import { access, readdir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { BridgeClient } from "./bridge.js";
import {
  isExternalManualBlocker,
  isModelProviderFailure,
  isTaskRetryConfirmationRequired,
  longRunningOperation,
  MAX_STATUS_FAILURES,
  PLAN_STRUCTURE_CHANGED_ERROR,
  PlanExecController,
  TASK_RETRY_OPTION,
  taskRetryRequiredMessage,
} from "./controller.js";
import { FusionClient } from "./fusion.js";
import {
  isInFlightStatus,
  isRecoverableRun,
  isSkippableStage,
  isTerminalStatus,
} from "./lifecycle.js";
import {
  ABANDONMENT,
  classifyAbandonment,
  isLeaseLive,
  removalRefusal,
  RunRegistry,
  type Abandonment,
  type AbandonmentEvidence,
} from "./registry.js";
import { readPlan } from "./plan.js";
import { appendProgress } from "./progress.js";
import { TaskProjector } from "./task-projection.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  EXEC_ACTION,
  EXTERNAL_OPERATION_STATE,
  OPERATION_SERVICE,
  RUN_STATUS,
  WORKFLOW_MODE,
  type ActiveOperation,
  type ExecAliasAction,
  type PlanExecRun,
  type RunAction,
} from "./types.js";

const registry = new RunRegistry();
const STATUS_KEY = "plan-exec";
const PROVIDER_PROBE_TIMEOUT_MS = 1_500;
const CONTROLLER_POLL_INTERVAL_MS = 1_000;
const COMMAND_CAS_RETRIES = 5;
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const DISPLAY_RUN_ID_LENGTH = 8;
const RECOVERY_MODEL_OPTION = "--model";
const CLEANUP_APPLY_OPTION = "--apply";
const CLEANUP_INCLUDE_FAILED_OPTION = "--include-failed";
const CLEANUP_RETENTION_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;
const CLEANUP_RETENTION_MS = CLEANUP_RETENTION_DAYS * MILLISECONDS_PER_DAY;
const CLEANUP_STATUSES = new Set<PlanExecRun["status"]>([
  RUN_STATUS.COMPLETED,
  RUN_STATUS.COMPLETED_WITH_FINDINGS,
  RUN_STATUS.CANCELLED,
]);
const RUNS_ALL_OPTION = "--all";
/**
 * A retired verb keeps working and says so once. The record is keyed by
 * `ExecAliasAction`, so retiring another name forces a note with it.
 */
const ALIAS_NOTES: Record<ExecAliasAction, string> = {
  [EXEC_ACTION.RUNS]:
    "/exec runs is now /exec status; the old name still works.",
  [EXEC_ACTION.DOCTOR]:
    "/exec doctor is now /exec status; the old name still works.",
  [EXEC_ACTION.SETUP]:
    "/exec setup is now part of /exec status; the old name still works.",
  [EXEC_ACTION.ADOPT]:
    "/exec adopt is now /exec resume; the old name still works.",
};
/** A retired verb that runs its replacement's code path. */
const RUN_ACTION_ALIASES = {
  [EXEC_ACTION.ADOPT]: EXEC_ACTION.RESUME,
} as const satisfies Partial<Record<ExecAliasAction, RunAction>>;
const RUN_ACTIONS = new Set<string>([
  EXEC_ACTION.PAUSE,
  EXEC_ACTION.RESUME,
  EXEC_ACTION.SKIP,
  EXEC_ACTION.CANCEL,
]);
const RUN_LIST_TERMINAL_WINDOW_MS = MILLISECONDS_PER_DAY;
const DOCTOR_RECONCILE_OPTION = "--reconcile";
const REQUIRED_RUNTIME_TOOLS: Record<string, string> = {
  subagent: "pi-subagents",
  TaskCreate: "@tintinweb/pi-tasks",
};
const SETUP_COMMANDS = [
  "pi install npm:pi-subagents",
  "pi install npm:@tintinweb/pi-tasks",
  "pi install npm:@alexeiled/pi-subagents-bridge@>=0.2.2",
  "pi install npm:@alexeiled/pi-fusion",
  "pi install npm:@alexeiled/pi-plan-exec",
];

const EXEC_COMMANDS: AutocompleteItem[] = [
  {
    value: EXEC_ACTION.HELP,
    label: EXEC_ACTION.HELP,
    description: "Show /exec commands and recovery hints",
  },
  {
    value: EXEC_ACTION.SETUP,
    label: EXEC_ACTION.SETUP,
    description: "Show required Pi packages and install commands",
  },
  {
    value: EXEC_ACTION.RUNS,
    label: EXEC_ACTION.RUNS,
    description: "List recent plan execution runs",
  },
  {
    value: EXEC_ACTION.CLEANUP,
    label: EXEC_ACTION.CLEANUP,
    description: "Preview or remove retired run records",
  },
  {
    value: EXEC_ACTION.DOCTOR,
    label: EXEC_ACTION.DOCTOR,
    description: "Diagnose runs that claim work with no live worker",
  },
  {
    value: EXEC_ACTION.STATUS,
    label: EXEC_ACTION.STATUS,
    description: "Show every run and what it needs, or one run in detail",
  },
  {
    value: EXEC_ACTION.PAUSE,
    label: EXEC_ACTION.PAUSE,
    description: "Pause advancing after the active child",
  },
  {
    value: EXEC_ACTION.RESUME,
    label: EXEC_ACTION.RESUME,
    description:
      "Continue the current run safely and reconcile its tracked worker",
  },
  {
    value: EXEC_ACTION.ADOPT,
    label: EXEC_ACTION.ADOPT,
    description: "Adopt a stale run from another session",
  },
  {
    value: EXEC_ACTION.SKIP,
    label: EXEC_ACTION.SKIP,
    description: "Force-skip a blocked non-implementation stage with a reason",
  },
  {
    value: EXEC_ACTION.CANCEL,
    label: EXEC_ACTION.CANCEL,
    description: "Cancel safely and preserve the worktree",
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
) => void;
type RuntimeCheck = () => Promise<void>;
/** Prerequisite problems in report form; empty when every package is present. */
type RuntimeProbe = () => Promise<string[]>;
type SyncProjection = (
  run: PlanExecRun,
  options: { cwd: string; sessionId: string },
) => Promise<PlanExecRun>;

export default function planExecExtension(pi: ExtensionAPI): void {
  const projector = new TaskProjector(registry);
  const projectionQueues = new Map<string, Promise<PlanExecRun>>();
  const syncProjection: SyncProjection = (run, options) => {
    const previous = projectionQueues.get(run.id) ?? Promise.resolve(run);
    const next = previous
      .catch(() => run)
      .then(() => projector.sync(run, options));
    projectionQueues.set(run.id, next);
    void next.finally(() => {
      if (projectionQueues.get(run.id) === next)
        projectionQueues.delete(run.id);
    });
    return next;
  };
  const bridge = new BridgeClient(pi.events);
  const fusion = new FusionClient(pi.events);
  const controller = new PlanExecController(
    registry,
    bridge,
    fusion,
    async (command, args, cwd) => {
      const result = await pi.exec(command, args, { cwd });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      };
    },
  );

  // A diagnosis must never hang: /exec doctor is the first step after a restart,
  // which is exactly when the bridge may not be up yet. It gets the same short
  // budget as the runtime probe, and no answer is simply no evidence.
  const doctorProbe = abandonmentProbe(async (operationId) => {
    const lookup = await new BridgeClient(
      pi.events,
      PROVIDER_PROBE_TIMEOUT_MS,
    ).operation(operationId);
    return lookup.success ? bridgeOperationState(lookup.data) : undefined;
  });

  const activeControllers = new Map<string, ReturnType<typeof setInterval>>();
  const inFlightControllers = new Set<string>();
  const lastStates = new Map<string, RunState>();
  const setStatus = (run: PlanExecRun, ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, compactRunStatus(run));
    ctx.ui.setWidget(STATUS_KEY, [
      `Plan worktree: ${run.worktreeCwd}`,
      `Git branch: ${run.branch}  ·  use !git status --short --branch for details`,
    ]);
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
    try {
      ctx.ui.notify(message, level);
    } catch {
      // UI can disappear during reload or shutdown; the registry remains authoritative.
    }
  };
  const handleBackgroundFailure = async (
    runId: string,
    sessionId: string,
    cwd: string,
    ctx: ExtensionContext,
    error: unknown,
  ): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const failed = await controller.markFailed(runId, error);
      if (!failed) {
        notify(
          ctx,
          `Plan execution ${shortRunId(runId)} stopped: ${message}`,
          "error",
        );
        return;
      }
      setStatus(failed, ctx);
      try {
        await syncProjection(failed, { sessionId, cwd });
      } catch {
        // A projection failure must not hide the persisted controller failure.
      }
      notify(
        ctx,
        `Plan execution ${shortRunId(failed.id)} failed at ${failed.stage}: ${failed.error ?? message}. Worktree preserved. Use /exec status ${failed.id} to inspect it.`,
        "error",
      );
    } catch (markError: unknown) {
      const detail =
        markError instanceof Error ? markError.message : String(markError);
      notify(
        ctx,
        `Plan execution ${shortRunId(runId)} failed and could not be recorded: ${detail}.`,
        "error",
      );
    }
  };
  // Reported, not thrown: /exec status prints the same problems next to the
  // install commands, so a missing package is visible without a separate verb.
  const runtimeProblems: RuntimeProbe = async () => {
    const missingTools = missingRuntimeTools(
      pi.getAllTools().map((tool) => tool.name),
    );
    if (missingTools.length > 0) return [`missing: ${missingTools.join(", ")}`];
    const [bridgeReply, fusionReply] = await Promise.all([
      new BridgeClient(pi.events, PROVIDER_PROBE_TIMEOUT_MS).ping(),
      new FusionClient(pi.events, PROVIDER_PROBE_TIMEOUT_MS).ping(),
    ]);
    const missing: string[] = [];
    const incompatible: string[] = [];
    if (!bridgeReply.success) missing.push("@alexeiled/pi-subagents-bridge");
    else if (
      !hasBridgeOperationMethod(bridgeReply.data) ||
      !hasBridgeWorkflowScriptSpawnCapability(bridgeReply.data)
    )
      incompatible.push("@alexeiled/pi-subagents-bridge >=0.2.2");
    if (!fusionReply.success) missing.push("@alexeiled/pi-fusion");
    return [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(incompatible.length > 0
        ? [`incompatible: ${incompatible.join(", ")}`]
        : []),
    ];
  };
  const checkRuntime: RuntimeCheck = async () => {
    const problems = await runtimeProblems();
    if (problems.length > 0)
      throw new Error(
        `${prerequisiteProblem(problems)} Use /exec status for the install commands, then /reload.`,
      );
  };
  const startBackgroundController: StartBackgroundController = (
    initialRun,
    sessionId,
    cwd,
    ctx,
  ): void => {
    const runId = initialRun.id;
    if (activeControllers.has(runId)) return;
    lastStates.set(runId, runState(initialRun));
    setStatus(initialRun, ctx);
    const timer = setInterval(() => {
      if (inFlightControllers.has(runId)) return;
      inFlightControllers.add(runId);
      void controller
        .resume(runId, sessionId, false)
        .then((run) => syncProjection(run, { sessionId, cwd }))
        .then((run) => {
          setStatus(run, ctx);
          const previous = lastStates.get(runId);
          lastStates.set(runId, runState(run));
          if (isTerminal(run.status)) {
            stopBackgroundController(runId);
            const level: NotificationLevel =
              run.status === RUN_STATUS.FAILED ? "error" : "info";
            notify(ctx, terminalMessage(run), level);
          } else if (run.status === RUN_STATUS.PAUSED) {
            stopBackgroundController(runId);
            notify(
              ctx,
              `Plan execution ${shortRunId(run.id)} is paused. Use /exec resume ${run.id} to continue.`,
              "warning",
            );
          } else {
            const transition = progressTransition(previous, run);
            if (transition) notify(ctx, transition, "info");
          }
          return run;
        })
        .catch((error: unknown) => {
          stopBackgroundController(runId);
          void handleBackgroundFailure(runId, sessionId, cwd, ctx, error);
        })
        .finally(() => inFlightControllers.delete(runId));
    }, CONTROLLER_POLL_INTERVAL_MS);
    timer.unref();
    activeControllers.set(runId, timer);
  };

  pi.registerCommand("exec", {
    description:
      "Execute a checked Markdown plan with worktree isolation, progress, reviews, and recovery; use /exec help for commands",
    getArgumentCompletions: getExecArgumentCompletions,
    handler: async (args, ctx) => {
      try {
        const message = await handleCommand(args.trim(), ctx, {
          controller,
          startBackgroundController,
          syncProjection,
          checkRuntime,
          runtimeProblems,
          doctorProbe,
        });
        if (message) ctx.ui.notify(message, "info");
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const { runs, errors } = await registry.listWithErrors();
    if (errors.length > 0)
      notify(
        ctx,
        `Ignored ${errors.length} corrupt plan-exec run record${errors.length === 1 ? "" : "s"}: ${errors.map((error) => shortRunId(error.runId)).join(", ")}.`,
        "warning",
      );
    for (const run of runs) {
      if (
        !isTerminal(run.status) &&
        run.lease?.sessionId === sessionId &&
        matchesContext(run, ctx.cwd)
      ) {
        startBackgroundController(run, sessionId, ctx.cwd, ctx);
      }
    }
    // Read-only on purpose: startup reports what it found and points at the
    // command that can act, and never writes. A diagnosis failure is advisory,
    // so it must not take the session down with it.
    try {
      const notice = abandonedRunsNotice(await sweepAbandonment(registry));
      if (notice) notify(ctx, notice, "warning");
    } catch {
      // Startup diagnosis is advisory; the registry stays authoritative.
    }
  });

  pi.on("session_shutdown", () => {
    for (const timer of activeControllers.values()) clearInterval(timer);
    activeControllers.clear();
    inFlightControllers.clear();
    lastStates.clear();
    // Status is session-scoped in Pi, so the next session starts clean.
  });
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

type RecoveryGuidance = {
  classification: string;
  action: string;
};

export function recoveryGuidance(run: PlanExecRun): RecoveryGuidance {
  if (isTerminal(run.status) && run.status !== RUN_STATUS.FAILED)
    return {
      classification: "terminal",
      action: "Run is terminal; no recovery action is available.",
    };
  // Only when nothing is tracked: a dead owner holding an unresolved operation
  // is answered by the operation branches below, which know whether that
  // operation is gone. Naming a takeover here would recommend a resume the
  // recovery gate then refuses.
  if (
    isStaleOwner(run) &&
    run.status !== RUN_STATUS.FAILED &&
    !run.activeOperation
  )
    return {
      classification: "stale owner",
      action: `Confirm the prior session stopped, then use /exec resume ${run.id}; it takes the lease over from the dead session.`,
    };
  if (hasExecutionBranchMismatch(run))
    return {
      classification: "execution-branch mismatch",
      action: `Review the current branch, then use interactive /exec resume ${run.id}; it asks before rebinding the run to the branch you are on.`,
    };
  if (needsPlanStructureReview(run))
    return {
      classification: "plan-structure review required",
      action: `Restore the original structure, or use interactive /exec resume ${run.id} to adopt the current plan. If the first resume only records this pause, a second resume is required after review.`,
    };
  if (run.status === RUN_STATUS.SKIP_PENDING)
    return {
      classification: "force-skip reconciliation pending",
      action:
        "Wait for the tracked child to become terminal; use /exec status. Do not resume or start another child.",
    };
  if (run.status === RUN_STATUS.CANCEL_PENDING)
    return {
      classification: "cancel-pending",
      action: `Wait and use /exec status ${run.id}; /exec resume ${run.id} retries cancellation only and cannot launch plan work.`,
    };
  if (run.activeOperation && !run.activeOperation.externalRunId)
    return {
      classification: "preserved unknown operation",
      action:
        "Repair the provider and reconcile the preserved operation; never launch a replacement worker while its outcome is unknown. Do not resume blindly.",
    };
  if (run.status === RUN_STATUS.RUNNING || run.status === RUN_STATUS.STARTING) {
    if (run.activeOperation?.statusFailures)
      return {
        classification: "active operation observation unavailable",
        action:
          "Repair the provider and wait for observation to recover; do not resume while the operation identity is preserved.",
      };
    // A stored `running` claim is not evidence. Only a trustworthy activity
    // signal earns the word "healthy"; anything else says so in words, because
    // absence of signal read as health is the bug this branch exists to fix.
    if (run.activeOperation) {
      const signal = run.activeOperation.workerSignal;
      if (signal?.asyncDirMissing)
        return {
          classification: "active operation directory is gone",
          action: `The operation's async directory no longer exists, so the worker is not running. Use /exec resume ${run.id}; it resets the abandoned operation before continuing, without launching a second worker. Use /exec cancel ${run.id} instead to stop the run and preserve the worktree.`,
        };
      // Elapsed time is weaker evidence than a fresh activity value, so the
      // bound only speaks when nothing else does. It prompts a look; it never
      // claims the worker is dead.
      const overdue = signal?.activity ? undefined : longRunningOperation(run);
      if (overdue)
        return {
          classification: "long-running active operation",
          action: `The bridge still reports this operation running ${elapsedLabel(overdue.elapsedMs)} after launch, past the ${minutesLabel(overdue.boundMs)} allowed for its ${overdue.maxTurns}-turn budget, and no per-turn activity signal is available${signal?.mode === WORKFLOW_MODE ? " for a workflow-mode run" : ""}. That is not proof the worker is stuck. Use /exec status ${run.id} to re-check, or /exec cancel ${run.id} to stop it and preserve the worktree. Do not resume or start a second run.`,
        };
      if (!signal?.activity)
        return {
          classification: "active operation, worker liveness unverified",
          action: `wait and use /exec status ${run.id} to re-check; no per-turn activity signal is available${signal?.mode === WORKFLOW_MODE ? " for a workflow-mode run" : ""}, so this worker is neither confirmed alive nor confirmed dead. do not resume or start another run.`,
        };
      return {
        classification: "healthy active operation",
        action:
          "wait; the controller is polling this operation. do not resume or start another run.",
      };
    }
    return {
      classification: "controller advancing",
      action: "Wait for the next controller tick, then use /exec status.",
    };
  }
  if (run.status === RUN_STATUS.PAUSED)
    return {
      classification: "paused review",
      action: `Use /exec resume ${run.id}; it applies the paused stage or its terminal child without starting a second writer.`,
    };
  if (run.status === RUN_STATUS.FAILED) {
    if (isModelProviderFailure(run))
      return {
        classification: "model/provider failure",
        action: `Use /exec resume ${run.id}. It retries the failed child with the current authenticated Pi model without consuming another task attempt.`,
      };
    if (isExternalManualBlocker(run))
      return {
        classification: "external/manual blocker",
        action: `${taskRetryRequiredMessage(run)} Do not use force-skip: implementation is sequential.`,
      };
    if (isTaskRetryConfirmationRequired(run))
      return {
        classification: "retry-exhausted or no-progress task",
        action: taskRetryRequiredMessage(run),
      };
    if (run.activeOperation?.externalRunId)
      return {
        classification: "preserved operation needs reconciliation",
        action: `Use /exec resume ${run.id}; it reconciles ${run.activeOperation.service}/${run.activeOperation.kind} before any retry in the preserved worktree.`,
      };
    return {
      classification: "failed with no active operation",
      action: `Use /exec resume ${run.id}; it retries the same stage (${run.stage}) in the preserved worktree.`,
    };
  }
  return {
    classification: "unclassified",
    action:
      "Use /exec status again or /exec help; no recovery action is inferred.",
  };
}

function isStaleOwner(run: PlanExecRun): boolean {
  // No session argument: status guidance describes the lease from the outside,
  // so ownership is never assumed. The predicate is otherwise the one `claim`
  // uses, so guidance and claiming cannot disagree.
  return Boolean(run.lease && !isLeaseLive(run.lease));
}

function hasExecutionBranchMismatch(run: PlanExecRun): boolean {
  return /Execution directory is on .+, expected .+\./.test(run.error ?? "");
}

export function formatRunStatus(run: PlanExecRun): string {
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
    `plan: ${run.planPath}`,
    `status: ${run.status}`,
    `stage: ${run.stage}`,
    `operation: ${operationText}`,
    `branch: ${run.branch}`,
    `worktree: ${run.worktreeCwd}`,
    `updated: ${new Date(run.updatedAt).toISOString()}`,
  ];
  if (operation) lines.push(`operation ID: ${operation.operationId}`);
  if (operation?.externalRunId)
    lines.push(`external run ID: ${operation.externalRunId}`);
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
  if (operation?.lastObservedAt)
    lines.push(
      `last observation: ${new Date(operation.lastObservedAt).toISOString()}`,
    );
  lines.push(...workerSignalLines(operation));
  if (operation?.statusFailures) {
    lines.push(
      `observation: unavailable (${operation.statusFailures}/${MAX_STATUS_FAILURES}); retrying${operation.lastStatusError ? ` — ${operation.lastStatusError}` : ""}`,
    );
  }
  if (operation?.skipFailures) {
    lines.push(
      `force-skip reconciliation: failed (${operation.skipFailures}/${MAX_STATUS_FAILURES}); retrying${operation.lastSkipError ? ` — ${operation.lastSkipError}` : ""}`,
    );
  } else if (operation && !operation.statusFailures) {
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
  const guidance = recoveryGuidance(run);
  lines.push(`recovery: ${guidance.classification}`);
  if (isStaleOwner(run))
    lines.push(
      `owner: stale lease for ${run.lease?.sessionId ?? "unknown session"}; verify it is stopped before ${run.status === RUN_STATUS.FAILED ? "recovery" : "adoption"}.`,
    );
  lines.push(`next safe action: ${guidance.action}`);
  return lines.join("\n");
}

/**
 * Report what the provider actually said about the worker. Nothing here may
 * read as health on its own: with no trustworthy activity value the line
 * states the absence instead of staying silent.
 */
function workerSignalLines(operation: ActiveOperation | undefined): string[] {
  if (!operation) return [];
  const signal = operation.workerSignal;
  const since = operation.launchStartedAt
    ? `, ${elapsedLabel(Date.now() - operation.launchStartedAt)} since launch`
    : "";
  const lines = [
    signal?.asyncDirMissing
      ? `worker: operation directory is gone; the operation is not running${since}`
      : signal?.activity
        ? `worker: ${signal.activity}${since}`
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
 * A terminal run stops being news once it is a day old, so hidden rows are
 * counted in a footer rather than dropped silently.
 */
export function settledRunLines(
  runs: PlanExecRun[],
  showAll = false,
): string[] {
  const visible = showAll ? runs : runs.filter(isRecentlyRelevantRun);
  const hidden = runs.length - visible.length;
  return [
    ...runGroupLines(
      "waiting for you — no worker is running",
      visible.filter(needsOperator),
    ),
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
  if (runs.length === 0) return [];
  return [
    `${heading}:`,
    ...runs.map(
      (run) =>
        `- ${runClaim(run)} updated ${relativeTime(run.updatedAt)}. Next: ${nextRunCommand(run)}`,
    ),
  ];
}

/** A settled run that a person still has to move; everything else is history. */
function needsOperator(run: PlanExecRun): boolean {
  return run.status === RUN_STATUS.PAUSED || isRecoverableFailure(run);
}

function nextRunCommand(run: PlanExecRun): string {
  return needsOperator(run)
    ? `/exec resume ${run.id}`
    : `/exec status ${run.id}`;
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

function parseRunsArguments(args: string[]): boolean {
  for (const arg of args)
    if (arg !== RUNS_ALL_OPTION)
      throw new Error(`Usage: /exec runs [${RUNS_ALL_OPTION}]`);
  return args.includes(RUNS_ALL_OPTION);
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
 * `failed` is excluded by default: /exec resume is the documented recovery path
 * for a failed run, and its registry entry is what makes that path possible.
 */
export function isRemovableRun(
  run: PlanExecRun,
  includeFailed = false,
): boolean {
  if (removalRefusal(run)) return false;
  if (
    !CLEANUP_STATUSES.has(run.status) &&
    !(includeFailed && run.status === RUN_STATUS.FAILED)
  )
    return false;
  return Date.now() - run.updatedAt >= CLEANUP_RETENTION_MS;
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
  const failedHint = includeFailed
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
      `No plan execution runs are removable. A terminal run becomes removable ${CLEANUP_RETENTION_DAYS} days after its last update.`,
      ...failedHint,
    ].join("\n");
  const rows = targets.map(
    (run) =>
      `${run.id} ${basename(run.planPath)} ${run.status}/${run.stage} updated ${relativeTime(run.updatedAt)}`,
  );
  if (!apply)
    return [
      "Removable plan execution runs (preview; nothing was deleted):",
      ...rows,
      "Removal deletes the registry entry only; the worktree, branch, and progress file are left in place.",
      ...failedHint,
      `Use /exec cleanup ${runId ? `${runId} ` : ""}${CLEANUP_APPLY_OPTION}${includeFailed ? ` ${CLEANUP_INCLUDE_FAILED_OPTION}` : ""} to remove them.`,
    ].join("\n");
  for (const run of targets) await registry.remove(run.id);
  return [
    `Removed ${targets.length} plan execution run${targets.length === 1 ? "" : "s"}; worktrees, branches, and progress files were left in place.`,
    ...rows,
  ].join("\n");
}

/**
 * A record the registry cannot parse has nothing left to protect: `list` drops
 * it, so removal is the only action that applies to it.
 */
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
  await registry.remove(unreadable.runId);
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
 * Filesystem evidence always; the bridge is asked only when a lookup is wired
 * in and the cheap check was not already decisive. Both are read-only, and a
 * lookup that cannot answer yields no evidence rather than a false verdict.
 */
export function abandonmentProbe(
  lookupOperationState?: (operationId: string) => Promise<string | undefined>,
): EvidenceProbe {
  return async (run) => {
    const operation = run.activeOperation;
    if (!operation) return {};
    const asyncDirPresent = operation.asyncDir
      ? await pathExists(operation.asyncDir)
      : undefined;
    if (asyncDirPresent === false) return { asyncDirPresent };
    const bridgeState =
      lookupOperationState && operation.service === OPERATION_SERVICE.BRIDGE
        ? await lookupOperationState(operation.operationId).catch(
            () => undefined,
          )
        : undefined;
    return {
      ...(asyncDirPresent === undefined ? {} : { asyncDirPresent }),
      ...(bridgeState ? { bridgeState } : {}),
    };
  };
}

/**
 * Diagnose every run that claims work in flight. Read-only by construction: it
 * observes and classifies and writes nothing, so extension startup can call it.
 */
export async function sweepAbandonment(
  registry: RunRegistry,
  probe: EvidenceProbe = abandonmentProbe(),
): Promise<AbandonmentSweep> {
  const { runs, errors } = await registry.listWithErrors();
  const claiming = runs.filter((run) => isInFlightStatus(run.status));
  const diagnoses = await Promise.all(
    claiming.map(async (run) => {
      const leaseLive = Boolean(run.lease && isLeaseLive(run.lease));
      const evidence: AbandonmentEvidence = leaseLive
        ? { leaseLive }
        : { leaseLive, ...(await probe(run)) };
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
 * The whole read surface, with its registry injected so no caller can reach
 * the real one by accident. Returns undefined when the subcommand is not a
 * read command, and when `status` named a run the caller must resolve against
 * its own session.
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
  if (subcommand === EXEC_ACTION.DOCTOR)
    return withAliasNote(
      await execDoctor(registry, rest, sources.probe),
      parseDoctorArguments(rest).reconcile
        ? `/exec doctor ${DOCTOR_RECONCILE_OPTION} still works for scripted callers; /exec status reports the same diagnosis without writing.`
        : ALIAS_NOTES[EXEC_ACTION.DOCTOR],
    );
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
 * One read for "what is going on": every run, grouped by what it needs, each
 * row ending in a single next command. Listing, diagnosis, and the missing
 * package report are the same question at different zoom levels, so they are
 * one answer; `--all` is the zoom control.
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
  lines.push(
    `Plan execution runs: ${total}${inFlight > 0 ? ` (${inFlight} claiming work in flight)` : ""}`,
    ...groupLines(
      "abandoned — no worker is running",
      diagnosisGroup(sweep, ABANDONMENT.ABANDONED),
      "Each resets to a recoverable failure before it continues; no second worker is launched.",
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
    ...SETUP_COMMANDS,
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

function diagnosisGroup(
  sweep: AbandonmentSweep,
  classification: Abandonment,
): RunDiagnosis[] {
  return sweep.diagnoses.filter(
    (diagnosis) => diagnosis.classification === classification,
  );
}

/**
 * Retired: the read-only sweep is /exec status. Only the write half still lives
 * here, so a scripted `--reconcile` caller keeps working until it moves to
 * /exec resume.
 */
export async function execDoctor(
  registry: RunRegistry,
  args: string[],
  probe?: EvidenceProbe,
): Promise<string> {
  const { reconcile } = parseDoctorArguments(args);
  if (!reconcile) return execStatus(registry, probe ? { probe } : {});
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
      diagnosisGroup(sweep, ABANDONMENT.ABANDONED),
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
  if (diagnoses.length === 0) return [];
  return [
    `${heading}:`,
    ...diagnoses.map(
      (diagnosis) =>
        `- ${runClaim(diagnosis.run)} — ${evidenceText(diagnosis)}. Next: ${nextCommand(diagnosis)}`,
    ),
    ...(footer ? [footer] : []),
  ];
}

async function reconcileLines(
  registry: RunRegistry,
  abandoned: RunDiagnosis[],
): Promise<string[]> {
  const reset: Array<{ diagnosis: RunDiagnosis; run: PlanExecRun }> = [];
  const skipped: RunDiagnosis[] = [];
  for (const diagnosis of abandoned) {
    const run = await reconcileRun(registry, diagnosis);
    if (run) reset.push({ diagnosis, run });
    else skipped.push(diagnosis);
  }
  const lines: string[] = [];
  if (reset.length > 0)
    lines.push(
      `Reset ${reset.length} abandoned run${reset.length === 1 ? "" : "s"} to failed. No worker was launched and no task attempt was consumed.`,
      ...reset.map(
        ({ diagnosis }) =>
          `- ${runClaim(diagnosis.run)} → failed. Next: ${recoveryCommand(diagnosis.run)}`,
      ),
    );
  if (skipped.length > 0)
    lines.push(
      `Skipped ${skipped.length} run${skipped.length === 1 ? "" : "s"} reclaimed while the sweep ran; nothing was overwritten:`,
      ...skipped.map((diagnosis) => `- ${runClaim(diagnosis.run)}`),
    );
  if (reset.length === 0 && skipped.length === 0)
    lines.push("No run is provably abandoned, so nothing was reset.");
  return lines;
}

/**
 * Convert decisive evidence into the recoverable failure that /exec resume
 * already knows how to handle, and stop there. Compare-and-swap on the scanned
 * `updatedAt`, with no retry: a run reclaimed between the scan and this write
 * is skipped, never overwritten. `taskAttempts` is untouched because the worker
 * never ran, so the operator must not lose an attempt.
 */
async function reconcileRun(
  registry: RunRegistry,
  diagnosis: RunDiagnosis,
  actor = `/exec ${EXEC_ACTION.DOCTOR}`,
): Promise<PlanExecRun | undefined> {
  const reason = reconcileReason(diagnosis, actor);
  const reset = { ...diagnosis.run };
  delete reset.activeOperation;
  const reconciled = await registry.updateIfCurrent(
    {
      ...reset,
      status: RUN_STATUS.FAILED,
      error: reason,
      reconciledAt: Date.now(),
    },
    diagnosis.run.updatedAt,
  );
  if (!reconciled.applied) return undefined;
  try {
    await appendProgress(
      reconciled.run,
      `${reason} The task attempt counter was left unchanged.`,
    );
  } catch {
    // An abandoned run often outlived its worktree; the registry entry is the record.
  }
  return reconciled.run;
}

/**
 * Name the evidence in the stored error, so the reset is legible later. Worded
 * to describe this reconciliation only: recovery classification reads run.error
 * back, and a stray "provider" or "external" here would reclassify the run.
 */
function reconcileReason(diagnosis: RunDiagnosis, actor: string): string {
  const operation = diagnosis.run.activeOperation;
  return `Reset by ${actor}: its lease was dead and ${operationEvidence(diagnosis)}, so no worker was running${operation ? ` for ${operation.service}/${operation.kind}` : ""}.`;
}

/**
 * The recovery gate in front of every resume. It reconciles only on Task 8's
 * full conjunction — an in-flight claim, a dead lease, and a tracked operation
 * provably gone — and otherwise leaves the record exactly as it found it.
 *
 * Statuses resume already recovers (`failed`, `cancel_pending`) pass straight
 * through: resetting a cancel-pending run would drop the cancellation it is
 * carrying. A run with nothing tracked also passes through — nothing can
 * double-write when no operation exists, and claiming it is what the retired
 * `/exec adopt` did. What is refused is the one shape that could add a second
 * writer: an unresolved operation that could not be proven gone.
 */
export async function reconcileForResume(
  registry: RunRegistry,
  run: PlanExecRun,
  sessionId: string,
  probe: EvidenceProbe = abandonmentProbe(),
): Promise<{ run: PlanExecRun; note?: string }> {
  if (!isInFlightStatus(run.status) || isRecoverableRun(run)) return { run };
  const leaseLive = Boolean(run.lease && isLeaseLive(run.lease, sessionId));
  const evidence: AbandonmentEvidence = leaseLive
    ? { leaseLive }
    : { leaseLive, ...(await probe(run)) };
  const diagnosis: RunDiagnosis = {
    run,
    evidence,
    classification: classifyAbandonment(run, evidence),
  };
  if (diagnosis.classification === ABANDONMENT.LIVE) return { run };
  if (diagnosis.classification === ABANDONMENT.AMBIGUOUS) {
    if (!run.activeOperation) return { run };
    throw new Error(
      `Run ${shortRunId(run.id)} still claims ${run.status} and the evidence is incomplete: ${evidenceText(diagnosis)}. Resuming could add a second writer, so nothing was changed. Use /exec status ${run.id} to re-check, or /exec cancel ${run.id} to stop it and preserve the worktree.`,
    );
  }
  const reconciled = await reconcileRun(
    registry,
    diagnosis,
    `/exec ${EXEC_ACTION.RESUME}`,
  );
  if (!reconciled)
    throw new Error(
      `Run ${shortRunId(run.id)} was reclaimed while it was being diagnosed, so nothing was changed. Use /exec status ${run.id}.`,
    );
  return {
    run: reconciled,
    note: `Run ${shortRunId(run.id)} was abandoned — ${evidenceText(diagnosis)} — so it was reset to failed before resuming. No task attempt was consumed.`,
  };
}

function runClaim(run: PlanExecRun): string {
  return `${run.id} ${basename(run.planPath)} ${run.status}/${run.stage}`;
}

function evidenceText(diagnosis: RunDiagnosis): string {
  const lease = diagnosis.run.lease;
  const leaseText = !lease
    ? "no session holds it"
    : diagnosis.evidence.leaseLive
      ? `session ${lease.sessionId} holds a live lease`
      : `its lease for session ${lease.sessionId} is dead, last beat ${relativeTime(lease.heartbeatAt)}`;
  return `${leaseText}; ${operationEvidence(diagnosis)}`;
}

function operationEvidence(diagnosis: RunDiagnosis): string {
  const operation = diagnosis.run.activeOperation;
  if (!operation) return "no operation is tracked";
  if (diagnosis.evidence.asyncDirPresent === false)
    return "its operation directory is gone from disk";
  if (diagnosis.evidence.bridgeState === EXTERNAL_OPERATION_STATE.ABSENT)
    return "the bridge has no record of its operation";
  if (diagnosis.evidence.asyncDirPresent === true)
    return "its operation directory is still on disk";
  return "its operation could not be observed";
}

function nextCommand(diagnosis: RunDiagnosis): string {
  if (diagnosis.classification === ABANDONMENT.ABANDONED)
    return recoveryCommand(diagnosis.run);
  return `/exec status ${diagnosis.run.id}`;
}

/** A cancel-pending run still wants cancelling, before or after a reset. */
function recoveryCommand(run: PlanExecRun): string {
  return run.status === RUN_STATUS.CANCEL_PENDING
    ? `/exec cancel ${run.id}`
    : `/exec resume ${run.id}`;
}

function bridgeOperationState(
  data: Record<string, unknown>,
): string | undefined {
  const state = data.state;
  return typeof state === "string" && state.trim() ? state.trim() : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface CommandDependencies {
  controller: PlanExecController;
  startBackgroundController: StartBackgroundController;
  syncProjection: SyncProjection;
  checkRuntime: RuntimeCheck;
  runtimeProblems: RuntimeProbe;
  doctorProbe: EvidenceProbe;
}

async function handleCommand(
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
  if (subcommand === EXEC_ACTION.CLEANUP) return execCleanup(registry, rest);
  const read = await execRead(registry, subcommand, rest, {
    probe: doctorProbe,
    problems: runtimeProblems,
  });
  if (read !== undefined) return read;
  if (subcommand === EXEC_ACTION.STATUS)
    return formatRunStatus(
      await resolveRunForAction(
        EXEC_ACTION.STATUS,
        parseStatusArguments(rest).selector,
        ctx,
      ),
    );
  const dispatched = runActionFor(subcommand);
  if (dispatched) {
    const message = await runAction(dispatched.action, rest, ctx, dependencies);
    if (!dispatched.note) return message;
    return message === undefined
      ? dispatched.note
      : withAliasNote(message, dispatched.note);
  }

  const planPath = args || (await selectPlan(ctx));
  await checkRuntime();
  const useWorktree = await chooseIsolation(ctx);
  const started = await controller.start({
    cwd: ctx.cwd,
    planPath,
    useWorktree,
    sessionId: ctx.sessionManager.getSessionId(),
  });
  if (await handoffToWorktree(ctx, started, syncProjection)) return undefined;
  const run = await syncProjection(started, {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
  });
  startBackgroundController(
    run,
    ctx.sessionManager.getSessionId(),
    ctx.cwd,
    ctx,
  );
  return `Run ${shortRunId(run.id)} started: ${run.status} (${run.stage})\nbranch: ${run.branch}\nworktree: ${run.worktreeCwd}\nUse /exec status ${run.id} for live progress.`;
}

/** The subcommand's action and, when the name is retired, the note to append. */
export function runActionFor(
  subcommand: string | undefined,
): { action: RunAction; note?: string } | undefined {
  if (subcommand === undefined) return undefined;
  if (Object.hasOwn(RUN_ACTION_ALIASES, subcommand)) {
    const alias = subcommand as keyof typeof RUN_ACTION_ALIASES;
    return { action: RUN_ACTION_ALIASES[alias], note: ALIAS_NOTES[alias] };
  }
  return RUN_ACTIONS.has(subcommand)
    ? { action: subcommand as RunAction }
    : undefined;
}

async function runAction(
  action: RunAction,
  rest: string[],
  ctx: ExtensionCommandContext,
  dependencies: CommandDependencies,
): Promise<string | undefined> {
  const {
    controller,
    startBackgroundController,
    syncProjection,
    checkRuntime,
    doctorProbe,
  } = dependencies;
  const resumeArguments =
    action === EXEC_ACTION.RESUME
      ? parseResumeArguments(rest)
      : {
          selector: rest[0],
          adoptCurrentBranch: false,
          retryTask: false,
          model: undefined,
        };
  if (action === EXEC_ACTION.SKIP && (!rest[0] || rest[0] === "--reason"))
    throw new Error(
      "Usage: /exec skip <full-run-id> --reason <non-empty reason>",
    );
  const sessionId = ctx.sessionManager.getSessionId();
  const resolved = await resolveRunForAction(
    action,
    resumeArguments.selector,
    ctx,
    resumeArguments.adoptCurrentBranch,
  );
  if (action === EXEC_ACTION.RESUME || action === EXEC_ACTION.SKIP) {
    await checkRuntime();
    // Reconcile before anything else touches the run: from here on resume is
    // working with a state it has evidence for.
    const recovered =
      action === EXEC_ACTION.RESUME
        ? await reconcileForResume(registry, resolved, sessionId, doctorProbe)
        : { run: resolved, note: undefined };
    const run = recovered.run;
    const recoveryModel =
      action === EXEC_ACTION.RESUME
        ? await recoveryModelForResume(run, resumeArguments.model, ctx)
        : undefined;
    let retryTask = resumeArguments.retryTask;
    if (
      action === EXEC_ACTION.RESUME &&
      isTaskRetryConfirmationRequired(run) &&
      !retryTask
    ) {
      if (!ctx.hasUI) throw new Error(taskRetryRequiredMessage(run));
      const accepted = await ctx.ui.confirm(
        "Retry externally blocked task?",
        `${taskRetryRequiredMessage(run)}\n\nRetry it now?`,
      );
      if (!accepted) throw new Error("Task retry cancelled.");
      retryTask = true;
    }
    // A branch mismatch cannot advance without rebinding, so an interactive
    // resume asks instead of requiring the caller to know the flag. The flag
    // stays for callers with no human to ask.
    const adoptCurrentBranch =
      resumeArguments.adoptCurrentBranch ||
      (action === EXEC_ACTION.RESUME &&
        ctx.hasUI &&
        hasExecutionBranchMismatch(run) &&
        run.activeOperation === undefined);
    const skipReason =
      action === EXEC_ACTION.SKIP ? parseSkipReason(rest.slice(1)) : undefined;
    const handedOff = await handoffToWorktree(
      ctx,
      run,
      syncProjection,
      action === EXEC_ACTION.RESUME
        ? `resume ${run.id}${adoptCurrentBranch ? " --adopt-current-branch" : ""}${retryTask ? ` ${TASK_RETRY_OPTION}` : ""}${recoveryModel ? ` ${RECOVERY_MODEL_OPTION} ${recoveryModel}` : ""}`
        : action === EXEC_ACTION.SKIP
          ? `skip ${run.id} --reason ${skipReason}`
          : undefined,
    );
    if (handedOff) return undefined;
    if (action === EXEC_ACTION.SKIP) {
      if (!ctx.hasUI)
        throw new Error("Force-skip requires interactive confirmation.");
      const operation = run.activeOperation;
      const accepted = await ctx.ui.confirm(
        `Force-skip ${run.stage}?`,
        [
          `Run: ${run.id}`,
          `Reason: ${skipReason}`,
          operation
            ? `Active operation: ${operation.service}/${operation.kind} ${operation.externalRunId ?? operation.operationId}`
            : "Active operation: none",
          `Known findings: ${run.reviewFindings.length}`,
          "The controller will stop any tracked child before advancing.",
          "Final status will be completed_with_findings.",
        ].join("\n"),
      );
      if (!accepted) throw new Error("Force-skip cancelled.");
      const skipped = await syncProjection(
        await controller.skip(run.id, sessionId, skipReason!),
        { cwd: ctx.cwd, sessionId },
      );
      startBackgroundController(skipped, sessionId, ctx.cwd, ctx);
      return `Run ${shortRunId(skipped.id)} force-skip requested: ${skipped.status} (${skipped.stage}).\nUse /exec status ${skipped.id} for live progress.`;
    }
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
      const rebound = await syncProjection(
        await controller.rebindBranchAndResume(run.id, sessionId),
        { cwd: ctx.cwd, sessionId },
      );
      startBackgroundController(rebound, sessionId, ctx.cwd, ctx);
      return `Run ${shortRunId(rebound.id)} adopted branch ${rebound.branch}: ${rebound.status} (${rebound.stage}).\nUse /exec status ${rebound.id} for live progress.`;
    }
    const reviewedPlanHash =
      action === EXEC_ACTION.RESUME
        ? await reviewedPlanHashForResume(run, ctx)
        : undefined;
    const resumed = await syncProjection(
      await controller.resume(
        run.id,
        sessionId,
        true,
        reviewedPlanHash,
        retryTask,
        recoveryModel,
      ),
      { cwd: ctx.cwd, sessionId },
    );
    startBackgroundController(resumed, sessionId, ctx.cwd, ctx);
    // The reset is reported where the operator asked for it, not only in the
    // progress file it was appended to.
    return recovered.note
      ? `${recovered.note}\n${resumeResultMessage(resumed)}`
      : resumeResultMessage(resumed);
  }
  const claimed = await registry.claim(resolved, sessionId);
  if (action === EXEC_ACTION.PAUSE) {
    const paused = await syncProjection(
      await requestStatus(claimed, EXEC_ACTION.PAUSE, sessionId),
      { cwd: ctx.cwd, sessionId },
    );
    return `Run ${shortRunId(paused.id)} paused after its active operation. Use /exec resume ${paused.id} to continue.`;
  }
  const cancelled = await syncProjection(
    await requestStatus(claimed, EXEC_ACTION.CANCEL, sessionId),
    { cwd: ctx.cwd, sessionId },
  );
  startBackgroundController(cancelled, sessionId, ctx.cwd, ctx);
  return `Run ${shortRunId(cancelled.id)} marked cancel-pending. Its worktree is preserved.`;
}

async function resolveRunForAction(
  action: RunAction,
  selector: string | undefined,
  ctx: ExtensionContext,
  adoptCurrentBranch = false,
): Promise<PlanExecRun> {
  if (selector) {
    const run = await registry.get(selector);
    if (!run) throw new Error(`Plan execution run not found: ${selector}`);
    assertActionAllowed(
      action,
      run,
      ctx.sessionManager.getSessionId(),
      adoptCurrentBranch,
    );
    return run;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const candidates = (await registry.list()).filter(
    (run) =>
      matchesContext(run, ctx.cwd) &&
      isActionAllowed(action, run, sessionId, adoptCurrentBranch),
  );
  if (candidates.length === 0) {
    const verb =
      action === EXEC_ACTION.STATUS
        ? "matching"
        : action === EXEC_ACTION.RESUME
          ? "resumable"
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

async function handoffToWorktree(
  ctx: ExtensionCommandContext,
  run: PlanExecRun,
  syncProjection: SyncProjection,
  followUp?: string,
): Promise<boolean> {
  if (resolve(run.worktreeCwd) === resolve(ctx.cwd)) return false;
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) return false;

  const sourceSessionId = ctx.sessionManager.getSessionId();
  const targetSession = SessionManager.forkFrom(
    sourceSessionFile,
    run.worktreeCwd,
  );
  const targetSessionFile = targetSession.getSessionFile();
  if (!targetSessionFile) {
    throw new Error("Could not create a worktree Pi session.");
  }

  let claimed = await registry.claim(
    await registry.release(run),
    targetSession.getSessionId(),
  );
  claimed = await syncProjection(claimed, {
    cwd: targetSession.getCwd(),
    sessionId: targetSession.getSessionId(),
  });
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
    if (!result.cancelled) return true;
  } catch (error: unknown) {
    if (switched) throw error;
    await restoreSourceLease(run.id, sourceSessionId);
    throw error;
  }

  await restoreSourceLease(run.id, sourceSessionId);
  return false;
}

async function restoreSourceLease(
  runId: string,
  sourceSessionId: string,
): Promise<void> {
  const current = await registry.get(runId);
  if (!current) return;
  await registry.claim(await registry.release(current), sourceSessionId);
}

function matchesContext(run: PlanExecRun, cwd: string): boolean {
  const current = resolve(cwd);
  return (
    resolve(run.worktreeCwd) === current ||
    isPathWithin(run.repositoryRoot, current)
  );
}

export function isActionAllowed(
  action: RunAction,
  run: PlanExecRun,
  sessionId: string,
  adoptCurrentBranch = false,
): boolean {
  if (action === EXEC_ACTION.STATUS) return true;
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
          isRecoverableFailure(run) ||
          isClaimableForeignRun(run, sessionId);
  if (action === EXEC_ACTION.SKIP)
    return (
      isSkippableStage(run.stage) &&
      (run.status === RUN_STATUS.FAILED ||
        run.status === RUN_STATUS.PAUSED ||
        run.status === RUN_STATUS.SKIP_PENDING)
    );
  if (action === EXEC_ACTION.CANCEL)
    return (
      run.pendingStageSkip === undefined &&
      (!isTerminal(run.status) || run.status === RUN_STATUS.FAILED)
    );
  return false;
}

/**
 * The lease that used to force a reader to choose `/exec adopt`: another
 * session still holds this run and that session is provably gone. Resume reads
 * the lease itself and takes it over.
 */
function isClaimableForeignRun(run: PlanExecRun, sessionId: string): boolean {
  const lease = run.lease;
  return (
    !isTerminal(run.status) &&
    lease !== undefined &&
    lease.sessionId !== sessionId &&
    !isLeaseLive(lease, sessionId)
  );
}

export function isRecoverableFailure(run: PlanExecRun): boolean {
  return needsPlanStructureReview(run) || isRecoverableRun(run);
}

export function needsPlanStructureReview(run: PlanExecRun): boolean {
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

export function parseResumeArguments(args: string[]): {
  selector: string | undefined;
  adoptCurrentBranch: boolean;
  retryTask: boolean;
  model: string | undefined;
} {
  const first = args[0];
  const selector = first?.startsWith("--") ? undefined : first;
  return {
    selector,
    ...parseResumeOptions(selector === undefined ? args : args.slice(1)),
  };
}

export function parseResumeOptions(args: string[]): {
  adoptCurrentBranch: boolean;
  retryTask: boolean;
  model: string | undefined;
} {
  const options: {
    adoptCurrentBranch: boolean;
    retryTask: boolean;
    model: string | undefined;
  } = {
    adoptCurrentBranch: false,
    retryTask: false,
    model: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--adopt-current-branch") options.adoptCurrentBranch = true;
    else if (arg === TASK_RETRY_OPTION) options.retryTask = true;
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
    `Usage: /exec resume [full-run-id] [--adopt-current-branch] [${RECOVERY_MODEL_OPTION} current|provider/model]`,
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
  if (args[0] !== "--reason")
    throw new Error(
      "Usage: /exec skip <full-run-id> --reason <non-empty reason>",
    );
  const reason = args.slice(1).join(" ").trim();
  if (!reason)
    throw new Error(
      "Usage: /exec skip <full-run-id> --reason <non-empty reason>",
    );
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
  const current = await readPlan(run.planPath);
  if (current.hash !== run.planHash) {
    if (!ctx.hasUI) {
      throw new Error(
        `Run ${shortRunId(run.id)} changed the plan structure. Review ${run.planPath}, then resume from interactive Pi to confirm adopting the current structure.`,
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

async function requestStatus(
  run: PlanExecRun,
  action: typeof EXEC_ACTION.PAUSE | typeof EXEC_ACTION.CANCEL,
  sessionId: string,
): Promise<PlanExecRun> {
  let current = run;
  for (let attempt = 0; attempt < COMMAND_CAS_RETRIES; attempt += 1) {
    assertActionAllowed(action, current, sessionId);
    const requested = await registry.updateIfCurrent(
      {
        ...current,
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
  sessionId: string,
  adoptCurrentBranch = false,
): void {
  if (!isActionAllowed(action, run, sessionId, adoptCurrentBranch)) {
    throw new Error(
      `Run ${shortRunId(run.id)} cannot be ${actionPastTense(action)} while ${run.status}.`,
    );
  }
}

function actionPastTense(action: RunAction): string {
  return {
    [EXEC_ACTION.STATUS]: "inspected",
    [EXEC_ACTION.PAUSE]: "paused",
    [EXEC_ACTION.RESUME]: "resumed",
    [EXEC_ACTION.SKIP]: "force-skipped",
    [EXEC_ACTION.CANCEL]: "cancelled",
  }[action];
}

function runSelectorLabel(run: PlanExecRun): string {
  return `${basename(run.planPath)} — ${run.status}/${run.stage} — ${activeOperationLabel(run)} — ${shortRunId(run.id)}`;
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
  const failures = run.activeOperation?.statusFailures;
  return failures ? `cannot observe worker (${failures}/3)` : "polling worker";
}

function compactRunStatus(run: PlanExecRun): string {
  return `exec ${run.status} · ${run.stage} · ${activeOperationLabel(run)} · ${observationLabel(run)}`;
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

export function execSetup(): string {
  return [
    "Install the plan-exec prerequisites at compatible versions:",
    ...SETUP_COMMANDS,
    "",
    "Then run /reload. Use /exec help for commands.",
  ].join("\n");
}

export function execHelp(): string {
  return [
    "Plan execution commands:",
    "/exec [plan-path]       Start a plan (bare /exec opens the plan picker).",
    `/exec status [run-id] [${RUNS_ALL_OPTION}]`,
    `                        No run ID: every run grouped by what it needs, with any missing package and one next command per run. ${RUNS_ALL_OPTION} also shows terminal runs older than a day.`,
    `/exec cleanup [full-run-id] [${CLEANUP_APPLY_OPTION}] [${CLEANUP_INCLUDE_FAILED_OPTION}]`,
    `                        Preview retired runs older than ${CLEANUP_RETENTION_DAYS} days; ${CLEANUP_APPLY_OPTION} deletes their registry entries only. Failed runs need ${CLEANUP_INCLUDE_FAILED_OPTION}.`,
    "/exec pause [run-id]    Pause after the active child finishes.",
    `/exec resume [run-id] [${RECOVERY_MODEL_OPTION} current|provider/model]`,
    "                        Continue a stuck run: it takes the lease over from a dead session, resets a run whose worker is provably gone, and asks before retrying a blocked task or rebinding the current branch. Model/provider failures use the current Pi model.",
    "/exec skip <full-run-id> --reason <text>",
    "                        Stop any tracked child, force-skip a blocked review/finalize/stats stage, and record the waiver.",
    "/exec cancel [run-id]   Cancel safely and preserve the worktree.",
    "",
    "Hints:",
    "- Prefer Worktree (isolated) when asked.",
    "- /exec status reports a missing package with the exact install commands, and diagnoses every run that claims a worker.",
    "- The footer shows live stage and worker progress.",
    "- /exec resume preserves the stage and worktree, and reconciles a known Bridge operation before retrying it.",
    "- /exec resume never starts a second worker: a run whose worker cannot be proven gone is reported, not reset.",
    `- ${RECOVERY_MODEL_OPTION} is an advanced one-recovery-launch override; normal resume uses this Pi session model after a model/provider failure.`,
    "- /exec skip never skips implementation or archive; skipped runs finish as completed_with_findings.",
    "- Worktree runs fork this Pi session into the worktree so the footer and tools use the execution directory.",
    "- Use /skill:exec-plan for the executable-plan format and recovery rules.",
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

function isPathWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
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
