import { randomUUID } from "node:crypto";
import { isSkippableStage } from "./lifecycle.js";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_FROZEN_RUN_CONFIG,
  OPERATION_KIND,
  RUN_STAGE,
  RUN_STATUS,
  RUN_STAGES,
  RUN_STATUSES,
  type ActiveOperation,
  type PlanExecRun,
  type RunStage,
} from "./types.js";

const RUNS_DIRECTORY = join(homedir(), ".pi", "plan-exec", "runs");
export const LEASE_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const LOCK_STALE_MS = 10_000;
const CONTROLLER_LOCK_MAX_RETRIES = 20;
const CONTROLLER_LOCK_STALE_MS = 120_000;
const CLAIM_CAS_RETRIES = 5;
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The global orchestration store. It is deliberately separate from pi-tasks:
 * pi-tasks is session-scoped UI projection, while this record survives adoption.
 */
export class RunRegistry {
  constructor(private readonly directory = RUNS_DIRECTORY) {}

  async create(
    run: Omit<
      PlanExecRun,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "skippedStages"
      | "branchRebindings"
    > & {
      skippedStages?: PlanExecRun["skippedStages"];
      branchRebindings?: PlanExecRun["branchRebindings"];
    },
  ): Promise<PlanExecRun> {
    const now = Date.now();
    const created: PlanExecRun = {
      ...run,
      skippedStages: run.skippedStages ?? [],
      branchRebindings: run.branchRebindings ?? [],
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.write(created);
    return created;
  }

  async get(runId: string): Promise<PlanExecRun | undefined> {
    assertRunId(runId);
    try {
      return parseRun(await readFile(this.pathFor(runId), "utf8"), runId);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async list(): Promise<PlanExecRun[]> {
    return (await this.listWithErrors()).runs;
  }

  async listWithErrors(): Promise<{
    runs: PlanExecRun[];
    errors: Array<{ runId: string; message: string }>;
  }> {
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(this.directory, { withFileTypes: true });
      const loaded = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
          .map(async (entry) => {
            try {
              return { run: await this.get(entry.name) };
            } catch (error: unknown) {
              return {
                error: {
                  runId: entry.name,
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              };
            }
          }),
      );
      return {
        runs: loaded
          .flatMap((item) => (item.run ? [item.run] : []))
          .sort((a, b) => b.updatedAt - a.updatedAt),
        errors: loaded.flatMap((item) => (item.error ? [item.error] : [])),
      };
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return { runs: [], errors: [] };
      throw error;
    }
  }

  async update(run: PlanExecRun): Promise<PlanExecRun> {
    return (await this.updateIfCurrent(run, run.updatedAt)).run;
  }

  async updateIfCurrent(
    run: PlanExecRun,
    expectedUpdatedAt: number,
  ): Promise<{ run: PlanExecRun; applied: boolean }> {
    assertRun(run);
    const path = this.pathFor(run.id);
    const lockPath = `${path}.lock`;
    const lock = await acquireLock(lockPath);
    try {
      let current: PlanExecRun;
      try {
        current = parseRun(await readFile(path, "utf8"), run.id);
      } catch (error: unknown) {
        if (isNodeError(error, "ENOENT"))
          throw new Error(`Plan execution run not found: ${run.id}`, {
            cause: error,
          });
        throw error;
      }
      if (current.updatedAt !== expectedUpdatedAt)
        return { run: current, applied: false };
      const updated: PlanExecRun = {
        ...run,
        updatedAt: nextUpdatedAt(current.updatedAt),
      };
      await writeLocked(path, updated);
      return { run: updated, applied: true };
    } finally {
      await releaseLock(lockPath, lock);
    }
  }

  async claim(run: PlanExecRun, sessionId: string): Promise<PlanExecRun> {
    if (!sessionId.trim())
      throw new Error("A Pi session ID is required to claim a run.");
    let current = run;
    for (let attempt = 0; attempt < CLAIM_CAS_RETRIES; attempt += 1) {
      const now = Date.now();
      const lease = current.lease;
      if (
        lease &&
        lease.sessionId !== sessionId &&
        now - lease.heartbeatAt < LEASE_STALE_MS
      ) {
        throw new Error(
          `Run ${current.id} is controlled by another active Pi session.`,
        );
      }
      const claimed = await this.updateIfCurrent(
        {
          ...current,
          lease: { sessionId, pid: process.pid, heartbeatAt: now },
        },
        current.updatedAt,
      );
      if (claimed.applied) return claimed.run;
      current = claimed.run;
    }
    throw new Error(`Run ${run.id} changed repeatedly while being claimed.`);
  }

  async withControllerLock<T>(
    runId: string,
    callback: () => Promise<T>,
  ): Promise<T | undefined> {
    const path = `${this.pathFor(runId)}.controller.lock`;
    let lock;
    try {
      lock = await acquireLock(
        path,
        CONTROLLER_LOCK_MAX_RETRIES,
        CONTROLLER_LOCK_STALE_MS,
      );
    } catch (error: unknown) {
      if (error instanceof LockTimeoutError) return undefined;
      throw error;
    }
    try {
      return await callback();
    } finally {
      await releaseLock(path, lock);
    }
  }

  async heartbeat(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.lease) return run;
    const heartbeat = await this.updateIfCurrent(
      {
        ...run,
        lease: { ...run.lease, heartbeatAt: Date.now() },
      },
      run.updatedAt,
    );
    return heartbeat.run;
  }

  async release(run: PlanExecRun): Promise<PlanExecRun> {
    const released = { ...run };
    delete released.lease;
    return this.update(released);
  }

  private pathFor(runId: string): string {
    assertRunId(runId);
    return join(this.directory, runId, "run.json");
  }

  private async write(run: PlanExecRun): Promise<void> {
    const path = this.pathFor(run.id);
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    const lock = await acquireLock(lockPath);
    try {
      await writeLocked(path, run);
    } finally {
      await releaseLock(lockPath, lock);
    }
  }
}

async function writeLocked(path: string, run: PlanExecRun): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function acquireLock(
  path: string,
  maxRetries = LOCK_MAX_RETRIES,
  staleMs = LOCK_STALE_MS,
) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      const token = randomUUID();
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })}\n`,
        "utf8",
      );
      return { handle, token };
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
      await removeStaleLock(path, staleMs);
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new LockTimeoutError(path);
}

class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out acquiring plan-exec registry lock: ${path}`);
  }
}

async function removeStaleLock(path: string, staleMs: number): Promise<void> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const parsed: unknown = raw.startsWith("{") ? JSON.parse(raw) : undefined;
    const pid = isRecord(parsed)
      ? numberOr(parsed.pid, 0)
      : Number.parseInt(raw, 10);
    const createdAt = isRecord(parsed)
      ? numberOr(parsed.createdAt, 0)
      : (await stat(path)).mtimeMs;
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !isProcessRunning(pid) ||
      (createdAt > 0 && Date.now() - createdAt > staleMs)
    ) {
      await rm(path, { force: true });
    }
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function releaseLock(
  path: string,
  lock: { handle: Awaited<ReturnType<typeof open>>; token: string },
): Promise<void> {
  await lock.handle.close();
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed) && parsed.token === lock.token) {
      await rm(path, { force: true });
    }
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT") && !(error instanceof SyntaxError))
      throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRun(raw: string, runId: string): PlanExecRun {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.id !== runId || value.schemaVersion !== 1) {
    throw new Error(`Invalid plan-exec run registry entry: ${runId}`);
  }
  const migrated = migrateLegacyRun(value);
  assertRun(migrated);
  return migrated;
}

function migrateLegacyRun(value: Record<string, unknown>): PlanExecRun {
  const stage =
    value.stage === "tasks" ? RUN_STAGE.PROJECT_TASKS : value.stage;
  const config = isRecord(value.config) ? value.config : {};
  return {
    ...(value as unknown as PlanExecRun),
    stage: stage as RunStage,
    stageAttempts: isRecord(value.stageAttempts)
      ? (value.stageAttempts as Record<string, number>)
      : {},
    reviewFindings: Array.isArray(value.reviewFindings)
      ? (value.reviewFindings as PlanExecRun["reviewFindings"])
      : [],
    unresolvedFindings: Array.isArray(value.unresolvedFindings)
      ? (value.unresolvedFindings as PlanExecRun["unresolvedFindings"])
      : [],
    skippedStages:
      value.skippedStages === undefined
        ? []
        : (value.skippedStages as PlanExecRun["skippedStages"]),
    branchRebindings:
      value.branchRebindings === undefined
        ? []
        : (value.branchRebindings as PlanExecRun["branchRebindings"]),
    config: {
      ...config,
      taskRetries: numberOr(
        config.taskRetries,
        DEFAULT_FROZEN_RUN_CONFIG.taskRetries,
      ),
      maxTaskIterations: numberOr(
        config.maxTaskIterations,
        DEFAULT_FROZEN_RUN_CONFIG.maxTaskIterations,
      ),
      reviewIterations: numberOr(
        config.reviewIterations,
        DEFAULT_FROZEN_RUN_CONFIG.reviewIterations,
      ),
      fusionIterations: numberOr(
        config.fusionIterations,
        DEFAULT_FROZEN_RUN_CONFIG.fusionIterations,
      ),
      finalizeEnabled: booleanOr(
        config.finalizeEnabled,
        DEFAULT_FROZEN_RUN_CONFIG.finalizeEnabled,
      ),
      workerAgent: stringOr(
        config.workerAgent,
        DEFAULT_FROZEN_RUN_CONFIG.workerAgent,
      ),
      workerMaxTurns: numberOr(
        config.workerMaxTurns,
        DEFAULT_FROZEN_RUN_CONFIG.workerMaxTurns,
      ),
      reviewerAgent: stringOr(
        config.reviewerAgent,
        DEFAULT_FROZEN_RUN_CONFIG.reviewerAgent,
      ),
      reviewerMaxTurns: numberOr(
        config.reviewerMaxTurns,
        DEFAULT_FROZEN_RUN_CONFIG.reviewerMaxTurns,
      ),
      statsAgent: stringOr(
        config.statsAgent,
        DEFAULT_FROZEN_RUN_CONFIG.statsAgent,
      ),
      statsMaxTurns: numberOr(
        config.statsMaxTurns,
        DEFAULT_FROZEN_RUN_CONFIG.statsMaxTurns,
      ),
    } as PlanExecRun["config"],
  };
}

function assertRun(run: PlanExecRun): void {
  assertRunId(run.id);
  if (
    !RUN_STAGES.includes(run.stage) ||
    !RUN_STATUSES.includes(run.status) ||
    !Number.isFinite(run.createdAt) ||
    !Number.isFinite(run.updatedAt) ||
    !isFrozenConfig(run.config) ||
    !Array.isArray(run.skippedStages) ||
    !run.skippedStages.every(
      (skip) =>
        isValidStageSkip(skip, true) &&
        isSkippableStage(skip.stage as RunStage),
    ) ||
    !Array.isArray(run.branchRebindings) ||
    !run.branchRebindings.every(isValidBranchRebinding) ||
    (run.pendingStageSkip !== undefined &&
      (!isValidStageSkip(run.pendingStageSkip, false) ||
        run.pendingStageSkip.stage !== run.stage ||
        !isSkippableStage(run.pendingStageSkip.stage) ||
        (run.status !== RUN_STATUS.SKIP_PENDING &&
          run.status !== RUN_STATUS.FAILED &&
          run.status !== RUN_STATUS.PAUSED))) ||
    (run.status === RUN_STATUS.SKIP_PENDING &&
      run.pendingStageSkip === undefined) ||
    !isValidOperationForStage(run.activeOperation, run.stage) ||
    !isValidOperationForStage(run.failedOperation, run.stage)
  ) {
    throw new Error(`Invalid plan-exec run registry entry: ${run.id}`);
  }
}

function isFrozenConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskRetries === "number" &&
    typeof value.maxTaskIterations === "number" &&
    typeof value.reviewIterations === "number" &&
    typeof value.fusionIterations === "number" &&
    typeof value.finalizeEnabled === "boolean" &&
    typeof value.workerAgent === "string" &&
    typeof value.workerMaxTurns === "number" &&
    typeof value.reviewerAgent === "string" &&
    typeof value.reviewerMaxTurns === "number" &&
    typeof value.statsAgent === "string" &&
    typeof value.statsMaxTurns === "number"
  );
}

function isValidBranchRebinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.from === "string" &&
    value.from.trim().length > 0 &&
    typeof value.to === "string" &&
    value.to.trim().length > 0 &&
    value.from !== value.to &&
    typeof value.requestedBy === "string" &&
    value.requestedBy.trim().length > 0 &&
    typeof value.requestedAt === "number" &&
    Number.isFinite(value.requestedAt)
  );
}

function isValidStageSkip(value: unknown, completed: boolean): boolean {
  if (!isRecord(value)) return false;
  return (
    RUN_STAGES.includes(value.stage as RunStage) &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    typeof value.requestedBy === "string" &&
    value.requestedBy.trim().length > 0 &&
    typeof value.requestedAt === "number" &&
    Number.isFinite(value.requestedAt) &&
    (!completed ||
      (typeof value.completedAt === "number" &&
        Number.isFinite(value.completedAt)))
  );
}

function isValidOperationForStage(
  operation: ActiveOperation | undefined,
  stage: RunStage,
): boolean {
  if (!operation) return true;
  const stages: Record<ActiveOperation["kind"], readonly RunStage[]> = {
    [OPERATION_KIND.IMPLEMENTATION]: [RUN_STAGE.IMPLEMENTATION],
    [OPERATION_KIND.REVIEW]: [
      RUN_STAGE.COMPREHENSIVE_REVIEW,
      RUN_STAGE.SMELLS_REVIEW,
      RUN_STAGE.CRITICAL_REVIEW,
    ],
    [OPERATION_KIND.FIX]: [
      RUN_STAGE.COMPREHENSIVE_REVIEW,
      RUN_STAGE.SMELLS_REVIEW,
      RUN_STAGE.FUSION_REVIEW,
      RUN_STAGE.CRITICAL_REVIEW,
    ],
    [OPERATION_KIND.FUSION]: [RUN_STAGE.FUSION_REVIEW],
    [OPERATION_KIND.FINALIZE]: [RUN_STAGE.FINALIZE],
    [OPERATION_KIND.STATS]: [RUN_STAGE.STATS],
  };
  return stages[operation.kind].includes(stage);
}

function nextUpdatedAt(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error("Invalid plan-exec run ID.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
