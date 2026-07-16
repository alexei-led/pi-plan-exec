import type { PlanExecRun, RunStage, RunStatus } from "./types.js";

export const PIPELINE_STAGES = [
  "comprehensive_review",
  "smells_review",
  "fusion_review",
  "critical_review",
  "finalize",
  "stats",
  "archive",
] as const satisfies readonly RunStage[];

export const STAGE_ORDER = [
  "resolve",
  "isolation",
  "project_tasks",
  "branch",
  "progress",
  "implementation",
  ...PIPELINE_STAGES,
  "complete",
] as const satisfies readonly RunStage[];

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "completed_with_findings",
  "cancelled",
  "failed",
]);

const REVIEW_STAGES = new Set<RunStage>([
  "comprehensive_review",
  "smells_review",
  "fusion_review",
  "critical_review",
]);

const NEXT_STAGES: Partial<Record<RunStage, RunStage>> = {
  comprehensive_review: "smells_review",
  smells_review: "fusion_review",
  fusion_review: "critical_review",
  critical_review: "finalize",
  finalize: "stats",
  stats: "archive",
  archive: "complete",
};

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isReviewStage(stage: RunStage): boolean {
  return REVIEW_STAGES.has(stage);
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
  return run.status === "failed" || run.status === "cancel_pending";
}
