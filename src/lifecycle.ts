import {
  RUN_STAGE,
  RUN_STATUS,
  type PlanExecRun,
  type RunStage,
  type RunStatus,
} from "./types.js";

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
    run.status === RUN_STATUS.FAILED ||
    run.status === RUN_STATUS.CANCEL_PENDING
  );
}
