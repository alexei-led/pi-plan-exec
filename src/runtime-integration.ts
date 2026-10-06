import { basename } from 'node:path';
import { isInFlightStatus, isTerminalStatus } from './lifecycle.js';
import { type PlanExecRun, RUN_STATUS } from './types.js';

const EXTERNAL_SOURCE = 'pi-plan-exec';
const PROVIDER_NAME = 'pi-plan-exec';
const TERMINAL_ROW_LIMIT = 20;
const OWNERSHIP_KEY = Symbol.for('pi-plan-exec.runtime-integration.owners.v1');

export type ExternalRunState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type ExternalRunUpdate = Partial<
  Omit<ExternalRunRecord, 'id' | 'sessionId' | 'source'>
>;

export interface ExternalRunRecord {
  id: string;
  sessionId: string;
  source: string;
  label: string;
  state: ExternalRunState;
  currentAction?: string;
  preview?: string;
  startedAt: number;
  updatedAt?: number;
  endedAt?: number;
  reportPath?: string;
}

export interface BackgroundWorkItem {
  id: string;
  sessionId: string;
}

export interface BackgroundWorkProvider {
  name: string;
  listActiveWork(): BackgroundWorkItem[];
  reconcile?(): void;
}

export interface PlanExecRuntimeApi {
  /** Stable module identity keeps reload ownership generation-safe. */
  ownershipKey?: object;
  registerExternalRun(record: ExternalRunRecord): void;
  updateExternalRun(
    sessionId: string,
    runId: string,
    update: ExternalRunUpdate,
  ): void;
  unregisterExternalRun(sessionId: string, runId: string): void;
  registerBackgroundWorkProvider(provider: BackgroundWorkProvider): () => void;
}

interface RegisteredRow {
  sessionId: string;
  externalId: string;
  terminal: boolean;
  updatedAt: number;
}

interface RuntimeOwner {
  token: symbol;
  generation: number;
}

interface RuntimeOwnership {
  nextGeneration: number;
  rowsByApi: WeakMap<object, Map<string, RuntimeOwner>>;
}

export class PlanExecRuntimeIntegration {
  private readonly token = Symbol('pi-plan-exec-runtime');
  private readonly generation: number;
  private readonly rows = new Map<string, RegisteredRow>();
  private readonly activeWork = new Map<string, BackgroundWorkItem>();
  private readonly observedAt = new Map<string, number>();
  private disposeProvider: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly api: PlanExecRuntimeApi) {
    this.generation = nextRuntimeGeneration();
  }

  reconcile(
    runs: PlanExecRun[],
    ownerSessionId: string,
    runtimeSessionId = ownerSessionId,
  ): void {
    if (this.disposed) return;
    this.ensureProvider();
    const desired = new Set(
      runs
        .filter((run) => matchesContextRun(run, ownerSessionId))
        .map((run) => run.id),
    );
    const desiredExternal = new Set([...desired].map(externalRunId));
    const ownership = runtimeOwnership(this.api);
    const prefix = `${runtimeSessionId}\u0000plan-exec:`;
    for (const rowKey of [...ownership.keys()]) {
      if (!rowKey.startsWith(prefix)) continue;
      const externalId = rowKey.slice(`${runtimeSessionId}\u0000`.length);
      const owned = ownership.get(rowKey);
      if (
        !desiredExternal.has(externalId) &&
        owned !== undefined &&
        (owned.token === this.token || owned.generation < this.generation)
      ) {
        try {
          this.api.unregisterExternalRun(runtimeSessionId, externalId);
        } catch {
          /* Display cache only. */
        }
        ownership.delete(rowKey);
      }
    }
    for (const runId of this.rows.keys()) {
      if (!desired.has(runId)) this.unregister(runId);
    }
    for (const run of runs) {
      if (matchesContextRun(run, ownerSessionId))
        this.sync(run, runtimeSessionId);
    }
  }

  sync(run: PlanExecRun, sessionId: string): void {
    if (this.disposed) return;
    this.ensureProvider();
    const externalId = externalRunId(run.id);
    const rowKey = registrationKey(sessionId, externalId);
    const ownership = runtimeOwnership(this.api);
    const previous = this.rows.get(run.id);
    if ((this.observedAt.get(rowKey) ?? -1) > run.updatedAt) return;
    if (
      previous &&
      (previous.sessionId !== sessionId || previous.externalId !== externalId)
    )
      this.unregister(run.id);

    const record = externalRecord(run, sessionId, externalId);
    const currentOwner = ownership.get(rowKey);
    if (currentOwner && currentOwner.generation > this.generation) return;
    // Keep freshness independent of the bounded Fleet display cache.
    this.observedAt.set(rowKey, run.updatedAt);
    this.rows.set(run.id, {
      sessionId,
      externalId,
      terminal: isTerminalStatus(run.status),
      updatedAt: run.updatedAt,
    });
    if (isInFlightStatus(run.status))
      this.activeWork.set(externalId, { id: externalId, sessionId });
    else this.activeWork.delete(externalId);
    const terminalRows = [...this.rows.entries()]
      .filter(([, row]) => row.terminal)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    for (const [id] of terminalRows.slice(TERMINAL_ROW_LIMIT))
      this.unregister(id);
    if (!this.rows.has(run.id)) return;
    try {
      if (currentOwner?.token === this.token) {
        this.api.updateExternalRun(
          sessionId,
          externalId,
          externalRunUpdate(record),
        );
      } else {
        this.api.unregisterExternalRun(sessionId, externalId);
        this.api.registerExternalRun(record);
        ownership.set(rowKey, {
          token: this.token,
          generation: this.generation,
        });
      }
    } catch {
      // Fleet admission is advisory, even when another extension filled its cache.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeProvider?.();
    this.disposeProvider = undefined;
    for (const runId of [...this.rows.keys()]) this.unregister(runId);
    this.activeWork.clear();
    this.observedAt.clear();
  }

  private ensureProvider(): void {
    if (this.disposed || this.disposeProvider) return;
    const provider: BackgroundWorkProvider = {
      name: PROVIDER_NAME,
      listActiveWork: () => [...this.activeWork.values()],
      reconcile: () => undefined,
    };
    this.disposeProvider = this.api.registerBackgroundWorkProvider(provider);
  }

  private unregister(runId: string): void {
    const row = this.rows.get(runId);
    if (!row) return;
    const ownership = runtimeOwnership(this.api);
    const rowKey = registrationKey(row.sessionId, row.externalId);
    if (ownership.get(rowKey)?.token === this.token) {
      try {
        this.api.unregisterExternalRun(row.sessionId, row.externalId);
      } catch {
        /* Display cache only. */
      }
      ownership.delete(rowKey);
    }
    this.activeWork.delete(row.externalId);
    this.rows.delete(runId);
  }
}

export async function loadPlanExecRuntimeIntegration(): Promise<PlanExecRuntimeIntegration> {
  const externalRunsId = 'pi-subagents/external-runs';
  const backgroundWorkId = 'pi-subagents/background-work';
  const [externalRuns, backgroundWork]: unknown[] = await Promise.all([
    import(externalRunsId),
    import(backgroundWorkId),
  ]);
  if (
    !isRecord(externalRuns) ||
    typeof externalRuns.registerExternalRun !== 'function' ||
    typeof externalRuns.updateExternalRun !== 'function' ||
    typeof externalRuns.unregisterExternalRun !== 'function' ||
    !isRecord(backgroundWork) ||
    typeof backgroundWork.registerBackgroundWorkProvider !== 'function'
  )
    throw new Error('Installed pi-subagents extension APIs are incompatible.');
  return new PlanExecRuntimeIntegration({
    ownershipKey: externalRuns,
    registerExternalRun:
      externalRuns.registerExternalRun as PlanExecRuntimeApi['registerExternalRun'],
    updateExternalRun:
      externalRuns.updateExternalRun as PlanExecRuntimeApi['updateExternalRun'],
    unregisterExternalRun:
      externalRuns.unregisterExternalRun as PlanExecRuntimeApi['unregisterExternalRun'],
    registerBackgroundWorkProvider:
      backgroundWork.registerBackgroundWorkProvider as PlanExecRuntimeApi['registerBackgroundWorkProvider'],
  });
}

function externalRecord(
  run: PlanExecRun,
  sessionId: string,
  id: string,
): ExternalRunRecord {
  const projectionError =
    run.taskProjection?.state === 'degraded'
      ? (run.taskProjection.error ?? 'unknown projection error')
      : undefined;
  return {
    id,
    sessionId,
    source: EXTERNAL_SOURCE,
    label: `PlanExec ${run.planPath !== undefined ? basename(run.planPath) : `goal ${run.goal?.hash ?? run.id}`}`,
    state: externalState(run),
    currentAction: run.stage,
    preview: projectionError
      ? `Task projection degraded: ${projectionError}`
      : `${run.status} · ${run.stage}`,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(isTerminalStatus(run.status) ? { endedAt: run.updatedAt } : {}),
    ...(run.progressPath ? { reportPath: run.progressPath } : {}),
  };
}

function externalRunUpdate(record: ExternalRunRecord): ExternalRunUpdate {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== 'id' && key !== 'sessionId' && key !== 'source',
    ),
  ) as ExternalRunUpdate;
}

function matchesContextRun(run: PlanExecRun, sessionId: string): boolean {
  return (
    run.lease?.sessionId === sessionId ||
    run.taskProjection?.sessionId === sessionId
  );
}

function externalState(run: PlanExecRun): ExternalRunState {
  switch (run.status) {
    case RUN_STATUS.STARTING:
      return 'queued';
    case RUN_STATUS.COMPLETED:
    case RUN_STATUS.COMPLETED_WITH_FINDINGS:
      return 'completed';
    case RUN_STATUS.FAILED:
      return 'failed';
    case RUN_STATUS.CANCELLED:
      return 'stopped';
    case RUN_STATUS.PAUSED:
      return 'stopped';
    default:
      return 'running';
  }
}

function externalRunId(runId: string): string {
  return `plan-exec:${runId}`;
}

function registrationKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nextRuntimeGeneration(): number {
  return ++runtimeState().nextGeneration;
}

function runtimeState(): RuntimeOwnership {
  const root = globalThis as typeof globalThis & {
    [OWNERSHIP_KEY]?: RuntimeOwnership;
  };
  let state = root[OWNERSHIP_KEY];
  if (!state) {
    state = { nextGeneration: 0, rowsByApi: new WeakMap() };
    root[OWNERSHIP_KEY] = state;
  }
  if (!Number.isSafeInteger(state.nextGeneration)) state.nextGeneration = 0;
  return state;
}

function runtimeOwnership(api: PlanExecRuntimeApi): Map<string, RuntimeOwner> {
  const state = runtimeState();
  const key = api.ownershipKey ?? (api as object);
  let ownership = state.rowsByApi.get(key);
  if (!ownership) {
    ownership = new Map();
    state.rowsByApi.set(key, ownership);
  }
  const legacy = ownership as unknown as Map<string, RuntimeOwner | symbol>;
  for (const [rowKey, owner] of legacy) {
    if (typeof owner === 'symbol')
      legacy.set(rowKey, { token: owner, generation: 0 });
  }
  return ownership;
}
