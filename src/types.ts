import type { OperationDiagnostics } from './diagnostics.js';

export const COMPLETED_PLANS_DIRECTORY = 'completed';
export const CONTROLLER_POLL_INTERVAL_MS = 1_000;

export const EXEC_ACTION = {
  HELP: 'help',
  SETUP: 'setup',
  RUNS: 'runs',
  CLEANUP: 'cleanup',
  DOCTOR: 'doctor',
  STATUS: 'status',
  STOP: 'stop',
  PAUSE: 'pause',
  RESUME: 'resume',
  ADOPT: 'adopt',
  SKIP: 'skip',
  CANCEL: 'cancel',
} as const;

/**
 * Retired names that still dispatch, so a scripted caller never breaks on a
 * renamed verb. Absent from /exec help; each names its replacement once in its
 * own output.
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
  'HELP' | 'SETUP' | 'RUNS' | 'CLEANUP' | 'DOCTOR' | 'ADOPT'
>];

export const RUN_STAGE = {
  RESOLVE: 'resolve',
  ISOLATION: 'isolation',
  PROJECT_TASKS: 'project_tasks',
  BRANCH: 'branch',
  PROGRESS: 'progress',
  IMPLEMENTATION: 'implementation',
  COMPREHENSIVE_REVIEW: 'comprehensive_review',
  SMELLS_REVIEW: 'smells_review',
  FUSION_REVIEW: 'fusion_review',
  CRITICAL_REVIEW: 'critical_review',
  FINALIZE: 'finalize',
  STATS: 'stats',
  ARCHIVE: 'archive',
  COMPLETE: 'complete',
} as const;

export type RunStage = (typeof RUN_STAGE)[keyof typeof RUN_STAGE];
export const RUN_STAGES: readonly RunStage[] = Object.freeze(
  Object.values(RUN_STAGE),
);

export const RUN_STATUS = {
  STARTING: 'starting',
  RUNNING: 'running',
  PAUSED: 'paused',
  SKIP_PENDING: 'skip_pending',
  CANCEL_PENDING: 'cancel_pending',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  COMPLETED: 'completed',
  COMPLETED_WITH_FINDINGS: 'completed_with_findings',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export const RUN_STATUSES: readonly RunStatus[] = Object.freeze(
  Object.values(RUN_STATUS),
);

export type ExecutionLifetime =
  | { mode: 'unbounded' }
  | { mode: 'bounded'; timeoutMs: number };

export const MAX_EXECUTION_TIMEOUT_MS = 2_147_483_647;

export type ReviewBackend = 'subagent' | 'fusion' | 'revmux';

export interface FrozenRunConfig {
  executionLifetime: ExecutionLifetime;
  retryDelayMs: number;
  requiredChecks: string[][];
  bootstrapCommands: string[][];
  reviewEnabled: boolean;
  reviewRequired: boolean;
  reviewBackend: ReviewBackend;
  reviewFallback: ReviewBackend[];
  statsEnabled: boolean;
  revmuxExecutable?: string;
  revmuxProfile?: string;
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
  executionLifetime: { mode: 'unbounded' },
  retryDelayMs: 5_000,
  requiredChecks: [],
  bootstrapCommands: [],
  reviewEnabled: true,
  reviewRequired: true,
  reviewBackend: 'subagent',
  reviewFallback: [],
  statsEnabled: false,
  taskRetries: 1,
  maxTaskIterations: 50,
  reviewIterations: 5,
  fusionIterations: 10,
  finalizeEnabled: true,
  workerAgent: 'worker',
  workerMaxTurns: 75,
  reviewerAgent: 'reviewer',
  reviewerMaxTurns: 30,
  statsAgent: 'reviewer',
  statsMaxTurns: 30,
} as const satisfies FrozenRunConfig;

export const OPERATION_SERVICE = {
  BRIDGE: 'bridge',
  FUSION: 'fusion',
} as const;

export type OperationService =
  (typeof OPERATION_SERVICE)[keyof typeof OPERATION_SERVICE];

export const OPERATION_KIND = {
  IMPLEMENTATION: 'implementation',
  REVIEW: 'review',
  FIX: 'fix',
  FUSION: 'fusion',
  FINALIZE: 'finalize',
  STATS: 'stats',
} as const;

export type OperationKind =
  (typeof OPERATION_KIND)[keyof typeof OPERATION_KIND];

export const OPERATION_RECOVERY = {
  OBSERVE: 'observe',
  REPLAY: 'replay',
  CANCEL: 'cancel',
  REQUIRED: 'recovery_required',
} as const;

export type OperationRecovery =
  (typeof OPERATION_RECOVERY)[keyof typeof OPERATION_RECOVERY];

export const EXTERNAL_OPERATION_STATE = {
  RUNNING: 'running',
  STOPPING: 'stopping',
  COMPLETE: 'complete',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  PAUSED: 'paused',
  ABORTED: 'aborted',
  PENDING: 'pending',
  FOUND: 'found',
  UNKNOWN: 'unknown',
  UNKNOWN_LAUNCH: 'unknown_launch',
  ABSENT: 'absent',
  CHAIN: 'chain',
  PANEL: 'panel',
  JUDGE: 'judge',
} as const;

export interface PlanTask {
  id: number;
  dependsOn: number[];
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
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
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
export const WORKFLOW_MODE = 'workflow';

export const WORKFLOW_RESOLUTION = {
  SETTLED_AWAITING_RESUME: 'settled-awaiting-resume',
} as const;

/**
 * Compact digest of the provider status text. The provider renders each line
 * conditionally, so a missing field means "not reported", never "healthy".
 */
export interface WorkerSignal {
  mode?: string;
  /**
   * Non-workflow modes only. Upstream anchors the workflow-mode value to launch
   * time (nicobailon/pi-subagents#920), so it grows while the worker is healthy
   * and must never be surfaced.
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
  requestDigest?: string;
  taskId?: number;
  reviewIteration?: number;
  reviewedCommit?: string;
  stopRequested?: boolean;
  stopAcknowledged?: boolean;
  launchFenced?: boolean;
  recovery?: OperationRecovery;
  launchFailures?: number;
  lastLaunchError?: string;
  statusFailures?: number;
  lastObservedAt?: number;
  lastObservedState?: string;
  lastStatusError?: string;
  terminalError?: string;
  skipFailures?: number;
  lastSkipError?: string;
  /** Last digest parsed from the provider status text; absent when unreported. */
  workerSignal?: WorkerSignal;
  processTreeExited?: boolean;
  stopGeneration?: number;
  nextAttemptAt?: number;
  effectiveLifetime?: ExecutionLifetime;
  expectedLifetime?: ExecutionLifetime;
  terminationReason?: 'execution_lifetime_expired';
  budgetExpiryRecorded?: boolean;
  budgetGrowthGranted?: boolean;
  externalPrerequisite?: ExternalPrerequisite;
  diagnostics?: OperationDiagnostics;
  diagnosticActions?: Record<string, DiagnosticAction>;
  reportedUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
}

export interface DiagnosticAction {
  diagnosticId: string;
  toolCallId: string;
  message: string;
  state: 'pending' | 'queued' | 'cancelled' | 'rejected';
  stopGeneration: number;
  requestedAt: number;
  nextAttemptAt: number;
  lastReplyAt?: number;
  error?: string;
}

export type TaskExecutionState =
  | 'ready'
  | 'running'
  | 'verifying'
  | 'retry_wait'
  | 'waiting_dependency'
  | 'waiting_external'
  | 'accepted';

export interface ExternalPrerequisite {
  kind: 'credentials' | 'permission' | 'missing_executable' | 'runtime';
  source: 'provider' | 'worker';
  evidence: string;
}

export interface TaskExecution {
  taskId: number;
  dependsOn: number[];
  state: TaskExecutionState;
  attempts: number;
  nextAttemptAt?: number;
  reason?: string;
  externalPrerequisite?: ExternalPrerequisite;
  laneCwd?: string;
  laneBranch?: string;
  recoverySource?: TaskRecoverySource;
  recoveryHistory?: TaskRecoverySource[];
  baselineCommit?: string;
  candidateCommit?: string;
  acceptedCommit?: string;
  operationId?: string;
  lastScheduledAt?: number;
  lastVerifiedActivityAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
}

export interface TaskRecoverySource {
  cwd: string;
  branch: string;
  baselineCommit: string;
  headCommit: string;
  checkpointRef: string;
  checkpointCommit?: string;
}

export interface GoalCheckEvidence {
  fingerprint: string;
  /** Normalized tail of the failing check output, fed to the next goal turn. */
  failures: string;
  head: string;
  at: number;
}

/** Presence of `goal` marks a planless goal run on the shared controller loop. */
export interface GoalState {
  text: string;
  hash: string;
  iteration: number;
  maxTurns: number;
  noProgress: number;
  lastOutcome?: string;
  lastCheck?: GoalCheckEvidence;
}

export interface PlanExecRun {
  schemaVersion: 1;
  id: string;
  /** Monotonic durable-state revision. Missing only on legacy v1 records. */
  revision?: number;
  goal?: GoalState;
  repositoryRoot: string;
  /** Absent on goal runs; required by `requirePlan` on plan runs. */
  planPath?: string;
  /** Absent on goal runs; required by `requirePlan` on plan runs. */
  planHash?: string;
  initialPlan?: { hash: string; content: string };
  approvedPlan?: { hash: string; content: string };
  worktreeCwd: string;
  branch: string;
  defaultBranch: string;
  status: RunStatus;
  /** Derived from the private local-operation index on registry reads. */
  localOperationActive?: boolean;
  stage: RunStage;
  taskAttempts: Record<string, number>;
  budgetExhaustions?: Record<string, number>;
  budgetGrowths?: Record<string, number>;
  tasks?: Record<string, TaskExecution>;
  acceptedHead?: string;
  reviewedCommit?: string;
  verifiedCommit?: string;
  nextAttemptAt?: number;
  wakeReason?: string;
  recoveryAttempts?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
  statsReport?: {
    state: 'summary' | 'reported' | 'unavailable';
    summary: string;
    error?: string;
  };
  reviewRecovery?: {
    fingerprint: string;
    repeats: number;
    pendingFix: boolean;
    lastReviewedCommit?: string;
  };
  outputTarget?: {
    cwd: string;
    branch: string;
    initialHead: string;
    planRelativePath: string;
    progressRelativePath?: string;
  };
  outputPromotion?: {
    candidate: string;
    state: 'pending' | 'complete';
    attempt?: number;
    commandStarted?: boolean;
  };
  archiveOperation?: {
    phase: 'stage' | 'commit' | 'retired';
    operationId: string;
    commands: string[][];
    paths: string[];
    destination: string;
    attempt: number;
  };
  needsAttention?: boolean;
  stopGeneration?: number;
  userStopped?: boolean;
  lanePreparation?: {
    cwd: string;
    branch: string;
    baselineCommit: string;
    taskId: number;
    state: 'create' | 'bootstrap';
    nextAttemptAt?: number;
    error?: string;
    sourcePlanPath?: string;
    publication?: { planHash: string; digest: string };
  };
  stageAttempts: Partial<Record<RunStage, number>>;
  reviewFindings: ReviewFinding[];
  skippedStages: SkippedStage[];
  pendingStageSkip?: PendingStageSkip;
  branchRebindings: BranchRebinding[];
  progressPath?: string;
  taskProjection?: {
    version?: 1;
    state?: 'ready' | 'degraded';
    owner?: 'pi-plan-exec';
    sessionId: string;
    scope?: 'session';
    listPath?: string;
    packageVersion?: string;
    revision?: number;
    taskIds: Record<string, string>;
    error?: string;
  };
  activeOperation?: ActiveOperation;
  failedOperation?: ActiveOperation;
  /** Explicit stop: incomplete task or unmet goal, no automatic retry, resumable after confirmation. */
  blocked?: { taskId?: number; reason: string };
  /** One recovery launch only; consumed when the replacement child is recorded. */
  recoveryModel?: string;
  config: FrozenRunConfig;
  createdAt: number;
  updatedAt: number;
  /**
   * When the archive stage finished; cleanup measures its retention window from
   * here. Absent on runs archived before the field existed or finished without
   * the archive stage, which fall back to `updatedAt`.
   */
  retiredAt?: number;
  /** Stamped when an abandoned run was reset to failed, so the reset is auditable. */
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
