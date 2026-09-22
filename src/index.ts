import { access, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, relative, resolve } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  BridgeClient,
  processTerminalProof,
  supportsOwnedProcessTree,
  parseExecutionLifetime,
  type BridgeCapabilities,
} from "./bridge.js";
import {
  isDetachedWorkflowFailure,
  isExternalManualBlocker,
  isModelProviderFailure,
  isTaskRetryConfirmationRequired,
  PLAN_STRUCTURE_CHANGED_ERROR,
  PlanExecController,
  TASK_RETRY_OPTION,
  taskRetryRequiredMessage,
} from "./controller.js";
import { FusionClient } from "./fusion.js";
import { isPathWithin } from "./git.js";
import { workspaceCommand } from "./workspace-environment.js";
import {
  ABANDONMENT,
  classifyAbandonment,
  isGoalRun,
  isInFlightStatus,
  isRecoverableRun,
  isReviewStage,
  isSkippableStage,
  isTerminalStatus,
  longRunningOperation,
  activeExecutionLifetime,
  requirePlanPath,
  type Abandonment,
  type AbandonmentEvidence,
  type ProcessTerminalProof,
} from "./lifecycle.js";
import {
  asLocalRun,
  isLeaseLive,
  isLocalRun,
  LEASE_STALE_MS,
  removalRefusal,
  RunRegistry,
  takeoverRefusal,
} from "./registry.js";
import { readPlan } from "./plan.js";
import { appendProgress } from "./progress.js";
import { loadPlanExecRuntimeIntegration } from "./runtime-integration.js";
import {
  TaskProjector,
  TASK_EXECUTION_STATE,
  taskProjectionSummary,
} from "./task-projection.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  EXEC_ACTION,
  EXEC_ALIAS_ACTIONS,
  EXTERNAL_OPERATION_STATE,
  OPERATION_RECOVERY,
  OPERATION_SERVICE,
  RUN_STAGE,
  RUN_STATUS,
  CONTROLLER_POLL_INTERVAL_MS,
  WORKFLOW_MODE,
  type ActiveOperation,
  type ExecAliasAction,
  type PlanExecRun,
  type RunAction,
} from "./types.js";

const defaultRegistry = new RunRegistry();
const STATUS_KEY = "plan-exec";
const PROVIDER_PROBE_TIMEOUT_MS = 1_500;
const PROJECTION_TIMEOUT_MS = 1_500;
const COMMAND_CAS_RETRIES = 5;
const SESSION_RETIREMENTS_KEY = Symbol.for("pi-plan-exec.session-retirements.v1");
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const DISPLAY_RUN_ID_LENGTH = 8;
const RECOVERY_MODEL_OPTION = "--model";
const EXISTING_WORKTREE_OPTION = "--worktree";
const SAME_MACHINE_OPTION = "--same-machine";
const CLEANUP_APPLY_OPTION = "--apply";
const CLEANUP_INCLUDE_FAILED_OPTION = "--include-failed";
const CLEANUP_RETENTION_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;
const CLEANUP_RETENTION_MS = CLEANUP_RETENTION_DAYS * MILLISECONDS_PER_DAY;
const GOAL_WIDGET_TAIL_LIMIT = 200;
const GOAL_STATUS_TAIL_LIMIT = 400;
const RUNS_ALL_OPTION = "--all";
/** Keyed by `ExecAliasAction`, so retiring another name forces a note with it. */
const ALIAS_NOTES: Record<ExecAliasAction, string> = {
  [EXEC_ACTION.RUNS]:
    "/exec runs is now /exec status; the old name still works.",
  [EXEC_ACTION.DOCTOR]:
    "/exec doctor is now /exec status; the old name still works.",
  [EXEC_ACTION.SETUP]:
    "/exec setup is now part of /exec status; the old name still works.",
  [EXEC_ACTION.ADOPT]:
    "/exec adopt is now /exec resume; the old name still works.",
  [EXEC_ACTION.PAUSE]:
    "/exec pause is now /exec stop; the old name still works and is the way to pause without a human to ask.",
  [EXEC_ACTION.CANCEL]:
    "/exec cancel is now /exec stop; the old name still works and is the way to cancel without a human to ask.",
};
/** Every run verb the action dispatch owns; `status` is read and answered earlier. */
type DispatchedAction = Exclude<RunAction, typeof EXEC_ACTION.STATUS>;
/** A verb added to `EXEC_ACTION` fails to compile here until it is routed. */
const RUN_ACTIONS: Record<DispatchedAction, true> = {
  [EXEC_ACTION.STOP]: true,
  [EXEC_ACTION.PAUSE]: true,
  [EXEC_ACTION.RESUME]: true,
  [EXEC_ACTION.SKIP]: true,
  [EXEC_ACTION.CANCEL]: true,
};
/** Labels lead with reversibility: it is the difference the reader chooses on. */
const STOP_OUTCOMES = [
  {
    action: EXEC_ACTION.PAUSE,
    label:
      "Pause — stop the current attempt and keep its checkpoint; /exec resume continues after confirmed exit.",
  },
  {
    action: EXEC_ACTION.CANCEL,
    label:
      "Cancel — final; the run stops for good and its worktree is preserved.",
  },
] as const;
/** Stop asks a question, so with no human it names both scripted answers. */
const STOP_REQUIRES_UI =
  "/exec stop asks whether to pause or cancel and needs an interactive session. Use /exec pause <run-id> to stop the current attempt while keeping its checkpoint resumable, or /exec cancel <run-id> to stop it for good with its worktree preserved.";
const RUN_LIST_TERMINAL_WINDOW_MS = MILLISECONDS_PER_DAY;
/** Why a reconcile left a run alone. Each reason gets its own report line. */
const RECONCILE_SKIP = {
  RECLAIMED: "reclaimed",
  STOP_REQUESTED: "stop-requested",
} as const;
type ReconcileSkip = (typeof RECONCILE_SKIP)[keyof typeof RECONCILE_SKIP];
type ReconcileOutcome =
  | { run: PlanExecRun; skipped?: undefined }
  | { run?: undefined; skipped: ReconcileSkip };
/** Deleted, not retired: bare /exec is the same code path, picker included. */
const REMOVED_START_ACTION = "start";
const DOCTOR_RECONCILE_OPTION = "--reconcile";
const REQUIRED_RUNTIME_TOOLS: Record<string, string> = {
  subagent: "pi-subagents",
};
function sourceInstallCommand(packageName: string): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (isRecord(manifest)) {
      const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
      const development = isRecord(manifest.devDependencies) ? manifest.devDependencies : {};
      const reference = dependencies[packageName] ?? development[packageName];
      if (typeof reference === "string") {
        const git = reference.match(/^git\+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git#([a-f0-9]{40})$/i);
        if (git) return `pi install -l git:github.com/${git[1]}@${git[2]}`;
        if (/^[\^~]?\d+\.\d+\.\d+/.test(reference)) return `pi install -l npm:${packageName}@${reference}`;
      }
    }
  } catch { /* A missing manifest must not imply that old published APIs suffice. */ }
  return `Install ${packageName} from the matching source revision documented in docs/runtime-contracts.md.`;
}

function requiredSetupCommands(): string[] {
  return [sourceInstallCommand("pi-subagents"), sourceInstallCommand("@alexeiled/pi-subagents-bridge")];
}

/** Primary verbs only: a retired name still dispatches, but is never taught. */
const EXEC_COMMANDS: AutocompleteItem[] = [
  {
    value: EXEC_ACTION.HELP,
    label: EXEC_ACTION.HELP,
    description: "Show /exec commands and recovery hints",
  },
  {
    value: EXEC_ACTION.CLEANUP,
    label: EXEC_ACTION.CLEANUP,
    description: "Preview or remove retired run records",
  },
  {
    value: EXEC_ACTION.STATUS,
    label: EXEC_ACTION.STATUS,
    description: "Show every run and what it needs, or one run in detail",
  },
  {
    value: EXEC_ACTION.STOP,
    label: EXEC_ACTION.STOP,
    description: "Stop a run: pause it (resumable) or cancel it (final)",
  },
  {
    value: EXEC_ACTION.RESUME,
    label: EXEC_ACTION.RESUME,
    description:
      "Continue the current run safely and reconcile its tracked worker",
  },
  {
    value: EXEC_ACTION.SKIP,
    label: EXEC_ACTION.SKIP,
    description: "Force-skip a blocked non-implementation stage with a reason",
  },
];

type NotificationLevel = "info" | "warning" | "error";
type RunState = Pick<PlanExecRun, "status" | "stage"> & {
  operation?: string;
  observation?: string;
};

type StartBackgroundController = (
  run: PlanExecRun,
  sessionId: string,
  cwd: string,
  ctx: ExtensionContext,
  handoffWhenReady?: (run: PlanExecRun) => Promise<boolean>,
) => void;
type RuntimeCheck = () => Promise<void>;
/** Prerequisite problems in report form; empty when every package is present. */
type RuntimeProbe = () => Promise<string[]>;
type SyncProjection = (
  run: PlanExecRun,
  options: { cwd: string; sessionId: string },
) => Promise<PlanExecRun>;

/** Survives extension replacement while an outgoing controller finishes its tick. */
interface SessionRetirement {
  sessionId: string;
  runIds: ReadonlySet<string>;
  settled: Promise<void>;
}

interface HandoffLifecycle {
  isClosed(): boolean;
  beginPreparation(runId: string): { finish(): void; switchingTo(sessionFile: string): void };
}

function sessionRetirements(): Set<SessionRetirement> {
  const existing: unknown = Reflect.get(globalThis, SESSION_RETIREMENTS_KEY);
  if (existing instanceof Set) return existing as Set<SessionRetirement>;
  const pending = new Set<SessionRetirement>();
  Reflect.set(globalThis, SESSION_RETIREMENTS_KEY, pending);
  return pending;
}

function retiringSession(run: PlanExecRun): SessionRetirement | undefined {
  if (run.lease && (!isLocalRun(run) || run.lease.pid !== process.pid)) return undefined;
  return [...sessionRetirements()].find((retirement) =>
    (!run.lease || retirement.sessionId === run.lease.sessionId) && retirement.runIds.has(run.id));
}

async function retireSessionLeases(sessionId: string, runIds: ReadonlySet<string>): Promise<void> {
  const owns = (run: PlanExecRun) => isLocalRun(run) &&
    run.lease?.sessionId === sessionId && run.lease.pid === process.pid;
  for (const runId of runIds) {
    for (let attempt = 0; attempt < COMMAND_CAS_RETRIES; attempt++) {
      const current = await defaultRegistry.get(runId);
      if (!current || !owns(current)) break;
      const released = { ...current };
      delete released.lease;
      if ((await defaultRegistry.updateIfCurrent(released, current.updatedAt)).applied) break;
      if (attempt === COMMAND_CAS_RETRIES - 1)
        throw new Error(`Run ${runId} changed repeatedly while retiring its session lease.`);
    }
  }
}

async function retrySessionRetirement(sessionId: string, runIds: ReadonlySet<string>): Promise<void> {
  for (;;) {
    try {
      await retireSessionLeases(sessionId, runIds);
      return;
    } catch {
      await waitForControllerPoll();
    }
  }
}

function waitForControllerPoll(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CONTROLLER_POLL_INTERVAL_MS);
    timer.unref?.();
  });
}

async function restoreRetiredRun(
  runId: string,
  ctx: ExtensionContext,
  start: StartBackgroundController,
  isClosed: () => boolean,
  contextOnly = false,
): Promise<void> {
  while (!isClosed()) {
    try {
      const run = await defaultRegistry.get(runId);
      if (isClosed() || !run || (contextOnly && !matchesContext(run, ctx.cwd))) return;
      const retiring = retiringSession(run);
      if (retiring) { await retiring.settled; continue; }
      const sessionId = ctx.sessionManager.getSessionId();
      if (shouldAutoRestoreRun(run, sessionId)) start(run, sessionId, ctx.cwd, ctx);
      return;
    } catch {
      await waitForControllerPoll();
    }
  }
}

export default function planExecExtension(pi: ExtensionAPI): void {
  const projector = new TaskProjector(defaultRegistry);
  const runtimeIntegration = loadPlanExecRuntimeIntegration().catch(
    () => undefined,
  );
  type ProjectionRequest = { run: PlanExecRun; options: Parameters<SyncProjection>[1] };
  const projectionQueues = new Map<string, { work: Promise<PlanExecRun>; latest?: ProjectionRequest }>();
  const syncProjection: SyncProjection = (run, options) => {
    const pending = projectionQueues.get(run.id);
    if (pending) {
      if (!pending.latest || run.updatedAt >= pending.latest.run.updatedAt) pending.latest = { run, options };
      return Promise.resolve(run);
    }
    const next = Promise.resolve()
      .then(() => projector.sync(run, options))
      .then(async (projected) => {
        try {
          const integration = await boundedPromise(
            runtimeIntegration,
            PROJECTION_TIMEOUT_MS,
          );
          if (integration)
            await boundedPromise(
              Promise.resolve(integration.sync(projected, options.sessionId)),
              PROJECTION_TIMEOUT_MS,
            );
        } catch {
          // Fleet visibility is a cache too; the durable run still proceeds.
        }
        return projected;
      });
    const entry: { work: Promise<PlanExecRun>; latest?: ProjectionRequest } = { work: next };
    projectionQueues.set(run.id, entry);
    void next.then(() => undefined, () => undefined).finally(() => {
      if (projectionQueues.get(run.id) === entry) {
        projectionQueues.delete(run.id);
        if (entry.latest) void syncProjection(entry.latest.run, entry.latest.options).catch(() => undefined);
      }
    });
    // A broken pi-tasks/runtime integration must not hold controller progress.
    // Keep one cache writer; later ticks use their current snapshot and coalesce
    // missed updates until this write settles.
    return boundedPromise(next, PROJECTION_TIMEOUT_MS).then(
      (projected) => entry.latest?.run ?? projected ?? run,
      () => entry.latest?.run ?? run,
    );
  };
  const bridge = new BridgeClient(pi.events);
  const fusion = new FusionClient(pi.events);
  const runCommand = async (command: string, args: string[], cwd: string) => {
    const invocation = workspaceCommand(command, args);
    const result = await pi.exec(invocation.command, invocation.args, { cwd });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  };
  const controller = new PlanExecController(
    defaultRegistry,
    bridge,
    fusion,
    runCommand,
  );

  // Bounded: a diagnosis runs right after a restart, when the bridge may not be
  // up yet. No answer within the budget is simply no evidence.
  const probeBridge = new BridgeClient(pi.events, PROVIDER_PROBE_TIMEOUT_MS);
  const doctorProbe = abandonmentProbe(
    async (operationId, run) => {
      const digest = run.activeOperation?.requestDigest;
      if (!digest) return undefined;
      await probeBridge.capabilities();
      const lookup = await probeBridge.operation(operationId, { kind: "pi-plan-exec", runId: run.id, key: operationId, requestDigest: digest });
      return lookup.success && lookup.data.requestDigest === digest ? bridgeOperationState(lookup.data) : undefined;
    },
    async (operation, run) => {
      const capabilities = await probeBridge.capabilities();
      if (capabilities.protocolVersion !== 2 || !capabilities.healthy) return {};
      if (!operation.requestDigest) return {};
      const expectedCaller = { operationId: operation.operationId, requestDigest: operation.requestDigest };
      const lookup = await probeBridge.operation(operation.operationId, { kind: "pi-plan-exec", runId: run.id, key: operation.operationId, requestDigest: operation.requestDigest });
      const proofData = lookup.success && lookup.data.requestDigest === operation.requestDigest
        ? lookup.data : undefined;
      const proof = operation.externalRunId
        ? processTerminalProof(processTerminalFromStatus(proofData), operation.externalRunId, expectedCaller)
        : undefined;
      return {
        durableOperationLookup: capabilities.durableOperationLookup,
        ...(proofData?.state === EXTERNAL_OPERATION_STATE.ABSENT && proofData.replaySafe === true ? { replaySafe: true } : {}),
        ...(proofData?.state === RUN_STATUS.CANCELLED && proofData.neverStarted === true && proofData.cancellationRequested === true ? { neverStarted: true } : {}),
        ...(proof ? { processTerminalProof: proof } : {}),
      };
    },
  );

  const activeControllers = new Map<string, ReturnType<typeof setInterval>>();
  const inFlightControllers = new Map<string, Promise<PlanExecRun>>();
  const ownedRuns = new Set<string>();
  const handoffPreparations = new Set<{ settled: Promise<void>; targetSessionFile?: string }>();
  const pendingMutations = new Set<{
    settled: Promise<void>;
    retirementRunIds?: Set<string>;
  }>();
  let sessionClosed = false;
  const handoffLifecycle: HandoffLifecycle = {
    isClosed: () => sessionClosed,
    beginPreparation: (runId) => {
      ownedRuns.add(runId);
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const handoff: { settled: Promise<void>; targetSessionFile?: string } = { settled: pending };
      handoffPreparations.add(handoff);
      return {
        finish: () => { handoffPreparations.delete(handoff); finish(); },
        switchingTo: (sessionFile) => { handoff.targetSessionFile = sessionFile; },
      };
    },
  };
  const lastStates = new Map<string, RunState>();
  const setStatus = (run: PlanExecRun, ctx: ExtensionContext): void => {
    if (sessionClosed) return;
    try {
      ctx.ui.setStatus(STATUS_KEY, compactRunStatus(run));
      ctx.ui.setWidget(STATUS_KEY, [
        ...formatRunWidget(run),
        `Plan worktree: ${run.worktreeCwd}`,
        `Git branch: ${run.branch}  ·  use !git status --short --branch for details`,
      ]);
    } catch {
      // TUI/RPC teardown must never affect the durable controller.
    }
  };
  const stopBackgroundController = (runId: string): void => {
    const timer = activeControllers.get(runId);
    if (timer) clearInterval(timer);
    activeControllers.delete(runId);
    lastStates.delete(runId);
  };
  const notify = (
    ctx: ExtensionContext,
    message: string,
    level: NotificationLevel,
  ): void => {
    if (sessionClosed) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // UI can disappear during reload or shutdown; the registry remains authoritative.
    }
  };
  // Reported, not thrown: /exec status prints the same problems next to the
  // install commands, so a missing package is visible without a separate verb.
  const runtimeProblems: RuntimeProbe = async () => {
    const missingTools = missingRuntimeTools(
      pi.getAllTools().map((tool) => tool.name),
    );
    if (missingTools.length > 0) return [`missing: ${missingTools.join(", ")}`];
    const bridgeReply = await bridge.ping();
    const missing: string[] = [];
    const incompatible: string[] = [];
    if (!bridgeReply.success) missing.push("@alexeiled/pi-subagents-bridge");
    else {
      const capabilities = await bridge.capabilities();
      if (!bridgeRuntimeCompatible(bridgeReply.data, capabilities))
        incompatible.push(
          "@alexeiled/pi-subagents-bridge (durable lookup, direct owned-agent spawn, and explicit lifetime support required)",
        );
    }
    return [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(incompatible.length > 0
        ? [`incompatible: ${incompatible.join(", ")}`]
        : []),
    ];
  };
  const checkRuntime: RuntimeCheck = async () => {
    // Dispatch admission belongs to the durable controller; cold probes must
    // not discard an otherwise authorized plan or resume request.
    void runtimeProblems().catch(() => undefined);
  };
  const startBackgroundController: StartBackgroundController = (
    initialRun,
    sessionId,
    cwd,
    ctx,
    handoffWhenReady,
  ): void => {
    const runId = initialRun.id;
    if (sessionClosed || retiringSession(initialRun) || activeControllers.has(runId)) return;
    ownedRuns.add(runId);
    lastStates.set(runId, runState(initialRun));
    setStatus(initialRun, ctx);
    const timer = setInterval(() => {
      if (sessionClosed || inFlightControllers.has(runId)) return;
      const ticking = controller.tick(runId, sessionId);
      inFlightControllers.set(runId, ticking);
      void ticking
        .then(async (run) => {
          if (sessionClosed) return run;
          if (handoffWhenReady && canHandoffPreparedWorktree(run)) {
            // Session startup must be able to install the target's controller.
            stopBackgroundController(runId);
            let handedOff = false;
            try {
              handedOff = await handoffWhenReady(run);
            } finally {
              if (!handedOff) startBackgroundController(run, sessionId, cwd, ctx);
            }
            if (handedOff) return run;
          }
          setStatus(run, ctx);
          const previous = lastStates.get(runId);
          lastStates.set(runId, runState(run));
          if (isTerminal(run.status)) {
            stopBackgroundController(runId);
            const level: NotificationLevel =
              run.status === RUN_STATUS.FAILED ? "error" : "info";
            notify(ctx, terminalMessage(run), level);
          } else if (shouldStopBackgroundController(run)) {
            stopBackgroundController(runId);
            notify(
              ctx,
              pausedMessage(run),
              "warning",
            );
          } else {
            const transition = progressTransition(previous, run);
            if (transition) notify(ctx, transition, "info");
          }
          // Projection is a cache repair. Keep it serialized per run, but do
          // not hold the controller's next tick on a slow or broken cache.
          void syncProjection(run, { sessionId, cwd })
            .then((projected) => setStatus(projected, ctx))
            .catch(() => undefined);
          return run;
        })
        .catch((error: unknown) => {
          // A transient claim/UI/provider error is a recovery observation. The
          // next timer tick retries it; only explicit controller state can stop
          // the timer. In particular, this path never marks a run failed.
          const message = error instanceof Error ? error.message : String(error);
          notify(
            ctx,
            `Plan execution ${shortRunId(runId)} recovery probe unavailable: ${message}. Automatic retry continues.`,
            "warning",
          );
        })
        .finally(() => {
          if (inFlightControllers.get(runId) === ticking) inFlightControllers.delete(runId);
        });
    }, CONTROLLER_POLL_INTERVAL_MS);
    timer.unref();
    activeControllers.set(runId, timer);
  };

  /** Track a run allocation so session retirement waits for it, exactly as /exec does. */
  const withPendingMutation = async <T>(
    operation: (recordRun: (run: PlanExecRun) => void) => Promise<T>,
  ): Promise<T> => {
    if (sessionClosed) throw new Error("The requesting Pi session has been replaced.");
    let finish!: () => void;
    const mutation: { settled: Promise<void>; retirementRunIds?: Set<string> } = {
      settled: new Promise<void>((resolve) => { finish = resolve; }),
    };
    pendingMutations.add(mutation);
    try {
      return await operation((run) => {
        ownedRuns.add(run.id);
        mutation.retirementRunIds?.add(run.id);
      });
    } finally {
      pendingMutations.delete(mutation);
      finish();
    }
  };

  pi.registerCommand("exec", {
    description:
      "Execute a checked Markdown plan with worktree isolation, progress, reviews, and recovery; use /exec help for commands",
    getArgumentCompletions: getExecArgumentCompletions,
    handler: async (args, ctx) => {
      if (sessionClosed) return;
      let currentMutation: { settled: Promise<void>; retirementRunIds?: Set<string> } | undefined;
      try {
        const message = await handleCommand(args.trim(), ctx, {
          controller,
          startBackgroundController,
          syncProjection,
          checkRuntime,
          runtimeProblems,
          doctorProbe,
          isSessionClosed: () => sessionClosed,
          recordRun: (run) => { ownedRuns.add(run.id); currentMutation?.retirementRunIds?.add(run.id); },
          mutate: async (operation) => {
            if (sessionClosed) throw new Error("The requesting Pi session has been replaced.");
            let finish!: () => void;
            const mutation: { settled: Promise<void>; retirementRunIds?: Set<string> } = {
              settled: new Promise<void>((resolve) => { finish = resolve; }),
            };
            currentMutation = mutation;
            pendingMutations.add(mutation);
            try { return await operation(); }
            finally {
              pendingMutations.delete(mutation);
              currentMutation = undefined;
              finish();
            }
          },
          handoffLifecycle,
        });
        if (message) notify(ctx, message, "info");
      } catch (error: unknown) {
        notify(ctx,
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("goal", {
    description: "Pursue a goal autonomously in place; use /goal help for commands",
    getArgumentCompletions: (prefix: string) => {
      const request = prefix.trim().toLowerCase();
      if (request.includes(" ")) return [];
      return ["help", "status", "resume", "pause", "stop", "cancel"]
        .filter((value) => value.startsWith(request))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const parsed = parseGoalCommand(args);
      try {
        if (parsed.action === EXEC_ACTION.HELP) {
          notify(ctx, goalHelp(), "info");
          return;
        }
        if (parsed.action === EXEC_ACTION.STATUS) {
          const run = await resolveGoalRun(parsed.id);
          if (!run) throw new Error("No goal run found.");
          notify(ctx, goalStatusText(run), "info");
          return;
        }
        if (parsed.action === EXEC_ACTION.RESUME) {
          const run = await resolveGoalRun(parsed.id);
          if (!run) throw new Error("No goal run found.");
          const resumed = await controller.resume(run.id, sessionId, true);
          startBackgroundController(resumed, sessionId, ctx.cwd, ctx);
          notify(ctx, `Goal ${shortRunId(resumed.id)} resumed (${resumed.status}/${resumed.stage}).`, "info");
          return;
        }
        if (parsed.action === EXEC_ACTION.PAUSE || parsed.action === EXEC_ACTION.CANCEL) {
          const run = await resolveGoalRun(parsed.id);
          if (!run) throw new Error("No goal run found.");
          const requested = await requestStatus(run, parsed.action === EXEC_ACTION.PAUSE ? EXEC_ACTION.PAUSE : EXEC_ACTION.CANCEL);
          startBackgroundController(requested, sessionId, ctx.cwd, ctx);
          notify(ctx, parsed.action === EXEC_ACTION.PAUSE
            ? `Goal ${shortRunId(requested.id)} paused; run /goal resume ${requested.id} to continue.`
            : `Goal ${shortRunId(requested.id)} cancellation requested.`, "info");
          return;
        }
        const run = await withPendingMutation((recordRun) => controller.startGoal({
          goal: parsed.goal,
          sessionId,
          cwd: ctx.cwd,
          ...(parsed.checks.length ? { checks: parsed.checks } : {}),
          onRunAllocated: recordRun,
        }));
        startBackgroundController(run, sessionId, ctx.cwd, ctx);
        notify(ctx, [
          `Goal ${shortRunId(run.id)} started: ${run.goal?.text ?? ""}`,
          `checks: ${run.config.requiredChecks.map((command) => command.join(" ")).join(" · ")}`,
          `Use /goal status ${run.id} for progress.`,
        ].join("\n"), "info");
      } catch (error: unknown) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const retiring = [...sessionRetirements()];
    const sessionId = ctx.sessionManager.getSessionId();
    const { runs, errors } = await defaultRegistry.listWithErrors();
    const contextualRuns = runs.filter((run) => matchesContext(run, ctx.cwd));
    for (const run of runs) {
      if (isLocalRun(run) && run.lease?.sessionId === sessionId && run.lease.pid === process.pid && !retiringSession(run))
        ownedRuns.add(run.id);
    }
    if (errors.length > 0)
      notify(
        ctx,
        `Ignored ${errors.length} corrupt plan-exec run record${errors.length === 1 ? "" : "s"}: ${errors.map((error) => shortRunId(error.runId)).join(", ")}.`,
        "warning",
      );
    for (const run of contextualRuns) {
      if (shouldAutoRestoreRun(run, sessionId))
        startBackgroundController(run, sessionId, ctx.cwd, ctx);
    }
    for (const retirement of retiring) {
      void retirement.settled.then(async () => {
        await Promise.all([...retirement.runIds].map((runId) =>
          restoreRetiredRun(runId, ctx, startBackgroundController, () => sessionClosed, true)));
      }).catch(() => undefined);
    }
    for (const run of contextualRuns) {
      if (shouldRepairProjectionForSession(run, sessionId))
        void syncProjection(run, { cwd: ctx.cwd, sessionId }).then((projected) => setStatus(projected, ctx)).catch(() => undefined);
    }
    void boundedPromise(runtimeIntegration, PROJECTION_TIMEOUT_MS).then(async (integration) => {
      if (integration)
        await boundedPromise(Promise.resolve(integration.reconcile(contextualRuns, sessionId)), PROJECTION_TIMEOUT_MS);
    }).catch(() => undefined);
    void boundedPromise(sweepAbandonment(defaultRegistry), PROJECTION_TIMEOUT_MS).then((sweep) => {
      if (!sweep) return;
      const notice = abandonedRunsNotice(sweep);
      if (notice) notify(ctx, notice, "warning");
    }).catch(() => undefined);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    sessionClosed = true;
    for (const timer of activeControllers.values()) clearInterval(timer);
    activeControllers.clear();
    lastStates.clear();
    // A handoff cannot await itself; other replacements drain its cleanup too.
    const sessionId = ctx.sessionManager.getSessionId();
    const runIds = new Set(ownedRuns);
    for (const mutation of pendingMutations) mutation.retirementRunIds = runIds;
    const retirement: SessionRetirement = { sessionId, runIds,
      settled: Promise.allSettled([...inFlightControllers.values(), ...[...pendingMutations].map((mutation) => mutation.settled), ...[...handoffPreparations]
        .filter((handoff) => !(event.reason === EXEC_ACTION.RESUME && handoff.targetSessionFile &&
          event.targetSessionFile === handoff.targetSessionFile)).map((handoff) => handoff.settled)])
        .then(() => retrySessionRetirement(sessionId, runIds)) };
    const retirements = sessionRetirements();
    retirements.add(retirement);
    void retirement.settled.finally(() => retirements.delete(retirement)).catch(() => undefined);
    void boundedPromise(runtimeIntegration, PROJECTION_TIMEOUT_MS).then(async (integration) => {
      if (integration) await boundedPromise(Promise.resolve(integration.dispose()), PROJECTION_TIMEOUT_MS);
    }).catch(() => undefined);
    await boundedPromise(retirement.settled, PROJECTION_TIMEOUT_MS).catch(() => undefined);
    // Status is session-scoped in Pi, so the next session starts clean.
  });
}

export function runtimeIntegrationProblem(
  available: boolean,
): string | undefined {
  return available
    ? undefined
    : "pi-subagents >=0.60.0 external-runs/background-work APIs unavailable";
}

export function bridgeRuntimeCompatible(
  _pingData: unknown,
  capabilities: BridgeCapabilities,
): boolean {
  if (!capabilities.healthy || capabilities.singleAgentSpawn !== true) return false;
  if (capabilities.protocolVersion === 2)
    return (
      capabilities.durableOperationLookup &&
      capabilities.processTerminalProofVersion === 1 &&
      capabilities.executionLifetimeVersion === 1 &&
      (capabilities.executionLifetimeModes?.length ?? 0) > 0 &&
      supportsOwnedProcessTree(capabilities)
    );
  return false;
}

export function hasBridgeOperationMethod(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("methods" in data))
    return false;
  const methods = data.methods;
  return Array.isArray(methods) && methods.includes("operation");
}

export function hasBridgeWorkflowScriptSpawnCapability(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("capabilities" in data))
    return false;
  const capabilities = data.capabilities;
  return (
    typeof capabilities === "object" &&
    capabilities !== null &&
    "workflowScriptSpawn" in capabilities &&
    capabilities.workflowScriptSpawn === true
  );
}

export function missingRuntimeTools(available: string[]): string[] {
  const registered = new Set(available);
  return Object.entries(REQUIRED_RUNTIME_TOOLS)
    .filter(([tool]) => !registered.has(tool))
    .map(([, packageName]) => packageName);
}

export function getExecArgumentCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  if (trimmed.includes(" ")) return null;
  return EXEC_COMMANDS.filter((command) => command.value.startsWith(trimmed));
}

/**
 * One verdict and the one command that acts on it. `command` is always a
 * command `action` names, so a surface that renders only the command and a
 * surface that renders the whole sentence cannot disagree.
 */
type RecoveryGuidance = {
  classification: string;
  action: string;
  command: string;
};

/** Every command a verdict can name for one run, so no branch spells one out. */
type RunCommands = {
  status: string;
  resume: string;
  stop: string;
  cleanup: string;
};

function runCommands(run: PlanExecRun): RunCommands {
  return {
    status: `/exec status ${run.id}`,
    resume: `/exec resume ${run.id}`,
    stop: `/exec stop ${run.id}`,
    cleanup: `/exec cleanup ${run.id}`,
  };
}

/**
 * The one next action for a run. Branch order matters throughout: each branch
 * assumes the ones above it did not fire. Without evidence nothing is proven
 * gone, and a persisted claim is never read as proof in either direction.
 *
 * `/exec status` is named only where the next read can differ: something is
 * polling, or an operation is left to probe. Anywhere else it would loop the
 * reader on a record nothing updates, so a command that moves the run is named.
 */
export function recoveryGuidance(
  run: PlanExecRun,
  evidence?: AbandonmentEvidence,
): RecoveryGuidance {
  const commands = runCommands(run);
  const { status, resume, stop } = commands;
  const polled = evidence?.leaseLive === true;
  if (isTerminal(run.status) && run.status !== RUN_STATUS.FAILED)
    return {
      classification: "finished",
      action: `This run is over and there is nothing to recover. Run /exec cleanup once you no longer need its record.`,
      command: commands.cleanup,
    };
  if (leaseNamesAnotherHost(run))
    return {
      classification: "its lease names a machine that cannot be observed here",
      action: `The lease was stamped on ${run.lease?.hostname} and this machine answers to ${hostname()}. Its ownership remains protected; that does not prove its worker is running. If that name was this machine before it was renamed, run ${resume} ${SAME_MACHINE_OPTION}; it checks the local owner and tracked worker before rebinding the lease. If it was a different machine, recover the run there.`,
      command: `${resume} ${SAME_MACHINE_OPTION}`,
    };
  // Only when nothing is tracked. With an unresolved operation this would
  // recommend a takeover the recovery gate then refuses; the operation branches
  // below answer that case instead. A run already told to stop, or already
  // failed, keeps that request and is answered by its own branch.
  if (isStaleOwner(run) && !isRecoverableRun(run) && !run.activeOperation)
    return {
      classification:
        "someone else's session was holding this run, and it is gone",
      action: `Check that the other session really stopped, then run ${resume}; it takes the run over from the dead one.`,
      command: resume,
    };
  if (hasExecutionBranchMismatch(run))
    return {
      classification: "this run belongs to a branch you are not on",
      action: `Check the branch you are on, then run interactive ${resume}; it asks before moving the run to that branch.`,
      command: resume,
    };
  if (needsPlanStructureReview(run))
    return {
      classification: "the plan file changed shape since this run started",
      action: `Put the original headings and checkboxes back, or run interactive ${resume} to accept the plan as it now reads. If the first resume only records this pause, run it once more after you have read the plan.`,
      command: resume,
    };
  // Ahead of every branch that tells the reader to wait: each such wait needs
  // something still running, so a proven-gone worker falsifies them all.
  if (evidence && classifyAbandonment(run, evidence) === ABANDONMENT.ABANDONED)
    return abandonedGuidance(run, commands, evidence);
  if (evidence && classifyAbandonment(run, evidence) === ABANDONMENT.RECONCILABLE)
    return { classification: "the pending launch can be checked without replacing it",
      action: `Run ${resume}; it preserves the same operation ID and immutable request. An empty lookup does not prove that an earlier request cannot still arrive.`, command: resume };
  if (run.status === RUN_STATUS.RUNNING && run.activeOperation?.processTreeExited === true)
    return { classification: "the worker has finished and its result is ready to read",
      action: `Run ${resume}; it consumes the saved result and candidate under the existing operation ID without launching a replacement worker.`, command: resume };
  if (run.status === RUN_STATUS.CANCEL_PENDING)
    return polled
      ? {
          classification: "waiting for the stop you asked for",
          action: `Run ${status} until it reads cancelled or failed. If the stop itself failed, ${resume} retries only the stop and cannot start plan work.`,
          command: status,
        }
      : {
          classification: "waiting for the stop you asked for",
          action: `No live session holds this run, so the stop cannot land by itself. Run ${stop} to finish the cancellation; its worktree is kept either way.`,
          command: stop,
        };
  if (run.status === RUN_STATUS.SKIP_PENDING) {
    if (!isStageWaiverAvailable(run))
      return {
        classification: "a required stage cannot be force-skipped",
        action: `The recorded waiver for required ${run.stage} cannot be applied. Keep the stage required and run ${status} after correcting the durable request. Do not resume or start another run.`,
        command: status,
      };
    if (polled)
      return {
        classification: "waiting for the stage you waived to stop",
        action: `The worker on that stage was told to stop, and the run moves on by itself once it has. Run ${status} to re-check. Do not resume or start another run.`,
        command: status,
      };
    if (!run.activeOperation)
      return {
        classification: "the waived stage has no worker left to stop",
        action: `No live session holds this run and no worker is tracked, so it cannot move on by itself. Run ${resume}; it applies the waiver without starting a worker.`,
        command: resume,
      };
    // Resume refuses a worker it cannot prove gone and stop is refused while a
    // waiver is pending, so the waiver itself is the only command left. Repeating
    // it on an already-pending waiver requests nothing new: it attaches a polling
    // session that stops the worker and advances the stage.
    return {
      classification: "waiting for the stage you waived to stop",
      action: `The worker on that stage was told to stop, but no live session is polling it, so nothing here notices when it does. Run ${stageWaiverCommand(run)} again; it attaches a session that stops that worker and applies the waiver. Do not resume or start another run.`,
      command: stageWaiverCommand(run),
    };
  }
  if (
    run.activeOperation?.recovery === OPERATION_RECOVERY.REQUIRED ||
    run.activeOperation?.lastObservedState ===
      EXTERNAL_OPERATION_STATE.UNKNOWN_LAUNCH
  )
    return {
      classification: "recovery required: worker launch outcome is unknown",
      action: `Run ${resume} only to re-check the same durable operation identity. Plan-exec will not launch replacement work without v2 durable absence proof. Use ${stop} if you must stop recovery.`,
      command: resume,
    };
  // In-flight only. A settled run's own record says the controller stopped, and
  // its resume looks the operation up by ID rather than launching a second one.
  if (
    isInFlightStatus(run.status) &&
    run.activeOperation &&
    !run.activeOperation.externalRunId
  )
    return waitOrStop(
      commands,
      polled,
      "cannot check on the worker right now",
      `A worker was launched and the tool never learned its name, so nothing here can tell whether it is still writing to the worktree.`,
    );
  if (run.status === RUN_STATUS.RUNNING || run.status === RUN_STATUS.STARTING) {
    if (run.activeOperation?.statusFailures)
      return waitOrStop(
        commands,
        polled,
        "cannot check on the worker right now",
        `The provider could not be reached, so nothing here can see what the worker is doing.`,
      );
    // A stored `running` claim is not evidence: only a trustworthy activity
    // signal earns wording that says the worker is alive.
    if (run.activeOperation) {
      if (
        run.activeOperation.lastObservedState ===
        EXTERNAL_OPERATION_STATE.PAUSED
      )
        return polled
          ? {
              classification: "workflow paused for supervisor input",
              action: `Reply to the displayed supervisor request. This controller is still polling the same workflow and continues automatically after its child settles. Run ${status} to re-check; do not resume or start another run.`,
              command: status,
            }
          : {
              classification: "workflow paused for supervisor input",
              action: `No live controller is polling it. Reply to any displayed supervisor request, then run ${resume}; it consumes the durable child result or reattaches the same workflow without launching a replacement.`,
              command: resume,
            };
      const signal = run.activeOperation.workerSignal;
      const workflow =
        signal?.mode === WORKFLOW_MODE ? " for a workflow-mode run" : "";
      const activity = reportedActivity(run.activeOperation, evidence);
      // Elapsed time is weaker evidence than a fresh activity value, so the
      // bound only speaks when nothing else does.
      const overdue = activity ? undefined : longRunningOperation(run);
      if (overdue)
        return waitOrStop(
          commands,
          polled,
          "running longer than its budget allows",
          `This run has claimed an active worker for ${elapsedLabel(overdue.elapsedMs)} since launch, past the explicit ${minutesLabel(overdue.boundMs)} compatibility deadline, and nothing reports what it is doing${workflow}. That is not proof the worker is stuck.`,
        );
      if (!activity)
        return waitOrStop(
          commands,
          polled,
          "running, but nothing proves the worker is alive",
          `Nothing reports what this worker is doing${workflow}, so it is neither confirmed alive nor confirmed dead.`,
        );
      return {
        classification: "running, and the worker reported activity",
        action: `Wait; the controller is polling this worker. Run ${status} to look again later. Do not resume or start another run.`,
        command: status,
      };
    }
    return polled
      ? {
          classification: "between steps",
          action: `Wait for the next controller tick, then run ${status}.`,
          command: status,
        }
      : {
          classification: "between steps, with no session driving them",
          action: `No live session holds this run and no worker is tracked, so no tick is coming. Run ${resume}; it continues from the recorded stage without starting a second worker.`,
          command: resume,
        };
  }
  if (run.status === RUN_STATUS.PAUSED) {
    if (run.blocked)
      return {
        classification: run.blocked.taskId === undefined ? "paused for a goal blocker" : "paused for a task blocker",
        action: run.blocked.taskId === undefined
          ? `Goal: ${run.blocked.reason} Resolve the blocker, then run interactive /goal resume ${run.id}; no automatic retry is scheduled.`
          : `Task ${run.blocked.taskId}: ${run.blocked.reason} Resolve the blocker, then run interactive ${resume}; it asks before retrying the same task. No task was skipped and no automatic retry is scheduled.`,
        command: run.blocked.taskId === undefined ? `/goal resume ${run.id}` : resume,
      };
    if (run.activeOperation)
      return {
        classification: "workflow paused for supervisor input",
        action: `Reply to the displayed supervisor request first and wait for its child to finish. Then run ${resume}; it consumes the durable child result or reattaches the same workflow without launching a replacement.`,
        command: resume,
      };
    return {
      classification: "paused, waiting for you to continue it",
      action: `Run ${resume}; it applies the paused stage or its finished worker without starting a second one.`,
      command: resume,
    };
  }
  if (run.status === RUN_STATUS.FAILED) {
    if (isDetachedWorkflowFailure(run))
      return {
        classification: "workflow detached during supervisor coordination",
        action: `Run ${resume}; it consumes a durably completed child or reattaches the same workflow. It does not launch a replacement while that detached operation is unresolved.`,
        command: resume,
      };
    if (isModelProviderFailure(run))
      return {
        classification:
          "stopped because the model or provider could not be used",
        action: `Run ${resume}. It retries the failed worker with the model this Pi session is signed in to, and does not spend another task attempt.`,
        command: resume,
      };
    // Reachable only here: `isTaskRetryConfirmationRequired` conjoins this same
    // predicate, so a separate branch below it could never fire.
    if (isExternalManualBlocker(run))
      return {
        classification: "a task is blocked by something outside this run",
        action: `Resolve the reported prerequisite first — for example an approval, release checkpoint, credentials, or network access — then run interactive ${resume}; it asks before retrying the same task in the preserved worktree. Implementation work cannot be waived. Retrying does not waive plan requirements.`,
        command: resume,
      };
    if (run.activeOperation?.externalRunId)
      return {
        classification: "stopped, and you can continue it",
        action: `Run ${resume}; it first checks what the tracked ${run.activeOperation.service}/${run.activeOperation.kind} worker did, then retries the same stage in the worktree that was kept.`,
        command: resume,
      };
    return {
      classification: "stopped, and you can continue it",
      action: `Run ${resume}; it retries the same stage (${run.stage}) in the worktree that was kept.`,
      command: resume,
    };
  }
  return {
    classification: "not recognised",
    action: `Run ${status} again; no next step could be worked out from this state.`,
    command: status,
  };
}

/**
 * A wait, worded for whether anything is left to do the waiting. With a live
 * lease the controller reports back; without one the same words send the reader
 * round a record nothing updates, so the command that ends it leads instead.
 */
function waitOrStop(
  commands: RunCommands,
  polled: boolean,
  classification: string,
  reason: string,
): RecoveryGuidance {
  return polled
    ? {
        classification,
        action: `${reason} The controller is still polling it, so run ${commands.status} to look again later. Do not resume or start another run.`,
        command: commands.status,
      }
    : {
        classification,
        action: `${reason} No live session is polling it, so waiting alone never settles it. Run ${commands.stop} to end it and preserve the worktree. Do not resume or start another run.`,
        command: commands.stop,
      };
}

/** The one shape the evidence settled: nothing is running. */
function abandonedGuidance(
  run: PlanExecRun,
  commands: RunCommands,
  evidence: AbandonmentEvidence,
): RecoveryGuidance {
  const checked = `Checked just now: ${operationEvidence({ run, evidence })}`;
  if (run.status === RUN_STATUS.CANCEL_PENDING)
    return {
      classification: "the worker is gone, so the stop cannot land by itself",
      action: `${checked}, so this run will never reach cancelled on its own. Run ${commands.stop} to finish the cancellation; its worktree is kept either way.`,
      command: commands.stop,
    };
  if (run.status === RUN_STATUS.SKIP_PENDING)
    return {
      classification: "the worker is gone, so the waived stage cannot finish",
      action: `${checked}. Run ${commands.resume}; it retains the operation identity and finishes the pending waiver without starting a second worker.`,
      command: commands.resume,
    };
  return {
    classification: "the worker is gone, so nothing is running",
    action: `${checked}. Run ${commands.resume}; it retains the operation and consumes its saved result or candidate before continuing. Run ${commands.stop} instead to end the run and keep the worktree.`,
    command: commands.resume,
  };
}

/**
 * Why `--same-machine` does not apply to this run, or undefined when it does.
 * The flag is a human hostname assertion only; local PID and process evidence
 * still decide whether a foreign lease can be rebound.
 */
export function sameMachineRefusal(run: PlanExecRun): string | undefined {
  if (isLocalRun(run))
    return `${SAME_MACHINE_OPTION} only applies to a run whose lease names another host; run ${shortRunId(run.id)} is already observable here.`;
  return undefined;
}

/** A foreign lease remains protected regardless of heartbeat age. */
function leaseNamesAnotherHost(run: PlanExecRun): boolean {
  return Boolean(run.lease) && !isLocalRun(run);
}

function isStaleOwner(run: PlanExecRun): boolean {
  // No session argument, here or in any caller that judges liveness: passing
  // one makes `isLeaseLive` answer LIVE on a name match whatever the heartbeat
  // says, so a session would read its own dead lease as live and disagree with
  // the sweep. The predicate is otherwise `claim`'s, so the two cannot drift.
  return Boolean(run.lease) && !hasLiveLease(run);
}

function hasExecutionBranchMismatch(run: PlanExecRun): boolean {
  return /Execution directory is on .+, expected .+\./.test(run.error ?? "");
}

/**
 * A stored activity value freezes when the polling session dies and would read
 * as health forever. Two gates, because either alone is passable: a live lease
 * proves someone is still writing the value, and the staleness bound proves
 * this one was written recently. With no evidence, nothing is proven.
 */
function reportedActivity(
  operation: ActiveOperation | undefined,
  evidence: AbandonmentEvidence | undefined,
): string | undefined {
  if (evidence?.leaseLive !== true) return undefined;
  const activity = operation?.workerSignal?.activity;
  if (!activity || operation?.lastObservedAt === undefined) return undefined;
  return Date.now() - operation.lastObservedAt < LEASE_STALE_MS
    ? activity
    : undefined;
}

export function formatRunStatus(
  run: PlanExecRun,
  evidence?: AbandonmentEvidence,
): string {
  const operation = run.activeOperation;
  const operationText = operation
    ? `${operation.service}/${operation.kind}${
        operation.taskId ? ` (Task ${operation.taskId})` : ""
      }${
        operation.reviewIteration
          ? ` (review iteration ${operation.reviewIteration})`
          : ""
      }`
    : "idle";
  const lines = [
    `Run ${run.id}`,
    run.goal !== undefined ? `goal: ${run.goal.text}` : `plan: ${run.planPath}`,
    `status: ${run.status}`,
    `stage: ${run.stage}`,
    `operation: ${operationText}`,
    `branch: ${run.branch}`,
    `worktree: ${run.worktreeCwd}`,
    `updated: ${new Date(run.updatedAt).toISOString()}`,
  ];
  if (run.goal !== undefined) {
    lines.push(`turn: ${run.goal.iteration}/${run.config.maxTaskIterations}`);
    if (run.goal.lastCheck) lines.push(`checks: ${run.goal.lastCheck.failures ? `failing — ${run.goal.lastCheck.failures}` : "passing"}`);
  }
  if (run.blocked) lines.push(`blocked: ${run.blocked.reason}`);
  if (operation) lines.push(`operation ID: ${operation.operationId}`);
  if (operation?.externalRunId)
    lines.push(`external run ID: ${operation.externalRunId}`);
  if (run.archiveOperation) lines.push(`archive Git operation: ${run.archiveOperation.phase} · attempt ${run.archiveOperation.attempt + 1} · ${run.archiveOperation.operationId}`);
  if (run.outputPromotion?.state === EXTERNAL_OPERATION_STATE.PENDING) lines.push(`output promotion: ${run.outputPromotion.commandStarted ? "waiting for owned Git command retirement" : "preparing safe fast-forward"}`);
  if (run.failedOperation) {
    lines.push(
      `failed operation: ${run.failedOperation.service}/${run.failedOperation.kind}`,
    );
    if (run.failedOperation.externalRunId)
      lines.push(
        `failed external run ID: ${run.failedOperation.externalRunId}`,
      );
    if (run.failedOperation.terminalError)
      lines.push(
        `failed operation error: ${run.failedOperation.terminalError}`,
      );
  }
  if (run.progressPath) lines.push(`progress: ${run.progressPath}`);
  lines.push(...taskStatusLines(run));
  const usage = totalUsage(run);
  if (usage) lines.push(`usage: ${usage}`);
  if (run.statsReport)
    lines.push(`stats report: ${run.statsReport.state} — ${run.statsReport.error ?? run.statsReport.summary}`);
  if (run.taskProjection?.state === "degraded")
    lines.push(
      `task projection: degraded — ${run.taskProjection.error ?? "unknown error"}`,
    );
  else if (run.taskProjection?.state === "ready")
    lines.push(
      `task projection: ready (${run.taskProjection.scope ?? "unknown scope"}${run.taskProjection.listPath ? `, ${run.taskProjection.listPath}` : ""})`,
    );
  if (operation?.lastObservedAt)
    lines.push(
      `last observation: ${new Date(operation.lastObservedAt).toISOString()}`,
    );
  lines.push(...workerSignalLines(run, evidence));
  if (operation?.diagnostics) {
    const diagnosis = operation.diagnostics;
    lines.push(`runner diagnosis: ${diagnosis.assessment} · phase ${diagnosis.phase ?? "unavailable"}${diagnosis.currentTool ? ` · tool ${diagnosis.currentTool}` : ""}${diagnosis.runnerPid ? ` · runner PID ${diagnosis.runnerPid}` : ""}`,
      `next diagnostic action: ${diagnosis.action} at ${new Date(diagnosis.nextProbeAt).toISOString()}`);
    if (diagnosis.lastToolFailure) lines.push(`confirmed tool failure: ${diagnosis.lastToolFailure.toolName} (${diagnosis.lastToolFailure.toolCallId}) — ${diagnosis.lastToolFailure.message}`);
  }
  for (const action of Object.values(operation?.diagnosticActions ?? {}))
    lines.push(`tool guidance: ${action.state} for ${action.toolCallId} — guidance only, not a repair confirmation${action.error ? `; ${action.error}` : ""}`);
  // The failure counts below are stored facts and print either way. Only an
  // observed live lease adds the claim that something is still trying.
  const polling = evidence?.leaseLive === true && isLocalRun(run) ? "; retrying" : "";
  if (operation?.statusFailures) {
    lines.push(
      `observation: unavailable (${operation.statusFailures} failed probes)${polling}${operation.lastStatusError ? ` — ${operation.lastStatusError}` : ""}`,
    );
  }
  if (operation?.skipFailures) {
    lines.push(
      `waived stage: could not stop the worker (${operation.skipFailures} failed requests)${polling}${operation.lastSkipError ? ` — ${operation.lastSkipError}` : ""}`,
    );
  } else if (operation && !operation.statusFailures && polling) {
    lines.push(
      "observation: polling continues; worker output is available when its operation completes.",
    );
  }
  if (run.branchRebindings.length > 0) {
    lines.push("branch rebindings:");
    for (const rebinding of run.branchRebindings)
      lines.push(
        `- ${rebinding.from} -> ${rebinding.to} by ${rebinding.requestedBy}`,
      );
  }
  if (run.error) lines.push(`error: ${run.error}`);
  if (run.pendingStageSkip)
    lines.push(
      `force-skip pending: ${run.pendingStageSkip.stage} — ${run.pendingStageSkip.reason}`,
    );
  if (run.skippedStages.length > 0) {
    lines.push("force-skipped stages:");
    for (const skip of run.skippedStages)
      lines.push(
        `- ${skip.stage} by ${skip.requestedBy}: ${skip.reason}${skip.terminalOperationState ? ` (operation: ${skip.terminalOperationState})` : ""}`,
      );
  }
  const guidance = recoveryGuidance(run, evidence);
  lines.push(`recovery: ${guidance.classification}`);
  // The fact only. What to do about it is the next safe action below, which
  // knows whether the operation the dead owner left behind is gone.
  if (isStaleOwner(run))
    lines.push(
      `owner: stale lease for ${run.lease?.sessionId ?? "unknown session"}; that Pi session is no longer running.`,
    );
  lines.push(`next safe action: ${guidance.action}`);
  return lines.join("\n");
}

function taskStatusLines(run: PlanExecRun): string[] {
  const summary = taskProjectionSummary(run);
  if (summary.total === 0) return [];
  const lines = [
    `tasks: ${summary.accepted}/${summary.total} accepted; ready ${summary.ready}; running ${summary.running}; retry ${summary.retry}; dependency ${summary.dependency}; external ${summary.external}`,
  ];
  for (const task of Object.values(run.tasks ?? {}).sort(
    (left, right) => left.taskId - right.taskId,
  )) {
    if (task.state === TASK_EXECUTION_STATE.ACCEPTED) continue;
    const next = task.nextAttemptAt
      ? `; next automatic action ${new Date(task.nextAttemptAt).toISOString()}`
      : "";
    const verified = task.lastVerifiedActivityAt
      ? `; last verified ${new Date(task.lastVerifiedActivityAt).toISOString()}`
      : "";
    lines.push(
      `task ${task.taskId}: ${task.state}; attempts ${task.attempts}${task.reason ? `; reason ${task.reason}` : ""}${next}${verified}`,
    );
  }
  return lines;
}

/**
 * Report what the provider actually said about the worker. Silence must never
 * be read as health, so with no trustworthy activity value the line states the
 * absence rather than printing nothing.
 */
function workerSignalLines(
  run: PlanExecRun,
  evidence?: AbandonmentEvidence,
): string[] {
  const operation = run.activeOperation;
  if (!operation) return [];
  const signal = operation.workerSignal;
  const activity = reportedActivity(operation, isLocalRun(run) ? evidence : undefined);
  const since = operation.launchStartedAt
    ? `, ${elapsedLabel(Date.now() - operation.launchStartedAt)} since launch`
    : "";
  const lines = [
    evidence && classifyAbandonment(run, evidence) === ABANDONMENT.ABANDONED
      ? `worker: ${operationEvidence({ run, evidence })}; the operation is not running${since}`
      : activity
        ? `worker: ${activity}${since}`
        : `worker: no per-turn activity signal${
            signal?.mode === WORKFLOW_MODE ? " (workflow-mode run)" : ""
          }; liveness unverified${since}`,
  ];
  if (signal?.progress) lines.push(`worker progress: ${signal.progress}`);
  if (signal?.turnBudget)
    lines.push(`worker turn budget: ${signal.turnBudget}`);
  if (signal?.updated) lines.push(`worker status updated: ${signal.updated}`);
  for (const step of signal?.steps ?? []) lines.push(`worker step: ${step}`);
  return lines;
}

/**
 * Rows for the runs that claim nothing in flight, grouped by what they need.
 * Terminal runs older than a day are hidden, but counted in a footer rather
 * than dropped silently.
 */
export function settledRunLines(
  runs: PlanExecRun[],
  showAll = false,
): string[] {
  const visible = showAll ? runs : runs.filter(isRecentlyRelevantRun);
  const hidden = runs.length - visible.length;
  return [
    ...runGroupLines("waiting for you", visible.filter(needsOperator)),
    ...runGroupLines(
      "finished",
      visible.filter((run) => !needsOperator(run)),
    ),
    ...(hidden === 0
      ? []
      : [
          `${hidden} older terminal run${hidden === 1 ? "" : "s"} hidden. /exec status ${RUNS_ALL_OPTION} to show, /exec cleanup to remove.`,
        ]),
  ];
}

function runGroupLines(heading: string, runs: PlanExecRun[]): string[] {
  return sectionLines(
    heading,
    runs.flatMap((run) => [
      `- ${runClaim(run)} updated ${relativeTime(run.updatedAt)}. Next: ${nextRunCommand(run)}`,
      ...stageWaiverLines(run),
    ]),
  );
}

/** One heading, its rows, and an optional trailer — or nothing when empty. */
function sectionLines(
  heading: string,
  rows: string[],
  footer?: string,
): string[] {
  if (rows.length === 0) return [];
  return [`${heading}:`, ...rows, ...(footer ? [footer] : [])];
}

/**
 * Show the explicit waiver command for a blocked optional stage.
 */
function stageWaiverLines(run: PlanExecRun): string[] {
  if (!isStageWaiverAvailable(run)) return [];
  return [
    `  If ${run.stage} cannot pass, waive it: ${stageWaiverCommand(run)}`,
  ];
}

/**
 * The waiver, spelled for pasting. The reason is unquoted because
 * `parseSkipReason` joins the remaining tokens verbatim, so pasted quotes end
 * up inside the waiver.
 */
function stageWaiverCommand(run: PlanExecRun): string {
  return `/exec skip ${run.id} --reason <why the residual risk is accepted>`;
}

/** A settled run that a person still has to move; everything else is history. */
function needsOperator(run: PlanExecRun): boolean {
  return run.status === RUN_STATUS.PAUSED || isRecoverableFailure(run);
}

/** The same verdict the detail view renders, derived in the one place. */
function nextRunCommand(run: PlanExecRun): string {
  return recoveryGuidance(run).command;
}

function isRecentlyRelevantRun(run: PlanExecRun): boolean {
  return (
    !isTerminal(run.status) ||
    Date.now() - run.updatedAt < RUN_LIST_TERMINAL_WINDOW_MS
  );
}

export function parseStatusArguments(args: string[]): {
  selector: string | undefined;
  all: boolean;
} {
  let selector: string | undefined;
  let all = false;
  for (const arg of args) {
    if (arg === RUNS_ALL_OPTION) all = true;
    else if (arg === DOCTOR_RECONCILE_OPTION)
      throw new Error(
        `/exec status never writes. /exec resume <run-id> resets a provably abandoned run and continues it.`,
      );
    else if (arg.startsWith("--") || selector !== undefined)
      throw new Error(`Usage: /exec status [full-run-id] [${RUNS_ALL_OPTION}]`);
    else selector = arg;
  }
  if (selector && all)
    throw new Error(
      `${RUNS_ALL_OPTION} lists every run, so it cannot be combined with a run ID.`,
    );
  return { selector, all };
}

/** Reuses the status parser: the retired verb must accept no wider a set. */
function parseRunsArguments(args: string[]): boolean {
  const { selector, all } = parseStatusArguments(args);
  if (selector) throw new Error(`Usage: /exec runs [${RUNS_ALL_OPTION}]`);
  return all;
}

export function parseStartArguments(args: string): {
  planPath?: string;
  worktreePath?: string;
} {
  const input = args.trim();
  if (!input) return {};
  // The remaining text is one plan path, preserving the original space syntax.
  if (!input.startsWith("--")) return { planPath: unquoteStartPath(input) };
  const match = /^--worktree(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+|$)/.exec(
    input,
  );
  const worktreePath = match?.[1] ?? match?.[2] ?? match?.[3];
  const planPath = match ? input.slice(match[0].length).trim() : "";
  if (
    !worktreePath || worktreePath.startsWith("--") ||
    !planPath || planPath.startsWith("--")
  )
    throw new Error(`Usage: /exec ${EXISTING_WORKTREE_OPTION} <path> <plan-path>`);
  return { worktreePath, planPath: unquoteStartPath(planPath) };
}

function unquoteStartPath(path: string): string {
  const quote = path[0];
  if (quote !== '"' && quote !== "'") return path;
  if (path.length <= 2 || !path.endsWith(quote))
    throw new Error("Plan path needs matching quotes and must not be empty.");
  return path.slice(1, -1);
}

export function parseCleanupArguments(args: string[]): {
  runId: string | undefined;
  apply: boolean;
  includeFailed: boolean;
} {
  let runId: string | undefined;
  let apply = false;
  let includeFailed = false;
  for (const arg of args) {
    if (arg === CLEANUP_APPLY_OPTION) apply = true;
    else if (arg === CLEANUP_INCLUDE_FAILED_OPTION) includeFailed = true;
    else if (arg.startsWith("--") || runId !== undefined)
      throw new Error(
        `Usage: /exec cleanup [full-run-id] [${CLEANUP_APPLY_OPTION}] [${CLEANUP_INCLUDE_FAILED_OPTION}]`,
      );
    else runId = arg;
  }
  return { runId, apply, includeFailed };
}

/**
 * Removable = retired past the retention window with nothing alive holding it.
 * `failed` is excluded by default: its registry entry is what makes /exec
 * resume possible. The window runs from `retiredAt`, because releasing a lease
 * bumps `updatedAt` and would restart the clock.
 */
export function isRemovableRun(
  run: PlanExecRun,
  includeFailed = false,
): boolean {
  if (removalRefusal(run)) return false;
  // The refusal rejected every non-terminal status, so `failed` is the only
  // status left to exclude.
  if (run.status === RUN_STATUS.FAILED && !includeFailed) return false;
  return Date.now() - (run.retiredAt ?? run.updatedAt) >= CLEANUP_RETENTION_MS;
}

export async function execCleanup(
  registry: RunRegistry,
  args: string[],
): Promise<string> {
  const { runId, apply, includeFailed } = parseCleanupArguments(args);
  if (runId) {
    const unreadable = (await registry.listWithErrors()).errors.find(
      (error) => error.runId === runId,
    );
    if (unreadable) return cleanupUnreadable(registry, unreadable, apply);
  }
  // Naming a run overrides both the retention window and the failed exclusion,
  // so mentioning either would describe a filter that is not applied.
  const failedHint =
    includeFailed || runId
      ? []
      : [
          `Failed runs are excluded so /exec resume stays available; add ${CLEANUP_INCLUDE_FAILED_OPTION} to consider them.`,
        ];
  const targets = runId
    ? [await removableRun(registry, runId)]
    : (await registry.list()).filter((run) =>
        isRemovableRun(run, includeFailed),
      );
  if (targets.length === 0)
    return [
      `No plan execution runs are removable. A terminal run becomes removable ${CLEANUP_RETENTION_DAYS} days after it finished.`,
      ...failedHint,
    ].join("\n");
  const rows = targets.map(cleanupRow);
  if (!apply)
    return [
      "Removable plan execution runs (preview; nothing was deleted):",
      ...rows,
      "Removal deletes the registry entry only; the worktree, branch, and progress file are left in place.",
      ...(runId
        ? [
            "Naming a run overrides both the retention window and the failed exclusion; the registry still refuses a non-terminal run, a live lease, or a run a controller is recovering.",
          ]
        : []),
      ...failedHint,
      `Use /exec cleanup ${runId ? `${runId} ` : ""}${CLEANUP_APPLY_OPTION}${includeFailed ? ` ${CLEANUP_INCLUDE_FAILED_OPTION}` : ""} to remove them.`,
    ].join("\n");
  return removalReport(await removeAll(registry, targets));
}

function cleanupRow(run: PlanExecRun): string {
  return `${run.id} ${runLabel(run)} ${run.status}/${run.stage} updated ${relativeTime(run.updatedAt)}`;
}

function runLabel(run: PlanExecRun): string {
  return run.planPath !== undefined
    ? basename(run.planPath)
    : `goal ${run.goal?.hash ?? run.id}`;
}

/**
 * The registry re-checks each target under its lock, so any one can still be
 * refused. Outcomes are collected rather than thrown, so one refusal cannot
 * hide the removals that already happened.
 */
interface RemovalOutcome {
  run: PlanExecRun;
  removed: boolean;
  error?: string;
}

async function removeAll(
  registry: RunRegistry,
  targets: PlanExecRun[],
): Promise<RemovalOutcome[]> {
  const outcomes: RemovalOutcome[] = [];
  for (const run of targets) {
    try {
      outcomes.push({ run, removed: await registry.remove(run.id) });
    } catch (error: unknown) {
      outcomes.push({
        run,
        removed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

function removalReport(outcomes: RemovalOutcome[]): string {
  const removed = outcomes.filter((outcome) => outcome.removed);
  const refused = outcomes.filter((outcome) => outcome.error);
  const vanished = outcomes.filter(
    (outcome) => !outcome.removed && !outcome.error,
  );
  return [
    `Removed ${removed.length} plan execution run${removed.length === 1 ? "" : "s"}; worktrees, branches, and progress files were left in place.`,
    ...removed.map((outcome) => cleanupRow(outcome.run)),
    ...(vanished.length === 0
      ? []
      : [
          `${vanished.length} record${vanished.length === 1 ? " was" : "s were"} already gone: ${vanished.map((outcome) => outcome.run.id).join(", ")}`,
        ]),
    ...(refused.length === 0
      ? []
      : [
          `Kept ${refused.length} run${refused.length === 1 ? "" : "s"} the registry refused:`,
          ...refused.map(
            (outcome) => `- ${cleanupRow(outcome.run)} — ${outcome.error}`,
          ),
        ]),
  ].join("\n");
}

/** `list` drops an unparsable record, so removal is the only action left. */
async function cleanupUnreadable(
  registry: RunRegistry,
  unreadable: { runId: string; message: string },
  apply: boolean,
): Promise<string> {
  if (!apply)
    return [
      `Unreadable plan execution run record (preview; nothing was deleted): ${unreadable.runId} — ${unreadable.message}`,
      "Removal deletes the registry entry only; the worktree, branch, and progress file are left in place.",
      `Use /exec cleanup ${unreadable.runId} ${CLEANUP_APPLY_OPTION} to remove it.`,
    ].join("\n");
  if (!(await registry.remove(unreadable.runId)))
    return `Unreadable plan execution run record ${unreadable.runId} was already gone; nothing was deleted.`;
  return `Removed 1 unreadable plan execution run record: ${unreadable.runId}; its worktree, branch, and progress file were left in place.`;
}

async function removableRun(
  registry: RunRegistry,
  runId: string,
): Promise<PlanExecRun> {
  const run = await registry.get(runId);
  if (!run) throw new Error(`Plan execution run not found: ${runId}`);
  const refusal = removalRefusal(run);
  if (refusal) throw new Error(refusal);
  return run;
}

export function parseDoctorArguments(args: string[]): { reconcile: boolean } {
  for (const arg of args)
    if (arg !== DOCTOR_RECONCILE_OPTION)
      throw new Error(`Usage: /exec doctor [${DOCTOR_RECONCILE_OPTION}]`);
  return { reconcile: args.includes(DOCTOR_RECONCILE_OPTION) };
}

/** Evidence about the tracked operation; the sweep supplies lease liveness itself. */
export type EvidenceProbe = (
  run: PlanExecRun,
) => Promise<Omit<AbandonmentEvidence, "leaseLive">>;

export interface RunDiagnosis {
  run: PlanExecRun;
  evidence: AbandonmentEvidence;
  classification: Abandonment;
}

export interface AbandonmentSweep {
  diagnoses: RunDiagnosis[];
  /** Runs that claim nothing right now: terminal or paused. */
  settled: PlanExecRun[];
  unreadable: Array<{ runId: string; message: string }>;
}

/**
 * Filesystem evidence is diagnostic only. A wired bridge is still asked for
 * durable lookup and native process proof. A lookup that cannot answer yields
 * no evidence rather than a false verdict, and a run whose lease names another
 * host yields none at all — see `isLocalRun`.
 */
export function abandonmentProbe(
  lookupOperationState?: (operationId: string, run: PlanExecRun) => Promise<string | undefined>,
  lookupBridgeProof?: (
    operation: ActiveOperation,
    run: PlanExecRun,
  ) => Promise<{
    durableOperationLookup?: boolean;
    processTerminalProof?: ProcessTerminalProof;
    replaySafe?: boolean;
    neverStarted?: boolean;
  }>,
): EvidenceProbe {
  return async (run) => {
    const operation = run.activeOperation;
    if (!operation || !isLocalRun(run)) return {};
    const asyncDirPresent = operation.asyncDir
      ? await pathExists(operation.asyncDir)
      : undefined;
    const bridgeState =
      lookupOperationState && operation.service === OPERATION_SERVICE.BRIDGE
        ? await lookupOperationState(operation.operationId, run).catch(
            () => undefined,
          )
        : undefined;
    const bridgeProof =
      lookupBridgeProof && operation.service === OPERATION_SERVICE.BRIDGE
        ? await lookupBridgeProof(operation, run).catch(() => ({}))
        : {};
    return {
      ...(asyncDirPresent === undefined ? {} : { asyncDirPresent }),
      ...(bridgeState ? { bridgeState } : {}),
      ...bridgeProof,
    };
  };
}

/**
 * Everything known about one run's claim, gathered live. The sweep, the resume
 * gate, and the detail view all come through here, so none can answer
 * differently. A live lease is decisive, so nothing else is probed for it.
 * Takes no session, for the reason `isStaleOwner` gives.
 */
export async function runEvidence(
  run: PlanExecRun,
  probe: EvidenceProbe = abandonmentProbe(),
): Promise<AbandonmentEvidence> {
  const leaseLive = Boolean(run.lease && isLeaseLive(run.lease));
  return leaseLive ? { leaseLive } : { leaseLive, ...(await probe(run)) };
}

/** Diagnose every run that claims work in flight. Writes nothing, so startup can call it. */
export async function sweepAbandonment(
  registry: RunRegistry,
  probe: EvidenceProbe = abandonmentProbe(),
): Promise<AbandonmentSweep> {
  const { runs, errors } = await registry.listWithErrors();
  const claiming = runs.filter((run) => isInFlightStatus(run.status));
  const diagnoses = await Promise.all(
    claiming.map(async (run) => {
      const evidence = await runEvidence(run, probe);
      return {
        run,
        evidence,
        classification: classifyAbandonment(run, evidence),
      };
    }),
  );
  return {
    diagnoses,
    settled: runs.filter((run) => !isInFlightStatus(run.status)),
    unreadable: errors,
  };
}

/** The one line startup is allowed to say about a sweep, or nothing at all. */
export function abandonedRunsNotice(
  sweep: AbandonmentSweep,
): string | undefined {
  const abandoned = sweep.diagnoses.filter(
    (diagnosis) => diagnosis.classification === ABANDONMENT.ABANDONED,
  ).length;
  if (abandoned === 0) return undefined;
  return `${abandoned} plan execution ${abandoned === 1 ? "run claims" : "runs claim"} to be running with no worker. Use /exec status.`;
}

/** Probes are optional and lazy: a read command must pay for them, nothing else. */
export interface StatusSources {
  probe?: EvidenceProbe;
  problems?: RuntimeProbe;
}

export interface StatusOptions {
  all?: boolean;
  probe?: EvidenceProbe;
  problems?: string[];
}

/**
 * The whole read surface; nothing reachable from here writes. Returns undefined
 * for a non-read subcommand, for a `status` naming a run the caller must
 * resolve itself, and for the one retired flag that writes.
 */
export async function execRead(
  registry: RunRegistry,
  subcommand: string | undefined,
  rest: string[],
  sources: StatusSources = {},
): Promise<string | undefined> {
  if (subcommand === EXEC_ACTION.SETUP)
    return withAliasNote(execSetup(), ALIAS_NOTES[EXEC_ACTION.SETUP]);
  if (subcommand === EXEC_ACTION.RUNS)
    return withAliasNote(
      await execStatus(
        registry,
        await statusOptions(parseRunsArguments(rest), sources),
      ),
      ALIAS_NOTES[EXEC_ACTION.RUNS],
    );
  if (subcommand === EXEC_ACTION.DOCTOR) {
    // `--reconcile` resets every abandoned run in the registry. A read command
    // must not be able to do that, so it is dispatched as a write instead.
    if (parseDoctorArguments(rest).reconcile) return undefined;
    return withAliasNote(
      await execStatus(registry, await statusOptions(false, sources)),
      ALIAS_NOTES[EXEC_ACTION.DOCTOR],
    );
  }
  if (subcommand === EXEC_ACTION.STATUS) {
    const { selector, all } = parseStatusArguments(rest);
    if (!selector)
      return execStatus(registry, await statusOptions(all, sources));
  }
  return undefined;
}

/** One line, appended once, naming what the retired verb became. */
function withAliasNote(body: string, note: string): string {
  return `${body}\n${note}`;
}

async function statusOptions(
  all: boolean,
  sources: StatusSources,
): Promise<StatusOptions> {
  const problems = sources.problems ? await sources.problems() : [];
  return {
    all,
    ...(sources.probe ? { probe: sources.probe } : {}),
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/**
 * Every run, grouped by what it needs, each row ending in a single next
 * command. Listing, diagnosis, and the missing-package report are one answer;
 * `--all` is the zoom control.
 */
export async function execStatus(
  registry: RunRegistry,
  options: StatusOptions = {},
): Promise<string> {
  const sweep = await sweepAbandonment(registry, options.probe);
  const lines =
    options.problems && options.problems.length > 0
      ? prerequisiteLines(options.problems)
      : [];
  const total =
    sweep.diagnoses.length + sweep.settled.length + sweep.unreadable.length;
  if (total === 0)
    return [...lines, "No plan execution runs. Start one with /exec."].join(
      "\n",
    );
  const inFlight = sweep.diagnoses.length;
  const abandoned = diagnosisGroup(sweep, ABANDONMENT.ABANDONED);
  lines.push(
    `Plan execution runs: ${total}${inFlight > 0 ? ` (${inFlight} claiming work in flight)` : ""}`,
    ...groupLines(
      "abandoned — no worker is running",
      abandoned,
      abandonedFooter(abandoned),
    ),
    ...groupLines(
      "reconcilable — the existing launch identity must be preserved",
      diagnosisGroup(sweep, ABANDONMENT.RECONCILABLE),
    ),
    ...groupLines(
      "ambiguous — evidence is incomplete, so nothing was reset",
      diagnosisGroup(sweep, ABANDONMENT.AMBIGUOUS),
    ),
    ...groupLines(
      "live — a session still holds this run",
      diagnosisGroup(sweep, ABANDONMENT.LIVE),
    ),
    ...settledRunLines(sweep.settled, options.all ?? false),
    ...unreadableLines(sweep.unreadable),
  );
  return lines.join("\n");
}

/** Name the problem where the reader already is, next to the exact cure. */
function prerequisiteLines(problems: string[]): string[] {
  return [
    `${prerequisiteProblem(problems)} Install them, then /reload:`,
    ...requiredSetupCommands(),
    "",
  ];
}

function prerequisiteProblem(problems: string[]): string {
  return `Plan-exec prerequisites — ${problems.join("; ")}.`;
}

function unreadableLines(
  unreadable: Array<{ runId: string; message: string }>,
): string[] {
  if (unreadable.length === 0) return [];
  return [
    "unreadable run records:",
    ...unreadable.map(
      (record) =>
        `- ${record.runId} — ${record.message}. Next: /exec cleanup ${record.runId} ${CLEANUP_APPLY_OPTION}`,
    ),
  ];
}

/** Reconciliation preserves explicit stop requests as well as operation identity. */
function abandonedFooter(diagnoses: RunDiagnosis[]): string | undefined {
  const resettable = diagnoses.filter(
    (diagnosis) => !isRecoverableRun(diagnosis.run),
  ).length;
  if (resettable === 0) return undefined;
  return resettable === diagnoses.length
    ? "Each retains its operation and saved result for reconciliation; no replacement worker is launched."
    : "Each retains its operation and saved result for reconciliation, except the ones already told to stop, which keep that request; no replacement worker is launched.";
}

function diagnosisGroup(
  sweep: AbandonmentSweep,
  classification: Abandonment,
): RunDiagnosis[] {
  return sweep.diagnoses.filter(
    (diagnosis) => diagnosis.classification === classification,
  );
}

/** The one line the retired writing flag adds to its own report. */
const RECONCILE_ALIAS_NOTE = `/exec doctor ${DOCTOR_RECONCILE_OPTION} still works for scripted callers; /exec resume <run-id> reconciles one named operation instead, and /exec status reports the same diagnosis without writing.`;

/** Record eligible handoffs without discarding a launch, result, or candidate. */
export async function execReconcile(
  registry: RunRegistry,
  probe?: EvidenceProbe,
): Promise<string> {
  const sweep = await sweepAbandonment(registry, probe);
  const lines =
    sweep.diagnoses.length === 0
      ? ["No plan execution run claims work in flight."]
      : [
          `Plan execution runs claiming work in flight: ${sweep.diagnoses.length}`,
        ];
  lines.push(
    ...(await reconcileLines(
      registry,
      [...diagnosisGroup(sweep, ABANDONMENT.ABANDONED), ...diagnosisGroup(sweep, ABANDONMENT.RECONCILABLE)],
    )),
    ...groupLines(
      "ambiguous — evidence is incomplete, so nothing was reset",
      diagnosisGroup(sweep, ABANDONMENT.AMBIGUOUS),
    ),
    ...groupLines(
      "live — a session still holds this run",
      diagnosisGroup(sweep, ABANDONMENT.LIVE),
    ),
    ...unreadableLines(sweep.unreadable),
  );
  if (sweep.settled.length > 0)
    lines.push(
      `${sweep.settled.length} other run${sweep.settled.length === 1 ? " is" : "s are"} terminal or paused; use /exec status ${RUNS_ALL_OPTION}.`,
    );
  return lines.join("\n");
}

function groupLines(
  heading: string,
  diagnoses: RunDiagnosis[],
  footer?: string,
): string[] {
  return sectionLines(
    heading,
    diagnoses.map(
      (diagnosis) =>
        `- ${runClaim(diagnosis.run)} — ${evidenceText(diagnosis)}. Next: ${nextCommand(diagnosis)}`,
    ),
    footer,
  );
}

async function reconcileLines(
  registry: RunRegistry,
  abandoned: RunDiagnosis[],
): Promise<string[]> {
  const reset: RunDiagnosis[] = [];
  const reclaimed: RunDiagnosis[] = [];
  const stopping: RunDiagnosis[] = [];
  for (const diagnosis of abandoned) {
    const outcome = await reconcileRun(registry, diagnosis);
    if (outcome.run) reset.push(diagnosis);
    else if (outcome.skipped === RECONCILE_SKIP.STOP_REQUESTED)
      stopping.push(diagnosis);
    else reclaimed.push(diagnosis);
  }
  const lines: string[] = [];
  if (reset.length > 0)
    lines.push(
      `Reconciled ${reset.length} run${reset.length === 1 ? "" : "s"} with their existing operation identity. No worker was launched and no task attempt was consumed.`,
      ...reset.map(
        (diagnosis) =>
          `- ${runClaim(diagnosis.run)} → reconciliation pending. Next: ${nextCommand(diagnosis)}`,
      ),
    );
  if (stopping.length > 0)
    lines.push(
      `Left ${stopping.length} abandoned run${stopping.length === 1 ? "" : "s"} alone: each carries the stop you asked for, and a reset would drop it:`,
      ...stopping.map(
        (diagnosis) =>
          `- ${runClaim(diagnosis.run)}. Next: ${nextCommand(diagnosis)}`,
      ),
    );
  if (reclaimed.length > 0)
    lines.push(
      `Skipped ${reclaimed.length} run${reclaimed.length === 1 ? "" : "s"} reclaimed while the sweep ran; nothing was overwritten:`,
      ...reclaimed.map((diagnosis) => `- ${runClaim(diagnosis.run)}`),
    );
  if (abandoned.length === 0)
    lines.push("No run is provably abandoned, so nothing was reset.");
  return lines;
}

/**
 * The single writer behind every reconcile, so its exclusions cannot drift.
 * Compare-and-swap on the scanned `updatedAt` with no retry: a run reclaimed
 * since the scan is skipped. Reconciliation itself launches no worker.
 */
async function reconcileRun(
  registry: RunRegistry,
  diagnosis: RunDiagnosis,
  actor = `/exec ${EXEC_ACTION.DOCTOR}`,
): Promise<ReconcileOutcome> {
  // A recovery observation must not revoke a user's stop.
  if (isRecoverableRun(diagnosis.run) || diagnosis.run.userStopped || diagnosis.run.status === RUN_STATUS.PAUSED)
    return { skipped: RECONCILE_SKIP.STOP_REQUESTED };
  const reason = reconcileReason(diagnosis, actor);
  const terminalObserved = diagnosis.evidence.processTerminalProof?.state === "observed" &&
    diagnosis.evidence.processTerminalProof.runId === diagnosis.run.activeOperation?.externalRunId;
  const reconciled = await registry.updateIfCurrent(
    {
      ...diagnosis.run,
      status: diagnosis.run.status === RUN_STATUS.SKIP_PENDING ? RUN_STATUS.SKIP_PENDING : RUN_STATUS.RUNNING,
      ...(terminalObserved && diagnosis.run.activeOperation ? { activeOperation: { ...diagnosis.run.activeOperation, processTreeExited: true } } : {}),
      error: reason,
      wakeReason: reason,
      nextAttemptAt: 0,
      reconciledAt: Date.now(),
    },
    diagnosis.run.updatedAt,
  );
  if (!reconciled.applied) return { skipped: RECONCILE_SKIP.RECLAIMED };
  try {
    await appendProgress(
      reconciled.run,
      `${reason} The task attempt counter was left unchanged.`,
    );
  } catch {
    // An abandoned run often outlived its worktree; the registry entry is the
    // record.
  }
  return { run: reconciled.run };
}

/** Keep the evidence and identity-preservation decision visible in the audit record. */
function reconcileReason(diagnosis: RunDiagnosis, actor: string): string {
  const operation = diagnosis.run.activeOperation;
  return `Reconciled by ${actor}: its lease was dead and ${operationEvidence(diagnosis)}. The existing ${operation ? `${operation.service}/${operation.kind} ` : ""}operation, candidate, and result identity were preserved.`;
}

/**
 * The recovery gate in front of every resume. It reconciles only on the
 * `classifyAbandonment` conjunction, and refuses one shape: an unresolved
 * operation that could not be proven gone. Takes no session, for the reason
 * `isStaleOwner` gives.
 *
 * `sameMachine` unblocks evidence gathering and nothing else, so it cannot
 * force a resume past a worker still writing: only the probe sees the rewritten
 * host. A live local PID still reads LIVE; a proven local handoff records the
 * asserted hostname before the subsequent claim.
 */
export async function reconcileForResume(
  registry: RunRegistry,
  run: PlanExecRun,
  probe: EvidenceProbe = abandonmentProbe(),
  sameMachine = false,
): Promise<{ run: PlanExecRun; note?: string }> {
  if (sameMachine && !isLocalRun(run) &&
    (!isInFlightStatus(run.status) || isRecoverableRun(run) || !run.activeOperation || run.userStopped)) {
    const subject = asLocalRun(run);
    const evidence = await runEvidence(subject, () => probe(subject));
    if (evidence.leaseLive) return { run };
    const operation = run.activeOperation;
    if (operation && !operation.processTreeExited && !operation.launchFenced &&
      classifyAbandonment({ ...subject, status: RUN_STATUS.RUNNING }, evidence) === ABANDONMENT.AMBIGUOUS)
      throw new Error(`Run ${shortRunId(run.id)} evidence is incomplete: its tracked worker has not been proven safe to recover. Nothing was changed.`);
    const rebound = await registry.updateIfCurrent(subject, run.updatedAt);
    if (!rebound.applied)
      throw new Error(`Run ${shortRunId(run.id)} changed while its asserted host was being recorded; nothing was changed. Use /exec status ${run.id}.`);
    return { run: rebound.run, note: `Run ${shortRunId(run.id)} lease rebound to this machine after checking its local owner; its status, stop request, and tracked operations were preserved.` };
  }
  if (!isInFlightStatus(run.status) || isRecoverableRun(run)) return { run };
  // The operator asserted the host, so every text below reads the run that way
  // too. Evidence still has to prove local PID/process-tree termination before
  // the old foreign lease is rebound to this host for the subsequent claim.
  const subject = sameMachine ? asLocalRun(run) : run;
  const evidence = await runEvidence(subject, () => probe(subject));
  const diagnosis: RunDiagnosis = {
    run,
    evidence,
    classification: classifyAbandonment(run, evidence),
  };
  if (diagnosis.classification === ABANDONMENT.LIVE) return { run };
  if (diagnosis.classification === ABANDONMENT.AMBIGUOUS) {
    if (!run.activeOperation) return { run };
    throw new Error(
      `Run ${shortRunId(run.id)} still claims ${run.status} and the evidence is incomplete: ${evidenceText({ run: subject, evidence })}. Resuming could add a second writer, so nothing was changed. ${recoveryGuidance(subject, evidence).action}`,
    );
  }
  const reconciled = await reconcileRun(
    registry,
    diagnosis,
    `/exec ${EXEC_ACTION.RESUME}`,
  );
  if (!reconciled.run)
    throw new Error(
      `Run ${shortRunId(run.id)} was reclaimed while it was being diagnosed, so nothing was changed. Use /exec status ${run.id}.`,
    );
  let recovered = reconciled.run;
  if (sameMachine && recovered.lease) {
    const rebound = await registry.updateIfCurrent(
      {
        ...recovered,
        lease: { ...recovered.lease, hostname: hostname() },
      },
      recovered.updatedAt,
    );
    if (!rebound.applied)
      throw new Error(
        `Run ${shortRunId(run.id)} changed while its asserted host was being recorded; nothing was changed. Use /exec status ${run.id}.`,
      );
    recovered = rebound.run;
  }
  return {
    run: recovered,
    note: `Run ${shortRunId(run.id)} is ready for reconciliation — ${evidenceText(diagnosis)} — and its existing operation and candidate were preserved. No task attempt was consumed.`,
  };
}

function runClaim(run: PlanExecRun): string {
  return `${run.id} ${runLabel(run)} ${run.status}/${run.stage}`;
}

/** A run and what was observed about it; a diagnosis adds the verdict. */
type ObservedRun = Pick<RunDiagnosis, "run" | "evidence">;

function evidenceText(diagnosis: ObservedRun): string {
  const lease = diagnosis.run.lease;
  const leaseText = !lease
    ? "no session holds it"
    : !isLocalRun(diagnosis.run)
      ? `session ${lease.sessionId} retains protected ownership on unobserved host ${lease.hostname}`
      : diagnosis.evidence.leaseLive
      ? `session ${lease.sessionId} holds a live lease`
      : `its lease for session ${lease.sessionId} is dead, last beat ${relativeTime(lease.heartbeatAt)}`;
  return `${leaseText}; ${operationEvidence(diagnosis)}${overdueText(diagnosis)}`;
}

/** Without it a run far past its bound reads like one launched a minute ago. */
function overdueText(diagnosis: ObservedRun): string {
  const run = diagnosis.run;
  const overdue = reportedActivity(run.activeOperation, isLocalRun(run) ? diagnosis.evidence : undefined)
    ? undefined
    : longRunningOperation(run);
  return overdue
    ? `; running ${elapsedLabel(overdue.elapsedMs)}, past the explicit ${minutesLabel(overdue.boundMs)} compatibility deadline`
    : "";
}

function operationEvidence(diagnosis: ObservedRun): string {
  const operation = diagnosis.run.activeOperation;
  if (!operation) return "no operation is tracked";
  if (diagnosis.evidence.neverStarted) return "the original launch was durably fenced before dispatch";
  if (diagnosis.evidence.replaySafe && diagnosis.evidence.bridgeState === EXTERNAL_OPERATION_STATE.ABSENT)
    return "the provider permits only same-ID replay; no worker-exit claim was made";
  if (diagnosis.evidence.asyncDirPresent === false)
    return "its operation directory is gone from disk";
  if (diagnosis.evidence.bridgeState === EXTERNAL_OPERATION_STATE.ABSENT)
    return "the bridge has no record of its operation";
  if (diagnosis.evidence.asyncDirPresent === true)
    return "its operation directory is still on disk";
  // Last, so it cannot mask evidence — but ahead of the generic fallback, which
  // would hide why nothing was gathered.
  if (!isLocalRun(diagnosis.run))
    return `its lease names ${diagnosis.run.lease?.hostname}, not this machine, so nothing here could observe its operation`;
  return "its operation could not be observed";
}

function nextCommand(diagnosis: RunDiagnosis): string {
  return recoveryGuidance(diagnosis.run, diagnosis.evidence).command;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processTerminalFromStatus(
  data: unknown,
): unknown {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.processTerminalProof)) return data.processTerminalProof;
  if (isRecord(data.processTerminal)) return data.processTerminal;
  const details = data.details;
  if (!isRecord(details)) return undefined;
  const lifecycleStatus = details.lifecycleStatus;
  if (!isRecord(lifecycleStatus)) return undefined;
  return lifecycleStatus.processTerminal;
}

function bridgeOperationState(
  data: Record<string, unknown>,
): string | undefined {
  const state = data.state;
  return typeof state === "string" && state.trim() ? state.trim() : undefined;
}

/**
 * `undefined` when the check itself failed. Only ENOENT and ENOTDIR prove a
 * path is not there; EACCES or EIO prove nothing, and absence of evidence must
 * never reach the caller as evidence of absence.
 */
async function pathExists(path: string): Promise<boolean | undefined> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")
      ? false
      : undefined;
  }
}

interface CommandDependencies {
  controller: PlanExecController;
  startBackgroundController: StartBackgroundController;
  syncProjection: SyncProjection;
  checkRuntime: RuntimeCheck;
  runtimeProblems: RuntimeProbe;
  doctorProbe: EvidenceProbe;
  handoff?: typeof handoffToWorktree;
  isSessionClosed?: () => boolean;
  handoffLifecycle?: HandoffLifecycle;
  recordRun?: (run: PlanExecRun) => void;
  mutate?: <T>(operation: () => Promise<T>) => Promise<T>;
}

function mutateCommand<T>(dependencies: CommandDependencies, operation: () => Promise<T>): Promise<T> {
  return dependencies.mutate ? dependencies.mutate(operation) : operation();
}

export function shouldRepairProjectionForSession(
  run: PlanExecRun,
  sessionId: string,
): boolean {
  return (
    run.lease?.sessionId === sessionId ||
    run.taskProjection?.sessionId === sessionId
  );
}

/**
 * Startup may resume a recoverable in-flight run only when it can claim the
 * durable lease. A live lease from another session is observed and left alone;
 * a user pause remains authoritative, while cancel-pending is allowed to
 * finish its cleanup automatically.
 */
export function shouldAutoRestoreRun(
  run: PlanExecRun,
  sessionId: string,
): boolean {
  const pausedCleanup = run.status === RUN_STATUS.PAUSED && (run.localOperationActive === true ||
    Boolean(run.activeOperation && !run.activeOperation.processTreeExited && !run.activeOperation.launchFenced));
  if ((!isInFlightStatus(run.status) && !pausedCleanup) || isTerminal(run.status)) return false;
  if (run.status !== RUN_STATUS.CANCEL_PENDING && !pausedCleanup && run.userStopped === true)
    return false;
  const lease = run.lease;
  if (!lease) return true;
  if (lease.sessionId === sessionId) return true;
  return !isLeaseLive(lease, sessionId);
}

/** Keep polling a paused tracked child until its exit is actually observed. */
export function shouldStopBackgroundController(run: PlanExecRun): boolean {
  return isTerminal(run.status) ||
    (run.status === RUN_STATUS.PAUSED && !run.localOperationActive &&
      (!run.activeOperation || run.activeOperation.processTreeExited === true || run.activeOperation.launchFenced === true));
}

async function repairProjectionForRead(
  args: string[],
  ctx: ExtensionCommandContext,
  syncProjection: SyncProjection,
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const selector = args.find((arg) => !arg.startsWith("--"));
  const selected = selector ? await defaultRegistry.get(selector) : undefined;
  const runs = selected
    ? matchesContext(selected, ctx.cwd) &&
      (selected.lease?.sessionId === sessionId ||
        selected.taskProjection?.sessionId === sessionId)
      ? [selected]
      : []
    : (await defaultRegistry.list()).filter(
        (run) =>
          matchesContext(run, ctx.cwd) &&
          (run.lease?.sessionId === sessionId ||
            run.taskProjection?.sessionId === sessionId),
      );
  for (const run of runs) {
    try {
      await syncProjection(run, { cwd: ctx.cwd, sessionId });
    } catch {
      // The read still reports registry truth when a cache repair cannot land.
    }
  }
}

export async function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: CommandDependencies,
): Promise<string | undefined> {
  const {
    controller,
    startBackgroundController,
    syncProjection,
    checkRuntime,
    runtimeProblems,
    doctorProbe,
  } = dependencies;
  const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
  if (subcommand === EXEC_ACTION.HELP) return execHelp();
  if (subcommand === EXEC_ACTION.CLEANUP)
    return execCleanup(defaultRegistry, rest);
  if (
    subcommand === EXEC_ACTION.STATUS ||
    subcommand === EXEC_ACTION.RUNS ||
    subcommand === EXEC_ACTION.DOCTOR
  )
    await repairProjectionForRead(rest, ctx, syncProjection);
  const read = await execRead(defaultRegistry, subcommand, rest, {
    probe: doctorProbe,
    problems: runtimeProblems,
  });
  if (read !== undefined) return read;
  // The read surface answered everything it could, so the retired doctor verb
  // can only be here with `--reconcile`: the write half of it.
  if (subcommand === EXEC_ACTION.DOCTOR)
    return withAliasNote(
      await execReconcile(defaultRegistry, doctorProbe),
      RECONCILE_ALIAS_NOTE,
    );
  if (subcommand === EXEC_ACTION.STATUS) {
    const target = await resolveRunForAction(
      EXEC_ACTION.STATUS,
      parseStatusArguments(rest).selector,
      ctx,
    );
    // Probes for itself: the persisted digest alone renders an abandoned run
    // exactly like a healthy one.
    return formatRunStatus(target, await runEvidence(target, doctorProbe));
  }
  // Without this the token reads as the first word of a plan path, so the
  // reader gets an isolation prompt and then an unexplained not-found error.
  if (subcommand === REMOVED_START_ACTION)
    throw new Error(
      `/exec ${REMOVED_START_ACTION} was removed. Run /exec ${rest.join(" ") || "<path/to/plan.md>"} instead; bare /exec opens the plan picker.`,
    );
  const dispatched = runActionFor(subcommand);
  if (dispatched) {
    const message = await runAction(dispatched.action, rest, ctx, dependencies);
    if (!dispatched.note) return message;
    return message === undefined
      ? dispatched.note
      : withAliasNote(message, dispatched.note);
  }

  const startArguments = parseStartArguments(args);
  const worktreePath = startArguments.worktreePath
    ? resolve(ctx.cwd, startArguments.worktreePath)
    : undefined;
  const planPath = startArguments.planPath
    ? resolve(worktreePath ?? ctx.cwd, startArguments.planPath)
    : await selectPlan(ctx);
  await checkRuntime();
  const useWorktree = worktreePath === undefined && (await chooseIsolation(ctx));
  if (dependencies.isSessionClosed?.()) return undefined;
  const started = await mutateCommand(dependencies, async () => {
    const run = await controller.start({
      cwd: ctx.cwd,
      planPath,
      useWorktree,
      ...(worktreePath ? { existingWorktree: worktreePath } : {}),
      sessionId: ctx.sessionManager.getSessionId(),
      ...(dependencies.recordRun ? { onRunAllocated: dependencies.recordRun } : {}),
    });
    dependencies.recordRun?.(run);
    return run;
  });
  if (dependencies.isSessionClosed?.()) return undefined;
  const handoff = dependencies.handoff ?? handoffToWorktree;
  const deferredHandoff = started.lanePreparation?.state === "create" &&
    Boolean(ctx.sessionManager.getSessionFile());
  if (!deferredHandoff && await handoff(ctx, started, syncProjection, undefined, false, dependencies.handoffLifecycle)) return undefined;
  if (dependencies.isSessionClosed?.()) return undefined;
  const run = await syncProjection(started, {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
  });
  startBackgroundController(
    run,
    ctx.sessionManager.getSessionId(),
    ctx.cwd,
    ctx,
    deferredHandoff ? async (prepared) => canHandoffPreparedWorktree(prepared) &&
      handoff(ctx, prepared, syncProjection, undefined, true, dependencies.handoffLifecycle) : undefined,
  );
  return `Run ${shortRunId(run.id)} started: ${run.status} (${run.stage})\nbranch: ${run.branch}\nworktree: ${run.worktreeCwd}\nUse /exec status ${run.id} for live progress.`;
}

/**
 * The subcommand's action and, when the name is retired, the note to append.
 * Only `adopt` maps to a different action; every other retired verb kept its
 * behavior and needs nothing but the note.
 */
export function runActionFor(
  subcommand: string | undefined,
): { action: DispatchedAction; note?: string } | undefined {
  if (subcommand === undefined) return undefined;
  const action =
    subcommand === EXEC_ACTION.ADOPT ? EXEC_ACTION.RESUME : subcommand;
  if (!Object.hasOwn(RUN_ACTIONS, action)) return undefined;
  return {
    action: action as DispatchedAction,
    ...(isAliasAction(subcommand) ? { note: ALIAS_NOTES[subcommand] } : {}),
  };
}

function isAliasAction(subcommand: string): subcommand is ExecAliasAction {
  return (EXEC_ALIAS_ACTIONS as readonly string[]).includes(subcommand);
}

async function runAction(
  action: RunAction,
  rest: string[],
  ctx: ExtensionCommandContext,
  dependencies: CommandDependencies,
): Promise<string | undefined> {
  const { startBackgroundController, syncProjection } = dependencies;
  // Only resume takes flags, so only resume parses them.
  const resumeArguments =
    action === EXEC_ACTION.RESUME ? parseResumeArguments(rest) : undefined;
  if (action === EXEC_ACTION.SKIP && (!rest[0] || rest[0] === "--reason"))
    throw skipUsageError();
  // Before resolving a run, so a repository with several candidates does not
  // ask a picker question first and then refuse anyway.
  if (action === EXEC_ACTION.STOP && !ctx.hasUI)
    throw new Error(STOP_REQUIRES_UI);
  const resolved = await resolveRunForAction(
    action,
    resumeArguments ? resumeArguments.selector : rest[0],
    ctx,
    resumeArguments?.adoptCurrentBranch,
  );
  dependencies.recordRun?.(resolved);
  if (dependencies.isSessionClosed?.()) return undefined;
  if (resumeArguments) {
    if (resumeArguments.sameMachine) {
      const refusal = sameMachineRefusal(resolved);
      if (refusal) throw new Error(refusal);
    }
    return resumeRun(resolved, resumeArguments, ctx, dependencies);
  }
  if (action === EXEC_ACTION.SKIP)
    return skipStage(resolved, rest, ctx, dependencies);
  // Ask before claiming: an abandoned dialog must not have taken the lease.
  const outcome =
    action === EXEC_ACTION.STOP
      ? await chooseStopOutcome(resolved, ctx)
      : action;
  const sessionId = ctx.sessionManager.getSessionId();
  if (dependencies.isSessionClosed?.()) return undefined;
  const retiring = retiringSession(resolved);
  const startCleanup = (run: PlanExecRun): void => {
    if (!retiring) {
      startBackgroundController(run, sessionId, ctx.cwd, ctx);
      return;
    }
    // Only the durable stop request crosses a draining controller's live lease.
    void retiring.settled.then(() => restoreRetiredRun(run.id, ctx, startBackgroundController,
      dependencies.isSessionClosed ?? (() => false))).catch(() => undefined);
  };
  if (outcome === EXEC_ACTION.PAUSE) {
    const paused = await syncProjection(
      await mutateCommand(dependencies, async () => requestStatus(
        retiring ? resolved : await defaultRegistry.claim(resolved, sessionId), EXEC_ACTION.PAUSE)),
      { cwd: ctx.cwd, sessionId },
    );
    startCleanup(paused);
    return `Run ${shortRunId(paused.id)} paused; its current attempt is stopping and its checkpoint is preserved. Use /exec resume ${paused.id} to continue after confirmed exit.`;
  }
  const cancelled = await syncProjection(
    await mutateCommand(dependencies, async () => requestStatus(
      retiring ? resolved : await defaultRegistry.claim(resolved, sessionId), EXEC_ACTION.CANCEL)),
    { cwd: ctx.cwd, sessionId },
  );
  startCleanup(cancelled);
  return `Run ${shortRunId(cancelled.id)} marked cancel-pending. Its worktree is preserved.`;
}

async function resumeRun(
  resolved: PlanExecRun,
  options: ResumeOptions,
  ctx: ExtensionCommandContext,
  dependencies: CommandDependencies,
): Promise<string | undefined> {
  if (retiringSession(resolved))
    throw new Error(`Run ${shortRunId(resolved.id)} is finishing its outgoing session's controller tick. Automatic recovery continues after it settles; /exec stop ${resolved.id} can still stop the current attempt.`);
  const {
    controller,
    startBackgroundController,
    syncProjection,
    checkRuntime,
    doctorProbe,
  } = dependencies;
  const sessionId = ctx.sessionManager.getSessionId();
  await checkRuntime();
  if (dependencies.isSessionClosed?.()) return undefined;
  // Before anything else touches the run, so the rest of resume works from a
  // state it has evidence for.
  const recovered = await reconcileForResume(
    defaultRegistry,
    resolved,
    doctorProbe,
    options.sameMachine,
  );
  const run = recovered.run;
  const recoveryModel = await recoveryModelForResume(run, options.model, ctx);
  let retryTask = options.retryTask;
  if (isTaskRetryConfirmationRequired(run) && !retryTask) {
    if (!ctx.hasUI) throw new Error(taskRetryRequiredMessage(run));
    const accepted = await ctx.ui.confirm(
      "Retry externally blocked task?",
      `${taskRetryRequiredMessage(run)}\n\nRetry it now?`,
    );
    if (!accepted) throw new Error("Task retry cancelled.");
    retryTask = true;
  }
  // A branch mismatch cannot advance without rebinding, so an interactive
  // resume asks. The flag stays for callers with no human to ask.
  const adoptCurrentBranch =
    options.adoptCurrentBranch ||
    (ctx.hasUI &&
      hasExecutionBranchMismatch(run) &&
      run.activeOperation === undefined);
  const handedOff = await handoffToWorktree(
    ctx,
    run,
    syncProjection,
    `resume ${run.id}${adoptCurrentBranch ? " --adopt-current-branch" : ""}${retryTask ? ` ${TASK_RETRY_OPTION}` : ""}${recoveryModel ? ` ${RECOVERY_MODEL_OPTION} ${recoveryModel}` : ""}`,
    false,
    dependencies.handoffLifecycle,
  );
  // The forked session re-enters the gate on an already-reset run, so this is
  // the note's only chance to be printed.
  if (handedOff || dependencies.isSessionClosed?.()) return recovered.note;
  if (adoptCurrentBranch) {
    if (!ctx.hasUI)
      throw new Error("Branch adoption requires interactive confirmation.");
    if (run.activeOperation)
      throw new Error(
        "Cannot adopt the current branch while an external operation is tracked.",
      );
    const accepted = await ctx.ui.confirm(
      "Adopt current execution branch?",
      [
        `Run: ${run.id}`,
        `Recorded branch: ${run.branch}`,
        `Worktree: ${run.worktreeCwd}`,
        "The controller will verify the repository, record the actual named branch, and resume the same run.",
      ].join("\n"),
    );
    if (!accepted) throw new Error("Branch adoption cancelled.");
    if (dependencies.isSessionClosed?.()) return recovered.note;
    const rebound = await syncProjection(
      await mutateCommand(dependencies, () => controller.rebindBranchAndResume(run.id, sessionId, run.stopGeneration ?? 0)),
      { cwd: ctx.cwd, sessionId },
    );
    startBackgroundController(rebound, sessionId, ctx.cwd, ctx);
    return `Run ${shortRunId(rebound.id)} adopted branch ${rebound.branch}: ${rebound.status} (${rebound.stage}).\nUse /exec status ${rebound.id} for live progress.`;
  }
  const reviewedPlanHash = await reviewedPlanHashForResume(run, ctx);
  if (dependencies.isSessionClosed?.()) return recovered.note;
  const resumed = await syncProjection(
    await mutateCommand(dependencies, () => controller.resume(
      run.id,
      sessionId,
      true,
      reviewedPlanHash,
      retryTask,
      recoveryModel,
      run.stopGeneration ?? 0,
    )),
    { cwd: ctx.cwd, sessionId },
  );
  startBackgroundController(resumed, sessionId, ctx.cwd, ctx);
  // Reported where the operator asked, not only in the progress file.
  return recovered.note
    ? `${recovered.note}\n${resumeResultMessage(resumed)}`
    : resumeResultMessage(resumed);
}

/** The waiver never reconciles the run: it stops the worker and moves on. */
async function skipStage(
  run: PlanExecRun,
  rest: string[],
  ctx: ExtensionCommandContext,
  dependencies: CommandDependencies,
): Promise<string | undefined> {
  const {
    controller,
    startBackgroundController,
    syncProjection,
    checkRuntime,
  } = dependencies;
  const sessionId = ctx.sessionManager.getSessionId();
  await checkRuntime();
  const reason = parseSkipReason(rest.slice(1));
  const handedOff = await handoffToWorktree(
    ctx,
    run,
    syncProjection,
    `skip ${run.id} --reason ${reason}`,
    false,
    dependencies.handoffLifecycle,
  );
  if (handedOff || dependencies.isSessionClosed?.()) return undefined;
  if (!ctx.hasUI)
    throw new Error("Force-skip requires interactive confirmation.");
  const operation = run.activeOperation;
  const accepted = await ctx.ui.confirm(
    `Force-skip ${run.stage}?`,
    [
      `Run: ${run.id}`,
      `Reason: ${reason}`,
      operation
        ? `Active operation: ${operation.service}/${operation.kind} ${operation.externalRunId ?? operation.operationId}`
        : "Active operation: none",
      `Known findings: ${run.reviewFindings.length}`,
      "The controller will stop any tracked child before advancing.",
      "Final status will be completed_with_findings.",
    ].join("\n"),
  );
  if (!accepted) throw new Error("Force-skip cancelled.");
  if (dependencies.isSessionClosed?.()) return undefined;
  const skipped = await syncProjection(
    await mutateCommand(dependencies, () => controller.skip(run.id, sessionId, reason, run.stopGeneration ?? 0)),
    { cwd: ctx.cwd, sessionId },
  );
  startBackgroundController(skipped, sessionId, ctx.cwd, ctx);
  return `Run ${shortRunId(skipped.id)} force-skip requested: ${skipped.status} (${skipped.stage}).\nUse /exec status ${skipped.id} for live progress.`;
}

/**
 * Offers only the outcomes this run can still take. A single remaining outcome
 * is still asked, never assumed: an unwanted final cancel is the damage this
 * question prevents.
 */
export async function chooseStopOutcome(
  run: PlanExecRun,
  ctx: {
    hasUI: boolean;
    ui: {
      select(title: string, options: string[]): Promise<string | undefined>;
    };
  },
): Promise<typeof EXEC_ACTION.PAUSE | typeof EXEC_ACTION.CANCEL> {
  if (!ctx.hasUI) throw new Error(STOP_REQUIRES_UI);
  const outcomes = STOP_OUTCOMES.filter((outcome) =>
    isActionAllowed(outcome.action, run),
  );
  if (outcomes.length === 0)
    throw new Error(
      `Run ${shortRunId(run.id)} cannot be stopped while ${run.status}.`,
    );
  const labels: string[] = outcomes.map((outcome) => outcome.label);
  const choice = await ctx.ui.select(
    `Stop run ${shortRunId(run.id)} (${run.status}/${run.stage})?`,
    labels,
  );
  if (!choice) throw new Error("Stop cancelled.");
  const selected = outcomes[labels.indexOf(choice)];
  if (!selected) throw new Error("Stop selection returned an unknown outcome.");
  return selected.action;
}

async function resolveRunForAction(
  action: RunAction,
  selector: string | undefined,
  ctx: ExtensionContext,
  adoptCurrentBranch = false,
): Promise<PlanExecRun> {
  if (selector) {
    const run = await defaultRegistry.get(selector);
    if (!run) throw new Error(`Plan execution run not found: ${selector}`);
    assertActionAllowed(action, run, adoptCurrentBranch);
    return run;
  }

  const candidates = (await defaultRegistry.list()).filter(
    (run) =>
      matchesContext(run, ctx.cwd) &&
      isActionAllowed(action, run, adoptCurrentBranch),
  );
  if (candidates.length === 0) {
    const verb =
      action === EXEC_ACTION.STATUS
        ? "matching"
        : action === EXEC_ACTION.RESUME
          ? "resumable"
          : action === EXEC_ACTION.STOP
            ? "stoppable"
            : `${action}able`;
    throw new Error(
      `No ${verb} plan execution run found here. Use /exec status or /exec <plan> to start one.`,
    );
  }
  const preferred = prioritizeRunCandidates(candidates, ctx.cwd);
  if (preferred.length === 1) return preferred[0]!;
  if (!ctx.hasUI) {
    throw new Error(
      `Multiple runs match this repository. Use /exec ${action} <run-id> or /exec status.`,
    );
  }
  const labels = preferred.map(
    (run, index) => `${index + 1}. ${runSelectorLabel(run)}`,
  );
  const choice = await ctx.ui.select(`Select run to ${action}`, labels);
  if (!choice) throw new Error("Run selection cancelled.");
  const index = labels.indexOf(choice);
  const selected = preferred[index];
  if (!selected) throw new Error("Run selection returned an unknown run.");
  return selected;
}

export function prioritizeRunCandidates(
  candidates: PlanExecRun[],
  cwd: string,
): PlanExecRun[] {
  const exactWorktree = candidates.filter(
    (run) => resolve(run.worktreeCwd) === resolve(cwd),
  );
  return exactWorktree.length > 0 ? exactWorktree : candidates;
}

export function canHandoffPreparedWorktree(run: PlanExecRun): boolean {
  return run.status === RUN_STATUS.RUNNING && !run.userStopped &&
    !run.localOperationActive && run.lanePreparation?.state !== "create";
}

async function handoffToWorktree(
  ctx: ExtensionCommandContext,
  run: PlanExecRun,
  syncProjection: SyncProjection,
  followUp?: string,
  automatic = false,
  lifecycle?: HandoffLifecycle,
): Promise<boolean> {
  if (lifecycle?.isClosed()) return false;
  const preparation = lifecycle?.beginPreparation(run.id);
  try {
    return await prepareSessionHandoff(ctx, run, syncProjection, followUp, automatic,
      lifecycle?.isClosed ?? (() => false), preparation?.switchingTo ?? (() => undefined));
  } finally {
    preparation?.finish();
  }
}

async function prepareSessionHandoff(
  ctx: ExtensionCommandContext,
  run: PlanExecRun,
  syncProjection: SyncProjection,
  followUp: string | undefined,
  automatic: boolean,
  isClosed: () => boolean,
  switchingTo: (sessionFile: string) => void,
): Promise<boolean> {
  if (automatic) {
    const current = await defaultRegistry.get(run.id);
    if (!current || !canHandoffPreparedWorktree(current) ||
      (current.stopGeneration ?? 0) !== (run.stopGeneration ?? 0)) return false;
    run = current;
  }
  if (isClosed()) return false;
  if (run.lanePreparation?.state === "create") return false;
  if (resolve(run.worktreeCwd) === resolve(ctx.cwd)) return false;
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) return false;

  const sourceSessionId = ctx.sessionManager.getSessionId();
  // Before the fork, not merely before the release below: `release` deletes any
  // lease without asking, and refusing after the fork would strand a session
  // file for a run that is not going anywhere.
  const refusal = takeoverRefusal(run, sourceSessionId);
  if (refusal) throw new Error(refusal);

  const targetSession = SessionManager.forkFrom(
    sourceSessionFile,
    run.worktreeCwd,
  );
  const targetSessionFile = targetSession.getSessionFile();
  if (!targetSessionFile) {
    throw new Error("Could not create a worktree Pi session.");
  }

  let claimed: PlanExecRun;
  try {
    claimed = await defaultRegistry.claim(
      await defaultRegistry.release(run),
      targetSession.getSessionId(),
    );
  } catch (error: unknown) {
    await restoreSourceLease(run.id, sourceSessionId, targetSession.getSessionId(), isClosed);
    throw error;
  }
  if (isClosed() || (automatic && (!canHandoffPreparedWorktree(claimed) ||
    (claimed.stopGeneration ?? 0) !== (run.stopGeneration ?? 0)))) {
    await restoreSourceLease(run.id, sourceSessionId, targetSession.getSessionId(), isClosed);
    return false;
  }
  switchingTo(targetSessionFile);
  let switched = false;
  try {
    const result = await ctx.switchSession(targetSessionFile, {
      withSession: async (worktreeCtx) => {
        switched = true;
        process.chdir(claimed.worktreeCwd);
        worktreeCtx.ui.notify(
          `Plan-exec switched to its worktree:\n${claimed.worktreeCwd}\nBranch: ${claimed.branch}`,
          "info",
        );
        if (followUp) await worktreeCtx.sendUserMessage(`/exec ${followUp}`);
      },
    });
    if (!result.cancelled) {
      void syncProjection(claimed, { cwd: targetSession.getCwd(), sessionId: targetSession.getSessionId() }).catch(() => undefined);
      return true;
    }
  } catch (error: unknown) {
    if (switched) throw error;
    await restoreSourceLease(run.id, sourceSessionId, targetSession.getSessionId(), isClosed);
    throw error;
  }

  await restoreSourceLease(run.id, sourceSessionId, targetSession.getSessionId(), isClosed);
  return false;
}

async function restoreSourceLease(
  runId: string,
  sourceSessionId: string,
  targetSessionId: string,
  isClosed: () => boolean,
): Promise<void> {
  for (;;) {
    try {
      const current = await defaultRegistry.get(runId);
      if (!current || !isLocalRun(current) || current.lease?.pid !== process.pid ||
        current.lease.sessionId !== targetSessionId) return;
      const released = { ...current };
      delete released.lease;
      const updated = await defaultRegistry.updateIfCurrent(released, current.updatedAt);
      if (!updated.applied) continue;
      if (!isClosed()) await defaultRegistry.claim(updated.run, sourceSessionId);
      return;
    } catch {
      await waitForControllerPoll();
    }
  }
}

function matchesContext(run: PlanExecRun, cwd: string): boolean {
  const current = resolve(cwd);
  return (
    resolve(run.worktreeCwd) === current ||
    isPathWithin(run.repositoryRoot, current)
  );
}

/**
 * Whether this run can take this action at all. No action's permission depends
 * on who is asking: the lease decides liveness, judged from the outside.
 */
export function isActionAllowed(
  action: RunAction,
  run: PlanExecRun,
  adoptCurrentBranch = false,
): boolean {
  if (action === EXEC_ACTION.STATUS) return true;
  // Stop is allowed when either of its outcomes is; the reader picks which.
  if (action === EXEC_ACTION.STOP)
    return STOP_OUTCOMES.some((outcome) =>
      isActionAllowed(outcome.action, run),
    );
  if (action === EXEC_ACTION.PAUSE)
    return (
      run.status === RUN_STATUS.STARTING || run.status === RUN_STATUS.RUNNING
    );
  if (action === EXEC_ACTION.RESUME)
    return adoptCurrentBranch
      ? (!isTerminal(run.status) || run.status === RUN_STATUS.FAILED) &&
          run.activeOperation === undefined
      : run.status === RUN_STATUS.STARTING ||
          run.status === RUN_STATUS.RUNNING ||
          run.status === RUN_STATUS.PAUSED ||
          (run.status === RUN_STATUS.SKIP_PENDING && leaseNamesAnotherHost(run)) ||
          isRecoverableFailure(run) ||
          isClaimableRun(run);
  if (action === EXEC_ACTION.SKIP) return isStageWaiverAvailable(run);
  if (action === EXEC_ACTION.CANCEL)
    return (
      run.pendingStageSkip === undefined &&
      (!isTerminal(run.status) || run.status === RUN_STATUS.FAILED)
    );
  // A verb added to `RunAction` fails to compile here until it is decided.
  // Only a caller outside the type system reaches the refusal below.
  const unhandled: never = action;
  void unhandled;
  return false;
}

/**
 * Whether a waiver is what this run needs: a blocked non-implementation stage
 * that a person must release. The lease never enters it, so `/exec status` can
 * offer the waiver on the same terms `skip` will accept it.
 */
export function isStageWaiverAvailable(run: PlanExecRun): boolean {
  if (isReviewStage(run.stage) && run.config.reviewRequired) return false;
  if (run.stage === RUN_STAGE.FINALIZE) return false;
  return (
    isSkippableStage(run.stage) &&
    (run.status === RUN_STATUS.FAILED ||
      run.status === RUN_STATUS.PAUSED ||
      run.status === RUN_STATUS.SKIP_PENDING)
  );
}

/**
 * A run no live session holds; resume takes it over. Whose name is on the lease
 * never enters it: a Pi restarted under the same session ID left that lease,
 * and is told by `/exec status` to resume the run. A missing lease counts the
 * same as a dead one — a worktree handoff that failed between `release` and
 * `claim` leaves none, and the run would otherwise have no way forward.
 */
function isClaimableRun(run: PlanExecRun): boolean {
  return !isTerminal(run.status) && !hasLiveLease(run);
}

function hasLiveLease(run: PlanExecRun): boolean {
  return Boolean(run.lease && isLeaseLive(run.lease));
}

export function isRecoverableFailure(run: PlanExecRun): boolean {
  return needsPlanStructureReview(run) || isRecoverableRun(run);
}

export function needsPlanStructureReview(run: PlanExecRun): boolean {
  if (isGoalRun(run)) return false;
  return (
    (run.status === RUN_STATUS.PAUSED || run.status === RUN_STATUS.FAILED) &&
    run.error === PLAN_STRUCTURE_CHANGED_ERROR
  );
}

async function recoveryModelForResume(
  run: PlanExecRun,
  requested: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  if (requested) {
    if (run.status !== RUN_STATUS.FAILED)
      throw new Error(
        `${RECOVERY_MODEL_OPTION} is only valid for a failed run.`,
      );
    return resolveRecoveryModel(requested, ctx);
  }
  if (!isModelProviderFailure(run)) return undefined;
  if (!ctx.model)
    throw new Error("No active Pi model is available for recovery.");
  const current = modelReference(ctx.model);
  if (
    !ctx.modelRegistry
      .getAvailable()
      .some((model) => modelReference(model) === current)
  )
    throw new Error(`Current Pi model is not authenticated: ${current}`);
  return current;
}

function resolveRecoveryModel(
  requested: string,
  ctx: ExtensionCommandContext,
): string {
  if (requested === "current") {
    if (!ctx.model) throw new Error("This Pi session has no active model.");
    return modelReference(ctx.model);
  }
  const separator = requested.indexOf("/");
  if (separator <= 0 || separator === requested.length - 1)
    throw new Error(
      `${RECOVERY_MODEL_OPTION} requires current or provider/model.`,
    );
  const provider = requested.slice(0, separator);
  const modelId = requested.slice(separator + 1);
  if (!ctx.modelRegistry.find(provider, modelId))
    throw new Error(`Unknown recovery model: ${requested}`);
  if (
    !ctx.modelRegistry
      .getAvailable()
      .some((model) => model.provider === provider && model.id === modelId)
  )
    throw new Error(`Recovery model is not authenticated: ${requested}`);
  return requested;
}

function modelReference(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Every flag `/exec resume` accepts. A run selector is not one of them. */
type ResumeOptions = {
  adoptCurrentBranch: boolean;
  retryTask: boolean;
  sameMachine: boolean;
  model: string | undefined;
};
type ResumeArguments = ResumeOptions & { selector: string | undefined };

export function parseResumeArguments(args: string[]): ResumeArguments {
  const first = args[0];
  const selector = first?.startsWith("--") ? undefined : first;
  return {
    selector,
    ...parseResumeOptions(selector === undefined ? args : args.slice(1)),
  };
}

export function parseResumeOptions(args: string[]): ResumeOptions {
  const options: ResumeOptions = {
    adoptCurrentBranch: false,
    retryTask: false,
    sameMachine: false,
    model: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--adopt-current-branch") options.adoptCurrentBranch = true;
    else if (arg === TASK_RETRY_OPTION) options.retryTask = true;
    else if (arg === SAME_MACHINE_OPTION) options.sameMachine = true;
    else if (arg === RECOVERY_MODEL_OPTION) {
      const model = args[index + 1];
      if (!model || model.startsWith("--")) throw resumeUsageError();
      options.model = model;
      index += 1;
    } else throw resumeUsageError();
  }
  return options;
}

function resumeUsageError(): Error {
  return new Error(
    `Usage: /exec resume [full-run-id] [--adopt-current-branch] [${TASK_RETRY_OPTION}] [${SAME_MACHINE_OPTION}] [${RECOVERY_MODEL_OPTION} current|provider/model]`,
  );
}

function skipUsageError(): Error {
  return new Error(
    "Usage: /exec skip <full-run-id> --reason <non-empty reason>",
  );
}

export function resumeResultMessage(run: PlanExecRun): string {
  if (needsPlanStructureReview(run))
    return [
      `Run ${shortRunId(run.id)} paused for plan-structure review: ${run.status} (${run.stage}).`,
      `The first resume only recorded the pause. Review ${run.planPath}, restore the original structure or confirm adoption, then run interactive /exec resume ${run.id} again.`,
    ].join("\n");
  const verb =
    run.status === RUN_STATUS.RUNNING && run.activeOperation
      ? "is already running; its tracked worker is being reconciled"
      : "resumed";
  return [
    `Run ${shortRunId(run.id)} ${verb}: ${run.status} (${run.stage}).`,
    `Use /exec status ${run.id} for live progress.`,
  ].join("\n");
}

export function parseSkipReason(args: string[]): string {
  if (args[0] !== "--reason") throw skipUsageError();
  const reason = args.slice(1).join(" ").trim();
  if (!reason) throw skipUsageError();
  return reason;
}

export async function reviewedPlanHashForResume(
  run: PlanExecRun,
  ctx: {
    hasUI: boolean;
    ui: {
      confirm(title: string, message: string): Promise<boolean>;
    };
  },
): Promise<string | undefined> {
  if (!needsPlanStructureReview(run)) return undefined;
  const planPath = requirePlanPath(run);
  const current = await readPlan(planPath);
  if (current.hash !== run.planHash) {
    if (!ctx.hasUI) {
      throw new Error(
        `Run ${shortRunId(run.id)} changed the plan structure. Review ${planPath}, then resume from interactive Pi to confirm adopting the current structure.`,
      );
    }
    const accepted = await ctx.ui.confirm(
      "Adopt changed plan structure?",
      `The saved run expects a different task structure. Adopt the current structure at ${run.planPath} and continue?`,
    );
    if (!accepted) throw new Error("Plan structure adoption cancelled.");
  }
  return current.hash;
}

export async function requestStatus(
  run: PlanExecRun,
  action: typeof EXEC_ACTION.PAUSE | typeof EXEC_ACTION.CANCEL,
  registry: RunRegistry = defaultRegistry,
): Promise<PlanExecRun> {
  let current = run;
  for (let attempt = 0; attempt < COMMAND_CAS_RETRIES; attempt += 1) {
    assertActionAllowed(action, current);
    const requested = await registry.updateIfCurrent(
      {
        ...current,
        userStopped: true,
        nextAttemptAt: 0,
        stopGeneration: (current.stopGeneration ?? 0) + 1,
        status:
          action === EXEC_ACTION.PAUSE
            ? RUN_STATUS.PAUSED
            : RUN_STATUS.CANCEL_PENDING,
      },
      current.updatedAt,
    );
    if (requested.applied) return requested.run;
    current = requested.run;
  }
  throw new Error(
    `Run ${shortRunId(run.id)} changed repeatedly while requesting ${action}.`,
  );
}

function assertActionAllowed(
  action: RunAction,
  run: PlanExecRun,
  adoptCurrentBranch = false,
): void {
  if (!isActionAllowed(action, run, adoptCurrentBranch)) {
    throw new Error(
      `Run ${shortRunId(run.id)} cannot be ${actionPastTense(action)} while ${run.status}.`,
    );
  }
}

function actionPastTense(action: RunAction): string {
  return {
    [EXEC_ACTION.STATUS]: "inspected",
    [EXEC_ACTION.STOP]: "stopped",
    [EXEC_ACTION.PAUSE]: "paused",
    [EXEC_ACTION.RESUME]: "resumed",
    [EXEC_ACTION.SKIP]: "force-skipped",
    [EXEC_ACTION.CANCEL]: "cancelled",
  }[action];
}

function runSelectorLabel(run: PlanExecRun): string {
  return `${runLabel(run)} — ${run.status}/${run.stage} — ${activeOperationLabel(run)} — ${shortRunId(run.id)}`;
}

function activeOperationLabel(run: PlanExecRun): string {
  const operation = run.activeOperation;
  if (!operation) return "idle";
  return operation.taskId
    ? `${operation.kind}, Task ${operation.taskId}`
    : operation.kind;
}

function runState(run: PlanExecRun): RunState {
  return {
    status: run.status,
    stage: run.stage,
    operation: activeOperationLabel(run),
    observation: observationLabel(run),
  };
}

function progressTransition(
  previous: RunState | undefined,
  run: PlanExecRun,
): string | undefined {
  if (!previous) return undefined;
  if (previous.stage !== run.stage)
    return `Plan-exec ${shortRunId(run.id)} advanced: ${previous.stage} → ${run.stage}.`;
  if (previous.operation !== activeOperationLabel(run))
    return `Plan-exec ${shortRunId(run.id)} is now ${activeOperationLabel(run)}.`;
  if (previous.observation !== observationLabel(run))
    return `Plan-exec ${shortRunId(run.id)} ${observationLabel(run)}.`;
  if (previous.status !== run.status)
    return `Plan-exec ${shortRunId(run.id)} is ${run.status}.`;
  return undefined;
}

function observationLabel(run: PlanExecRun): string {
  if (!isLocalRun(run)) return "owner is on an unobserved host";
  const failures = run.activeOperation?.statusFailures;
  return failures
    ? `cannot observe worker (${failures} failed probes)`
    : "polling worker";
}

function compactRunStatus(run: PlanExecRun): string {
  const projection =
    run.taskProjection?.state === "degraded" ? " · projection degraded" : "";
  const summary = taskProjectionSummary(run);
  const taskCount =
    summary.total > 0
      ? ` · tasks ${summary.accepted}/${summary.total}`
      : "";
  return `exec ${run.status} · ${run.stage} · ${activeOperationLabel(run)} · ${observationLabel(run)}${taskCount}${projection}`;
}

/**
 * Render the durable controller snapshot for the native Pi widget. Every line
 * is derived from run.json; pi-tasks is intentionally absent from this path so
 * a broken optional projection cannot block status or recovery.
 */
export function formatRunWidget(
  run: PlanExecRun,
  now = Date.now(),
): string[] {
  if (isGoalRun(run)) {
    const goal = run.goal;
    const lines = [`Goal ${runLabel(run)}  turn ${goal.iteration}  ${run.status}`];
    if (run.activeOperation) lines.push(`Turn ${goal.iteration}: ${activeOperationLabel(run)} · deadline ${executionDeadlineLabel(run)}`);
    else if (run.wakeReason) lines.push(`Run ${run.status}: ${run.wakeReason}`);
    if (goal.lastCheck) lines.push(`Checks: ${goal.lastCheck.failures ? `failing · ${goal.lastCheck.failures.slice(0, GOAL_WIDGET_TAIL_LIMIT)}` : "passing"}`);
    if (run.blocked) lines.push(`Blocked: ${run.blocked.reason}`);
    if (run.nextAttemptAt && run.nextAttemptAt > now)
      lines.push(`Next automatic action: ${relativeTimeAt(run.nextAttemptAt, now)}${run.wakeReason ? ` · ${run.wakeReason}` : ""}`);
    return lines;
  }
  const summary = taskProjectionSummary(run);
  const taskCounts = [
    `${summary.accepted}/${summary.total} accepted`,
    `ready ${summary.ready}`,
    `retry ${summary.retry}`,
    `dependency ${summary.dependency}`,
    `external ${summary.external}`,
  ].join("  ");
  const lines = [`${run.goal !== undefined ? "Goal" : "Plan"} ${runLabel(run)}  ${taskCounts}`];
  const tasks = Object.values(run.tasks ?? {});
  const active = tasks.find(
    (task) =>
      task.state === TASK_EXECUTION_STATE.RUNNING ||
      task.state === TASK_EXECUTION_STATE.VERIFYING,
  );
  const waiting = tasks.find(
    (task) =>
      task.state === TASK_EXECUTION_STATE.RETRY_WAIT ||
      task.state === TASK_EXECUTION_STATE.WAITING_DEPENDENCY ||
      task.state === TASK_EXECUTION_STATE.WAITING_EXTERNAL,
  );
  const dependencyWait = tasks.find(
    (task) => task.state === TASK_EXECUTION_STATE.WAITING_DEPENDENCY,
  );
  if (active) {
    const usage = usageLabel(active.usage);
    const elapsed = active.lastScheduledAt
      ? ` · elapsed ${elapsedLabel(now - active.lastScheduledAt)}`
      : "";
    lines.push(
      `Task ${active.taskId}: ${active.state} · attempts ${active.attempts}${usage}${elapsed} · deadline ${executionDeadlineLabel(run)}`,
    );
  } else if (waiting) {
    const next = waiting.nextAttemptAt
      ? ` · next ${relativeTimeAt(waiting.nextAttemptAt, now)}`
      : "";
    lines.push(
      `Task ${waiting.taskId}: ${waiting.state} · attempts ${waiting.attempts}${next}${waiting.reason ? ` · ${waiting.reason}` : ""}`,
    );
  } else if (run.wakeReason) {
    lines.push(`Run ${run.status}: ${run.wakeReason}`);
  }
  if (run.lanePreparation) {
    lines.push(
      `Lane preparation: Task ${run.lanePreparation.taskId} · ${run.lanePreparation.state}${run.lanePreparation.error ? ` · ${run.lanePreparation.error}` : ""}`,
    );
  }
  if (run.archiveOperation) lines.push(`Archive: ${run.archiveOperation.phase} · attempt ${run.archiveOperation.attempt + 1}${run.archiveOperation.phase === "retired" ? " · owned Git exit confirmed" : " · owned Git exit pending"}`);
  if (run.outputPromotion?.state === EXTERNAL_OPERATION_STATE.PENDING) lines.push(`Output promotion: ${run.outputPromotion.commandStarted ? "owned Git exit pending" : "preparing"}`);
  if (dependencyWait) {
    lines.push(
      `Next automatic action: after task ${dependencyWait.dependsOn.join(", ") || "its prerequisite"} is accepted`,
    );
  } else if (run.nextAttemptAt && run.nextAttemptAt > now)
    lines.push(
      `Next automatic action: ${relativeTimeAt(run.nextAttemptAt, now)}${run.wakeReason ? ` · ${run.wakeReason}` : ""}`,
    );
  const lastVerified = latestVerifiedActivity(run);
  lines.push(
    lastVerified
      ? `Last verified progress: ${new Date(lastVerified).toISOString()}`
      : "Last verified progress: unavailable",
  );
  if (run.lease)
    lines.push(`Owner: Pi/${run.lease.sessionId} · heartbeat ${relativeTimeAt(run.lease.heartbeatAt, now)}`);
  if (run.needsAttention) lines.push("Needs attention: yes; automatic recovery remains scheduled");
  if (run.activeOperation?.diagnostics) {
    const diagnosis = run.activeOperation.diagnostics;
    lines.push(`Runner: ${diagnosis.phase ?? "unavailable"}${diagnosis.currentTool ? ` · ${diagnosis.currentTool}` : ""} · ${diagnosis.assessment}`,
      `Next diagnostic action: ${diagnosis.action} ${relativeTimeAt(diagnosis.nextProbeAt, now)}`);
  }
  const guidance = Object.values(run.activeOperation?.diagnosticActions ?? {}).at(-1);
  if (guidance) lines.push(`Tool guidance: ${guidance.state} · ${guidance.toolCallId} (not a repair confirmation)`);
  if (run.taskProjection?.state === "degraded")
    lines.push(`Projection: unavailable · ${run.taskProjection.error ?? "unknown error"}`);
  const usage = totalUsage(run);
  if (usage) lines.push(`Usage: ${usage}`);
  const reviewRequired = run.config?.reviewRequired === true;
  const reviewBackend = run.config?.reviewBackend ?? "unavailable";
  lines.push(
    `Review: ${reviewRequired ? "required" : "optional"} · ${reviewBackend}`,
    `Lifetime: ${executionLifetimeLabel(run)}`,
    `Details: /exec status ${run.id}`,
  );
  return lines;
}

function usageLabel(
  usage: { inputTokens?: number; outputTokens?: number; cost?: number } | undefined,
): string {
  const formatted = formatUsage(usage);
  return formatted ? ` · ${formatted}` : "";
}

function formatUsage(
  usage: { inputTokens?: number; outputTokens?: number; cost?: number } | undefined,
): string | undefined {
  if (!usage) return undefined;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const parts = tokens > 0 ? [`tokens ${tokens}`] : [];
  if (usage.cost !== undefined) parts.push(`cost ${usage.cost}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function executionDeadlineLabel(run: PlanExecRun): string {
  const lifetime = activeExecutionLifetime(run);
  if (!lifetime) return "unknown (awaiting lifetime evidence)";
  return lifetime?.mode !== "bounded"
    ? "none (unbounded)"
    : `${elapsedLabel(lifetime.timeoutMs)} compatibility mode`;
}

function executionLifetimeLabel(run: PlanExecRun): string {
  const lifetime = activeExecutionLifetime(run);
  if (!lifetime) return "unknown (awaiting lifetime evidence)";
  const operation = run.activeOperation;
  const expected = operation?.expectedLifetime ?? parseExecutionLifetime(operation?.params?.executionLifetime);
  return lifetime?.mode !== "bounded"
    ? operation?.effectiveLifetime?.mode === "unbounded" && expected?.mode === "unbounded" ? "unbounded end-to-end verified" : "unbounded requested"
    : `${elapsedLabel(lifetime.timeoutMs)} compatibility mode`;
}

function totalUsage(run: PlanExecRun): string | undefined {
  const recorded = formatUsage(run.usage);
  if (recorded) return recorded;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let hasCost = false;
  for (const task of Object.values(run.tasks ?? {})) {
    if (task.usage?.inputTokens !== undefined) inputTokens += task.usage.inputTokens;
    if (task.usage?.outputTokens !== undefined) outputTokens += task.usage.outputTokens;
    if (task.usage?.cost !== undefined) {
      cost += task.usage.cost;
      hasCost = true;
    }
  }
  const tokens = inputTokens + outputTokens;
  if (tokens === 0 && !hasCost) return undefined;
  return [
    ...(tokens > 0 ? [`tokens ${tokens}`] : []),
    ...(hasCost ? [`cost ${cost}`] : []),
  ].join(", ");
}

function latestVerifiedActivity(run: PlanExecRun): number | undefined {
  return Object.values(run.tasks ?? {})
    .map((task) => task.lastVerifiedActivityAt)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
}

function relativeTimeAt(timestamp: number, now: number): string {
  const delta = timestamp - now;
  if (delta > 0) return `in ${elapsedLabel(delta)}`;
  return `${elapsedLabel(-delta)} ago`;
}

function boundedPromise<T>(
  promise: Promise<T> | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function pausedMessage(run: PlanExecRun): string {
  return run.blocked
    ? run.blocked.taskId === undefined
      ? `Goal run ${shortRunId(run.id)} paused: ${run.blocked.reason}\nNo automatic retries. Worktree preserved. Resolve the blocker, then use /goal resume ${run.id}.`
      : `Plan execution ${shortRunId(run.id)} paused at Task ${run.blocked.taskId}: ${run.blocked.reason}\nNo automatic retries. Worktree and checkboxes preserved. Resolve the blocker, then use /exec resume ${run.id}; it asks before retrying the same task.`
    : `Plan execution ${shortRunId(run.id)} is paused; the current attempt is stopping and its checkpoint is preserved. Use /exec resume ${run.id} to continue after confirmed exit.`;
}

function terminalMessage(run: PlanExecRun): string {
  if (run.status === RUN_STATUS.FAILED)
    return `Plan execution ${shortRunId(run.id)} failed at ${run.stage}: ${run.error ?? "unknown error"}. Worktree preserved; use /exec status ${run.id}.`;
  if (run.status === RUN_STATUS.COMPLETED_WITH_FINDINGS)
    return `Plan execution ${shortRunId(run.id)} completed with findings. Use /exec status ${run.id} for details.`;
  if (run.status === RUN_STATUS.CANCELLED)
    return `Plan execution ${shortRunId(run.id)} cancelled. Its worktree was preserved.`;
  return `Plan execution ${shortRunId(run.id)} completed.`;
}

export type GoalCommand =
  | { action: "start"; goal: string; checks: string[][] }
  | { action: "help" }
  | { action: "status"; id?: string }
  | { action: "resume"; id?: string }
  | { action: "pause"; id?: string }
  | { action: "cancel"; id?: string };

const GOAL_ACTIONS = new Set<string>([
  EXEC_ACTION.HELP,
  EXEC_ACTION.STATUS,
  EXEC_ACTION.RESUME,
  EXEC_ACTION.PAUSE,
  EXEC_ACTION.STOP,
  EXEC_ACTION.CANCEL,
]);

/** `/goal <text>` starts; a leading verb addresses an existing goal run. */
export function parseGoalCommand(input: string): GoalCommand {
  const trimmed = input.trim();
  if (!trimmed) return { action: "help" };
  const [head, ...rest] = trimmed.split(/\s+/u);
  if (head && GOAL_ACTIONS.has(head)) {
    if (head === EXEC_ACTION.HELP) return { action: "help" };
    const action = head === EXEC_ACTION.STOP ? EXEC_ACTION.PAUSE : head;
    return { action: action as "status" | "resume" | "pause" | "cancel", ...(rest[0] ? { id: rest[0] } : {}) };
  }
  const { goal, checks } = parseGoalChecks(trimmed);
  return { action: "start", goal, checks };
}

/** `--check "npm test"` is repeatable and removed from the goal text. */
export function parseGoalChecks(input: string): { goal: string; checks: string[][] } {
  const checks: string[][] = [];
  const goal = input.replace(
    /--check(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))\s*/gu,
    (_match, doubleQuoted, singleQuoted, bare) => {
      const command = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
      if (command) checks.push(command.split(/\s+/u));
      return " ";
    },
  ).replace(/\s+/gu, " ").trim();
  return { goal, checks };
}

async function resolveGoalRun(id?: string): Promise<PlanExecRun | undefined> {
  if (id) {
    const run = await defaultRegistry.get(id);
    return run && isGoalRun(run) ? run : undefined;
  }
  const { runs } = await defaultRegistry.listWithErrors();
  return runs.filter(isGoalRun).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function goalStatusText(run: PlanExecRun): string {
  if (!isGoalRun(run)) return `Run ${run.id} is not a goal run.`;
  const goal = run.goal;
  const lines = [
    `Goal ${run.id}`,
    `goal: ${goal.text}`,
    `status: ${run.status}`,
    `stage: ${run.stage}`,
    `turn: ${goal.iteration}/${run.config.maxTaskIterations}`,
    `branch: ${run.branch}`,
    `worktree: ${run.worktreeCwd}`,
    `checks: ${run.config.requiredChecks.map((command) => command.join(" ")).join(" · ") || "none"}`,
    `updated: ${new Date(run.updatedAt).toISOString()}`,
  ];
  if (run.blocked) lines.push(`blocked: ${run.blocked.reason}`);
  if (goal.lastCheck) lines.push(`checks: ${goal.lastCheck.failures ? `failing — ${goal.lastCheck.failures}` : "passing"}`);
  if (goal.lastOutcome) lines.push(`last outcome: ${goal.lastOutcome.slice(0, GOAL_STATUS_TAIL_LIMIT)}`);
  if (goal.noProgress) lines.push(`turns without progress: ${goal.noProgress}`);
  if (run.activeOperation) lines.push(`operation: ${run.activeOperation.service}/${run.activeOperation.kind} · ${run.activeOperation.operationId}`);
  return lines.join("\n");
}

export function goalHelp(): string {
  return [
    "/goal <goal text> [--check \"command\"]",
    "                        Pursue the goal autonomously in place. The worktree must be clean and at least one check must exist.",
    "/goal status [run-id]  Show goal progress, checks, blocker, and current turn.",
    "/goal resume [run-id]  Continue after a stop, blocker, or failed turn.",
    "/goal pause [run-id]   Stop scheduling turns; the current turn is stopped and preserved.",
    "/goal cancel [run-id]  Cancel the goal and stop the current turn.",
    "/goal help              Show this list.",
    "",
    "The goal is complete only when the required checks pass on the committed work. Deleting tests or adding skip/only markers pauses completion for confirmation.",
  ].join("\n");
}

export function execSetup(): string {
  return [
    "Install the exact source runtimes pinned by this plan-exec build (project-local settings):",
    ...requiredSetupCommands(),
    "Optional Fusion review backend:",
    sourceInstallCommand("@alexeiled/pi-fusion"),
    "Optional task visibility (not required for execution):",
    "pi install -l npm:@tintinweb/pi-tasks",
    "Keep this plan-exec source build installed; published packages may not expose the required runtime contract yet.",
    "",
    "Then run /reload. Use /exec help for commands.",
  ].join("\n");
}

export function execHelp(): string {
  return [
    "Plan execution commands:",
    "/exec [plan-path]       Start a plan (bare /exec opens the plan picker).",
    "/exec --worktree <path> <plan-path>  Execute a plan in an existing registered worktree.",
    "/exec status [run-id]   No run ID: every run grouped by what it needs, with any missing package and one next command per run. With a run ID: that run in detail.",
    `/exec resume [run-id] [${RECOVERY_MODEL_OPTION} current|provider/model]`,
    "                        Continue a stuck run: take over a dead session's lease while retaining the existing operation and saved result. Explicit pauses require resume; automatic task retries preserve their checkpoints.",
    "/exec stop [run-id]     Stop a run: it asks whether to pause it (resumable) or cancel it (final, worktree preserved).",
    `/exec cleanup [full-run-id] [${CLEANUP_APPLY_OPTION}]`,
    `                        Preview retired runs older than ${CLEANUP_RETENTION_DAYS} days; ${CLEANUP_APPLY_OPTION} deletes their registry entries only.`,
    "/exec skip <full-run-id> --reason <text>",
    "                        Stop the tracked child, waive an optional review or statistics stage, and record why. Required review and final verification cannot be skipped.",
    "/exec help              Show this list.",
    "",
    "Hints:",
    "- Prefer Worktree (isolated) when asked.",
    "- Use --worktree when the plan and branch already exist in a registered worktree; the existing branch and unrelated changes are preserved.",
    "- /exec status reports a missing package with the exact install commands, and diagnoses every run that claims a worker.",
    "- The footer shows live stage and worker progress.",
    "- /exec resume preserves the stage and worktree, and reconciles a known Bridge operation before retrying it.",
    "- /exec resume never starts a second worker: a run whose worker cannot be proven gone is reported, not reset.",
    `- ${RECOVERY_MODEL_OPTION} is an advanced one-recovery-launch override; normal resume uses this Pi session model after a model/provider failure.`,
    "- /exec status spells out the /exec skip command, run ID filled in, for a stage that is blocked; skip keeps its reason and its confirm.",
    "- /exec skip never skips implementation or archive; skipped runs finish as completed_with_findings.",
    "- Worktree runs fork this Pi session into the worktree so the footer and tools use the execution directory.",
    "- Use /skill:exec-plan for the executable-plan format, the recovery rules, and the retired names and flags a scripted agent uses instead of a prompt.",
  ].join("\n");
}

function isTerminal(status: PlanExecRun["status"]): boolean {
  return isTerminalStatus(status);
}

function shortRunId(id: string): string {
  return id.slice(0, DISPLAY_RUN_ID_LENGTH);
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(
    0,
    Math.floor(milliseconds / MILLISECONDS_PER_SECOND),
  );
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h`;
}

/** Minute precision, so a derived bound is never rounded down to a lie. */
function minutesLabel(milliseconds: number): string {
  return `${Math.round(milliseconds / (MILLISECONDS_PER_SECOND * SECONDS_PER_MINUTE))}m`;
}

function relativeTime(timestamp: number): string {
  return `${elapsedLabel(Date.now() - timestamp)} ago`;
}

async function chooseIsolation(ctx: ExtensionContext): Promise<boolean> {
  if (!ctx.hasUI)
    throw new Error(
      "/exec requires interactive Pi to choose worktree isolation.",
    );
  const choice = await ctx.ui.select("Plan execution isolation", [
    "Worktree (isolated)",
    "In-place",
  ]);
  if (!choice)
    throw new Error("Plan execution cancelled before choosing isolation.");
  return choice === "Worktree (isolated)";
}

async function selectPlan(ctx: ExtensionContext): Promise<string> {
  if (!ctx.hasUI) {
    throw new Error("Plan path is required when /exec has no interactive UI.");
  }
  const root = resolve(ctx.cwd, "docs", "plans");
  const files = await findPlanFiles(root);
  if (files.length === 0) {
    throw new Error(`No Markdown plans found under ${root}.`);
  }
  const choice = await ctx.ui.select(
    "Select plan to execute",
    files.map((file) => relative(ctx.cwd, file)),
  );
  if (!choice)
    throw new Error("Plan execution cancelled before selecting a plan.");
  return resolve(ctx.cwd, choice);
}

async function findPlanFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === COMPLETED_PLANS_DIRECTORY) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
