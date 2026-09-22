import {
  EXTERNAL_OPERATION_STATE,
  type ExecutionLifetime,
  type GoalState,
  MAX_EXECUTION_TIMEOUT_MS,
  type PlanExecRun,
  RUN_STAGE,
  RUN_STATUS,
  type RunStage,
  type RunStatus,
} from './types.js';

export function isGoalRun(
  run: PlanExecRun,
): run is PlanExecRun & { goal: GoalState } {
  return run.goal !== undefined;
}

/** Plan-only code paths call this at their entry so a goal run fails loudly. */
export function assertPlanRun(
  run: PlanExecRun,
): asserts run is PlanExecRun & { planPath: string; planHash: string } {
  if (run.planPath === undefined || run.planHash === undefined)
    throw new Error('This execution path requires a plan run.');
}

export function requirePlanPath(run: PlanExecRun): string {
  assertPlanRun(run);
  return run.planPath;
}

export const PIPELINE_STAGES = [
  RUN_STAGE.COMPREHENSIVE_REVIEW,
  RUN_STAGE.SMELLS_REVIEW,
  RUN_STAGE.FUSION_REVIEW,
  RUN_STAGE.CRITICAL_REVIEW,
  RUN_STAGE.FINALIZE,
  RUN_STAGE.STATS,
  RUN_STAGE.ARCHIVE,
] as const satisfies readonly RunStage[];

export const STAGE_ORDER = [
  RUN_STAGE.RESOLVE,
  RUN_STAGE.ISOLATION,
  RUN_STAGE.PROJECT_TASKS,
  RUN_STAGE.BRANCH,
  RUN_STAGE.PROGRESS,
  RUN_STAGE.IMPLEMENTATION,
  ...PIPELINE_STAGES,
  RUN_STAGE.COMPLETE,
] as const satisfies readonly RunStage[];

const TERMINAL_STATUSES = new Set<RunStatus>([
  RUN_STATUS.COMPLETED,
  RUN_STATUS.COMPLETED_WITH_FINDINGS,
  RUN_STATUS.CANCELLED,
  RUN_STATUS.FAILED,
]);

/** Statuses that assert work is in flight right now, and are therefore falsifiable. */
const IN_FLIGHT_STATUSES = new Set<RunStatus>([
  RUN_STATUS.STARTING,
  RUN_STATUS.RUNNING,
  RUN_STATUS.SKIP_PENDING,
  RUN_STATUS.CANCEL_PENDING,
]);

const REVIEW_STAGES = new Set<RunStage>([
  RUN_STAGE.COMPREHENSIVE_REVIEW,
  RUN_STAGE.SMELLS_REVIEW,
  RUN_STAGE.FUSION_REVIEW,
  RUN_STAGE.CRITICAL_REVIEW,
]);

const SKIPPABLE_STAGES = new Set<RunStage>([
  ...REVIEW_STAGES,
  RUN_STAGE.FINALIZE,
  RUN_STAGE.STATS,
]);

const NEXT_STAGES: Partial<Record<RunStage, RunStage>> = {
  [RUN_STAGE.COMPREHENSIVE_REVIEW]: RUN_STAGE.SMELLS_REVIEW,
  [RUN_STAGE.SMELLS_REVIEW]: RUN_STAGE.FUSION_REVIEW,
  [RUN_STAGE.FUSION_REVIEW]: RUN_STAGE.CRITICAL_REVIEW,
  [RUN_STAGE.CRITICAL_REVIEW]: RUN_STAGE.FINALIZE,
  [RUN_STAGE.FINALIZE]: RUN_STAGE.STATS,
  [RUN_STAGE.STATS]: RUN_STAGE.ARCHIVE,
  [RUN_STAGE.ARCHIVE]: RUN_STAGE.COMPLETE,
};

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isInFlightStatus(status: RunStatus): boolean {
  return IN_FLIGHT_STATUSES.has(status);
}

export function isReviewStage(stage: RunStage): boolean {
  return REVIEW_STAGES.has(stage);
}

export function isSkippableStage(stage: RunStage): boolean {
  return SKIPPABLE_STAGES.has(stage);
}

export function nextStage(stage: RunStage): RunStage {
  const next = NEXT_STAGES[stage];
  if (!next) throw new Error(`No next stage after ${stage}.`);
  return next;
}

export function stageIndex(stage: RunStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function isRecoverableRun(run: PlanExecRun): boolean {
  return (
    run.status === RUN_STATUS.FAILED || run.status === RUN_STATUS.CANCEL_PENDING
  );
}

/**
 * Report an operation past an explicitly selected bounded compatibility
 * lifetime. Unbounded workers have no synthetic wall-clock verdict; activity,
 * phase, and process evidence remain diagnostic only.
 */
export function longRunningOperation(
  run: PlanExecRun,
  now = Date.now(),
): { elapsedMs: number; boundMs: number; maxTurns?: never } | undefined {
  const operation = run.activeOperation;
  const lifetime = activeExecutionLifetime(run);
  if (!operation?.launchStartedAt || lifetime?.mode !== 'bounded')
    return undefined;
  const boundMs = lifetime.timeoutMs;
  const elapsedMs = now - operation.launchStartedAt;
  return elapsedMs > boundMs ? { elapsedMs, boundMs } : undefined;
}

/** Existing operations use their persisted request or attestation, never a new base policy. */
export function activeExecutionLifetime(
  run: PlanExecRun,
): ExecutionLifetime | undefined {
  const operation = run.activeOperation;
  if (!operation) return run.config.executionLifetime;
  if (operation.effectiveLifetime) return operation.effectiveLifetime;
  if (operation.expectedLifetime) return operation.expectedLifetime;
  const params = operation.params?.executionLifetime;
  if (!params || typeof params !== 'object' || !('mode' in params))
    return undefined;
  if (params.mode === 'unbounded') return { mode: 'unbounded' };
  if (
    params.mode === 'bounded' &&
    'timeoutMs' in params &&
    typeof params.timeoutMs === 'number' &&
    Number.isSafeInteger(params.timeoutMs) &&
    params.timeoutMs > 0 &&
    params.timeoutMs <= MAX_EXECUTION_TIMEOUT_MS
  )
    return { mode: 'bounded', timeoutMs: params.timeoutMs };
  return undefined;
}

export const ABANDONMENT = {
  LIVE: 'live',
  ABANDONED: 'abandoned',
  RECONCILABLE: 'reconcilable',
  AMBIGUOUS: 'ambiguous',
} as const;

export type Abandonment = (typeof ABANDONMENT)[keyof typeof ABANDONMENT];

export const PROCESS_TERMINAL_STATE = {
  PENDING: 'pending',
  NOT_STARTED: 'not-started',
  OBSERVED: 'observed',
  UNKNOWN: 'unknown',
} as const;

export interface ProcessTerminalProof {
  version: 1;
  state: (typeof PROCESS_TERMINAL_STATE)[keyof typeof PROCESS_TERMINAL_STATE];
  runId: string;
  runnerProcessInstanceId: string;
  observedAt?: number;
  instances?: unknown[];
  reason?: string;
}

/** What a sweep managed to observe about a run's claim. */
export interface AbandonmentEvidence {
  leaseLive: boolean;
  /** Diagnostic only. Directory absence is not native process proof. */
  asyncDirPresent?: boolean;
  /** The bridge's own answer for the operation ID, when it was asked. */
  bridgeState?: string;
  durableOperationLookup?: boolean;
  replaySafe?: boolean;
  neverStarted?: boolean;
  processTerminalProof?: ProcessTerminalProof;
}

/** Exit proof permits result recovery; replay-safe absence permits only the same launch identity. */
export function classifyAbandonment(
  run: PlanExecRun,
  evidence: AbandonmentEvidence,
): Abandonment {
  if (evidence.leaseLive) return ABANDONMENT.LIVE;
  if (!isInFlightStatus(run.status) || !run.activeOperation)
    return ABANDONMENT.AMBIGUOUS;
  const terminalObserved =
    evidence.processTerminalProof?.version === 1 &&
    evidence.processTerminalProof.state === 'observed' &&
    evidence.processTerminalProof.runId === run.activeOperation?.externalRunId;
  const replaySafeAbsence =
    !run.activeOperation.externalRunId &&
    evidence.durableOperationLookup === true &&
    evidence.replaySafe === true &&
    evidence.bridgeState === EXTERNAL_OPERATION_STATE.ABSENT;
  return terminalObserved ||
    (evidence.durableOperationLookup === true && evidence.neverStarted === true)
    ? ABANDONMENT.ABANDONED
    : replaySafeAbsence
      ? ABANDONMENT.RECONCILABLE
      : ABANDONMENT.AMBIGUOUS;
}
