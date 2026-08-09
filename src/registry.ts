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
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { isSkippableStage, isTerminalStatus } from "./lifecycle.js";
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
const INVALID_RUN_ENTRY = "Invalid plan-exec run registry entry";
export const LEASE_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const LOCK_STALE_MS = 10_000;
const CONTROLLER_LOCK_MAX_RETRIES = 20;
const CONTROLLER_LOCK_STALE_MS = 120_000;
const CLAIM_CAS_RETRIES = 5;
const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RunLease = NonNullable<PlanExecRun["lease"]>;

/**
 * Whether the name frozen on a lease is this machine. The whole name decides,
 * never its first label: a shared or NFS home shows `build.a.corp.example` and
 * `build.b.corp.example`, which are different hosts.
 *
 * A name that is not exactly ours is foreign, so nothing measured here speaks
 * for it: such a run can reach AMBIGUOUS but never ABANDONED, and no second
 * worker is launched. A renamed machine is foreign too, and not stuck —
 * guidance names `/exec resume <id> --same-machine`.
 */
function isThisHost(name: string): boolean {
  return name.toLowerCase() === hostname().toLowerCase();
}

/**
 * A stored lease is a claim, not evidence. It is live only when the caller owns
 * it, or its heartbeat is fresh and — on this host, where the pid means
 * something — the process still exists. A lease with no hostname predates the
 * field, so its pid is not ours to check: the heartbeat is the only evidence.
 */
export function isLeaseLive(lease: RunLease, sessionId?: string): boolean {
  if (sessionId !== undefined && lease.sessionId === sessionId) return true;
  if (Date.now() - lease.heartbeatAt >= LEASE_STALE_MS) return false;
  if (lease.hostname === undefined || !isThisHost(lease.hostname)) return true;
  return isProcessRunning(lease.pid);
}

/**
 * Whether anything observed on this machine can speak for this run. A lease
 * naming another host makes every local check meaningless: that directory and
 * that bridge belong to a different machine. A lease with no hostname predates
 * the field and stays local, as it always was.
 */
export function isLocalRun(run: PlanExecRun): boolean {
  const host = run.lease?.hostname;
  return host === undefined || isThisHost(host);
}

/**
 * The run with the host on its lease read as this machine. Backs
 * `/exec resume --same-machine`: no probe can tell a renamed machine from a
 * foreign one, so the operator supplies that fact. It asserts a machine, never
 * a verdict — a worker still writing here keeps the run ambiguous.
 */
export function asLocalRun(run: PlanExecRun): PlanExecRun {
  return run.lease
    ? { ...run, lease: { ...run.lease, hostname: hostname() } }
    : run;
}

/**
 * Why this session cannot take this run's lease, or undefined when it can.
 * `claim` raises it, and the worktree handoff must ask it first: that handoff
 * releases before re-claiming, and `release` deletes whatever is there, so the
 * refusal `claim` would have raised comes too late.
 */
export function takeoverRefusal(
  run: PlanExecRun,
  sessionId: string,
): string | undefined {
  const lease = run.lease;
  return lease && lease.sessionId !== sessionId && isLeaseLive(lease, sessionId)
    ? `Run ${run.id} is controlled by another active Pi session.`
    : undefined;
}

/**
 * Why this run cannot be removed, or undefined when it can. `remove` and
 * `/exec cleanup` share it so a preview never promises a removal the registry
 * would refuse.
 */
export function removalRefusal(run: PlanExecRun): string | undefined {
  if (!isTerminalStatus(run.status))
    return `Run ${run.id} is ${run.status}; only a terminal run can be removed.`;
  if (run.lease && isLeaseLive(run.lease))
    return `Run ${run.id} is held by a live lease from session ${run.lease.sessionId}.`;
  return undefined;
}

/**
 * The global orchestration store. It is deliberately separate from pi-tasks:
 * pi-tasks is session-scoped UI projection, while this record survives adoption.
 */
export class RunRegistry {
  constructor(private readonly directory = RUNS_DIRECTORY) {}

  async create(
    run: Omit<
      PlanExecRun,
      "id" | "createdAt" | "updatedAt" | "skippedStages" | "branchRebindings"
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

  /**
   * Optimistic write: it lands only if nothing else wrote first, and otherwise
   * returns the record that did. A write that must not be lost — a terminal
   * status, a retirement stamp — belongs in `updateLatest`: this one drops it
   * silently.
   */
  async update(run: PlanExecRun): Promise<PlanExecRun> {
    return (await this.updateIfCurrent(run, run.updatedAt)).run;
  }

  /**
   * Apply a change that must not be lost, re-reading and re-applying on top of
   * whoever landed first. Use it when the work the write records has already
   * happened on disk, so dropping the write would falsify the record.
   */
  async updateLatest(
    runId: string,
    apply: (current: PlanExecRun) => PlanExecRun,
  ): Promise<PlanExecRun> {
    for (let attempt = 0; attempt < CLAIM_CAS_RETRIES; attempt += 1) {
      const current = await this.get(runId);
      if (!current) throw new Error(`Plan execution run not found: ${runId}`);
      const written = await this.updateIfCurrent(
        apply(current),
        current.updatedAt,
      );
      if (written.applied) return written.run;
    }
    throw new Error(`Run ${runId} changed repeatedly while being updated.`);
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
      const refusal = takeoverRefusal(current, sessionId);
      if (refusal) throw new Error(refusal);
      const claimed = await this.updateIfCurrent(
        {
          ...current,
          lease: {
            sessionId,
            pid: process.pid,
            hostname: hostname(),
            heartbeatAt: now,
          },
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
    const path = this.controllerLockPath(runId);
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
        // Timestamp only. claim is the sole writer of lease identity: stamping
        // this host over another session's pid would make an unrelated local
        // process read as the live owner.
        lease: { ...run.lease, heartbeatAt: Date.now() },
      },
      run.updatedAt,
    );
    return heartbeat.run;
  }

  /**
   * Delete the registry entry only; the worktree, branch, and progress file
   * stay. An unparsable record is removable as-is, because `list` already drops
   * it and nothing else could clean it up. Returns false for a record already
   * gone, so it is not counted as a removal.
   *
   * The refusal is decided under the same lock as the deletion: reading first
   * would let a concurrent `claim` revive the run in the window between, and
   * this is the one irreversible path in the store.
   *
   * The controller lock comes first, in the order every controller takes it. A
   * resume holds it across the whole recovery, and the record it is about to
   * write must not be deleted underneath it.
   */
  async remove(runId: string): Promise<boolean> {
    assertRunId(runId);
    const controllerPath = this.controllerLockPath(runId);
    let controllerLock;
    try {
      controllerLock = await acquireLock(
        controllerPath,
        CONTROLLER_LOCK_MAX_RETRIES,
        CONTROLLER_LOCK_STALE_MS,
      );
    } catch (error: unknown) {
      // No directory to lock is no directory to delete.
      if (isNodeError(error, "ENOENT")) return false;
      if (error instanceof LockTimeoutError)
        throw new Error(
          `Run ${runId} is being recovered by another controller; nothing was deleted.`,
          { cause: error },
        );
      throw error;
    }
    try {
      return await this.removeLocked(runId);
    } finally {
      await releaseLock(controllerPath, controllerLock);
    }
  }

  private async removeLocked(runId: string): Promise<boolean> {
    const path = this.pathFor(runId);
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await acquireLock(lockPath);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    try {
      const run = await this.readForRemoval(runId);
      if (run === undefined) return false;
      const refusal = run === null ? undefined : removalRefusal(run);
      if (refusal) throw new Error(refusal);
      await rm(dirname(path), { recursive: true, force: true });
      return true;
    } finally {
      await releaseLock(lockPath, lock);
    }
  }

  async release(run: PlanExecRun): Promise<PlanExecRun> {
    const released = { ...run };
    delete released.lease;
    return this.update(released);
  }

  /** `undefined` when nothing is on disk, `null` when it is there but unreadable. */
  private async readForRemoval(
    runId: string,
  ): Promise<PlanExecRun | null | undefined> {
    try {
      return await this.get(runId);
    } catch (error: unknown) {
      // Narrow on purpose: an unreadable file is removable, but an I/O or
      // permission error is not evidence of anything and must not delete data.
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message.startsWith(INVALID_RUN_ENTRY))
      )
        return null;
      throw error;
    }
  }

  private pathFor(runId: string): string {
    assertRunId(runId);
    return join(this.directory, runId, "run.json");
  }

  private controllerLockPath(runId: string): string {
    return `${this.pathFor(runId)}.controller.lock`;
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
    throw new Error(`${INVALID_RUN_ENTRY}: ${runId}`);
  }
  const migrated = migrateLegacyRun(value);
  assertRun(migrated);
  return migrated;
}

function migrateLegacyRun(value: Record<string, unknown>): PlanExecRun {
  const stage = value.stage === "tasks" ? RUN_STAGE.PROJECT_TASKS : value.stage;
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
    throw new Error(`${INVALID_RUN_ENTRY}: ${run.id}`);
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
