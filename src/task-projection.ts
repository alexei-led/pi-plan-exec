import { join } from "node:path";
import { TaskStore } from "@tintinweb/pi-tasks/dist/task-store.js";
import type { Task, TaskStatus } from "@tintinweb/pi-tasks/dist/types.js";
import { readPlan } from "./plan.js";
import { RunRegistry } from "./registry.js";
import type { PlanExecRun, RunStage } from "./types.js";

const PIPELINE: Array<{ key: RunStage; subject: string }> = [
  { key: "comprehensive_review", subject: "Run comprehensive review" },
  { key: "smells_review", subject: "Run smells review" },
  { key: "fusion_review", subject: "Run Fusion review" },
  { key: "critical_review", subject: "Run critical review" },
  { key: "finalize", subject: "Finalize branch" },
  { key: "stats", subject: "Collect execution statistics" },
  { key: "archive", subject: "Archive completed plan" },
];

const STAGE_ORDER: RunStage[] = [
  "resolve",
  "isolation",
  "project_tasks",
  "branch",
  "progress",
  "implementation",
  ...PIPELINE.map((entry) => entry.key),
  "complete",
];

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
    const path = sessionTaskPath(options.cwd, options.sessionId);
    const store = openCompatibleStore(path);
    const plan = await readPlan(run.planPath);
    const existing = new Map(
      store
        .list()
        .filter((task) => task.metadata.planExecRunId === run.id)
        .map((task) => [String(task.metadata.planExecKey), task]),
    );
    const taskIds: Record<string, string> = {};
    let previousId: string | undefined;

    for (const task of plan.tasks) {
      const key = implementationKey(task.id);
      const projected = ensureTask(store, existing.get(key), {
        subject: `Implement Task ${task.id}: ${task.title}`,
        description: task.items.map((item) => `- [ ] ${item}`).join("\n"),
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
        description: `Plan-exec stage: ${entry.key}`,
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

    return this.registry.update({
      ...run,
      taskProjection: { sessionId: options.sessionId, listPath: path, taskIds },
    });
  }
}

export function sessionTaskPath(cwd: string, sessionId: string): string {
  if (!sessionId.trim())
    throw new Error("Pi session ID is required for pi-tasks projection.");
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

function openCompatibleStore(path: string): TaskStore {
  const store: unknown = new TaskStore(path);
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
  const current = run.activeOperation?.taskId;
  return run.stage === "implementation" && current === taskId
    ? "in_progress"
    : "pending";
}

function stageStatus(run: PlanExecRun, stage: RunStage): TaskStatus {
  const currentIndex = STAGE_ORDER.indexOf(run.stage);
  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (run.status === "completed" || run.status === "completed_with_findings")
    return "completed";
  if (currentIndex > stageIndex) return "completed";
  if (run.stage === stage) return "in_progress";
  return "pending";
}
