export const COMPLETED_PLANS_DIRECTORY = "completed";

export const EXEC_ACTION = {
  HELP: "help",
  START: "start",
  SETUP: "setup",
  RUNS: "runs",
  STATUS: "status",
  PAUSE: "pause",
  RESUME: "resume",
  ADOPT: "adopt",
  SKIP: "skip",
  CANCEL: "cancel",
} as const;

export type RunAction =
  (typeof EXEC_ACTION)[Exclude<
    keyof typeof EXEC_ACTION,
    "HELP" | "START" | "SETUP" | "RUNS"
  >];

export const RUN_STAGE = {
  RESOLVE: "resolve",
  ISOLATION: "isolation",
  PROJECT_TASKS: "project_tasks",
  BRANCH: "branch",
  PROGRESS: "progress",
  IMPLEMENTATION: "implementation",
  COMPREHENSIVE_REVIEW: "comprehensive_review",
  SMELLS_REVIEW: "smells_review",
  FUSION_REVIEW: "fusion_review",
  CRITICAL_REVIEW: "critical_review",
  FINALIZE: "finalize",
  STATS: "stats",
  ARCHIVE: "archive",
  COMPLETE: "complete",
} as const;

export type RunStage = (typeof RUN_STAGE)[keyof typeof RUN_STAGE];
export const RUN_STAGES: readonly RunStage[] = Object.freeze(
  Object.values(RUN_STAGE),
);

export const RUN_STATUS = {
  STARTING: "starting",
  RUNNING: "running",
  PAUSED: "paused",
  SKIP_PENDING: "skip_pending",
  CANCEL_PENDING: "cancel_pending",
  CANCELLED: "cancelled",
  FAILED: "failed",
  COMPLETED: "completed",
  COMPLETED_WITH_FINDINGS: "completed_with_findings",
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export const RUN_STATUSES: readonly RunStatus[] = Object.freeze(
  Object.values(RUN_STATUS),
);

export interface FrozenRunConfig {
  taskRetries: number;
  maxTaskIterations: number;
  reviewIterations: number;
  fusionIterations: number;
  fusionProfile?: string;
  finalizeEnabled: boolean;
  workerAgent: string;
  workerModel?: string;
  workerMaxTurns: number;
  reviewerAgent: string;
  reviewerModel?: string;
  reviewerMaxTurns: number;
  statsAgent: string;
  statsModel?: string;
  statsMaxTurns: number;
}

export const DEFAULT_FROZEN_RUN_CONFIG = {
  taskRetries: 1,
  maxTaskIterations: 50,
  reviewIterations: 5,
  fusionIterations: 10,
  finalizeEnabled: true,
  workerAgent: "worker",
  workerMaxTurns: 75,
  reviewerAgent: "reviewer",
  reviewerMaxTurns: 30,
  statsAgent: "reviewer",
  statsMaxTurns: 30,
} as const satisfies FrozenRunConfig;

export const OPERATION_SERVICE = {
  BRIDGE: "bridge",
  FUSION: "fusion",
} as const;

export type OperationService =
  (typeof OPERATION_SERVICE)[keyof typeof OPERATION_SERVICE];

export const OPERATION_KIND = {
  IMPLEMENTATION: "implementation",
  REVIEW: "review",
  FIX: "fix",
  FUSION: "fusion",
  FINALIZE: "finalize",
  STATS: "stats",
} as const;

export type OperationKind =
  (typeof OPERATION_KIND)[keyof typeof OPERATION_KIND];

export const OPERATION_RECOVERY = {
  OBSERVE: "observe",
  REPLAY: "replay",
  CANCEL: "cancel",
} as const;

export type OperationRecovery =
  (typeof OPERATION_RECOVERY)[keyof typeof OPERATION_RECOVERY];

export const EXTERNAL_OPERATION_STATE = {
  RUNNING: "running",
  STOPPING: "stopping",
  COMPLETE: "complete",
  DONE: "done",
  FAILED: "failed",
  STOPPED: "stopped",
  PAUSED: "paused",
  ABORTED: "aborted",
  PENDING: "pending",
  FOUND: "found",
  UNKNOWN: "unknown",
  ABSENT: "absent",
  CHAIN: "chain",
  PANEL: "panel",
  JUDGE: "judge",
} as const;

export interface PlanTask {
  id: number;
  title: string;
  startLine: number;
  endLine: number;
  items: string[];
  unchecked: string[];
}

export interface ParsedPlan {
  path: string;
  hash: string;
  tasks: PlanTask[];
}

export interface ReviewFinding {
  id: string;
  severity: "CRITICAL" | "MAJOR" | "MINOR";
  summary: string;
  evidence?: string;
  suggestion?: string;
}

export interface PendingStageSkip {
  stage: RunStage;
  reason: string;
  requestedAt: number;
  requestedBy: string;
}

export interface SkippedStage extends PendingStageSkip {
  completedAt: number;
  operationId?: string;
  externalRunId?: string;
  terminalOperationState?: string;
}

export interface BranchRebinding {
  from: string;
  to: string;
  requestedAt: number;
  requestedBy: string;
}

export interface ActiveOperation {
  operationId: string;
  service: OperationService;
  kind: OperationKind;
  externalRunId?: string;
  asyncDir?: string;
  launchStartedAt?: number;
  params?: Record<string, unknown>;
  taskId?: number;
  reviewIteration?: number;
  stopRequested?: boolean;
  recovery?: OperationRecovery;
  launchFailures?: number;
  lastLaunchError?: string;
  statusFailures?: number;
  lastObservedAt?: number;
  lastStatusError?: string;
  skipFailures?: number;
  lastSkipError?: string;
}

export interface PlanExecRun {
  schemaVersion: 1;
  id: string;
  repositoryRoot: string;
  planPath: string;
  planHash: string;
  worktreeCwd: string;
  branch: string;
  defaultBranch: string;
  status: RunStatus;
  stage: RunStage;
  taskAttempts: Record<string, number>;
  stageAttempts: Partial<Record<RunStage, number>>;
  reviewFindings: ReviewFinding[];
  skippedStages: SkippedStage[];
  pendingStageSkip?: PendingStageSkip;
  branchRebindings: BranchRebinding[];
  progressPath?: string;
  taskProjection?: {
    sessionId: string;
    listPath: string;
    taskIds: Record<string, string>;
  };
  activeOperation?: ActiveOperation;
  failedOperation?: ActiveOperation;
  config: FrozenRunConfig;
  createdAt: number;
  updatedAt: number;
  lease?: { sessionId: string; pid: number; heartbeatAt: number };
  error?: string;
  unresolvedFindings: ReviewFinding[];
}

export type BridgeResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { code?: string; message: string } };
