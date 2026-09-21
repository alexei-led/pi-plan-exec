import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { PlanExecController } from "../src/controller.js";
import { bridgeRequestDigest, processTerminalProof, type BridgeOperationOwner, type DiagnosticGuidanceRequest } from "../src/bridge.js";
import { execReconcile, reconcileForResume } from "../src/index.js";
import { readPlan } from "../src/plan.js";
import { RunRegistry } from "../src/registry.js";
import { reconcileTasks, selectReadyTask } from "../src/scheduler.js";
import { DEFAULT_FROZEN_RUN_CONFIG, MAX_EXECUTION_TIMEOUT_MS, type BridgeResult, type ExecutionLifetime, type PlanExecRun } from "../src/types.js";
import type { RunCommand } from "../src/git.js";
import { LocalOperationCancelledError, LocalOperationFailedError, LocalOperationUnknownError, runLocalOperation } from "../src/local-operation.js";
import { runCommands } from "../src/lanes.js";
import { createControllerLocalExecutor } from "./fixtures/controller-local-executor.js";

const execute = promisify(execFile);
const command: RunCommand = async (program, args, cwd) => {
  try { const r = await execute(program, args, { cwd }); return { ...r, code: 0 }; }
  catch (error) { const r = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 1 }; }
};
const ok = (data: Record<string, unknown>): BridgeResult => ({ success: true, data });

function observedWorkerProof(id: string, digest: string) {
  const binding = { operationId: `kernel-${id}`, requestDigest: `kernel-digest-${id}`,
    hostId: "00000000-0000-0000-0000-000000000001", bootId: "00000000-0000-0000-0000-000000000002" };
  const identity = { ...binding, version: 1, backend: "darwin-resource-coalition-v1", coalitionId: "2001",
    leader: { pid: 4242, uniqueId: "1001", pidVersion: 1 } };
  const proof = { ...binding, kind: "darwin-coalition-retired", identity, observedAt: new Date().toISOString() };
  return { version: 1, state: "observed", runId: id, runnerProcessInstanceId: "fixture", observedAt: Date.now(),
    processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" },
    callerBinding: { operationId: id, requestDigest: digest }, nativeOperation: { operationId: `native-${id}`, digest: `native-digest-${id}` },
    kernelBinding: binding, kernelProof: { status: "retired", operationDirectory: "/fixture/op", binding, identity, proof, exitCode: 0, signal: null } };
}

class Worker {
  launches: { id: string; params: Record<string, unknown> }[] = [];
  output = "";
  state = "running";
  proof = false;
  failStatus = false;
  loseSpawn = false;
  totalTokens?: { input: number; output: number; total: number };
  totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
  terminationReason?: "execution_lifetime_expired";
  activity?: Record<string, unknown>;
  stopCalls = 0;
  constructor(readonly resultPath: string) {}
  async capabilities() { return { protocolVersion: 2 as const, healthy: true, workflowScriptSpawn: true, singleAgentSpawn: true, durableOperationLookup: true, processTerminalProofVersion: 1, executionLifetimeVersion: 1 as const, executionLifetimeModes: ["unbounded" as const, "bounded" as const], processTreeOwnership: { version: 1 as const, scope: "owned-process-tree" as const, escapedDescendants: "contained" as const } }; }
  async spawn(id: string, params: Record<string, unknown>): Promise<BridgeResult> {
    if (!this.launches.some((item) => item.id === id)) this.launches.push({ id, params });
    if (this.loseSpawn) return { success: false, error: { message: "lost spawn reply" } };
    return ok({ runId: id, requestDigest: bridgeRequestDigest(params), effectiveExecutionLifetime: params.executionLifetime });
  }
  async operation(id: string) {
    const launch = this.launches.find((item) => item.id === id);
    return ok(launch ? { state: "found", runId: id, requestDigest: bridgeRequestDigest(launch.params), effectiveExecutionLifetime: launch.params.executionLifetime } : { state: "unknown" });
  }
  async status(id: string): Promise<BridgeResult> {
    if (this.failStatus) return { success: false, error: { message: "status unavailable" } };
    return ok({ state: this.state,
      ...(this.terminationReason ? { terminationReason: this.terminationReason } : {}),
      ...(this.activity ? { activity: this.activity } : {}),
      ...(this.totalTokens ? { totalTokens: this.totalTokens } : {}),
      ...(this.totalCost ? { totalCost: this.totalCost } : {}),
      ...(this.proof ? { processTerminalProof: observedWorkerProof(id, bridgeRequestDigest(this.launches.find((launch) => launch.id === id)?.params ?? {})) } : {}) });
  }
  async result() { await writeFile(this.resultPath, JSON.stringify({ result: this.output })); return ok({ resultPath: this.resultPath }); }
  async adopt() { return ok({}); }
  async stop() { this.stopCalls++; return ok({ state: "stopping" }); }
}

class GuidingWorker extends Worker {
  guidanceCalls: { operationId: string; owner: BridgeOperationOwner; params: DiagnosticGuidanceRequest }[] = [];
  queued = new Set<string>();
  async capabilities() {
    return { ...await super.capabilities(), diagnosticGuidance: { version: 1 as const, idempotent: true as const, mode: "follow_up" as const, confirmedToolFailure: true as const } };
  }
  async diagnoseOperation(operationId: string, owner: BridgeOperationOwner, params: DiagnosticGuidanceRequest): Promise<BridgeResult> {
    this.guidanceCalls.push({ operationId, owner, params });
    this.queued.add(params.diagnosticId);
    if (this.guidanceCalls.length === 1) return { success: false, error: { code: "timeout", message: "guidance reply lost" } };
    return ok({ operationId, requestDigest: owner.requestDigest, diagnosticId: params.diagnosticId,
      toolCallId: params.toolCallId, guidanceOnly: true, state: "queued" });
  }
}
const fusion = { start: async () => ok({}), status: async () => ok({}), result: async () => ok({}), adopt: async () => ok({}), cancel: async () => ok({}) };

class DurableReviewBackend {
  calls: { id: string; prompt: string; profile: string | undefined; lifetime: ExecutionLifetime | undefined; digest: string | undefined; context: { cwd: string; reviewedCommit: string } | undefined }[] = [];
  children = new Set<string>();
  cancelled = new Set<string>();
  lookupUnavailable = false;
  constructor(readonly worker: Worker) {}
  capabilities() { return this.worker.capabilities(); }
  async start(id: string, prompt: string, profile?: string, lifetime?: ExecutionLifetime, digest?: string, context?: { cwd: string; reviewedCommit: string }): Promise<BridgeResult> {
    this.calls.push({ id, prompt, profile, lifetime, digest, context });
    if (this.cancelled.has(id)) return { success: false, error: { code: "cancelled", message: "launch fenced" } };
    if (this.calls.length === 1) return { success: false, error: { code: "timeout", message: "start never reached admission" } };
    this.children.add(id);
    return ok({ runId: id, operationId: id, phase: "panel", terminal: false, requestDigest: digest, effectiveExecutionLifetime: lifetime });
  }
  async status(runId?: string, operationId?: string): Promise<BridgeResult> {
    const id = runId ?? operationId!;
    if (this.lookupUnavailable) return { success: false, error: { code: "not_found", message: "not authoritative" } };
    if (this.cancelled.has(id)) return ok({ operationId: id, state: "cancelled", cancellationRequested: true, neverStarted: true, replaySafe: false });
    if (!this.children.has(id)) return ok({ operationId: id, state: "absent", replaySafe: true });
    const request = this.calls.find((call) => call.id === id)!;
    return ok({ runId: id, operationId: id, phase: "panel", terminal: false, requestDigest: request.digest, effectiveExecutionLifetime: request.lifetime });
  }
  async cancel(runId?: string, operationId?: string) {
    const id = runId ?? operationId!;
    this.cancelled.add(id);
    return ok({ operationId: id, state: "cancelled", cancellationRequested: true, neverStarted: !this.children.has(id), replaySafe: false });
  }
  result(runId?: string, operationId?: string) { return this.status(runId, operationId); }
  adopt(runId: string) { return this.status(runId); }
}

async function fixture(t: TestContext, content = "### Task 1: A\n- [ ] A\n") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autonomous-controller-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const result = await command("git", args, root);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-b", "feature");
  await git("config", "user.email", "test@example.test");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgSign", "false");
  await git("config", "core.hooksPath", "/dev/null");
  const planPath = join(root, "plan.md");
  await writeFile(planPath, content);
  await git("add", "plan.md"); await git("commit", "-m", "baseline");
  const plan = await readPlan(planPath);
  const registry = new RunRegistry(join(root, ".git", "runs"));
  const worker = new Worker(join(root, ".git", "result.json"));
  const localExecutor = createControllerLocalExecutor();
  const controller = new PlanExecController(registry, worker, fusion, command, localExecutor);
  const run = await registry.create({ schemaVersion: 1, repositoryRoot: root, worktreeCwd: root,
    planPath, planHash: plan.hash, branch: "feature", defaultBranch: "main", stage: "implementation",
    status: "running", taskAttempts: {}, stageAttempts: {}, reviewFindings: [], unresolvedFindings: [],
    config: { ...DEFAULT_FROZEN_RUN_CONFIG, retryDelayMs: 10 }, skippedStages: [], branchRebindings: [],
  });
  return { root, git, registry, worker, controller, run, planPath, localExecutor };
}

async function due(registry: RunRegistry, run: PlanExecRun) {
  return registry.update({ ...run, nextAttemptAt: 0, ...(run.activeOperation ? { activeOperation: { ...run.activeOperation, launchStartedAt: 0 } } : {}) });
}

test("status uncertainty beyond diagnostic burst preserves one writer and automatic wake", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let run = await f.controller.tick(f.run.id, "session");
  const id = run.activeOperation!.operationId;
  f.worker.failStatus = true;
  for (let i = 0; i < 6; i++) {
    run = await due(f.registry, run);
    run = await f.controller.tick(run.id, "session");
    assert.equal(run.status, "running");
    assert.equal(run.activeOperation?.operationId, id);
    assert.ok(run.nextAttemptAt! > Date.now());
  }
  assert.equal(f.worker.launches.length, 1);
  assert.equal(run.activeOperation?.statusFailures, 6);
});

test("lost spawn reply is reconciled after controller restart without duplicate child", async (t) => {
  const f = await fixture(t);
  f.worker.loseSpawn = true;
  let run = await f.controller.tick(f.run.id, "session");
  assert.equal(run.status, "running");
  assert.equal(run.activeOperation?.externalRunId, undefined);
  run = await due(f.registry, run);
  const restarted = new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor);
  run = await restarted.tick(run.id, "session");
  assert.equal(run.activeOperation?.externalRunId, f.worker.launches[0]?.id);
  assert.equal(f.worker.launches.length, 1);
});

test("wrapper failure without exit evidence cannot release ownership or rotate lane", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [ ] A\n### Task 2: B\ndependsOn: []\n- [ ] B\n");
  let run = await f.controller.tick(f.run.id, "session");
  f.worker.state = "failed";
  run = await f.controller.tick(run.id, "session");
  assert.ok(run.activeOperation);
  assert.equal(run.lanePreparation, undefined);
  assert.equal(f.worker.launches.length, 1);
});

test("late successful worker after stop cannot accept its candidate", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "candidate");
  run = await f.registry.update({ ...run, status: "cancel_pending", userStopped: true, stopGeneration: 1 });
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "cancelled");
  assert.notEqual(run.tasks?.["1"]?.state, "accepted");
  assert.equal(f.worker.launches.length, 1);
});

test("external prerequisite A preserves its lane while B completes and C waits until automatic recovery", async (t) => {
  const content = "### Task 1: A\n- [ ] A\n### Task 2: B\ndependsOn: []\n- [ ] B\n### Task 3: C\ndependsOn: [1]\n- [ ] C\n";
  const f = await fixture(t, content);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await writeFile(join(f.root, ".gitignore"), "private-artifact\n");
  await f.git("add", ".gitignore"); await f.git("commit", "-m", "fixture ignored artifact policy");
  await writeFile(join(f.root, "private-artifact"), "private bytes stay untouched");
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(join(f.root, "partial.txt"), "A private partial work");
  f.worker.state = "failed"; f.worker.proof = true;
  f.worker.output = "<<<RALPHEX:TASK_FAILED>>>\nBlocker: deployment credentials are invalid\nPrerequisite: credentials\nEvidence: provider returned HTTP 401 invalid_token\nNext step: restore credentials";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "running");
  assert.equal(run.tasks?.["1"]?.state, "waiting_external");
  assert.deepEqual(run.tasks?.["1"]?.externalPrerequisite, { kind: "credentials", source: "worker", evidence: "provider returned HTTP 401 invalid_token" });
  assert.equal(run.tasks?.["3"]?.state, "waiting_dependency");
  run = await f.controller.tick(run.id, "session");
  assert.ok(run.lanePreparation);
  const lane = run.lanePreparation.cwd;
  t.after(() => rm(lane, { recursive: true, force: true }));
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.taskId, 2);
  assert.equal(run.worktreeCwd, lane);
  assert.equal(await readFile(join(f.root, "partial.txt"), "utf8"), "A private partial work");
  await assert.rejects(readFile(join(lane, "partial.txt")), /ENOENT/);
  f.worker.state = "complete"; f.worker.output = "Task completed";
  const bPlan = content.replace("- [ ] B", "- [x] B");
  await writeFile(join(lane, "plan.md"), bPlan);
  for (const args of [["add", "plan.md"], ["commit", "-m", "B"]]) {
    const result = await command("git", args, lane);
    assert.equal(result.code, 0, result.stderr);
  }
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["2"]?.state, "accepted");
  assert.equal(run.tasks?.["3"]?.state, "waiting_dependency");
  const acceptedB = run.acceptedHead!;
  t.mock.timers.tick(run.tasks!["1"]!.nextAttemptAt! - Date.now());
  run = await f.registry.release(run);
  const restarted = new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor);
  run = await restarted.tick(run.id, "restored-session");
  assert.ok(run.lanePreparation);
  const recoveryLane = run.lanePreparation.cwd;
  t.after(() => rm(recoveryLane, { recursive: true, force: true }));
  assert.notEqual(recoveryLane, f.root);
  assert.notEqual(recoveryLane, lane);
  run = await restarted.tick(run.id, "restored-session");
  run = await restarted.tick(run.id, "restored-session");
  run = await restarted.tick(run.id, "restored-session");
  assert.equal(run.activeOperation?.taskId, 1);
  const oldPlan = await readFile(f.planPath, "utf8");
  const source = run.tasks!["1"]!.recoverySource!;
  assert.equal(source.cwd, f.root);
  assert.equal(await readFile(join(f.root, "partial.txt"), "utf8"), "A private partial work");
  await f.git("add", "partial.txt"); await f.git("commit", "-m", "A checkpoint");
  const checkpoint = await f.git("rev-parse", "HEAD");
  await f.git("update-ref", source.checkpointRef, checkpoint);
  const laneGit = async (...args: string[]) => {
    const result = await command("git", args, recoveryLane);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await laneGit("merge", "--no-edit", checkpoint);
  await writeFile(run.planPath, bPlan.replace("- [ ] A", "- [x] A"));
  await laneGit("add", "plan.md"); await laneGit("commit", "-m", "A recovered in new verification lane");
  run = await restarted.tick(run.id, "restored-session");
  assert.equal(run.tasks?.["1"]?.state, "accepted");
  assert.equal(run.tasks?.["1"]?.externalPrerequisite, undefined);
  assert.equal(run.tasks?.["1"]?.recoverySource?.checkpointCommit, checkpoint);
  await laneGit("merge-base", "--is-ancestor", acceptedB, run.acceptedHead!);
  assert.equal(await readFile(f.planPath, "utf8"), oldPlan);
  assert.equal(await readFile(join(f.root, "partial.txt"), "utf8"), "A private partial work");
  run = await restarted.tick(run.id, "restored-session");
  assert.equal(run.activeOperation?.taskId, 3);
  await writeFile(run.planPath, (await readFile(run.planPath, "utf8")).replace("- [ ] C", "- [x] C"));
  await laneGit("add", "plan.md"); await laneGit("commit", "-m", "C after A recovered");
  run = await restarted.tick(run.id, "restored-session");
  assert.equal(run.tasks?.["3"]?.state, "accepted");
  assert.equal(await readFile(f.planPath, "utf8"), oldPlan);
  f.worker.output = "NO_FINDINGS";
  for (let step = 0; step < 15 && run.status === "running"; step++) run = await restarted.tick(run.id, "restored-session");
  assert.equal(run.status, "completed", run.error ?? "pipeline did not complete");
  assert.equal(run.worktreeCwd, f.root);
  assert.equal(run.branch, "feature");
  assert.equal(await f.git("show", `${source.checkpointRef}:partial.txt`), "A private partial work");
  assert.equal(await readFile(join(f.root, "private-artifact"), "utf8"), "private bytes stay untouched");
});

test("independent external prerequisites wait together and retry automatically", async (t) => {
  const content = "### Task 1: A\ndependsOn: []\n- [ ] A\n### Task 2: B\ndependsOn: []\n- [ ] B\n";
  const f = await fixture(t, content);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let run = await f.controller.tick(f.run.id, "session");
  f.worker.state = "failed";
  f.worker.proof = true;
  f.worker.output = "<<<RALPHEX:TASK_FAILED>>>\nBlocker: deployment credentials are invalid\nPrerequisite: credentials\nEvidence: provider returned HTTP 401 invalid_token\nNext step: restore credentials";
  for (let attempt = 0; attempt < 12 && run.tasks?.["1"]?.state !== "waiting_external"; attempt++)
    run = await f.controller.tick(run.id, "session");
  for (let attempt = 0; attempt < 12 && run.tasks?.["2"]?.state !== "waiting_external"; attempt++)
    run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "running");
  assert.equal(run.tasks?.["1"]?.state, "waiting_external");
  assert.equal(run.tasks?.["2"]?.state, "waiting_external");
  assert.match(run.tasks?.["1"]?.reason ?? "", /credential/i);
  assert.match(run.tasks?.["2"]?.reason ?? "", /credential/i);
  const firstTask = run.tasks?.["1"];
  const secondTask = run.tasks?.["2"];
  assert.ok(firstTask?.externalPrerequisite?.evidence);
  assert.ok(secondTask?.externalPrerequisite?.evidence);
  assert.ok(firstTask);
  assert.ok(secondTask);
  assert.ok(firstTask.nextAttemptAt !== undefined);
  assert.ok(secondTask.nextAttemptAt !== undefined);
  const nextAttemptAt = Math.min(firstTask.nextAttemptAt, secondTask.nextAttemptAt);
  assert.ok(nextAttemptAt > Date.now());
  const launches = f.worker.launches.length;
  for (let attempt = 0; attempt < 3; attempt++)
    run = await f.controller.tick(run.id, "session");
  assert.equal(f.worker.launches.length, launches);
  assert.ok(run.tasks?.["1"]?.nextAttemptAt !== undefined && run.tasks["1"].nextAttemptAt > Date.now());
  assert.ok(run.tasks?.["2"]?.nextAttemptAt !== undefined && run.tasks["2"].nextAttemptAt > Date.now());
  t.mock.timers.tick(nextAttemptAt - Date.now());
  for (let attempt = 0; attempt < 12 && f.worker.launches.length === launches; attempt++)
    run = await f.controller.tick(run.id, "session");
  assert.equal(f.worker.launches.length, launches + 1);
  assert.ok(run.activeOperation);
});

test("fair scheduler has no fifty-task or attempt cap", async () => {
  const tasks = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, title: String(index), startLine: index, endLine: index + 1, items: ["work"], unchecked: ["work"], dependsOn: [] }));
  let states = reconcileTasks(tasks);
  states["1"] = { ...states["1"]!, attempts: 500, state: "retry_wait", nextAttemptAt: 10, lastScheduledAt: 1 };
  states = reconcileTasks(tasks, states, 20);
  assert.equal(selectReadyTask(states)?.taskId, 2);
  for (let id = 2; id <= 60; id++) states[String(id)] = { ...states[String(id)]!, state: "accepted" };
  assert.equal(selectReadyTask(states)?.taskId, 1);
});

test("controller accepts fifty-one distinct committed tasks without a global iteration cap", async (t) => {
  const count = 51;
  let content = Array.from({ length: count }, (_, index) => `### Task ${index + 1}: Work ${index + 1}\n- [ ] Work ${index + 1}\n`).join("");
  const f = await fixture(t, content);
  let run = f.run;
  const commits = new Set<string>();
  f.worker.state = "complete"; f.worker.proof = true;
  for (let id = 1; id <= count; id++) {
    run = await f.controller.tick(run.id, "session");
    assert.equal(run.activeOperation?.taskId, id);
    content = content.replace(`- [ ] Work ${id}\n`, `- [x] Work ${id}\n`);
    await writeFile(f.planPath, content);
    await f.git("add", "plan.md"); await f.git("commit", "-m", `task ${id}`);
    run = await f.controller.tick(run.id, "session");
    assert.equal(run.tasks?.[String(id)]?.state, "accepted", run.wakeReason ?? "task was not accepted");
    commits.add(run.acceptedHead!);
  }
  assert.equal(commits.size, count);
  assert.equal(f.worker.launches.length, count);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "comprehensive_review");
});

test("candidate verification failure is recoverable and never accepts checkbox-only work", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  assert.match(run.tasks?.["1"]?.reason ?? "", /did not advance/);
  assert.equal(run.status, "running");
});

test("two malformed reviews remain required with scheduled recovery", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review" });
  f.worker.state = "complete"; f.worker.proof = true; f.worker.output = "Looks good overall";
  for (let attempt = 0; attempt < 2; attempt++) {
    run = await due(f.registry, run);
    run = await f.controller.tick(run.id, "session");
    run = await f.controller.tick(run.id, "session");
    assert.equal(run.stage, "comprehensive_review");
    assert.equal(run.status, "running");
    assert.ok(run.nextAttemptAt);
  }
  assert.equal(f.worker.launches.length, 2);
});

test("restart after candidate commit verifies it without another implementation worker", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "candidate before crash");
  const candidate = await f.git("rev-parse", "HEAD");
  run = await f.registry.update({ ...run, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, state: "verifying", candidateCommit: candidate } } });
  f.worker.state = "complete"; f.worker.proof = true;
  const restarted = new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor);
  run = await restarted.tick(run.id, "session");
  assert.equal(run.acceptedHead, candidate);
  assert.equal(run.tasks?.["1"]?.state, "accepted", JSON.stringify({ status: run.status, userStopped: run.userStopped, error: run.error, wakeReason: run.wakeReason, activeOperation: run.activeOperation }));
  assert.equal(f.worker.launches.length, 1);
});

test("untracked source cannot be smuggled into an accepted candidate", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "incomplete candidate");
  await writeFile(join(f.root, "forgotten-source.ts"), "export const result = 1;\n");
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  assert.match(run.tasks?.["1"]?.reason ?? "", /uncommitted source/);
});

test("start freezes mandatory checks before a worker can remove their declarations", async (t) => {
  const f = await fixture(t);
  await f.git("branch", "main");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await f.git("add", "package.json"); await f.git("commit", "-m", "trusted project checks");
  const registry = new RunRegistry(join(f.root, ".git", "start-runs"));
  const controller = new PlanExecController(registry, f.worker, fusion, command, f.localExecutor);
  const started = await controller.start({ cwd: f.root, planPath: f.planPath, useWorktree: false, sessionId: "session" });
  assert.deepEqual(started.config.requiredChecks, [["npm", "run", "test"]]);
  await writeFile(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
  assert.deepEqual((await registry.get(started.id))?.config.requiredChecks, [["npm", "run", "test"]]);
});

test("required review cannot be waived by explicit skip", async (t) => {
  const f = await fixture(t);
  const run = await f.registry.update({ ...f.run, stage: "comprehensive_review", status: "paused" });
  await assert.rejects(f.controller.skip(run.id, "session", "skip it"), /Required comprehensive_review/);
  assert.equal((await f.registry.get(run.id))?.stage, "comprehensive_review");
});

test("paused runs observe a tracked child without accepting it or dispatching a replacement", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  const operationId = run.activeOperation!.operationId;
  run = await f.registry.update({ ...run, status: "paused", userStopped: true, stopGeneration: 1 });
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "paused");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.ok(run.activeOperation?.lastObservedAt);
  assert.equal(f.worker.launches.length, 1);
  assert.notEqual(run.tasks?.["1"]?.state, "accepted");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "paused worker completed");
  run = await f.controller.resume(run.id, "session", true);
  assert.equal(run.tasks?.["1"]?.state, "accepted", JSON.stringify({ status: run.status, userStopped: run.userStopped, error: run.error, wakeReason: run.wakeReason, activeOperation: run.activeOperation }));
  assert.equal(f.worker.launches.length, 1);
});

test("accepted candidate completes required review and archives only the verified commit", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "verified candidate");
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  const candidate = run.acceptedHead;
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.kind, "review");
  f.worker.output = "NO_FINDINGS";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.reviewedCommit, candidate);
  assert.equal(run.verifiedCommit, candidate);
  f.worker.output = "Statistics recorded.";
  for (let attempt = 0; attempt < 8 && run.status === "running"; attempt++) run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "completed", run.error ?? "pipeline did not complete");
  assert.match(await readFile(join(f.root, "completed", "plan.md"), "utf8"), /\[x\]/);
});

test("cumulative native usage is counted once across repeated status polls", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  assert.equal(run.tasks?.["1"]?.usage, undefined);
  f.worker.totalTokens = { input: 10, output: 20, total: 30 };
  f.worker.totalCost = { inputTokens: 10, outputTokens: 20, costUsd: 0.5 };
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.deepEqual(run.tasks?.["1"]?.usage, { inputTokens: 10, outputTokens: 20, cost: 0.5 });
  f.worker.totalTokens = { input: 15, output: 25, total: 40 };
  f.worker.totalCost = { inputTokens: 15, outputTokens: 25, costUsd: 0.75 };
  run = await f.controller.tick(run.id, "session");
  assert.deepEqual(run.tasks?.["1"]?.usage, { inputTokens: 15, outputTokens: 25, cost: 0.75 });
  assert.deepEqual(run.usage, { inputTokens: 15, outputTokens: 25, cost: 0.75 });
});

test("malformed optional token counts and overflowing totals do not block worker observation", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  const operationId = run.activeOperation!.operationId;
  f.worker.totalTokens = { input: 0.5, output: Number.MAX_SAFE_INTEGER + 1, total: Number.MAX_SAFE_INTEGER + 1 };
  f.worker.totalCost = { inputTokens: 0.5, outputTokens: Number.POSITIVE_INFINITY, costUsd: 0.25 };
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.ok(run.activeOperation?.lastObservedAt);
  assert.equal(run.error, undefined);
  assert.deepEqual(run.usage, { cost: 0.25 });
  assert.deepEqual(run.tasks?.["1"]?.usage, { cost: 0.25 });
  run = await f.registry.update({ ...run, usage: { ...run.usage, inputTokens: Number.MAX_SAFE_INTEGER },
    tasks: { ...run.tasks, "1": { ...run.tasks!["1"]!, usage: { ...run.tasks!["1"]!.usage, inputTokens: Number.MAX_SAFE_INTEGER } } } });
  f.worker.totalTokens = { input: 1, output: 2, total: 3 };
  f.worker.totalCost = { inputTokens: 1, outputTokens: 2, costUsd: 0.5 };
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(run.error, undefined);
  assert.deepEqual(run.usage, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2, cost: 0.5 });
  assert.deepEqual(run.tasks?.["1"]?.usage, run.usage);
});

test("explicit resume adopts an approved legacy plan hash at the current revision", async (t) => {
  const f = await fixture(t);
  const approvedHash = f.run.planHash;
  const paused = await f.registry.update({ ...f.run, planHash: "legacy-plan-hash",
    status: "paused", userStopped: true, stopGeneration: 1 });
  const resumed = await f.controller.resume(paused.id, "session", true, approvedHash);
  assert.equal(resumed.planHash, approvedHash);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.userStopped, false);
  assert.equal(resumed.activeOperation?.taskId, 1);
  assert.equal(f.worker.launches.length, 1);
});

test("late stop winning resume authorization CAS cannot be erased by another resume write", async (t) => {
  const f = await fixture(t);
  const paused = await f.registry.update({ ...f.run, status: "paused", userStopped: true, stopGeneration: 1 });
  const update = f.registry.updateIfCurrent.bind(f.registry);
  let injected = false;
  f.registry.updateIfCurrent = async (candidate, expectedAt, preserveRevision) => {
    if (!injected && candidate.userStopped === false) {
      injected = true;
      const current = await f.registry.get(candidate.id);
      assert.ok(current);
      await update({ ...current, status: "paused", userStopped: true, stopGeneration: 2 }, current.updatedAt);
    }
    return update(candidate, expectedAt, preserveRevision);
  };
  const resumed = await f.controller.resume(paused.id, "session", true, paused.planHash);
  assert.equal(injected, true);
  assert.equal(resumed.status, "paused");
  assert.equal(resumed.userStopped, true);
  assert.equal(resumed.stopGeneration, 2);
  assert.equal(f.worker.launches.length, 0);
});

test("stop arriving while a resume claims ownership supersedes that resume", async (t) => {
  const f = await fixture(t);
  const paused = await f.registry.update({ ...f.run, status: "paused", userStopped: true, stopGeneration: 1 });
  const claim = f.registry.claim.bind(f.registry);
  f.registry.claim = async (candidate, sessionId) => {
    const stopped = await f.registry.update({ ...candidate, status: "paused", userStopped: true, stopGeneration: 2 });
    return claim(stopped, sessionId);
  };
  const resumed = await f.controller.resume(paused.id, "session", true);
  assert.equal(resumed.status, "paused");
  assert.equal(resumed.userStopped, true);
  assert.equal(resumed.stopGeneration, 2);
  assert.equal(f.worker.launches.length, 0);
});

test("default reporting summarizes durable usage without launching a statistics worker", async (t) => {
  const f = await fixture(t);
  const stats = await f.registry.update({ ...f.run, stage: "stats", usage: { inputTokens: 11, outputTokens: 7, cost: 0.25 } });
  const result = await f.controller.tick(stats.id, "session");
  assert.equal(result.stage, "archive");
  assert.equal(result.statsReport?.state, "summary");
  assert.match(result.statsReport?.summary ?? "", /input tokens: 11; output tokens: 7; cost: 0.25/);
  assert.equal(f.worker.launches.length, 0);
});

test("optional statistics failure needs exit proof but cannot block mandatory completion afterward", async (t) => {
  const f = await fixture(t);
  let run = await f.registry.update({ ...f.run, stage: "stats", config: { ...f.run.config, statsEnabled: true } });
  run = await f.controller.tick(run.id, "session");
  const operationId = run.activeOperation!.operationId;
  f.worker.state = "failed";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "stats");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(run.statsReport, undefined);
  f.worker.proof = true;
  run = await due(f.registry, run);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "archive");
  assert.equal(run.activeOperation, undefined);
  assert.equal(run.statsReport?.state, "unavailable");
  assert.match(run.statsReport?.error ?? "", /ended as failed/);
  assert.equal(f.worker.launches.length, 1);
});

test("repeated blocking findings across commit churn schedule a changed fix without waiving review", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const baseline = await f.git("rev-parse", "HEAD");
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review", acceptedHead: baseline,
    tasks: { "1": { taskId: 1, dependsOn: [], state: "accepted", attempts: 1, acceptedCommit: baseline } },
  });
  f.worker.state = "complete"; f.worker.proof = true;
  f.worker.output = "FINDING: MAJOR | Shared state remains unsafe\nEvidence: worker.ts:1 concurrent updates lose data\nFix: reproduce the race and serialize writes";
  run = await f.controller.tick(run.id, "session");
  for (let attempt = 1; attempt <= 2; attempt++) {
    run = await f.controller.tick(run.id, "session");
    assert.equal(run.activeOperation?.kind, "fix");
    await writeFile(join(f.root, "churn.txt"), `ineffective fix ${attempt}\n`);
    await f.git("add", "churn.txt"); await f.git("commit", "-m", `ineffective fix ${attempt}`);
    run = await f.controller.tick(run.id, "session");
    assert.equal(run.activeOperation?.kind, "review");
  }
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "comprehensive_review");
  assert.equal(run.activeOperation, undefined);
  assert.equal(run.reviewRecovery?.repeats, 3);
  assert.equal(run.reviewRecovery?.pendingFix, true);
  assert.equal(run.reviewFindings[0]?.severity, "MAJOR");
  assert.equal(run.reviewedCommit, undefined);
  assert.equal(run.unresolvedFindings.length, 0);
  assert.ok(run.nextAttemptAt! > Date.now());
  const launches = f.worker.launches.length;
  run = await f.controller.tick(run.id, "session");
  assert.equal(f.worker.launches.length, launches);
  t.mock.timers.tick(run.nextAttemptAt! - Date.now());
  const restarted = new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor);
  run = await restarted.tick(run.id, "session");
  assert.equal(run.activeOperation?.kind, "fix");
  assert.equal(run.reviewRecovery?.pendingFix, false);
  assert.match(String(f.worker.launches.at(-1)?.params.task), /Change the diagnosis before editing again/);
  await writeFile(join(f.root, "churn.txt"), "serialized write verified\n");
  await f.git("add", "churn.txt"); await f.git("commit", "-m", "fix shared state race");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.kind, "review");
  f.worker.output = "NO_FINDINGS";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.reviewRecovery, undefined);
  assert.equal(run.reviewedCommit, await f.git("rev-parse", "HEAD"));
  assert.equal(run.stage, "stats");
});

test("normal progress files do not dirty candidates but neighboring user files still do", async (t) => {
  const f = await fixture(t);
  let run = await f.registry.update({ ...f.run, stage: "progress" });
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "candidate with progress");
  f.worker.state = "complete"; f.worker.proof = true;
  await writeFile(join(f.root, ".ralphex", "user-secret.txt"), "preserve user content");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  await rm(join(f.root, ".ralphex", "user-secret.txt"));
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "accepted", run.error ?? run.wakeReason ?? "not accepted");
});

test("a failed resumed candidate is cleared before a replacement attempt commits", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "candidate one");
  const first = await f.git("rev-parse", "HEAD");
  run = await f.registry.update({ ...run, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, state: "verifying", candidateCommit: first } } });
  await writeFile(join(f.root, "uncommitted.txt"), "invalid candidate");
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  assert.equal(run.tasks?.["1"]?.candidateCommit, undefined);
  await rm(join(f.root, "uncommitted.txt"));
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await f.controller.tick(run.id, "session");
  await writeFile(join(f.root, "source.txt"), "corrected implementation");
  await f.git("add", "source.txt"); await f.git("commit", "-m", "candidate two");
  const second = await f.git("rev-parse", "HEAD");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "accepted");
  assert.equal(run.acceptedHead, second);
});

test("a candidate cannot reopen the committed checkbox of an already accepted task", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [ ] A\n### Task 2: B\n- [ ] B\n");
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n### Task 2: B\n- [ ] B\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "A accepted");
  f.worker.state = "complete"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [ ] A\n### Task 2: B\n- [x] B\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "B wrongly reopens A");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["2"]?.state, "retry_wait");
  assert.match(run.tasks?.["2"]?.reason ?? "", /accepted task 1/i);
});

test("minor-only required review records advisory findings without an endless fixer", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review" });
  run = await f.controller.tick(run.id, "session");
  f.worker.state = "complete"; f.worker.proof = true;
  f.worker.output = "FINDING: MINOR | Naming can be clearer\nEvidence: source.ts:1 the local name is vague\nFix: consider a clearer local name";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "stats");
  assert.equal(run.unresolvedFindings[0]?.severity, "MINOR");
  assert.equal(run.reviewedCommit, await f.git("rev-parse", "HEAD"));
  assert.equal(f.worker.launches.length, 1);
});

test("review progress creates missing directories in a newly selected lane", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  const progressPath = join(f.root, ".ralphex", "progress", "new-lane.txt");
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review", progressPath });
  run = await f.controller.tick(run.id, "session");
  f.worker.state = "complete"; f.worker.proof = true; f.worker.output = "NO_FINDINGS";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "stats");
  assert.match(await readFile(progressPath, "utf8"), /found no issues/);
});

test("archive resumes an already staged rename without misreading its second pathname", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  const head = await f.git("rev-parse", "HEAD");
  let run = await f.registry.update({ ...f.run, stage: "archive", verifiedCommit: head, reviewedCommit: head,
    tasks: { "1": { taskId: 1, dependsOn: [], state: "accepted", attempts: 1, acceptedCommit: head } } });
  await mkdir(join(f.root, "completed"));
  await f.git("mv", "plan.md", "completed/plan.md");
  const staged = await f.git("status", "--porcelain", "-z");
  assert.match(staged, /^R /);
  for (let attempt = 0; attempt < 5 && run.status === "running"; attempt++) run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "completed", run.error ?? "archive did not complete");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("accepted internal-lane work fast-forwards the original output branch without erasing dirty files", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  const baseline = await f.git("rev-parse", "HEAD");
  const lane = `${f.root}-output-lane`;
  t.after(() => rm(lane, { recursive: true, force: true }));
  await f.git("worktree", "add", "-b", "internal-output", lane, baseline);
  await writeFile(join(lane, "accepted.txt"), "accepted independent work");
  for (const args of [["add", "accepted.txt"], ["commit", "-m", "accepted lane candidate"]])
    assert.equal((await command("git", args, lane)).code, 0);
  const candidate = (await command("git", ["rev-parse", "HEAD"], lane)).stdout.trim();
  const progressRelativePath = ".ralphex/progress/output.txt";
  await mkdir(join(f.root, ".ralphex", "progress"), { recursive: true });
  await writeFile(join(f.root, progressRelativePath), "original progress preserved\n");
  let run = await f.registry.update({ ...f.run, stage: "finalize", reviewedCommit: candidate, worktreeCwd: lane, branch: "internal-output", planPath: join(lane, "plan.md"),
    acceptedHead: candidate, progressPath: join(lane, progressRelativePath),
    outputTarget: { cwd: f.root, branch: "feature", initialHead: baseline, planRelativePath: "plan.md", progressRelativePath },
    tasks: { "1": { taskId: 1, dependsOn: [], state: "accepted", attempts: 1, acceptedCommit: candidate } },
  });
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.outputPromotion?.state, "pending");
  await writeFile(join(f.root, "user-work.txt"), "do not overwrite");
  run = await f.controller.tick(run.id, "session");
  assert.equal(await f.git("rev-parse", "HEAD"), baseline);
  assert.match(run.error ?? "", /preserved or user changes/);
  assert.equal(await readFile(join(f.root, "user-work.txt"), "utf8"), "do not overwrite");
  await rm(join(f.root, "user-work.txt"));
  run = await due(f.registry, run);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.outputPromotion?.state, "complete");
  assert.equal(run.worktreeCwd, f.root);
  assert.equal(run.branch, "feature");
  assert.equal(await f.git("rev-parse", "HEAD"), candidate);
  assert.equal(await readFile(join(f.root, "accepted.txt"), "utf8"), "accepted independent work");
  assert.match(await readFile(join(f.root, progressRelativePath), "utf8"), /original progress preserved/);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "stats");
});

test("authoritative absent review intent replays the exact durable request after restart", async (t) => {
  const f = await fixture(t);
  const backend = new DurableReviewBackend(f.worker);
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review", config: { ...f.run.config, reviewBackend: "fusion" } });
  const controller = new PlanExecController(f.registry, f.worker, backend, command, f.localExecutor);
  run = await controller.tick(run.id, "session");
  const operationId = run.activeOperation!.operationId;
  assert.equal(run.activeOperation?.externalRunId, undefined);
  run = await due(f.registry, run);
  const restarted = new PlanExecController(f.registry, f.worker, backend, command, f.localExecutor);
  run = await restarted.tick(run.id, "session");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(run.activeOperation?.externalRunId, operationId);
  assert.equal(backend.children.size, 1);
  assert.equal(backend.calls.length, 2);
  assert.deepEqual(backend.calls[0], backend.calls[1]);
  assert.deepEqual(backend.calls[0]?.context, { cwd: f.root, reviewedCommit: await f.git("rev-parse", "HEAD") });
});

test("unknown review lookup does not replay or launch a configured fallback", async (t) => {
  const f = await fixture(t);
  const backend = new DurableReviewBackend(f.worker);
  backend.lookupUnavailable = true;
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review", config: { ...f.run.config, reviewBackend: "fusion", reviewFallback: ["subagent"] } });
  const controller = new PlanExecController(f.registry, f.worker, backend, command, f.localExecutor);
  run = await controller.tick(run.id, "session");
  const operationId = run.activeOperation!.operationId;
  run = await due(f.registry, run);
  run = await controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(backend.calls.length, 1);
  assert.equal(f.worker.launches.length, 0);
  assert.equal(run.config.reviewBackend, "fusion");
});

test("durable never-started review cancellation fences delayed replay without wrapper exit proof", async (t) => {
  const f = await fixture(t);
  const backend = new DurableReviewBackend(f.worker);
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review", config: { ...f.run.config, reviewBackend: "fusion" } });
  const controller = new PlanExecController(f.registry, f.worker, backend, command, f.localExecutor);
  run = await controller.tick(run.id, "session");
  const operationId = run.activeOperation!.operationId;
  run = await f.registry.update({ ...run, status: "cancel_pending", userStopped: true, stopGeneration: 1 });
  run = await controller.tick(run.id, "session");
  assert.equal(run.status, "cancelled");
  assert.equal(run.activeOperation, undefined);
  assert.equal(backend.children.size, 0);
  const delayed = await backend.start(operationId, "late reply");
  assert.equal(delayed.success, false);
  assert.equal(backend.children.size, 0);
});

test("unchanged commit churn cannot relabel a remembered blocking finding as advisory", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  let run = await f.registry.update({ ...f.run, stage: "comprehensive_review" });
  f.worker.state = "complete"; f.worker.proof = true;
  f.worker.output = "FINDING: MAJOR | Lost update\nEvidence: source.ts:1 concurrent writes overwrite data\nFix: serialize writes";
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.kind, "fix");
  await f.git("commit", "--allow-empty", "-m", "cosmetic commit churn");
  run = await f.controller.tick(run.id, "session");
  f.worker.output = "FINDING: MINOR | Lost update\nEvidence: source.ts:1 concurrent writes overwrite data\nFix: serialize writes";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.stage, "comprehensive_review");
  assert.equal(run.reviewFindings[0]?.severity, "MAJOR");
  assert.equal(run.unresolvedFindings.length, 0);
  assert.equal(run.reviewedCommit, undefined);
  assert.match(run.error ?? "", /relabeled MINOR/);
});

test("output fast-forward recovery reconciles a lost reply and preserves a concurrent stop", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  const baseline = await f.git("rev-parse", "HEAD");
  const lane = `${f.root}-crash-lane`;
  t.after(() => rm(lane, { recursive: true, force: true }));
  await f.git("worktree", "add", "-b", "internal-crash", lane, baseline);
  await writeFile(join(lane, "result.txt"), "verified output\n");
  for (const args of [["add", "result.txt"], ["commit", "-m", "accepted output"]])
    assert.equal((await command("git", args, lane)).code, 0);
  const candidate = (await command("git", ["rev-parse", "HEAD"], lane)).stdout.trim();
  let run = await f.registry.update({ ...f.run, stage: "finalize", reviewedCommit: candidate, worktreeCwd: lane, branch: "internal-crash", planPath: join(lane, "plan.md"),
    acceptedHead: candidate, outputTarget: { cwd: f.root, branch: "feature", initialHead: baseline, planRelativePath: "plan.md" },
    outputPromotion: { candidate, state: "pending" },
    tasks: { "1": { taskId: 1, dependsOn: [], state: "accepted", attempts: 1, acceptedCommit: candidate } },
  });
  let lost = false;
  const crashCommand: typeof runCommands = async (cwd, commands, options) => {
    await runCommands(cwd, commands, options);
    if (!lost) { lost = true; throw new LocalOperationUnknownError("lost fast-forward reply"); }
  };
  run = await new PlanExecController(f.registry, f.worker, fusion, command, crashCommand).tick(run.id, "session");
  assert.equal(await f.git("rev-parse", "HEAD"), candidate);
  assert.equal(run.outputPromotion?.state, "pending");
  run = await due(f.registry, run);
  const stopCommand: typeof runCommands = async (cwd, commands, options) => {
    await runCommands(cwd, commands, options);
    if (commands[0]?.[1] === "merge") {
      const current = await f.registry.get(run.id);
      assert.ok(current);
      await f.registry.update({ ...current, status: "paused", userStopped: true, stopGeneration: 1 });
    }
  };
  run = await new PlanExecController(f.registry, f.worker, fusion, command, stopCommand).tick(run.id, "session");
  assert.equal(run.status, "paused");
  assert.equal(run.outputPromotion?.state, "pending");
  assert.equal(f.worker.launches.length, 0);
  run = await f.controller.resume(run.id, "session", true);
  assert.equal(run.outputPromotion?.state, "complete");
  assert.equal(run.worktreeCwd, f.root);
  assert.equal(await f.git("rev-parse", "HEAD"), candidate);
});

test("final checks get a fresh persisted identity after proven nonzero exit", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  const candidate = await f.git("rev-parse", "HEAD");
  let run = await f.registry.update({ ...f.run, stage: "finalize", reviewedCommit: candidate,
    config: { ...f.run.config, requiredChecks: [["node", "-e", "process.exit(0)"]] } });
  const identities: string[] = [];
  const execute: typeof runCommands = async (_cwd, _commands, options) => {
    identities.push(options.operationId);
    if (identities.length === 1) throw new LocalOperationFailedError("exit 1 with owned tree retired");
  };
  run = await new PlanExecController(f.registry, f.worker, fusion, command, execute).tick(run.id, "session");
  assert.equal(run.stage, "finalize");
  assert.equal(run.stageAttempts.finalize, 1);
  assert.equal(run.verifiedCommit, undefined);
  run = await due(f.registry, run);
  run = await new PlanExecController(f.registry, f.worker, fusion, command, execute).tick(run.id, "session");
  assert.equal(run.stage, "stats");
  assert.equal(run.verifiedCommit, candidate);
  assert.equal(identities.length, 2);
  assert.notEqual(identities[0], identities[1]);
  assert.equal(f.worker.launches.length, 0);
});

test("unknown final-check result reconciles the same identity across restart", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  let run = await f.registry.update({ ...f.run, stage: "finalize",
    config: { ...f.run.config, requiredChecks: [["node", "-e", "process.exit(0)"]] } });
  const identities: string[] = [];
  const execute: typeof runCommands = async (_cwd, _commands, options) => {
    identities.push(options.operationId);
    if (identities.length === 1) throw new LocalOperationUnknownError("lost result; original verifier may still own descendants");
  };
  run = await new PlanExecController(f.registry, f.worker, fusion, command, execute).tick(run.id, "session");
  assert.equal(run.stage, "finalize");
  assert.equal(run.stageAttempts.finalize, undefined);
  run = await due(f.registry, run);
  run = await new PlanExecController(f.registry, f.worker, fusion, command, execute).tick(run.id, "session");
  assert.equal(run.stage, "stats");
  assert.equal(identities.length, 2);
  assert.equal(identities[0], identities[1]);
});

test("bootstrap changes identity only after proven failure and does not consume task attempts", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const baseline = await f.git("rev-parse", "HEAD");
  let run = await f.registry.update({ ...f.run, stage: "resolve",
    lanePreparation: { cwd: f.root, branch: "feature", baselineCommit: baseline, taskId: 0, state: "bootstrap" },
    config: { ...f.run.config, bootstrapCommands: [["node", "-e", "process.exit(0)"]] },
  });
  const identities: string[] = [];
  const execute: typeof runCommands = async (_cwd, _commands, options) => {
    identities.push(options.operationId);
    if (identities.length === 1) throw new LocalOperationUnknownError("bootstrap result unavailable");
    if (identities.length < 4) throw new LocalOperationFailedError("bootstrap exited nonzero with tree retired");
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    run = await due(f.registry, run);
    run = await new PlanExecController(f.registry, f.worker, fusion, command, execute).tick(run.id, "session");
  }
  assert.equal(identities[0], identities[1]);
  assert.notEqual(identities[1], identities[2]);
  assert.notEqual(identities[2], identities[3]);
  assert.equal(run.lanePreparation, undefined);
  assert.deepEqual(run.taskAttempts, {});
  assert.equal(f.worker.launches.length, 0);
});

test("late successful final checks cannot overwrite a newer stop generation", async (t) => {
  const f = await fixture(t, "### Task 1: A\n- [x] A\n");
  let run = await f.registry.update({ ...f.run, stage: "finalize",
    config: { ...f.run.config, requiredChecks: [["node", "-e", "process.exit(0)"]] } });
  const authorizations: number[] = [];
  const identities: string[] = [];
  const execute: typeof runCommands = async (_cwd, _commands, options) => {
    identities.push(options.operationId);
    authorizations.push(options.authorization!.stopGeneration);
    if (identities.length === 1) {
      const current = await f.registry.get(run.id);
      assert.ok(current);
      await f.registry.update({ ...current, status: "paused", userStopped: true, stopGeneration: 1 });
      assert.equal(await options.isAuthorized(), false);
    }
  };
  const controller = new PlanExecController(f.registry, f.worker, fusion, command, execute);
  run = await controller.tick(run.id, "session");
  assert.equal(run.status, "paused");
  assert.equal(run.stage, "finalize");
  assert.equal(run.verifiedCommit, undefined);
  run = await controller.tick(run.id, "session");
  assert.equal(identities.length, 1);
  run = await controller.resume(run.id, "session", true);
  assert.equal(run.stage, "stats");
  assert.deepEqual(authorizations, [0, 1]);
  assert.equal(identities[0], identities[1]);
});

test("candidate checks retain unknown ownership then use a new verifier for a proven failed attempt", async (t) => {
  const f = await fixture(t);
  let run = await f.registry.update({ ...f.run, config: { ...f.run.config,
    requiredChecks: [["node", "-e", "process.exit(0)"]] } });
  const identities: string[] = [];
  const candidates: (string | undefined)[] = [];
  const execute: typeof runCommands = async (_cwd, _commands, options) => {
    identities.push(options.operationId);
    candidates.push(options.candidate);
    if (identities.length === 1) throw new LocalOperationUnknownError("candidate check result lost");
    if (identities.length === 2) throw new LocalOperationFailedError("same check later proves nonzero exit");
  };
  const controller = new PlanExecController(f.registry, f.worker, fusion, command, execute);
  run = await controller.tick(run.id, "session");
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "candidate awaiting checks");
  const candidate = await f.git("rev-parse", "HEAD");
  f.worker.state = "complete"; f.worker.proof = true;
  run = await controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "verifying");
  assert.ok(run.activeOperation);
  run = await due(f.registry, run);
  run = await controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  assert.equal(run.activeOperation, undefined);
  assert.equal(f.worker.launches.length, 1);
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await controller.tick(run.id, "session");
  run = await controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "accepted");
  assert.equal(run.acceptedHead, candidate);
  assert.equal(identities[0], identities[1]);
  assert.notEqual(identities[1], identities[2]);
  assert.deepEqual(candidates, [candidate, candidate, candidate]);
  assert.equal(f.worker.launches.length, 2);
});

test("confirmed bounded expiry grows later budgets while a lost reply preserves the exact request", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let run = await f.registry.update({ ...f.run, config: { ...f.run.config,
    executionLifetime: { mode: "bounded", timeoutMs: 1_000 } } });
  run = await f.controller.tick(run.id, "session");
  assert.deepEqual(run.activeOperation?.expectedLifetime, { mode: "bounded", timeoutMs: 1_000 });
  t.mock.timers.tick(1_000);
  f.worker.activity = { phase: "model_stream", lastModelActivityAt: Date.now() };
  f.worker.state = "failed";
  f.worker.terminationReason = "execution_lifetime_expired";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.budgetExhaustions, undefined);
  assert.ok(run.activeOperation);
  f.worker.proof = true;
  run = await due(f.registry, run);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.budgetExhaustions?.["task:1"], 1);
  for (let expiry = 1; expiry <= 2; expiry++) {
    run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
      "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
    f.worker.state = "running";
    if (expiry === 2) f.worker.loseSpawn = true;
    run = await f.controller.tick(run.id, "session");
    assert.deepEqual(run.activeOperation?.expectedLifetime, { mode: "bounded", timeoutMs: 1_000 * 2 ** expiry });
    assert.deepEqual(run.config.executionLifetime, { mode: "bounded", timeoutMs: 1_000 });
    assert.match(String(f.worker.launches.at(-1)?.params.task), /Resume the preserved checkpoint/);
    if (expiry === 1) {
      t.mock.timers.tick(2_000);
      f.worker.activity = { phase: "model_stream", lastModelActivityAt: Date.now() };
      f.worker.state = "failed";
      run = await f.controller.tick(run.id, "session");
      assert.equal(run.budgetExhaustions?.["task:1"], 2);
    }
  }
  const operationId = run.activeOperation!.operationId;
  const digest = run.activeOperation!.requestDigest;
  assert.equal(run.activeOperation?.externalRunId, undefined);
  run = await due(f.registry, run);
  run = await new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor).tick(run.id, "session");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(run.activeOperation?.requestDigest, digest);
  assert.deepEqual(run.activeOperation?.effectiveLifetime, { mode: "bounded", timeoutMs: 4_000 });
  assert.equal(f.worker.launches.length, 3);
});

test("bounded compatibility stops growing at the supported timer maximum without ending recovery", async (t) => {
  const f = await fixture(t);
  let run = await f.registry.update({ ...f.run, config: { ...f.run.config,
    executionLifetime: { mode: "bounded", timeoutMs: MAX_EXECUTION_TIMEOUT_MS - 1 } },
    budgetExhaustions: { "task:1": 2 },
    budgetGrowths: { "task:1": 2 },
  });
  run = await f.controller.tick(run.id, "session");
  assert.deepEqual(run.activeOperation?.expectedLifetime, { mode: "bounded", timeoutMs: MAX_EXECUTION_TIMEOUT_MS });
  assert.match(String(f.worker.launches[0]?.params.task), /narrow the session's scope and checkpoint earlier/);
  assert.equal(run.status, "running");
});

test("silent unbounded workers never acquire a synthetic execution budget", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let run = await f.controller.tick(f.run.id, "session");
  const id = run.activeOperation!.operationId;
  t.mock.timers.tick(60 * 60 * 1_000);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.operationId, id);
  assert.deepEqual(run.activeOperation?.expectedLifetime, { mode: "unbounded" });
  assert.deepEqual(run.activeOperation?.effectiveLifetime, { mode: "unbounded" });
  assert.equal(run.budgetExhaustions, undefined);
  assert.equal(f.worker.launches.length, 1);
});

test("ordinary tool timeout text cannot grow a bounded session budget", async (t) => {
  const f = await fixture(t);
  let run = await f.registry.update({ ...f.run, config: { ...f.run.config, executionLifetime: { mode: "bounded", timeoutMs: 1_000 } } });
  run = await f.controller.tick(run.id, "session");
  f.worker.state = "failed"; f.worker.proof = true;
  const status = f.worker.status.bind(f.worker);
  f.worker.status = async (id) => {
    const reply = await status(id);
    if (reply.success) reply.data.text = "Error: a tool command timed out";
    return reply;
  };
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.budgetExhaustions, undefined);
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks, "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await f.controller.tick(run.id, "session");
  assert.deepEqual(run.activeOperation?.expectedLifetime, { mode: "bounded", timeoutMs: 1_000 });
});

test("confirmed expiry is counted once when result consumption is interrupted", async (t) => {
  const f = await fixture(t);
  let run = await f.registry.update({ ...f.run, config: { ...f.run.config, executionLifetime: { mode: "bounded", timeoutMs: 1_000 } } });
  run = await f.controller.tick(run.id, "session");
  const id = run.activeOperation!.operationId;
  f.worker.state = "failed"; f.worker.proof = true; f.worker.terminationReason = "execution_lifetime_expired";
  await rm(f.planPath);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.budgetExhaustions?.["task:1"], 1);
  assert.equal(run.activeOperation?.operationId, id);
  await writeFile(f.planPath, "### Task 1: A\n- [ ] A\n");
  run = await new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor).tick(run.id, "session");
  assert.equal(run.budgetExhaustions?.["task:1"], 1);
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
});

test("generic mention of credentials remains a diagnostic retry without prerequisite evidence", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  f.worker.state = "failed"; f.worker.proof = true;
  f.worker.output = "<<<RALPHEX:TASK_FAILED>>>\nBlocker: maybe credentials or a code error\nNext step: investigate";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  assert.equal(run.tasks?.["1"]?.externalPrerequisite, undefined);
});

test("unavailable runtime preflight is an explicit prerequisite and does not consume a worker attempt", async (t) => {
  const f = await fixture(t);
  const capabilities = f.worker.capabilities.bind(f.worker);
  f.worker.capabilities = async () => ({ ...await capabilities(), healthy: false });
  let run = await f.controller.tick(f.run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "waiting_external");
  assert.equal(run.tasks?.["1"]?.externalPrerequisite?.source, "provider");
  assert.equal(run.tasks?.["1"]?.externalPrerequisite?.kind, "runtime");
  assert.match(run.tasks?.["1"]?.reason ?? "", /Capability probe/);
  assert.equal(run.tasks?.["1"]?.attempts, 0);
  assert.equal(f.worker.launches.length, 0);
  f.worker.capabilities = capabilities;
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.taskId, 1);
  assert.equal(f.worker.launches.length, 1);
});

test("structured tool diagnosis preserves the session and schedules probes without unsupported repair", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  const id = run.activeOperation!.operationId;
  const eventAt = Date.now();
  f.worker.activity = { phase: "tool_in_flight", currentTool: "bash", toolCallId: "tool-1", runnerPid: 4242,
    currentToolStartedAt: eventAt, lastActivityAt: eventAt, lastToolActivityAt: eventAt,
    lastToolFailure: { kind: "tool-execution-error", toolCallId: "tool-1", toolName: "bash", observedAt: eventAt,
      message: "ENOENT: build executable missing" } };
  run = await f.controller.tick(run.id, "session");
  const diagnosed = run.activeOperation!.diagnostics!;
  assert.equal(diagnosed.assessment, "tool_fault_reported");
  assert.equal(diagnosed.action, "probe");
  assert.equal(diagnosed.phase, "tool_in_flight");
  assert.equal(diagnosed.runnerPid, 4242);
  assert.equal(diagnosed.lastToolFailure?.message, "ENOENT: build executable missing");
  assert.ok(diagnosed.nextProbeAt >= diagnosed.observedAt);
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.diagnostics?.failureKey, diagnosed.failureKey);
  f.worker.failStatus = true;
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.diagnostics?.assessment, "status_unavailable");
  assert.equal(run.activeOperation?.diagnostics?.phase, "tool_in_flight");
  assert.equal(run.activeOperation?.diagnostics?.action, "probe");
  assert.equal(run.activeOperation?.operationId, id);
  assert.equal(f.worker.launches.length, 1);
});

test("doctor preserves the same launch identity when an empty lookup races a late spawn", async (t) => {
  const f = await fixture(t);
  f.worker.loseSpawn = true;
  let run = await f.controller.tick(f.run.id, "session");
  const operationId = run.activeOperation!.operationId;
  const digest = run.activeOperation!.requestDigest;
  run = await f.registry.release(run);
  const evidence = async () => ({ bridgeState: "absent", durableOperationLookup: true, replaySafe: true });
  const report = await execReconcile(f.registry, evidence);
  assert.match(report, /existing operation identity/);
  run = (await f.registry.get(run.id))!;
  assert.equal(run.status, "running");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(run.activeOperation?.requestDigest, digest);
  assert.equal(run.activeOperation?.processTreeExited, undefined);
  run = (await reconcileForResume(f.registry, run, evidence)).run;
  run = await due(f.registry, run);
  f.worker.loseSpawn = false;
  run = await new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor).resume(run.id, "restarted-session", true);
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(run.activeOperation?.externalRunId, operationId);
  assert.equal(f.worker.launches.length, 1);
});

test("doctor retains a retired worker candidate and consumes its result without repeating implementation", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  const operation = run.activeOperation!;
  await writeFile(f.planPath, "### Task 1: A\n- [x] A\n");
  await f.git("add", "plan.md"); await f.git("commit", "-m", "candidate before doctor recovery");
  const candidate = await f.git("rev-parse", "HEAD");
  run = await f.registry.update({ ...run, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, state: "verifying", candidateCommit: candidate } } });
  run = await f.registry.release(run);
  f.worker.state = "complete"; f.worker.proof = true;
  const proof = processTerminalProof(observedWorkerProof(operation.externalRunId!, operation.requestDigest!), operation.externalRunId!,
    { operationId: operation.operationId, requestDigest: operation.requestDigest! });
  assert.ok(proof);
  await execReconcile(f.registry, async () => ({ processTerminalProof: proof }));
  run = (await f.registry.get(run.id))!;
  assert.equal(run.activeOperation?.operationId, operation.operationId);
  assert.equal(run.activeOperation?.processTreeExited, true);
  assert.equal(run.tasks?.["1"]?.candidateCommit, candidate);
  run = await new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor).resume(run.id, "restarted-session", true);
  assert.equal(run.tasks?.["1"]?.state, "accepted");
  assert.equal(run.acceptedHead, candidate);
  assert.equal(f.worker.launches.length, 1);
});

test("pause persists cancellation before RPC and early resume cannot replace the live attempt", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  const id = run.activeOperation!.operationId;
  const stop = f.worker.stop.bind(f.worker);
  f.worker.stop = async () => {
    const current = await f.registry.get(run.id);
    assert.equal(current?.activeOperation?.stopRequested, true);
    return stop();
  };
  run = await f.registry.update({ ...run, status: "paused", userStopped: true, stopGeneration: 1 });
  run = await f.controller.advance(run);
  assert.equal(run.status, "paused");
  assert.equal(run.activeOperation?.stopAcknowledged, true);
  assert.equal(run.activeOperation?.processTreeExited, undefined);
  assert.equal(f.worker.stopCalls, 1);
  run = await f.controller.resume(run.id, "session", true);
  assert.equal(run.activeOperation?.operationId, id);
  assert.equal(f.worker.launches.length, 1);
  f.worker.state = "stopped"; f.worker.proof = true;
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  assert.equal(run.activeOperation, undefined);
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await f.controller.tick(run.id, "session");
  assert.notEqual(run.activeOperation?.operationId, id);
  assert.equal(f.worker.launches.length, 2);
});

test("pause cancellation reply loss retries the same fence without claiming worker exit", async (t) => {
  const f = await fixture(t);
  let run = await f.controller.tick(f.run.id, "session");
  const id = run.activeOperation!.operationId;
  let requests = 0;
  f.worker.stop = async () => {
    requests++;
    return requests === 1 ? { success: false, error: { code: "timeout", message: "cancel reply lost" } } : ok({ state: "stopping" });
  };
  run = await f.registry.update({ ...run, status: "paused", userStopped: true, stopGeneration: 1 });
  run = await f.controller.advance(run);
  assert.equal(run.activeOperation?.stopRequested, true);
  assert.equal(run.activeOperation?.stopAcknowledged, undefined);
  run = await due(f.registry, run);
  run = await f.controller.tick(run.id, "session");
  assert.equal(requests, 2);
  assert.equal(run.status, "paused");
  assert.equal(run.activeOperation?.operationId, id);
  assert.equal(run.activeOperation?.stopAcknowledged, true);
  assert.equal(run.activeOperation?.processTreeExited, undefined);
  assert.equal(f.worker.launches.length, 1);
});

test("confirmed tool guidance replays one durable action after reply loss and never marks the tool repaired", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const worker = new GuidingWorker(f.worker.resultPath);
  worker.activity = { phase: "model_stream", lastToolFailure: { kind: "tool-execution-error", toolCallId: "failed-tool", toolName: "bash", observedAt: Date.now(), message: "build command exited 1" } };
  let controller = new PlanExecController(f.registry, worker, fusion, command, f.localExecutor);
  let run = await controller.tick(f.run.id, "session");
  const id = run.activeOperation!.operationId;
  run = await controller.tick(run.id, "session");
  const first = Object.values(run.activeOperation!.diagnosticActions!)[0]!;
  assert.equal(first.state, "pending");
  t.mock.timers.tick(f.run.config.retryDelayMs);
  controller = new PlanExecController(f.registry, worker, fusion, command, f.localExecutor);
  run = await controller.tick(run.id, "session");
  const second = Object.values(run.activeOperation!.diagnosticActions!)[0]!;
  assert.equal(second.diagnosticId, first.diagnosticId);
  assert.equal(second.state, "queued");
  assert.equal(run.activeOperation?.diagnostics?.assessment, "tool_fault_reported");
  assert.deepEqual(worker.guidanceCalls[0], worker.guidanceCalls[1]);
  assert.equal(worker.queued.size, 1);
  run = await controller.tick(run.id, "session");
  assert.equal(worker.guidanceCalls.length, 2);
  assert.equal(run.activeOperation?.operationId, id);
  assert.equal(worker.launches.length, 1);
});

test("pause delivers its fence while diagnostic RPC is pending and ignores the late queued acknowledgment", async (t) => {
  const f = await fixture(t);
  const worker = new GuidingWorker(f.worker.resultPath);
  worker.activity = { phase: "model_stream", lastToolFailure: { kind: "tool-execution-error", toolCallId: "failed-tool", toolName: "bash", observedAt: Date.now(), message: "build command exited 1" } };
  let entered!: () => void;
  let release!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const replyGate = new Promise<void>((resolve) => { release = resolve; });
  worker.diagnoseOperation = async (operationId, owner, params) => {
    worker.guidanceCalls.push({ operationId, owner, params });
    entered();
    await replyGate;
    return ok({ operationId, requestDigest: owner.requestDigest, diagnosticId: params.diagnosticId,
      toolCallId: params.toolCallId, guidanceOnly: true, state: "queued" });
  };
  const controller = new PlanExecController(f.registry, worker, fusion, command, f.localExecutor);
  let run = await controller.tick(f.run.id, "session");
  const pending = controller.tick(run.id, "session");
  await entry;
  run = (await f.registry.get(run.id))!;
  run = await f.registry.update({ ...run, status: "paused", userStopped: true, stopGeneration: 1 });
  run = await controller.advance(run);
  assert.equal(worker.stopCalls, 1);
  assert.equal(run.status, "paused");
  release();
  run = await pending;
  assert.equal(run.status, "paused");
  assert.equal(Object.values(run.activeOperation!.diagnosticActions!)[0]?.state, "pending");
  await controller.tick(run.id, "session");
  assert.equal(worker.guidanceCalls.length, 1);
  assert.equal(worker.launches.length, 1);
});

test("pause fences a child whose spawn reply is still pending", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const replyGate = new Promise<void>((resolve) => { release = resolve; });
  const spawn = f.worker.spawn.bind(f.worker);
  f.worker.spawn = async (id, params) => {
    const reply = await spawn(id, params);
    entered();
    await replyGate;
    return reply;
  };
  const pending = f.controller.tick(f.run.id, "session");
  await entry;
  let run = (await f.registry.get(f.run.id))!;
  const operationId = run.activeOperation!.operationId;
  run = await f.registry.update({ ...run, status: "paused", userStopped: true, stopGeneration: 1 });
  run = await f.controller.advance(run);
  assert.equal(f.worker.stopCalls, 1);
  assert.equal(run.status, "paused");
  release();
  run = await pending;
  assert.equal(run.status, "paused");
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(f.worker.launches.length, 1);
});

test("diagnostic capability does not trigger guidance or cancellation for a silent healthy tool", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const worker = new GuidingWorker(f.worker.resultPath);
  worker.activity = { phase: "tool_in_flight", currentTool: "bash", toolCallId: "healthy-check", currentToolStartedAt: Date.now() };
  const controller = new PlanExecController(f.registry, worker, fusion, command, f.localExecutor);
  let run = await controller.tick(f.run.id, "session");
  t.mock.timers.tick(60 * 60 * 1_000);
  run = await controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.diagnostics?.assessment, "observing");
  assert.equal(run.activeOperation?.diagnostics?.action, "probe");
  assert.equal(worker.guidanceCalls.length, 0);
  assert.equal(worker.stopCalls, 0);
  assert.equal(worker.launches.length, 1);
});

test("initial worktree creation records ownership before any Git mutation", async (t) => {
  const f = await fixture(t);
  await f.git("branch", "main");
  const invocations: string[] = [];
  const execute: typeof runCommands = async (cwd, commands, options) => {
    invocations.push(options.operationId);
    const persisted = await f.registry.get(options.runId);
    assert.equal(persisted?.id, createdRunId);
    assert.equal(persisted?.lanePreparation?.state, "create");
    assert.equal(persisted?.lanePreparation?.sourcePlanPath, f.planPath);
    assert.equal(cwd, f.root);
    await runCommands(cwd, commands, options);
  };
  const controller = new PlanExecController(f.registry, f.worker, fusion, command, execute);
  let run = await controller.start({ cwd: f.root, planPath: f.planPath, useWorktree: true, sessionId: "initial-session" });
  const createdRunId = run.id;
  t.after(() => rm(run.worktreeCwd, { recursive: true, force: true }));
  assert.equal(run.lanePreparation?.state, "create");
  assert.equal(invocations.length, 0);
  await assert.rejects(readFile(join(run.worktreeCwd, ".git")), /ENOENT/);
  for (let attempt = 0; attempt < 4 && run.lanePreparation?.state === "create"; attempt++) {
    run = await due(f.registry, run);
    run = await controller.tick(run.id, "initial-session");
  }
  assert.equal(run.lanePreparation?.state, "bootstrap", run.error ?? "worktree creation did not settle");
  assert.equal(new Set(invocations).size, 1);
  assert.match(await readFile(join(run.worktreeCwd, ".git"), "utf8"), /gitdir:/);
});

test("bounded expiry without recent useful progress retries with a changed strategy but unchanged budget", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let run = await f.registry.update({ ...f.run, config: { ...f.run.config, executionLifetime: { mode: "bounded", timeoutMs: 1_000 } } });
  run = await f.controller.tick(run.id, "session");
  f.worker.activity = { phase: "tool_in_flight", currentTool: "bash", lastModelActivityAt: Date.now(), lastActivityAt: Date.now() };
  t.mock.timers.tick(1_000);
  f.worker.activity.lastActivityAt = Date.now();
  f.worker.state = "failed"; f.worker.proof = true; f.worker.terminationReason = "execution_lifetime_expired";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.budgetExhaustions?.["task:1"], 1);
  assert.equal(run.budgetGrowths, undefined);
  assert.equal(run.failedOperation?.budgetGrowthGranted, false);
  assert.equal(run.tasks?.["1"]?.state, "retry_wait");
  t.mock.timers.tick(f.run.config.retryDelayMs);
  run = await f.controller.tick(run.id, "session");
  assert.deepEqual(run.activeOperation?.expectedLifetime, { mode: "bounded", timeoutMs: 1_000 });
  assert.match(String(f.worker.launches.at(-1)?.params.task), /0 had recent verified model\/tool progress qualifying for growth/);
  assert.match(String(f.worker.launches.at(-1)?.params.task), /Change the previous approach/);
});

test("cancel retains the worktree fence until a local command proves retirement", async (t) => {
  const f = await fixture(t);
  const started = join(f.root, ".git", "local-started");
  const retired = join(f.root, ".git", "local-retired");
  const runtimePath = join(f.root, ".git", "local-runtime.mjs");
  await writeFile(runtimePath, `import { readFile, writeFile } from 'node:fs/promises';
const binding={operationId:'local-owned',requestDigest:'local-digest',hostId:'host',bootId:'boot'};
export async function prepareKernelOwnedProcess(request){return {...binding,operationDirectory:request.operationDirectory,stdoutPath:'out',stderrPath:'err'};}
export async function launchKernelOwnedProcess(request){await writeFile(${JSON.stringify(started)},'yes');return {observation:await observeKernelOwnedProcess(request.operationDirectory)};}
export async function observeKernelOwnedProcess(directory){
  let done=false;try{done=await readFile(${JSON.stringify(retired)},'utf8')==='yes';}catch{}
  return done?{status:'retired',operationDirectory:directory,exitCode:0,proof:{...binding,kind:'darwin-coalition-retired',identity:{...binding,version:1,backend:'darwin-resource-coalition-v1',coalitionId:'123',leader:{pid:123,uniqueId:'1',pidVersion:1}}}}:{status:'active',operationDirectory:directory,binding};
}
export async function requestKernelOwnedProcessCancellation(){}
export async function cancelKernelOwnedProcess(directory){return observeKernelOwnedProcess(directory);}
export async function reconcileKernelOwnedProcess(directory){return observeKernelOwnedProcess(directory);}
`);
  const running = runLocalOperation(f.root, [["unused"]], {
    journalRoot: join(f.root, ".git", "local-jobs"), runId: f.run.id, operationId: "verification",
    activeDirectory: f.registry.localOperationsPath(f.run.id), runtimeModule: pathToFileURL(runtimePath).href,
    authorization: { path: f.registry.authorizationPath(f.run.id), stopGeneration: 0 },
    isAuthorized: async () => (await f.registry.get(f.run.id))?.status === "running",
  }).then(() => undefined, (error: unknown) => error);
  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try { await readFile(started); break; } catch { if (Date.now() > deadline) throw new Error("Local command was not started."); }
      await delay(10);
    }
    let run = (await f.registry.get(f.run.id))!;
    assert.equal(run.localOperationActive, true);
    run = await f.registry.update({ ...run, status: "cancel_pending", userStopped: true, stopGeneration: 1 });
    run = await f.controller.advance(run);
    assert.equal(run.status, "cancel_pending");
    assert.equal(run.localOperationActive, true);
    await assert.rejects(f.registry.assertExclusive({ worktreeCwd: f.root, planPath: f.planPath }), /already exists/);
    await writeFile(retired, "yes");
    assert.ok(await running instanceof LocalOperationCancelledError);
    run = await new PlanExecController(f.registry, f.worker, fusion, command, f.localExecutor).advance((await f.registry.get(run.id))!);
    assert.equal(run.status, "cancelled");
    assert.equal(run.localOperationActive, undefined);
    assert.equal(f.worker.launches.length, 0);
  } finally {
    await writeFile(retired, "yes");
    await running;
  }
});
