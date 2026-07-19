import { readdir } from "node:fs/promises";
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
  isTaskRetryConfirmationRequired,
  MAX_STATUS_FAILURES,
  PLAN_STRUCTURE_CHANGED_ERROR,
  PlanExecController,
  TASK_RETRY_OPTION,
  taskRetryRequiredMessage,
} from "./controller.js";
import { FusionClient } from "./fusion.js";
import {
  isRecoverableRun,
  isSkippableStage,
  isTerminalStatus,
} from "./lifecycle.js";
import { LEASE_STALE_MS, RunRegistry } from "./registry.js";
import { readPlan } from "./plan.js";
import { TaskProjector } from "./task-projection.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  EXEC_ACTION,
  RUN_STATUS,
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
const DISPLAY_RUN_ID_LENGTH = 8;
const REQUIRED_RUNTIME_TOOLS: Record<string, string> = {
  subagent: "pi-subagents",
  TaskCreate: "@tintinweb/pi-tasks",
};

const EXEC_COMMANDS: AutocompleteItem[] = [
  {
    value: EXEC_ACTION.HELP,
    label: EXEC_ACTION.HELP,
    description: "Show /exec commands and recovery hints",
  },
  {
    value: EXEC_ACTION.START,
    label: EXEC_ACTION.START,
    description: "Start a plan; bare /exec is an alias",
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
    value: EXEC_ACTION.STATUS,
    label: EXEC_ACTION.STATUS,
    description: "Show the current run status",
  },
  {
    value: EXEC_ACTION.PAUSE,
    label: EXEC_ACTION.PAUSE,
    description: "Pause advancing after the active child",
  },
  {
    value: EXEC_ACTION.RESUME,
    label: EXEC_ACTION.RESUME,
    description: "Resume or retry a failed run safely; use --retry-task for exhausted implementation tasks",
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
        `Plan execution ${shortRunId(failed.id)} failed at ${failed.stage}: ${failed.error ?? message}. Worktree preserved. Use /exec status to inspect it.`,
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
  const checkRuntime: RuntimeCheck = async () => {
    const missingTools = missingRuntimeTools(
      pi.getAllTools().map((tool) => tool.name),
    );
    if (missingTools.length > 0) {
      throw new Error(
        `Missing plan-exec prerequisite${missingTools.length === 1 ? "" : "s"}: ${missingTools.join(", ")}. Run /exec setup, install the packages, then /reload.`,
      );
    }
    const [bridgeReply, fusionReply] = await Promise.all([
      new BridgeClient(pi.events, PROVIDER_PROBE_TIMEOUT_MS).ping(),
      new FusionClient(pi.events, PROVIDER_PROBE_TIMEOUT_MS).ping(),
    ]);
    const missing: string[] = [];
    const incompatible: string[] = [];
    if (!bridgeReply.success) missing.push("@alexeiled/pi-subagents-bridge");
    else if (!hasBridgeOperationMethod(bridgeReply.data))
      incompatible.push("@alexeiled/pi-subagents-bridge >=0.2.0");
    if (!fusionReply.success) missing.push("@alexeiled/pi-fusion");
    if (missing.length > 0 || incompatible.length > 0) {
      const problems = [
        ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
        ...(incompatible.length > 0
          ? [`incompatible: ${incompatible.join(", ")}`]
          : []),
      ];
      throw new Error(
        `Plan-exec provider ${problems.join("; ")}. Run /exec setup, install compatible packages, then /reload.`,
      );
    }
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
              `Plan execution ${shortRunId(run.id)} is paused. Use /exec resume to continue.`,
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
        const message = await handleCommand(
          args.trim(),
          ctx,
          controller,
          startBackgroundController,
          syncProjection,
          checkRuntime,
        );
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
  if (
    isTerminal(run.status) &&
    run.status !== RUN_STATUS.FAILED
  )
    return {
      classification: "terminal",
      action: "Run is terminal; no recovery action is available.",
    };
  if (isStaleOwner(run) && run.status !== RUN_STATUS.FAILED)
    return {
      classification: "stale owner",
      action: `Confirm the prior session stopped, then use /exec adopt ${run.id}; do not resume from this session.`,
    };
  if (hasExecutionBranchMismatch(run))
    return {
      classification: "execution-branch mismatch",
      action: `Review the current branch, then use interactive /exec resume ${run.id} --adopt-current-branch; normal resume will not rebind it.`,
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
    if (run.activeOperation)
      return {
        classification: "healthy active operation",
        action:
          "wait; the controller is polling this operation. do not resume or start another run.",
      };
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
    action: "Use /exec status again or /exec help; no recovery action is inferred.",
  };
}

function isStaleOwner(run: PlanExecRun): boolean {
  return Boolean(
    run.lease && Date.now() - run.lease.heartbeatAt >= LEASE_STALE_MS,
  );
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
  if (run.progressPath) lines.push(`progress: ${run.progressPath}`);
  if (operation?.lastObservedAt)
    lines.push(
      `last observation: ${new Date(operation.lastObservedAt).toISOString()}`,
    );
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

export function formatRunList(runs: PlanExecRun[]): string {
  if (runs.length === 0) return "No plan execution runs. Start one with /exec.";
  return [
    "Plan execution runs:",
    ...runs.map(
      (run) =>
        `${run.id} ${basename(run.planPath)} ${run.status}/${run.stage} ${activeOperationLabel(run)} updated ${relativeTime(run.updatedAt)}`,
    ),
    "Use /exec status, pause, resume, adopt, skip, or cancel. Force-skip requires a full run ID and reason.",
  ].join("\n");
}

async function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: PlanExecController,
  startBackgroundController: StartBackgroundController,
  syncProjection: SyncProjection,
  checkRuntime: RuntimeCheck,
): Promise<string | undefined> {
  const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
  if (subcommand === EXEC_ACTION.HELP) return execHelp();
  if (subcommand === EXEC_ACTION.SETUP) return execSetup();
  if (subcommand === EXEC_ACTION.RUNS) return formatRunList(await registry.list());
  if (
    subcommand === EXEC_ACTION.STATUS ||
    subcommand === EXEC_ACTION.PAUSE ||
    subcommand === EXEC_ACTION.RESUME ||
    subcommand === EXEC_ACTION.ADOPT ||
    subcommand === EXEC_ACTION.SKIP ||
    subcommand === EXEC_ACTION.CANCEL
  ) {
    const action = subcommand as RunAction;
    const resumeArguments =
      action === EXEC_ACTION.RESUME
        ? parseResumeArguments(rest)
        : {
            selector: rest[0],
            adoptCurrentBranch: false,
            retryTask: false,
          };
    const adoptCurrentBranch = resumeArguments.adoptCurrentBranch;
    if (
      action === EXEC_ACTION.SKIP &&
      (!rest[0] || rest[0] === "--reason")
    )
      throw new Error(
        "Usage: /exec skip <full-run-id> --reason <non-empty reason>",
      );
    const run = await resolveRunForAction(
      action,
      resumeArguments.selector,
      ctx,
      adoptCurrentBranch,
    );
    if (action === EXEC_ACTION.STATUS) return formatRunStatus(run);
    if (
      action === EXEC_ACTION.RESUME ||
      action === EXEC_ACTION.ADOPT ||
      action === EXEC_ACTION.SKIP
    ) {
      await checkRuntime();
      const skipReason =
        action === EXEC_ACTION.SKIP ? parseSkipReason(rest.slice(1)) : undefined;
      const handedOff = await handoffToWorktree(
        ctx,
        run,
        syncProjection,
        action === EXEC_ACTION.RESUME
          ? `resume ${run.id}${adoptCurrentBranch ? " --adopt-current-branch" : ""}${resumeArguments.retryTask ? ` ${TASK_RETRY_OPTION}` : ""}`
          : action === EXEC_ACTION.SKIP
            ? `skip ${run.id} --reason ${skipReason}`
            : undefined,
      );
      if (handedOff) return undefined;
      const sessionId = ctx.sessionManager.getSessionId();
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
        return `Run ${shortRunId(skipped.id)} force-skip requested: ${skipped.status} (${skipped.stage}).\nUse /exec status for live progress.`;
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
        return `Run ${shortRunId(rebound.id)} adopted branch ${rebound.branch}: ${rebound.status} (${rebound.stage}).\nUse /exec status for live progress.`;
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
          resumeArguments.retryTask,
        ),
        { cwd: ctx.cwd, sessionId },
      );
      startBackgroundController(resumed, sessionId, ctx.cwd, ctx);
      return resumeResultMessage(resumed);
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const claimed = await registry.claim(run, sessionId);
    if (action === EXEC_ACTION.PAUSE) {
      const paused = await syncProjection(
        await requestStatus(claimed, EXEC_ACTION.PAUSE, sessionId),
        { cwd: ctx.cwd, sessionId },
      );
      return `Run ${shortRunId(paused.id)} paused after its active operation. Use /exec resume to continue.`;
    }
    const cancelled = await syncProjection(
      await requestStatus(claimed, EXEC_ACTION.CANCEL, sessionId),
      { cwd: ctx.cwd, sessionId },
    );
    startBackgroundController(cancelled, sessionId, ctx.cwd, ctx);
    return `Run ${shortRunId(cancelled.id)} marked cancel-pending. Its worktree is preserved.`;
  }

  const planPath =
    subcommand === EXEC_ACTION.START
      ? rest.join(" ") || (await selectPlan(ctx))
      : args || (await selectPlan(ctx));
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
  return `Run ${shortRunId(run.id)} started: ${run.status} (${run.stage})\nbranch: ${run.branch}\nworktree: ${run.worktreeCwd}\nUse /exec status for live progress.`;
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
      `No ${verb} plan execution run found here. Use /exec runs or /exec <plan> to start one.`,
    );
  }
  const preferred = prioritizeRunCandidates(
    candidates,
    ctx.cwd,
    action === EXEC_ACTION.STATUS,
  );
  if (preferred.length === 1) return preferred[0]!;
  if (!ctx.hasUI) {
    throw new Error(
      `Multiple runs match this repository. Use /exec ${action} <run-id> or /exec runs.`,
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
  preferLive = false,
): PlanExecRun[] {
  const live = preferLive
    ? candidates.filter((run) => !isTerminal(run.status))
    : [];
  const pool = live.length > 0 ? live : candidates;
  const exactWorktree = pool.filter(
    (run) => resolve(run.worktreeCwd) === resolve(cwd),
  );
  return exactWorktree.length > 0 ? exactWorktree : pool;
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
      : run.status === RUN_STATUS.PAUSED || isRecoverableFailure(run);
  if (action === EXEC_ACTION.ADOPT) {
    return !isTerminal(run.status) && run.lease?.sessionId !== sessionId;
  }
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

export function isRecoverableFailure(run: PlanExecRun): boolean {
  return needsPlanStructureReview(run) || isRecoverableRun(run);
}

export function needsPlanStructureReview(run: PlanExecRun): boolean {
  return (
    (run.status === RUN_STATUS.PAUSED || run.status === RUN_STATUS.FAILED) &&
    run.error === PLAN_STRUCTURE_CHANGED_ERROR
  );
}

export function parseResumeArguments(args: string[]): {
  selector: string | undefined;
  adoptCurrentBranch: boolean;
  retryTask: boolean;
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
} {
  const options = {
    adoptCurrentBranch: false,
    retryTask: false,
  };
  for (const arg of args) {
    if (arg === "--adopt-current-branch") options.adoptCurrentBranch = true;
    else if (arg === TASK_RETRY_OPTION) options.retryTask = true;
    else
      throw new Error(
        `Usage: /exec resume <full-run-id> [--adopt-current-branch] [${TASK_RETRY_OPTION}]`,
      );
  }
  return options;
}

export function resumeResultMessage(run: PlanExecRun): string {
  if (needsPlanStructureReview(run))
    return [
      `Run ${shortRunId(run.id)} paused for plan-structure review: ${run.status} (${run.stage}).`,
      `The first resume only recorded the pause. Review ${run.planPath}, restore the original structure or confirm adoption, then run interactive /exec resume ${run.id} again.`,
    ].join("\n");
  return [
    `Run ${shortRunId(run.id)} resumed: ${run.status} (${run.stage}).`,
    "Use /exec status for live progress.",
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
    [EXEC_ACTION.ADOPT]: "adopted",
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
    return `Plan execution ${shortRunId(run.id)} failed at ${run.stage}: ${run.error ?? "unknown error"}. Worktree preserved; use /exec status.`;
  if (run.status === RUN_STATUS.COMPLETED_WITH_FINDINGS)
    return `Plan execution ${shortRunId(run.id)} completed with findings. Use /exec status for details.`;
  if (run.status === RUN_STATUS.CANCELLED)
    return `Plan execution ${shortRunId(run.id)} cancelled. Its worktree was preserved.`;
  return `Plan execution ${shortRunId(run.id)} completed.`;
}

export function execSetup(): string {
  return [
    "Install the plan-exec prerequisites at compatible versions:",
    "pi install npm:pi-subagents",
    "pi install npm:@tintinweb/pi-tasks",
    "pi install npm:@alexeiled/pi-subagents-bridge@^0.2.0",
    "pi install npm:@alexeiled/pi-fusion",
    "pi install npm:@alexeiled/pi-plan-exec",
    "",
    "Then run /reload. Use /exec help for commands.",
  ].join("\n");
}

export function execHelp(): string {
  return [
    "Plan execution commands:",
    "/exec [plan-path]       Start a plan (bare /exec opens the plan picker).",
    "/exec start [plan-path] Start a plan explicitly.",
    "/exec setup             Show required packages and install commands.",
    "/exec status [run-id]   Show progress; run-id is optional when unambiguous.",
    "/exec runs              List runs and their full IDs.",
    "/exec pause [run-id]    Pause after the active child finishes.",
    `/exec resume [run-id] [--adopt-current-branch] [${TASK_RETRY_OPTION}]`,
    "                        Reconcile, resume, or retry a failed run safely; exhausted implementation tasks require the explicit flag.",
    "/exec adopt [run-id]    Adopt a stale run from another session.",
    "/exec skip <full-run-id> --reason <text>",
    "                        Stop any tracked child, force-skip a blocked review/finalize/stats stage, and record the waiver.",
    "/exec cancel [run-id]   Cancel safely and preserve the worktree.",
    "",
    "Hints:",
    "- Prefer Worktree (isolated) when asked.",
    "- The footer shows live stage and worker progress.",
    "- /exec resume preserves the stage and worktree, and reconciles a known Bridge operation before retrying it.",
    "- --adopt-current-branch requires confirmation, no active child, and the same Git repository.",
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

function relativeTime(timestamp: number): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / MILLISECONDS_PER_SECOND),
  );
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < SECONDS_PER_MINUTE) return `${minutes}m ago`;
  return `${Math.floor(minutes / SECONDS_PER_MINUTE)}h ago`;
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
