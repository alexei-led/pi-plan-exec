import { basename, dirname, join } from "node:path";
import type { TaskStore } from "@tintinweb/pi-tasks/dist/task-store.js";
import type { Task, TaskStatus } from "@tintinweb/pi-tasks/dist/types.js";
import { PIPELINE_STAGES, isTerminalStatus, stageIndex } from "./lifecycle.js";
import { readPlan } from "./plan.js";
import { RunRegistry } from "./registry.js";
import type { PlanExecRun, RunStage } from "./types.js";

const STAGE_SUBJECT: Record<(typeof PIPELINE_STAGES)[number], string> = {
  comprehensive_review: "Run comprehensive review",
  smells_review: "Run smells review",
  fusion_review: "Run Fusion review",
  critical_review: "Run critical review",
  finalize: "Finalize branch",
  stats: "Collect execution statistics",
  archive: "Archive completed plan",
};

const PIPELINE = PIPELINE_STAGES.map((key) => ({
  key,
  subject: STAGE_SUBJECT[key],
}));

export interface TaskProjectionOptions {
  cwd: string;
  sessionId: string;
}

/**
 * Writes the same task file format and locking protocol as pi-tasks. This is a
 * session projection only: the global PlanExecRun remains authoritative.
 */
export class TaskProjector {
  constructor(private readonly registry: RunRegistry) {}

  async sync(
    run: PlanExecRun,
    options: TaskProjectionOptions,
  ): Promise<PlanExecRun> {
    const current = await this.registry.get(run.id);
    if (current && current.updatedAt > run.updatedAt) run = current;
    const path = sessionTaskPath(options.cwd, options.sessionId);
    const store = await openCompatibleStore(path);
    const plan = await readProjectionPlan(run);
    const existing = new Map(
      store
        .list()
        .filter((task) => task.metadata.planExecRunId === run.id)
        .map((task) => [String(task.metadata.planExecKey), task]),
    );
    const taskIds: Record<string, string> = {};
    const firstIncompleteTaskId = plan.tasks.find(
      (task) => task.unchecked.length > 0,
    )?.id;
    let previousId: string | undefined;

    for (const task of plan.tasks) {
      const key = implementationKey(task.id);
      const projected = ensureTask(store, existing.get(key), {
        subject: `Implement Task ${task.id}: ${task.title}`,
        description: implementationDescription(
          run,
          task.items,
          task.id === firstIncompleteTaskId,
        ),
        metadata: {
          planExecRunId: run.id,
          planExecKey: key,
          planExecKind: "implementation",
        },
        blockedBy: previousId ? [previousId] : [],
      });
      taskIds[key] = projected.id;
      previousId = projected.id;
    }

    for (const entry of PIPELINE) {
      const projected = ensureTask(store, existing.get(entry.key), {
        subject: entry.subject,
        description: stageDescription(run, entry.key),
        metadata: {
          planExecRunId: run.id,
          planExecKey: entry.key,
          planExecKind: "stage",
        },
        blockedBy: previousId ? [previousId] : [],
      });
      taskIds[entry.key] = projected.id;
      previousId = projected.id;
    }

    for (const task of plan.tasks) {
      const key = implementationKey(task.id);
      const projected = store.get(taskIds[key] ?? "");
      if (projected)
        updateStatus(
          store,
          projected,
          implementationStatus(run, task.id, task.unchecked.length === 0),
        );
    }
    for (const entry of PIPELINE) {
      const projected = store.get(taskIds[entry.key] ?? "");
      if (projected)
        updateStatus(store, projected, stageStatus(run, entry.key));
    }

    const persisted = await this.registry.updateIfCurrent(
      {
        ...run,
        taskProjection: {
          sessionId: options.sessionId,
          listPath: path,
          taskIds,
        },
      },
      run.updatedAt,
    );
    if (!persisted.applied && persisted.run.updatedAt !== run.updatedAt)
      return this.sync(persisted.run, options);
    return persisted.run;
  }
}

export function sessionTaskPath(cwd: string, sessionId: string): string {
  if (!sessionId.trim())
    throw new Error("Pi session ID is required for pi-tasks projection.");
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

async function readProjectionPlan(run: PlanExecRun) {
  try {
    return await readPlan(run.planPath);
  } catch (error: unknown) {
    if (!isTerminalStatus(run.status) || !isNodeError(error, "ENOENT"))
      throw error;
    return readPlan(
      join(dirname(run.planPath), "completed", basename(run.planPath)),
    );
  }
}

async function openCompatibleStore(path: string): Promise<TaskStore> {
  const { TaskStore: TaskStoreConstructor } =
    await import("@tintinweb/pi-tasks/dist/task-store.js");
  const store: unknown = new TaskStoreConstructor(path);
  if (!hasTaskStoreContract(store)) {
    throw new Error(
      "Installed pi-tasks TaskStore is incompatible with plan-exec projection.",
    );
  }
  return store;
}

function hasTaskStoreContract(value: unknown): value is TaskStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["create", "get", "list", "update"].every(
    (name) => typeof candidate[name] === "function",
  );
}

function ensureTask(
  store: TaskStore,
  existing: Task | undefined,
  desired: {
    subject: string;
    description: string;
    metadata: Record<string, unknown>;
    blockedBy: string[];
  },
): Task {
  const task =
    existing ??
    store.create(
      desired.subject,
      desired.description,
      undefined,
      desired.metadata,
    );
  const currentBlockers = new Set(task.blockedBy);
  const missingBlockers = desired.blockedBy.filter(
    (id) => !currentBlockers.has(id),
  );
  store.update(task.id, {
    subject: desired.subject,
    description: desired.description,
    metadata: desired.metadata,
    ...(missingBlockers.length > 0 ? { addBlockedBy: missingBlockers } : {}),
  });
  return store.get(task.id) ?? task;
}

function updateStatus(store: TaskStore, task: Task, status: TaskStatus): void {
  if (task.status !== status) store.update(task.id, { status });
}

function implementationKey(id: number): string {
  return `implementation:${id}`;
}

function implementationStatus(
  run: PlanExecRun,
  taskId: number,
  complete: boolean,
): TaskStatus {
  if (complete) return "completed";
  if (run.status !== "starting" && run.status !== "running") return "pending";
  const current = run.activeOperation?.taskId;
  return run.stage === "implementation" && current === taskId
    ? "in_progress"
    : "pending";
}

function stageStatus(run: PlanExecRun, stage: RunStage): TaskStatus {
  const currentIndex = stageIndex(run.stage);
  const projectedIndex = stageIndex(stage);
  if (run.status === "completed" || run.status === "completed_with_findings")
    return "completed";
  if (currentIndex > projectedIndex) return "completed";
  if (run.status !== "starting" && run.status !== "running") return "pending";
  if (run.stage === stage) return "in_progress";
  return "pending";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function implementationDescription(
  run: PlanExecRun,
  items: string[],
  isCurrent: boolean,
): string {
  const description = items.map((item) => `- [ ] ${item}`).join("\n");
  if (isCurrent && run.status === "failed" && run.error)
    return `${description}\n\nPlan-exec failed: ${run.error}`;
  if (isCurrent && run.status === "cancelled")
    return `${description}\n\nPlan-exec cancelled; its worktree is preserved.`;
  return description;
}

function stageDescription(run: PlanExecRun, stage: RunStage): string {
  const description = `Plan-exec stage: ${stage}`;
  if (run.stage === stage && run.status === "failed" && run.error)
    return `${description}\n\nPlan-exec failed: ${run.error}`;
  if (run.stage === stage && run.status === "cancelled")
    return `${description}\n\nPlan-exec cancelled; its worktree is preserved.`;
  return description;
}
