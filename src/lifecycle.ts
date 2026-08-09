import {
  EXTERNAL_OPERATION_STATE,
  OPERATION_KIND,
  RUN_STAGE,
  RUN_STATUS,
  type FrozenRunConfig,
  type OperationKind,
  type PlanExecRun,
  type RunStage,
  type RunStatus,
} from "./types.js";

/**
 * Wall-clock allowance per turn, so each stage is bounded by its own turn
 * budget. PLACEHOLDER, deliberately generous: a false "long-running" banner on
 * a healthy worker is worse than a late one. Tighten it once a real per-turn
 * activity signal exists (nicobailon/pi-subagents#920).
 */
const OPERATION_TURN_ALLOWANCE_MS = 120_000;

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

/** Turn budget each launch path passes; fusion carries none of its own. */
function operationMaxTurns(
  config: FrozenRunConfig,
  kind: OperationKind,
): number {
  if (kind === OPERATION_KIND.STATS) return config.statsMaxTurns;
  if (kind === OPERATION_KIND.REVIEW) return config.reviewerMaxTurns;
  return config.workerMaxTurns;
}

/**
 * Report an operation past its stage's turn budget. Classification only:
 * nothing here fails or kills a run. An operation with no `launchStartedAt`
 * predates the field, cannot be bounded, and is never reported.
 */
export function longRunningOperation(
  run: PlanExecRun,
  now = Date.now(),
): { elapsedMs: number; boundMs: number; maxTurns: number } | undefined {
  const operation = run.activeOperation;
  if (!operation?.launchStartedAt) return undefined;
  const maxTurns = operationMaxTurns(run.config, operation.kind);
  const boundMs = maxTurns * OPERATION_TURN_ALLOWANCE_MS;
  const elapsedMs = now - operation.launchStartedAt;
  return elapsedMs > boundMs ? { elapsedMs, boundMs, maxTurns } : undefined;
}

export const ABANDONMENT = {
  LIVE: "live",
  ABANDONED: "abandoned",
  AMBIGUOUS: "ambiguous",
} as const;

export type Abandonment = (typeof ABANDONMENT)[keyof typeof ABANDONMENT];

/** What a sweep managed to observe about a run's claim. */
export interface AbandonmentEvidence {
  leaseLive: boolean;
  /** Only `false` is evidence; undefined means no directory was recorded. */
  asyncDirPresent?: boolean;
  /** The bridge's own answer for the operation ID, when it was asked. */
  bridgeState?: string;
}

/**
 * `abandoned` is the full conjunction: an in-flight claim, a dead lease, and a
 * tracked operation provably gone. Anything short of that is `ambiguous`,
 * reported and never reset — resetting a run whose worker is alive can
 * double-write a worktree, which is worse than the stall. The sweep, the resume
 * gate, and the detail view all read this one answer.
 */
export function classifyAbandonment(
  run: PlanExecRun,
  evidence: AbandonmentEvidence,
): Abandonment {
  if (evidence.leaseLive) return ABANDONMENT.LIVE;
  if (!isInFlightStatus(run.status) || !run.activeOperation)
    return ABANDONMENT.AMBIGUOUS;
  const gone =
    evidence.asyncDirPresent === false ||
    evidence.bridgeState === EXTERNAL_OPERATION_STATE.ABSENT;
  return gone ? ABANDONMENT.ABANDONED : ABANDONMENT.AMBIGUOUS;
}
