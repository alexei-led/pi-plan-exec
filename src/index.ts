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
  PLAN_STRUCTURE_CHANGED_ERROR,
  PlanExecController,
  isRecoverableImplementationFailure,
} from "./controller.js";
import { FusionClient } from "./fusion.js";
import { RunRegistry } from "./registry.js";
import { readPlan } from "./plan.js";
import { TaskProjector } from "./task-projection.js";
import type { PlanExecRun } from "./types.js";

const registry = new RunRegistry();
const STATUS_KEY = "plan-exec";
const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_findings",
  "failed",
  "cancelled",
]);
const REQUIRED_RUNTIME_TOOLS: Record<string, string> = {
  subagent: "pi-subagents",
  TaskCreate: "@tintinweb/pi-tasks",
};

const EXEC_COMMANDS: AutocompleteItem[] = [
  {
    value: "help",
    label: "help",
    description: "Show /exec commands and recovery hints",
  },
  {
    value: "start",
    label: "start",
    description: "Start a plan; bare /exec is an alias",
  },
  {
    value: "setup",
    label: "setup",
    description: "Show required Pi packages and install commands",
  },
  {
    value: "runs",
    label: "runs",
    description: "List recent plan execution runs",
  },
  {
    value: "status",
    label: "status",
    description: "Show the current run status",
  },
  {
    value: "pause",
    label: "pause",
    description: "Pause advancing after the active child",
  },
  {
    value: "resume",
    label: "resume",
    description: "Resume a paused run or review plan-structure recovery",
  },
  {
    value: "adopt",
    label: "adopt",
    description: "Adopt a stale run from another session",
  },
  {
    value: "cancel",
    label: "cancel",
    description: "Cancel safely and preserve the worktree",
  },
];

type RunAction = "status" | "pause" | "resume" | "adopt" | "cancel";
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
      new BridgeClient(pi.events, 1_500).ping(),
      new FusionClient(pi.events, 1_500).ping(),
    ]);
    const missing: string[] = [];
    if (!bridgeReply.success) missing.push("@alexeiled/pi-subagents-bridge");
    if (!fusionReply.success) missing.push("@alexeiled/pi-fusion");
    if (missing.length > 0) {
      throw new Error(
        `Missing plan-exec provider${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Run /exec setup, install the packages, then /reload.`,
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
              run.status === "failed" ? "error" : "info";
            notify(ctx, terminalMessage(run), level);
          } else if (run.status === "paused") {
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
    }, 1_000);
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
    const runs = await registry.list();
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
  if (run.progressPath) lines.push(`progress: ${run.progressPath}`);
  if (operation?.lastObservedAt)
    lines.push(
      `last observation: ${new Date(operation.lastObservedAt).toISOString()}`,
    );
  if (operation?.statusFailures) {
    lines.push(
      `observation: unavailable (${operation.statusFailures}/3); retrying${operation.lastStatusError ? ` — ${operation.lastStatusError}` : ""}`,
    );
  } else if (operation) {
    lines.push(
      "observation: polling continues; worker output is available when its operation completes.",
    );
  }
  if (run.error) lines.push(`error: ${run.error}`);
  if (needsPlanStructureReview(run)) {
    lines.push(
      "next: use interactive /exec resume to restore or explicitly adopt the reviewed plan structure.",
    );
  } else if (isTerminal(run.status)) {
    lines.push(
      run.status === "failed"
        ? isRecoverableImplementationFailure(run)
          ? "next: use interactive /exec resume to retry the incomplete task in its worktree."
          : "next: worktree preserved; inspect the error, then use /exec runs."
        : "next: run is terminal; use /exec runs to inspect other runs.",
    );
  } else {
    lines.push("next: /exec status (run ID is optional) or /exec help");
  }
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
    "Use /exec status, pause, resume, adopt, or cancel without a run ID when one run is in context.",
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
  if (subcommand === "help") return execHelp();
  if (subcommand === "setup") return execSetup();
  if (subcommand === "runs") return formatRunList(await registry.list());
  if (
    subcommand === "status" ||
    subcommand === "pause" ||
    subcommand === "resume" ||
    subcommand === "adopt" ||
    subcommand === "cancel"
  ) {
    const action = subcommand;
    const run = await resolveRunForAction(action, rest[0], ctx);
    if (action === "status") return formatRunStatus(run);
    if (action === "resume" || action === "adopt") {
      const handedOff = await handoffToWorktree(
        ctx,
        run,
        syncProjection,
        action === "resume" ? `resume ${run.id}` : undefined,
      );
      if (handedOff) return undefined;
      const reviewedPlanHash =
        action === "resume"
          ? await reviewedPlanHashForResume(run, ctx)
          : undefined;
      const resumed = await syncProjection(
        await controller.resume(
          run.id,
          ctx.sessionManager.getSessionId(),
          true,
          reviewedPlanHash,
        ),
        { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
      );
      startBackgroundController(
        resumed,
        ctx.sessionManager.getSessionId(),
        ctx.cwd,
        ctx,
      );
      return `Run ${shortRunId(resumed.id)} resumed: ${resumed.status} (${resumed.stage}).\nUse /exec status for live progress.`;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const claimed = await registry.claim(run, sessionId);
    if (action === "pause") {
      const paused = await syncProjection(
        await requestStatus(claimed, "pause", sessionId),
        { cwd: ctx.cwd, sessionId },
      );
      return `Run ${shortRunId(paused.id)} paused after its active operation. Use /exec resume to continue.`;
    }
    const cancelled = await syncProjection(
      await requestStatus(claimed, "cancel", sessionId),
      { cwd: ctx.cwd, sessionId },
    );
    startBackgroundController(cancelled, sessionId, ctx.cwd, ctx);
    return `Run ${shortRunId(cancelled.id)} marked cancel-pending. Its worktree is preserved.`;
  }

  const planPath =
    subcommand === "start"
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
): Promise<PlanExecRun> {
  if (selector) {
    const run = await registry.get(selector);
    if (!run) throw new Error(`Plan execution run not found: ${selector}`);
    assertActionAllowed(action, run, ctx.sessionManager.getSessionId());
    return run;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const candidates = (await registry.list()).filter(
    (run) =>
      matchesContext(run, ctx.cwd) && isActionAllowed(action, run, sessionId),
  );
  if (candidates.length === 0) {
    const verb =
      action === "status"
        ? "matching"
        : action === "resume"
          ? "resumable"
          : `${action}able`;
    throw new Error(
      `No ${verb} plan execution run found here. Use /exec runs or /exec <plan> to start one.`,
    );
  }
  const preferred = prioritizeRunCandidates(
    candidates,
    ctx.cwd,
    action === "status",
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

function isActionAllowed(
  action: RunAction,
  run: PlanExecRun,
  sessionId: string,
): boolean {
  if (action === "status") return true;
  if (action === "pause")
    return run.status === "starting" || run.status === "running";
  if (action === "resume")
    return run.status === "paused" || isRecoverableFailure(run);
  if (action === "adopt") {
    return !isTerminal(run.status) && run.lease?.sessionId !== sessionId;
  }
  return !isTerminal(run.status) && run.status !== "cancel_pending";
}

export function isRecoverableFailure(run: PlanExecRun): boolean {
  return (
    needsPlanStructureReview(run) || isRecoverableImplementationFailure(run)
  );
}

export function needsPlanStructureReview(run: PlanExecRun): boolean {
  return (
    (run.status === "paused" || run.status === "failed") &&
    run.error === PLAN_STRUCTURE_CHANGED_ERROR
  );
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
  action: "pause" | "cancel",
  sessionId: string,
): Promise<PlanExecRun> {
  let current = run;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertActionAllowed(action, current, sessionId);
    const requested = await registry.updateIfCurrent(
      {
        ...current,
        status: action === "pause" ? "paused" : "cancel_pending",
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
): void {
  if (!isActionAllowed(action, run, sessionId)) {
    throw new Error(
      `Run ${shortRunId(run.id)} cannot be ${actionPastTense(action)} while ${run.status}.`,
    );
  }
}

function actionPastTense(action: RunAction): string {
  return {
    status: "inspected",
    pause: "paused",
    resume: "resumed",
    adopt: "adopted",
    cancel: "cancelled",
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
  if (run.status === "failed")
    return `Plan execution ${shortRunId(run.id)} failed at ${run.stage}: ${run.error ?? "unknown error"}. Worktree preserved; use /exec status.`;
  if (run.status === "completed_with_findings")
    return `Plan execution ${shortRunId(run.id)} completed with findings. Use /exec status for details.`;
  if (run.status === "cancelled")
    return `Plan execution ${shortRunId(run.id)} cancelled. Its worktree was preserved.`;
  return `Plan execution ${shortRunId(run.id)} completed.`;
}

export function execSetup(): string {
  return [
    "Install the plan-exec prerequisites at compatible versions:",
    "pi install npm:pi-subagents",
    "pi install npm:@tintinweb/pi-tasks",
    "pi install npm:@alexeiled/pi-subagents-bridge",
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
    "/exec resume [run-id]   Resume a paused run, recover plan structure, or retry an exhausted worker.",
    "/exec adopt [run-id]    Adopt a stale run from another session.",
    "/exec cancel [run-id]   Cancel safely and preserve the worktree.",
    "",
    "Hints:",
    "- Prefer Worktree (isolated) when asked.",
    "- The footer shows live stage and worker progress.",
    "- A failed worker that leaves its task unchecked can be retried with /exec resume; its worktree is preserved.",
    "- Worktree runs fork this Pi session into the worktree so the footer and tools use the execution directory.",
    "- Use /skill:exec-plan for the executable-plan format and recovery rules.",
  ].join("\n");
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
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
      if (entry.name === "completed") continue;
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
