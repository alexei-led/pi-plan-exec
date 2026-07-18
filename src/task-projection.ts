import { basename, dirname, join } from "node:path";
import type { TaskStore } from "@tintinweb/pi-tasks/dist/task-store.js";
import type { Task, TaskStatus } from "@tintinweb/pi-tasks/dist/types.js";
import { PIPELINE_STAGES, isTerminalStatus, stageIndex } from "./lifecycle.js";
import { readPlan } from "./plan.js";
import { RunRegistry } from "./registry.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  RUN_STAGE,
  RUN_STATUS,
  type PlanExecRun,
  type RunStage,
} from "./types.js";

const STAGE_SUBJECT: Record<(typeof PIPELINE_STAGES)[number], string> = {
  [RUN_STAGE.COMPREHENSIVE_REVIEW]: "Run comprehensive review",
  [RUN_STAGE.SMELLS_REVIEW]: "Run smells review",
  [RUN_STAGE.FUSION_REVIEW]: "Run Fusion review",
  [RUN_STAGE.CRITICAL_REVIEW]: "Run critical review",
  [RUN_STAGE.FINALIZE]: "Finalize branch",
  [RUN_STAGE.STATS]: "Collect execution statistics",
  [RUN_STAGE.ARCHIVE]: "Archive completed plan",
};

const PIPELINE = PIPELINE_STAGES.map((key) => ({
  key,
  subject: STAGE_SUBJECT[key],
}));

const TASK_PROJECTION_KIND = {
  IMPLEMENTATION: RUN_STAGE.IMPLEMENTATION,
  STAGE: "stage",
} as const;

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
    const desiredKeys = new Set([
      ...plan.tasks.map((task) => implementationKey(task.id)),
      ...PIPELINE_STAGES,
    ]);
    for (const [key, task] of existing) {
      if (!desiredKeys.has(key as RunStage)) {
        store.delete(task.id);
        existing.delete(key);
      }
    }
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
          planExecKind: TASK_PROJECTION_KIND.IMPLEMENTATION,
        },
        blockedBy: previousId ? [previousId] : [],
      });
      taskIds[key] = projected.id;
      previousId = projected.id;
    }

    for (const entry of PIPELINE) {
      const skipped = run.skippedStages.find(
        (stage) => stage.stage === entry.key,
      );
      const projected = ensureTask(store, existing.get(entry.key), {
        subject: skipped ? `FORCE-SKIPPED: ${entry.subject}` : entry.subject,
        description: stageDescription(run, entry.key),
        metadata: {
          planExecRunId: run.id,
          planExecKey: entry.key,
          planExecKind: TASK_PROJECTION_KIND.STAGE,
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
      join(
        dirname(run.planPath),
        COMPLETED_PLANS_DIRECTORY,
        basename(run.planPath),
      ),
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
  return ["create", "delete", "get", "list", "update"].every(
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
  if (existing && !sameStrings(existing.blockedBy, desired.blockedBy)) {
    store.delete(existing.id);
    existing = undefined;
  }
  const task =
    existing ??
    store.create(
      desired.subject,
      desired.description,
      undefined,
      desired.metadata,
    );
  store.update(task.id, {
    subject: desired.subject,
    description: desired.description,
    metadata: desired.metadata,
    ...(desired.blockedBy.length > 0
      ? { addBlockedBy: desired.blockedBy }
      : {}),
  });
  return store.get(task.id) ?? task;
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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
  if (
    run.status !== RUN_STATUS.STARTING &&
    run.status !== RUN_STATUS.RUNNING
  )
    return "pending";
  const current = run.activeOperation?.taskId;
  return run.stage === RUN_STAGE.IMPLEMENTATION && current === taskId
    ? "in_progress"
    : "pending";
}

function stageStatus(run: PlanExecRun, stage: RunStage): TaskStatus {
  const currentIndex = stageIndex(run.stage);
  const projectedIndex = stageIndex(stage);
  if (
    run.status === RUN_STATUS.COMPLETED ||
    run.status === RUN_STATUS.COMPLETED_WITH_FINDINGS
  )
    return "completed";
  if (currentIndex > projectedIndex) return "completed";
  if (run.status === RUN_STATUS.SKIP_PENDING && run.stage === stage)
    return "in_progress";
  if (
    run.status !== RUN_STATUS.STARTING &&
    run.status !== RUN_STATUS.RUNNING
  )
    return "pending";
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
  if (isCurrent && run.status === RUN_STATUS.FAILED && run.error)
    return `${description}\n\nPlan-exec failed: ${run.error}`;
  if (isCurrent && run.status === RUN_STATUS.CANCELLED)
    return `${description}\n\nPlan-exec cancelled; its worktree is preserved.`;
  return description;
}

function stageDescription(run: PlanExecRun, stage: RunStage): string {
  const skipped = run.skippedStages.find((entry) => entry.stage === stage);
  if (skipped)
    return `Plan-exec stage: ${stage}\n\nFORCE-SKIPPED by ${skipped.requestedBy}: ${skipped.reason}`;
  const description = `Plan-exec stage: ${stage}`;
  if (run.stage === stage && run.status === RUN_STATUS.FAILED && run.error)
    return `${description}\n\nPlan-exec failed: ${run.error}`;
  if (run.stage === stage && run.status === RUN_STATUS.CANCELLED)
    return `${description}\n\nPlan-exec cancelled; its worktree is preserved.`;
  return description;
}
