import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { fixtureGitEnvironment } from "./fixtures/autonomous-git-environment.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(project, ".pi", "autonomous-runtime-smoke");
await mkdir(artifactRoot, { recursive: true });
const sandbox = await mkdtemp(join(artifactRoot, "run-"));
for (const key of Object.keys(process.env)) {
  if (!["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "SystemRoot", "NODE_TEST_CONTEXT"].includes(key)) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
os.homedir = () => sandbox;
syncBuiltinESMExports();
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
process.env.PI_SUBAGENTS_TEMP_ROOT = join(sandbox, "native");
process.env.PI_AUTONOMOUS_SMOKE_CALLS = join(sandbox, "scripted-model-calls.jsonl");
const preload = join(sandbox, "isolate.mjs");
await writeFile(preload, `import os from "node:os"; import { syncBuiltinESMExports } from "node:module"; os.homedir = () => ${JSON.stringify(sandbox)}; syncBuiltinESMExports();\n`);
process.env.NODE_OPTIONS = `--import=${preload}`;

const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
const installedLock = JSON.parse(await readFile(join(project, "node_modules/.package-lock.json"), "utf8"));
const nativeRevision = /#([a-f0-9]{40})$/.exec(manifest.dependencies?.["pi-subagents"] ?? "")?.[1];
assert.ok(nativeRevision, "pi-subagents must use an immutable Git pin");
for (const source of [lock, installedLock]) {
  assert.ok(source.packages["node_modules/pi-subagents"].resolved.endsWith(`#${nativeRevision}`), "pi-subagents installed package must match the declared pin");
}
for (const name of ["@alexeiled/pi-subagents-bridge", "@alexeiled/pi-fusion"]) {
  const declared = manifest.devDependencies?.[name];
  assert.match(declared ?? "", /^\^\d+\.\d+\.\d+$/, `${name} must use a released registry pin`);
  const [major, minor, patch] = declared.slice(1).split(".").map(Number);
  for (const source of [lock, installedLock]) {
    const entry = source.packages[`node_modules/${name}`];
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, `${name} must resolve from the registry`);
    const [installedMajor, installedMinor, installedPatch] = String(entry.version).split(".").map(Number);
    assert.ok(installedMajor === major && installedMinor === minor && installedPatch >= patch, `${name} installed version must satisfy the declared range`);
  }
}
const nativeRoot = join(project, "node_modules/pi-subagents");
const bridgeRoot = join(project, "node_modules/@alexeiled/pi-subagents-bridge");
const jiti = createJiti(import.meta.url);
const { createSubagentExecutor } = await jiti.import(join(nativeRoot, "src/runs/foreground/subagent-executor.ts"));
const { registerSubagentRpcBridge } = await jiti.import(join(nativeRoot, "src/extension/rpc.ts"));
const { setChildSessionFactoryModule } = await jiti.import(join(nativeRoot, "src/runs/shared/child-session.ts"));
const { ASYNC_DIR, RESULTS_DIR } = await jiti.import(join(nativeRoot, "src/shared/types.ts"));
const { registerPlanExecRpc } = await jiti.import(join(bridgeRoot, "src/plan-exec-rpc.ts"));
const { BridgeClient, hasKernelRetirementProof, hasTerminalOwnershipProof } = await jiti.import(join(project, "src/bridge.ts"));
const { cancelKernelOwnedProcess, observeKernelOwnedProcess, preflightKernelOwnedProcess } = await import("pi-subagents/kernel-owned-process");
const { PlanExecController } = await jiti.import(join(project, "src/controller.ts"));
const { RunRegistry } = await jiti.import(join(project, "src/registry.ts"));
const { readPlan } = await jiti.import(join(project, "src/plan.ts"));
const { DEFAULT_FROZEN_RUN_CONFIG } = await jiti.import(join(project, "src/types.ts"));

test("scripted model completes real controller, Bridge, kernel-owned workers, checks, review and promotion", { timeout: 120_000 }, async (t) => {
  t.diagnostic(`Retained smoke evidence: ${sandbox}; model turns are scripted, not a live-LLM guarantee.`);
  const root = join(sandbox, "repository");
  const lane = join(sandbox, "execution-lane");
  const localRoot = join(root, ".git/plan-exec-local/local-operations");
  await mkdir(root);
  const inheritedHookEnvironment = { ...process.env, GIT_DIR: join(sandbox, "canary-metadata"), GIT_WORK_TREE: join(sandbox, "canary-worktree"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true", GIT_INDEX_FILE: join(sandbox, "canary-index") };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: fixtureGitEnvironment(inheritedHookEnvironment), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-b", "feature");
  for (const [key, value] of [["user.email", "smoke@example.test"], ["user.name", "Runtime Smoke"], ["commit.gpgSign", "false"], ["core.hooksPath", "/dev/null"]]) git(root, "config", key, value);
  await writeFile(join(root, "plan.md"), "### Task 1: Deliver fixture\n- [ ] Deliver fixture\n");
  await writeFile(join(root, "check.mjs"), 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; assert.equal(readFileSync("result.txt", "utf8"), "autonomous runtime smoke\\n");\n');
  git(root, "add", "plan.md", "check.mjs");
  git(root, "commit", "-m", "Smoke baseline");
  assert.equal(git(root, "rev-parse", "--absolute-git-dir"), join(root, ".git"));
  await assert.rejects(access(inheritedHookEnvironment.GIT_DIR), { code: "ENOENT" });
  await assert.rejects(access(inheritedHookEnvironment.GIT_INDEX_FILE), { code: "ENOENT" });
  const baseline = git(root, "rev-parse", "HEAD");
  git(root, "worktree", "add", "-b", "execution", lane, baseline);
  const emitter = new EventEmitter();
  const requests = [];
  const events = {
    on(name, handler) { emitter.on(name, handler); return () => emitter.off(name, handler); },
    emit(name, value) {
      if (name === "plan-exec:bridge:v2:request" && value.method === "spawn") requests.push(value);
      emitter.emit(name, value);
    },
  };
  const sessionId = "autonomous-runtime-smoke";
  const ctx = { cwd: lane, hasUI: false, ui: {}, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null }, modelRegistry: { getAvailable: () => [] } };
  const state = { baseCwd: lane, currentSessionId: sessionId, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, workflowControllers: new Map() };
  const agents = ["worker", "reviewer"].map((name) => ({ name, description: `Scripted smoke ${name}`, systemPrompt: "", systemPromptMode: "replace", inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false }));
  setChildSessionFactoryModule(join(project, "test/fixtures/autonomous-scripted-session.mjs"));
  const executor = createSubagentExecutor({ pi: { events, getSessionName: () => undefined, sendMessage() {} }, state,
    config: { worktree: true, worktreeProvider: "native", worktreeBaseDir: join(sandbox, "native-worktrees") }, asyncByDefault: false,
    tempArtifactsDir: join(sandbox, "artifacts"), getSubagentSessionRoot: () => join(sandbox, "sessions"), expandTilde: (value) => value, discoverAgents: () => ({ agents }) });
  const nativeRpc = registerSubagentRpcBridge({ events, state, asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR, getContext: () => ctx, execute: (...args) => executor.executePublic(...args) });
  const bridgeRpc = registerPlanExecRpc(events, { timeoutMs: 15_000, journalPath: join(sandbox, "bridge.sqlite") });
  const bridge = new BridgeClient(events, 20_000, 2_000);
  t.after(async () => {
    try {
      for (const request of requests) {
        const binding = { operationId: request.operationId, requestDigest: request.owner.requestDigest };
        const terminal = (operation) => operation.data?.neverStarted || hasTerminalOwnershipProof(operation.data ?? {}, operation.data?.runId, binding);
        let operation = await bridge.operation(request.operationId, request.owner);
        if (!terminal(operation)) {
          await bridge.cancelOperation(request.operationId, request.owner);
          const deadline = Date.now() + 15_000;
          do {
            await delay(100);
            operation = await bridge.operation(request.operationId, request.owner);
          } while (Date.now() < deadline && !terminal(operation));
        }
        assert.ok(terminal(operation), `Owned runtime cleanup proof missing: ${request.operationId}`);
      }
      for (const directory of await readdir(localRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
        const generation = join(localRoot, directory, "generation-0");
        const binding = JSON.parse(await readFile(join(generation, "binding.json"), "utf8"));
        let observation = await observeKernelOwnedProcess(join(generation, "owned-process"));
        if (!hasKernelRetirementProof(observation, binding)) observation = await cancelKernelOwnedProcess(join(generation, "owned-process"), { deadlineMs: 15_000 });
        assert.ok(hasKernelRetirementProof(observation, binding) || observation.status === "never-started" && observation.proof?.kind === "never-started" && ["operationId", "requestDigest", "hostId", "bootId"].every((key) => observation.proof[key] === binding[key]),
          `Local check cleanup proof missing: ${directory}`);
      }
    } finally {
      bridgeRpc.dispose();
      nativeRpc.dispose();
      setChildSessionFactoryModule(undefined);
    }
  });
  assert.equal((await preflightKernelOwnedProcess({ artifactDirectory: join(ASYNC_DIR, "kernel-cache") })).supported, true);
  const capabilities = await bridge.capabilities();
  assert.equal(capabilities.processTreeOwnership?.scope, "owned-process-tree");
  assert.equal(capabilities.processTreeOwnership?.escapedDescendants, "contained");
  const command = async (program, args, cwd) => {
    try { return { stdout: execFileSync(program, args, { cwd, ...(program === "git" ? { env: fixtureGitEnvironment(inheritedHookEnvironment) } : {}), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 }; }
    catch (error) { return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: error.status ?? 1 }; }
  };
  const registry = new RunRegistry(join(root, ".git", "plan-exec-runs"));
  const fusion = new Proxy({}, { get: () => () => { throw new Error("Smoke requires the configured single-subagent review"); } });
  const controller = new PlanExecController(registry, bridge, fusion, command);
  const plan = await readPlan(join(lane, "plan.md"));
  const seed = { schemaVersion: 1, repositoryRoot: root, worktreeCwd: lane, planPath: plan.path, planHash: plan.hash,
    branch: "execution", defaultBranch: "main", outputTarget: { cwd: root, branch: "feature", initialHead: baseline, planRelativePath: "plan.md" },
    stage: "resolve", status: "running", taskAttempts: {}, stageAttempts: {}, reviewFindings: [], unresolvedFindings: [], skippedStages: [], branchRebindings: [],
    config: { ...DEFAULT_FROZEN_RUN_CONFIG, retryDelayMs: 100, requiredChecks: [[process.execPath, "check.mjs"]] } };
  let rejected = await registry.create({ ...seed, stage: "implementation",
    config: { ...seed.config, workerAgent: "missing-smoke-agent" } });
  for (let step = 0; step < 10 && !rejected.failedOperation?.launchFenced; step++) {
    rejected = await registry.update({ ...rejected, nextAttemptAt: 0,
      ...(rejected.activeOperation ? { activeOperation: { ...rejected.activeOperation, launchStartedAt: 0 } } : {}) });
    rejected = await controller.tick(rejected.id, sessionId);
  }
  assert.equal(rejected.failedOperation?.launchFenced, true, rejected.error ?? "Rejected launch did not reconcile");
  assert.equal(rejected.activeOperation, undefined);
  assert.equal(rejected.tasks["1"].state, "retry_wait");
  assert.ok(rejected.tasks["1"].nextAttemptAt > Date.now());
  await assert.rejects(access(process.env.PI_AUTONOMOUS_SMOKE_CALLS), { code: "ENOENT" });
  const rejectedOperationId = rejected.failedOperation.operationId;
  const rejectedEvidence = { runId: rejected.id, operationId: rejectedOperationId,
    state: rejected.tasks["1"].state, nextAttemptAt: rejected.tasks["1"].nextAttemptAt, modelSessions: 0 };
  rejected = await registry.update({ ...rejected, status: "cancel_pending", userStopped: true, stopGeneration: 1 });
  rejected = await controller.tick(rejected.id, sessionId);
  assert.equal(rejected.status, "cancelled");
  let run = await registry.create(seed);
  const transitions = [];
  const deadline = Date.now() + 90_000;
  while (run.status === "running" && Date.now() < deadline) {
    run = await controller.tick(run.id, sessionId);
    const transition = { status: run.status, stage: run.stage, operation: run.activeOperation?.operationId, wakeReason: run.wakeReason, error: run.error };
    if (JSON.stringify(transitions.at(-1)) !== JSON.stringify(transition)) transitions.push(transition);
    if (run.tasks?.["1"]?.state === "retry_wait" || (run.stageAttempts.comprehensive_review ?? 0) > 1) break;
    if (run.activeOperation || (run.nextAttemptAt ?? 0) > Date.now()) await delay(100);
  }
  await writeFile(join(sandbox, "evidence.json"), JSON.stringify({ model: "scripted", rejectedEvidence, pins: { native: manifest.dependencies["pi-subagents"], bridge: manifest.devDependencies["@alexeiled/pi-subagents-bridge"] }, run, transitions }, null, 2));
  assert.equal(run.status, "completed", JSON.stringify(transitions));
  assert.equal(run.tasks["1"].state, "accepted");
  assert.notEqual(run.acceptedHead, baseline);
  assert.equal(run.outputPromotion?.state, "complete");
  assert.equal(run.outputPromotion?.candidate, run.acceptedHead);
  assert.equal(run.reviewedCommit, run.acceptedHead);
  assert.equal(run.verifiedCommit, run.acceptedHead);
  assert.equal(run.worktreeCwd, root);
  assert.match(await readFile(join(root, "completed/plan.md"), "utf8"), /- \[x\] Deliver fixture/);
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "autonomous runtime smoke\n");
  git(root, "merge-base", "--is-ancestor", run.acceptedHead, "HEAD");
  const calls = (await readFile(process.env.PI_AUTONOMOUS_SMOKE_CALLS, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.agent), ["worker", "reviewer"]);
  assert.equal(calls[0].cwd, lane);
  assert.equal(calls[1].cwd, lane);
  assert.equal(calls[1].output, "NO_FINDINGS");
  assert.ok(calls.every((call) => call.pid !== process.pid && call.executionLifetime.mode === "unbounded"));
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.params.worktree, false);
    const operation = await bridge.operation(request.operationId, request.owner);
    const terminal = hasTerminalOwnershipProof(operation.data, operation.data.runId, { operationId: request.operationId, requestDigest: request.owner.requestDigest });
    if (request.operationId === rejectedOperationId) {
      assert.equal(operation.data.operationId, request.operationId);
      assert.equal(operation.data.requestDigest, request.owner.requestDigest);
      assert.equal(operation.data.neverStarted, true);
      assert.equal(operation.data.cancellationRequested, true);
      assert.equal(terminal, false);
    } else assert.ok(terminal);
  }
  const localDirectories = await readdir(localRoot);
  let requiredCheckRuns = 0;
  for (const directory of localDirectories) {
    const generation = join(localRoot, directory, "generation-0");
    const intent = JSON.parse(await readFile(join(generation, "intent.json"), "utf8"));
    if (JSON.stringify(intent.commands) === JSON.stringify([[process.execPath, "check.mjs"]])) {
      requiredCheckRuns++;
      assert.equal(intent.candidate, run.acceptedHead);
    }
    const binding = JSON.parse(await readFile(join(generation, "binding.json"), "utf8"));
    const observation = await observeKernelOwnedProcess(join(generation, "owned-process"));
    assert.ok(hasKernelRetirementProof(observation, binding));
    assert.equal(observation.exitCode, 0);
  }
  assert.ok(requiredCheckRuns >= 2, "Required checks must execute for candidate acceptance and final verification");
});
