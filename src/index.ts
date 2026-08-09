import { access, readdir } from "node:fs/promises";
import { hostname } from "node:os";
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
  MAX_STATUS_FAILURES,
  PLAN_STRUCTURE_CHANGED_ERROR,
  PlanExecController,
  TASK_RETRY_OPTION,
  taskRetryRequiredMessage,
} from "./controller.js";
import { FusionClient } from "./fusion.js";
import {
  ABANDONMENT,
  classifyAbandonment,
  isInFlightStatus,
  isRecoverableRun,
  isSkippableStage,
  isTerminalStatus,
  longRunningOperation,
  type Abandonment,
  type AbandonmentEvidence,
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
import { TaskProjector } from "./task-projection.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  EXEC_ACTION,
  EXEC_ALIAS_ACTIONS,
  EXTERNAL_OPERATION_STATE,
  OPERATION_SERVICE,
  RUN_STATUS,
  WORKFLOW_MODE,
  type ActiveOperation,
  type ExecAliasAction,
  type PlanExecRun,
  type RunAction,
} from "./types.js";

const defaultRegistry = new RunRegistry();
const STATUS_KEY = "plan-exec";
const PROVIDER_PROBE_TIMEOUT_MS = 1_500;
const CONTROLLER_POLL_INTERVAL_MS = 1_000;
const COMMAND_CAS_RETRIES = 5;
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const DISPLAY_RUN_ID_LENGTH = 8;
const RECOVERY_MODEL_OPTION = "--model";
const SAME_MACHINE_OPTION = "--same-machine";
const CLEANUP_APPLY_OPTION = "--apply";
const CLEANUP_INCLUDE_FAILED_OPTION = "--include-failed";
const CLEANUP_RETENTION_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;
const CLEANUP_RETENTION_MS = CLEANUP_RETENTION_DAYS * MILLISECONDS_PER_DAY;
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
      "Pause — stop after the active operation finishes; /exec resume continues this run.",
  },
  {
    action: EXEC_ACTION.CANCEL,
    label:
      "Cancel — final; the run stops for good and its worktree is preserved.",
  },
] as const;
/** Stop asks a question, so with no human it names both scripted answers. */
const STOP_REQUIRES_UI =
  "/exec stop asks whether to pause or cancel and needs an interactive session. Use /exec pause <run-id> to stop after the active operation and keep the run resumable, or /exec cancel <run-id> to stop it for good with its worktree preserved.";
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
  TaskCreate: "@tintinweb/pi-tasks",
};
const SETUP_COMMANDS = [
  "pi install npm:pi-subagents",
  "pi install npm:@tintinweb/pi-tasks",
  "pi install npm:@alexeiled/pi-subagents-bridge@>=0.2.2",
  "pi install npm:@alexeiled/pi-fusion",
  "pi install npm:@alexeiled/pi-plan-exec",
];

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
) => void;
type RuntimeCheck = () => Promise<void>;
/** Prerequisite problems in report form; empty when every package is present. */
type RuntimeProbe = () => Promise<string[]>;
type SyncProjection = (
  run: PlanExecRun,
  options: { cwd: string; sessionId: string },
) => Promise<PlanExecRun>;

export default function planExecExtension(pi: ExtensionAPI): void {
  const projector = new TaskProjector(defaultRegistry);
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
    defaultRegistry,
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

  // Bounded: a diagnosis runs right after a restart, when the bridge may not be
  // up yet. No answer within the budget is simply no evidence.
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
    const { runs, errors } = await defaultRegistry.listWithErrors();
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
    // Advisory only: startup never writes, and a failed diagnosis must not take
    // the session down with it.
    try {
      const notice = abandonedRunsNotice(
        await sweepAbandonment(defaultRegistry),
      );
      if (notice) notify(ctx, notice, "warning");
    } catch {
      // The registry stays authoritative.
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
  // Ahead of every other unknown: no local probe can settle a run whose lease
  // names another machine, so the operator's override is the only action left.
  // A run with nothing tracked belongs to the takeover branch above; a settled
  // one needs no override, because its resume gathers no evidence at all.
  if (
    isInFlightStatus(run.status) &&
    leaseNamesAnotherHost(run) &&
    run.activeOperation
  )
    return {
      classification: "its lease names a machine that is not this one",
      action: `The lease was stamped on ${run.lease?.hostname} and this machine answers to ${hostname()}, so nothing here can observe its worker. If that name was this machine before it was renamed, run ${resume} ${SAME_MACHINE_OPTION}; it checks the worker here and still refuses while one is running. If it was a different machine, recover the run there.`,
      command: `${resume} ${SAME_MACHINE_OPTION}`,
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
          `This run has claimed an active worker for ${elapsedLabel(overdue.elapsedMs)} since launch, past the ${minutesLabel(overdue.boundMs)} allowed for its ${overdue.maxTurns}-turn budget, and nothing reports what it is doing${workflow}. That is not proof the worker is stuck.`,
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
  if (run.status === RUN_STATUS.PAUSED)
    return {
      classification: "paused, waiting for you to continue it",
      action: `Run ${resume}; it applies the paused stage or its finished worker without starting a second one.`,
      command: resume,
    };
  if (run.status === RUN_STATUS.FAILED) {
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
        action: `Fix the outside cause first — billing, credentials, quota, network, or a manual step — then run interactive ${resume}; it asks before retrying that task. Implementation work cannot be waived, so there is no way past it.`,
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
      action: `${checked}, so there is nothing left to stop and the run cannot move on by itself. Run ${commands.resume}; it clears the dead worker and continues, without starting a second one.`,
      command: commands.resume,
    };
  return {
    classification: "the worker is gone, so nothing is running",
    action: `${checked}. Run ${commands.resume}; it clears the dead worker and continues, without starting a second one. Run ${commands.stop} instead to end the run and keep the worktree.`,
    command: commands.resume,
  };
}

/**
 * Why `--same-machine` does not apply to this run, or undefined when it does.
 * Refusing where the flag would change nothing keeps it from widening into a
 * general force. A beating heartbeat is refused whatever host it names: the
 * flag asserts a machine, and no assertion about a machine can outrank a worker
 * that is still writing on it.
 */
export function sameMachineRefusal(run: PlanExecRun): string | undefined {
  if (isLocalRun(run))
    return `${SAME_MACHINE_OPTION} only applies to a run whose lease names another host; run ${shortRunId(run.id)} is already observable here.`;
  if (run.lease && isLeaseLive(run.lease))
    return `Run ${shortRunId(run.id)} still has a beating lease from session ${run.lease.sessionId}, so ${SAME_MACHINE_OPTION} cannot act on it. Wait ${elapsedLabel(LEASE_STALE_MS)} for the heartbeat to go stale, then resume.`;
  return undefined;
}

/** A dead lease naming a host this machine is not: no local check can speak. */
function leaseNamesAnotherHost(run: PlanExecRun): boolean {
  return isStaleOwner(run) && !isLocalRun(run);
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
  lines.push(...workerSignalLines(run, evidence));
  // The failure counts below are stored facts and print either way. Only an
  // observed live lease adds the claim that something is still trying.
  const polling = evidence?.leaseLive === true ? "; retrying" : "";
  if (operation?.statusFailures) {
    lines.push(
      `observation: unavailable (${operation.statusFailures}/${MAX_STATUS_FAILURES})${polling}${operation.lastStatusError ? ` — ${operation.lastStatusError}` : ""}`,
    );
  }
  if (operation?.skipFailures) {
    lines.push(
      `waived stage: could not stop the worker (${operation.skipFailures}/${MAX_STATUS_FAILURES})${polling}${operation.lastSkipError ? ` — ${operation.lastSkipError}` : ""}`,
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
  const activity = reportedActivity(operation, evidence);
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
 * A blocked review, finalize, or stats stage moves only by waiver, so the row
 * spells the waiver out with the run ID filled in.
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
  // The refusal above already rejected every non-terminal status, so `failed`
  // is the only terminal status left to exclude.
  if (removalRefusal(run)) return false;
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
            "Naming a run overrides both the retention window and the failed exclusion; the registry still refuses a non-terminal run or a live lease.",
          ]
        : []),
      ...failedHint,
      `Use /exec cleanup ${runId ? `${runId} ` : ""}${CLEANUP_APPLY_OPTION}${includeFailed ? ` ${CLEANUP_INCLUDE_FAILED_OPTION}` : ""} to remove them.`,
    ].join("\n");
  return removalReport(await removeAll(registry, targets));
}

function cleanupRow(run: PlanExecRun): string {
  return `${run.id} ${basename(run.planPath)} ${run.status}/${run.stage} updated ${relativeTime(run.updatedAt)}`;
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
 * Filesystem evidence always; the bridge only when a lookup is wired in and the
 * cheap check was not decisive. A lookup that cannot answer yields no evidence
 * rather than a false verdict, and a run whose lease names another host yields
 * none at all — see `isLocalRun`.
 */
export function abandonmentProbe(
  lookupOperationState?: (operationId: string) => Promise<string | undefined>,
): EvidenceProbe {
  return async (run) => {
    const operation = run.activeOperation;
    if (!operation || !isLocalRun(run)) return {};
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

/**
 * Worded for the rows the group actually holds. `reconcileRun` refuses every
 * run already told to stop, so promising that each one resets would be false.
 */
function abandonedFooter(diagnoses: RunDiagnosis[]): string | undefined {
  const resettable = diagnoses.filter(
    (diagnosis) => !isRecoverableRun(diagnosis.run),
  ).length;
  if (resettable === 0) return undefined;
  return resettable === diagnoses.length
    ? "Each resets to a recoverable failure before it continues; no second worker is launched."
    : "Each resets to a recoverable failure before it continues, except the ones already told to stop, which keep that request; no second worker is launched.";
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
const RECONCILE_ALIAS_NOTE = `/exec doctor ${DOCTOR_RECONCILE_OPTION} still works for scripted callers; /exec resume <run-id> resets one named run instead, and /exec status reports the same diagnosis without writing.`;

/**
 * The registry-wide write behind the retired `/exec doctor --reconcile`. It
 * resets every provably abandoned run — a wider blast radius than /exec
 * cleanup, which demands `--apply` — so only the write dispatch reaches it.
 */
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
      `Reset ${reset.length} abandoned run${reset.length === 1 ? "" : "s"} to failed. No worker was launched and no task attempt was consumed.`,
      ...reset.map(
        (diagnosis) =>
          `- ${runClaim(diagnosis.run)} → failed. Next: ${nextCommand(diagnosis)}`,
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
 * since the scan is skipped. `taskAttempts` is untouched; the worker never ran.
 */
async function reconcileRun(
  registry: RunRegistry,
  diagnosis: RunDiagnosis,
  actor = `/exec ${EXEC_ACTION.DOCTOR}`,
): Promise<ReconcileOutcome> {
  // Resetting a cancel-pending run to failed would erase the stop it carries,
  // and the next resume would restart plan work instead of finishing it.
  if (isRecoverableRun(diagnosis.run))
    return { skipped: RECONCILE_SKIP.STOP_REQUESTED };
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

/**
 * Name the evidence in the stored error, so the reset is legible later.
 * Recovery classification reads `run.error` back, so a stray "provider" or
 * "external" in this text would reclassify the run.
 */
function reconcileReason(diagnosis: RunDiagnosis, actor: string): string {
  const operation = diagnosis.run.activeOperation;
  return `Reset by ${actor}: its lease was dead and ${operationEvidence(diagnosis)}, so no worker was running${operation ? ` for ${operation.service}/${operation.kind}` : ""}.`;
}

/**
 * The recovery gate in front of every resume. It reconciles only on the
 * `classifyAbandonment` conjunction, and refuses one shape: an unresolved
 * operation that could not be proven gone. Takes no session, for the reason
 * `isStaleOwner` gives.
 *
 * `sameMachine` unblocks evidence gathering and nothing else, so it cannot
 * force a resume past a worker still writing: only the probe sees the rewritten
 * host, while `leaseLive` keeps reading the stored lease. A beating heartbeat
 * therefore still reads LIVE, whichever machine stamped it. The rewritten host
 * is never written back — the reset's own `claim` re-stamps the current host.
 */
export async function reconcileForResume(
  registry: RunRegistry,
  run: PlanExecRun,
  probe: EvidenceProbe = abandonmentProbe(),
  sameMachine = false,
): Promise<{ run: PlanExecRun; note?: string }> {
  if (!isInFlightStatus(run.status) || isRecoverableRun(run)) return { run };
  // The operator asserted the host, so every text below reads the run that way
  // too; only the record written back keeps the stored lease.
  const subject = sameMachine ? asLocalRun(run) : run;
  const evidence = await runEvidence(run, () => probe(subject));
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
  return {
    run: reconciled.run,
    note: `Run ${shortRunId(run.id)} was abandoned — ${evidenceText(diagnosis)} — so it was reset to failed before resuming. No task attempt was consumed.`,
  };
}

function runClaim(run: PlanExecRun): string {
  return `${run.id} ${basename(run.planPath)} ${run.status}/${run.stage}`;
}

/** A run and what was observed about it; a diagnosis adds the verdict. */
type ObservedRun = Pick<RunDiagnosis, "run" | "evidence">;

function evidenceText(diagnosis: ObservedRun): string {
  const lease = diagnosis.run.lease;
  const leaseText = !lease
    ? "no session holds it"
    : diagnosis.evidence.leaseLive
      ? `session ${lease.sessionId} holds a live lease`
      : `its lease for session ${lease.sessionId} is dead, last beat ${relativeTime(lease.heartbeatAt)}`;
  return `${leaseText}; ${operationEvidence(diagnosis)}${overdueText(diagnosis)}`;
}

/** Without it a run far past its bound reads like one launched a minute ago. */
function overdueText(diagnosis: ObservedRun): string {
  const run = diagnosis.run;
  const overdue = reportedActivity(run.activeOperation, diagnosis.evidence)
    ? undefined
    : longRunningOperation(run);
  return overdue
    ? `; running ${elapsedLabel(overdue.elapsedMs)}, past the ${minutesLabel(overdue.boundMs)} allowed for its ${overdue.maxTurns}-turn budget`
    : "";
}

function operationEvidence(diagnosis: ObservedRun): string {
  const operation = diagnosis.run.activeOperation;
  if (!operation) return "no operation is tracked";
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
  if (subcommand === EXEC_ACTION.CLEANUP)
    return execCleanup(defaultRegistry, rest);
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
          sameMachine: false,
          model: undefined,
        };
  if (action === EXEC_ACTION.SKIP && (!rest[0] || rest[0] === "--reason"))
    throw skipUsageError();
  // Before resolving a run, so a repository with several candidates does not
  // ask a picker question first and then refuse anyway.
  if (action === EXEC_ACTION.STOP && !ctx.hasUI)
    throw new Error(STOP_REQUIRES_UI);
  const sessionId = ctx.sessionManager.getSessionId();
  const resolved = await resolveRunForAction(
    action,
    resumeArguments.selector,
    ctx,
    resumeArguments.adoptCurrentBranch,
  );
  if (resumeArguments.sameMachine) {
    const refusal = sameMachineRefusal(resolved);
    if (refusal) throw new Error(refusal);
  }
  if (action === EXEC_ACTION.RESUME || action === EXEC_ACTION.SKIP) {
    await checkRuntime();
    // Before anything else touches the run, so the rest of resume works from a
    // state it has evidence for.
    const recovered =
      action === EXEC_ACTION.RESUME
        ? await reconcileForResume(
            defaultRegistry,
            resolved,
            doctorProbe,
            resumeArguments.sameMachine,
          )
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
    // resume asks. The flag stays for callers with no human to ask.
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
    // The forked session re-enters the gate on an already-reset run, so this is
    // the note's only chance to be printed.
    if (handedOff) return recovered.note;
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
    // Reported where the operator asked, not only in the progress file.
    return recovered.note
      ? `${recovered.note}\n${resumeResultMessage(resumed)}`
      : resumeResultMessage(resumed);
  }
  // Ask before claiming: an abandoned dialog must not have taken the lease.
  const outcome =
    action === EXEC_ACTION.STOP
      ? await chooseStopOutcome(resolved, ctx)
      : action;
  const claimed = await defaultRegistry.claim(resolved, sessionId);
  if (outcome === EXEC_ACTION.PAUSE) {
    const paused = await syncProjection(
      await requestStatus(claimed, EXEC_ACTION.PAUSE),
      { cwd: ctx.cwd, sessionId },
    );
    return `Run ${shortRunId(paused.id)} paused after its active operation. Use /exec resume ${paused.id} to continue.`;
  }
  const cancelled = await syncProjection(
    await requestStatus(claimed, EXEC_ACTION.CANCEL),
    { cwd: ctx.cwd, sessionId },
  );
  startBackgroundController(cancelled, sessionId, ctx.cwd, ctx);
  return `Run ${shortRunId(cancelled.id)} marked cancel-pending. Its worktree is preserved.`;
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

  let claimed = await defaultRegistry.claim(
    await defaultRegistry.release(run),
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
  const current = await defaultRegistry.get(runId);
  if (!current) return;
  await defaultRegistry.claim(
    await defaultRegistry.release(current),
    sourceSessionId,
  );
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
  sameMachine: boolean;
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
  sameMachine: boolean;
  model: string | undefined;
} {
  const options: {
    adoptCurrentBranch: boolean;
    retryTask: boolean;
    sameMachine: boolean;
    model: string | undefined;
  } = {
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
): Promise<PlanExecRun> {
  let current = run;
  for (let attempt = 0; attempt < COMMAND_CAS_RETRIES; attempt += 1) {
    assertActionAllowed(action, current);
    const requested = await defaultRegistry.updateIfCurrent(
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
  return failures
    ? `cannot observe worker (${failures}/${MAX_STATUS_FAILURES})`
    : "polling worker";
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
    "/exec status [run-id]   No run ID: every run grouped by what it needs, with any missing package and one next command per run. With a run ID: that run in detail.",
    `/exec resume [run-id] [${RECOVERY_MODEL_OPTION} current|provider/model]`,
    "                        Continue a stuck run: it takes the lease over from a dead session, resets a run whose worker is provably gone, and asks before retrying a blocked task or rebinding the current branch. Model/provider failures use the current Pi model.",
    "/exec stop [run-id]     Stop a run: it asks whether to pause it (resumable) or cancel it (final, worktree preserved).",
    `/exec cleanup [full-run-id] [${CLEANUP_APPLY_OPTION}]`,
    `                        Preview retired runs older than ${CLEANUP_RETENTION_DAYS} days; ${CLEANUP_APPLY_OPTION} deletes their registry entries only.`,
    "/exec skip <full-run-id> --reason <text>",
    "                        Waiver of last resort: stop any tracked child, force-skip a review/finalize/stats stage that cannot pass, and record why.",
    "/exec help              Show this list.",
    "",
    "Hints:",
    "- Prefer Worktree (isolated) when asked.",
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
