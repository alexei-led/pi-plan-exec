import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { TaskStore } from "@tintinweb/pi-tasks/dist/task-store.js";
import type { Task, TaskStatus } from "@tintinweb/pi-tasks/dist/types.js";
import { PIPELINE_STAGES, isGoalRun, isTerminalStatus, requirePlanPath, stageIndex } from "./lifecycle.js";
import { readPlan } from "./plan.js";
import { RunRegistry } from "./registry.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  RUN_STAGE,
  RUN_STATUS,
  type TaskExecution,
  type PlanExecRun,
  type PlanTask,
  type RunStage,
} from "./types.js";

const TASK_PROJECTION_VERSION = 1 as const;
const TASK_PROJECTION_OWNER = "pi-plan-exec" as const;
const SUPPORTED_PI_TASKS_VERSION = /^0\.9\.\d+(?:[-+].*)?$/;

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

export const TASK_EXECUTION_STATE = {
  READY: "ready",
  RUNNING: "running",
  VERIFYING: "verifying",
  RETRY_WAIT: "retry_wait",
  WAITING_DEPENDENCY: "waiting_dependency",
  WAITING_EXTERNAL: "waiting_external",
  ACCEPTED: "accepted",
} as const;

type ProjectionScope = Exclude<
  NonNullable<PlanExecRun["taskProjection"]>["scope"],
  undefined
>;

interface ProjectionTarget {
  scope: ProjectionScope;
  listPath: string;
  storeTarget: string;
  packageVersion: string;
}

export interface TaskProjectionOptions {
  cwd: string;
  sessionId: string;
}

export interface TaskProjectionSummary {
  total: number;
  accepted: number;
  ready: number;
  running: number;
  retry: number;
  dependency: number;
  external: number;
  attention: number;
}

/** Summarise durable task state without reading the optional pi-tasks cache. */
export function taskProjectionSummary(run: PlanExecRun): TaskProjectionSummary {
  const tasks = Object.values(run.tasks ?? {});
  const summary: TaskProjectionSummary = {
    total: tasks.length,
    accepted: 0,
    ready: 0,
    running: 0,
    retry: 0,
    dependency: 0,
    external: 0,
    attention: 0,
  };
  for (const task of tasks) {
    if (task.state === TASK_EXECUTION_STATE.ACCEPTED) summary.accepted += 1;
    else if (task.state === TASK_EXECUTION_STATE.READY) summary.ready += 1;
    else if (
      task.state === TASK_EXECUTION_STATE.RUNNING ||
      task.state === TASK_EXECUTION_STATE.VERIFYING
    )
      summary.running += 1;
    else if (task.state === TASK_EXECUTION_STATE.RETRY_WAIT) summary.retry += 1;
    else if (task.state === TASK_EXECUTION_STATE.WAITING_DEPENDENCY)
      summary.dependency += 1;
    else if (task.state === TASK_EXECUTION_STATE.WAITING_EXTERNAL)
      summary.external += 1;
    if (task.reason || task.state === TASK_EXECUTION_STATE.WAITING_EXTERNAL)
      summary.attention += 1;
  }
  return summary;
}

/** The PlanExecRun is authoritative; this only repairs pi-tasks' file cache. */
export class TaskProjector {
  constructor(private readonly registry: RunRegistry) {}

  async sync(
    run: PlanExecRun,
    options: TaskProjectionOptions,
  ): Promise<PlanExecRun> {
    if (isGoalRun(run)) return run;
    const current = await this.registry.get(run.id);
    if (current && current.updatedAt > run.updatedAt) run = current;
    try {
      const target = await resolveProjectionTarget(options);
      const store = await openCompatibleStore(target.storeTarget);
      const plan = await readProjectionPlan(run);
      const tasks = store.list();
      const existing = deduplicateOwnedTasks(store, tasks, run);
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
      const commonMetadata = {
        planExecOwner: TASK_PROJECTION_OWNER,
        planExecRunId: run.id,
        planExecRevision: run.revision ?? 1,
        planStatus: run.status,
        planExecProjectionVersion: TASK_PROJECTION_VERSION,
      };
      for (const task of plan.tasks) {
        const key = implementationKey(task.id);
        const execution = taskExecution(run, task.id);
        const dependencies = task.dependsOn
          .map((dependency) => taskIds[implementationKey(dependency)])
          .filter((id): id is string => id !== undefined);
        const projected = ensureTask(store, existing.get(key), {
          subject: `Implement Task ${task.id}: ${task.title}`,
          description: implementationDescription(
            run,
            task.items,
            task.id === firstIncompleteTaskId,
            execution,
          ),
          metadata: {
            ...commonMetadata,
            planExecKey: key,
            planExecKind: TASK_PROJECTION_KIND.IMPLEMENTATION,
            planExecTaskId: task.id,
            planExecDependsOn: task.dependsOn,
            ...(execution ? taskExecutionMetadata(execution) : {}),
          },
          blockedBy: dependencies,
        });
        taskIds[key] = projected.id;
      }

      const implementationIds = plan.tasks
        .map((task) => taskIds[implementationKey(task.id)])
        .filter((id): id is string => id !== undefined);
      let previousId: string | undefined;
      for (const entry of PIPELINE) {
        const skipped = run.skippedStages.find(
          (stage) => stage.stage === entry.key,
        );
        const projected = ensureTask(store, existing.get(entry.key), {
          subject: skipped ? `FORCE-SKIPPED: ${entry.subject}` : entry.subject,
          description: stageDescription(run, entry.key),
          metadata: {
            ...commonMetadata,
            planExecKey: entry.key,
            planExecKind: TASK_PROJECTION_KIND.STAGE,
          },
          blockedBy:
            entry === PIPELINE[0]
              ? implementationIds
              : previousId
                ? [previousId]
                : [],
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
            implementationStatus(
              run,
              task,
              task.unchecked.length === 0,
            ),
          );
      }
      for (const entry of PIPELINE) {
        const projected = store.get(taskIds[entry.key] ?? "");
        if (projected)
          updateStatus(store, projected, stageStatus(run, entry.key));
      }

      return this.persistState(run, {
        version: TASK_PROJECTION_VERSION,
        state: "ready",
        owner: TASK_PROJECTION_OWNER,
        sessionId: options.sessionId,
        scope: target.scope,
        listPath: target.listPath,
        packageVersion: target.packageVersion,
        revision: run.revision ?? 1,
        taskIds,
      });
    } catch (error: unknown) {
      return this.persistState(run, {
        version: TASK_PROJECTION_VERSION,
        state: "degraded",
        owner: TASK_PROJECTION_OWNER,
        sessionId: options.sessionId,
        revision: run.revision ?? 1,
        taskIds: run.taskProjection?.taskIds ?? {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async persistState(
    run: PlanExecRun,
    taskProjection: NonNullable<PlanExecRun["taskProjection"]>,
  ): Promise<PlanExecRun> {
    if (sameProjection(run.taskProjection, taskProjection)) return run;
    return this.registry.updateTaskProjection(run, taskProjection);
  }
}

export function sessionTaskPath(cwd: string, sessionId: string): string {
  if (!sessionId.trim())
    throw new Error("Pi session ID is required for pi-tasks projection.");
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

async function resolveProjectionTarget(
  options: TaskProjectionOptions,
): Promise<ProjectionTarget> {
  if (!options.sessionId.trim())
    throw new Error("Pi session ID is required for pi-tasks projection.");
  const packageVersion = piTasksPackageVersion();
  if (!SUPPORTED_PI_TASKS_VERSION.test(packageVersion))
    throw new Error(
      `pi-tasks ${packageVersion} is unsupported; plan-exec requires 0.9.x for projection.`,
    );

  const configured = process.env.PI_TASKS;
  const expectedPath = sessionTaskPath(options.cwd, options.sessionId);
  if (configured === "off")
    throw new Error("PI_TASKS=off selects memory scope; no durable projection path exists.");
  if (configured) {
    const configuredPath = isAbsolute(configured)
      ? configured
      : configured.startsWith(".")
        ? resolve(options.cwd, configured)
        : join(homedir(), ".pi", "tasks", `${configured}.json`);
    if (resolve(configuredPath) !== resolve(expectedPath))
      throw new Error(
        `PI_TASKS selects ${configuredPath}; plan-exec requires the session path ${expectedPath}.`,
      );
    return {
      scope: "session",
      listPath: expectedPath,
      storeTarget: expectedPath,
      packageVersion,
    };
  }

  const [{ loadTasksConfig }] = await Promise.all([
    import("@tintinweb/pi-tasks/dist/tasks-config.js"),
  ]);
  const scope = loadTasksConfig(options.cwd).taskScope ?? "session";
  if (scope !== "session")
    throw new Error(
      `pi-tasks scope ${scope} is unsupported; plan-exec requires session scope.`,
    );
  return {
    scope: "session",
    listPath: expectedPath,
    storeTarget: expectedPath,
    packageVersion,
  };
}

function piTasksPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const packageJson: unknown = require("@tintinweb/pi-tasks/package.json");
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  )
    throw new Error("Installed pi-tasks package has no readable version.");
  return packageJson.version;
}

function sameProjection(
  left: PlanExecRun["taskProjection"],
  right: PlanExecRun["taskProjection"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deduplicateOwnedTasks(
  store: TaskStore,
  tasks: Task[],
  run: PlanExecRun,
): Map<string, Task> {
  const existing = new Map<string, Task>();
  for (const task of tasks) {
    if (!isOwnedTask(task, run)) continue;
    const key = task.metadata.planExecKey;
    if (typeof key !== "string" || !key) {
      store.delete(task.id);
      continue;
    }
    const duplicate = existing.get(key);
    if (!duplicate) {
      existing.set(key, task);
      continue;
    }
    const preferredId = run.taskProjection?.taskIds[key];
    const keep =
      task.id === preferredId ||
      (duplicate.id !== preferredId && task.id < duplicate.id)
        ? task
        : duplicate;
    store.delete(keep.id === task.id ? duplicate.id : task.id);
    existing.set(key, keep);
  }
  return existing;
}

function isOwnedTask(task: Task, run: PlanExecRun): boolean {
  return (
    task.metadata.planExecOwner === TASK_PROJECTION_OWNER &&
    task.metadata.planExecRunId === run.id
  );
}

async function readProjectionPlan(run: PlanExecRun) {
  const planPath = requirePlanPath(run);
  try {
    return await readPlan(planPath);
  } catch (error: unknown) {
    if (!isTerminalStatus(run.status) || !isNodeError(error, "ENOENT"))
      throw error;
    return readPlan(
      join(
        dirname(planPath),
        COMPLETED_PLANS_DIRECTORY,
        basename(planPath),
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
    metadata: { ...desired.metadata, agentType: null },
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
  task: PlanTask,
  complete: boolean,
): TaskStatus {
  const execution = taskExecution(run, task.id);
  if (execution?.state === TASK_EXECUTION_STATE.ACCEPTED)
    return complete ? "completed" : "pending";
  if (!execution && complete) return "completed";
  if (run.status !== RUN_STATUS.STARTING && run.status !== RUN_STATUS.RUNNING)
    return "pending";
  const current = run.activeOperation?.taskId;
  return run.stage === RUN_STAGE.IMPLEMENTATION && current === task.id
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
  if (run.status !== RUN_STATUS.STARTING && run.status !== RUN_STATUS.RUNNING)
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
  execution?: TaskExecution,
): string {
  const description = items.map((item) => `- [ ] ${item}`).join("\n");
  const details = execution ? taskExecutionDescription(execution) : undefined;
  if (isCurrent && run.status === RUN_STATUS.FAILED && run.error)
    return `${description}\n\nPlan-exec failed: ${run.error}${details ? `\n${details}` : ""}`;
  if (isCurrent && run.status === RUN_STATUS.CANCELLED)
    return `${description}\n\nPlan-exec cancelled; its worktree is preserved.${details ? `\n${details}` : ""}`;
  return details ? `${description}\n\n${details}` : description;
}

function taskExecution(run: PlanExecRun, taskId: number): TaskExecution | undefined {
  return run.tasks?.[String(taskId)];
}

function taskExecutionMetadata(execution: TaskExecution): Record<string, unknown> {
  return {
    planExecTaskState: execution.state,
    planExecAttempts: execution.attempts,
    ...(execution.reason ? { planExecReason: execution.reason } : {}),
    ...(execution.nextAttemptAt !== undefined
      ? { planExecNextAttemptAt: execution.nextAttemptAt }
      : {}),
    ...(execution.lastVerifiedActivityAt !== undefined
      ? { planExecLastVerifiedActivityAt: execution.lastVerifiedActivityAt }
      : {}),
    ...(execution.usage ? { planExecUsage: execution.usage } : {}),
  };
}

function taskExecutionDescription(execution: TaskExecution): string {
  const details = [
    `Task state: ${execution.state}`,
    `Attempts: ${execution.attempts}`,
    ...(execution.reason ? [`Reason: ${execution.reason}`] : []),
    ...(execution.nextAttemptAt !== undefined
      ? [`Next automatic attempt: ${new Date(execution.nextAttemptAt).toISOString()}`]
      : []),
    ...(execution.lastVerifiedActivityAt !== undefined
      ? [`Last verified activity: ${new Date(execution.lastVerifiedActivityAt).toISOString()}`]
      : []),
  ];
  return details.join("\n");
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
