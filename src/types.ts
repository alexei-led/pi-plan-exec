export const COMPLETED_PLANS_DIRECTORY = "completed";

export const EXEC_ACTION = {
  HELP: "help",
  SETUP: "setup",
  RUNS: "runs",
  CLEANUP: "cleanup",
  DOCTOR: "doctor",
  STATUS: "status",
  STOP: "stop",
  PAUSE: "pause",
  RESUME: "resume",
  ADOPT: "adopt",
  SKIP: "skip",
  CANCEL: "cancel",
} as const;

/**
 * Retired names that still dispatch. They are absent from /exec help and name
 * their replacement once in their own output, so a run in flight during an
 * upgrade — or a scripted caller — never breaks on a renamed verb.
 */
export const EXEC_ALIAS_ACTIONS = [
  EXEC_ACTION.RUNS,
  EXEC_ACTION.DOCTOR,
  EXEC_ACTION.SETUP,
  EXEC_ACTION.ADOPT,
  EXEC_ACTION.PAUSE,
  EXEC_ACTION.CANCEL,
] as const;

export type ExecAliasAction = (typeof EXEC_ALIAS_ACTIONS)[number];

export type RunAction = (typeof EXEC_ACTION)[Exclude<
  keyof typeof EXEC_ACTION,
  "HELP" | "SETUP" | "RUNS" | "CLEANUP" | "DOCTOR" | "ADOPT"
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

/** `status.mode` value the bridge spawns; its activity fields are untrustworthy. */
export const WORKFLOW_MODE = "workflow";

/**
 * Compact digest of the provider status text. Every field is optional: the
 * provider renders each line conditionally, so a missing field means "not
 * reported", never "healthy".
 */
export interface WorkerSignal {
  mode?: string;
  /**
   * Only ever set for non-workflow modes. Upstream anchors the workflow-mode
   * value to launch time (nicobailon/pi-subagents#920), so it grows without
   * bound while the worker is healthy and must never be surfaced.
   */
  activity?: string;
  progress?: string;
  turnBudget?: string;
  updated?: string;
  steps?: string[];
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
  terminalError?: string;
  skipFailures?: number;
  lastSkipError?: string;
  /** Last digest parsed from the provider status text; absent when unreported. */
  workerSignal?: WorkerSignal;
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
  /** One recovery launch only; consumed when the replacement child is recorded. */
  recoveryModel?: string;
  config: FrozenRunConfig;
  createdAt: number;
  updatedAt: number;
  /**
   * When the archive stage finished. Cleanup measures its retention window
   * from here, falling back to `updatedAt` on runs archived before this field
   * existed or completed without the archive stage.
   */
  retiredAt?: number;
  /**
   * Set when an abandoned run was reset to failed, by /exec resume or by
   * /exec doctor --reconcile, so the reset is auditable in the record itself.
   */
  reconciledAt?: number;
  lease?: {
    sessionId: string;
    pid: number;
    heartbeatAt: number;
    /** Absent on leases written before this field existed: unknown host. */
    hostname?: string;
  };
  error?: string;
  unresolvedFindings: ReviewFinding[];
}

export type BridgeResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { code?: string; message: string } };
