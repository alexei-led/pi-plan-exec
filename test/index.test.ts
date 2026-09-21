import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RunRegistry } from "../src/registry.js";
import { PlanExecController } from "../src/controller.js";
import { LocalOperationFailedError } from "../src/local-operation.js";
import { TaskProjector } from "../src/task-projection.js";
import { createControllerLocalExecutor } from "./fixtures/controller-local-executor.js";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import planExecExtension, {
  abandonedRunsNotice,
  abandonmentProbe,
  bridgeRuntimeCompatible,
  chooseStopOutcome,
  execCleanup,
  execReconcile,
  execHelp,
  execSetup,
  isRemovableRun,
  parseCleanupArguments,
  pausedMessage,
  parseDoctorArguments,
  runEvidence,
  sweepAbandonment,
  type EvidenceProbe,
  execRead,
  execStatus,
  formatRunStatus,
  formatRunWidget,
  getExecArgumentCompletions,
  hasBridgeOperationMethod,
  hasBridgeWorkflowScriptSpawnCapability,
  handleCommand,
  isActionAllowed,
  isRecoverableFailure,
  isStageWaiverAvailable,
  missingRuntimeTools,
  needsPlanStructureReview,
  parseResumeArguments,
  parseResumeOptions,
  parseStartArguments,
  parseSkipReason,
  parseStatusArguments,
  reconcileForResume,
  runActionFor,
  sameMachineRefusal,
  settledRunLines,
  shouldRepairProjectionForSession,
  resumeResultMessage,
  prioritizeRunCandidates,
  recoveryGuidance,
  reviewedPlanHashForResume,
  requestStatus,
  runtimeIntegrationProblem,
  shouldStopBackgroundController,
} from "../src/index.js";
import {
  EXEC_ACTION,
  EXEC_ALIAS_ACTIONS,
  DEFAULT_FROZEN_RUN_CONFIG,
  type PlanExecRun,
} from "../src/types.js";
import {
  longRunningOperation,
  type AbandonmentEvidence,
} from "../src/lifecycle.js";

// Three distinct turn budgets on purpose: with reviewer and stats equal, a
// stats operation routed to the reviewer budget would be invisible.
const config = {
  ...DEFAULT_FROZEN_RUN_CONFIG,
  taskRetries: 1,
  maxTaskIterations: 50,
  reviewIterations: 5,
  fusionIterations: 10,
  finalizeEnabled: true,
  workerAgent: "worker",
  workerMaxTurns: 50,
  reviewerAgent: "reviewer",
  reviewerMaxTurns: 30,
  statsAgent: "reviewer",
  statsMaxTurns: 20,
};

function persistedSession(cwd: string, directory: string): SessionManager {
  const session = SessionManager.create(cwd, directory);
  session.appendMessage({ role: "user", content: "Execute the saved plan.", timestamp: Date.now() });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready to execute." }],
    api: "openai-responses", provider: "openai", model: "test-fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return session;
}

function executionHarness(cwd: string, sessionId: string) {
  type Handler = (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>;
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const notifications: string[] = [];
  const pi = { events: { on() {}, emit() {} },
    on(name: string, handler: Handler) { events.set(name, [...events.get(name) ?? [], handler]); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) { commands.set(name, command); },
    registerTool() {}, getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
    exec: async (program: string, args: string[], options: { cwd: string }) => {
      const result = spawnSync(program, args, { cwd: options.cwd, encoding: "utf8" });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd, hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    ui: { select: async (_title: string, options: string[]) => options.includes("In-place") ? "In-place" : options[0],
      confirm: async () => true, setStatus() {}, setWidget() {}, notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionCommandContext;
  planExecExtension(pi);
  return { ctx, notifications, command: (args: string) => commands.get("exec")!.handler(args, ctx),
    emit: async (name: string, details: Record<string, unknown> = {}) => {
      for (const handler of events.get(name) ?? []) await handler({ type: name, reason: "new", ...details }, ctx);
    } };
}

test("task blocker status and pause notification explain recovery without a crash", () => {
  const blocked = run({
    status: "paused", stage: "implementation",
    blockedTask: { taskId: 4, reason: "Constructor merge and readiness evidence missing." },
  });
  delete blocked.activeOperation;
  const status = formatRunStatus(blocked);
  const notification = pausedMessage(blocked);
  assert.match(status, /paused for a task blocker/);
  for (const message of [status, notification]) {
    assert.match(message, /Task 4/);
    assert.match(message, /Constructor merge and readiness evidence missing/);
    assert.match(message, new RegExp(`/exec resume ${blocked.id}`));
    assert.match(message, /asks before retrying/);
    assert.match(message, /[Nn]o automatic retr/);
    assert.doesNotMatch(message, /failed at|no way past/);
  }
});

test("legacy TASK_FAILED diagnostics show a resumable outside blocker", () => {
  const legacy = run({
    status: "failed", stage: "implementation",
    error: 'Worker workflow-1 ended as complete and left task 4 checkboxes unchecked. Return: {"output":"<<<RALPHEX:TASK_FAILED>>>\\nBlocker: Constructor merge missing."}',
  });
  delete legacy.activeOperation;
  const status = formatRunStatus(legacy);
  assert.match(status, /a task is blocked by something outside this run/);
  assert.match(status, /asks before retrying/);
  assert.doesNotMatch(status, /no way past/);
});

function run(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    repositoryRoot: "/repo",
    planPath: "/repo/docs/plans/example.md",
    planHash: "hash",
    worktreeCwd: "/repo",
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    skippedStages: [],
    branchRebindings: [],
    progressPath: "/repo/.ralphex/progress.txt",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
    },
    config,
    createdAt: 1,
    updatedAt: Date.now(),
    unresolvedFindings: [],
    ...overrides,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PAST_RETENTION = Date.now() - 8 * DAY_MS;
const INSIDE_RETENTION = Date.now() - 6 * DAY_MS;

/** A terminal run with no tracked operation, the shape cleanup considers. */
function retiredRun(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  const retired = run({
    status: "completed",
    stage: "complete",
    updatedAt: PAST_RETENTION,
    ...overrides,
  });
  delete retired.activeOperation;
  return retired;
}

/** Every registry test writes into its own temp directory, never ~/.pi. */
async function seedDirectory(
  runs: PlanExecRun[],
): Promise<{ registry: RunRegistry; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-exec-cleanup-"));
  for (const seed of runs) {
    await mkdir(join(directory, seed.id), { recursive: true });
    await writeFile(
      join(directory, seed.id, "run.json"),
      `${JSON.stringify(seed)}\n`,
      "utf8",
    );
  }
  return { registry: new RunRegistry(directory), directory };
}

async function seedRegistry(runs: PlanExecRun[]): Promise<RunRegistry> {
  return (await seedDirectory(runs)).registry;
}

/** Raw bytes per run directory, so "wrote nothing" can be asserted literally. */
async function snapshotRuns(
  directory: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(directory))
    snapshot[entry] = await readFile(
      join(directory, entry, "run.json"),
      "utf8",
    );
  return snapshot;
}

/** This machine's first label: a name that looks like this machine and is not it. */
function thisHost(): string {
  return hostname().split(".")[0]!;
}

/** Return a local PID whose process has actually exited. A stale heartbeat is
 * not enough proof now that a local live PID fences the lease. */
function reapedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (child.pid === undefined)
    throw new Error("Could not create a reaped process for the lease fixture.");
  return child.pid;
}

const DEAD_LEASE = {
  sessionId: "session-gone",
  pid: reapedPid(),
  heartbeatAt: Date.now() - 10 * 60_000,
  hostname: hostname(),
};

const OWNED_PROCESS_TREE = {
  version: 1 as const,
  scope: "owned-process-tree" as const,
  escapedDescendants: "contained" as const,
};

function observedTerminalProof(
  runId: string,
): NonNullable<AbandonmentEvidence["processTerminalProof"]> {
  return {
    version: 1,
    state: "observed",
    runId,
    runnerProcessInstanceId: "native-instance-1",
    observedAt: 1,
    instances: [],
    processTreeOwnership: OWNED_PROCESS_TREE,
  } as NonNullable<AbandonmentEvidence["processTerminalProof"]>;
}

const LIVE_SESSION_ID = "session-live";

/**
 * Built per use: a module-level `Date.now()` freezes at import, and the 30s
 * staleness bound would turn a shared constant into a dead lease as the suite
 * grows.
 */
function liveLease() {
  return {
    sessionId: LIVE_SESSION_ID,
    pid: process.pid,
    heartbeatAt: Date.now(),
    hostname: hostname(),
  };
}

/** Unique per process: a fixed path in shared /tmp is not the suite's to own. */
const MISSING_ASYNC_DIR = join(
  tmpdir(),
  `pi-plan-exec-async-gone-${randomUUID()}`,
);

/** A stale run fixture. Native process proof is supplied live by each test. */
function abandonedRun(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return run({
    lease: DEAD_LEASE,
    taskAttempts: { "1": 2 },
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      taskId: 1,
      asyncDir: MISSING_ASYNC_DIR,
    },
    ...overrides,
  });
}

function terminalEvidence(runId = "external-1"): AbandonmentEvidence {
  return {
    leaseLive: false,
    asyncDirPresent: false,
    processTerminalProof: observedTerminalProof(runId),
  };
}

const nativeTerminalProbe: EvidenceProbe = async (candidate) => {
  const runId = candidate.activeOperation?.externalRunId;
  return {
    asyncDirPresent: false,
    ...(runId
      ? {
          processTerminalProof: observedTerminalProof(runId),
        }
      : {}),
  };
};

const durableTerminalProbe: EvidenceProbe = async (candidate) => {
  const evidence = await nativeTerminalProbe(candidate);
  return candidate.activeOperation?.externalRunId
    ? evidence
    : {
        ...evidence,
        bridgeState: "absent",
        durableOperationLookup: true,
        replaySafe: true,
      };
};

test("bridge runtime compatibility requires direct owned-agent recovery rather than workflow scripting", () => {
  const v1 = {
    protocolVersion: 1 as const,
    healthy: true,
    workflowScriptSpawn: true,
    durableOperationLookup: false,
  };
  assert.equal(
    bridgeRuntimeCompatible(
      {
        methods: ["ping", "operation"],
        capabilities: { workflowScriptSpawn: true },
      },
      v1,
    ),
    false,
  );
  assert.equal(bridgeRuntimeCompatible({}, { protocolVersion: 2, healthy: true,
    workflowScriptSpawn: false, singleAgentSpawn: true, durableOperationLookup: true,
    processTerminalProofVersion: 1, executionLifetimeVersion: 1, executionLifetimeModes: ["unbounded"],
    processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" },
  }), true);
  assert.equal(
    bridgeRuntimeCompatible(
      {
        methods: ["ping", "spawn"],
        capabilities: { workflowScriptSpawn: true },
      },
      v1,
    ),
    false,
  );
  assert.equal(
    hasBridgeOperationMethod({ methods: ["ping", "operation"] }),
    true,
  );
  assert.equal(hasBridgeOperationMethod({ methods: ["ping", "spawn"] }), false);
  assert.equal(hasBridgeOperationMethod({ methods: "operation" }), false);
  assert.equal(hasBridgeOperationMethod(undefined), false);

  assert.equal(
    hasBridgeWorkflowScriptSpawnCapability({
      capabilities: { workflowScriptSpawn: true },
    }),
    true,
  );
  assert.equal(
    hasBridgeWorkflowScriptSpawnCapability({
      capabilities: { workflowScriptSpawn: false },
    }),
    false,
  );
  assert.equal(hasBridgeWorkflowScriptSpawnCapability(undefined), false);
});

test("exec command completions explain the command family", () => {
  const items = getExecArgumentCompletions("st");
  assert.deepEqual(
    items?.map((item) => item.value),
    ["status", "stop"],
  );
  assert.match(items?.[0]?.description ?? "", /every run and what it needs/);
  const allItems = getExecArgumentCompletions("") ?? [];
  assert.match(
    allItems.find((item) => item.value === "resume")?.description ?? "",
    /Continue the current run safely/,
  );
  assert.match(
    allItems.find((item) => item.value === "skip")?.description ?? "",
    /Force-skip/,
  );
});

test("runtime prerequisite check identifies missing provider extensions", () => {
  assert.deepEqual(missingRuntimeTools(["TaskCreate"]), ["pi-subagents"]);
  assert.deepEqual(missingRuntimeTools(["subagent", "TaskCreate"]), []);
  assert.deepEqual(missingRuntimeTools(["subagent"]), []);
  assert.equal(runtimeIntegrationProblem(true), undefined);
  assert.match(
    runtimeIntegrationProblem(false) ?? "",
    /external-runs\/background-work APIs unavailable/,
  );
});

test("reload repairs terminal projections owned by the current session", () => {
  const terminal = retiredRun({
    taskProjection: {
      version: 1,
      state: "ready",
      owner: "pi-plan-exec",
      sessionId: "session-1",
      scope: "session",
      revision: 1,
      taskIds: {},
    },
  });

  assert.equal(
    shouldRepairProjectionForSession(terminal, "session-1"),
    true,
  );
  assert.equal(
    shouldRepairProjectionForSession(terminal, "foreign-session"),
    false,
  );
});

test("start paths preserve spaces and accept quoted explicit worktree paths", () => {
  for (const input of ["docs/plans/my  plan.md", '"docs/plans/my  plan.md"', "'docs/plans/my  plan.md'"])
    assert.deepEqual(parseStartArguments(input), { planPath: "docs/plans/my  plan.md" });
  for (const input of ['--worktree "../feature tree" docs/plans/my  plan.md', "--worktree='../feature tree' 'docs/plans/my  plan.md'"])
    assert.deepEqual(parseStartArguments(input), { worktreePath: "../feature tree", planPath: "docs/plans/my  plan.md" });
  assert.deepEqual(parseStartArguments(""), {});
  for (const input of ["--worktree", "--worktree=", '--worktree "" plan.md', "--worktree --unknown plan.md", '--worktree "broken plan.md', "--worktree target --worktree other plan.md", "--unknown plan.md", '"unterminated', '--worktree target ""'])
    assert.throws(() => parseStartArguments(input), /Usage:|matching quotes/, input);
});

test("start arguments accept an explicit existing worktree", () => {
  assert.deepEqual(
    parseStartArguments(
      "--worktree /repo.worktrees/feature docs/plans/example.md",
    ),
    {
      worktreePath: "/repo.worktrees/feature",
      planPath: "docs/plans/example.md",
    },
  );
  assert.deepEqual(
    parseStartArguments(
      "--worktree=/repo.worktrees/feature /tmp/plan.md",
    ),
    {
      worktreePath: "/repo.worktrees/feature",
      planPath: "/tmp/plan.md",
    },
  );
  assert.throws(
    () => parseStartArguments("--worktree /repo.worktrees/feature"),
    /Usage: \/exec --worktree/,
  );
});

test("help and setup explain the installed command surface", () => {
  assert.match(execHelp(), /\/exec status \[run-id\]/);
  assert.match(execHelp(), /Continue a stuck run/);
  assert.match(execHelp(), /\/exec skip <full-run-id> --reason <text>/);
  assert.match(execHelp(), /--model current\|provider\/model/);
  assert.match(execHelp(), /completed_with_findings/);
  assert.match(execHelp(), /\/exec cleanup \[full-run-id\]/);
  assert.match(execHelp(), /registry entries only/);
  assert.match(execHelp(), /\/skill:exec-plan/);
  for (const alias of EXEC_ALIAS_ACTIONS)
    assert.doesNotMatch(execHelp(), new RegExp(`/exec ${alias}`), alias);
  assert.match(
    execSetup(),
    /pi install -l git:github\.com\/alexei-led\/pi-subagents-bridge@[a-f0-9]{40}$/m,
  );
  assert.match(execSetup(), /pi install -l git:github\.com\/alexei-led\/pi-fusion@[a-f0-9]{40}$/m);
  assert.match(execSetup(), /Keep this plan-exec source build installed/);
});

test("setup installs exact project-local source pins rather than obsolete published runtime APIs", () => {
  assert.doesNotMatch(execSetup(), /npm:[^\s]+@(?:\^|>=|<=|=|~)/);
  assert.match(execSetup(), /^pi install -l git:github\.com\/alexei-led\/pi-subagents-codex-fix@[a-f0-9]{40}$/m);
  assert.match(execSetup(), /^pi install -l git:github\.com\/alexei-led\/pi-subagents-bridge@[a-f0-9]{40}$/m);
  assert.doesNotMatch(execSetup(), /^pi install npm:(?:pi-subagents|@alexeiled\/pi-plan-exec)$/m);
  assert.match(execSetup(), /Optional task visibility \(not required for execution\)/);
});

test("cancel cannot bypass a pending force-skip", () => {
  const pending = run({
    status: "skip_pending",
    stage: "comprehensive_review",
    config: { ...config, reviewRequired: false },
    pendingStageSkip: {
      stage: "comprehensive_review",
      reason: "operator waiver",
      requestedAt: 1,
      requestedBy: "session-1",
    },
  });

  assert.equal(isActionAllowed("cancel", pending), false);
  assert.equal(isActionAllowed("skip", pending), true);
  // Resume is what applies the waiver; nothing holds this run, so it is open.
  assert.equal(isActionAllowed("resume", pending), true);
});

test("resume accepts options without an explicit run ID", () => {
  assert.deepEqual(parseResumeArguments(["--retry-task"]), {
    selector: undefined,
    adoptCurrentBranch: false,
    retryTask: true,
    sameMachine: false,
    model: undefined,
  });
  assert.deepEqual(
    parseResumeArguments([
      "run-id",
      "--adopt-current-branch",
      "--retry-task",
      "--same-machine",
      "--model",
      "current",
    ]),
    {
      selector: "run-id",
      adoptCurrentBranch: true,
      retryTask: true,
      sameMachine: true,
      model: "current",
    },
  );
});

test("resume branch-adoption and recovery-model options are explicit", () => {
  assert.deepEqual(parseResumeOptions([]), {
    adoptCurrentBranch: false,
    retryTask: false,
    sameMachine: false,
    model: undefined,
  });
  assert.deepEqual(parseResumeOptions(["--adopt-current-branch"]), {
    adoptCurrentBranch: true,
    retryTask: false,
    sameMachine: false,
    model: undefined,
  });
  assert.deepEqual(parseResumeOptions(["--retry-task"]), {
    adoptCurrentBranch: false,
    retryTask: true,
    sameMachine: false,
    model: undefined,
  });
  assert.deepEqual(
    parseResumeOptions([
      "--adopt-current-branch",
      "--retry-task",
      "--model",
      "anthropic-work/claude-sonnet-4-6",
    ]),
    {
      adoptCurrentBranch: true,
      retryTask: true,
      sameMachine: false,
      model: "anthropic-work/claude-sonnet-4-6",
    },
  );
  assert.throws(() => parseResumeOptions(["--model"]), /Usage/);
  assert.throws(() => parseResumeOptions(["--force"]), /Usage/);

  const running = run({ status: "running" });
  delete running.activeOperation;
  assert.equal(isActionAllowed("resume", running), true);
  assert.equal(isActionAllowed("resume", running, true), true);
  const failed = run({ status: "failed" });
  delete failed.activeOperation;
  assert.equal(isActionAllowed("resume", failed, true), true);
  const busy = run({
    status: "running",
    activeOperation: {
      operationId: "live-review",
      service: "bridge",
      kind: "review",
      externalRunId: "live-run",
    },
  });
  assert.equal(isActionAllowed("resume", busy, true), false);
});

test("force-skip reason parsing requires the explicit option and text", () => {
  assert.equal(
    parseSkipReason(["--reason", "review", "loop", "is", "stuck"]),
    "review loop is stuck",
  );
  assert.throws(() => parseSkipReason([]), /Usage/);
  assert.throws(() => parseSkipReason(["--reason"]), /Usage/);
  assert.throws(() => parseSkipReason(["because"]), /Usage/);
});

test("failed and cancellation-pending runs are eligible for recovery", () => {
  assert.equal(
    isRecoverableFailure(
      run({
        status: "failed",
        error: "Plan task structure changed outside checkbox completion.",
      }),
    ),
    true,
  );
  assert.equal(
    needsPlanStructureReview(
      run({
        status: "paused",
        error: "Plan task structure changed outside checkbox completion.",
      }),
    ),
    true,
  );
  const exhaustedWorker = run({
    status: "failed",
    error: "Worker run-2 ended as failed and left task 1 checkboxes unchecked.",
  });
  delete exhaustedWorker.activeOperation;
  assert.equal(isRecoverableFailure(exhaustedWorker), true);
  const crashedWorker = run({
    status: "failed",
    error: "worker crashed",
  });
  delete crashedWorker.activeOperation;
  assert.equal(isRecoverableFailure(crashedWorker), true);
  assert.equal(
    isRecoverableFailure(
      run({
        status: "failed",
        error: "worker crashed",
        activeOperation: {
          operationId: "still-running",
          service: "bridge",
          kind: "review",
        },
      }),
    ),
    true,
  );
  assert.equal(isRecoverableFailure(run({ status: "cancel_pending" })), true);
});

test("run status classifies recovery and gives one safe next action", () => {
  const active = formatRunStatus(
    run({
      status: "running",
      activeOperation: {
        operationId: "active-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
      },
    }),
  );
  assert.match(
    active,
    /recovery: running, but nothing proves the worker is alive/,
  );
  assert.match(active, /next safe action: Nothing reports what this worker/);
  assert.match(active, /Do not resume/);
  assert.doesNotMatch(active, /reported activity/);

  const observed = (
    lastObservedAt: number,
    evidence?: AbandonmentEvidence,
  ): string =>
    formatRunStatus(
      run({
        status: "running",
        activeOperation: {
          operationId: "active-operation",
          service: "bridge",
          kind: "implementation",
          taskId: 1,
          externalRunId: "worker-run-1",
          lastObservedAt,
          workerSignal: { mode: "chain", activity: "active 12s ago" },
        },
      }),
      evidence,
    );

  assert.match(
    observed(Date.now(), { leaseLive: true }),
    /recovery: running, and the worker reported activity/,
  );

  // The same value, last refreshed an hour ago: a memory, not health.
  const frozen = observed(Date.now() - HOUR_MS, { leaseLive: true });
  assert.match(
    frozen,
    /recovery: running, but nothing proves the worker is alive/,
  );
  assert.doesNotMatch(frozen, /reported activity/);

  // Fresh value, dead lease: whoever wrote it stopped, so it froze just now.
  const unwatched = observed(Date.now(), { leaseLive: false });
  assert.doesNotMatch(unwatched, /reported activity/);
  assert.doesNotMatch(unwatched, /controller is/);

  const failedRun = run({
    status: "failed",
    error: "worker crashed before launch",
  });
  delete failedRun.activeOperation;
  const failed = formatRunStatus(failedRun);
  assert.match(failed, /recovery: stopped, and you can continue it/);
  assert.match(failed, /resume .* retries the same stage/);

  const blockedRun = run({
    status: "failed",
    taskAttempts: { "1": 2 },
    error: "Task 1 exhausted its retry limit. Provider billing unavailable.",
  });
  delete blockedRun.activeOperation;
  const blocked = formatRunStatus(blockedRun);
  assert.match(
    blocked,
    /recovery: a task is blocked by something outside this run/,
  );
  // The flag left the guidance with the help text; interactive resume asks.
  assert.match(blocked, /interactive \/exec resume .*asks before retrying/);
  assert.doesNotMatch(blocked, /--retry-task/);
  assert.match(blocked, /Implementation work cannot be waived/);

  const modelFailureRun = run({
    status: "failed",
    error:
      "Worker failed because the model/provider is unusable: Invalid call_id: maximum length 64.",
    failedOperation: {
      operationId: "failed-model-operation",
      service: "bridge",
      kind: "implementation",
      externalRunId: "failed-model-run",
      taskId: 1,
      terminalError:
        "Codex error: [string_above_max_length] Invalid call_id: maximum length 64.",
    },
  });
  delete modelFailureRun.activeOperation;
  const modelFailure = formatRunStatus(modelFailureRun);
  assert.match(
    modelFailure,
    /recovery: stopped because the model or provider could not be used/,
  );
  assert.match(
    modelFailure,
    /Run \/exec resume .*model this Pi session is signed in to/,
  );
  assert.match(modelFailure, /failed-model-run/);
  assert.match(modelFailure, /string_above_max_length/);

  const unnamedWorker = (status: PlanExecRun["status"]): PlanExecRun =>
    run({
      status,
      error: "Bridge operation lookup is unresolved",
      activeOperation: {
        operationId: "unknown-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
      },
    });

  const unknown = formatRunStatus(unnamedWorker("running"), {
    leaseLive: true,
  });
  assert.match(unknown, /recovery: cannot check on the worker right now/);
  assert.match(unknown, /the tool never learned its name/);
  assert.match(unknown, /\/exec status .* to look again later/);

  // The same operation on a settled run: its record already says the
  // controller stopped, and resume looks the operation up rather than
  // launching a second worker.
  const unknownSettled = formatRunStatus(unnamedWorker("failed"));
  assert.match(unknownSettled, /recovery: stopped, and you can continue it/);
  assert.match(unknownSettled, /\/exec resume /);
  assert.doesNotMatch(unknownSettled, /cannot check on the worker/);

  const pausedRun = run({ status: "paused", stage: "comprehensive_review" });
  delete pausedRun.activeOperation;
  const paused = formatRunStatus(pausedRun);
  assert.match(paused, /recovery: paused, waiting for you to continue it/);
  assert.match(paused, /resume .* applies the paused stage/);

  const pausedWorkflowRun = run({
    status: "running",
    stage: "stats",
    activeOperation: {
      operationId: "paused-workflow-operation",
      service: "bridge",
      kind: "stats",
      externalRunId: "paused-workflow-run",
      lastObservedState: "paused",
      terminalError: "Run 'main' detached for intercom coordination.",
    },
  });
  const pausedWorkflow = formatRunStatus(pausedWorkflowRun, {
    leaseLive: true,
  });
  assert.match(
    pausedWorkflow,
    /recovery: workflow paused for supervisor input/,
  );
  assert.match(pausedWorkflow, /Reply to the displayed supervisor request/);
  assert.match(pausedWorkflow, /continues automatically/);
  assert.match(pausedWorkflow, /do not resume or start another run/);

  const detachedWorkflowRun = run({
    status: "failed",
    stage: "stats",
    error: "stats operation ended as paused.",
    failedOperation: {
      operationId: "detached-workflow-operation",
      service: "bridge",
      kind: "stats",
      externalRunId: "detached-workflow-run",
      terminalError: "Run 'main' detached for intercom coordination.",
    },
  });
  delete detachedWorkflowRun.activeOperation;
  const detachedWorkflow = formatRunStatus(detachedWorkflowRun);
  assert.match(
    detachedWorkflow,
    /recovery: workflow detached during supervisor coordination/,
  );
  assert.match(detachedWorkflow, /consumes a durably completed child/);
  assert.match(detachedWorkflow, /does not launch a replacement/);

  const cancellingRun = run({ status: "cancel_pending" });
  delete cancellingRun.activeOperation;
  const cancelling = formatRunStatus(cancellingRun, { leaseLive: true });
  assert.match(cancelling, /recovery: waiting for the stop you asked for/);
  assert.match(cancelling, /resume .* retries only the stop/);

  // Nothing is driving the stop, so re-reading the record would never end.
  const abandonedStop = formatRunStatus(cancellingRun, { leaseLive: false });
  assert.match(abandonedStop, /the stop cannot land by itself/);
  assert.match(abandonedStop, /Run \/exec stop /);

  const staleOwnerRun = run({
    status: "failed",
    lease: { sessionId: "old-session", pid: 1, heartbeatAt: 0 },
  });
  delete staleOwnerRun.activeOperation;
  const staleOwner = formatRunStatus(staleOwnerRun);
  assert.match(staleOwner, /owner: stale lease/);
  assert.match(staleOwner, /\/exec resume/);
  assert.doesNotMatch(staleOwner, /\/exec adopt/);
  assert.equal(isActionAllowed("resume", staleOwnerRun), true);

  const branchMismatch = formatRunStatus(
    run({
      status: "failed",
      error: "Execution directory is on feature/current, expected master.",
    }),
  );
  assert.match(
    branchMismatch,
    /recovery: this run belongs to a branch you are not on/,
  );
  // The flag left the guidance with the help text; interactive resume asks.
  assert.match(branchMismatch, /interactive \/exec resume .*asks before/);
  assert.doesNotMatch(branchMismatch, /--adopt-current-branch/);

  const planMismatch = formatRunStatus(
    run({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(
    planMismatch,
    /recovery: the plan file changed shape since this run started/,
  );
  assert.match(planMismatch, /first resume only records this pause/);

  const terminal = formatRunStatus(
    run({ status: "completed", stage: "complete" }),
  );
  assert.match(terminal, /recovery: finished/);
  assert.match(terminal, /nothing to recover/);
  assert.match(terminal, /\/exec cleanup/);
});

test("an overdue operation is classified without being called dead", () => {
  const MINUTE_MS = 60_000;
  const BOUNDED_CONFIG = {
    ...config,
    executionLifetime: { mode: "bounded" as const, timeoutMs: 100 * MINUTE_MS },
  };
  const active = (
    agoMinutes: number | undefined,
    overrides: Partial<PlanExecRun["activeOperation"]> = {},
    runOverrides: Partial<PlanExecRun> = {},
  ): PlanExecRun =>
    run({
      status: "running",
      activeOperation: {
        operationId: "active-operation",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
        ...(agoMinutes === undefined
          ? {}
          : { launchStartedAt: Date.now() - agoMinutes * MINUTE_MS }),
        expectedLifetime: (runOverrides.config ?? BOUNDED_CONFIG).executionLifetime,
        ...overrides,
      },
      config: BOUNDED_CONFIG,
      ...runOverrides,
    });

  // A trustworthy activity value needs a live lease behind it, so the cases
  // that turn on one carry that evidence.
  const LIVE: AbandonmentEvidence = { leaseLive: true };
  const cases: [string, PlanExecRun, string, AbandonmentEvidence?][] = [
    [
      "nine minutes, no signal",
      active(9),
      "running, but nothing proves the worker is alive",
    ],
    [
      "nine minutes, workflow-mode signal with no activity",
      active(9, { workerSignal: { mode: "workflow" } }),
      "running, but nothing proves the worker is alive",
    ],
    [
      "inside the worker bound, no signal",
      active(99),
      "running, but nothing proves the worker is alive",
    ],
    [
      "past the worker bound, no signal",
      active(101),
      "running longer than its budget allows",
    ],
    [
      "past the reviewer bound but inside the worker bound",
      active(65),
      "running, but nothing proves the worker is alive",
    ],
    [
      "past the reviewer bound on a review operation",
      active(65, { kind: "review" }),
      "running, but nothing proves the worker is alive",
    ],
    [
      "past the stats bound on a stats operation",
      active(45, { kind: "stats" }, { stage: "stats" }),
      "running, but nothing proves the worker is alive",
    ],
    [
      "inside the worker bound on a stats-sized elapsed time",
      active(45, { kind: "fusion" }, { stage: "fusion_review" }),
      "running, but nothing proves the worker is alive",
    ],
    [
      "finalize borrows the worker budget",
      active(101, { kind: "finalize" }, { stage: "finalize" }),
      "running longer than its budget allows",
    ],
    [
      "past the bound with a trustworthy activity value",
      active(180, {
        lastObservedAt: Date.now(),
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      }),
      "running, and the worker reported activity",
      LIVE,
    ],
    [
      "past the bound with an activity value nothing has refreshed",
      active(180, {
        lastObservedAt: Date.now() - 10 * MINUTE_MS,
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      }),
      "running longer than its budget allows",
      LIVE,
    ],
    [
      "past the bound with a fresh activity value and a dead lease",
      active(180, {
        lastObservedAt: Date.now(),
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      }),
      "running longer than its budget allows",
    ],
    [
      "past the bound while observation is unavailable",
      active(180, { statusFailures: 1 }),
      "cannot check on the worker right now",
    ],
    [
      "past the bound while still starting",
      active(180, {}, { status: "starting" }),
      "running longer than its budget allows",
    ],
    [
      "no launch time recorded",
      active(undefined),
      "running, but nothing proves the worker is alive",
    ],
    // The bound only speaks while the run still claims work in flight.
    [
      "past the bound on a failed run",
      active(180, {}, { status: "failed", error: "worker crashed" }),
      "stopped, and you can continue it",
    ],
  ];
  for (const [name, candidate, classification, evidence] of cases)
    assert.equal(
      recoveryGuidance(candidate, evidence).classification,
      classification,
      name,
    );

  const unbounded = active(180, {}, { config });
  assert.equal(
    recoveryGuidance(unbounded).classification,
    "running, but nothing proves the worker is alive",
    "unbounded silence has no synthetic deadline verdict",
  );
  assert.equal(longRunningOperation(unbounded), undefined);

  // Only `longRunningOperation` can be asked about the exact bound:
  // `recoveryGuidance` reads its own clock, so a run built to sit on the bound
  // is already past it by the time it runs.
  const launchStartedAt = Date.parse("2026-08-09T12:00:00Z");
  const onTheBound = active(undefined, { launchStartedAt });
  assert.equal(
    longRunningOperation(onTheBound, launchStartedAt + 100 * MINUTE_MS),
    undefined,
    "exactly on the worker bound is not past it",
  );
  assert.ok(
    longRunningOperation(onTheBound, launchStartedAt + 100 * MINUTE_MS + 1),
    "one millisecond past it is",
  );

  // Decisive death outranks a bound breach.
  const gone = terminalEvidence("worker-run-1");
  assert.equal(
    recoveryGuidance(active(180), gone).classification,
    "the worker is gone, so nothing is running",
  );
  assert.equal(
    recoveryGuidance(active(9), gone).classification,
    "the worker is gone, so nothing is running",
  );
  assert.equal(
    recoveryGuidance(active(180), { leaseLive: false, asyncDirPresent: true })
      .classification,
    "running longer than its budget allows",
    "a directory still on disk proves nothing about death",
  );

  const overdue = formatRunStatus(active(180), LIVE);
  assert.match(overdue, /recovery: running longer than its budget allows/);
  assert.match(overdue, /past the explicit 100m compatibility deadline/);
  assert.match(overdue, /not proof the worker is stuck/);
  assert.match(overdue, /controller is still polling it/);
  assert.match(overdue, /\/exec status .* to look again later/);
  assert.match(overdue, /Do not resume or start another run/);
  assert.doesNotMatch(overdue, /\b(?:healthy|dead|stalled)\b/);

  // The same breach with nothing polling: waiting is not on offer.
  const unwatched = formatRunStatus(active(180), { leaseLive: false });
  assert.match(unwatched, /waiting alone never settles it/);
  assert.match(unwatched, /\/exec stop .* preserve the worktree/);
  assert.doesNotMatch(unwatched, /controller is still polling/);
});

test("no recovery classification names a controller internal", async () => {
  // Scraped from source, not from a shape table, so a branch added later cannot
  // reintroduce the vocabulary. Every quote style, or such a branch could evade
  // the guard with a template literal.
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const classifications = [
    ...source.matchAll(/classification:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  assert.ok(
    classifications.length >= 15,
    `expected the classification literals to be found, got ${classifications.length}`,
  );
  for (const classification of classifications)
    assert.doesNotMatch(
      classification,
      /preserved|reconciliation|operation identity/i,
      `classification names a controller internal: ${classification}`,
    );
});

test("every recovery classification ends at a primary verb", () => {
  const withoutOperation = (overrides: Partial<PlanExecRun>): PlanExecRun => {
    const shape = run(overrides);
    delete shape.activeOperation;
    return shape;
  };
  const launched = (
    overrides: Partial<NonNullable<PlanExecRun["activeOperation"]>> = {},
  ): NonNullable<PlanExecRun["activeOperation"]> => ({
    operationId: "operation-1",
    service: "bridge",
    kind: "implementation",
    taskId: 1,
    externalRunId: "worker-run-1",
    launchStartedAt: Date.now() - 180 * 60_000,
    ...overrides,
  });
  const unnamedOperation = run({
    status: "failed",
    error: "Bridge operation lookup is unresolved",
    activeOperation: { operationId: "op", service: "bridge", kind: "review" },
  });
  const unnamedInFlight = run({
    activeOperation: { operationId: "op", service: "bridge", kind: "review" },
  });
  const unobservable = run({
    activeOperation: launched({ statusFailures: 1 }),
  });
  const trackedFailure = run({
    status: "failed",
    error: "worker crashed",
    activeOperation: launched(),
  });
  const untrackedFailure = withoutOperation({
    status: "failed",
    error: "worker crashed",
  });
  const shapes: PlanExecRun[] = [
    retiredRun(),
    withoutOperation({ lease: DEAD_LEASE }),
    withoutOperation({
      status: "failed",
      error: "Execution directory is on feature/current, expected master.",
    }),
    withoutOperation({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
    run({ status: "skip_pending" }),
    run({ status: "cancel_pending" }),
    unnamedOperation,
    unnamedInFlight,
    unobservable,
    run({ activeOperation: launched() }),
    run({ activeOperation: launched({ launchStartedAt: Date.now() }) }),
    run({
      activeOperation: launched({
        lastObservedAt: Date.now(),
        workerSignal: { mode: "chain", activity: "active 12s ago" },
      }),
    }),
    withoutOperation({ status: "running" }),
    withoutOperation({ status: "paused", stage: "comprehensive_review" }),
    withoutOperation({
      status: "failed",
      error: "Worker failed: invalid api key.",
    }),
    withoutOperation({
      status: "failed",
      taskAttempts: { "1": 2 },
      error: "Task 1 exhausted its retry limit. Provider billing unavailable.",
    }),
    trackedFailure,
    untrackedFailure,
  ];

  // The gone branch needs live evidence, so it carries its own entry.
  const observed: Array<[PlanExecRun, AbandonmentEvidence | undefined]> = [
    ...shapes.map((shape) => [shape, undefined] as [PlanExecRun, undefined]),
    [
      run({ activeOperation: launched() }),
      terminalEvidence("worker-run-1"),
    ],
  ];

  for (const [shape, evidence] of observed) {
    const { classification, action } = recoveryGuidance(shape, evidence);
    assert.match(
      action,
      /\/exec (status|resume|stop|cleanup|skip)\b/,
      `no primary verb: ${classification}`,
    );
    assert.doesNotMatch(
      action,
      /\/exec (start|runs|doctor|setup|adopt|pause|cancel)\b/,
      `names a retired alias: ${classification}`,
    );
  }

  // Unobservable is a claim about a worker in flight. A settled run makes no
  // such claim, so an unnamed operation on one reads as the failure it is.
  assert.equal(
    recoveryGuidance(unnamedInFlight).classification,
    recoveryGuidance(unobservable).classification,
  );
  assert.equal(
    recoveryGuidance(unnamedOperation).classification,
    recoveryGuidance(untrackedFailure).classification,
  );
  assert.equal(
    recoveryGuidance(trackedFailure).classification,
    recoveryGuidance(untrackedFailure).classification,
  );
});

test("status guidance judges lease staleness the way claiming does", () => {
  const { pid } = spawnSync("true");
  assert.ok(pid, "spawnSync must report a child pid");
  const deadLocalOwner = run({
    lease: {
      sessionId: "old-session",
      pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });
  assert.match(formatRunStatus(deadLocalOwner), /owner: stale lease/);

  const liveLocalOwner = run({
    lease: {
      sessionId: "old-session",
      pid: process.pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });
  assert.doesNotMatch(formatRunStatus(liveLocalOwner), /owner: stale lease/);

  // No hostname is the on-disk shape of every existing run: heartbeat only.
  const legacyOwner = run({
    lease: { sessionId: "old-session", pid, heartbeatAt: Date.now() },
  });
  assert.doesNotMatch(formatRunStatus(legacyOwner), /owner: stale lease/);
});

test("resume output explains a required second plan-structure review", () => {
  const paused = run({
    status: "paused",
    error: "Plan task structure changed outside checkbox completion.",
  });
  delete paused.activeOperation;
  const message = resumeResultMessage(paused);
  assert.match(message, /first resume only recorded the pause/);
  assert.match(message, /run interactive \/exec resume/);

  const resumed = resumeResultMessage(run({ status: "running" }));
  assert.match(
    resumed,
    /already running; its tracked worker is being reconciled/,
  );

  const reconciling = resumeResultMessage(
    run({
      status: "running",
      activeOperation: {
        operationId: "live-worker",
        service: "bridge",
        kind: "implementation",
      },
    }),
  );
  assert.match(
    reconciling,
    /already running; its tracked worker is being reconciled/,
  );
  assert.doesNotMatch(resumed, /second resume/);
});

test("run status includes live operation, progress, and recovery hints", () => {
  const status = formatRunStatus(
    run({
      status: "failed",
      error: "Plan structure changed",
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        externalRunId: "worker-run-1",
      },
    }),
  );
  assert.match(status, /status: failed/);
  assert.match(status, /operation: bridge\/implementation \(Task 1\)/);
  assert.match(status, /operation ID: operation-1/);
  assert.match(status, /external run ID: worker-run-1/);
  assert.match(status, /progress: \/repo\/\.ralphex\/progress\.txt/);
  assert.match(status, /error: Plan structure changed/);
  assert.match(status, /worktree that was kept/);

  const recoverable = formatRunStatus(
    run({
      status: "failed",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(recoverable, /interactive \/exec resume/);

  const failedWorker = run({
    status: "failed",
    error: "Worker run-2 ended as failed and left task 1 checkboxes unchecked.",
  });
  delete failedWorker.activeOperation;
  assert.match(formatRunStatus(failedWorker), /retries the same stage/);

  const paused = formatRunStatus(
    run({
      status: "paused",
      error: "Plan task structure changed outside checkbox completion.",
    }),
  );
  assert.match(paused, /interactive \/exec resume/);
  assert.doesNotMatch(paused, /next: \/exec status/);

  const skippedRun = run({
    status: "completed_with_findings",
    stage: "complete",
    skippedStages: [
      {
        stage: "comprehensive_review",
        reason: "operator waiver",
        requestedAt: 1,
        requestedBy: "session-1",
        completedAt: 2,
        terminalOperationState: "stopped",
      },
    ],
  });
  delete skippedRun.activeOperation;
  const skipped = formatRunStatus(skippedRun);
  assert.match(skipped, /force-skipped stages/);
  assert.match(skipped, /operator waiver/);
});

test("run status distinguishes unavailable observation from normal polling", () => {
  const status = formatRunStatus(
    run({
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        statusFailures: 2,
        lastStatusError: "bridge unavailable",
      },
    }),
  );
  assert.match(status, /observation: unavailable \(2 failed probes\)/);
  assert.match(status, /bridge unavailable/);
});

test("resume keeps exact-worktree priority over a live isolated run", () => {
  const recoverableInPlace = run({
    id: "11111111-1111-4111-8111-111111111111",
    status: "failed",
    error: "Plan task structure changed outside checkbox completion.",
    worktreeCwd: "/repo",
  });
  const pausedIsolated = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "paused",
    worktreeCwd: "/tmp/execution-worktree",
  });

  assert.deepEqual(
    prioritizeRunCandidates([recoverableInPlace, pausedIsolated], "/repo").map(
      (candidate) => candidate.id,
    ),
    [recoverableInPlace.id],
  );
});

test("plan-structure recovery requires interactive adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-index-"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Changed\n- [ ] New text\n");
  const recoverable = run({
    planPath,
    status: "failed",
    error: "Plan task structure changed outside checkbox completion.",
  });

  await assert.rejects(
    reviewedPlanHashForResume(recoverable, {
      hasUI: false,
      ui: { confirm: async () => false },
    }),
    /interactive Pi/,
  );

  let confirmed = false;
  const adoptedHash = await reviewedPlanHashForResume(recoverable, {
    hasUI: true,
    ui: {
      confirm: async () => {
        confirmed = true;
        return true;
      },
    },
  });
  assert.equal(confirmed, true);
  assert.notEqual(adoptedHash, recoverable.planHash);
  assert.equal(
    await reviewedPlanHashForResume(run({ status: "failed" }), {
      hasUI: false,
      ui: { confirm: async () => false },
    }),
    undefined,
  );
});

test("removable runs are terminal, past retention, and unheld", () => {
  const liveLease = {
    sessionId: "session-1",
    pid: process.pid,
    heartbeatAt: Date.now(),
    hostname: hostname(),
  };
  const staleLease = {
    sessionId: "session-1",
    pid: reapedPid(),
    heartbeatAt: 0,
    hostname: hostname(),
  };
  const cases: Array<{
    name: string;
    run: PlanExecRun;
    includeFailed?: boolean;
    removable: boolean;
  }> = [
    {
      name: "a retired completed run is removable",
      run: retiredRun(),
      removable: true,
    },
    {
      name: "completed_with_findings is removable",
      run: retiredRun({ status: "completed_with_findings" }),
      removable: true,
    },
    {
      name: "cancelled is removable",
      run: retiredRun({ status: "cancelled" }),
      removable: true,
    },
    {
      name: "failed is excluded by default so resume stays available",
      run: retiredRun({ status: "failed", stage: "implementation" }),
      removable: false,
    },
    {
      name: "failed is removable with --include-failed",
      run: retiredRun({ status: "failed", stage: "implementation" }),
      includeFailed: true,
      removable: true,
    },
    {
      name: "inside the retention window nothing is removable",
      run: retiredRun({ updatedAt: INSIDE_RETENTION }),
      removable: false,
    },
    {
      name: "a running run is never removable",
      run: run({ updatedAt: PAST_RETENTION }),
      includeFailed: true,
      removable: false,
    },
    {
      name: "cancel_pending is not terminal",
      run: retiredRun({ status: "cancel_pending" }),
      includeFailed: true,
      removable: false,
    },
    {
      name: "a live lease holds a retired run",
      run: retiredRun({ lease: liveLease }),
      removable: false,
    },
    {
      name: "a stale lease does not hold it",
      run: retiredRun({ lease: staleLease }),
      removable: true,
    },
  ];

  for (const testCase of cases)
    assert.equal(
      isRemovableRun(testCase.run, testCase.includeFailed),
      testCase.removable,
      testCase.name,
    );
});

test("cleanup arguments accept one run ID and the two flags", () => {
  assert.deepEqual(parseCleanupArguments([]), {
    runId: undefined,
    apply: false,
    includeFailed: false,
  });
  assert.deepEqual(
    parseCleanupArguments(["run-id", "--apply", "--include-failed"]),
    { runId: "run-id", apply: true, includeFailed: true },
  );
  assert.throws(() => parseCleanupArguments(["--force"]), /Usage/);
  assert.throws(() => parseCleanupArguments(["one", "two"]), /Usage/);
});

test("cleanup previews without deleting and names both escapes", async () => {
  const removable = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const recent = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: INSIDE_RETENTION,
  });
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
  });
  const registry = await seedRegistry([removable, recent, failed]);

  const preview = await execCleanup(registry, []);

  assert.match(preview, /nothing was deleted/);
  assert.match(preview, new RegExp(removable.id));
  assert.doesNotMatch(preview, new RegExp(recent.id));
  assert.doesNotMatch(preview, new RegExp(failed.id));
  assert.match(
    preview,
    /worktree, branch, and progress file are left in place/,
  );
  assert.match(preview, /--include-failed/);
  assert.match(preview, /\/exec cleanup --apply/);
  assert.equal((await registry.list()).length, 3);
});

test("cleanup --apply removes only retired runs past retention", async () => {
  const removable = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const recent = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: INSIDE_RETENTION,
  });
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
  });
  const registry = await seedRegistry([removable, recent, failed]);

  const applied = await execCleanup(registry, ["--apply"]);

  assert.match(applied, /Removed 1 plan execution run;/);
  assert.match(applied, /left in place/);
  assert.deepEqual(
    (await registry.list()).map((entry) => entry.id).sort(),
    [recent.id, failed.id].sort(),
  );
});

test("cleanup includes failed runs only when asked", async () => {
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
  });
  const registry = await seedRegistry([failed]);

  const excluded = await execCleanup(registry, []);
  assert.match(excluded, /No plan execution runs are removable/);
  assert.match(excluded, /7 days/);

  const included = await execCleanup(registry, ["--include-failed"]);
  assert.match(included, new RegExp(failed.id));
  assert.doesNotMatch(included, /Failed runs are excluded/);

  await execCleanup(registry, ["--apply", "--include-failed"]);
  assert.deepEqual(await registry.list(), []);
});

test("cleanup with a run ID removes just that run and refuses live ones", async () => {
  const recent = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: INSIDE_RETENTION,
  });
  const removable = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
  });
  const active = run({
    id: "66666666-6666-4666-8666-666666666666",
    updatedAt: PAST_RETENTION,
  });
  const held = retiredRun({
    id: "77777777-7777-4777-8777-777777777777",
    lease: {
      sessionId: "session-1",
      pid: process.pid,
      heartbeatAt: Date.now(),
      hostname: hostname(),
    },
  });
  const registry = await seedRegistry([recent, removable, active, held]);

  const applied = await execCleanup(registry, [recent.id, "--apply"]);

  assert.match(applied, /Removed 1 plan execution run;/);
  assert.equal(await registry.get(recent.id), undefined);
  assert.ok(await registry.get(removable.id), "the sweep set is untouched");
  await assert.rejects(
    () => execCleanup(registry, [active.id, "--apply"]),
    /only a terminal run can be removed/,
  );
  await assert.rejects(
    () => execCleanup(registry, [held.id, "--apply"]),
    /held by a live lease/,
  );
  await assert.rejects(
    () => execCleanup(registry, ["88888888-8888-4888-8888-888888888888"]),
    /Plan execution run not found/,
  );
});

test("doctor argument parsing accepts only --reconcile", () => {
  assert.deepEqual(parseDoctorArguments([]), { reconcile: false });
  assert.deepEqual(parseDoctorArguments(["--reconcile"]), { reconcile: true });
  assert.throws(() => parseDoctorArguments(["--apply"]), /Usage/);
  assert.throws(() => parseDoctorArguments(["run-id"]), /Usage/);
});

test("doctor groups every in-flight claim and mutates nothing", async () => {
  const abandoned = abandonedRun();
  const ambiguous = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    activeOperation: {
      operationId: "operation-2",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-2",
    },
  });
  const live = abandonedRun({
    id: "33333333-3333-4333-8333-333333333333",
    lease: liveLease(),
  });
  const settled = retiredRun({ id: "44444444-4444-4444-8444-444444444444" });
  const { registry, directory } = await seedDirectory([
    abandoned,
    ambiguous,
    live,
    settled,
  ]);
  const before = await snapshotRuns(directory);

  const report =
    (await execRead(registry, "doctor", [], {
      probe: nativeTerminalProbe,
    })) ?? "";

  assert.match(report, /Plan execution runs: 4 \(3 claiming work in flight\)/);
  assert.match(
    report,
    new RegExp(
      `abandoned — no worker is running:\\n- ${abandoned.id} [^\\n]*operation directory is gone from disk\\. Next: /exec resume ${abandoned.id}`,
    ),
  );
  assert.match(
    report,
    new RegExp(
      `abandoned — no worker is running:[\\s\\S]*- ${ambiguous.id} [^\\n]*Next: /exec resume ${ambiguous.id}`,
    ),
  );
  assert.match(
    report,
    new RegExp(
      `live[^\\n]*\\n- ${live.id} [^\\n]*session ${LIVE_SESSION_ID} holds a live lease`,
    ),
  );
  assert.match(
    report,
    /1 older terminal run hidden\. \/exec status --all to show, \/exec cleanup to remove\./,
  );
  assert.deepEqual(
    await snapshotRuns(directory),
    before,
    "preview writes nothing",
  );
});

test("doctor --reconcile retains retired operations and leaves explicit stops intact", async () => {
  const abandoned = abandonedRun();
  const ambiguous = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    activeOperation: {
      operationId: "operation-2",
      service: "bridge",
      kind: "implementation",
    },
  });
  const live = abandonedRun({
    id: "33333333-3333-4333-8333-333333333333",
    lease: liveLease(),
  });
  const cancelling = abandonedRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "cancel_pending",
  });
  const { registry, directory } = await seedDirectory([
    abandoned,
    ambiguous,
    live,
    cancelling,
  ]);
  const before = await snapshotRuns(directory);

  const report = await execReconcile(registry, nativeTerminalProbe);

  assert.match(report, /Reconciled 1 run with their existing operation identity\./);
  assert.match(report, /no task attempt was consumed/);
  assert.match(
    report,
    new RegExp(`- ${abandoned.id} [^\\n]*Next: /exec resume ${abandoned.id}`),
  );
  assert.match(report, /Left 1 abandoned run alone: each carries the stop/);
  assert.match(
    report,
    new RegExp(`- ${cancelling.id} [^\\n]*Next: /exec stop ${cancelling.id}`),
  );
  assert.equal((await registry.get(cancelling.id))?.status, "cancel_pending");
  assert.ok(
    (await registry.get(cancelling.id))?.activeOperation,
    "the tracked operation survives too",
  );

  const reset = await registry.get(abandoned.id);
  assert.equal(reset?.status, "running");
  assert.equal(reset?.activeOperation?.operationId, abandoned.activeOperation?.operationId);
  assert.equal(reset?.activeOperation?.processTreeExited, true);
  assert.deepEqual(reset?.taskAttempts, abandoned.taskAttempts);
  assert.ok(reset?.reconciledAt, "the reset is stamped for audit");
  assert.match(reset?.error ?? "", /lease was dead/);
  assert.match(reset?.error ?? "", /operation directory is gone from disk/);

  const after = await snapshotRuns(directory);
  assert.equal(
    after[ambiguous.id],
    before[ambiguous.id],
    "ambiguous untouched",
  );
  assert.equal(after[live.id], before[live.id], "live untouched");
});

test("doctor --reconcile skips a run reclaimed while the sweep ran", async () => {
  const reclaimed = abandonedRun();
  const stalled = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
  });
  const { registry } = await seedDirectory([reclaimed, stalled]);
  const probe: EvidenceProbe = async (candidate) => {
    if (candidate.id === reclaimed.id) {
      const current = await registry.get(candidate.id);
      await registry.update({ ...current!, lease: liveLease() });
    }
    return {
      asyncDirPresent: false,
      processTerminalProof: observedTerminalProof(
        candidate.activeOperation?.externalRunId ?? "external-unknown",
      ),
    };
  };

  const report = await execReconcile(registry, probe);

  assert.match(report, /Reconciled 1 run with their existing operation identity\./);
  assert.match(report, /Skipped 1 run reclaimed while the sweep ran/);
  assert.match(report, new RegExp(`- ${reclaimed.id} `));
  assert.equal((await registry.get(reclaimed.id))?.status, "running");
  assert.equal((await registry.get(reclaimed.id))?.reconciledAt, undefined);
  assert.equal((await registry.get(stalled.id))?.status, "running");
});

test("a reconciled run preserves its terminal operation for result recovery", async () => {
  const abandoned = abandonedRun();
  const { registry } = await seedDirectory([abandoned]);

  await execReconcile(registry, nativeTerminalProbe);
  const reconciled = await registry.get(abandoned.id);

  assert.ok(reconciled);
  assert.equal(isActionAllowed("resume", reconciled), true);
  assert.equal(isRecoverableFailure(reconciled), false);
  const guidance = recoveryGuidance(reconciled);
  assert.equal(guidance.classification, "the worker has finished and its result is ready to read");
  assert.match(guidance.action, new RegExp(`/exec resume ${abandoned.id}`));
  assert.deepEqual(reconciled.taskAttempts, { "1": 2 });
});

test("reconcile records the retained operation in the run's own progress file", async () => {
  const progressPath = join(
    await mkdtemp(join(tmpdir(), "pi-plan-exec-progress-")),
    "progress.txt",
  );
  const abandoned = abandonedRun({ progressPath });
  const { registry } = await seedDirectory([abandoned]);

  await execReconcile(registry, nativeTerminalProbe);

  const progress = await readFile(progressPath, "utf8");
  assert.match(progress, /Reconciled by \/exec doctor/);
  assert.match(progress, /operation directory is gone from disk/);
  assert.match(progress, /task attempt counter was left unchanged/);
});

test("the bridge is asked even when the operation directory is missing", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-"));
  const surviving = abandonedRun({
    activeOperation: {
      operationId: "operation-surviving",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const wiped = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
  });
  const fused = abandonedRun({
    id: "33333333-3333-4333-8333-333333333333",
    stage: "fusion_review",
    activeOperation: {
      operationId: "operation-fusion",
      service: "fusion",
      kind: "fusion",
      externalRunId: "external-3",
      asyncDir,
    },
  });
  const { registry } = await seedDirectory([surviving, wiped, fused]);
  const asked: string[] = [];

  const report = await execReconcile(
    registry,
    abandonmentProbe(
      async (operationId) => {
        asked.push(operationId);
        return "absent";
      },
      async (operation) => ({
        processTerminalProof: observedTerminalProof(
          operation.externalRunId ?? "external-unknown",
        ),
      }),
    ),
  );

  assert.deepEqual(
    asked.toSorted(),
    ["operation-1", "operation-surviving"],
    "directory absence is diagnostic; every bridge operation is still asked",
  );
  assert.match(report, /Reconciled 2 runs with their existing operation identity\./);
  assert.match(
    (await registry.get(surviving.id))?.error ?? "",
    /the bridge has no record of its operation/,
  );
  assert.equal((await registry.get(fused.id))?.status, "running");
});

test("a bridge that cannot answer is not evidence the worker is gone", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-"));
  const surviving = abandonedRun({
    activeOperation: {
      operationId: "operation-surviving",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const { registry } = await seedDirectory([surviving]);

  const report = await execReconcile(
    registry,
    abandonmentProbe(() => Promise.reject(new Error("bridge is not loaded"))),
  );

  assert.match(report, /No run is provably abandoned, so nothing was reset\./);
  assert.equal((await registry.get(surviving.id))?.status, "running");
});

test("startup says one line about abandoned runs, or nothing", async () => {
  const { registry } = await seedDirectory([
    abandonedRun(),
    abandonedRun({ id: "22222222-2222-4222-8222-222222222222" }),
  ]);
  const { registry: quiet } = await seedDirectory([retiredRun()]);

  assert.equal(
    abandonedRunsNotice(await sweepAbandonment(registry, nativeTerminalProbe)),
    "2 plan execution runs claim to be running with no worker. Use /exec status.",
  );
  assert.equal(abandonedRunsNotice(await sweepAbandonment(quiet)), undefined);

  const { registry: single } = await seedDirectory([abandonedRun()]);
  assert.match(
    abandonedRunsNotice(await sweepAbandonment(single, nativeTerminalProbe)) ?? "",
    /^1 plan execution run claims to be running/,
  );
});

test("the startup sweep classifies without writing anything", async () => {
  const abandoned = abandonedRun();
  const live = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    lease: liveLease(),
  });
  const { registry, directory } = await seedDirectory([abandoned, live]);
  const before = await snapshotRuns(directory);

  const sweep = await sweepAbandonment(registry, nativeTerminalProbe);

  assert.deepEqual(
    sweep.diagnoses.map((diagnosis) => diagnosis.classification).sort(),
    ["abandoned", "live"],
  );
  assert.deepEqual(await snapshotRuns(directory), before);
});

test("cleanup removes a run record the registry cannot parse", async () => {
  const corruptId = "99999999-9999-4999-8999-999999999999";
  const { registry, directory } = await seedDirectory([retiredRun()]);
  await mkdir(join(directory, corruptId), { recursive: true });
  await writeFile(join(directory, corruptId, "run.json"), "{not-json\n");

  const doctored = (await execRead(registry, "doctor", [])) ?? "";
  assert.match(
    doctored,
    new RegExp(
      `unreadable run records:\\n- ${corruptId} — [^\\n]*Next: /exec cleanup ${corruptId} --apply`,
    ),
  );

  const preview = await execCleanup(registry, [corruptId]);
  assert.match(preview, /nothing was deleted/);
  assert.ok(await registry.listWithErrors().then((it) => it.errors.length));

  const applied = await execCleanup(registry, [corruptId, "--apply"]);
  assert.match(applied, /Removed 1 unreadable plan execution run record/);
  assert.deepEqual((await registry.listWithErrors()).errors, []);
});

test("settled runs group by what they need and hide stale terminal rows", () => {
  const paused = run({
    id: "11111111-1111-4111-8111-111111111111",
    status: "paused",
    updatedAt: Date.now() - HOUR_MS,
  });
  const failed = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "failed",
    updatedAt: Date.now() - HOUR_MS,
  });
  // Retired an hour ago: the archive stamp does not hide a run, age does.
  const justArchived = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
    updatedAt: Date.now() - HOUR_MS,
    retiredAt: Date.now() - HOUR_MS,
  });
  const oldCompleted = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
  });
  const oldCancelled = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "cancelled",
  });
  const runs = [paused, failed, justArchived, oldCompleted, oldCancelled];

  const lines = settledRunLines(runs).join("\n");

  assert.match(
    lines,
    new RegExp(
      `waiting for you:\\n- ${paused.id} [^\\n]*Next: /exec resume ${paused.id}`,
    ),
  );
  assert.match(
    lines,
    new RegExp(`- ${failed.id} [^\\n]*/exec resume ${failed.id}`),
  );
  assert.match(
    lines,
    new RegExp(
      `finished:\\n- ${justArchived.id} [^\\n]*Next: /exec cleanup ${justArchived.id}`,
    ),
  );
  assert.ok(!lines.includes(oldCompleted.id), "an old terminal run is hidden");
  assert.ok(!lines.includes(oldCancelled.id), "an old terminal run is hidden");
  assert.match(
    lines,
    /2 older terminal runs hidden\. \/exec status --all to show, \/exec cleanup to remove\./,
  );

  const all = settledRunLines(runs, true).join("\n");

  for (const shown of runs) assert.ok(all.includes(shown.id), shown.id);
  assert.doesNotMatch(all, /hidden/, "--all hides nothing, so no footer");
});

test("status answers what is going on in one pass", async () => {
  const abandoned = abandonedRun();
  const paused = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "paused",
    updatedAt: Date.now() - HOUR_MS,
  });
  const stale = retiredRun({ id: "33333333-3333-4333-8333-333333333333" });
  const registry = await seedRegistry([abandoned, paused, stale]);

  const report = await execStatus(registry, { probe: nativeTerminalProbe });

  assert.match(report, /Plan execution runs: 3 \(1 claiming work in flight\)/);
  assert.match(
    report,
    new RegExp(
      `abandoned — no worker is running:\\n- ${abandoned.id} [^\\n]*Next: /exec resume ${abandoned.id}`,
    ),
  );
  assert.doesNotMatch(report, /--reconcile/, "the retired flag is not offered");
  assert.match(
    report,
    new RegExp(`- ${paused.id} [^\\n]*Next: /exec resume ${paused.id}`),
  );
  assert.ok(!report.includes(stale.id), "an old terminal run needs --all");
  assert.match(report, /1 older terminal run hidden\./);

  const zoomed = await execStatus(registry, {
    all: true,
    probe: nativeTerminalProbe,
  });
  assert.ok(zoomed.includes(stale.id), "--all is the zoom control");
  assert.doesNotMatch(zoomed, /hidden/);
});

test("status reports a missing package with its install commands", async () => {
  const registry = await seedRegistry([]);

  const report = await execStatus(registry, {
    problems: ["missing: pi-subagents"],
  });

  assert.match(report, /Plan-exec prerequisites — missing: pi-subagents\./);
  assert.match(report, /^pi install -l git:github\.com\/alexei-led\/pi-subagents-codex-fix@[a-f0-9]{40}$/m);
  assert.doesNotMatch(report, /pi-fusion/);
  assert.match(report, /No plan execution runs\. Start one with \/exec\./);
  assert.equal(
    await execStatus(registry),
    "No plan execution runs. Start one with /exec.",
  );
});

test("status arguments take one run ID or the --all zoom, never both", () => {
  assert.deepEqual(parseStatusArguments([]), {
    selector: undefined,
    all: false,
  });
  assert.deepEqual(parseStatusArguments(["run-id"]), {
    selector: "run-id",
    all: false,
  });
  assert.deepEqual(parseStatusArguments(["--all"]), {
    selector: undefined,
    all: true,
  });
  assert.throws(
    () => parseStatusArguments(["run-id", "--all"]),
    /cannot be combined/,
  );
  assert.throws(
    () => parseStatusArguments(["--reconcile"]),
    /\/exec status never writes\. \/exec resume <run-id> resets/,
  );
  assert.throws(() => parseStatusArguments(["one", "two"]), /Usage/);
});

test("the retired read verbs still work and name their replacement", async () => {
  const abandoned = abandonedRun();
  const stale = retiredRun({ id: "33333333-3333-4333-8333-333333333333" });
  const registry = await seedRegistry([abandoned, stale]);

  const runs = await execRead(registry, "runs", []);
  assert.match(runs ?? "", /Plan execution runs: 2/);
  assert.match(runs ?? "", new RegExp(`- ${abandoned.id} `));
  assert.equal(
    (runs?.match(/\/exec runs is now \/exec status/g) ?? []).length,
    1,
    "the replacement is named once",
  );

  const zoomed = await execRead(registry, "runs", ["--all"]);
  assert.ok(zoomed?.includes(stale.id), "--all still zooms through the alias");

  const doctor = await execRead(registry, "doctor", []);
  assert.match(doctor ?? "", new RegExp(`- ${abandoned.id} `));
  assert.match(doctor ?? "", /\/exec doctor is now \/exec status/);

  const setup = await execRead(registry, "setup", []);
  assert.match(setup ?? "", /^pi install -l git:github\.com\/alexei-led\/pi-subagents-codex-fix@[a-f0-9]{40}$/m);
  assert.match(setup ?? "", /\/exec setup is now part of \/exec status/);

  assert.equal(await execRead(registry, "resume", []), undefined);
  assert.equal(await execRead(registry, "status", ["run-id"]), undefined);
});

test("the doctor alias keeps --reconcile for scripted callers", async () => {
  const abandoned = abandonedRun();
  const { registry, directory } = await seedDirectory([abandoned]);
  const before = await snapshotRuns(directory);

  assert.equal(await execRead(registry, "doctor", ["--reconcile"]), undefined);
  assert.deepEqual(await snapshotRuns(directory), before, "no read wrote");

  const report = await execReconcile(registry, nativeTerminalProbe);

  assert.match(report, /Reconciled 1 run with their existing operation identity\./);
  assert.equal((await registry.get(abandoned.id))?.status, "running");
});

test("the start subcommand is gone", () => {
  assert.ok(
    !(Object.values(EXEC_ACTION) as string[]).includes("start"),
    "start is not a subcommand",
  );
  assert.doesNotMatch(execHelp(), /\/exec start/);
  assert.equal(
    (getExecArgumentCompletions("") ?? []).find(
      (item) => item.value === "start",
    ),
    undefined,
  );
});

test("the exec-plan skill documents exactly the subcommands /exec implements", async () => {
  const skill = fileURLToPath(new URL("../skills/exec-plan/", import.meta.url));
  const prose = (
    await Promise.all([
      readFile(join(skill, "SKILL.md"), "utf8"),
      readFile(join(skill, "references", "recovery.md"), "utf8"),
    ])
  ).join("\n");
  // A subcommand token must start with a letter, so `--all`, `--apply`,
  // `--reconcile`, and `--include-failed` are flags and never match.
  const documented = new Set(
    [...prose.matchAll(/(?<![-\w])\/exec[ \t]+(?<subcommand>[a-z][a-z-]*)/g)]
      .map((match) => match.groups?.subcommand)
      .filter((token): token is string => Boolean(token)),
  );
  const actions = new Set<string>(Object.values(EXEC_ACTION));
  const aliases = new Set<string>(EXEC_ALIAS_ACTIONS);

  assert.ok(documented.size > 0, "no /exec subcommand was found in the skill");
  for (const token of documented)
    assert.ok(actions.has(token), `skill documents unknown: /exec ${token}`);
  // A hidden alias may appear in the skill but is never required there.
  for (const action of actions)
    if (!aliases.has(action))
      assert.ok(
        documented.has(action),
        `skill never documents: /exec ${action}`,
      );
});

test("resume takes over a lease whose session is provably gone", () => {
  // DEAD_LEASE names the caller: a Pi restarted under the same session ID must
  // not be locked out of the run the sweep just told it to resume.
  const stranded = run({ status: "skip_pending", lease: DEAD_LEASE });
  assert.equal(isActionAllowed("resume", stranded), true);

  const held = run({ status: "skip_pending", lease: liveLease() });
  assert.equal(isActionAllowed("resume", held), false);
  // No lease at all: a handoff that failed between release and claim leaves
  // one of these, and it must not be a dead end.
  const unheld = run({ status: "skip_pending" });
  assert.equal(isActionAllowed("resume", unheld), true);
  const done = run({ status: "completed", stage: "complete" });
  assert.equal(isActionAllowed("resume", done), false);
});

test("a live foreign lease still blocks a second worker", async () => {
  const held = run({ status: "running", lease: liveLease() });
  const registry = await seedRegistry([held]);

  // Reachable by status; the claim is what refuses it.
  assert.equal(isActionAllowed("resume", held), true);
  await assert.rejects(
    registry.claim(held, "session-new"),
    /controlled by another active Pi session/,
  );
});

test("the retired adopt verb runs resume and names it once", () => {
  assert.deepEqual(runActionFor("adopt"), {
    action: "resume",
    note: "/exec adopt is now /exec resume; the old name still works.",
  });
  assert.deepEqual(runActionFor("resume"), { action: "resume" });
  assert.deepEqual(runActionFor("skip"), { action: "skip" });
  assert.equal(runActionFor("status"), undefined);
  assert.equal(runActionFor("cleanup"), undefined);
  assert.equal(runActionFor(undefined), undefined);
  assert.ok(
    (EXEC_ALIAS_ACTIONS as readonly string[]).includes(EXEC_ACTION.ADOPT),
    "adopt is a hidden alias",
  );
});

test("help drops both interactive flags but keeps them working", () => {
  const help = execHelp();
  assert.doesNotMatch(help, /--adopt-current-branch/);
  assert.doesNotMatch(help, /--retry-task/);
  assert.match(help, /--model current\|provider\/model/);
  // Both flags stay parseable for a caller with no human to ask.
  assert.deepEqual(
    parseResumeOptions(["--adopt-current-branch", "--retry-task"]),
    {
      adoptCurrentBranch: true,
      retryTask: true,
      sameMachine: false,
      model: undefined,
    },
  );
  assert.deepEqual(parseResumeOptions(["--same-machine"]), {
    adoptCurrentBranch: false,
    retryTask: false,
    sameMachine: true,
    model: undefined,
  });
  assert.throws(
    () => parseResumeOptions(["--same-host"]),
    /Usage: \/exec resume/,
  );
});

test("resume reconciles a provably abandoned run, then continues", async () => {
  const progressPath = join(
    await mkdtemp(join(tmpdir(), "pi-plan-exec-resume-")),
    "progress.txt",
  );
  const abandoned = abandonedRun({ progressPath });
  const registry = await seedRegistry([abandoned]);

  const recovered = await reconcileForResume(
    registry,
    abandoned,
    nativeTerminalProbe,
  );

  assert.equal(recovered.run.status, "running");
  assert.equal(recovered.run.activeOperation?.operationId, abandoned.activeOperation?.operationId);
  assert.deepEqual(recovered.run.taskAttempts, abandoned.taskAttempts);
  assert.ok(recovered.run.reconciledAt, "the reset is stamped for audit");
  assert.match(recovered.note ?? "", /existing operation and candidate were preserved/);
  assert.match(recovered.note ?? "", /No task attempt was consumed/);
  assert.match(
    (await registry.get(abandoned.id))?.error ?? "",
    /Reconciled by \/exec resume/,
  );
  assert.match(
    await readFile(progressPath, "utf8"),
    /Reconciled by \/exec resume[\s\S]*attempt counter was left unchanged/,
  );
  assert.equal(isRecoverableFailure(recovered.run), false);
  assert.equal(
    isActionAllowed("resume", recovered.run),
    true,
    "the reconciled run is resumable",
  );
});

test("resume refuses a run whose worker cannot be proven gone", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-live-"));
  const ambiguous = abandonedRun({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const { registry, directory } = await seedDirectory([ambiguous]);
  const before = await snapshotRuns(directory);

  await assert.rejects(
    reconcileForResume(registry, ambiguous),
    /evidence is incomplete[\s\S]*could add a second writer[\s\S]*\/exec stop/,
  );
  assert.deepEqual(
    await snapshotRuns(directory),
    before,
    "an ambiguous run is reported, never reset",
  );
});

test("resume refuses a run whose operation directory cannot be read", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-denied-"));
  const asyncDir = join(parent, "operation");
  await mkdir(asyncDir);
  // Mode 000 on the parent makes access() fail with EACCES instead of ENOENT.
  // It needs no root and destroys nothing.
  await chmod(parent, 0o000);
  const unreadable = abandonedRun({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const { registry, directory } = await seedDirectory([unreadable]);
  const before = await snapshotRuns(directory);

  try {
    const evidence = await runEvidence(unreadable, abandonmentProbe());
    assert.equal(
      evidence.asyncDirPresent,
      undefined,
      "a check that failed is not proof the directory is gone",
    );
    await assert.rejects(
      reconcileForResume(registry, unreadable),
      /evidence is incomplete/,
      "an unreadable directory must not license a reset",
    );
    assert.deepEqual(await snapshotRuns(directory), before);
  } finally {
    await chmod(parent, 0o700);
  }
});

test("resume passes through what it has no evidence against", async () => {
  const registry = await seedRegistry([]);
  const untracked = run({ status: "running", lease: DEAD_LEASE });
  delete untracked.activeOperation;
  const own = abandonedRun({ lease: liveLease() });
  const cancelling = abandonedRun({ status: "cancel_pending" });
  const failed = abandonedRun({ status: "failed" });

  for (const [label, candidate] of [
    ["nothing tracked, so nothing can double-write", untracked],
    ["a live lease holds it", own],
    ["cancellation must survive, not be reset", cancelling],
    ["resume already recovers a failure", failed],
  ] as const) {
    const recovered = await reconcileForResume(registry, candidate);
    assert.equal(recovered.run, candidate, label);
    assert.equal(recovered.note, undefined, label);
  }
});

test("resume skips a run reclaimed while it was being diagnosed", async () => {
  const abandoned = abandonedRun();
  const registry = await seedRegistry([abandoned]);
  const probe: EvidenceProbe = async () => {
    const current = await registry.get(abandoned.id);
    await registry.update({ ...current!, lease: liveLease() });
    return {
      asyncDirPresent: false,
      processTerminalProof: observedTerminalProof(
        abandoned.activeOperation?.externalRunId ?? "external-unknown",
      ),
    };
  };

  await assert.rejects(
    reconcileForResume(registry, abandoned, probe),
    /reclaimed while it was being diagnosed/,
  );
  assert.equal((await registry.get(abandoned.id))?.status, "running");
  assert.equal((await registry.get(abandoned.id))?.reconciledAt, undefined);
});

test("every run whose guidance names resume survives the resume gate", async () => {
  const abandoned = abandonedRun();
  const registry = await seedRegistry([abandoned]);
  const withoutOperation = (overrides: Partial<PlanExecRun>): PlanExecRun => {
    const shape = run(overrides);
    delete shape.activeOperation;
    return shape;
  };
  // `withoutOperation` matters: an activeOperation left in place fires the
  // unobservable-worker branch first and the loop tests nothing.
  const shapes: Array<[PlanExecRun, AbandonmentEvidence | undefined]> = [
    [
      withoutOperation({ status: "paused", stage: "comprehensive_review" }),
      undefined,
    ],
    [
      withoutOperation({ status: "failed", error: "worker crashed" }),
      undefined,
    ],
    [withoutOperation({ status: "running", lease: DEAD_LEASE }), undefined],
    // The only shape the gate writes for, so the only one seeded.
    [abandoned, terminalEvidence()],
  ];

  let exercised = 0;
  for (const [shape, evidence] of shapes) {
    const guidance = recoveryGuidance(shape, evidence);
    // A qualified resume such as `--same-machine` is not the bare resume this
    // gate takes; the gate is meant to refuse without the flag.
    if (guidance.action.includes(`${shape.id} --`)) continue;
    if (!guidance.action.includes(`/exec resume ${shape.id}`)) continue;
    exercised += 1;
    await assert.doesNotReject(
      reconcileForResume(registry, shape, nativeTerminalProbe),
      `guidance recommends resume but the gate refuses it: ${guidance.classification}`,
    );
  }
  assert.equal(exercised, shapes.length, "every shape must reach the gate");

  // The counter-case: with no evidence, the same run is not offered resume.
  assert.doesNotMatch(recoveryGuidance(abandonedRun()).action, /\/exec resume/);
  const stranded = withoutOperation({ status: "running", lease: DEAD_LEASE });
  assert.equal(
    recoveryGuidance(stranded).classification,
    "someone else's session was holding this run, and it is gone",
  );
});

/** The verbs a row or a sentence can name, in the order the parser reads them. */
function namedVerbs(text: string): string[] {
  return [...text.matchAll(/\/exec (resume|stop|status|cleanup|skip)\b/g)].map(
    (match) => match[1] as string,
  );
}

test("every surface names the same next command for one run", async () => {
  const foreignLease = {
    sessionId: "session-remote",
    pid: 12345,
    hostname: "buildbox.corp.example",
    heartbeatAt: Date.now() - 10 * 60_000,
  };
  const leases: Array<PlanExecRun["lease"] | undefined> = [
    undefined,
    liveLease(),
    { ...DEAD_LEASE, heartbeatAt: Date.now(), pid: 4194303 },
    DEAD_LEASE,
    foreignLease,
    // The axis --same-machine lives on: a foreign name whose heartbeat still
    // beats reads live here, and no local probe may contradict it.
    { ...foreignLease, heartbeatAt: Date.now() },
  ];
  const operations: Array<PlanExecRun["activeOperation"] | undefined> = [
    undefined,
    {
      operationId: "op",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      externalRunId: "x",
      asyncDir: process.cwd(),
      launchStartedAt: Date.now() - 60_000,
    },
    {
      operationId: "op",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      externalRunId: "x",
      asyncDir: MISSING_ASYNC_DIR,
      launchStartedAt: Date.now() - 60_000,
    },
    {
      operationId: "op",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
      asyncDir: process.cwd(),
      launchStartedAt: Date.now() - 60_000,
    },
  ];
  const shapes: PlanExecRun[] = [];
  for (const status of [
    "running",
    "starting",
    "skip_pending",
    "cancel_pending",
    "paused",
    "failed",
  ] as const)
    for (const lease of leases)
      for (const activeOperation of operations) {
        const shape = run({
          id: randomUUID(),
          status,
          stage:
            status === "skip_pending"
              ? "comprehensive_review"
              : "implementation",
          ...(lease ? { lease } : {}),
          ...(status === "skip_pending"
            ? { config: { ...config, reviewRequired: false } }
            : {}),
          ...(status === "skip_pending"
            ? {
                pendingStageSkip: {
                  stage: "comprehensive_review",
                  reason: "accepted",
                  requestedAt: Date.now() - 60_000,
                  requestedBy: "session-old",
                },
              }
            : {}),
        });
        // The registry rejects an operation whose kind cannot belong to the
        // stage, and a waived run sits on a review stage.
        if (activeOperation)
          shape.activeOperation =
            status === "skip_pending"
              ? { ...activeOperation, kind: "review" }
              : activeOperation;
        else delete shape.activeOperation;
        shapes.push(shape);
      }

  const { registry } = await seedDirectory(shapes);
  const probe = abandonmentProbe();
  const report = await execStatus(registry, { probe, all: true });
  const rows = new Map(
    report
      .split("\n")
      .filter((line) => line.includes("Next: /exec"))
      .map((line) => [line.slice(2, 38), line.split("Next: ")[1] as string]),
  );

  for (const shape of shapes) {
    const evidence = await runEvidence(shape, probe);
    const verdict = recoveryGuidance(shape, evidence);
    const label = `${shape.status} lease=${shape.lease?.sessionId ?? "none"}@${shape.lease?.hostname ?? "-"} op=${shape.activeOperation?.externalRunId ?? shape.activeOperation?.operationId ?? "none"}`;

    // The list row — the sweep for an in-flight claim, the settled group
    // otherwise — must be the command the detail view names.
    assert.equal(rows.get(shape.id), verdict.command, `row: ${label}`);
    // And that command must be one the sentence beside it names first.
    assert.equal(
      namedVerbs(verdict.action)[0],
      namedVerbs(verdict.command)[0],
      `action leads with another verb: ${label}`,
    );
    // And one the run will accept.
    const verb = namedVerbs(verdict.command)[0] as string;
    if (verb === "resume" || verb === "stop" || verb === "skip")
      assert.equal(
        isActionAllowed(verb, shape),
        true,
        `guidance names /exec ${verb} but the gate refuses it: ${label}`,
      );
    // Nothing may report a worker as watched when no lease proves it.
    if (!evidence.leaseLive)
      for (const claim of [
        "the controller is polling",
        "controller is still polling",
        "reported activity",
        "polling continues",
        "; retrying",
      ])
        assert.ok(
          !formatRunStatus(shape, evidence).includes(claim),
          `"${claim}" over a dead lease: ${label}`,
        );
  }

  // The gate is the fourth surface: a bare resume it names must not refuse.
  for (const shape of shapes) {
    const evidence = await runEvidence(shape, probe);
    const { command } = recoveryGuidance(shape, evidence);
    if (command !== `/exec resume ${shape.id}`) continue;
    await assert.doesNotReject(
      reconcileForResume(registry, shape, probe),
      `guidance names a resume the gate refuses: ${shape.status}`,
    );
  }
});

test("a finished run's list row names the command its detail view names", async () => {
  // The statuses the loop above cannot reach: every in-flight and paused shape
  // is covered there, and only a terminal non-failed run reaches `finished`.
  const finished = (
    ["completed", "completed_with_findings", "cancelled"] as const
  ).map((status) =>
    retiredRun({ id: randomUUID(), status, updatedAt: Date.now() }),
  );
  const registry = await seedRegistry(finished);
  const report = await execStatus(registry, { probe: abandonmentProbe() });

  for (const record of finished) {
    const row = report.split("\n").find((line) => line.includes(record.id));
    assert.equal(
      row?.split("Next: ")[1],
      recoveryGuidance(record).command,
      `list row disagrees with the detail view: ${record.status}`,
    );
  }
});

test("a waived stage nothing can observe names the waiver, not another read", async () => {
  const waived = run({
    id: randomUUID(),
    status: "skip_pending",
    stage: "comprehensive_review",
    config: { ...config, reviewRequired: false },
    lease: DEAD_LEASE,
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "review",
    },
    pendingStageSkip: {
      stage: "comprehensive_review",
      reason: "accepted",
      requestedAt: Date.now() - 60_000,
      requestedBy: "session-old",
    },
  });
  const probe = abandonmentProbe();
  const evidence = await runEvidence(waived, probe);
  // Nothing polls it and nothing proves the worker gone, so neither a re-read
  // nor a reset moves it. The waiver is the one command that does.
  assert.equal(evidence.leaseLive, false);
  assert.equal(evidence.asyncDirPresent, undefined);
  assert.equal(evidence.bridgeState, undefined);
  await assert.rejects(
    reconcileForResume(await seedRegistry([waived]), waived, probe),
    /evidence is incomplete/,
  );

  const guidance = recoveryGuidance(waived, evidence);
  assert.equal(isStageWaiverAvailable(waived), true);
  assert.equal(namedVerbs(guidance.command)[0], "skip");
  assert.equal(namedVerbs(guidance.action)[0], "skip");
  const registry = await seedRegistry([waived]);
  const row = (await execStatus(registry, { probe }))
    .split("\n")
    .find((line) => line.includes(waived.id));
  assert.equal(row?.split("Next: ")[1], guidance.command);
});

test("--same-machine verifies local proof before taking a foreign lease", async () => {
  // A1: the machine was renamed and its worker died 5s ago. A2: the machine is
  // genuinely remote and its worker is alive. A human assertion permits local
  // evidence gathering, but stale heartbeat alone decides neither case.
  const beating = (sessionId: string, pid: number) => ({
    sessionId,
    pid,
    hostname: "buildbox.corp.example",
    heartbeatAt: Date.now() - 5_000,
  });
  const cases: Array<[string, PlanExecRun]> = [
    [
      "A1 renamed machine, worker dead",
      abandonedRun({ lease: beating("session-old", reapedPid()) }),
    ],
    [
      "A2 remote machine, worker alive",
      abandonedRun({ lease: beating("session-remote", reapedPid()) }),
    ],
  ];

  for (const [name, held] of cases) {
    const { registry, directory } = await seedDirectory([held]);
    const before = await snapshotRuns(directory);

    assert.equal(sameMachineRefusal(held), undefined, name);
    await assert.rejects(
      reconcileForResume(registry, held, abandonmentProbe(), true),
      /evidence is incomplete/,
      name,
    );
    assert.deepEqual(await snapshotRuns(directory), before, name);
    assert.equal((await runEvidence(held)).leaseLive, true, name);
  }
});

test("status counts a hidden-only registry instead of reporting an empty one", async () => {
  const registry = await seedRegistry([retiredRun()]);

  const report = await execStatus(registry);

  assert.match(report, /^Plan execution runs: 1$/m);
  assert.doesNotMatch(report, /claiming work in flight/);
  assert.match(report, /1 older terminal run hidden\./);
});

test("stop reaches both outcomes and asks for the one it takes", async () => {
  const running = run({ status: "running" });
  const asked: Array<{ title: string; options: string[] }> = [];
  const pick = (index: number) => ({
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        asked.push({ title, options });
        return options[index];
      },
    },
  });

  assert.equal(await chooseStopOutcome(running, pick(0)), EXEC_ACTION.PAUSE);
  assert.equal(await chooseStopOutcome(running, pick(1)), EXEC_ACTION.CANCEL);
  assert.equal(asked.length, 2, "each stop asks before it acts");
  assert.match(asked[0]!.title, new RegExp(running.id.slice(0, 8)));
  assert.match(asked[0]!.options[0]!, /^Pause — .*\/exec resume continues/);
  assert.match(asked[0]!.options[1]!, /^Cancel — final.*worktree is preserved/);

  await assert.rejects(
    chooseStopOutcome(running, {
      hasUI: true,
      ui: { select: async () => undefined },
    }),
    /Stop cancelled\./,
  );
});

test("pause and cancel persist a stop fence before later recovery can run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-stop-fence-"));
  const registry = new RunRegistry(join(root, "runs"));
  const stored = await registry.create(
    run({ status: "running", stopGeneration: 4 }),
  );

  const paused = await requestStatus(stored, EXEC_ACTION.PAUSE, registry);
  assert.equal(paused.status, "paused");
  assert.equal(paused.userStopped, true);
  assert.equal(paused.stopGeneration, 5);

  const cancelled = await requestStatus(
    paused,
    EXEC_ACTION.CANCEL,
    registry,
  );
  assert.equal(cancelled.status, "cancel_pending");
  assert.equal(cancelled.userStopped, true);
  assert.equal(cancelled.stopGeneration, 6);
  const persisted = await registry.get(stored.id);
  assert.deepEqual(
    persisted && {
      status: persisted.status,
      userStopped: persisted.userStopped,
      stopGeneration: persisted.stopGeneration,
    },
    { status: "cancel_pending", userStopped: true, stopGeneration: 6 },
  );
});

test("paused runs keep the background probe while a child exit is unconfirmed", () => {
  const settledPause = run({ status: "paused" });
  delete settledPause.activeOperation;
  assert.equal(
    shouldStopBackgroundController(settledPause),
    true,
  );
  assert.equal(
    shouldStopBackgroundController(
      run({
        status: "paused",
        activeOperation: {
          operationId: "pause-child",
          service: "bridge",
          kind: "implementation",
          externalRunId: "child-1",
        },
      }),
    ),
    false,
  );
  assert.equal(
    shouldStopBackgroundController(run({ status: "completed", stage: "complete" })),
    true,
  );
});

test("stop offers only the outcomes a run can still take, and still asks", async () => {
  const paused = run({ status: "paused", stage: "comprehensive_review" });
  let offered: string[] = [];

  const outcome = await chooseStopOutcome(paused, {
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        offered = options;
        return options[0];
      },
    },
  });

  assert.equal(
    outcome,
    EXEC_ACTION.CANCEL,
    "a paused run has nothing to pause",
  );
  assert.equal(offered.length, 1);
  // One option is still a question: a final cancel is never assumed.
  assert.match(offered[0]!, /^Cancel — final/);
  assert.equal(isActionAllowed("stop", paused), true);
  assert.equal(
    isActionAllowed("stop", run({ status: "completed", stage: "complete" })),
    false,
  );
});

test("stop refuses without a human and names both scripted verbs", async () => {
  await assert.rejects(
    chooseStopOutcome(run({ status: "running" }), {
      hasUI: false,
      ui: { select: async () => "Pause" },
    }),
    (error: Error) => {
      assert.match(error.message, /\/exec pause <run-id>/);
      assert.match(error.message, /\/exec cancel <run-id>/);
      assert.match(error.message, /resumable/);
      assert.match(error.message, /for good/);
      return true;
    },
  );
});

test("the retired pause and cancel verbs still work and name their replacement", () => {
  assert.deepEqual(runActionFor("stop"), { action: "stop" });
  assert.deepEqual(runActionFor("pause"), {
    action: "pause",
    note: "/exec pause is now /exec stop; the old name still works and is the way to pause without a human to ask.",
  });
  assert.deepEqual(runActionFor("cancel"), {
    action: "cancel",
    note: "/exec cancel is now /exec stop; the old name still works and is the way to cancel without a human to ask.",
  });
  for (const alias of ["pause", "cancel"])
    assert.ok(
      (EXEC_ALIAS_ACTIONS as readonly string[]).includes(alias),
      `${alias} is a hidden alias`,
    );
  assert.match(execHelp(), /\/exec stop \[run-id\]/);
  assert.ok(
    (getExecArgumentCompletions("") ?? []).some(
      (item) => item.value === "stop",
    ),
    "stop completes",
  );
});

test("status hands a blocked stage its skip command with the run ID filled in", async () => {
  const blocked = run({
    status: "failed",
    stage: "critical_review",
    error: "reviewer could not pass the stage",
    updatedAt: Date.now() - HOUR_MS,
    config: { ...config, reviewRequired: false },
  });
  delete blocked.activeOperation;
  const implementing = run({
    id: "22222222-2222-4222-8222-222222222222",
    status: "paused",
    stage: "implementation",
    updatedAt: Date.now() - HOUR_MS,
  });
  const registry = await seedRegistry([blocked, implementing]);

  const report = (await execRead(registry, "status", [])) ?? "";

  assert.match(
    report,
    new RegExp(
      `- ${blocked.id} [^\\n]*Next: /exec resume ${blocked.id}\\n  If critical_review cannot pass, waive it: /exec skip ${blocked.id} --reason <why the residual risk is accepted>`,
    ),
  );
  // Implementation is never skippable, so nothing offers a waiver for it.
  assert.doesNotMatch(report, new RegExp(`/exec skip ${implementing.id}`));
  assert.equal(isStageWaiverAvailable(blocked), true);
  assert.equal(isStageWaiverAvailable(implementing), false);
});

test("required review and finalize stages never suggest force-skip", () => {
  for (const stage of ["comprehensive_review", "finalize"] as const) {
    const required = run({
      status: "failed",
      stage,
      error: "required stage is blocked",
    });
    delete required.activeOperation;
    assert.equal(isStageWaiverAvailable(required), false, stage);
    assert.doesNotMatch(recoveryGuidance(required).action, /\/exec skip/);
    const invalidPending = run({
      status: "skip_pending",
      stage,
      pendingStageSkip: {
        stage,
        reason: "legacy waiver",
        requestedAt: 1,
        requestedBy: "old-session",
      },
    });
    assert.equal(recoveryGuidance(invalidPending).command, `/exec status ${invalidPending.id}`);
    assert.doesNotMatch(recoveryGuidance(invalidPending).action, /\/exec skip/);
  }
  const optionalReview = run({
    status: "failed",
    stage: "comprehensive_review",
    config: { ...config, reviewRequired: false },
  });
  delete optionalReview.activeOperation;
  assert.equal(isStageWaiverAvailable(optionalReview), true);
});

test("help lists every primary verb and no retired alias", () => {
  const help = execHelp();
  const aliases = new Set<string>(EXEC_ALIAS_ACTIONS);
  const primary = Object.values(EXEC_ACTION).filter(
    (action) => !aliases.has(action),
  );
  // Only the command list is line-anchored; the hints under it are prose.
  const listed = [...help.matchAll(/^\/exec[ \t]+(?<verb>[a-z][a-z-]*)/gm)].map(
    (match) => match.groups?.verb,
  );

  assert.deepEqual(listed.sort(), [...primary].sort());
  assert.match(help, /^\/exec \[plan-path\]/m);
  for (const alias of aliases)
    assert.doesNotMatch(help, new RegExp(`/exec ${alias}`), alias);
  assert.deepEqual(
    (getExecArgumentCompletions("") ?? []).map((item) => item.value).sort(),
    [...primary].sort(),
  );
});

test("what help drops, the skill keeps for scripted callers", async () => {
  const help = execHelp();
  const skill = await readFile(
    fileURLToPath(new URL("../skills/exec-plan/SKILL.md", import.meta.url)),
    "utf8",
  );
  // Retired names and prompt-answering flags leave help, never the docs.
  const scripted = [
    "--all",
    "--include-failed",
    "--reconcile",
    "--retry-task",
    "--adopt-current-branch",
  ];

  assert.match(help, /--apply/);
  assert.match(help, /--model current\|provider\/model/);
  // --reason is a required argument of skip, not an optional flag.
  assert.match(help, /--reason <text>/);
  for (const flag of scripted) {
    assert.doesNotMatch(help, new RegExp(flag), `help names ${flag}`);
    assert.match(skill, new RegExp(flag), `skill drops ${flag}`);
  }
  for (const alias of EXEC_ALIAS_ACTIONS)
    assert.match(skill, new RegExp(`/exec ${alias}`), `skill drops ${alias}`);
});

test("the detail view checks the worker itself instead of trusting the record", async () => {
  // Three hours in, so the elapsed bound would answer if the decisive evidence
  // did not.
  const abandoned = abandonedRun({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir: MISSING_ASYNC_DIR,
      launchStartedAt: Date.now() - 180 * 60_000,
      lastObservedAt: Date.now() - 180 * 60_000,
      workerSignal: { mode: "workflow" },
    },
  });
  const registry = await seedRegistry([abandoned]);

  const evidence = await runEvidence(abandoned, nativeTerminalProbe);
  const detail = formatRunStatus(abandoned, evidence);

  assert.match(detail, /recovery: the worker is gone, so nothing is running/);
  assert.match(detail, /worker: its operation directory is gone from disk/);
  assert.match(detail, new RegExp(`Run /exec resume ${abandoned.id}`));
  assert.doesNotMatch(detail, /Do not resume/);

  // Unprobed, the same record can claim neither death nor health.
  const unprobed = formatRunStatus(abandoned);
  assert.match(
    unprobed,
    /recovery: running longer than its budget allows|recovery: running, but nothing proves the worker is alive/,
  );
  assert.doesNotMatch(unprobed, /reported activity/);

  // The two views disagreeing about one run is the defect this pairing pins.
  const sweep = await execStatus(registry, { probe: nativeTerminalProbe });
  assert.match(
    sweep,
    new RegExp(
      `abandoned — no worker is running:\\n- ${abandoned.id} [^\\n]*Next: /exec resume ${abandoned.id}`,
    ),
  );
});

test("the two views judge a lease the same way, including this session's own", async () => {
  // A session that claims a run and starts no controller — /exec pause and the
  // worktree handoff both do — owns a stale lease 30s later with nothing
  // polling behind it.
  const mine = abandonedRun({
    lease: { ...DEAD_LEASE, sessionId: LIVE_SESSION_ID },
  });
  const registry = await seedRegistry([mine]);

  const evidence = await runEvidence(mine, nativeTerminalProbe);
  const detail = formatRunStatus(mine, evidence);
  const sweep = await execStatus(registry, { probe: nativeTerminalProbe });

  assert.match(detail, /recovery: the worker is gone, so nothing is running/);
  assert.match(sweep, /abandoned — no worker is running/);
  assert.match(sweep, new RegExp(`Next: /exec resume ${mine.id}`));
  assert.equal(
    isActionAllowed("resume", mine),
    true,
    "the sweep must not print a next command its own gate refuses",
  );
  assert.equal(
    (await reconcileForResume(registry, mine, nativeTerminalProbe)).run.status,
    "running",
    "the gate must preserve the retired operation for result reconciliation",
  );
});

/** Every one names a wait, and every wait needs something still running. */
const PREEMPTING_SHAPES: Array<[string, Partial<PlanExecRun>]> = [
  [
    "the provider stopped answering",
    {
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        externalRunId: "external-1",
        asyncDir: MISSING_ASYNC_DIR,
        statusFailures: 2,
        lastStatusError: "bridge status failed: ENOENT",
      },
    },
  ],
  [
    "the worker's name was never learned",
    {
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        asyncDir: MISSING_ASYNC_DIR,
      },
    },
  ],
  [
    "a stage was waived",
    {
      status: "skip_pending",
      stage: "comprehensive_review",
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "review",
        externalRunId: "external-1",
        reviewIteration: 1,
        asyncDir: MISSING_ASYNC_DIR,
      },
      pendingStageSkip: {
        stage: "comprehensive_review",
        reason: "waived",
        requestedAt: Date.now() - 6 * 60_000,
        requestedBy: "operator",
      },
    },
  ],
  ["a stop was requested", { status: "cancel_pending" }],
];

test("decisive evidence outranks every claim that would say wait", async () => {
  for (const [label, overrides] of PREEMPTING_SHAPES) {
    const gone = abandonedRun(overrides);
    const registry = await seedRegistry([gone]);
    const evidence = await runEvidence(gone, durableTerminalProbe);
    const guidance = recoveryGuidance(gone, evidence);
    const sweep = await execStatus(registry, { probe: durableTerminalProbe });
    // The command the sweep prints for this row; the detail view must match it.
    const next =
      gone.status === "cancel_pending"
        ? `/exec stop ${gone.id}`
        : `/exec resume ${gone.id}`;

    assert.match(guidance.classification, gone.activeOperation?.externalRunId ? /^the worker is gone/ : /pending launch can be checked/, label);
    assert.doesNotMatch(
      guidance.action,
      /Do not resume|Do not start another|moves on by itself|until it reads cancelled|polling picks up/,
      `${label}: guidance still tells the reader to wait for a dead worker`,
    );
    assert.ok(guidance.action.includes(next), `${label}: names ${next}`);
    assert.match(sweep, new RegExp(`Next: ${next.replace("/", "\\/")}`), label);
    // Including for the session named on the dead lease.
    assert.equal(
      isActionAllowed(
        gone.status === "cancel_pending" ? "stop" : "resume",
        gone,
      ),
      true,
      `${label}: the sweep prints a next command its own gate refuses`,
    );
  }
});

test("a live lease keeps every one of those claims exactly as it was", async () => {
  const waits = [
    /cannot check on the worker right now/,
    /cannot check on the worker right now/,
    /waiting for the stage you waived to stop/,
    /waiting for the stop you asked for/,
  ];
  for (const [index, [label, overrides]] of PREEMPTING_SHAPES.entries()) {
    const held = abandonedRun({
      ...overrides,
      ...(label === "a stage was waived"
        ? { config: { ...config, reviewRequired: false } }
        : {}),
      lease: liveLease(),
    });
    const guidance = recoveryGuidance(
      held,
      await runEvidence(held, abandonmentProbe()),
    );
    assert.match(guidance.classification, waits[index]!, label);
  }
});

test("nothing claims a poll loop that no live lease was observed for", async () => {
  const stalled = abandonedRun({
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir: MISSING_ASYNC_DIR,
      statusFailures: 2,
      lastStatusError: "bridge status failed: ENOENT",
    },
  });
  const dead = formatRunStatus(
    stalled,
    await runEvidence(stalled, abandonmentProbe()),
  );

  // The count is a stored fact and stays; "retrying" does not.
  assert.match(
    dead,
    /observation: unavailable \(2 failed probes\) — bridge status failed/,
  );
  assert.doesNotMatch(dead, /retrying/);
  assert.doesNotMatch(dead, /polling continues/);

  const held = { ...stalled, lease: liveLease() };
  assert.match(
    formatRunStatus(held, await runEvidence(held, abandonmentProbe())),
    /observation: unavailable \(2 failed probes\); retrying/,
  );
  const polling = abandonedRun({ lease: liveLease() });
  assert.match(
    formatRunStatus(polling, await runEvidence(polling, abandonmentProbe())),
    /observation: polling continues/,
  );
  assert.doesNotMatch(formatRunStatus(polling), /polling continues/);
});

test("the abandoned group promises a reset only where one happens", async () => {
  const stopping = abandonedRun({
    id: "22222222-2222-4222-8222-222222222222",
    status: "cancel_pending",
  });
  const resettable = abandonedRun();
  const footer =
    /Each retains its operation and saved result for reconciliation; no replacement worker is launched\./;

  // reconcileRun refuses a run already told to stop.
  const onlyStopping = await execStatus(await seedRegistry([stopping]), {
    probe: nativeTerminalProbe,
  });
  assert.match(onlyStopping, /abandoned — no worker is running/);
  assert.doesNotMatch(onlyStopping, /Each resets/);

  assert.match(
    await execStatus(await seedRegistry([resettable]), {
      probe: nativeTerminalProbe,
    }),
    footer,
  );

  const mixed = await execStatus(
    await seedRegistry([stopping, resettable]),
    { probe: nativeTerminalProbe },
  );
  assert.match(
    mixed,
    /except the ones already told to stop, which keep that request/,
  );
});

test("the sweep reports how far past its budget a run has gone", async () => {
  const overdue = abandonedRun({
    lease: liveLease(),
    config: {
      ...config,
      executionLifetime: { mode: "bounded", timeoutMs: 100 * 60_000 },
    },
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      launchStartedAt: Date.now() - 180 * 60_000,
      expectedLifetime: { mode: "bounded", timeoutMs: 100 * 60_000 },
    },
  });
  const registry = await seedRegistry([overdue]);

  const report = await execStatus(registry);

  assert.match(report, /past the explicit 100m compatibility deadline/);
});

test("widget shows a grown active compatibility budget rather than the frozen base", () => {
  const active = run({ config: { ...config, executionLifetime: { mode: "bounded", timeoutMs: 60_000 } },
    activeOperation: { operationId: "grown", service: "bridge", kind: "implementation", taskId: 1,
      expectedLifetime: { mode: "bounded", timeoutMs: 240_000 }, effectiveLifetime: { mode: "bounded", timeoutMs: 240_000 } },
    tasks: { "1": { taskId: 1, dependsOn: [], state: "running", attempts: 3 } },
  });
  const widget = formatRunWidget(active).join("\n");
  assert.match(widget, /deadline 4m compatibility mode/);
  assert.match(widget, /Lifetime: 4m compatibility mode/);
  assert.doesNotMatch(widget, /1m compatibility mode/);
});

test("a run on another host stays live until its owner releases it", async () => {
  const remote = abandonedRun({
    lease: { ...DEAD_LEASE, hostname: "another-host" },
  });
  const { registry } = await seedDirectory([remote]);
  const asked: string[] = [];
  const probe = abandonmentProbe(async (operationId) => {
    asked.push(operationId);
    return "absent";
  });

  // The probe gathers nothing: an absence measured on this machine's disk would
  // be an absence of the wrong thing.
  assert.deepEqual(await probe(remote), {});
  const report = await execReconcile(registry, probe);

  assert.match(report, /No run is provably abandoned, so nothing was reset\./);
  assert.match(
    report,
    /lease names another-host, not this machine/,
    "the doctor report names the blocker rather than an unexplained unknown",
  );
  assert.equal((await registry.get(remote.id))?.status, "running");
  assert.deepEqual(asked, [], "no local bridge lookup for a remote worker");
  const kept = await reconcileForResume(registry, remote, probe);
  assert.equal(kept.run.status, "running");
  assert.equal(kept.note, undefined);
});

test("a renamed machine keeps the remote lease protected and explains the assertion", async () => {
  // A DHCP rename: the lease names something no probe can connect back here.
  const renamed = abandonedRun({
    lease: { ...DEAD_LEASE, hostname: `${thisHost()}-corp-dhcp` },
  });
  const { registry, directory } = await seedDirectory([renamed]);
  const before = await snapshotRuns(directory);

  const guidance = recoveryGuidance(renamed, await runEvidence(renamed));

  assert.match(guidance.classification, /cannot be observed here/);
  assert.match(guidance.action, /--same-machine/);
  const status = formatRunStatus(renamed, await runEvidence(renamed));
  assert.match(status, /--same-machine/);
  assert.doesNotMatch(status, /polling continues|controller is polling|; retrying|holds a live lease/);
  const stillOwned = await reconcileForResume(registry, renamed);
  assert.equal(stillOwned.run.status, "running");
  assert.equal(stillOwned.note, undefined);
  assert.deepEqual(
    await snapshotRuns(directory),
    before,
    "a refused resume writes nothing",
  );

  const stillOwnedAfterOverride = await reconcileForResume(
    registry,
    renamed,
    nativeTerminalProbe,
    true,
  );

  assert.equal(stillOwnedAfterOverride.run.status, "running");
  assert.equal(stillOwnedAfterOverride.run.activeOperation?.operationId, renamed.activeOperation?.operationId);
  assert.match(stillOwnedAfterOverride.note ?? "", /existing operation and candidate were preserved/);
  assert.equal(
    (await registry.get(renamed.id))?.lease?.hostname,
    hostname(),
    "the proven local handoff rebinds the lease host before the next claim",
  );
  const claimed = await registry.claim(
    (await registry.get(renamed.id))!,
    "session-after-same-machine-proof",
  );
  assert.equal(claimed.lease?.sessionId, "session-after-same-machine-proof");
});

test("a machine that shares this one's first label keeps its live worker", async () => {
  // Precondition: a registry on a shared or NFS home, where corporate DNS gives
  // two machines the same first label and the other one is alive and beating.
  const collided = abandonedRun({
    lease: {
      sessionId: "session-on-the-other-machine",
      pid: process.pid,
      heartbeatAt: Date.now(),
      hostname: `${thisHost()}.b.corp.example`,
    },
  });
  const { registry, directory } = await seedDirectory([collided]);
  const before = await snapshotRuns(directory);
  const asked: string[] = [];
  const probe = abandonmentProbe(async (operationId) => {
    asked.push(operationId);
    return "absent";
  });

  assert.deepEqual(
    await runEvidence(collided, probe),
    { leaseLive: true },
    "a fresh remote heartbeat is not for a local pid lookup to contradict",
  );
  assert.deepEqual(
    await probe(collided),
    {},
    "and nothing here measures that machine's disk",
  );
  assert.deepEqual(asked, []);

  const kept = await reconcileForResume(registry, collided, probe);

  assert.equal(kept.run.status, "running");
  assert.equal(kept.note, undefined, "no reset, so nothing to report");
  assert.deepEqual(
    await snapshotRuns(directory),
    before,
    "a live remote worker keeps the worktree it is writing to",
  );
});

test("a stale lease from a colliding name stays live, never abandoned", async () => {
  const collided = abandonedRun({
    lease: { ...DEAD_LEASE, hostname: `${thisHost()}.b.corp.example` },
  });
  const { registry, directory } = await seedDirectory([collided]);
  const before = await snapshotRuns(directory);

  // A silent heartbeat proves nothing about a remote worker. The remote lease
  // remains live until its owner releases it or supplies a durable handoff.
  const kept = await reconcileForResume(registry, collided);
  assert.equal(kept.run.status, "running");
  assert.equal(kept.note, undefined);
  assert.deepEqual(await snapshotRuns(directory), before);
});

test("a network rename cannot override a live remote lease", async () => {
  const churned = abandonedRun({
    lease: { ...DEAD_LEASE, hostname: `${thisHost()}.lan` },
  });
  const { registry, directory } = await seedDirectory([churned]);
  const before = await snapshotRuns(directory);

  // Indistinguishable by name from the colliding machine above, so ordinary
  // reconciliation remains protected by the remote lease.
  const kept = await reconcileForResume(registry, churned);
  assert.equal(kept.run.status, "running");
  assert.equal(kept.note, undefined);
  assert.deepEqual(await snapshotRuns(directory), before);
  assert.equal(sameMachineRefusal(churned), undefined);

  const stillOwned = await reconcileForResume(
    registry,
    churned,
    nativeTerminalProbe,
    true,
  );

  assert.equal(stillOwned.run.status, "running");
  assert.equal(stillOwned.run.activeOperation?.operationId, churned.activeOperation?.operationId);
});

test("--same-machine supplies a machine, never a verdict", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-async-alive-"));
  const foreignLease = { ...DEAD_LEASE, hostname: `${thisHost()}-corp-dhcp` };
  const stillWriting = abandonedRun({
    lease: foreignLease,
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
      asyncDir,
    },
  });
  const { registry, directory } = await seedDirectory([stillWriting]);
  const before = await snapshotRuns(directory);

  // The assertion only changes where evidence may be gathered; a live child
  // or unknown child remains a hard stop.
  await assert.rejects(
    reconcileForResume(registry, stillWriting, abandonmentProbe(), true),
    /evidence is incomplete/,
  );
  assert.deepEqual(await snapshotRuns(directory), before);

  // The other half of the conjunction: a bridge that still knows the operation.
  const bridgeKnowsIt = abandonedRun({
    lease: foreignLease,
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      externalRunId: "external-1",
    },
  });
  const seeded = await seedDirectory([bridgeKnowsIt]);

  await assert.rejects(
    reconcileForResume(
      seeded.registry,
      bridgeKnowsIt,
      abandonmentProbe(async () => "running"),
      true,
    ),
    /evidence is incomplete/,
  );
  assert.equal(
    (await seeded.registry.get(bridgeKnowsIt.id))?.status,
    "running",
  );
  assert.match(
    sameMachineRefusal(abandonedRun()) ?? "",
    /only applies to a run whose lease names another host/,
  );
  assert.equal(sameMachineRefusal(abandonedRun({ lease: foreignLease })), undefined);
});

test("same-machine rebinds settled and between-step leases without discarding ownership or stop state", async () => {
  for (const status of ["running", "starting", "failed", "paused", "cancel_pending"] as const) {
    const held = run({ status, lease: { ...DEAD_LEASE, hostname: "former-host" },
      userStopped: status === "paused" || status === "cancel_pending",
      stopGeneration: 4, localOperationActive: true });
    delete held.activeOperation;
    const registry = await seedRegistry([held]);
    const recovered = await reconcileForResume(registry, held, undefined, true);
    assert.equal(recovered.run.lease?.hostname, hostname());
    assert.equal(recovered.run.status, held.status);
    assert.equal(recovered.run.userStopped, held.userStopped);
    assert.equal(recovered.run.stopGeneration, 4);
    assert.equal(recovered.run.localOperationActive, true);
    const claimed = await registry.claim(recovered.run, "new-session");
    assert.equal(claimed.lease?.sessionId, "new-session");
    assert.equal(claimed.localOperationActive, true);
    assert.match(recoveryGuidance(held).command, /--same-machine/);
  }
});

test("same-machine preserves a settled tracked operation and requires proof for unknown workers", async () => {
  for (const status of ["failed", "paused", "cancel_pending"] as const) {
    const held = abandonedRun({ status, lease: { ...DEAD_LEASE, hostname: "former-host" },
      userStopped: true, stopGeneration: 2 });
    const { registry, directory } = await seedDirectory([held]);
    const before = await snapshotRuns(directory);
    await assert.rejects(reconcileForResume(registry, held, abandonmentProbe(), true), /evidence is incomplete/);
    assert.deepEqual(await snapshotRuns(directory), before);
    const recovered = await reconcileForResume(registry, held, nativeTerminalProbe, true);
    assert.equal(recovered.run.status, status);
    assert.equal(recovered.run.lease?.hostname, hostname());
    assert.deepEqual(recovered.run.activeOperation, held.activeOperation);
    assert.equal(recovered.run.userStopped, true);
    assert.equal(recovered.run.stopGeneration, 2);
  }
});

test("same-machine never steals an actual live local PID under a foreign hostname", async () => {
  for (const status of ["running", "failed", "paused", "cancel_pending"] as const) {
    for (const tracked of [true, false]) {
      const held = abandonedRun({ status, lease: { ...DEAD_LEASE, hostname: "former-host", pid: process.pid } });
      if (!tracked) delete held.activeOperation;
      const { registry, directory } = await seedDirectory([held]);
      const before = await snapshotRuns(directory);
      const recovered = await reconcileForResume(registry, held, async () => {
        assert.fail("A live local controller must fence evidence gathering.");
      }, true);
      assert.equal(recovered.run, held);
      assert.deepEqual(await snapshotRuns(directory), before);
      await assert.rejects(registry.claim(recovered.run, "replacement-session"), /controlled by another active Pi session/);
    }
  }
});

test("same-machine cannot overwrite a stop recorded while checking a settled run", async () => {
  const held = abandonedRun({ status: "failed", lease: { ...DEAD_LEASE, hostname: "former-host" } });
  const registry = await seedRegistry([held]);
  await assert.rejects(reconcileForResume(registry, held, async (subject) => {
    await registry.update({ ...held, status: "cancel_pending", userStopped: true, stopGeneration: 1 });
    return nativeTerminalProbe(subject);
  }, true), /changed while its asserted host was being recorded/);
  const current = await registry.get(held.id);
  assert.equal(current?.lease?.hostname, "former-host");
  assert.equal(current?.status, "cancel_pending");
  assert.equal(current?.userStopped, true);
  assert.equal(current?.stopGeneration, 1);
});

test("a saved session waits for durable Git lane creation and recovers creation failures automatically", async (t) => {
  const initialCwd = process.cwd();
  const root = await realpath(await mkdtemp(join(tmpdir(), "exec-saved-session-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const command = async (program: string, args: string[], cwd: string) => {
    const result = spawnSync(program, args, { cwd, encoding: "utf8" });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
  };
  for (const args of [["init", "-b", "main"], ["-c", "user.name=Test", "-c", "user.email=test@example.org",
    "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "initial"]]) {
    const result = await command("git", args, source);
    assert.equal(result.code, 0, result.stderr);
  }
  await writeFile(join(source, "plan.md"), "### Task 1: Implement\n- [ ] Do the work\n");
  const sourceSession = persistedSession(source, join(root, "sessions", "source"));
  const sourceSessionFile = sourceSession.getSessionFile();
  assert.ok(sourceSessionFile);
  await access(sourceSessionFile);
  const targetSessionDirectory = join(root, "sessions", "target");
  const registry = new RunRegistry(join(root, "runs"));
  const unavailable = async (): Promise<never> => { throw new Error("No worker should start before handoff."); };
  let releaseCreation!: () => void;
  const creationBarrier = new Promise<void>((resolve) => { releaseCreation = resolve; });
  let attempted = 0;
  const localExecutor = createControllerLocalExecutor();
  const creationOperations = new Set<string>();
  const createdPaths = new Set<string>();
  t.after(() => Promise.all([...createdPaths].map((path) => rm(path, { recursive: true, force: true }))));
  const controller = new PlanExecController(registry,
    { spawn: unavailable, operation: unavailable, status: unavailable, result: unavailable, adopt: unavailable, stop: unavailable },
    { start: unavailable, status: unavailable, result: unavailable, adopt: unavailable, cancel: unavailable }, command,
    async (cwd, commands, options) => {
      assert.equal(await options.isAuthorized(), true);
      if (options.operationId.startsWith("git:worktree:") && !creationOperations.has(options.operationId)) {
        creationOperations.add(options.operationId);
        createdPaths.add(options.operationId.slice("git:worktree:".length));
        attempted++;
        if (attempted === 1) {
          await creationBarrier;
          throw new LocalOperationFailedError("temporary checkout failure");
        }
      }
      await localExecutor(cwd, commands, options);
    });
  const ctx = { cwd: source, hasUI: true,
    ui: { select: async () => "Worktree (isolated)" },
    sessionManager: sourceSession,
  } as unknown as ExtensionCommandContext;
  let started: PlanExecRun | undefined;
  let afterTick: ((run: PlanExecRun) => Promise<boolean>) | undefined;
  let forks = 0;
  const response = await handleCommand("plan.md", ctx, {
    controller,
    startBackgroundController: (run, _sessionId, _cwd, _ctx, handoff) => { started = run; afterTick = handoff; },
    syncProjection: async (run) => run,
    checkRuntime: async () => undefined,
    runtimeProblems: async () => [],
    doctorProbe: async () => ({}),
    handoff: async (_ctx, run) => {
      await access(run.worktreeCwd);
      assert.equal(run.lanePreparation?.state, "bootstrap");
      assert.equal(_ctx.sessionManager.getSessionFile(), sourceSessionFile);
      const targetSession = SessionManager.forkFrom(sourceSessionFile, run.worktreeCwd, targetSessionDirectory);
      assert.equal(targetSession.getCwd(), run.worktreeCwd);
      assert.equal(targetSession.getSessionDir(), targetSessionDirectory);
      assert.notEqual(targetSession.getSessionId(), sourceSession.getSessionId());
      assert.equal(targetSession.getHeader()?.parentSession, sourceSessionFile);
      assert.deepEqual(targetSession.getEntries(), sourceSession.getEntries());
      const targetSessionFile = targetSession.getSessionFile();
      assert.ok(targetSessionFile);
      await access(targetSessionFile);
      assert.equal(process.cwd(), initialCwd);
      forks++;
      return true;
    },
  });
  assert.match(response ?? "", /started/);
  assert.ok(started);
  assert.ok(afterTick);
  assert.equal(forks, 0);
  await assert.rejects(access(started.worktreeCwd));
  assert.equal(await afterTick(started), false);
  await mkdir(started.worktreeCwd, { recursive: true });
  await writeFile(join(started.worktreeCwd, "unowned.txt"), "keep this directory");
  assert.equal(await afterTick(started), false);
  const firstTick = controller.tick(started.id, sourceSession.getSessionId());
  releaseCreation();
  let current = await firstTick;
  assert.equal(current.lanePreparation?.state, "create");
  assert.equal(await afterTick(current), false);
  current = await registry.update({ ...current, nextAttemptAt: 0 });
  for (let tick = 0; tick < 5 && current.lanePreparation?.state === "create"; tick++) {
    assert.equal(await afterTick(current), false);
    current = await controller.tick(current.id, sourceSession.getSessionId());
  }
  assert.equal(current.lanePreparation?.state, "bootstrap", current.error ?? current.wakeReason ?? "The lane must finish creation.");
  assert.equal(await afterTick({ ...current, status: "paused", userStopped: true }), false);
  assert.equal(await afterTick({ ...current, status: "cancel_pending", userStopped: true }), false);
  assert.equal(await afterTick(current), true);
  assert.equal(forks, 1);
  assert.equal(attempted, 2);
  assert.equal(await readFile(join(started.worktreeCwd, "unowned.txt"), "utf8"), "keep this directory");
  assert.equal((await readdir(targetSessionDirectory)).length, 1);
  assert.equal(process.cwd(), initialCwd);
});

test("a live lease is decisive on its own and nothing else is probed", async () => {
  const held = abandonedRun({ lease: liveLease() });
  const registry = await seedRegistry([held]);
  let probed = 0;
  const probe: EvidenceProbe = async () => {
    probed += 1;
    return { asyncDirPresent: false };
  };

  const sweep = await sweepAbandonment(registry, probe);

  assert.equal(sweep.diagnoses[0]?.classification, "live");
  assert.equal(probed, 0, "a live lease short-circuits the probe");
  assert.deepEqual(await runEvidence(held, probe), { leaseLive: true });
});

test("explicit pause from an unrelated session polls a dead owner's worker until owned exit", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "exec-unrelated-pause-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new RunRegistry(join(root, "runs"));
  const held = await registry.create(run({
    repositoryRoot: join(root, "original"), worktreeCwd: join(root, "original"),
    planPath: join(root, "original", "plan.md"), progressPath: join(root, "original", "progress.txt"),
    lease: DEAD_LEASE,
    activeOperation: { operationId: "owned-operation", externalRunId: "owned-worker", requestDigest: "owned-digest",
      service: "bridge", kind: "implementation", taskId: 1,
      expectedLifetime: { mode: "unbounded" }, effectiveLifetime: { mode: "unbounded" } },
  }));
  t.mock.method(RunRegistry.prototype, "get", registry.get.bind(registry));
  t.mock.method(RunRegistry.prototype, "claim", registry.claim.bind(registry));
  t.mock.method(RunRegistry.prototype, "updateIfCurrent", registry.updateIfCurrent.bind(registry));
  const binding = { operationId: "kernel-operation", requestDigest: "kernel-digest",
    hostId: "00000000-0000-0000-0000-000000000001", bootId: "00000000-0000-0000-0000-000000000002" };
  const identity = { ...binding, version: 1, backend: "darwin-resource-coalition-v1", coalitionId: "2001",
    leader: { pid: 4242, uniqueId: "1001", pidVersion: 1 } };
  const proof = { version: 1, state: "observed", runId: "owned-worker", runnerProcessInstanceId: "fixture", observedAt: Date.now(),
    processTreeOwnership: OWNED_PROCESS_TREE,
    callerBinding: { operationId: "owned-operation", requestDigest: "owned-digest" },
    nativeOperation: { operationId: "native-operation", digest: "native-digest" }, kernelBinding: binding,
    kernelProof: { status: "retired", operationDirectory: join(root, "operation"), binding, identity,
      proof: { ...binding, kind: "darwin-coalition-retired", identity, observedAt: new Date().toISOString() }, exitCode: 0, signal: null } };
  let stopCalls = 0;
  const unavailable = async (): Promise<never> => { throw new Error("Pause must not dispatch implementation or consume a result."); };
  const bridge = {
    spawn: unavailable, result: unavailable, adopt: unavailable, status: unavailable,
    operation: async () => ({ success: true as const, data: { runId: "owned-worker", requestDigest: "owned-digest",
      state: "found", status: stopCalls ? "stopped" : "running", ...(stopCalls ? { processTerminalProof: proof } : {}) } }),
    stop: async (runId: string) => {
      assert.equal(runId, "owned-worker");
      stopCalls++;
      return { success: true as const, data: { state: "stopping" } };
    },
  };
  const controller = new PlanExecController(registry, bridge,
    { start: unavailable, status: unavailable, result: unavailable, adopt: unavailable, cancel: unavailable }, unavailable);
  assert.equal((await bridge.operation()).data.status, "running");
  const cwd = join(root, "unrelated");
  await mkdir(cwd);
  const sessionId = "new-unrelated-session";
  const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionCommandContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  t.after(() => { if (timer) clearInterval(timer); });
  let finish!: (run: PlanExecRun) => void;
  let fail!: (error: unknown) => void;
  const exited = new Promise<PlanExecRun>((resolve, reject) => { finish = resolve; fail = reject; });
  const response = await handleCommand(`pause ${held.id}`, ctx, {
    controller, syncProjection: async (run) => run, checkRuntime: async () => undefined,
    runtimeProblems: async () => [], doctorProbe: async () => ({}),
    startBackgroundController: (paused, owner, controllerCwd) => {
      assert.equal(paused.status, "paused");
      assert.equal(paused.userStopped, true);
      assert.equal(paused.lease?.sessionId, sessionId);
      assert.equal(owner, sessionId);
      assert.equal(controllerCwd, cwd);
      let ticking = false;
      timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        void controller.tick(paused.id, owner).then((current) => {
          if (shouldStopBackgroundController(current)) {
            clearInterval(timer);
            finish(current);
          }
        }).catch(fail).finally(() => { ticking = false; });
      }, 5);
    },
  });
  assert.match(response ?? "", /paused; its current attempt is stopping/);
  assert.ok(timer, "Pause must attach a controller before returning, even outside the run's repository.");
  const current = await exited;
  assert.equal(stopCalls, 1);
  assert.equal(current.status, "paused");
  assert.equal(current.userStopped, true);
  assert.equal(current.stopGeneration, 1);
  assert.equal(current.activeOperation?.operationId, "owned-operation");
  assert.equal(current.activeOperation?.processTreeExited, true);
  assert.deepEqual(current.taskAttempts, held.taskAttempts);
});

for (const phase of ["before-create", "published", "claimed-failure"] as const) {
  test(`pending start retires its late allocation at ${phase} across session replacement`, { timeout: 10_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "exec-pending-start-")));
    const registry = new RunRegistry(join(root, "runs"));
    const source = join(root, "repository");
    await mkdir(source);
    for (const args of [["init", "-b", "main"], ["-c", "user.name=Test", "-c", "user.email=test@example.org",
      "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "initial"],
      ["checkout", "-b", "feature"]]) {
      const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    await writeFile(join(source, "plan.md"), "### Task 1: Implement\n- [ ] Do the work\n");
    const sessionA = "pending-start-source";
    const sessionB = phase === "published" ? sessionA : "pending-start-replacement";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const checkpoint = new Promise<void>((resolve) => { reached = resolve; });
    const create = registry.create.bind(registry);
    t.mock.method(RunRegistry.prototype, "create", async (candidate: Parameters<RunRegistry["create"]>[0], options?: Parameters<RunRegistry["create"]>[1]) => {
      if (phase === "before-create") { reached(); await gate; }
      return create(candidate, options);
    });
    if (phase === "published") {
      const writer = registry as unknown as { write(run: PlanExecRun): Promise<void> };
      const write = writer.write.bind(registry);
      t.mock.method(writer, "write", async (candidate: PlanExecRun) => { await write(candidate); reached(); await gate; });
    }
    t.mock.method(RunRegistry.prototype, "get", registry.get.bind(registry));
    t.mock.method(RunRegistry.prototype, "listWithErrors", registry.listWithErrors.bind(registry));
    t.mock.method(RunRegistry.prototype, "withControllerLock", registry.withControllerLock.bind(registry));
    const claim = registry.claim.bind(registry);
    let failedClaim = false;
    t.mock.method(RunRegistry.prototype, "claim", async (candidate: PlanExecRun, owner: string) => {
      const claimed = await claim(candidate, owner);
      if (phase === "claimed-failure" && owner === sessionA && !failedClaim) {
        failedClaim = true;
        reached();
        await gate;
        throw new Error("Start failed after durable allocation and claim.");
      }
      return claimed;
    });
    const update = registry.updateIfCurrent.bind(registry);
    let failedRetirement = false;
    t.mock.method(RunRegistry.prototype, "updateIfCurrent", async (candidate: PlanExecRun, revision: number, preserveRevision?: boolean) => {
      if (!candidate.lease && !failedRetirement && phase === "before-create") {
        failedRetirement = true;
        throw new Error("Transient retirement write failure.");
      }
      return update(candidate, revision, preserveRevision);
    });
    t.mock.method(TaskProjector.prototype, "sync", async (current: PlanExecRun) => current);
    const tick = PlanExecController.prototype.tick;
    const owners: string[] = [];
    t.mock.method(PlanExecController.prototype, "tick", async function (this: PlanExecController, runId: string, owner: string) {
      owners.push(owner);
      assert.equal(owner, sessionB);
      if (phase === "claimed-failure") return tick.call(this, runId, owner);
      return registry.claim((await registry.get(runId))!, owner);
    });
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const first = executionHarness(source, sessionA);
    const start = first.command("plan.md");
    await Promise.race([checkpoint, start.then(() => assert.fail(first.notifications.join("\n") || "Start returned before its fault checkpoint."))]);
    const closing = first.emit("session_shutdown", { reason: phase === "published" ? "reload" : "new" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_500);
    await closing;
    const notificationsBefore = first.notifications.length;
    const second = executionHarness(phase === "claimed-failure" ? join(root, "unrelated") : source, sessionB);
    t.after(async () => { release(); await start; await second.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); });
    await second.emit("session_start");
    t.mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(owners, []);
    if (phase !== "before-create") {
      const current = (await registry.list())[0]!;
      await second.command(`${phase === "published" ? "pause" : "cancel"} ${current.id}`);
      assert.equal((await registry.get(current.id))?.userStopped, true);
    }
    release();
    await start;
    const deadline = Date.now() + 2_000;
    let current: PlanExecRun | undefined;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1_000);
      current = (await registry.list())[0];
      if (phase === "published" ? current?.status === "paused" && !current.lease
        : phase === "claimed-failure" ? current?.status === "cancelled" && !current.lease : current?.lease?.sessionId === sessionB) break;
    }
    assert.ok(current);
    assert.equal(first.notifications.length, notificationsBefore);
    if (phase === "published") {
      assert.equal(current.status, "paused");
      assert.equal(current.userStopped, true);
      assert.equal(current.lease, undefined);
      assert.deepEqual(owners, []);
    } else if (phase === "claimed-failure") {
      assert.equal(current.status, "cancelled");
      assert.equal(current.userStopped, true);
      assert.equal(current.lease, undefined);
      assert.ok(owners.length > 0);
    } else {
      assert.equal(failedRetirement, true);
      assert.equal(current.lease?.sessionId, sessionB);
      assert.ok(owners.length > 0);
    }
  });
}

test("a queued resume from another directory cannot override a replacement session's pause", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "exec-queued-resume-"));
  const registry = new RunRegistry(join(root, "runs"));
  const planPath = join(root, "plan.md");
  await writeFile(planPath, "### Task 1: Implement\n- [ ] Do the work\n");
  const initial = run({ repositoryRoot: root, worktreeCwd: root, planPath, stage: "resolve",
    lease: { ...liveLease(), sessionId: "resume-source" } });
  delete initial.activeOperation;
  const held = await registry.create(initial);
  t.mock.method(RunRegistry.prototype, "get", registry.get.bind(registry));
  t.mock.method(RunRegistry.prototype, "listWithErrors", registry.listWithErrors.bind(registry));
  t.mock.method(RunRegistry.prototype, "claim", registry.claim.bind(registry));
  t.mock.method(RunRegistry.prototype, "updateIfCurrent", registry.updateIfCurrent.bind(registry));
  t.mock.method(TaskProjector.prototype, "sync", async (current: PlanExecRun) => current);
  let release!: () => void;
  const lockBlocked = new Promise<void>((resolve) => { release = resolve; });
  let waiting!: () => void;
  const lockRequested = new Promise<void>((resolve) => { waiting = resolve; });
  const withLock = registry.withControllerLock.bind(registry);
  t.mock.method(RunRegistry.prototype, "withControllerLock", async <T>(runId: string, callback: () => Promise<T>) => {
    waiting();
    await lockBlocked;
    return withLock(runId, callback);
  });
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const first = executionHarness(join(root, "unrelated"), "resume-source");
  const pending = first.command(`resume ${held.id}`);
  await lockRequested;
  const closing = first.emit("session_shutdown");
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_500);
  await closing;
  const second = executionHarness(root, "resume-replacement");
  await second.emit("session_start");
  await second.command(`pause ${held.id}`);
  assert.equal((await registry.get(held.id))?.userStopped, true);
  release();
  await pending;
  const deadline = Date.now() + 1_000;
  let current = await registry.get(held.id);
  while (current?.lease && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    current = await registry.get(held.id);
  }
  assert.equal(current?.status, "paused");
  assert.equal(current?.userStopped, true);
  assert.equal(current?.stopGeneration, 1);
  assert.equal(current?.lease, undefined);
  await second.emit("session_shutdown");
  await rm(root, { recursive: true, force: true });
});

test("a hanging stop dialog cannot delay retirement or mutate after session replacement", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "exec-pending-dialog-"));
  const registry = new RunRegistry(join(root, "runs"));
  const held = await registry.create(run({ repositoryRoot: root, worktreeCwd: root,
    lease: { ...liveLease(), sessionId: "dialog-source" } }));
  t.mock.method(RunRegistry.prototype, "get", registry.get.bind(registry));
  t.mock.method(RunRegistry.prototype, "listWithErrors", registry.listWithErrors.bind(registry));
  t.mock.method(RunRegistry.prototype, "updateIfCurrent", registry.updateIfCurrent.bind(registry));
  t.mock.method(RunRegistry.prototype, "claim", registry.claim.bind(registry));
  t.mock.method(TaskProjector.prototype, "sync", async (current: PlanExecRun) => current);
  const first = executionHarness(root, "dialog-source");
  let choose!: (label: string) => void;
  let shown!: () => void;
  const dialogShown = new Promise<void>((resolve) => { shown = resolve; });
  let pauseLabel = "";
  first.ctx.ui.select = async (_title, options) => { pauseLabel = options[0]!; shown(); return new Promise<string>((resolve) => { choose = resolve; }); };
  const command = first.command(`stop ${held.id}`);
  await dialogShown;
  await first.emit("session_shutdown");
  assert.equal((await registry.get(held.id))?.lease, undefined);
  const replacement = await registry.claim((await registry.get(held.id))!, "dialog-replacement");
  choose(pauseLabel);
  await command;
  const current = await registry.get(held.id);
  assert.equal(current?.status, "running");
  assert.equal(current?.userStopped, undefined);
  assert.deepEqual(current?.lease, replacement.lease);
  await rm(root, { recursive: true, force: true });
});

for (const interruption of ["shutdown", "new-owner", "own-switch"] as const) {
  test(`worktree handoff fences ${interruption} without waiting for projection or reclaiming another lease`, { timeout: 5_000 }, async (t) => {
    const initialCwd = process.cwd();
    const root = await mkdtemp(join(tmpdir(), "exec-handoff-retirement-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "worktree");
    await mkdir(target);
    const source = persistedSession(root, join(root, "sessions", "source"));
    const fork = SessionManager.forkFrom.bind(SessionManager);
    t.mock.method(SessionManager, "forkFrom", (file: string, cwd: string) => fork(file, cwd, join(root, "sessions", "target")));
    const registry = new RunRegistry(join(root, "runs"));
    const held = await registry.create(run({ repositoryRoot: root, worktreeCwd: target,
      planPath: join(target, "plan.md"), lease: { ...liveLease(), sessionId: source.getSessionId() } }));
    t.mock.method(RunRegistry.prototype, "get", registry.get.bind(registry));
    t.mock.method(RunRegistry.prototype, "updateIfCurrent", registry.updateIfCurrent.bind(registry));
    const claim = registry.claim.bind(registry);
    let targetClaimed!: () => void;
    const claimedTarget = new Promise<void>((resolve) => { targetClaimed = resolve; });
    let releaseClaim!: () => void;
    const pendingClaim = new Promise<void>((resolve) => { releaseClaim = resolve; });
    t.after(releaseClaim);
    t.mock.method(RunRegistry.prototype, "claim", async (candidate: PlanExecRun, sessionId: string) => {
      const claimed = await claim(candidate, sessionId);
      if (sessionId !== source.getSessionId()) { targetClaimed(); await pendingClaim; }
      return claimed;
    });
    t.mock.method(PlanExecController.prototype, "start", async () => held);
    t.mock.method(PlanExecController.prototype, "tick", async () => { assert.fail("The source must not restart after handoff shutdown."); });
    let projectionCalls = 0;
    let releaseProjection!: () => void;
    const projection = new Promise<void>((resolve) => { releaseProjection = resolve; });
    t.after(releaseProjection);
    t.mock.method(TaskProjector.prototype, "sync", async (current: PlanExecRun) => {
      projectionCalls++;
      await projection;
      return current;
    });
    type Handler = (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>;
    const events = new Map<string, Handler[]>();
    const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
    const errors: string[] = [];
    const pi = { events: { on() {}, emit() {} },
      on(name: string, handler: Handler) { events.set(name, [...events.get(name) ?? [], handler]); },
      registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) { commands.set(name, command); },
      registerTool() {}, getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
    } as unknown as ExtensionAPI;
    const shutdown = async (reason: string, targetSessionFile?: string) => {
      for (const handler of events.get("session_shutdown") ?? [])
        await handler({ type: "session_shutdown", reason, targetSessionFile }, ctx);
    };
    let switchCalls = 0;
    const ctx = { cwd: root, hasUI: true, sessionManager: source,
      ui: { select: async () => "Worktree (isolated)",
        notify(message: string, level: string) { if (level === "error") errors.push(message); },
        setStatus() {}, setWidget() {},
      },
      switchSession: async (sessionFile: string) => {
        switchCalls++;
        await shutdown("resume", sessionFile);
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    planExecExtension(pi);
    const command = commands.get("exec")!.handler("plan.md", ctx);
    await claimedTarget;
    const targetOwner = (await registry.get(held.id))?.lease;
    assert.ok(targetOwner);
    assert.notEqual(targetOwner.sessionId, source.getSessionId());
    if (interruption !== "own-switch") {
      const closing = shutdown("new");
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1_500);
      await closing;
    }
    if (interruption === "new-owner") {
      const current = (await registry.get(held.id))!;
      await registry.update({ ...current, lease: { ...liveLease(), sessionId: "replacement-owner" } });
    }
    releaseClaim();
    await command;
    const current = await registry.get(held.id);
    assert.equal(current?.lease?.sessionId, interruption === "shutdown" ? undefined
      : interruption === "new-owner" ? "replacement-owner" : targetOwner.sessionId);
    assert.equal(switchCalls, interruption === "own-switch" ? 1 : 0);
    assert.equal(projectionCalls, interruption === "own-switch" ? 1 : 0);
    assert.deepEqual(errors, []);
    assert.equal(process.cwd(), initialCwd);
  });
}

for (const reason of ["new", "reload"] as const) {
  test(`${reason} retires only its drained controller and restores the next extension instance`, { timeout: 10_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "exec-session-retirement-"));
    const registry = new RunRegistry(join(root, "runs"));
    const sessionA = "outgoing-session";
    const sessionB = reason === "reload" ? sessionA : "replacement-session";
    const held = await registry.create(run({ repositoryRoot: root, worktreeCwd: root,
      planPath: join(root, "plan.md"), lease: { ...liveLease(), sessionId: sessionA },
      activeOperation: { operationId: "preserved-operation", service: "bridge", kind: "implementation", externalRunId: "preserved-worker" } }));
    const other = await registry.create(run({ repositoryRoot: join(root, "other"), worktreeCwd: join(root, "other"),
      lease: { ...liveLease(), sessionId: "another-live-controller" } }));
    const lookup = registry.get.bind(registry);
    let restorationReadFailures = reason === "new" ? 2 : 1;
    t.mock.method(RunRegistry.prototype, "get", async (runId: string) => {
      const current = await lookup(runId);
      if (runId === held.id && current && !current.lease && restorationReadFailures > 0) {
        restorationReadFailures--;
        throw new Error("Temporary restoration read failure.");
      }
      return current;
    });
    t.mock.method(RunRegistry.prototype, "listWithErrors", registry.listWithErrors.bind(registry));
    t.mock.method(RunRegistry.prototype, "claim", registry.claim.bind(registry));
    const update = registry.updateIfCurrent.bind(registry);
    let rejectRetirement = true;
    let retirementFailed!: () => void;
    const failedRetirement = new Promise<void>((resolve) => { retirementFailed = resolve; });
    t.mock.method(RunRegistry.prototype, "updateIfCurrent", async (candidate: PlanExecRun, revision: number, preserveRevision?: boolean) => {
      if (candidate.id === held.id && !candidate.lease && rejectRetirement) {
        rejectRetirement = false;
        retirementFailed();
        throw new Error("Temporary registry write failure.");
      }
      return update(candidate, revision, preserveRevision);
    });
    t.mock.method(TaskProjector.prototype, "sync", async (current: PlanExecRun) => current);
    let releaseTick!: () => void;
    const pendingTick = new Promise<void>((resolve) => { releaseTick = resolve; });
    let tickStarted!: () => void;
    const startedTick = new Promise<void>((resolve) => { tickStarted = resolve; });
    let replacementTicked!: () => void;
    const replacementTick = new Promise<void>((resolve) => { replacementTicked = resolve; });
    const ticks: string[] = [];
    let activeTicks = 0;
    t.mock.method(PlanExecController.prototype, "tick", async (runId: string, owner: string) => {
      assert.equal(activeTicks++, 0, "Session replacement must never overlap controller ticks.");
      try {
        const current = await registry.get(runId);
        assert.ok(current);
        const claimed = await registry.claim(current, owner);
        ticks.push(owner);
        if (ticks.length === 1) {
          tickStarted();
          await pendingTick;
          return (await update({ ...claimed, wakeReason: "late outgoing observation" }, claimed.updatedAt)).run;
        }
        const next = reason === "new" && claimed.activeOperation
          ? (await update({ ...claimed, activeOperation: { ...claimed.activeOperation, processTreeExited: true } }, claimed.updatedAt)).run
          : claimed;
        replacementTicked();
        return next;
      } finally {
        activeTicks--;
      }
    });
    type Handler = (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>;
    const harness = (sessionId: string) => {
      const events = new Map<string, Handler[]>();
      const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
      let uiCalls = 0;
      const pi = { events: { on() {}, emit() {} },
        on(name: string, handler: Handler) { events.set(name, [...events.get(name) ?? [], handler]); },
        registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) { commands.set(name, command); },
        registerTool() {}, getAllTools() { return []; }, getActiveTools() { return []; }, setActiveTools() {},
      } as unknown as ExtensionAPI;
      const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => sessionId },
        ui: { setStatus() { uiCalls++; }, setWidget() { uiCalls++; }, notify() { uiCalls++; } },
      } as unknown as ExtensionCommandContext;
      planExecExtension(pi);
      return { commands, ctx, uiCalls: () => uiCalls,
        emit: async (name: string) => { for (const handler of events.get(name) ?? []) await handler({ type: name, reason }, ctx); } };
    };
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const first = harness(sessionA);
    const replacements: Array<ReturnType<typeof harness>> = [];
    t.after(async () => {
      releaseTick();
      for (const replacement of replacements) await replacement.emit("session_shutdown");
      await rm(root, { recursive: true, force: true });
    });
    await first.emit("session_start");
    t.mock.timers.tick(1_000);
    await startedTick;
    const shutdown = first.emit("session_shutdown");
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_500);
    await shutdown;
    const outgoingUICalls = first.uiCalls();
    assert.equal((await registry.get(held.id))?.lease?.sessionId, sessionA);
    assert.equal(activeTicks, 1);
    const second = harness(sessionB);
    replacements.push(second);
    await second.emit("session_start");
    t.mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(ticks, [sessionA]);
    if (reason === "new") {
      await second.commands.get("exec")!.handler(`pause ${held.id}`, second.ctx);
      const paused = await registry.get(held.id);
      assert.equal(paused?.userStopped, true);
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.stopGeneration, 1);
      assert.equal(paused?.lease?.sessionId, sessionA);
    }
    releaseTick();
    await failedRetirement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await registry.get(held.id))?.lease?.sessionId, sessionA);
    assert.deepEqual(ticks, [sessionA]);
    t.mock.timers.tick(1_000);
    const restorationDeadline = Date.now() + 2_000;
    while (ticks.length < 2 && Date.now() < restorationDeadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1_000);
    }
    assert.equal(ticks.length, 2, "The replacement must automatically restore after retirement succeeds.");
    await replacementTick;
    const recovered = await registry.get(held.id);
    assert.equal(recovered?.lease?.sessionId, sessionB);
    assert.equal(recovered?.activeOperation?.operationId, "preserved-operation");
    assert.equal(recovered?.status, reason === "new" ? "paused" : "running");
    if (reason === "new") assert.equal(recovered?.userStopped, true);
    assert.deepEqual(ticks, [sessionA, sessionB]);
    assert.equal(restorationReadFailures, 0);
    assert.equal(first.uiCalls(), outgoingUICalls);
    assert.deepEqual((await registry.get(other.id))?.lease, other.lease);
  });
}

test("cleanup reports every outcome instead of stopping at the first refusal", async () => {
  const first = retiredRun({ id: "33333333-3333-4333-8333-333333333333" });
  const second = retiredRun({ id: "44444444-4444-4444-8444-444444444444" });
  const { directory } = await seedDirectory([first, second]);
  // Stands in for the registry's own re-check under its lock, which can refuse
  // a target the listing snapshotted.
  class RefusingRegistry extends RunRegistry {
    override async remove(runId: string): Promise<boolean> {
      if (runId === second.id)
        throw new Error(`Run ${runId} is held by a live lease from session x.`);
      return super.remove(runId);
    }
  }
  const registry = new RefusingRegistry(directory);

  const report = await execCleanup(registry, ["--apply"]);

  assert.match(report, /Removed 1 plan execution run;/);
  assert.match(report, new RegExp(`^${first.id} `, "m"));
  assert.match(report, /Kept 1 run the registry refused:/);
  assert.match(report, new RegExp(`- ${second.id} [^\\n]*live lease`));
  assert.equal(await registry.get(first.id), undefined);
  assert.ok(await registry.get(second.id), "the refused run is still there");
});

test("cleanup does not offer --include-failed to a caller naming one run", async () => {
  const failed = retiredRun({
    id: "55555555-5555-4555-8555-555555555555",
    status: "failed",
    stage: "implementation",
    updatedAt: INSIDE_RETENTION,
  });
  const registry = await seedRegistry([failed]);

  const preview = await execCleanup(registry, [failed.id]);

  assert.match(preview, new RegExp(failed.id));
  assert.doesNotMatch(preview, /Failed runs are excluded/);
  assert.match(preview, /overrides both the retention window/);
  assert.match(
    preview,
    new RegExp(`/exec cleanup ${failed.id} --apply`),
    "the apply line repeats only what was actually used",
  );
});

test("retention is measured from when a run finished, not from its last write", () => {
  // A lease release writes the record after the run is over, so `updatedAt`
  // would restart the clock.
  assert.equal(
    isRemovableRun(
      retiredRun({ retiredAt: PAST_RETENTION, updatedAt: Date.now() }),
    ),
    true,
  );
  assert.equal(
    isRemovableRun(
      retiredRun({ retiredAt: Date.now(), updatedAt: PAST_RETENTION }),
    ),
    false,
  );
  assert.equal(
    isRemovableRun(retiredRun({ updatedAt: PAST_RETENTION })),
    true,
    "a record with no stamp falls back to its last write",
  );
});

test("the settled listing hides a terminal run the moment it is a day old", () => {
  const justInside = retiredRun({
    id: "33333333-3333-4333-8333-333333333333",
    updatedAt: Date.now() - 23 * HOUR_MS,
  });
  const justOutside = retiredRun({
    id: "44444444-4444-4444-8444-444444444444",
    updatedAt: Date.now() - 25 * HOUR_MS,
  });

  const lines = settledRunLines([justInside, justOutside]).join("\n");

  assert.ok(lines.includes(justInside.id), "23 hours old is still news");
  assert.ok(!lines.includes(justOutside.id), "25 hours old is not");
  assert.match(lines, /1 older terminal run hidden\./);
});
