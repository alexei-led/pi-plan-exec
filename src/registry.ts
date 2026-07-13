import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RUN_STAGES, type PlanExecRun, type RunStage } from "./types.js";

const RUNS_DIRECTORY = join(homedir(), ".pi", "plan-exec", "runs");
const LEASE_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
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
    assertRun(run);
    const updated: PlanExecRun = { ...run, updatedAt: Date.now() };
    await this.write(updated);
    return updated;
  }

  async claim(run: PlanExecRun, sessionId: string): Promise<PlanExecRun> {
    if (!sessionId.trim())
      throw new Error("A Pi session ID is required to claim a run.");
    const now = Date.now();
    const lease = run.lease;
    if (
      lease &&
      lease.sessionId !== sessionId &&
      now - lease.heartbeatAt < LEASE_STALE_MS
    ) {
      throw new Error(
        `Run ${run.id} is controlled by another active Pi session.`,
      );
    }
    return this.update({
      ...run,
      lease: { sessionId, pid: process.pid, heartbeatAt: now },
    });
  }

  async heartbeat(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.lease) return run;
    return this.update({
      ...run,
      lease: { ...run.lease, heartbeatAt: Date.now() },
    });
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
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function acquireLock(path: string) {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
      await removeStaleLock(path);
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out acquiring plan-exec registry lock: ${path}`);
}

async function removeStaleLock(path: string): Promise<void> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && !isProcessRunning(pid)) {
      await rm(path, { force: true });
    }
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
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
