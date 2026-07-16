export const RUN_STAGES = [
  "resolve",
  "isolation",
  "project_tasks",
  "branch",
  "progress",
  "implementation",
  "comprehensive_review",
  "smells_review",
  "fusion_review",
  "critical_review",
  "finalize",
  "stats",
  "archive",
  "complete",
] as const;

export type RunStage = (typeof RUN_STAGES)[number];
export const RUN_STATUSES = [
  "starting",
  "running",
  "paused",
  "cancel_pending",
  "cancelled",
  "failed",
  "completed",
  "completed_with_findings",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

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

export interface ReviewFinding {
  id: string;
  severity: "CRITICAL" | "MAJOR" | "MINOR";
  summary: string;
  evidence?: string;
  suggestion?: string;
}

export interface ActiveOperation {
  operationId: string;
  service: "bridge" | "fusion";
  kind: "implementation" | "review" | "fix" | "fusion" | "finalize" | "stats";
  externalRunId?: string;
  asyncDir?: string;
  launchStartedAt?: number;
  params?: Record<string, unknown>;
  taskId?: number;
  reviewIteration?: number;
  stopRequested?: boolean;
  recovery?: "observe" | "replay" | "cancel";
  launchFailures?: number;
  lastLaunchError?: string;
  statusFailures?: number;
  lastObservedAt?: number;
  lastStatusError?: string;
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
