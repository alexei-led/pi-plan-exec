import { randomUUID } from "node:crypto";
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
import { RUN_STAGES, type PlanExecRun, type RunStage } from "./types.js";

const RUNS_DIRECTORY = join(homedir(), ".pi", "plan-exec", "runs");
const LEASE_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const LOCK_STALE_MS = 10_000;
const CONTROLLER_LOCK_MAX_RETRIES = 20;
const CONTROLLER_LOCK_STALE_MS = 120_000;
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The global orchestration store. It is deliberately separate from pi-tasks:
 * pi-tasks is session-scoped UI projection, while this record survives adoption.
 */
export class RunRegistry {
  constructor(private readonly directory = RUNS_DIRECTORY) {}

  async create(
    run: Omit<PlanExecRun, "id" | "createdAt" | "updatedAt">,
  ): Promise<PlanExecRun> {
    const now = Date.now();
    const created: PlanExecRun = {
      ...run,
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
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(this.directory, { withFileTypes: true });
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
          .map((entry) => this.get(entry.name)),
      );
      return runs
        .filter((run): run is PlanExecRun => run !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return [];
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
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
  const stage = value.stage === "tasks" ? "project_tasks" : value.stage;
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
    config: {
      ...config,
      reviewIterations: numberOr(config.reviewIterations, 5),
      fusionIterations: numberOr(config.fusionIterations, 10),
      finalizeEnabled: booleanOr(config.finalizeEnabled, true),
      reviewerAgent: stringOr(config.reviewerAgent, "reviewer"),
      reviewerMaxTurns: numberOr(config.reviewerMaxTurns, 30),
      statsAgent: stringOr(config.statsAgent, "reviewer"),
      statsMaxTurns: numberOr(config.statsMaxTurns, 30),
    } as PlanExecRun["config"],
  };
}

function assertRun(run: PlanExecRun): void {
  assertRunId(run.id);
  if (
    !RUN_STAGES.includes(run.stage) ||
    !Number.isFinite(run.createdAt) ||
    !Number.isFinite(run.updatedAt)
  ) {
    throw new Error(`Invalid plan-exec run registry entry: ${run.id}`);
  }
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
