import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BridgeClient } from "./bridge.js";
import { PlanExecController } from "./controller.js";
import { FusionClient } from "./fusion.js";
import { RunRegistry } from "./registry.js";
import { TaskProjector } from "./task-projection.js";

const registry = new RunRegistry();

export default function planExecExtension(pi: ExtensionAPI): void {
  const projector = new TaskProjector(registry);
  const controller = new PlanExecController(
    registry,
    new BridgeClient(pi.events),
    new FusionClient(pi.events),
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
  const toolsBeforeRun = new Map<string, string[]>();
  const restoreTools = (runId: string): void => {
    const tools = toolsBeforeRun.get(runId);
    if (tools) pi.setActiveTools(tools);
    toolsBeforeRun.delete(runId);
  };
  const startBackgroundController = (
    runId: string,
    sessionId: string,
    cwd: string,
  ): void => {
    if (activeControllers.has(runId)) return;
    if (!toolsBeforeRun.has(runId)) {
      toolsBeforeRun.set(runId, pi.getActiveTools());
      // The main agent must not interpret pi-tasks' projected rows as a second
      // executor. The controller alone advances a claimed plan-exec run.
      pi.setActiveTools([]);
    }
    const timer = setInterval(() => {
      if (inFlightControllers.has(runId)) return;
      inFlightControllers.add(runId);
      void controller
        .resume(runId, sessionId, false)
        .then((run) => projector.sync(run, { sessionId, cwd }))
        .then((run) => {
          if (isTerminal(run.status)) {
            clearInterval(timer);
            activeControllers.delete(runId);
            restoreTools(runId);
          }
        })
        .catch((error: unknown) => {
          clearInterval(timer);
          activeControllers.delete(runId);
          restoreTools(runId);
          void controller.markFailed(runId, error);
        })
        .finally(() => inFlightControllers.delete(runId));
    }, 1_000);
    timer.unref();
    activeControllers.set(runId, timer);
  };

  pi.registerCommand("exec", {
    description:
      "Start, inspect, resume, or adopt a reliable plan execution run",
    handler: async (args, ctx) => {
      try {
        const message = await handleCommand(
          args.trim(),
          ctx,
          controller,
          startBackgroundController,
          projector,
        );
        ctx.ui.notify(message, "info");
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", () => {
    for (const timer of activeControllers.values()) clearInterval(timer);
    activeControllers.clear();
    inFlightControllers.clear();
    for (const runId of toolsBeforeRun.keys()) restoreTools(runId);
  });
}

async function handleCommand(
  args: string,
  ctx: ExtensionContext,
  controller: PlanExecController,
  startBackgroundController: (
    runId: string,
    sessionId: string,
    cwd: string,
  ) => void,
  projector: TaskProjector,
): Promise<string> {
  const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
  if (subcommand === "runs") {
    const runs = await registry.list();
    return runs.length === 0
      ? "No plan execution runs."
      : runs
          .map((run) => `${run.id} ${run.status} ${run.stage} ${run.planPath}`)
          .join("\n");
  }
  if (subcommand === "status") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: /exec status <run-id>");
    const run = await registry.get(runId);
    if (!run) throw new Error(`Plan execution run not found: ${runId}`);
    return `${run.id}\nstatus: ${run.status}\nstage: ${run.stage}\nbranch: ${run.branch}\nworktree: ${run.worktreeCwd}${run.error ? `\nerror: ${run.error}` : ""}`;
  }
  if (subcommand === "resume" || subcommand === "adopt") {
    const runId = rest[0];
    if (!runId) throw new Error(`Usage: /exec ${subcommand} <run-id>`);
    const run = await projector.sync(
      await controller.resume(runId, ctx.sessionManager.getSessionId()),
      { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
    );
    startBackgroundController(
      run.id,
      ctx.sessionManager.getSessionId(),
      ctx.cwd,
    );
    return `Run ${run.id}: ${run.status} (${run.stage})`;
  }
  if (subcommand === "pause") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: /exec pause <run-id>");
    const run = await registry.get(runId);
    if (!run) throw new Error(`Plan execution run not found: ${runId}`);
    await registry.update({ ...run, status: "paused" });
    return `Run ${run.id} paused after its active operation.`;
  }
  if (subcommand === "cancel") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: /exec cancel <run-id>");
    const run = await registry.get(runId);
    if (!run) throw new Error(`Plan execution run not found: ${runId}`);
    await registry.update({ ...run, status: "cancel_pending" });
    return `Run ${run.id} marked cancel-pending. Its worktree is preserved.`;
  }

  const planPath = args || (await selectPlan(ctx));
  const useWorktree = await chooseIsolation(ctx);
  const run = await projector.sync(
    await controller.start({
      cwd: ctx.cwd,
      planPath,
      useWorktree,
      sessionId: ctx.sessionManager.getSessionId(),
    }),
    { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() },
  );
  startBackgroundController(run.id, ctx.sessionManager.getSessionId(), ctx.cwd);
  return `Run ${run.id} started: ${run.status} (${run.stage})\nbranch: ${run.branch}\nworktree: ${run.worktreeCwd}`;
}

function isTerminal(status: string): boolean {
  return (
    status === "completed" ||
    status === "completed_with_findings" ||
    status === "failed" ||
    status === "cancelled"
  );
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
