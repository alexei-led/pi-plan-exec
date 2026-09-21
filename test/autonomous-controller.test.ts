import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { PlanExecController } from "../src/controller.js";
import { bridgeRequestDigest } from "../src/bridge.js";
import { readPlan } from "../src/plan.js";
import { RunRegistry } from "../src/registry.js";
import { reconcileTasks, selectReadyTask } from "../src/scheduler.js";
import { DEFAULT_FROZEN_RUN_CONFIG, type BridgeResult, type PlanExecRun } from "../src/types.js";
import type { RunCommand } from "../src/git.js";

const execute = promisify(execFile);
const command: RunCommand = async (program, args, cwd) => {
  try { const r = await execute(program, args, { cwd }); return { ...r, code: 0 }; }
  catch (error) { const r = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 1 }; }
};
const ok = (data: Record<string, unknown>): BridgeResult => ({ success: true, data });
class Worker {
  launches: { id: string; params: Record<string, unknown> }[] = [];
  output = "";
  state = "running";
  proof = false;
  failStatus = false;
  loseSpawn = false;
  totalTokens?: { input: number; output: number; total: number };
  totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
  constructor(readonly resultPath: string) {}
  async capabilities() { return { protocolVersion: 2 as const, healthy: true, workflowScriptSpawn: true, durableOperationLookup: true, processTerminalProofVersion: 1, executionLifetimeVersion: 1 as const, executionLifetimeModes: ["unbounded" as const, "bounded" as const], processTreeOwnership: { version: 1 as const, scope: "owned-process-tree" as const, escapedDescendants: "contained" as const } }; }
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
      ...(this.totalTokens ? { totalTokens: this.totalTokens } : {}),
      ...(this.totalCost ? { totalCost: this.totalCost } : {}),
      ...(this.proof ? { processTerminalProof: { version: 1, state: "observed", runId: id, runnerProcessInstanceId: "instance", observedAt: Date.now(), instances: [], processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" } } } : {}) });
  }
  async result() { await writeFile(this.resultPath, JSON.stringify({ result: this.output })); return ok({ resultPath: this.resultPath }); }
  async adopt() { return ok({}); }
  async stop() { return ok({ state: "stopping" }); }
}
const fusion = { start: async () => ok({}), status: async () => ok({}), result: async () => ok({}), adopt: async () => ok({}), cancel: async () => ok({}) };

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
  const controller = new PlanExecController(registry, worker, fusion, command);
  const run = await registry.create({ schemaVersion: 1, repositoryRoot: root, worktreeCwd: root,
    planPath, planHash: plan.hash, branch: "feature", defaultBranch: "main", stage: "implementation",
    status: "running", taskAttempts: {}, stageAttempts: {}, reviewFindings: [], unresolvedFindings: [],
    config: { ...DEFAULT_FROZEN_RUN_CONFIG, retryDelayMs: 10 }, skippedStages: [], branchRebindings: [],
  });
  return { root, git, registry, worker, controller, run, planPath };
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
  const restarted = new PlanExecController(f.registry, f.worker, fusion, command);
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

test("partial A stays in preserved lane while independent B starts from accepted baseline", async (t) => {
  const content = "### Task 1: A\n- [ ] A\n### Task 2: B\ndependsOn: []\n- [ ] B\n### Task 3: C\ndependsOn: [1]\n- [ ] C\n";
  const f = await fixture(t, content);
  let run = await f.controller.tick(f.run.id, "session");
  await writeFile(join(f.root, "partial.txt"), "A private partial work");
  f.worker.state = "failed"; f.worker.proof = true;
  f.worker.output = "<<<RALPHEX:TASK_FAILED>>>\nBlocker: credentials\nNext step: restore credentials";
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.status, "running");
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
  run = await f.registry.update({ ...run, nextAttemptAt: 0, tasks: { ...run.tasks,
    "1": { ...run.tasks!["1"]!, nextAttemptAt: 0 } } });
  run = await f.controller.tick(run.id, "session");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.taskId, 1);
  await f.git("add", "partial.txt"); await f.git("commit", "-m", "A checkpoint");
  await f.git("merge", "--no-edit", acceptedB);
  await writeFile(f.planPath, bPlan.replace("- [ ] A", "- [x] A"));
  await f.git("add", "plan.md"); await f.git("commit", "-m", "A recovered");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.tasks?.["1"]?.state, "accepted");
  run = await f.controller.tick(run.id, "session");
  assert.equal(run.activeOperation?.taskId, 3);
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
  const restarted = new PlanExecController(f.registry, f.worker, fusion, command);
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
  const controller = new PlanExecController(registry, f.worker, fusion, command);
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
  for (let attempt = 0; attempt < 4 && run.status === "running"; attempt++) run = await f.controller.tick(run.id, "session");
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
