import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  readSettledWorkflowCompletion,
  readSubagentArtifact,
} from "./artifact.js";
import {
  bridgeRequestDigest,
  hasTerminalOwnershipProof,
  supportsOwnedProcessTree,
  parseExecutionLifetime,
  type BridgeCapabilities,
  type BridgeOperationOwner,
  type DiagnosticGuidanceRequest,
} from "./bridge.js";
import {
  FUSION_PHASE,
  fusionState,
  parseFusionCallerOutput,
  type FusionRunState,
  type FusionCapabilities,
} from "./fusion.js";
import {
  branchNameFromPlan,
  executionWorktreePath,
  currentBranch,
  defaultBranch,
  ensureCleanForWorktree,
  isPathWithin,
  requireGitRepository,
  gitCheckoutRoot,
  verifyExistingWorktree,
  verifyExecutionRepository,
  verifyExecutionTree,
  worktreePlanPath,
  worktreeChanges,
  type RunCommand,
} from "./git.js";
import {
  assertPlanRun,
  isGoalRun,
  isRecoverableRun,
  isReviewStage,
  isSkippableStage,
  isTerminalStatus,
  nextStage,
  requirePlanPath,
} from "./lifecycle.js";
import {
  GOAL_CHECK_OUTPUT_LIMIT,
  GOAL_DISABLED_SAMPLE_LIMIT,
  GOAL_FINGERPRINT_LENGTH,
  GOAL_NO_PROGRESS_LIMIT,
  GOAL_OUTCOME,
  TASK_FAILED_MARKER,
  goalHash,
  goalPrompt,
  normalizeGoalText,
  parseGoalOutcome,
} from "./goal-loop.js";
import { readPlan, parsePlan, materializeApprovedPlan } from "./plan.js";
import {
  appendProgress,
  appendProgressOnce,
  initializeProgress,
} from "./progress.js";
import { RunRegistry } from "./registry.js";
import { diagnoseOperation } from "./diagnostics.js";
import { resolveRunConfig } from "./config.js";
import { RevmuxReviewClient, validateReviewResult } from "./review-backend.js";
import { cancelActiveLocalOperations, durableJson, LocalOperationCancelledError, LocalOperationFailedError, LocalOperationUnknownError, type LocalOperationOptions } from "./local-operation.js";
import { reconcileTasks, selectReadyTask, nextTaskWake } from "./scheduler.js";
import { bootstrapCommands, gitValue, requiredChecks, runCommands } from "./lanes.js";
import {
  formatFindings,
  hasBlockingFindings,
  parseReviewFindings,
} from "./review.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  CONTROLLER_POLL_INTERVAL_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  EXTERNAL_OPERATION_STATE,
  OPERATION_KIND,
  OPERATION_RECOVERY,
  OPERATION_SERVICE,
  RUN_STAGE,
  RUN_STATUS,
  WORKFLOW_MODE,
  type ActiveOperation,
  type FrozenRunConfig,
  type PlanExecRun,
  type ReviewFinding,
  type RunStage,
  type WorkerSignal,
  type ExecutionLifetime,
  type ParsedPlan,
  type ExternalPrerequisite,
  type DiagnosticAction,
  type TaskRecoverySource,
} from "./types.js";

/** Attention threshold only; recovery continues beyond this count. */
export const MAX_STATUS_FAILURES = 3;
const TERMINAL_BRIDGE_OPERATION_STATES = new Set<string>([
  EXTERNAL_OPERATION_STATE.COMPLETE,
  EXTERNAL_OPERATION_STATE.DONE,
  EXTERNAL_OPERATION_STATE.FAILED,
  EXTERNAL_OPERATION_STATE.STOPPED,
  EXTERNAL_OPERATION_STATE.PAUSED,
  EXTERNAL_OPERATION_STATE.ABORTED,
]);
const OPERATION_UPDATE_CAS_RETRIES = 5;
const OPERATION_RECOVERY_DELAY_MS = 35_000;
const RECOVERY_WORKER_MAX_TURNS = 75;
const RECOVERY_REVIEWER_MAX_TURNS = 75;
const MAX_TERMINAL_ERROR_LENGTH = 2_000;
const GIT_MISSING_OBJECT_EXIT_CODE = 128;
const LANE_TOKEN_LENGTH = 12;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_AUTOMATIC_RETRY_DELAY_MS = 300_000;
const MAX_BACKOFF_EXPONENT = 16;
const REVIEW_DIAGNOSTIC_BURST = 2;
const MAX_LIFETIME_GROWTH_EXPONENT = 31;
const BUDGET_PROGRESS_WINDOW_MS = 60_000;
const BUDGET_PROGRESS_WINDOW_DIVISOR = 10;
export const PLAN_STRUCTURE_CHANGED_ERROR =
  "Plan task structure changed outside checkbox completion.";

type ServiceReply =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { code?: string; message: string } };

interface BridgeLike {
  spawn(
    operationId: string,
    params: Record<string, unknown>,
    owner?: BridgeOperationOwner,
  ): Promise<ServiceReply>;
  operation(
    operationId: string,
    owner?: BridgeOperationOwner,
  ): Promise<ServiceReply>;
  cancelOperation?(operationId: string, owner?: BridgeOperationOwner): Promise<ServiceReply>;
  diagnoseOperation?(operationId: string, owner: BridgeOperationOwner, params: DiagnosticGuidanceRequest): Promise<ServiceReply>;
  capabilities?(): Promise<BridgeCapabilities>;
  status(runId: string, asyncDir?: string): Promise<ServiceReply>;
  result(runId: string, asyncDir?: string): Promise<ServiceReply>;
  adopt(runId: string, asyncDir?: string): Promise<ServiceReply>;
  stop(runId: string, asyncDir?: string): Promise<ServiceReply>;
}

interface FusionLike {
  capabilities?(): Promise<FusionCapabilities>;
  start(
    operationId: string,
    prompt: string,
    profile?: string,
    executionLifetime?: ExecutionLifetime,
    digest?: string,
    context?: { cwd: string; reviewedCommit: string },
  ): Promise<ServiceReply>;
  status(runId?: string, operationId?: string): Promise<ServiceReply>;
  result(runId?: string, operationId?: string): Promise<ServiceReply>;
  adopt(runId: string): Promise<ServiceReply>;
  cancel(runId?: string, operationId?: string): Promise<ServiceReply>;
}

export interface StartRunOptions {
  cwd: string;
  planPath: string;
  useWorktree: boolean;
  /** Use this already-registered linked worktree instead of creating one. */
  existingWorktree?: string;
  sessionId: string;
  onRunAllocated?: (run: PlanExecRun) => void;
}

/** Deterministic controller. It chooses transitions; existing extensions execute work. */
export class PlanExecController {
  constructor(
    private readonly registry: RunRegistry,
    private readonly bridge: BridgeLike,
    private readonly fusion: FusionLike,
    private readonly runCommand: RunCommand,
    private readonly executeLocalCommands: typeof runCommands = runCommands,
  ) {}

  async start(options: StartRunOptions): Promise<PlanExecRun> {
    if (options.existingWorktree !== undefined && options.useWorktree)
      throw new Error("Choose either an existing worktree or a new worktree.");
    const targetPath = options.existingWorktree === undefined
      ? options.cwd
      : resolve(options.cwd, options.existingWorktree);
    const requestedPlan = resolve(targetPath, options.planPath);
    const sourcePlanPath = options.existingWorktree === undefined
      ? requestedPlan
      : await realpath(requestedPlan);
    const initialContent = await readFile(sourcePlanPath, "utf8");
    const plan = parsePlan(sourcePlanPath, initialContent);
    const repositoryRoot = await requireGitRepository(
      this.runCommand,
      options.cwd,
    );
    const baseBranch = await defaultBranch(this.runCommand, repositoryRoot);
    let branch: string;
    let executionWorktreeCwd: string;
    let executionPlanPath = plan.path;

    if (options.existingWorktree !== undefined) {
      const targetWorktree = await verifyExistingWorktree(
        this.runCommand,
        repositoryRoot,
        targetPath,
      );
      if (!isPathWithin(targetWorktree, plan.path))
        throw new Error("Plan must be inside the selected Git worktree.");
      branch = await currentBranch(this.runCommand, targetWorktree);
      executionWorktreeCwd = targetWorktree;
    } else {
      if (!isPathWithin(repositoryRoot, plan.path))
        throw new Error("Plan must be stored inside the Git repository.");
      const current = await currentBranch(this.runCommand, options.cwd);
      const planBranch = branchNameFromPlan(plan.path);
      branch = options.useWorktree
        ? current === baseBranch
          ? planBranch
          : `${current}-${planBranch}`
        : current;
      executionWorktreeCwd = options.useWorktree
        ? executionWorktreePath(repositoryRoot, branch)
        : resolve(options.cwd);
      if (options.useWorktree) {
        await ensureCleanForWorktree(this.runCommand, repositoryRoot, plan.path);
        if (await pathExists(executionWorktreeCwd)) throw new Error(`Worktree already exists: ${executionWorktreeCwd}`);
        executionPlanPath = worktreePlanPath(
          executionWorktreeCwd,
          repositoryRoot,
          plan.path,
        );
      }
    }

    const configured = await resolveRunConfig(repositoryRoot);
    const baselineCwd = options.useWorktree ? repositoryRoot : executionWorktreeCwd;
    const config: FrozenRunConfig = { ...configured,
      requiredChecks: await requiredChecks(baselineCwd, configured.requiredChecks),
      bootstrapCommands: await bootstrapCommands(baselineCwd, configured.bootstrapCommands),
    };
    const initialHead = await gitValue(this.runCommand, baselineCwd, ["rev-parse", "HEAD"]);
    const run = await this.registry.create({
      schemaVersion: 1,
      repositoryRoot,
      planPath: executionPlanPath,
      planHash: plan.hash,
      initialPlan: { hash: plan.hash, content: initialContent },
      worktreeCwd: executionWorktreeCwd,
      branch,
      defaultBranch: baseBranch,
      outputTarget: { cwd: executionWorktreeCwd, branch, initialHead,
        planRelativePath: relative(executionWorktreeCwd, executionPlanPath) },
      status: RUN_STATUS.STARTING,
      stage: RUN_STAGE.RESOLVE,
      taskAttempts: {},
      stageAttempts: {},
      reviewFindings: [],
      config,
      unresolvedFindings: [],
      skippedStages: [],
      branchRebindings: [],
      ...(options.useWorktree ? { lanePreparation: { cwd: executionWorktreeCwd, branch,
        baselineCommit: initialHead,
        taskId: 0, state: "create" as const, sourcePlanPath: plan.path } } : {}),
    }, { exclusive: true, ...(options.onRunAllocated ? { onAllocated: options.onRunAllocated } : {}) });
    return this.advance(await this.registry.claim(run, options.sessionId));
  }

  /**
   * A goal run works in place on the current branch: no plan file, no worktree,
   * and a clean tree is required because every turn commits its own work.
   */
  async startGoal(options: {
    goal: string;
    sessionId: string;
    cwd: string;
    checks?: string[][];
    onRunAllocated?: (run: PlanExecRun) => void;
  }): Promise<PlanExecRun> {
    const text = normalizeGoalText(options.goal);
    const repositoryRoot = await requireGitRepository(this.runCommand, options.cwd);
    const branch = await currentBranch(this.runCommand, options.cwd);
    const dirty = await worktreeChanges(this.runCommand, options.cwd);
    if (dirty.length)
      throw new Error("A goal run works in place and refuses a dirty worktree; commit or stash changes first.");
    const configured = await resolveRunConfig(repositoryRoot);
    const config: FrozenRunConfig = { ...configured,
      requiredChecks: await requiredChecks(options.cwd, options.checks?.length ? options.checks : configured.requiredChecks),
    };
    if (!config.requiredChecks.length)
      throw new Error("A goal needs at least one required check to prove completion; add a test or build script, or pass --check <command>.");
    const initialHead = await gitValue(this.runCommand, options.cwd, ["rev-parse", "HEAD"]);
    const baseBranch = await defaultBranch(this.runCommand, repositoryRoot);
    const hash = goalHash(text);
    const run = await this.registry.create({
      schemaVersion: 1,
      repositoryRoot,
      goal: { text, hash, iteration: 0, maxTurns: config.maxTaskIterations, noProgress: 0 },
      worktreeCwd: options.cwd,
      branch,
      defaultBranch: baseBranch,
      outputTarget: { cwd: options.cwd, branch, initialHead, planRelativePath: "" },
      status: RUN_STATUS.STARTING,
      stage: RUN_STAGE.IMPLEMENTATION,
      progressPath: join(options.cwd, ".ralphex", "progress", `progress-goal-${hash}.txt`),
      taskAttempts: {},
      stageAttempts: {},
      reviewFindings: [],
      config,
      unresolvedFindings: [],
      skippedStages: [],
      branchRebindings: [],
    }, { exclusive: true, ...(options.onRunAllocated ? { onRunAllocated: options.onRunAllocated } : {}) });
    return this.advance(await this.registry.claim(run, options.sessionId));
  }

  async markFailed(
    runId: string,
    error: unknown,
  ): Promise<PlanExecRun | undefined> {
    const run = await this.registry.get(runId);
    if (!run || isTerminalStatus(run.status)) return run;
    return this.fail(
      run,
      error instanceof Error ? error.message : String(error),
      run.activeOperation !== undefined,
    );
  }

  /** Automatic progress never grants the authorization of an explicit resume. */
  async tick(runId: string, sessionId: string): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, async () => {
      const run = await this.registry.get(runId);
      if (!run) throw new Error(`Plan execution run not found: ${runId}`);
      if (isTerminalStatus(run.status) || (run.status === RUN_STATUS.PAUSED && !run.activeOperation && !run.localOperationActive)) return run;
      const claimed = await this.registry.claim(run, sessionId);
      try { return await this.advanceUnlocked(claimed); }
      catch (error) { return this.fail(claimed, error instanceof Error ? error.message : String(error), true); }
    });
    const current = coordinated ?? await this.registry.get(runId);
    if (!current) throw new Error(`Plan execution run not found: ${runId}`);
    return current;
  }

  async resume(
    runId: string,
    sessionId: string,
    explicit = true,
    reviewedPlanHash?: string,
    retryTask = false,
    recoveryModel?: string,
    expectedStopGeneration?: number,
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.resumeLocked(
        runId,
        sessionId,
        explicit,
        reviewedPlanHash,
        retryTask,
        recoveryModel,
        expectedStopGeneration,
      ),
    );
    if (coordinated) return coordinated;
    const current = await this.registry.get(runId);
    if (!current) throw new Error(`Plan execution run not found: ${runId}`);
    return current;
  }

  private async resumeLocked(
    runId: string,
    sessionId: string,
    explicit: boolean,
    reviewedPlanHash?: string,
    retryTask = false,
    recoveryModel?: string,
    expectedStopGeneration?: number,
  ): Promise<PlanExecRun> {
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    if (expectedStopGeneration !== undefined && (existing.stopGeneration ?? 0) !== expectedStopGeneration) return existing;
    if (explicit) await this.registry.assertExclusive(existing);
    const claimed = await this.registry.claim(existing, sessionId);
    if (explicit && (claimed.stopGeneration ?? 0) !== (existing.stopGeneration ?? 0))
      return claimed;
    let prepared = claimed;
    if (explicit) {
      const authorized = await this.registry.updateIfCurrent(
        { ...prepared, userStopped: false, nextAttemptAt: 0 },
        prepared.updatedAt,
      );
      if (!authorized.applied) return authorized.run;
      prepared = authorized.run;
      const unpinned = withoutLegacyRecoveryModelPins(prepared);
      if (unpinned !== prepared) {
        const normalized = await this.registry.updateIfCurrent(
          unpinned,
          prepared.updatedAt,
        );
        if (!normalized.applied) return normalized.run;
        prepared = normalized.run;
      }
    }
    if (explicit && isGoalRun(prepared) && prepared.goal.iteration >= prepared.goal.maxTurns) {
      const granted = await this.registry.updateIfCurrent({
        ...prepared,
        goal: { ...prepared.goal, maxTurns: prepared.goal.maxTurns + prepared.config.maxTaskIterations },
      }, prepared.updatedAt);
      if (!granted.applied) return granted.run;
      prepared = granted.run;
    }
    if (reviewedPlanHash !== undefined) {
      if (!explicit) throw new Error("Adopting a changed plan requires explicit resume.");
      if (isGoalRun(prepared)) throw new Error("Plan adoption does not apply to goal runs.");
      const planPath = requirePlanPath(prepared);
      const content = await readFile(planPath, "utf8");
      const approved = parsePlan(planPath, content);
      if (approved.hash !== reviewedPlanHash) return this.pauseForReview(prepared, PLAN_STRUCTURE_CHANGED_ERROR);
      const acceptedHead = prepared.acceptedHead ?? prepared.outputTarget?.initialHead ??
        await gitValue(this.runCommand, prepared.worktreeCwd, ["rev-parse", "HEAD"]);
      const { facts } = await this.planBaseline(prepared, prepared.worktreeCwd, acceptedHead, planPath);
      const materialized = parsePlan(planPath, materializeApprovedPlan(planPath, content, facts));
      const tasks = reconcileTaskFacts(materialized, prepared.tasks);
      const adopted = await this.registry.updateIfCurrent(
        {
          ...prepared,
          planHash: reviewedPlanHash,
          approvedPlan: { hash: reviewedPlanHash, content },
          tasks,
          status: RUN_STATUS.PAUSED,
        },
        prepared.updatedAt,
      );
      if (!adopted.applied) return adopted.run;
      prepared = adopted.run;
    }
    const preservedOperationId = prepared.activeOperation?.operationId;
    if (explicit && isTaskRetryConfirmationRequired(prepared) && !retryTask)
      throw new Error(taskRetryRequiredMessage(prepared));
    if (explicit && isRecoverableFailure(prepared)) {
      prepared = await this.recoverFailedRun(
        prepared,
        retryTask,
        recoveryModel,
      );
    } else if (explicit && prepared.status === RUN_STATUS.PAUSED) {
      const resumed = await this.registry.updateIfCurrent(
        clearError({ ...prepared, status: RUN_STATUS.RUNNING }),
        prepared.updatedAt,
      );
      if (!resumed.applied) return resumed.run;
      prepared = resumed.run;
    }
    const shouldAdoptPreservedOperation =
      preservedOperationId !== undefined &&
      prepared.activeOperation?.operationId === preservedOperationId;
    return this.advanceUnlocked(
      shouldAdoptPreservedOperation
        ? await this.adoptActiveOperation(prepared)
        : prepared,
    );
  }

  async rebindBranchAndResume(
    runId: string,
    sessionId: string,
    expectedStopGeneration?: number,
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.rebindBranchAndResumeLocked(runId, sessionId, expectedStopGeneration),
    );
    if (coordinated) return coordinated;
    const current = await this.registry.get(runId);
    if (!current) throw new Error(`Plan execution run not found: ${runId}`);
    return current;
  }

  private async rebindBranchAndResumeLocked(
    runId: string,
    sessionId: string,
    expectedStopGeneration?: number,
  ): Promise<PlanExecRun> {
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    if (expectedStopGeneration !== undefined && (existing.stopGeneration ?? 0) !== expectedStopGeneration) return existing;
    await this.registry.assertExclusive(existing);
    const claimed = await this.registry.claim(existing, sessionId);
    if (expectedStopGeneration !== undefined && (claimed.stopGeneration ?? 0) !== expectedStopGeneration) return claimed;
    if (
      isTerminalStatus(claimed.status) &&
      claimed.status !== RUN_STATUS.FAILED
    )
      throw new Error(`Run ${runId} is already ${claimed.status}.`);
    if (claimed.activeOperation)
      throw new Error(
        "Cannot adopt the current branch while an external operation is tracked.",
      );
    await verifyExecutionRepository(
      this.runCommand,
      claimed.worktreeCwd,
      claimed.repositoryRoot,
    );
    const branch = await currentBranch(this.runCommand, claimed.worktreeCwd);
    if (branch === claimed.branch)
      throw new Error(`Execution branch is already ${branch}.`);
    const requestedAt = Date.now();
    const rebound = await this.registry.updateIfCurrent(
      {
        ...claimed,
        branch,
        branchRebindings: [
          ...claimed.branchRebindings,
          {
            from: claimed.branch,
            to: branch,
            requestedAt,
            requestedBy: sessionId,
          },
        ],
      },
      claimed.updatedAt,
    );
    if (!rebound.applied) return rebound.run;
    await appendProgressBestEffort(
      rebound.run,
      `Execution branch rebound by ${sessionId}: ${claimed.branch} -> ${branch}`,
    );
    if (
      rebound.run.status === RUN_STATUS.FAILED ||
      rebound.run.status === RUN_STATUS.PAUSED ||
      rebound.run.status === RUN_STATUS.CANCEL_PENDING
    )
      return this.resumeLocked(runId, sessionId, true, undefined, false, undefined, expectedStopGeneration);
    return this.advanceUnlocked(rebound.run);
  }

  async skip(
    runId: string,
    sessionId: string,
    reason: string,
    expectedStopGeneration?: number,
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.skipLocked(runId, sessionId, reason, expectedStopGeneration),
    );
    if (coordinated) return coordinated;
    const current = await this.registry.get(runId);
    if (!current) throw new Error(`Plan execution run not found: ${runId}`);
    return current;
  }

  private async skipLocked(
    runId: string,
    sessionId: string,
    reason: string,
    expectedStopGeneration?: number,
  ): Promise<PlanExecRun> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("Force-skip requires a reason.");
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    if (expectedStopGeneration !== undefined && (existing.stopGeneration ?? 0) !== expectedStopGeneration) return existing;
    const claimed = await this.registry.claim(existing, sessionId);
    if (expectedStopGeneration !== undefined && (claimed.stopGeneration ?? 0) !== expectedStopGeneration) return claimed;
    if (!isSkippableStage(claimed.stage))
      throw new Error(`Stage ${claimed.stage} cannot be force-skipped.`);
    if ((claimed.config.reviewRequired && isReviewStage(claimed.stage)) ||
      claimed.stage === RUN_STAGE.FINALIZE)
      throw new Error(`Required ${claimed.stage} cannot be satisfied by skipping it.`);
    if (
      claimed.status !== RUN_STATUS.FAILED &&
      claimed.status !== RUN_STATUS.PAUSED &&
      claimed.status !== RUN_STATUS.SKIP_PENDING
    ) {
      throw new Error(
        `Stage ${claimed.stage} cannot be force-skipped while the run is ${claimed.status}.`,
      );
    }
    let requested = claimed;
    if (!claimed.pendingStageSkip) {
      const requestedAt = Date.now();
      const persisted = await this.registry.updateIfCurrent(
        {
          ...claimed,
          status: RUN_STATUS.SKIP_PENDING,
          userStopped: false,
          nextAttemptAt: 0,
          pendingStageSkip: {
            stage: claimed.stage,
            reason: trimmedReason,
            requestedAt,
            requestedBy: sessionId,
          },
        },
        claimed.updatedAt,
      );
      if (!persisted.applied) return persisted.run;
      requested = persisted.run;
      await appendProgressBestEffort(
        requested,
        `Force-skip requested for ${requested.stage} by ${sessionId}: ${trimmedReason}`,
      );
    } else if (claimed.status !== RUN_STATUS.SKIP_PENDING || claimed.userStopped) {
      const resetOperation = resetOperationFailures(claimed.activeOperation);
      const persisted = await this.registry.updateIfCurrent(
        clearError({
          ...claimed,
          status: RUN_STATUS.SKIP_PENDING,
          userStopped: false,
          nextAttemptAt: 0,
          ...(resetOperation ? { activeOperation: resetOperation } : {}),
        }),
        claimed.updatedAt,
      );
      if (!persisted.applied) return persisted.run;
      requested = persisted.run;
    }
    return this.advanceUnlocked(requested);
  }

  async advance(run: PlanExecRun): Promise<PlanExecRun> {
    const current = (await this.registry.get(run.id)) ?? run;
    if (current.status === RUN_STATUS.PAUSED) return this.observePausedOperation(current);
    if (current.status === RUN_STATUS.CANCEL_PENDING) return this.cancel(current);
    const coordinated = await this.registry.withControllerLock(run.id, () =>
      this.advanceUnlocked(current),
    );
    if (coordinated) return coordinated;
    return (await this.registry.get(run.id)) ?? run;
  }

  private async advanceUnlocked(run: PlanExecRun): Promise<PlanExecRun> {
    run = (await this.registry.get(run.id)) ?? run;
    if (isTerminalStatus(run.status)) return run;
    if (run.status === RUN_STATUS.CANCEL_PENDING) return this.cancel(run);
    if (run.status === RUN_STATUS.SKIP_PENDING)
      return this.advanceStageSkip(run);
    if (run.status === RUN_STATUS.PAUSED) {
      if ((run.nextAttemptAt ?? 0) > Date.now()) return run;
      return run.activeOperation || run.localOperationActive ? this.observePausedOperation(run) : run;
    }
    if (run.userStopped) return run;
    if ((run.nextAttemptAt ?? 0) > Date.now()) return run;
    if (run.activeOperation) return this.observeActiveOperation(run);

    if (run.lanePreparation) return this.prepareLane(run);

    await verifyExecutionTree(
      this.runCommand,
      run.worktreeCwd,
      run.repositoryRoot,
      run.branch,
    );
    if (run.reviewRecovery?.pendingFix && isReviewStage(run.stage))
      return this.launchPendingReviewFix(run);
    switch (run.stage) {
      case RUN_STAGE.RESOLVE:
        return this.transition(
          run,
          RUN_STAGE.PROJECT_TASKS,
          "Plan validated; projecting task list.",
        );
      case RUN_STAGE.PROJECT_TASKS:
        return this.transition(
          run,
          RUN_STAGE.BRANCH,
          "Task projection created.",
        );
      case RUN_STAGE.BRANCH:
        return this.transition(
          run,
          RUN_STAGE.PROGRESS,
          `Execution branch ready: ${run.branch}.`,
        );
      case RUN_STAGE.PROGRESS: {
        const progressPath = await initializeProgress(run);
        return this.transition(
          { ...run, progressPath, ...(run.outputTarget ? { outputTarget: { ...run.outputTarget,
            progressRelativePath: relative(run.worktreeCwd, progressPath) } } : {}) },
          RUN_STAGE.IMPLEMENTATION,
          "Progress log initialized.",
        );
      }
      case RUN_STAGE.IMPLEMENTATION:
        return isGoalRun(run) ? this.advanceGoal(run) : this.advanceImplementation(run);
      case RUN_STAGE.COMPREHENSIVE_REVIEW:
      case RUN_STAGE.SMELLS_REVIEW:
      case RUN_STAGE.CRITICAL_REVIEW:
        return this.launchReview(run);
      case RUN_STAGE.FUSION_REVIEW:
        return this.launchFusion(run);
      case RUN_STAGE.FINALIZE:
        return this.launchFinalizer(run);
      case RUN_STAGE.STATS:
        return this.launchStats(run);
      case RUN_STAGE.ARCHIVE:
        return isGoalRun(run) ? this.complete(run) : this.archive(run);
      case RUN_STAGE.ISOLATION:
        return this.transition(
          run,
          RUN_STAGE.PROJECT_TASKS,
          "Isolation was selected before run creation.",
        );
      case RUN_STAGE.COMPLETE:
        return this.complete(run);
    }
  }

  private async advanceImplementation(run: PlanExecRun): Promise<PlanExecRun> {
    assertPlanRun(run);
    const content = await readFile(run.planPath, "utf8");
    const plan = parsePlan(run.planPath, content);
    if (plan.hash !== run.planHash) {
      return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
    }
    if (!run.initialPlan && !run.approvedPlan && run.tasks) {
      const head = run.acceptedHead ?? run.outputTarget?.initialHead ?? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
      const { facts } = await this.planBaseline(run, run.worktreeCwd, head, run.planPath);
      const materialized = materializeApprovedPlan(run.planPath, content, facts);
      const captured = await this.registry.updateIfCurrent({ ...run,
        initialPlan: { hash: run.planHash, content: materialized },
        tasks: reconcileTaskFacts(parsePlan(run.planPath, materialized), run.tasks),
      }, run.updatedAt);
      if (!captured.applied) return captured.run;
      run = captured.run;
      assertPlanRun(run);
    }
    const checkoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
    const tasks = reconcileTasks(plan.tasks, run.tasks);
    for (const execution of Object.values(tasks)) {
      if (execution.state !== RUN_STATUS.RUNNING && execution.state !== "verifying") continue;
      if (run.failedOperation?.taskId === execution.taskId && run.failedOperation.processTreeExited === true) {
        tasks[String(execution.taskId)] = { ...execution, state: "retry_wait", nextAttemptAt: Date.now(),
          reason: execution.reason ?? "Previous task operation has confirmed exit; scheduling recovery." };
      } else {
        return this.fail(run, `Task ${execution.taskId} has unresolved operation ownership; no replacement writer is authorized.`, true);
      }
    }
    if (Object.values(tasks).every((task) => task.state === "accepted")) {
      const committed = await gitValue(this.runCommand, run.worktreeCwd, ["show", `HEAD:${gitPath(relative(checkoutRoot, run.planPath))}`]);
      assertAcceptedCheckboxes({ ...run, tasks }, parsePlan(run.planPath, committed));
      return this.transition(
        { ...run, tasks },
        RUN_STAGE.COMPREHENSIVE_REVIEW,
        "All plan checkboxes are complete.",
      );
    }
    const selected = selectReadyTask(tasks);
    if (!selected) return (await this.registry.updateIfCurrent({ ...run, tasks,
      nextAttemptAt: nextTaskWake(tasks, Date.now()), wakeReason: "Waiting for task prerequisites or retry", }, run.updatedAt)).run;
    const task = plan.tasks.find((candidate) => candidate.id === selected.taskId)!;
    const acceptedHead = run.acceptedHead ?? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    if (!run.outputTarget) {
      const planPath = requirePlanPath(run);
      run = { ...run, tasks, acceptedHead,
        outputTarget: { cwd: run.worktreeCwd, branch: run.branch, initialHead: acceptedHead,
          planRelativePath: relative(run.worktreeCwd, planPath),
          ...(run.progressPath ? { progressRelativePath: relative(run.worktreeCwd, run.progressPath) } : {}) },
      };
    }
    assertPlanRun(run);
    const selectedPlanPath = selected.laneCwd
      ? join(await gitCheckoutRoot(this.runCommand, selected.laneCwd), relative(checkoutRoot, run.planPath)) : undefined;
    const staleLane = selectedPlanPath && (await readPlan(selectedPlanPath)).hash !== run.planHash;
    if (staleLane && !run.approvedPlan) return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
    if (selected.laneCwd && selected.baselineCommit && (selected.baselineCommit !== acceptedHead || staleLane) && selected.state !== "accepted") {
      const token = randomUUID().slice(0, LANE_TOKEN_LENGTH);
      const nextTask = { ...selected,
        recoveryHistory: [...(selected.recoveryHistory ?? []), ...(selected.recoverySource ? [selected.recoverySource] : [])],
        recoverySource: {
        cwd: selected.laneCwd, branch: selected.laneBranch!, baselineCommit: selected.baselineCommit,
        headCommit: await gitValue(this.runCommand, selected.laneCwd, ["rev-parse", "HEAD"]),
        checkpointRef: `refs/plan-exec/${run.id}/task-${selected.taskId}/checkpoint-${selected.attempts}`,
      } };
      delete nextTask.laneCwd;
      delete nextTask.laneBranch;
      delete nextTask.candidateCommit;
      return this.registry.update({ ...run, tasks: { ...tasks, [String(selected.taskId)]: nextTask }, acceptedHead,
        lanePreparation: { taskId: selected.taskId, cwd: join(dirname(checkoutRoot), `plan-exec-${run.id}-${token}`),
          branch: `plan-exec/${run.id}/${token}`, baselineCommit: acceptedHead, state: "create" },
      });
    }
    if (selected.laneCwd && selected.laneCwd !== run.worktreeCwd) {
      const targetRoot = await gitCheckoutRoot(this.runCommand, selected.laneCwd);
      const laneRun = await this.registry.updateIfCurrent({ ...run, tasks, acceptedHead,
        planPath: join(targetRoot, relative(checkoutRoot, run.planPath)),
        worktreeCwd: selected.laneCwd, branch: selected.laneBranch!,
        ...(run.progressPath ? { progressPath: join(targetRoot, relative(checkoutRoot, run.progressPath)) } : {}),
      }, run.updatedAt);
      return laneRun.run;
    }
    const occupied = Object.values(tasks).some((other) => other.taskId !== task.id && other.state !== "accepted" && other.laneCwd === run.worktreeCwd);
    let needsPublication = false;
    const authorized = run.approvedPlan ?? run.initialPlan;
    if (authorized && !selected.laneCwd) {
      const { facts } = await this.planBaseline(run, run.worktreeCwd, acceptedHead, run.planPath);
      const materialized = parsePlan(run.planPath, materializeApprovedPlan(run.planPath, authorized.content, facts));
      needsPublication = JSON.stringify(plan.tasks.map((entry) => entry.unchecked)) !==
        JSON.stringify(materialized.tasks.map((entry) => entry.unchecked));
    }
    if ((occupied || needsPublication) && !selected.laneCwd) {
      const token = randomUUID().slice(0, LANE_TOKEN_LENGTH);
      return (await this.registry.updateIfCurrent({ ...run, tasks, acceptedHead,
        lanePreparation: { taskId: task.id, cwd: join(dirname(checkoutRoot), `plan-exec-${run.id}-${token}`),
          branch: `plan-exec/${run.id}/${token}`, baselineCommit: acceptedHead, state: "create" },
      }, run.updatedAt)).run;
    }
    const prepared = await this.registry.updateIfCurrent({ ...run, tasks: { ...tasks, [String(task.id)]: {
      ...selected, state: "ready", lastScheduledAt: Date.now(), attempts: selected.attempts,
      laneCwd: run.worktreeCwd, laneBranch: run.branch, baselineCommit: selected.baselineCommit ?? acceptedHead,
    } }, acceptedHead, nextAttemptAt: 0, wakeReason: `Task ${task.id} ready`, }, run.updatedAt);
    if (!prepared.applied) return prepared.run;
    return this.launchBridge(prepared.run, {
      kind: OPERATION_KIND.IMPLEMENTATION,
      taskId: task.id,
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: workerPrompt(prepared.run, task.id, task.title, task.unchecked),
    });
  }

  private async advanceGoal(run: PlanExecRun): Promise<PlanExecRun> {
    if (!isGoalRun(run)) throw new Error("advanceGoal requires a goal run.");
    const goal = run.goal;
    if (goal.iteration >= goal.maxTurns)
      return this.pauseGoal(run,
        `Goal turn budget reached after ${goal.iteration} turns; run /goal resume ${run.id} to authorize ${run.config.maxTaskIterations} more turns.`);
    return this.launchBridge(run, {
      kind: OPERATION_KIND.IMPLEMENTATION,
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: goalPrompt(run, {
        lastOutcome: goal.lastOutcome,
        ...(goal.lastCheck?.failures ? { checkFailure: goal.lastCheck.failures } : {}),
        recentCommits: await this.recentGoalCommits(run),
      }),
    });
  }
  private async recentGoalCommits(run: PlanExecRun): Promise<string | undefined> {
    const base = run.outputTarget?.initialHead;
    if (!base) return undefined;
    const log = await gitValue(this.runCommand, run.worktreeCwd, ["log", "--oneline", "--no-decorate", `${base}..HEAD`]);
    return log.trim() || undefined;
  }

  private async finishGoal(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    terminalError?: string,
    output?: string,
  ): Promise<PlanExecRun> {
    if (!isGoalRun(run)) throw new Error("finishGoal requires a goal run.");
    const goal = run.goal;
    const outcome = parseGoalOutcome(output);
    if (outcome.kind === GOAL_OUTCOME.BLOCKED || (outcome.kind === GOAL_OUTCOME.CONTINUE && !isSuccessfulOperationState(state)))
      return this.pauseGoal(run, outcome.reason ?? terminalError ?? `Goal turn ended as ${state}.`);
    const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    const failure = await this.goalCheckFailure(run, operation);
    const fingerprint = failure?.fingerprint ?? "pass";
    const progressed = goal.lastCheck === undefined || head !== goal.lastCheck.head || fingerprint !== goal.lastCheck.fingerprint;
    const noProgress = progressed ? 0 : goal.noProgress + 1;
    const nextGoal = {
      ...goal,
      noProgress,
      lastOutcome: outcome.kind === GOAL_OUTCOME.DONE && failure
        ? `Worker reported the goal achieved, but required checks failed: ${failure.text}\n${outcome.summary}`
        : outcome.summary,
      lastCheck: { fingerprint, failures: failure?.text ?? "", head, at: Date.now() },
    };
    if (noProgress >= GOAL_NO_PROGRESS_LIMIT)
      return this.pauseGoal({ ...run, goal: nextGoal },
        `No progress after ${noProgress} goal turns: HEAD is unchanged and the required checks produced the same result.`);
    if (outcome.kind === GOAL_OUTCOME.DONE && !failure) {
      const violation = await this.goalCompletionGuard(run);
      if (violation) return this.pauseGoal({ ...run, goal: nextGoal }, violation);
      const advanced = await this.registry.updateIfCurrent(clearError(withoutOperation({
        ...run, goal: nextGoal, nextAttemptAt: 0,
        wakeReason: `Goal achieved after ${goal.iteration} turns.`,
      })), run.updatedAt);
      if (!advanced.applied) return advanced.run;
      return run.config.reviewEnabled || run.config.reviewRequired
        ? this.transition(advanced.run, RUN_STAGE.COMPREHENSIVE_REVIEW, "Goal achieved; starting required review.")
        : this.transition(advanced.run, RUN_STAGE.FINALIZE, "Goal achieved; final verification required.");
    }
    const scheduled = await this.registry.updateIfCurrent(withoutOperation({
      ...run,
      goal: nextGoal,
      nextAttemptAt: Date.now() + run.config.retryDelayMs,
      wakeReason: failure ? `Goal checks failing: ${failure.text}` : "Goal turn completed; continuing.",
    }), run.updatedAt);
    if (scheduled.applied)
      await appendProgressBestEffort(scheduled.run,
        `Goal turn ${goal.iteration} ${outcome.kind}: ${nextGoal.lastOutcome ?? ""}`.trim());
    return scheduled.run;
  }

  /** Run the required checks for one goal turn; a cancelled check aborts the run. */
  private async goalCheckFailure(run: PlanExecRun, operation: ActiveOperation): Promise<{ text: string; fingerprint: string } | undefined> {
    const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    const commands = run.config.requiredChecks.map((command) => command.join(" "));
    const operationId = `goal:check:${run.goal?.iteration ?? 0}:${operation.operationId}`;
    try {
      await this.executeLocalCommands(run.worktreeCwd, run.config.requiredChecks,
        await this.localOptions(run, operationId, head));
      return undefined;
    } catch (error: unknown) {
      if (error instanceof LocalOperationUnknownError || error instanceof LocalOperationCancelledError) throw error;
      const details = error instanceof LocalOperationFailedError ? error.details : undefined;
      const output = (details?.outputTail ?? "").replace(/\s+/gu, " ").trim().slice(0, GOAL_CHECK_OUTPUT_LIMIT);
      const text = [
        `checks: ${commands.join(" · ")}`,
        `exit: ${details?.code ?? "unknown"}`,
        output ? `output: ${output}` : `error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n");
      const fingerprint = `fail:${details?.code ?? "unknown"}:${createHash("sha256")
        .update(`${commands.join("\n")}\n${output || (error instanceof Error ? error.message : String(error))}`)
        .digest("hex").slice(0, GOAL_FINGERPRINT_LENGTH)}`;
      return { text, fingerprint };
    }
  }

  /** A goal is not complete when its diff deletes tests or disables them. */
  private async goalCompletionGuard(run: PlanExecRun): Promise<string | undefined> {
    const base = run.outputTarget?.initialHead;
    if (!base) return undefined;
    const diff = await this.runCommand("git", ["diff", "--name-status", "-z", "--no-relative", base, "HEAD"], run.worktreeCwd);
    if (diff.code !== 0) return "Cannot verify the goal diff before completion.";
    const fields = diff.stdout.split("\0").filter(Boolean);
    const deletedTests: string[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++] ?? "";
      const first = fields[index++] ?? "";
      const kind = status[0];
      if (kind === "R" || kind === "C") {
        const second = fields[index++] ?? "";
        if (kind === "R" && isTestPath(first) && !isTestPath(second)) deletedTests.push(first);
      } else if (kind === "D" && isTestPath(first)) deletedTests.push(first);
    }
    if (deletedTests.length)
      return `Goal completion deleted test files: ${deletedTests.join(", ")}. Restore or justify them, then resume.`;
    const added = await this.runCommand("git", ["diff", "-U0", "--no-relative", base, "HEAD"], run.worktreeCwd);
    if (added.code !== 0) return "Cannot verify the goal diff before completion.";
    const disabled = added.stdout.split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .filter((line) => /(?:\.(?:skip|only)\s*\(|\b(?:xit|fit)\s*\()/u.test(line));
    if (disabled.length)
      return `Goal completion disables tests: ${disabled.slice(0, GOAL_DISABLED_SAMPLE_LIMIT).map((line) => line.slice(1).trim()).join(" | ")}. Restore them, then resume.`;
    return undefined;
  }

  private async pauseGoal(run: PlanExecRun, reason: string): Promise<PlanExecRun> {
    const paused = await this.registry.updateIfCurrent(withoutOperation({
      ...run,
      status: RUN_STATUS.PAUSED,
      blocked: { reason },
      nextAttemptAt: 0,
      wakeReason: reason,
      error: reason,
      needsAttention: true,
    }), run.updatedAt);
    if (paused.applied) await appendProgressBestEffort(paused.run, `Goal paused: ${reason}`);
    return paused.run;
  }

  private async launchReview(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.config.reviewEnabled && !run.config.reviewRequired)
      return this.transition(run, RUN_STAGE.FINALIZE, "Optional review disabled by configuration.");
    if (run.config.reviewBackend !== "subagent") return this.launchFusion(run);
    const iteration = (run.stageAttempts[run.stage] ?? 0) + 1;
    const updated = {
      ...run,
      stageAttempts: { ...run.stageAttempts, [run.stage]: iteration },
    };
    return this.launchBridge(updated, {
      kind: OPERATION_KIND.REVIEW,
      reviewIteration: iteration,
      agent: updated.config.reviewerAgent,
      maxTurns: updated.config.reviewerMaxTurns,
      task: reviewerPrompt(updated),
    });
  }

  private async promoteAcceptedOutput(run: PlanExecRun, candidate: string): Promise<PlanExecRun | undefined> {
    const target = run.outputTarget;
    if (!target || target.cwd === run.worktreeCwd) return undefined;
    if (run.config.reviewRequired && run.reviewedCommit !== candidate) return this.fail(run, "Output promotion requires review of the current candidate.");
    if (!run.outputPromotion || run.outputPromotion.candidate !== candidate) {
      return this.registry.update({ ...run, outputPromotion: { candidate, state: "pending" } });
    }
    try {
      if (!run.outputPromotion?.commandStarted) {
        await verifyExecutionTree(this.runCommand, target.cwd, run.repositoryRoot, target.branch);
        const current = await gitValue(this.runCommand, target.cwd, ["rev-parse", "HEAD"]);
        const knownHeads = new Set([target.initialHead, candidate,
          ...Object.values(run.tasks ?? {}).flatMap((task) => [task.acceptedCommit, task.recoverySource?.checkpointCommit,
            ...(task.recoveryHistory ?? []).map((source) => source.checkpointCommit)].filter((commit): commit is string => Boolean(commit)))]);
        if (!knownHeads.has(current)) throw new Error("Original output branch changed outside accepted task commits; refusing to overwrite it.");
        await gitValue(this.runCommand, target.cwd, ["merge-base", "--is-ancestor", current, candidate]);
        const dirty = await worktreeChanges(this.runCommand, target.cwd);
        const targetRoot = await gitCheckoutRoot(this.runCommand, target.cwd);
        const progress = target.progressRelativePath === undefined ? undefined
          : gitPath(relative(targetRoot, join(target.cwd, target.progressRelativePath)));
        if (dirty.some((path) => path !== progress))
          throw new Error("Original output worktree has preserved or user changes; waiting for a safe fast-forward without resetting them.");
        const intended = await this.registry.updateIfCurrent({ ...run, outputPromotion: { ...run.outputPromotion!, commandStarted: true } }, run.updatedAt);
        if (!intended.applied) return intended.run;
        run = intended.run;
      }
      await this.executeLocalCommands(target.cwd, [["git", "merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", candidate]],
        await this.localOptions(run, `git:promote:${candidate}:${run.outputPromotion?.attempt ?? 0}`, candidate));
      await verifyExecutionTree(this.runCommand, target.cwd, run.repositoryRoot, target.branch);
      if (await gitValue(this.runCommand, target.cwd, ["rev-parse", "HEAD"]) !== candidate)
        throw new Error("Original output branch does not match the retired promotion candidate.");
      const promoted = await this.registry.updateIfCurrent({ ...run,
        worktreeCwd: target.cwd, branch: target.branch, planPath: join(target.cwd, target.planRelativePath),
        ...(target.progressRelativePath ? { progressPath: join(target.cwd, target.progressRelativePath) } : {}),
        outputPromotion: { ...run.outputPromotion!, candidate, state: "complete" }, nextAttemptAt: 0,
      }, run.updatedAt);
      return promoted.run;
    } catch (error) {
      return this.fail(error instanceof LocalOperationFailedError ? { ...run, outputPromotion: { ...run.outputPromotion!,
        attempt: (run.outputPromotion?.attempt ?? 0) + 1, commandStarted: false } } : run,
      `Output promotion: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async prepareLane(run: PlanExecRun): Promise<PlanExecRun> {
    assertPlanRun(run);
    if (run.status === RUN_STATUS.STARTING) return this.registry.update({ ...run, status: RUN_STATUS.RUNNING });
    const preparation = run.lanePreparation!;
    try {
      const sourceRoot = preparation.taskId === 0 ? run.worktreeCwd
        : await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
      const workerCwd = join(preparation.cwd, relative(sourceRoot, run.worktreeCwd));
      const planPath = join(preparation.cwd, relative(sourceRoot, run.planPath));
      if (preparation.state === "create") {
        await this.executeLocalCommands(run.repositoryRoot,
          [["git", "worktree", "add", "-b", preparation.branch, preparation.cwd, preparation.baselineCommit]],
          await this.localOptions(run, `git:worktree:${preparation.cwd}`, preparation.baselineCommit));
        await verifyExecutionTree(this.runCommand, preparation.cwd, run.repositoryRoot, preparation.branch);
        const head = await gitValue(this.runCommand, preparation.cwd, ["rev-parse", "HEAD"]);
        if (head !== preparation.baselineCommit) throw new Error("Lane creation found an unexpected HEAD; refusing to reuse it.");
        const pending = await this.publishLanePlan(run, preparation.cwd, preparation.baselineCommit, planPath);
        if (pending) return pending;
        if (preparation.publication?.planHash !== run.planHash)
          throw new LocalOperationFailedError("Plan publication retired under an earlier approval; a fresh lane is required.");
        return (await this.registry.updateIfCurrent({ ...run, lanePreparation: { ...preparation, state: "bootstrap" } }, run.updatedAt)).run;
      }
      await this.executeLocalCommands(workerCwd, await bootstrapCommands(workerCwd, run.config.bootstrapCommands),
        await this.localOptions(run, `bootstrap:${preparation.cwd}:${preparation.nextAttemptAt ?? 0}`));
      const task = run.tasks?.[String(preparation.taskId)];
      if (!task && preparation.taskId !== 0) throw new Error("Lane preparation lost its task.");
      const prepared = { ...run,
        worktreeCwd: workerCwd, branch: preparation.branch,
        planPath,
        ...(run.progressPath ? { progressPath: join(preparation.cwd, relative(sourceRoot, run.progressPath)) } : {}),
        ...(task ? { tasks: { ...run.tasks, [String(task.taskId)]: { ...task, laneCwd: workerCwd,
          laneBranch: preparation.branch, baselineCommit: preparation.baselineCommit } } } : {}),
        nextAttemptAt: 0,
      };
      delete prepared.lanePreparation;
      return (await this.registry.updateIfCurrent(prepared, run.updatedAt)).run;
    } catch (error) {
      if (error instanceof LocalOperationFailedError && preparation.state === "create") {
        const token = randomUUID().slice(0, LANE_TOKEN_LENGTH);
        const cwd = join(dirname(preparation.cwd), `plan-exec-${run.id}-${token}`);
        const branch = `plan-exec/${run.id}/${token}`;
        const initial = preparation.taskId === 0;
        const fresh = { ...preparation, cwd, branch };
        delete fresh.publication;
        return this.fail({ ...run, lanePreparation: fresh,
          ...(initial ? { worktreeCwd: cwd, branch, planPath: join(cwd, relative(run.worktreeCwd, run.planPath)),
            ...(run.outputTarget ? { outputTarget: { ...run.outputTarget, cwd, branch } } : {}) } : {}),
        }, `Lane preparation failed after confirmed exit; preserved ${preparation.cwd} and scheduled a fresh lane: ${error.message}`);
      }
      return this.fail(error instanceof LocalOperationFailedError ? { ...run,
        lanePreparation: { ...preparation, nextAttemptAt: Math.max((preparation.nextAttemptAt ?? 0) + 1, Date.now() + run.config.retryDelayMs) } } : run,
      `Lane preparation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async planBaseline(run: PlanExecRun, cwd: string, commit: string, planPath: string) {
    const checkoutRoot = await gitCheckoutRoot(this.runCommand, cwd);
    const relativePlanPath = gitPath(relative(checkoutRoot, planPath));
    const tracked = await gitValue(this.runCommand, checkoutRoot, ["ls-tree", "--name-only", commit, "--", relativePlanPath]);
    let committed: string | undefined;
    if (tracked) {
      const result = await this.runCommand("git", ["show", `${commit}:${relativePlanPath}`], checkoutRoot);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "Unable to read the committed baseline plan.");
      committed = result.stdout;
    }
    const facts = commit === run.outputTarget?.initialHead && run.initialPlan
      ? run.initialPlan.content : committed;
    return { committed, facts };
  }

  private async publishLanePlan(run: PlanExecRun, cwd: string, baselineCommit: string, planPath: string): Promise<PlanExecRun | undefined> {
    assertPlanRun(run);
    const options = await this.localOptions(run, `plan:publish:${cwd}`, baselineCommit);
    const directory = join(options.journalRoot, "plan-payloads", run.id);
    const publication = run.lanePreparation!.publication;
    if (publication) {
      await this.executeLocalCommands(cwd,
        [[process.execPath, fileURLToPath(new URL("./plan-publisher.mjs", import.meta.url)),
          join(directory, `${publication.digest}.json`), publication.digest]], options);
      return undefined;
    }
    const authorized = run.approvedPlan ?? run.initialPlan;
    if (!authorized) {
      const content = await readFile(run.lanePreparation!.sourcePlanPath ?? run.planPath, "utf8");
      if (parsePlan(planPath, content).hash !== run.planHash) return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
      const { facts } = await this.planBaseline(run, cwd, baselineCommit, planPath);
      const materialized = materializeApprovedPlan(planPath, content, facts);
      return (await this.registry.updateIfCurrent({ ...run,
        initialPlan: { hash: run.planHash, content: materialized },
        tasks: reconcileTaskFacts(parsePlan(planPath, materialized), run.tasks),
      }, run.updatedAt)).run;
    }
    if (authorized.hash !== run.planHash) return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
    const { committed, facts } = await this.planBaseline(run, cwd, baselineCommit, planPath);
    const payload = { cwd, path: planPath, expectedContent: committed ?? null,
      content: run.lanePreparation!.taskId === 0 && !run.approvedPlan ? authorized.content
        : materializeApprovedPlan(planPath, authorized.content, facts) };
    const serialized = JSON.stringify(payload);
    const digest = createHash("sha256").update(serialized).digest("hex");
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const payloadPath = join(directory, `${digest}.json`);
    try {
      if (await readFile(payloadPath, "utf8") !== serialized) throw new Error("Approved plan publication payload changed.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await durableJson(payloadPath, payload);
    }
    return (await this.registry.updateIfCurrent({ ...run,
      lanePreparation: { ...run.lanePreparation!, publication: { planHash: authorized.hash, digest } },
    }, run.updatedAt)).run;
  }

  private async verifyCandidate(run: PlanExecRun, candidate: string): Promise<void> {
    if (run.acceptedHead) await gitValue(this.runCommand, run.worktreeCwd, ["merge-base", "--is-ancestor", run.acceptedHead, candidate]);
    const finalizationAttempt = run.stage === RUN_STAGE.FINALIZE && !run.activeOperation ? run.stageAttempts[RUN_STAGE.FINALIZE] ?? 0 : 0;
    const operationId = `verify:${candidate}:${run.activeOperation?.operationId ?? run.stage}${finalizationAttempt ? `:retry-${finalizationAttempt}` : ""}`;
    await this.executeLocalCommands(run.worktreeCwd, run.config.requiredChecks,
      await this.localOptions(run, operationId, candidate));
    const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    if (head !== candidate) throw new Error("HEAD changed while verifying the candidate.");
    const dirty = await worktreeChanges(this.runCommand, run.worktreeCwd);
    const checkoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
    const progress = run.progressPath ? gitPath(relative(checkoutRoot, run.progressPath)) : undefined;
    if (dirty.some((path) => path !== progress))
      throw new Error("Candidate has uncommitted source changes after verification.");
  }

  private async localOptions(run: PlanExecRun, operationId: string, candidate?: string): Promise<LocalOperationOptions> {
    const commonDir = await gitValue(this.runCommand, run.repositoryRoot, ["rev-parse", "--git-common-dir"]);
    return { journalRoot: join(resolve(run.repositoryRoot, commonDir), "plan-exec-local"), runId: run.id, operationId,
      activeDirectory: this.registry.localOperationsPath(run.id),
      authorization: { path: this.registry.authorizationPath(run.id), stopGeneration: run.stopGeneration ?? 0 },
      ...(candidate ? { candidate } : {}),
      isAuthorized: async () => {
        const current = await this.registry.get(run.id);
        return current?.status === RUN_STATUS.RUNNING && !current.userStopped &&
          (current.stopGeneration ?? 0) === (run.stopGeneration ?? 0);
      },
    };
  }

  private async launchFusion(run: PlanExecRun): Promise<PlanExecRun> {
    const lifetime = attemptExecutionLifetime(run, OPERATION_KIND.FUSION);
    const client = await this.reviewClient(run);
    const capabilities = await client.capabilities?.();
    if (!supportsExecution(capabilities, lifetime))
      return this.reviewFailure(run, `${run.config.reviewBackend} runtime does not support the requested explicit execution lifetime, durable lookup and process-tree proof.`);
    const iteration = (run.stageAttempts[RUN_STAGE.FUSION_REVIEW] ?? 0) + 1;
    const profile = run.config.reviewBackend === "revmux" ? run.config.revmuxProfile : run.config.fusionProfile;
    const operationId = randomUUID();
    const launchStartedAt = Date.now();
    const params = {
      prompt: boundedContinuationPrompt(run, OPERATION_KIND.FUSION, fusionPrompt(run), lifetime), backend: run.config.reviewBackend,
      cwd: run.worktreeCwd,
      executionLifetime: lifetime,
      reviewedCommit: await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]),
      ...(profile ? { profile } : {}),
    };
    const persisted = await this.registry.updateIfCurrent(
      {
        ...run,
        stageAttempts: {
          ...run.stageAttempts,
          [RUN_STAGE.FUSION_REVIEW]: iteration,
        },
        activeOperation: {
          operationId,
          service: OPERATION_SERVICE.FUSION,
          kind: OPERATION_KIND.FUSION,
          reviewIteration: iteration,
          launchStartedAt,
          recovery: OPERATION_RECOVERY.REPLAY,
          expectedLifetime: lifetime,
          params,
          requestDigest: bridgeRequestDigest(params),
        },
      },
      run.updatedAt,
    );
    if (!persisted.applied) return persisted.run;
    const intended = persisted.run;
    const reply = await (await this.reviewClient(intended)).start(
      operationId,
      text(intended.activeOperation?.params?.prompt) ?? fusionPrompt(intended),
      text(intended.activeOperation?.params?.profile),
      lifetime,
      intended.activeOperation?.requestDigest,
      { cwd: params.cwd, reviewedCommit: params.reviewedCommit },
    );
    if (!reply.success)
      return this.fail(intended, reply.error.message, true);
    if (reply.data.requestDigest !== intended.activeOperation?.requestDigest)
      return this.failUnknownLaunch(intended, intended.activeOperation, "Review backend did not attest the immutable request digest.");
    if (!sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), lifetime))
      return this.failUnknownLaunch(intended, intended.activeOperation, "Fusion did not attest the effective execution lifetime.");
    const state = fusionState(reply.data);
    if (!state)
      return this.fail(intended, "Fusion launch outcome requires reconciliation.", true);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId: state.runId,
      recovery: OPERATION_RECOVERY.OBSERVE,
      effectiveLifetime: lifetime,
    });
  }

  private async reviewFailure(run: PlanExecRun, reason: string): Promise<PlanExecRun> {
    const fallback = run.config.reviewFallback.find((backend) => backend !== run.config.reviewBackend);
    if (!fallback) return this.fail(run, reason);
    await appendProgressBestEffort(run, `Explicit review fallback policy selected ${fallback}: ${reason}`);
    return this.fail({ ...withoutOperation(run), config: { ...run.config, reviewBackend: fallback,
      reviewFallback: run.config.reviewFallback.filter((backend) => backend !== fallback && backend !== run.config.reviewBackend) } }, reason);
  }

  private async reviewClient(run: PlanExecRun): Promise<FusionLike> {
    if ((run.activeOperation?.params?.backend ?? run.config.reviewBackend) !== "revmux") return this.fusion;
    const commonDir = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "--git-common-dir"]);
    return new RevmuxReviewClient({ cwd: text(run.activeOperation?.params?.cwd) ?? run.worktreeCwd,
      stateDirectory: join(resolve(run.worktreeCwd, commonDir), "plan-exec-review", run.id),
      reviewedCommit: text(run.activeOperation?.params?.reviewedCommit) ?? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]),
      ...(run.config.revmuxExecutable ? { executable: run.config.revmuxExecutable } : {}),
    });
  }

  private async launchFinalizer(run: PlanExecRun): Promise<PlanExecRun> {
    const candidate = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    const promoted = await this.promoteAcceptedOutput(run, candidate);
    if (promoted) return promoted;
    try { await this.verifyCandidate(run, candidate); }
    catch (error) {
      if (!(error instanceof LocalOperationFailedError)) throw error;
      return this.fail({ ...run, stageAttempts: { ...run.stageAttempts,
        [RUN_STAGE.FINALIZE]: (run.stageAttempts[RUN_STAGE.FINALIZE] ?? 0) + 1,
      } }, `Final verification failed after confirmed command exit: ${error.message}`);
    }
    return this.transition({ ...run, verifiedCommit: candidate }, RUN_STAGE.STATS, "Final verification passed for the reviewed candidate.");
  }

  private launchStats(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.config.statsEnabled) return this.finishStats(run);
    return this.launchBridge(run, {
      kind: OPERATION_KIND.STATS,
      agent: run.config.statsAgent,
      maxTurns: run.config.statsMaxTurns,
      task: statsPrompt(run),
    });
  }

  private async finishStats(run: PlanExecRun, error?: string, report?: string): Promise<PlanExecRun> {
    const tasks = Object.values(run.tasks ?? {});
    const summary = [
      `${tasks.filter((task) => task.state === "accepted").length}/${tasks.length} tasks accepted`,
      `${Object.values(run.taskAttempts).reduce((total, attempts) => total + attempts, 0)} attempts`,
      `input tokens: ${run.usage?.inputTokens ?? "unavailable"}`,
      `output tokens: ${run.usage?.outputTokens ?? "unavailable"}`,
      `cost: ${run.usage?.cost ?? "unavailable"}`,
    ].join("; ");
    const finished = await this.registry.updateIfCurrent(clearError(withoutOperation({
      ...run, stage: RUN_STAGE.ARCHIVE, nextAttemptAt: 0, recoveryAttempts: 0,
      statsReport: { state: error ? "unavailable" : report ? "reported" : "summary",
        summary: report ? `${summary}\n${report.slice(0, MAX_TERMINAL_ERROR_LENGTH)}` : summary,
        ...(error ? { error } : {}),
      },
    })), run.updatedAt);
    if (finished.applied) await appendProgressBestEffort(finished.run,
      error ? `Optional statistics report unavailable: ${error}\n${summary}` : summary);
    return finished.run;
  }

  private async launchBridge(
    run: PlanExecRun,
    input: {
      operationId?: string;
      kind: ActiveOperation["kind"];
      taskId?: number;
      reviewIteration?: number;
      agent: string;
      maxTurns: number;
      task: string;
    },
  ): Promise<PlanExecRun> {
    const lifetime = attemptExecutionLifetime(run, input.kind, input.taskId);
    const capabilities = await this.bridgeCapabilities();
    if (!supportsExecution(capabilities, lifetime) || capabilities?.singleAgentSpawn !== true) {
      const reason = "Bridge runtime does not support the requested explicit execution lifetime, durable lookup and process-tree proof.";
      if (input.taskId && run.tasks?.[String(input.taskId)]) {
        const prerequisite: ExternalPrerequisite = { kind: "runtime", source: "provider",
          evidence: `${reason} Capability probe: ${JSON.stringify(capabilities ?? "unavailable")}` };
        return this.registry.update({ ...run, nextAttemptAt: 0, needsAttention: true, wakeReason: prerequisite.evidence,
          tasks: { ...run.tasks, [String(input.taskId)]: { ...run.tasks[String(input.taskId)]!,
            state: "waiting_external", reason: prerequisite.evidence, externalPrerequisite: prerequisite,
            nextAttemptAt: Date.now() + run.config.retryDelayMs,
          } },
        });
      }
      return input.kind === OPERATION_KIND.STATS ? this.finishStats(run, reason) : this.fail(run, reason);
    }
    const operationId = input.operationId ?? randomUUID();
    const launchStartedAt = Date.now();
    const model = run.recoveryModel ?? bridgeModel(run.config, input.kind);
    const runWithoutRecoveryModel = withoutRecoveryModel(run);
    const reviewedCommit = input.kind === OPERATION_KIND.REVIEW
      ? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]) : undefined;
    const params = {
      agent: input.agent,
      ...(model ? { model } : {}),
      task: boundedContinuationPrompt(run, input.kind, reviewedCommit ? `${input.task}\nReview exactly commit ${reviewedCommit}.` : input.task, lifetime, input.taskId),
      cwd: run.worktreeCwd,
      worktree: false,
      context: "fresh",
      executionLifetime: lifetime,
      turnBudget: { maxTurns: input.maxTurns },
      acceptance: false,
      mission: false,
      // The plan's checkboxes prove implementation; legitimate blockers need no edits.
      ...(input.kind === OPERATION_KIND.FIX || input.kind === OPERATION_KIND.IMPLEMENTATION
        ? { completionGuard: false } : {}),
    };
    const requestDigest = bridgeRequestDigest(params);
    const persisted = await this.registry.updateIfCurrent(
      {
        ...runWithoutRecoveryModel,
        status:
          run.status === RUN_STATUS.SKIP_PENDING
            ? RUN_STATUS.SKIP_PENDING
            : RUN_STATUS.RUNNING,
        activeOperation: {
          operationId,
          service: OPERATION_SERVICE.BRIDGE,
          kind: input.kind,
          params,
          requestDigest,
          ...(reviewedCommit ? { reviewedCommit } : {}),
          launchStartedAt,
          recovery: OPERATION_RECOVERY.REPLAY,
          stopGeneration: run.stopGeneration ?? 0,
          expectedLifetime: lifetime,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.reviewIteration
            ? { reviewIteration: input.reviewIteration }
            : {}),
        },
        ...(input.taskId && run.tasks?.[String(input.taskId)] ? { tasks: { ...run.tasks,
          [String(input.taskId)]: { ...run.tasks[String(input.taskId)]!, state: "running", operationId,
            attempts: run.tasks[String(input.taskId)]!.attempts + 1 } } } : {}),
        ...(isGoalRun(run)
          ? { goal: { ...run.goal, iteration: run.goal.iteration + 1 } }
          : {}),
        ...(input.kind === OPERATION_KIND.FIX && run.reviewRecovery ? {
          reviewRecovery: { ...run.reviewRecovery, pendingFix: false },
        } : {}),
      },
      run.updatedAt,
    );
    if (!persisted.applied) return persisted.run;
    const intended = persisted.run;
    const owner = bridgeOperationOwner(intended, intended.activeOperation);
    const reply = await this.bridge.spawn(operationId, params, owner);
    if (!reply.success) return this.fail(intended, reply.error.message, true);
    if (!sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), lifetime))
      return this.failUnknownLaunch(intended, intended.activeOperation, "Bridge did not attest the effective execution lifetime.");
    const replyDigest = text(reply.data.requestDigest);
    if (
      capabilities?.protocolVersion === 2 &&
      (!replyDigest || replyDigest !== requestDigest)
    )
      return this.failUnknownLaunch(
        intended,
        intended.activeOperation,
        "Bridge spawn omitted or mismatched its request digest.",
      );
    if (replyDigest && replyDigest !== requestDigest)
      return this.failUnknownLaunch(
        intended,
        intended.activeOperation,
        "Bridge spawn returned a mismatched request digest.",
      );
    const externalRunId = text(reply.data.runId);
    if (!externalRunId)
      return this.fail(intended, "Bridge spawn returned no run ID.", true);
    const asyncDir = text(reply.data.asyncDir);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId,
      effectiveLifetime: lifetime,
      recovery: OPERATION_RECOVERY.OBSERVE,
      ...(asyncDir ? { asyncDir } : {}),
    });
  }

  private async recoverActiveOperation(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<PlanExecRun> {
    if (
      operation.launchStartedAt !== undefined &&
      Date.now() - operation.launchStartedAt < OPERATION_RECOVERY_DELAY_MS
    )
      return run;
    if (operation.service === OPERATION_SERVICE.BRIDGE) {
      const capabilities = await this.bridgeCapabilities();
      const owner = bridgeOperationOwner(run, operation);
      const lookup = await this.bridge.operation(operation.operationId, owner);
      if (!lookup.success)
        return this.failUnknownLaunch(
          run,
          operation,
          `Unable to look up bridge operation: ${lookup.error.message}`,
        );
      const lookupState = text(lookup.data.state);
      const lookupDigest = text(lookup.data.requestDigest);
      if (
        capabilities?.protocolVersion === 2 &&
        (!owner || lookupDigest !== owner.requestDigest)
      )
        return this.failUnknownLaunch(
          run,
          operation,
          "Bridge operation lookup did not match the persisted request digest.",
        );
      if (isFencedCancellation(lookup.data, operation)) {
        const fenced = await this.updateActiveOperation(run, operation.operationId, { launchFenced: true, stopRequested: true, stopAcknowledged: true });
        if (fenced.status === RUN_STATUS.CANCEL_PENDING) return this.cancel(fenced);
        if (fenced.status === RUN_STATUS.PAUSED || fenced.userStopped) return fenced;
        return this.recoverFencedOperation(fenced);
      }
      if (isBoundNeverStarted(lookup.data, operation))
        return this.fenceRejectedLaunch(run, operation, lookup.data);
      if (lookupState === EXTERNAL_OPERATION_STATE.FOUND) {
        const expectedLifetime = operationExpectedLifetime(operation);
        if (!expectedLifetime || !sameLifetime(parseExecutionLifetime(lookup.data.effectiveExecutionLifetime), expectedLifetime))
          return this.failUnknownLaunch(run, operation, "Recovered Bridge operation does not attest the requested execution lifetime.");
        const externalRunId = text(lookup.data.runId);
        if (!externalRunId)
          return this.failUnknownLaunch(
            run,
            operation,
            "Bridge operation lookup omitted a run ID.",
          );
        const asyncDir = text(lookup.data.asyncDir);
        return this.updateActiveOperation(run, operation.operationId, {
          externalRunId,
          recovery: OPERATION_RECOVERY.OBSERVE,
          expectedLifetime,
          effectiveLifetime: expectedLifetime,
          ...(owner ? { requestDigest: owner.requestDigest } : {}),
          ...(asyncDir ? { asyncDir } : {}),
        });
      }
      if (lookupState === EXTERNAL_OPERATION_STATE.PENDING) return run;
      if (lookupState === EXTERNAL_OPERATION_STATE.ABSENT) {
        if (
          capabilities?.protocolVersion === 2 &&
          capabilities.healthy &&
          capabilities.durableOperationLookup &&
          owner
        ) {
          if (run.status === RUN_STATUS.CANCEL_PENDING || run.status === RUN_STATUS.SKIP_PENDING) {
            return this.failUnknownLaunch(run, operation, "An empty lookup does not fence delayed dispatch; the original cancellation must be confirmed.");
          }
          return this.replayAbsentBridgeOperation(
            run,
            operation,
            owner,
          );
        }
        return this.failUnknownLaunch(
          run,
          operation,
          "Bridge launch outcome is unknown; v1 absence is not terminal proof, so refusing to launch a possible duplicate worker.",
        );
      }
      if (lookupState === EXTERNAL_OPERATION_STATE.UNKNOWN)
        return this.failUnknownLaunch(
          run,
          operation,
          "Bridge operation lookup is unresolved; retry /exec resume after the provider recovers.",
        );
      return this.failUnknownLaunch(
        run,
        operation,
        "Bridge operation lookup returned an invalid state.",
      );
    }

    const client = await this.reviewClient(run);
    const reply = await client.status(undefined, operation.operationId);
    if (!reply.success)
      return this.failUnknownLaunch(run, operation, reply.error.message);
    if (isFencedReviewCancellation(reply.data, operation)) {
      const cleared = withoutOperation(run);
      return run.status === RUN_STATUS.CANCEL_PENDING
        ? this.registry.update({ ...cleared, status: RUN_STATUS.CANCELLED })
        : this.fail(cleared, "Review launch was durably fenced before dispatch; scheduling a fresh operation.");
    }
    if (reply.data.state === EXTERNAL_OPERATION_STATE.ABSENT && reply.data.replaySafe === true && reply.data.operationId === operation.operationId) {
      if (run.status !== RUN_STATUS.RUNNING || run.userStopped)
        return this.failUnknownLaunch(run, operation, "An undispatched review remains fenced by the user's stop or pause.");
      const capabilities = await client.capabilities?.();
      const params = operation.params;
      const lifetime = parseExecutionLifetime(params?.executionLifetime);
      const expectedLifetime = operationExpectedLifetime(operation);
      if (!lifetime || !expectedLifetime || !sameLifetime(lifetime, expectedLifetime) || !supportsExecution(capabilities, lifetime) || !params ||
        !operation.requestDigest || operation.requestDigest !== bridgeRequestDigest(params) || !text(params.prompt) ||
        !text(params.cwd) || !isAbsolute(text(params.cwd)!) || !text(params.reviewedCommit))
        return this.failUnknownLaunch(run, operation, "Review replay lacks a supported runtime or matching immutable intent.");
      const latest = (await this.registry.get(run.id)) ?? run;
      if (!sameOperationState(run, latest, operation) || latest.userStopped || (latest.stopGeneration ?? 0) !== (run.stopGeneration ?? 0)) return latest;
      const replay = await client.start(operation.operationId, text(params.prompt)!, text(params.profile), lifetime, operation.requestDigest,
        { cwd: text(params.cwd)!, reviewedCommit: text(params.reviewedCommit)! });
      if (!replay.success) return this.failUnknownLaunch(latest, operation, replay.error.message);
      if (replay.data.requestDigest !== operation.requestDigest || !sameLifetime(parseExecutionLifetime(replay.data.effectiveExecutionLifetime), lifetime))
        return this.failUnknownLaunch(latest, operation, "Replayed review did not attest its original digest and lifetime.");
      const replayed = fusionState(replay.data);
      if (!replayed) return this.failUnknownLaunch(latest, operation, "Review replay returned no durable run identity.");
      return this.updateActiveOperation(latest, operation.operationId, { externalRunId: replayed.runId, recovery: OPERATION_RECOVERY.OBSERVE,
        expectedLifetime, effectiveLifetime: lifetime });
    }
    if (operation.requestDigest && reply.data.requestDigest !== operation.requestDigest)
      return this.failUnknownLaunch(run, operation, "Review lookup returned a different request digest.");
    const expectedLifetime = operationExpectedLifetime(operation);
    if (!expectedLifetime || !sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), expectedLifetime))
      return this.failUnknownLaunch(run, operation, "Review lookup did not attest the original execution lifetime.");
    const state = fusionState(reply.data);
    if (!state)
      return this.failUnknownLaunch(run, operation, "Fusion lookup did not prove an adoptable operation; retaining ownership.");
    return this.updateActiveOperation(run, operation.operationId, {
      externalRunId: state.runId,
      recovery: OPERATION_RECOVERY.OBSERVE,
      expectedLifetime,
      effectiveLifetime: expectedLifetime,
    });
  }

  private async bridgeCapabilities(): Promise<
    BridgeCapabilities | undefined
  > {
    try {
      return await this.bridge.capabilities?.();
    } catch {
      return undefined;
    }
  }

  private async replayAbsentBridgeOperation(
    run: PlanExecRun,
    operation: ActiveOperation,
    owner: BridgeOperationOwner,
  ): Promise<PlanExecRun> {
    if (!operation.params)
      return this.failUnknownLaunch(
        run,
        operation,
        "Bridge operation parameters are missing; refusing recovery launch.",
      );
    if (operation.params.mission !== false)
      return this.failUnknownLaunch(
        run,
        operation,
        "Bridge recovery parameters lack mission:false; refusing recovery launch.",
      );
    const expectedLifetime = operationExpectedLifetime(operation);
    const capabilities = await this.bridgeCapabilities();
    if (!expectedLifetime || !sameLifetime(parseExecutionLifetime(operation.params.executionLifetime), expectedLifetime) ||
      !supportsExecution(capabilities, expectedLifetime) || capabilities?.singleAgentSpawn !== true)
      return this.failUnknownLaunch(run, operation, "Bridge recovery lacks its original supported execution lifetime.");
    const reply = await this.bridge.spawn(
      operation.operationId,
      operation.params,
      owner,
    );
    if (!reply.success)
      return this.failUnknownLaunch(run, operation, reply.error.message);
    if (!sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), expectedLifetime))
      return this.failUnknownLaunch(run, operation, "Bridge recovery did not attest the effective execution lifetime.");
    const replyDigest = text(reply.data.requestDigest);
    if (!replyDigest || replyDigest !== owner.requestDigest)
      return this.failUnknownLaunch(
        run,
        operation,
        "Bridge recovery spawn omitted or mismatched its request digest.",
      );
    const externalRunId = text(reply.data.runId);
    if (!externalRunId)
      return this.failUnknownLaunch(
        run,
        operation,
        "Bridge recovery spawn returned no run ID.",
      );
    const asyncDir = text(reply.data.asyncDir);
    return this.updateActiveOperation(run, operation.operationId, {
      externalRunId,
      requestDigest: owner.requestDigest,
      recovery: OPERATION_RECOVERY.OBSERVE,
      expectedLifetime,
      effectiveLifetime: expectedLifetime,
      ...(asyncDir ? { asyncDir } : {}),
    });
  }

  private async failUnknownLaunch(
    run: PlanExecRun,
    operation: ActiveOperation | undefined,
    message: string,
  ): Promise<PlanExecRun> {
    const marked = operation
      ? await this.updateActiveOperation(run, operation.operationId, {
          recovery: OPERATION_RECOVERY.REQUIRED,
          lastObservedState: EXTERNAL_OPERATION_STATE.UNKNOWN_LAUNCH,
          lastStatusError: message,
        })
      : run;
    return this.fail(marked, message, true);
  }

  private async updateActiveOperation(
    run: PlanExecRun,
    operationId: string,
    patch: Partial<ActiveOperation>,
  ): Promise<PlanExecRun> {
    let current = (await this.registry.get(run.id)) ?? run;
    for (
      let attempt = 0;
      attempt < OPERATION_UPDATE_CAS_RETRIES;
      attempt += 1
    ) {
      if (current.activeOperation?.operationId !== operationId) return current;
      const updated = await this.registry.updateIfCurrent(
        {
          ...current,
          activeOperation: { ...current.activeOperation, ...patch },
        },
        current.updatedAt,
      );
      if (updated.applied) return updated.run;
      current = updated.run;
    }
    return current;
  }

  private async reconcileLocalCancellation(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.localOperationActive) return run;
    const result = await cancelActiveLocalOperations(this.registry.localOperationsPath(run.id), run.id, run.stopGeneration ?? 0);
    const current = (await this.registry.get(run.id)) ?? run;
    if (current.status !== run.status || current.stopGeneration !== run.stopGeneration) return current;
    const updated = { ...current };
    if (result.pending) {
      updated.localOperationActive = true;
      updated.nextAttemptAt = Date.now() + CONTROLLER_POLL_INTERVAL_MS;
      updated.wakeReason = result.reason ?? "Waiting for local command process-tree retirement.";
    } else {
      delete updated.localOperationActive;
      updated.nextAttemptAt = 0;
    }
    return (await this.registry.updateIfCurrent(updated, current.updatedAt)).run;
  }

  private async observePausedOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const original = run;
    run = await this.reconcileLocalCancellation(run);
    run = await this.requestOperationCancellation(run);
    if (run.status !== RUN_STATUS.PAUSED || run.stopGeneration !== original.stopGeneration) return run;
    const operation = run.activeOperation;
    if (!operation) return run;
    if (operation.launchFenced) return run;
    if (!operation.externalRunId) {
      const reply = operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridge.operation(operation.operationId, bridgeOperationOwner(run, operation))
        : await (await this.reviewClient(run)).status(undefined, operation.operationId);
      if (!reply.success) return this.recordObservationFailure(run, operation, reply.error.message);
      if (isFencedCancellation(reply.data, operation))
        return this.updateActiveOperation(run, operation.operationId, { launchFenced: true, stopAcknowledged: true });
      const runId = operation.service === OPERATION_SERVICE.BRIDGE ? text(reply.data.runId) : fusionState(reply.data)?.runId;
      if (!runId || (operation.service === OPERATION_SERVICE.BRIDGE &&
        (reply.data.state !== EXTERNAL_OPERATION_STATE.FOUND || reply.data.requestDigest !== operation.requestDigest)))
        return this.recordObservationFailure(run, operation, "Paused operation launch remains unresolved; no replacement is authorized.");
      const attached = await this.updateActiveOperation(run, operation.operationId, { externalRunId: runId, recovery: OPERATION_RECOVERY.OBSERVE });
      return this.requestOperationCancellation(attached);
    }
    const status =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridgeStatus(run, operation)
        : await (await this.reviewClient(run)).status(operation.externalRunId);
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    const observed = await this.recordObservation(
      run,
      operation,
      status.data.text,
      operation.service === OPERATION_SERVICE.BRIDGE ? text(status.data.state) : fusionState(status.data)?.phase,
      status.data.activity,
      status.data,
    );
    if (!sameOperationState(run, observed, operation)) return observed;
    const state =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? text(status.data.state)
        : fusionState(status.data)?.phase;
    if (state && hasProcessExit(status.data, operation))
      return this.updateActiveOperation(observed, operation.operationId, { processTreeExited: true, lastObservedState: state });
    if (
      !state ||
      state === EXTERNAL_OPERATION_STATE.RUNNING ||
      state === EXTERNAL_OPERATION_STATE.STOPPING ||
      state === EXTERNAL_OPERATION_STATE.CHAIN ||
      state === EXTERNAL_OPERATION_STATE.PANEL ||
      state === EXTERNAL_OPERATION_STATE.JUDGE
    ) {
      return observed;
    }
    await appendProgress(
      observed,
      `Paused after active ${operation.kind} operation reached ${state}; completion will be applied on resume.`,
    );
    return observed;
  }

  private async observeActiveOperation(run: PlanExecRun): Promise<PlanExecRun> {
    if (run.activeOperation?.stopRequested) {
      run = await this.requestOperationCancellation(run);
      if (run.status !== RUN_STATUS.RUNNING || run.userStopped) return run;
      if (run.activeOperation?.launchFenced) return this.recoverFencedOperation(run);
    }
    const operation = run.activeOperation;
    if (!operation) return this.fail(run, "Active operation is missing.");
    if (!operation.externalRunId)
      return this.recoverActiveOperation(run, operation);
    if (operation.service === OPERATION_SERVICE.FUSION)
      return this.observeFusion(run, operation);
    return this.observeBridge(run, operation);
  }

  private async requestOperationCancellation(run: PlanExecRun): Promise<PlanExecRun> {
    let operation = run.activeOperation;
    if (!operation || operation.stopAcknowledged || operation.launchFenced || operation.processTreeExited) return run;
    if (!operation.stopRequested) {
      const intended = await this.registry.updateIfCurrent({ ...run, activeOperation: { ...operation, stopRequested: true } }, run.updatedAt);
      if (!intended.applied) return intended.run;
      run = intended.run;
      operation = run.activeOperation!;
    }
    const latest = (await this.registry.get(run.id)) ?? run;
    if (!sameOperationState(run, latest, operation) || (latest.stopGeneration ?? 0) !== (run.stopGeneration ?? 0)) return latest;
    const owner = bridgeOperationOwner(run, operation);
    const reply = operation.service === OPERATION_SERVICE.BRIDGE
      ? this.bridge.cancelOperation && owner
        ? await this.bridge.cancelOperation(operation.operationId, owner)
        : operation.externalRunId ? await this.bridge.stop(operation.externalRunId, operation.asyncDir) : undefined
      : await (await this.reviewClient(run)).cancel(operation.externalRunId, operation.externalRunId ? undefined : operation.operationId);
    if (!reply?.success)
      return this.recordCancellationFailure(run, operation, reply?.error.message ?? "Cancellation is awaiting the original provider operation identity.");
    const fenced = isFencedCancellation(reply.data, operation);
    const current = (await this.registry.get(run.id)) ?? run;
    if (!sameOperationState(run, current, operation) || (current.stopGeneration ?? 0) !== (run.stopGeneration ?? 0)) return current;
    return (await this.registry.updateIfCurrent({ ...current, activeOperation: { ...current.activeOperation!,
      stopAcknowledged: true, ...(fenced ? { launchFenced: true } : {}),
    } }, current.updatedAt)).run;
  }

  private async recoverFencedOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation?.launchFenced) return run;
    const task = operation.taskId ? run.tasks?.[String(operation.taskId)] : undefined;
    const recoveryAttempts = (run.recoveryAttempts ?? 0) + 1;
    const retryAt = Date.now() + retryDelay(run.config.retryDelayMs, recoveryAttempts);
    const reason = operation.terminalError ?? "The original launch was fenced before dispatch; retrying the preserved task.";
    return (await this.registry.updateIfCurrent(withoutOperation({ ...run,
      nextAttemptAt: task ? 0 : retryAt, recoveryAttempts, wakeReason: reason, failedOperation: operation,
      ...(task ? { tasks: { ...run.tasks, [String(task.taskId)]: { ...task, state: "retry_wait",
        attempts: Math.max(task.attempts - 1, 0), nextAttemptAt: retryAt, reason } } } : {}),
    }), run.updatedAt)).run;
  }

  private async fenceRejectedLaunch(run: PlanExecRun, operation: ActiveOperation, data: Record<string, unknown>): Promise<PlanExecRun> {
    const rejected = await this.updateActiveOperation(run, operation.operationId, {
      terminalError: `Provider rejected the launch before dispatch: ${text(data.text) ?? "no child was started"}`.slice(0, MAX_TERMINAL_ERROR_LENGTH),
    });
    if (!sameOperationState(run, rejected, operation)) return rejected;
    const fenced = await this.requestOperationCancellation(rejected);
    if (fenced.status !== RUN_STATUS.RUNNING || fenced.userStopped) return fenced;
    return fenced.activeOperation?.launchFenced ? this.recoverFencedOperation(fenced) : fenced;
  }

  private async observeBridge(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<PlanExecRun> {
    const status = await this.bridgeStatus(run, operation);
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    const state = text(status.data.state);
    let observed = await this.recordObservation(
      run,
      operation,
      status.data.text,
      state,
      status.data.activity,
      status.data,
    );
    if (!sameOperationState(run, observed, operation)) return observed;
    if (isBoundNeverStarted(status.data, operation))
      return this.fenceRejectedLaunch(observed, operation, status.data);
    if (
      !state ||
      state === EXTERNAL_OPERATION_STATE.RUNNING ||
      state === EXTERNAL_OPERATION_STATE.STOPPING
    )
      return state === EXTERNAL_OPERATION_STATE.RUNNING ? this.guideConfirmedToolFailure(observed) : observed;
    if (!hasProcessExit(status.data, operation))
      return this.recordObservationFailure(observed, operation, "Terminal wrapper state has no confirmed process-tree exit; retaining ownership.");
    observed = await this.recordBudgetExhaustion(observed, operation, status.data);
    if (!sameOperationState(run, observed, operation)) return observed;
    operation = { ...(observed.activeOperation ?? operation), processTreeExited: true, lastObservedState: state };
    const terminalError = operation.terminationReason === "execution_lifetime_expired"
      ? "Explicit bounded execution lifetime expired; the checkpoint is preserved for automatic continuation."
      : bridgeTerminalError(status.data);
    const settled =
      state === EXTERNAL_OPERATION_STATE.PAUSED ||
      state === EXTERNAL_OPERATION_STATE.FAILED
        ? await readSettledWorkflowCompletion(
            text(status.data.resultPath),
            operation.asyncDir,
            operation.externalRunId,
          )
        : undefined;
    if (state === EXTERNAL_OPERATION_STATE.PAUSED && !settled)
      return this.waitForExternalOperation(
        observed,
        operation,
        terminalError,
      );
    if (settled) {
      await appendProgressBestEffort(
        observed,
        `Recovered completed ${operation.kind} child after its workflow detached for supervisor coordination.`,
      );
    }
    return this.finishBridgeOperation(
      observed,
      operation,
      settled ? EXTERNAL_OPERATION_STATE.COMPLETE : state,
      settled ? undefined : terminalError,
      settled?.output,
    );
  }

  private async bridgeStatus(run: PlanExecRun, operation: ActiveOperation): Promise<ServiceReply> {
    const lookup = await this.bridge.operation(operation.operationId, bridgeOperationOwner(run, operation));
    if (lookup.success && lookup.data.runId === operation.externalRunId &&
      operation.requestDigest && lookup.data.requestDigest === operation.requestDigest) {
      const state = text(lookup.data.status);
      if (state) return { success: true, data: { ...lookup.data, state } };
    }
    return this.bridge.status(operation.externalRunId!, operation.asyncDir);
  }

  private async guideConfirmedToolFailure(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    const diagnosis = operation?.diagnostics;
    const failure = diagnosis?.lastToolFailure;
    const key = diagnosis?.failureKey;
    if (run.status !== RUN_STATUS.RUNNING || run.userStopped || operation?.stopRequested || operation?.processTreeExited ||
      !operation || operation.service !== OPERATION_SERVICE.BRIDGE || diagnosis?.assessment !== "tool_fault_reported" || !failure || !key || !this.bridge.diagnoseOperation)
      return run;
    const pending = Object.entries(operation.diagnosticActions ?? {}).find(([, action]) => action.state === EXTERNAL_OPERATION_STATE.PENDING);
    const failureKey = pending?.[0] ?? key;
    let action = pending?.[1] ?? operation.diagnosticActions?.[failureKey];
    if (action && (action.state !== EXTERNAL_OPERATION_STATE.PENDING || action.nextAttemptAt > Date.now() || action.stopGeneration !== (run.stopGeneration ?? 0))) return run;
    const capabilities = await this.bridgeCapabilities();
    const capability = capabilities?.diagnosticGuidance;
    const owner = bridgeOperationOwner(run, operation);
    if (!owner || !capabilities?.healthy || capability?.version !== 1 || !capability.idempotent || capability.mode !== "follow_up" || !capability.confirmedToolFailure)
      return run;
    if (!action) {
      action = { diagnosticId: `${operation.operationId}:${failureKey}`, toolCallId: failure.toolCallId,
        message: `The runner confirmed a tool execution error for ${failure.toolName} (${failure.toolCallId}): ${failure.message}. Preserve this session and checkpoint. Diagnose that concrete error, repair or retry only the affected tool when justified, and continue the original task; do not restart already completed work.`,
        state: "pending", stopGeneration: run.stopGeneration ?? 0, requestedAt: Date.now(), nextAttemptAt: 0 };
      const intended = await this.registry.updateIfCurrent({ ...run, activeOperation: { ...operation,
        diagnosticActions: { ...operation.diagnosticActions, [failureKey]: action },
      } }, run.updatedAt);
      if (!intended.applied) return intended.run;
      run = intended.run;
    }
    const current = (await this.registry.get(run.id)) ?? run;
    if (!sameOperationState(run, current, operation) || current.status !== RUN_STATUS.RUNNING || current.userStopped ||
      current.activeOperation?.stopRequested || (current.stopGeneration ?? 0) !== action.stopGeneration) return current;
    let reply: ServiceReply;
    try {
      reply = await this.bridge.diagnoseOperation(operation.operationId, owner,
        { diagnosticId: action.diagnosticId, toolCallId: action.toolCallId, message: action.message });
    } catch (error) {
      reply = { success: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    const latest = (await this.registry.get(run.id)) ?? current;
    if (!sameOperationState(current, latest, operation) || latest.status !== RUN_STATUS.RUNNING || latest.userStopped ||
      latest.activeOperation?.stopRequested || (latest.stopGeneration ?? 0) !== action.stopGeneration) return latest;
    const valid = reply.success && reply.data.operationId === operation.operationId && reply.data.requestDigest === owner.requestDigest &&
      reply.data.diagnosticId === action.diagnosticId && reply.data.toolCallId === action.toolCallId && reply.data.guidanceOnly === true &&
      ["pending", "queued", "cancelled", "rejected"].includes(String(reply.data.state));
    const state = valid && reply.success ? reply.data.state as DiagnosticAction["state"] : "pending";
    const recorded: DiagnosticAction = { ...action, state, lastReplyAt: Date.now(), nextAttemptAt: Date.now() + run.config.retryDelayMs };
    if (!valid) recorded.error = reply.success ? "Diagnostic reply was not bound to the requested operation and tool failure." : reply.error.message;
    else delete recorded.error;
    return (await this.registry.updateIfCurrent({ ...latest, activeOperation: { ...latest.activeOperation!,
      diagnosticActions: { ...latest.activeOperation?.diagnosticActions, [failureKey]: recorded },
    } }, latest.updatedAt)).run;
  }

  private async finishBridgeOperation(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    terminalError?: string,
    recoveredOutput?: string,
  ): Promise<PlanExecRun> {
    if (operation.kind === OPERATION_KIND.IMPLEMENTATION) {
      let output = recoveredOutput;
      if (!output) {
        try {
          output = await this.bridgeOutput(operation);
        } catch {
          // Legacy providers may retain only terminal diagnostics. Checkboxes
          // still prove completion; missing output alone is not a task blocker.
        }
      }
      const current = (await this.registry.get(run.id)) ?? run;
      if (!sameOperationState(run, current, operation)) return current;
      return isGoalRun(current)
        ? this.finishGoal(current, operation, state, terminalError, output)
        : this.finishImplementation(current, operation, state, terminalError, output);
    }
    if (operation.kind === OPERATION_KIND.REVIEW) {
      if (!isSuccessfulOperationState(state))
        return this.finishReview(run, operation, state, "", terminalError);
      let output = recoveredOutput;
      if (!output) {
        try {
          output = await this.bridgeOutput(operation);
        } catch (error: unknown) {
          return this.retryReviewOutput(
            run,
            operation,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const current = (await this.registry.get(run.id)) ?? run;
      if (!sameOperationState(run, current, operation)) return current;
      return this.finishReview(current, operation, state, output);
    }
    if (operation.kind === OPERATION_KIND.FIX)
      return this.finishFix(run, operation, state, terminalError);
    if (operation.kind === OPERATION_KIND.FINALIZE)
      return this.finishBestEffort(
        run,
        operation,
        state,
        RUN_STAGE.STATS,
        terminalError,
      );
    if (operation.kind === OPERATION_KIND.STATS) {
      if (!isSuccessfulOperationState(state))
        return this.finishStats(run, operationFailureMessage(`Optional statistics operation ended as ${state}.`, terminalError));
      try { return this.finishStats(run, undefined, recoveredOutput ?? await this.bridgeOutput(operation)); }
      catch (error) { return this.finishStats(run, error instanceof Error ? error.message : String(error)); }
    }
    return this.fail(
      run,
      `Unexpected bridge operation kind: ${operation.kind}.`,
    );
  }

  private async waitForExternalOperation(
    run: PlanExecRun,
    operation: ActiveOperation,
    terminalError?: string,
  ): Promise<PlanExecRun> {
    const waiting = await this.registry.updateIfCurrent(
      clearError({
        ...withTerminalError(run, operation, terminalError),
        status: RUN_STATUS.RUNNING,
      }),
      run.updatedAt,
    );
    if (!waiting.applied) return waiting.run;
    await appendProgressOnceBestEffort(
      waiting.run,
      `${operation.kind} workflow is waiting for supervisor input; the controller kept its operation attached and continued polling.`,
    );
    return waiting.run;
  }

  private async observeFusion(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<PlanExecRun> {
    const client = await this.reviewClient(run);
    const status = await client.status(operation.externalRunId);
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    let observed = await this.recordObservation(run, operation, status.data.text, undefined, status.data.activity, status.data);
    if (!sameOperationState(run, observed, operation)) return observed;
    const state = fusionState(status.data);
    if (!state || !state.terminal) return observed;
    if (state.runId !== operation.externalRunId)
      return this.recordObservationFailure(observed, operation, "Fusion status did not match the tracked run identity.");
    if (!hasProcessExit(status.data, operation))
      return this.recordObservationFailure(observed, operation, "Fusion termination has no confirmed process-tree exit; retaining ownership.");
    observed = await this.recordBudgetExhaustion(observed, operation, status.data);
    if (!sameOperationState(run, observed, operation)) return observed;
    if (state.phase === FUSION_PHASE.FAILED || state.phase === FUSION_PHASE.CANCELLED)
      return this.reviewFailure(observed, fusionTerminalError(state));
    const result = await client.result(state.runId);
    if (!result.success)
      return this.fail(
        observed,
        fusionTerminalError(state, result.error.message),
        true,
      );
    const current = (await this.registry.get(run.id)) ?? observed;
    if (!sameOperationState(observed, current, operation)) return current;
    const final = fusionState(result.data);
    if (!final) {
      return this.fail(
        current,
        "Fusion result omitted a valid terminal run state.",
        true,
      );
    }
    if (final.runId !== operation.externalRunId)
      return this.fail(current, "Fusion result did not match the tracked run identity.", true);
    if (
      final.phase === FUSION_PHASE.FAILED ||
      final.phase === FUSION_PHASE.CANCELLED
    )
      return this.reviewFailure(
        current,
        fusionTerminalError(final),
      );
    if (final.phase !== FUSION_PHASE.DONE)
      return this.fail(
        current,
        `Fusion result ended in unexpected phase ${final.phase}.`,
        true,
      );
    const callerOutput = parseFusionCallerOutput(result.data.callerOutput);
    if (!callerOutput)
      return this.fail(
        current,
        "Fusion completed without validated caller output.",
      );
    return this.finishReview(current, operation, final.phase, callerOutput.output);
  }

  private async recordObservation(
    run: PlanExecRun,
    operation: ActiveOperation,
    statusText?: unknown,
    observedState?: string,
    nativeActivity?: unknown,
    nativeStatus?: Record<string, unknown>,
  ): Promise<PlanExecRun> {
    const observedOperation: ActiveOperation = {
      ...operation,
      lastObservedAt: Date.now(),
      ...(observedState ? { lastObservedState: observedState } : {}),
    };
    delete observedOperation.statusFailures;
    delete observedOperation.lastStatusError;
    const native = parseNativeActivity(nativeActivity);
    const diagnosis = diagnoseOperation(nativeActivity, nativeStatus, {
      now: Date.now(), nextProbeAt: Date.now() + CONTROLLER_POLL_INTERVAL_MS,
      treeExited: nativeStatus ? hasProcessExit(nativeStatus, operation) : false,
      ...(operation.diagnostics ? { prior: operation.diagnostics } : {}),
    });
    observedOperation.diagnostics = diagnosis.action === "repair_tool" ? { ...diagnosis, action: "probe" } : diagnosis;
    const prerequisite = parseExternalPrerequisite(nativeStatus?.externalPrerequisite, "provider");
    if (prerequisite) observedOperation.externalPrerequisite = prerequisite;
    const usage = nativeUsage(nativeStatus);
    const previous = operation.reportedUsage ?? {};
    const accumulated = { ...previous };
    const task = operation.taskId ? run.tasks?.[String(operation.taskId)] : undefined;
    const taskUsage = { ...task?.usage };
    const runUsage = { ...run.usage };
    for (const key of ["inputTokens", "outputTokens", "cost"] as const) {
      const value = usage[key];
      if (value === undefined) continue;
      const prior = previous[key] ?? 0;
      const delta = Math.max(value - prior, 0);
      const nextTaskTotal = (taskUsage[key] ?? 0) + delta;
      const nextRunTotal = (runUsage[key] ?? 0) + delta;
      const validTotal = key === "cost" ? finiteUsageAmount : safeTokenCount;
      if (!validTotal(nextTaskTotal) || !validTotal(nextRunTotal)) continue;
      accumulated[key] = Math.max(prior, value);
      taskUsage[key] = nextTaskTotal;
      runUsage[key] = nextRunTotal;
    }
    if (Object.keys(accumulated).length) observedOperation.reportedUsage = accumulated;
    const signal = native.signal ?? parseWorkerSignal(statusText);
    if (signal) observedOperation.workerSignal = signal;
    else delete observedOperation.workerSignal;
    return this.registry.heartbeat({
      ...run,
      activeOperation: observedOperation,
      ...(Object.keys(runUsage).length ? { usage: runUsage } : {}),
      ...(operation.taskId && task
        ? { tasks: { ...run.tasks, [String(operation.taskId)]: {
          ...task,
          ...(native.lastActivityAt ? { lastVerifiedActivityAt: native.lastActivityAt } : {}),
          ...(Object.keys(taskUsage).length ? { usage: taskUsage } : {}),
        } } } : {}),
    });
  }

  private async recordBudgetExhaustion(run: PlanExecRun, operation: ActiveOperation,
    status: Record<string, unknown>): Promise<PlanExecRun> {
    const lifetime = operationExpectedLifetime(operation);
    if (status.terminationReason !== "execution_lifetime_expired" || lifetime?.mode !== "bounded" ||
      run.activeOperation?.budgetExpiryRecorded) return run;
    const key = budgetKey(run, operation.kind, operation.taskId);
    const expiries = (run.budgetExhaustions?.[key] ?? 0) + 1;
    const growth = usefulProgressAtRetirement(run.activeOperation ?? operation, status, lifetime.timeoutMs);
    return (await this.registry.updateIfCurrent({ ...run,
      budgetExhaustions: { ...run.budgetExhaustions, [key]: expiries },
      ...(growth ? { budgetGrowths: { ...run.budgetGrowths, [key]: (run.budgetGrowths?.[key] ?? 0) + 1 } } : {}),
      activeOperation: { ...(run.activeOperation ?? operation), expectedLifetime: lifetime,
        processTreeExited: true, terminationReason: "execution_lifetime_expired", budgetExpiryRecorded: true, budgetGrowthGranted: growth },
      wakeReason: `Confirmed bounded execution-lifetime expiry ${expiries}; ${growth ? "recent verified model/tool progress permits a larger next budget" : "no recent useful progress was confirmed, so the budget stays unchanged and the next continuation must change its diagnosis"}.`,
    }, run.updatedAt)).run;
  }

  private async recordObservationFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = (operation.statusFailures ?? 0) + 1;
    const nextProbeAt = Date.now() + retryDelay(run.config.retryDelayMs, failures);
    const failedRun = {
      ...run,
      nextAttemptAt: nextProbeAt,
      wakeReason: error,
      needsAttention: failures >= MAX_STATUS_FAILURES,
      activeOperation: {
        ...operation,
        statusFailures: failures,
        lastStatusError: error,
        diagnostics: diagnoseOperation(undefined, undefined, { now: Date.now(), nextProbeAt, treeExited: false,
          statusUnavailable: true, error, ...(operation.diagnostics ? { prior: operation.diagnostics } : {}) }),
      },
    };
    return this.registry.heartbeat(failedRun);
  }

  private recordCancellationFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = (operation.statusFailures ?? 0) + 1;
    const failedRun = {
      ...run,
      nextAttemptAt: Date.now() + retryDelay(run.config.retryDelayMs, failures),
      wakeReason: error,
      activeOperation: {
        ...operation,
        recovery: OPERATION_RECOVERY.CANCEL,
        statusFailures: failures,
        lastStatusError: error,
      },
    };
    return this.registry.heartbeat(failedRun);
  }

  private async recoverFailedRun(
    run: PlanExecRun,
    retryTask = false,
    recoveryModel?: string,
  ): Promise<PlanExecRun> {
    const plan = isGoalRun(run) || run.stage === RUN_STAGE.ARCHIVE
      ? undefined
      : await readPlan(requirePlanPath(run));
    if (plan && plan.hash !== run.planHash)
      return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
    const settled = await this.settledFailedWorkflow(run);
    if (settled) return settled;
    if (isDetachedWorkflowFailure(run))
      return this.registry.heartbeat({
        ...run,
        error:
          "Detached workflow has no correlated durable completion artifact; refusing blind reattachment. Inspect the provider artifacts and retry only after correlation is restored.",
      });
    if (run.pendingStageSkip) {
      const resetOperation = resetOperationFailures(run.activeOperation);
      const recovered = await this.registry.updateIfCurrent(
        clearError({
          ...run,
          status: RUN_STATUS.SKIP_PENDING,
          ...(resetOperation ? { activeOperation: resetOperation } : {}),
        }),
        run.updatedAt,
      );
      if (!recovered.applied) return recovered.run;
      await appendProgressBestEffort(
        recovered.run,
        `Manual recovery continued the pending force-skip for ${run.pendingStageSkip.stage}.`,
      );
      return recovered.run;
    }

    const task =
      run.stage === RUN_STAGE.IMPLEMENTATION
        ? plan?.tasks.find((candidate) => candidate.unchecked.length > 0)
        : undefined;
    if (isTaskRetryConfirmationRequired(run) && !retryTask)
      throw new Error(taskRetryRequiredMessage(run));
    const config = recoveryConfig(run);
    const runWithoutRecoveryModel = withoutRecoveryModel(run);
    const retryFailedReview =
      isReviewStage(run.stage) &&
      (run.failedOperation?.kind === OPERATION_KIND.REVIEW ||
        run.failedOperation?.kind === OPERATION_KIND.FUSION);
    const recovered = await this.registry.updateIfCurrent(
      clearError({
        ...runWithoutRecoveryModel,
        status:
          run.activeOperation?.recovery === OPERATION_RECOVERY.CANCEL
            ? RUN_STATUS.CANCEL_PENDING
            : RUN_STATUS.RUNNING,
        config,
        ...(recoveryModel ? { recoveryModel } : {}),
        ...(retryFailedReview
          ? {
              stageAttempts: {
                ...run.stageAttempts,
                [run.stage]: Math.max(
                  (run.stageAttempts[run.stage] ?? 1) - 1,
                  0,
                ),
              },
            }
          : {}),
        ...(run.stage === RUN_STAGE.IMPLEMENTATION && task
          ? {
              taskAttempts: {
                ...run.taskAttempts,
                [String(task.id)]: 0,
              },
            }
          : {}),
      }),
      run.updatedAt,
    );
    if (!recovered.applied) return recovered.run;
    const retryFailedFix =
      (run.failedOperation?.kind === OPERATION_KIND.FIX ||
        /^Fix operation ended as .+\.$/.test(run.error ?? "")) &&
      isReviewStage(run.stage) &&
      run.reviewFindings.length > 0;
    await appendProgress(
      recovered.run,
      task
        ? `Manual recovery reset Task ${task.id} and retried the failed implementation stage${recoveryModel ? ` with model ${recoveryModel}` : ""}.`
        : retryFailedFix
          ? `Manual recovery retried the failed ${run.stage} fix operation.`
          : retryFailedReview
            ? `Manual recovery reset the failed ${run.stage} review attempt.`
            : `Manual recovery retried the failed ${run.stage} stage.`,
    );
    if (!retryFailedFix || recovered.run.activeOperation) return recovered.run;
    return this.launchBridge(recovered.run, {
      kind: OPERATION_KIND.FIX,
      reviewIteration:
        run.failedOperation?.reviewIteration ??
        run.stageAttempts[run.stage] ??
        1,
      agent: recovered.run.config.workerAgent,
      maxTurns: recovered.run.config.workerMaxTurns,
      task: fixerPrompt(
        recovered.run,
        recovered.run.reviewFindings,
        formatFindings(recovered.run.reviewFindings),
      ),
    });
  }

  private async settledFailedWorkflow(
    run: PlanExecRun,
  ): Promise<PlanExecRun | undefined> {
    const operation = run.failedOperation;
    if (
      operation?.service !== OPERATION_SERVICE.BRIDGE ||
      !operation.externalRunId
    )
      return undefined;
    const settled = await readSettledWorkflowCompletion(
      undefined,
      operation.asyncDir,
      operation.externalRunId,
    );
    if (!settled) return undefined;
    const restored = await this.registry.updateIfCurrent(
      clearError({
        ...run,
        status: RUN_STATUS.RUNNING,
        activeOperation: {
          ...resetOperationFailures(operation)!,
          recovery: OPERATION_RECOVERY.OBSERVE,
        },
      }),
      run.updatedAt,
    );
    if (!restored.applied) return restored.run;
    await appendProgressBestEffort(
      restored.run,
      `Manual recovery consumed the completed ${operation.kind} child from its detached workflow; no replacement was launched.`,
    );
    return this.observeBridge(restored.run, restored.run.activeOperation ?? operation);
  }

  private async pauseForReview(
    run: PlanExecRun,
    error: string,
  ): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    let next: PlanExecRun = { ...run, status: RUN_STATUS.PAUSED, error };
    if (!operation || operation.processTreeExited === true) {
      if (operation) {
        next.failedOperation = { ...operation, terminalError: error };
        const task = operation.taskId ? run.tasks?.[String(operation.taskId)] : undefined;
        if (operation.kind === OPERATION_KIND.IMPLEMENTATION && task && task.state !== "accepted") {
          const retry = { ...task, state: "retry_wait" as const, nextAttemptAt: Date.now(), reason: error,
            laneCwd: task.laneCwd ?? run.worktreeCwd, laneBranch: task.laneBranch ?? run.branch };
          delete retry.candidateCommit;
          next.tasks = { ...run.tasks, [String(task.taskId)]: retry };
          next.taskAttempts = { ...run.taskAttempts, [String(task.taskId)]: (run.taskAttempts[String(task.taskId)] ?? 0) + 1 };
        }
      }
      next = withoutOperation(next);
    }
    const paused = await this.registry.updateIfCurrent(
      next,
      run.updatedAt,
    );
    if (!paused.applied) return paused.run;
    try {
      await appendProgress(paused.run, `Run paused for review: ${error}`);
    } catch {
      // The registry is authoritative if the optional progress file is unavailable.
    }
    return paused.run;
  }

  private async finishImplementation(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    terminalError?: string,
    output?: string,
  ): Promise<PlanExecRun> {
    assertPlanRun(run);
    const taskId = operation.taskId;
    if (!taskId)
      return this.fail(run, "Implementation operation has no task ID.");
    const plan = await readPlan(run.planPath);
    if (plan.hash !== run.planHash)
      return this.pauseForReview({ ...run, activeOperation: operation }, PLAN_STRUCTURE_CHANGED_ERROR);
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task)
      return this.fail(run, `Task ${taskId} disappeared from the plan.`);
    const blocker = taskFailureReason(output);
    const prerequisite = operation.externalPrerequisite ?? workerExternalPrerequisite(output);
    const attempts = (run.taskAttempts[String(taskId)] ?? 0) + 1;
    const tasks = reconcileTasks(plan.tasks, run.tasks);
    const execution = tasks[String(taskId)]!;
    const waitingDependency = execution.dependsOn.some((id) => tasks[String(id)]?.state !== "accepted");
    let reason = blocker ?? terminalError ?? `Worker ended as ${state} with incomplete task ${taskId}.`;
    if (waitingDependency) reason = `Task ${taskId} is waiting for its approved dependencies; preserving the worker result for recovery.`;
    if (prerequisite) reason = `${reason}\nPrerequisite (${prerequisite.source}/${prerequisite.kind}): ${prerequisite.evidence}`;
    if (isSuccessfulOperationState(state) && !blocker && !prerequisite && !waitingDependency && task.unchecked.length === 0) {
      try {
        const candidate = execution.state === "verifying" && execution.operationId === operation.operationId && execution.candidateCommit
          ? execution.candidateCommit : await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
        if (candidate === execution.baselineCommit) throw new Error("Task candidate did not advance its baseline commit.");
        const checkoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
        const committedPlanText = await gitValue(this.runCommand, run.worktreeCwd, ["show", `${candidate}:${gitPath(relative(checkoutRoot, run.planPath))}`]);
        const committedPlan = parsePlan(run.planPath, committedPlanText);
        assertAcceptedCheckboxes(run, committedPlan);
        const checkpoints: TaskRecoverySource[] = [];
        for (const source of [...(execution.recoveryHistory ?? []), ...(execution.recoverySource ? [execution.recoverySource] : [])]) {
          const checkpointCommit = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "--verify", `${source.checkpointRef}^{commit}`]);
          await gitValue(this.runCommand, run.worktreeCwd, ["merge-base", "--is-ancestor", source.headCommit, checkpointCommit]);
          await gitValue(this.runCommand, run.worktreeCwd, ["merge-base", "--is-ancestor", checkpointCommit, candidate]);
          checkpoints.push({ ...source, checkpointCommit });
        }
        if (committedPlan.hash !== run.planHash || committedPlan.tasks.find((entry) => entry.id === taskId)?.unchecked.length !== 0)
          throw new Error("Task checkboxes must be complete in the committed candidate plan.");
        const verifying = await this.registry.updateIfCurrent({ ...run, tasks: { ...tasks,
          [String(taskId)]: { ...execution, state: "verifying", candidateCommit: candidate },
        } }, run.updatedAt);
        if (!verifying.applied) return verifying.run;
        run = verifying.run;
        await this.verifyCandidate(run, candidate);
        const acceptedExecution = { ...execution, acceptedCommit: candidate, candidateCommit: candidate };
        if (acceptedExecution.recoverySource && checkpoints.length)
          acceptedExecution.recoverySource = checkpoints.at(-1)!;
        if (acceptedExecution.recoveryHistory)
          acceptedExecution.recoveryHistory = checkpoints.slice(0, acceptedExecution.recoveryHistory.length);
        delete acceptedExecution.externalPrerequisite;
        delete acceptedExecution.reason;
        delete acceptedExecution.nextAttemptAt;
        const accepted = await this.registry.updateIfCurrent(withoutOperation({ ...run,
          acceptedHead: candidate, nextAttemptAt: 0, needsAttention: false,
          tasks: { ...tasks, [String(taskId)]: { ...acceptedExecution, state: "accepted" } },
          taskAttempts: { ...run.taskAttempts, [String(taskId)]: attempts },
        }), run.updatedAt);
        if (accepted.applied) await appendProgressBestEffort(accepted.run, `Task ${taskId} accepted at ${candidate} after verification.`);
        return accepted.run;
      } catch (error) {
        if (error instanceof LocalOperationUnknownError) return this.fail(run, error.message, true);
        reason = `Candidate verification: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const retryAt = Date.now() + retryDelay(run.config.retryDelayMs, attempts);
    const retryExecution = { ...execution };
    delete retryExecution.candidateCommit;
    delete retryExecution.externalPrerequisite;
    const waiting = await this.registry.updateIfCurrent(withoutOperation({ ...run,
      status: RUN_STATUS.RUNNING, nextAttemptAt: 0,
      tasks: { ...tasks, [String(taskId)]: { ...retryExecution,
        state: waitingDependency ? "waiting_dependency" : prerequisite ? "waiting_external" : "retry_wait", reason, nextAttemptAt: retryAt,
        ...(prerequisite ? { externalPrerequisite: prerequisite } : {}),
        laneCwd: run.worktreeCwd, laneBranch: run.branch,
      } },
      taskAttempts: { ...run.taskAttempts, [String(taskId)]: attempts },
      failedOperation: { ...operation, terminalError: reason }, wakeReason: reason,
    }), run.updatedAt);
    if (waiting.applied) await appendProgressBestEffort(waiting.run, `Task ${taskId} preserved for automatic recovery: ${reason}`);
    return waiting.run;
  }

  private async retryReviewOutput(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const cleared = withoutOperation(run);
    const iteration = operation.reviewIteration ?? 1;
    await appendProgress(
      cleared,
      `Review attempt ${iteration} produced no usable output; retrying: ${error}`,
    );
    const ready = await this.registry.update(cleared);
    if (
      ready.status !== cleared.status ||
      ready.activeOperation !== undefined
    ) {
      return ready;
    }
    return this.fail(ready, `Review output unavailable: ${error}`);
  }

  private async finishReview(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    output: string,
    terminalError?: string,
  ): Promise<PlanExecRun> {
    const reviewedCommit = operation.reviewedCommit ?? text(operation.params?.reviewedCommit);
    if (reviewedCommit) {
      const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
      if (head !== reviewedCommit) return this.fail(run, "Reviewed candidate changed during review; a new review is required.");
    }
    if (!isSuccessfulOperationState(state))
      return this.reviewFailure(
        withTerminalError(run, operation, terminalError),
        operationFailureMessage(
          `Review operation ended as ${state}.`,
          terminalError,
        ),
      );
    let findings: ReviewFinding[];
    try {
      findings = reviewedCommit
        ? validateReviewResult(output, reviewedCommit, await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"])).findings
        : parseReviewFindings(output);
    } catch (error: unknown) {
      return this.reviewFailure(
        run,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!hasBlockingFindings(findings) && findings.length && run.reviewRecovery?.lastReviewedCommit) {
      const priorBlockers = run.reviewFindings.filter((finding) => finding.severity !== "MINOR");
      const downgraded = findings.some((finding) => priorBlockers.some((previous) => normalizedSummary(previous.summary) === normalizedSummary(finding.summary)));
      if (downgraded) {
        const checkoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
        const metadata = new Set([
          ...(run.planPath ? [gitPath(relative(checkoutRoot, run.planPath))] : []),
          ...(run.progressPath ? [gitPath(relative(checkoutRoot, run.progressPath))] : []),
        ]);
        const changes = await this.runCommand("git", ["diff", "--name-only", "--no-relative", "-z", run.reviewRecovery.lastReviewedCommit, "HEAD"], run.worktreeCwd);
        if (changes.code !== 0) return this.reviewFailure(run, "Unable to verify the change supporting review adjudication.");
        if (!changes.stdout.split("\0").some((path) => path && !metadata.has(path)))
          return this.reviewFailure(run, "A previously blocking finding was relabeled MINOR without a changed tree or explicit adjudication; required review remains unmet.");
      }
    }
    const cleared = withoutOperation({ ...run, reviewFindings: findings });
    if (!hasBlockingFindings(findings)) {
      delete cleared.reviewRecovery;
      const known = new Set(run.unresolvedFindings.map((finding) => finding.id));
      cleared.unresolvedFindings = [...run.unresolvedFindings, ...findings.filter((finding) => !known.has(finding.id))];
      cleared.reviewedCommit = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
      await appendProgress(cleared, findings.length ? `${run.stage} passed with ${findings.length} reviewer-classified MINOR advisory finding(s).` : `${run.stage} found no issues.`);
      return this.advanceUnlocked(
        await this.transition(
          cleared,
          RUN_STAGE.FINALIZE,
          `${run.stage} passed.`,
        ),
      );
    }
    const fingerprint = reviewFingerprint(findings);
    const repeats = run.reviewRecovery?.fingerprint === fingerprint ? run.reviewRecovery.repeats + 1 : 1;
    const delayed = repeats > REVIEW_DIAGNOSTIC_BURST;
    const pending = await this.registry.updateIfCurrent({ ...cleared,
      reviewRecovery: { fingerprint, repeats, pendingFix: true,
        ...(reviewedCommit ? { lastReviewedCommit: reviewedCommit } : {}),
      },
      nextAttemptAt: delayed ? Date.now() + retryDelay(run.config.retryDelayMs, repeats - REVIEW_DIAGNOSTIC_BURST) : 0,
      wakeReason: delayed ? `The same review findings remain after ${repeats} reviews; a different diagnosis is scheduled.` : "Review findings require a fix.",
    }, run.updatedAt);
    if (!pending.applied || delayed) return pending.run;
    return this.launchPendingReviewFix(pending.run);
  }

  private launchPendingReviewFix(run: PlanExecRun): Promise<PlanExecRun> {
    return this.launchBridge(run, {
      kind: OPERATION_KIND.FIX,
      reviewIteration: run.stageAttempts[run.stage] ?? 1,
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: fixerPrompt(run, run.reviewFindings, formatFindings(run.reviewFindings)),
    });
  }

  private async finishFix(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    terminalError?: string,
  ): Promise<PlanExecRun> {
    const cleared = withoutOperation(run);
    if (state !== EXTERNAL_OPERATION_STATE.COMPLETE)
      return this.fail(
        { ...withTerminalError(run, operation, terminalError),
          ...(run.reviewRecovery ? { reviewRecovery: { ...run.reviewRecovery, pendingFix: true } } : {}),
        },
        operationFailureMessage(
          `Fix operation ended as ${state}.`,
          terminalError,
        ),
      );
    await appendProgress(
      cleared,
      `Applied fixes for ${run.stage} iteration ${operation.reviewIteration ?? 1}.`,
    );
    if (
      run.stage === RUN_STAGE.SMELLS_REVIEW ||
      run.stage === RUN_STAGE.CRITICAL_REVIEW
    ) {
      return this.advanceUnlocked(
        await this.transition(
          cleared,
          nextStage(run.stage),
          `${run.stage} fixes applied.`,
        ),
      );
    }
    if (
      run.stage === RUN_STAGE.FUSION_REVIEW &&
      !hasBlockingFindings(run.reviewFindings)
    ) {
      return this.advanceUnlocked(
        await this.transition(
          cleared,
          nextStage(run.stage),
          "Fusion minor findings fixed.",
        ),
      );
    }
    return this.advanceUnlocked(await this.registry.update(cleared));
  }

  private async finishBestEffort(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    next: RunStage,
    terminalError?: string,
  ): Promise<PlanExecRun> {
    if (!isSuccessfulOperationState(state))
      return this.fail(
        withTerminalError(run, operation, terminalError),
        operationFailureMessage(
          `${operation.kind} operation ended as ${state}.`,
          terminalError,
        ),
      );
    const cleared = withoutOperation(run);
    await appendProgress(
      cleared,
      `${operation.kind} finished as ${state}; continuing best-effort.`,
    );
    return this.advanceUnlocked(
      await this.transition(cleared, next, `${operation.kind} stage complete.`),
    );
  }

  private async archive(run: PlanExecRun): Promise<PlanExecRun> {
    assertPlanRun(run);
    if (run.archiveOperation) return this.advanceArchiveOperation(run);
    const unmet = await this.completionPrerequisite(run);
    if (unmet) return this.fail(run, unmet);
    const destination = join(
      dirname(run.planPath),
      COMPLETED_PLANS_DIRECTORY,
      basename(run.planPath),
    );
    const sourceRelative = relative(run.worktreeCwd, run.planPath);
    const destinationRelative = relative(run.worktreeCwd, destination);
    const progressRelative = run.progressPath
      ? relative(run.worktreeCwd, run.progressPath)
      : undefined;
    const checkoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
    if (
      !isInsideWorktree(relative(checkoutRoot, run.planPath)) ||
      !isInsideWorktree(relative(checkoutRoot, destination)) ||
      (run.progressPath !== undefined && !isInsideWorktree(relative(checkoutRoot, run.progressPath)))
    )
      return this.fail(run, "Archive paths must stay inside the execution worktree.");

    const status = completionStatus(run);
    const source = gitPath(sourceRelative);
    const destinationPath = gitPath(destinationRelative);
    try {
      await assertNoSymlinkPath(checkoutRoot, run.planPath);
      await assertNoSymlinkPath(checkoutRoot, destination);
      if (run.progressPath)
        await assertNoSymlinkPath(checkoutRoot, run.progressPath);
      await mkdir(dirname(destination), { recursive: true });
      const sourceExists = await pathExists(run.planPath);
      const destinationExists = await pathExists(destination);
      if (sourceExists && destinationExists)
        throw new Error(
          `Completed plan destination already exists: ${destination}.`,
        );
      let sourceTracked = false;
      let sourceInIndex = false;
      if (sourceExists) {
        const tracked = await this.runCommand(
          "git",
          ["ls-files", "--error-unmatch", "--", `:(literal)${source}`],
          run.worktreeCwd,
        );
        if (tracked.code === 0) {
          sourceTracked = true;
          sourceInIndex = true;
        } else if (tracked.code !== 1)
          throw new Error(
            tracked.stderr.trim() || "Could not inspect archived plan state.",
          );
      }
      if (sourceExists) await rename(run.planPath, destination);
      else if (!destinationExists)
        throw new Error(`Plan to archive is missing: ${run.planPath}.`);
      await appendProgressOnce(run, `Archived plan to ${destination}.`);
      await appendProgressOnce(run, `Archival prepared for ${status}; waiting for owned Git commands to retire.`);

      if (!sourceExists) {
        const tracked = await this.runCommand(
          "git",
          ["ls-files", "--error-unmatch", "--", `:(literal)${source}`],
          run.worktreeCwd,
        );
        if (tracked.code === 0) {
          sourceTracked = true;
          sourceInIndex = true;
        } else if (tracked.code !== 1)
          throw new Error(
            tracked.stderr.trim() || "Could not inspect archived plan state.",
          );
        else {
          // A previous failed attempt may already have staged the deletion, so
          // the index no longer reports the source even though HEAD does.
          const committed = await this.runCommand(
            "git",
            ["cat-file", "-e", `HEAD:${source}`],
            run.worktreeCwd,
          );
          if (committed.code === 0) sourceTracked = true;
          else if (
            committed.code !== 1 &&
            committed.code !== GIT_MISSING_OBJECT_EXIT_CODE
          )
            throw new Error(
              committed.stderr.trim() || "Could not inspect archived plan history.",
            );
        }
      }

      const paths = [destinationPath];
      if (sourceTracked) paths.unshift(source);
      if (progressRelative !== undefined) paths.push(gitPath(progressRelative));
      const literalPaths = paths.map((path) => `:(literal)${path}`);
      const addPaths = [
        ...(sourceInIndex ? [`:(literal)${source}`] : []),
        `:(literal)${destinationPath}`,
        ...(progressRelative !== undefined
          ? [`:(literal)${gitPath(progressRelative)}`]
          : []),
      ];
      return (await this.registry.updateIfCurrent({ ...run, archiveOperation: {
        phase: "stage", operationId: randomUUID(), commands: [["git", "add", "-f", "-A", "--", ...addPaths]],
        paths: literalPaths, destination, attempt: 0,
      } }, run.updatedAt)).run;
    } catch (error: unknown) {
      return this.fail(
        run,
        `Plan archival failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

  }

  private async advanceArchiveOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.archiveOperation!;
    if (operation.phase !== "retired") {
      try {
        await this.executeLocalCommands(run.worktreeCwd, operation.commands,
          await this.localOptions(run, `git:archive:${operation.operationId}:${operation.attempt}`, run.verifiedCommit));
        const current = (await this.registry.get(run.id)) ?? run;
        if (current.updatedAt !== run.updatedAt || current.userStopped || current.status !== RUN_STATUS.RUNNING) return current;
        const unmet = await this.completionPrerequisite(run);
        if (unmet) return this.fail(run, unmet);
        if (operation.phase === "stage") {
          const pending = await this.runCommand("git", ["status", "--porcelain", "--", ...operation.paths], run.worktreeCwd);
          if (pending.code !== 0) throw new Error(pending.stderr || "Cannot inspect staged archive paths.");
          const next = pending.stdout.trim()
            ? { ...operation, phase: "commit" as const, operationId: randomUUID(), attempt: 0,
              commands: [["git", "commit", "--only", "-m", `chore: archive ${basename(operation.destination)}`, "--", ...operation.paths]] }
            : { ...operation, phase: "retired" as const };
          return (await this.registry.updateIfCurrent({ ...run, archiveOperation: next }, run.updatedAt)).run;
        }
        return (await this.registry.updateIfCurrent({ ...run, archiveOperation: { ...operation, phase: "retired" } }, run.updatedAt)).run;
      } catch (error) {
        return this.fail(error instanceof LocalOperationFailedError ? { ...run,
          archiveOperation: { ...operation, attempt: operation.attempt + 1 },
        } : run, `Plan archival ${operation.phase}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const unmet = await this.completionPrerequisite(run);
    if (unmet) return this.fail(run, unmet);
    const status = completionStatus(run);
    try {
      const completed = await this.registry.updateIfCurrent({
        ...run,
        status,
        stage: RUN_STAGE.COMPLETE,
        retiredAt: Date.now(),
      }, run.updatedAt);
      return completed.applied ? this.registry.release(completed.run) : completed.run;
    } catch (error: unknown) {
      const current = await this.registry.get(run.id);
      if (current) return current;
      throw new Error(
        `Archive committed but run finalization failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async complete(run: PlanExecRun): Promise<PlanExecRun> {
    if (isGoalRun(run)) {
      const violation = await this.goalCompletionGuard(run);
      if (violation) return this.pauseGoal(run, violation);
    }
    const unmet = await this.completionPrerequisite(run);
    if (unmet) return this.fail(run, unmet);
    const status = completionStatus(run);
    // Merged onto the stored record, not onto `run`: the terminal status is the
    // only thing this step decides.
    const completed = await this.registry.updateIfCurrent({
      ...run,
      status,
      stage: RUN_STAGE.COMPLETE,
    }, run.updatedAt);
    if (!completed.applied) return completed.run;
    await appendProgress(completed.run, `Run completed as ${status}.`);
    return this.registry.release(completed.run);
  }

  private async completionPrerequisite(run: PlanExecRun): Promise<string | undefined> {
    const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    if (!run.verifiedCommit) return "Required checks do not cover the current final commit.";
    if (run.config.reviewRequired && run.reviewedCommit !== run.verifiedCommit) return "Required review does not cover the final verified commit.";
    if (isGoalRun(run)) {
      if (run.verifiedCommit !== head) return "Current code differs from the final verified and reviewed commit.";
      const goalCheckoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
      const goalDirty = await worktreeChanges(this.runCommand, run.worktreeCwd);
      const goalProgress = run.progressPath ? gitPath(relative(goalCheckoutRoot, run.progressPath)) : undefined;
      if (goalDirty.some((path) => path !== goalProgress)) return "Uncommitted source changes prevent completion.";
      return undefined;
    }
    assertPlanRun(run);
    if (!run.tasks || !Object.values(run.tasks).length || Object.values(run.tasks).some((task) => task.state !== "accepted"))
      return "Completion requires every implementation task to be accepted; skipped or unchecked tasks remain unmet.";
    const checkoutRoot = await gitCheckoutRoot(this.runCommand, run.worktreeCwd);
    const archivePaths = new Set([gitPath(relative(checkoutRoot, run.planPath)),
      gitPath(relative(checkoutRoot, join(dirname(run.planPath), COMPLETED_PLANS_DIRECTORY, basename(run.planPath)))),
      ...(run.progressPath ? [gitPath(relative(checkoutRoot, run.progressPath))] : [])]);
    if (run.verifiedCommit !== head) {
      const archived = !(await pathExists(run.planPath));
      const changes = await this.runCommand("git", ["diff", "--name-only", "--no-relative", "-z", run.verifiedCommit, head], run.worktreeCwd);
      if (!archived || changes.code !== 0 || changes.stdout.split("\0").some((path) => path && !archivePaths.has(path)))
        return "Current code differs from the final verified and reviewed commit.";
    }
    const planPath = await pathExists(run.planPath) ? run.planPath : join(dirname(run.planPath), COMPLETED_PLANS_DIRECTORY, basename(run.planPath));
    try {
      assertAcceptedCheckboxes(run, await readPlan(planPath));
      const committedPath = run.verifiedCommit === head ? run.planPath : planPath;
      const committed = await gitValue(this.runCommand, run.worktreeCwd, ["show", `${head}:${gitPath(relative(checkoutRoot, committedPath))}`]);
      assertAcceptedCheckboxes(run, parsePlan(committedPath, committed));
    } catch (error) { return error instanceof Error ? error.message : String(error); }
    const dirty = await worktreeChanges(this.runCommand, run.worktreeCwd);
    if (dirty.some((path) => !archivePaths.has(path)))
      return "Uncommitted source changes prevent completion.";
    if (hasBlockingFindings(run.reviewFindings) || hasBlockingFindings(run.unresolvedFindings)) return "Blocking review findings remain unresolved.";
    return undefined;
  }

  private async advanceStageSkip(run: PlanExecRun): Promise<PlanExecRun> {
    run = await this.requestOperationCancellation(run);
    if (run.status !== RUN_STATUS.SKIP_PENDING) return run;
    const request = run.pendingStageSkip;
    if (!request || request.stage !== run.stage)
      return this.fail(
        run,
        "Force-skip state does not match the current stage.",
      );
    const operation = run.activeOperation;
    if (!operation) return this.finishStageSkip(run, "no active operation");
    if (operation.launchFenced) return this.finishStageSkip(run, "launch durably fenced before dispatch");

    if (!operation.externalRunId) {
      if (operation.service === OPERATION_SERVICE.FUSION) {
        const launched = await (await this.reviewClient(run)).status(undefined, operation.operationId);
        if (!launched.success)
          return this.recordStageSkipFailure(run, operation, launched.error.message);
        if (isFencedCancellation(launched.data, operation)) {
          const fenced = await this.updateActiveOperation(run, operation.operationId, { launchFenced: true, stopAcknowledged: true });
          return this.advanceStageSkip(fenced);
        }
        const state = fusionState(launched.data);
        const expectedLifetime = operationExpectedLifetime(operation);
        if (!state || (operation.requestDigest && launched.data.requestDigest !== operation.requestDigest) ||
          (launched.data.operationId !== undefined && launched.data.operationId !== operation.operationId) ||
          (expectedLifetime && !sameLifetime(parseExecutionLifetime(launched.data.effectiveExecutionLifetime), expectedLifetime)))
          return this.recordStageSkipFailure(run, operation, "Fusion ownership is unresolved during skip.");
        const attached = await this.updateActiveOperation(
          run,
          operation.operationId,
          {
            externalRunId: state.runId,
            recovery: OPERATION_RECOVERY.OBSERVE,
          },
        );
        return this.advanceStageSkip(attached);
      }
      const owner = bridgeOperationOwner(run, operation);
      const lookup = await this.bridge.operation(operation.operationId, owner);
      if (!lookup.success)
        return this.recordStageSkipFailure(
          run,
          operation,
          `Unable to look up bridge operation: ${lookup.error.message}`,
        );
      if (isFencedCancellation(lookup.data, operation)) {
        const fenced = await this.updateActiveOperation(run, operation.operationId, { launchFenced: true, stopAcknowledged: true });
        return this.advanceStageSkip(fenced);
      }
      const lookupState = text(lookup.data.state);
      if (lookupState === EXTERNAL_OPERATION_STATE.PENDING)
        return this.registry.heartbeat(run);
      if (
        lookupState === EXTERNAL_OPERATION_STATE.ABSENT ||
        lookupState === EXTERNAL_OPERATION_STATE.UNKNOWN
      )
        return this.recordStageSkipFailure(
          run,
          operation,
          `Bridge operation lookup is ${lookupState}; force-skip cannot prove the worker is terminal.`,
        );
      if (lookupState !== EXTERNAL_OPERATION_STATE.FOUND)
        return this.recordStageSkipFailure(
          run,
          operation,
          "Bridge operation lookup returned an invalid state during force-skip.",
        );
      const expectedLifetime = operationExpectedLifetime(operation);
      if ((owner && lookup.data.requestDigest !== owner.requestDigest) ||
        (lookup.data.operationId !== undefined && lookup.data.operationId !== operation.operationId) ||
        (expectedLifetime && !sameLifetime(parseExecutionLifetime(lookup.data.effectiveExecutionLifetime), expectedLifetime)))
        return this.recordStageSkipFailure(run, operation, "Bridge ownership is unresolved during skip.");
      const externalRunId = text(lookup.data.runId);
      if (!externalRunId)
        return this.fail(
          run,
          "Bridge operation lookup omitted a run ID during force-skip.",
          true,
        );
      const asyncDir = text(lookup.data.asyncDir);
      const attached = await this.updateActiveOperation(
        run,
        operation.operationId,
        {
          externalRunId,
          recovery: OPERATION_RECOVERY.OBSERVE,
          ...(asyncDir ? { asyncDir } : {}),
        },
      );
      return this.advanceStageSkip(attached);
    }

    const status =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridgeStatus(run, operation)
        : await (await this.reviewClient(run)).status(operation.externalRunId);
    if (!status.success)
      return this.recordStageSkipFailure(
        run,
        operation,
        `Unable to observe ${operation.service}/${operation.kind}: ${status.error.message}`,
      );
    const observed = await this.updateActiveOperation(
      run,
      operation.operationId,
      { lastObservedAt: Date.now() },
    );
    if (!sameOperationState(run, observed, operation)) return observed;
    const fusion =
      operation.service === OPERATION_SERVICE.FUSION
        ? fusionState(status.data)
        : undefined;
    const state =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? text(status.data.state)
        : fusion?.phase;
    if (!state)
      return this.recordStageSkipFailure(
        observed,
        observed.activeOperation ?? operation,
        `${operation.service} status omitted the operation state`,
      );
    const terminal =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? isTerminalBridgeOperationState(state)
        : fusion?.terminal === true;
    if (terminal && hasProcessExit(status.data, operation)) return this.finishStageSkip(observed, state);
    if (operation.service === OPERATION_SERVICE.BRIDGE) {
      if (state === EXTERNAL_OPERATION_STATE.PENDING) return observed;
      if (!isActiveBridgeOperationState(state))
        return this.recordStageSkipFailure(
          observed,
          observed.activeOperation ?? operation,
          `Bridge returned unrecognized non-terminal state during force-skip: ${state}`,
        );
    }
    return observed;
  }

  private recordStageSkipFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = (operation.skipFailures ?? 0) + 1;
    const failedRun = {
      ...run,
      activeOperation: {
        ...operation,
        skipFailures: failures,
        lastSkipError: error,
      },
    };
    if (failures >= MAX_STATUS_FAILURES)
      return this.fail(
        failedRun,
        `Unable to finish force-skip after ${failures} attempts; automatic retry continues: ${error}`,
        true,
      );
    return this.registry.heartbeat(failedRun);
  }

  private async finishStageSkip(
    run: PlanExecRun,
    terminalOperationState: string,
  ): Promise<PlanExecRun> {
    const request = run.pendingStageSkip;
    if (!request) return this.fail(run, "Force-skip request is missing.");
    const operation = run.activeOperation;
    const existingFindingIds = new Set(
      run.unresolvedFindings.map((finding) => finding.id),
    );
    const unresolvedFindings = [
      ...run.unresolvedFindings,
      ...run.reviewFindings.filter(
        (finding) => !existingFindingIds.has(finding.id),
      ),
    ];
    const verificationRequired = request.stage === RUN_STAGE.FINALIZE;
    const next = verificationRequired ? RUN_STAGE.FINALIZE : nextStage(request.stage);
    const ready = clearError(
      withoutOperation({
        ...run,
        status: RUN_STATUS.RUNNING,
        stage: next,
        userStopped: false,
        nextAttemptAt: 0,
        reviewFindings: [],
        unresolvedFindings,
        skippedStages: verificationRequired ? run.skippedStages : [
          ...run.skippedStages,
          {
            ...request,
            completedAt: Date.now(),
            ...(operation
              ? {
                  operationId: operation.operationId,
                  ...(operation.externalRunId
                    ? { externalRunId: operation.externalRunId }
                    : {}),
                }
              : {}),
            terminalOperationState,
          },
        ],
      }),
    );
    delete ready.pendingStageSkip;
    const completion = await this.registry.updateIfCurrent(ready, run.updatedAt);
    if (!completion.applied) return completion.run;
    const persisted = completion.run;
    await appendProgressBestEffort(
      persisted,
      verificationRequired
        ? "Retired the pending finalizer skip; continuing required candidate verification."
        : `FORCE-SKIPPED ${request.stage} by ${request.requestedBy}: ${request.reason}\nOperation state: ${terminalOperationState}\nNext stage: ${next}`,
    );
    return this.advanceUnlocked(persisted);
  }

  private async cancel(run: PlanExecRun): Promise<PlanExecRun> {
    run = await this.reconcileLocalCancellation(run);
    if (run.status !== RUN_STATUS.CANCEL_PENDING) return run;
    if (run.activeOperation?.stopRequested && (run.nextAttemptAt ?? 0) > Date.now()) return run;
    run = await this.requestOperationCancellation(run);
    if (run.status !== RUN_STATUS.CANCEL_PENDING) return run;
    if (run.localOperationActive) return run;
    const operation = run.activeOperation;
    if (!operation)
      return this.registry.release(
        await this.registry.update({
          ...run,
          status: RUN_STATUS.CANCELLED,
        }),
      );
    if (operation.launchFenced) return this.registry.release(await this.registry.update(withoutOperation({ ...run, status: RUN_STATUS.CANCELLED })));
    if (!operation.externalRunId) return this.recoverActiveOperation(run, operation);
    const terminal =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridgeStatus(run, operation)
        : await (await this.reviewClient(run)).status(operation.externalRunId);
    if (!terminal.success)
      return this.recordCancellationFailure(
        run,
        operation,
        terminal.error.message,
      );
    const observed = await this.recordObservation(
      run,
      operation,
      terminal.data.text,
    );
    const bridgeState =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? text(terminal.data.state)
        : fusionState(terminal.data)?.phase;
    if (!hasProcessExit(terminal.data, operation)) {
      return observed;
    }
    const cancelled = withoutOperation({
      ...observed,
      status: RUN_STATUS.CANCELLED,
    });
    await appendProgress(
      cancelled,
      `Cancellation completed after owned process-tree retirement (${operation.kind}, wrapper state ${bridgeState ?? "unavailable"}).`,
    );
    return this.registry.release(await this.registry.update(cancelled));
  }

  private async adoptActiveOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation?.externalRunId) return run;
    if (operation.service === OPERATION_SERVICE.BRIDGE) {
      const adopted = await this.bridge.adopt(
        operation.externalRunId,
        operation.asyncDir,
      );
      if (adopted.success) {
        const asyncDir = text(adopted.data.asyncDir);
        return this.registry.update({
          ...run,
          activeOperation: {
            ...operation,
            recovery: OPERATION_RECOVERY.OBSERVE,
            ...(asyncDir ? { asyncDir } : {}),
          },
        });
      }
      return this.recordObservationFailure(
        run,
        operation,
        `Unable to adopt bridge operation: ${adopted.error.message}`,
      );
    }
    const adopted = await (await this.reviewClient(run)).adopt(operation.externalRunId);
    return adopted.success
      ? this.updateActiveOperation(run, operation.operationId, {
          recovery: OPERATION_RECOVERY.OBSERVE,
        })
      : this.recordObservationFailure(
          run,
          operation,
          `Unable to adopt Fusion operation: ${adopted.error.message}`,
        );
  }

  private async bridgeOutput(operation: ActiveOperation): Promise<string> {
    const result = await this.bridge.result(
      operation.externalRunId!,
      operation.asyncDir,
    );
    try {
      return await readSubagentArtifact(
        result.success ? text(result.data.resultPath) : undefined,
        operation.asyncDir,
        { runId: operation.externalRunId!, successful: operation.kind === OPERATION_KIND.REVIEW,
          ...(text(operation.params?.agent) ? { agent: text(operation.params?.agent)! } : {}) },
      );
    } catch (error) {
      if (!result.success) throw new Error(result.error.message, { cause: error });
      throw error;
    }
  }

  private async transition(
    run: PlanExecRun,
    stage: RunStage,
    message: string,
  ): Promise<PlanExecRun> {
    const transitioned = await this.registry.update({
      ...clearError(withoutOperation(run)),
      stage,
      status: RUN_STATUS.RUNNING,
      nextAttemptAt: 0,
      recoveryAttempts: 0,
    });
    await appendProgress(transitioned, message);
    return transitioned;
  }

  private async fail(
    run: PlanExecRun,
    error: string,
    preserveOperation = false,
  ): Promise<PlanExecRun> {
    const failedOperation = run.activeOperation ?? run.failedOperation;
    const failed = await this.registry.update({
      ...withoutOperation({ ...run,
        status: run.status === RUN_STATUS.CANCEL_PENDING || run.status === RUN_STATUS.SKIP_PENDING || run.status === RUN_STATUS.PAUSED ? run.status : RUN_STATUS.RUNNING,
        error, recoveryAttempts: (run.recoveryAttempts ?? 0) + 1,
        nextAttemptAt: Date.now() + retryDelay(run.config.retryDelayMs, (run.recoveryAttempts ?? 0) + 1), wakeReason: error, needsAttention: true }),
      ...(failedOperation ? { failedOperation } : {}),
      ...(preserveOperation ? { activeOperation: run.activeOperation } : {}),
    });
    try {
      if (!run.archiveOperation && !(run.outputPromotion?.commandStarted && run.outputPromotion.state === EXTERNAL_OPERATION_STATE.PENDING) && run.lanePreparation?.state !== "create")
        await appendProgress(failed, `Automatic recovery scheduled at ${failed.stage}: ${error}`);
    } catch {
      // The registry is authoritative if the optional progress file is unavailable.
    }
    return failed;
  }
}

function bridgeTerminalError(
  data: Record<string, unknown>,
): string | undefined {
  const statusText = text(data.text);
  if (!statusText) return undefined;
  const error = statusText.match(/^Error:\s*(.+)$/m)?.[1] ?? statusText;
  return error.trim().slice(0, MAX_TERMINAL_ERROR_LENGTH);
}

function hasProcessExit(data: Record<string, unknown>, operation: ActiveOperation): boolean {
  if (!operation.externalRunId || !operation.requestDigest) return false;
  return hasTerminalOwnershipProof(data, operation.externalRunId, {
    operationId: operation.operationId, requestDigest: operation.requestDigest,
  });
}

function isFencedReviewCancellation(data: Record<string, unknown>, operation: ActiveOperation): boolean {
  return data.operationId === operation.operationId && data.state === RUN_STATUS.CANCELLED && data.replaySafe === false &&
    data.neverStarted === true && data.cancellationRequested === true &&
    (data.requestDigest === undefined || data.requestDigest === operation.requestDigest);
}

function isBoundNeverStarted(data: Record<string, unknown>, operation: ActiveOperation): boolean {
  return data.neverStarted === true && data.operationId === operation.operationId &&
    Boolean(operation.requestDigest) && data.requestDigest === operation.requestDigest;
}

function isFencedCancellation(data: Record<string, unknown>, operation: ActiveOperation): boolean {
  return operation.service === OPERATION_SERVICE.BRIDGE
    ? data.operationId === operation.operationId && data.state === RUN_STATUS.CANCELLED && data.neverStarted === true &&
      data.cancellationRequested === true && operation.requestDigest !== undefined && data.requestDigest === operation.requestDigest
    : isFencedReviewCancellation(data, operation);
}

function supportsExecution(capabilities: FusionCapabilities | undefined, lifetime: ExecutionLifetime): boolean {
  return capabilities?.healthy === true && capabilities.durableOperationLookup &&
    supportsOwnedProcessTree(capabilities) &&
    capabilities.processTerminalProofVersion === 1 && capabilities.executionLifetimeVersion === 1 &&
    capabilities.executionLifetimeModes?.includes(lifetime.mode) === true;
}

function sameLifetime(actual: ExecutionLifetime | undefined, expected: ExecutionLifetime): boolean {
  return actual?.mode === expected.mode && (actual.mode === "unbounded" ||
    (expected.mode === "bounded" && actual.timeoutMs === expected.timeoutMs));
}

function operationExpectedLifetime(operation: ActiveOperation): ExecutionLifetime | undefined {
  return operation.expectedLifetime ?? parseExecutionLifetime(operation.params?.executionLifetime) ?? operation.effectiveLifetime;
}

function budgetKey(run: PlanExecRun, kind: ActiveOperation["kind"], taskId?: number): string {
  return taskId === undefined ? `${run.stage}:${kind}` : `task:${taskId}`;
}

function attemptExecutionLifetime(run: PlanExecRun, kind: ActiveOperation["kind"], taskId?: number): ExecutionLifetime {
  const base = run.config.executionLifetime;
  if (base.mode === "unbounded") return base;
  const growths = run.budgetGrowths?.[budgetKey(run, kind, taskId)] ?? 0;
  return { mode: "bounded", timeoutMs: Math.min(MAX_EXECUTION_TIMEOUT_MS,
    base.timeoutMs * 2 ** Math.min(growths, MAX_LIFETIME_GROWTH_EXPONENT)) };
}

function boundedContinuationPrompt(run: PlanExecRun, kind: ActiveOperation["kind"], prompt: string,
  lifetime: ExecutionLifetime, taskId?: number): string {
  const expiries = run.budgetExhaustions?.[budgetKey(run, kind, taskId)] ?? 0;
  const growths = run.budgetGrowths?.[budgetKey(run, kind, taskId)] ?? 0;
  if (lifetime.mode !== "bounded" || !expiries) return prompt;
  return `${prompt}\nBounded compatibility continuation after ${expiries} confirmed execution-lifetime expiry event(s); ${growths} had recent verified model/tool progress qualifying for growth. This attempt explicitly allows ${lifetime.timeoutMs} ms; the frozen base policy is unchanged. Resume the preserved checkpoint and complete the smallest independently verifiable slice first. Change the previous approach instead of restarting completed work.${lifetime.timeoutMs === MAX_EXECUTION_TIMEOUT_MS ? " The supported timer maximum is reached; narrow the session's scope and checkpoint earlier rather than increasing the timer further." : ""}`;
}

function usefulProgressAtRetirement(operation: ActiveOperation, status: Record<string, unknown>, timeoutMs: number): boolean {
  const proof = status.processTerminalProof ?? status.workflowTerminalProof;
  if (!proof || typeof proof !== "object") return false;
  const outer = proof as Record<string, unknown>;
  const kernel = outer.kernelProof && typeof outer.kernelProof === "object" ? outer.kernelProof as Record<string, unknown> : undefined;
  const retired = kernel?.proof && typeof kernel.proof === "object" ? kernel.proof as Record<string, unknown> : undefined;
  const retiredAt = typeof retired?.observedAt === "string" ? Date.parse(retired.observedAt) : outer.observedAt;
  if (typeof retiredAt !== "number" || !Number.isFinite(retiredAt) || retiredAt > Date.now()) return false;
  const activity = operation.diagnostics;
  const toolAt = activity?.lastToolActivityAt;
  const candidates = [activity?.lastModelActivityAt,
    toolAt && (!activity?.lastToolFailure || activity.lastToolFailure.observedAt < toolAt) ? toolAt : undefined];
  const window = Math.min(BUDGET_PROGRESS_WINDOW_MS, Math.max(1, Math.floor(timeoutMs / BUDGET_PROGRESS_WINDOW_DIVISOR)));
  return candidates.some((at) => at !== undefined && at >= (operation.launchStartedAt ?? retiredAt) && at <= retiredAt && retiredAt - at <= window);
}

function fusionTerminalError(
  state: Pick<FusionRunState, "phase" | "error">,
  fallbackError?: string,
): string {
  const error = (state.error ?? fallbackError)?.trim().slice(
    0,
    MAX_TERMINAL_ERROR_LENGTH,
  );
  return error
    ? `Fusion run ${state.phase}: ${error}`
    : `Fusion run ${state.phase}.`;
}

function operationFailureMessage(
  message: string,
  terminalError?: string,
): string {
  return terminalError ? `${message} ${terminalError}` : message;
}

function withTerminalError(
  run: PlanExecRun,
  operation: ActiveOperation,
  terminalError?: string,
): PlanExecRun {
  if (!terminalError) return run;
  return {
    ...run,
    activeOperation: {
      ...(run.activeOperation ?? operation),
      terminalError,
    },
  };
}

function isSuccessfulOperationState(state: string): boolean {
  return (
    state === EXTERNAL_OPERATION_STATE.COMPLETE ||
    state === EXTERNAL_OPERATION_STATE.DONE
  );
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|specs?)\//iu.test(path) ||
    /\.(?:test|spec)\.[a-z0-9]+$/iu.test(path);
}

function isActiveBridgeOperationState(state: string): boolean {
  return (
    state === EXTERNAL_OPERATION_STATE.RUNNING ||
    state === EXTERNAL_OPERATION_STATE.STOPPING
  );
}

function isTerminalBridgeOperationState(state: string): boolean {
  return TERMINAL_BRIDGE_OPERATION_STATES.has(state);
}

function resetOperationFailures(
  operation: ActiveOperation | undefined,
): ActiveOperation | undefined {
  if (!operation) return undefined;
  const reset = { ...operation };
  delete reset.statusFailures;
  delete reset.lastStatusError;
  delete reset.skipFailures;
  delete reset.lastSkipError;
  return reset;
}

async function appendProgressOnceBestEffort(
  run: PlanExecRun,
  message: string,
): Promise<void> {
  try {
    await appendProgressOnce(run, message);
  } catch {
    // Observation progress is diagnostic; registry state remains authoritative.
  }
}

async function appendProgressBestEffort(
  run: PlanExecRun,
  message: string,
): Promise<void> {
  try {
    await appendProgress(run, message);
  } catch {
    // The durable run record is authoritative. Progress logging must not split a
    // completed state transition into a second partially applied operation.
  }
}

function completionStatus(run: PlanExecRun) {
  return run.unresolvedFindings.length > 0 || run.skippedStages.length > 0
    ? RUN_STATUS.COMPLETED_WITH_FINDINGS
    : RUN_STATUS.COMPLETED;
}

function withoutRecoveryModel(run: PlanExecRun): PlanExecRun {
  const copy = { ...run };
  delete copy.recoveryModel;
  return copy;
}

function withoutLegacyRecoveryModelPins(run: PlanExecRun): PlanExecRun {
  if (
    !run.config.workerModel &&
    !run.config.reviewerModel &&
    !run.config.statsModel
  )
    return run;
  const config = { ...run.config };
  delete config.workerModel;
  delete config.reviewerModel;
  delete config.statsModel;
  return { ...run, config };
}

function recoveryConfig(run: PlanExecRun): FrozenRunConfig {
  let config = run.config;
  if (
    run.stage === RUN_STAGE.IMPLEMENTATION ||
    run.stage === RUN_STAGE.FINALIZE
  )
    config = {
      ...config,
      workerMaxTurns: Math.max(
        config.workerMaxTurns,
        RECOVERY_WORKER_MAX_TURNS,
      ),
    };
  else if (run.stage === RUN_STAGE.STATS)
    config = {
      ...config,
      statsMaxTurns: Math.max(
        config.statsMaxTurns,
        RECOVERY_REVIEWER_MAX_TURNS,
      ),
    };
  else if (isReviewStage(run.stage))
    config = {
      ...config,
      reviewerMaxTurns: Math.max(
        config.reviewerMaxTurns,
        RECOVERY_REVIEWER_MAX_TURNS,
      ),
    };
  if (!isModelProviderFailure(run)) return config;
  if (
    run.stage === RUN_STAGE.IMPLEMENTATION ||
    run.stage === RUN_STAGE.FINALIZE ||
    run.failedOperation?.kind === OPERATION_KIND.FIX
  )
    return withoutRoleModel(config, "workerModel");
  if (run.stage === RUN_STAGE.STATS)
    return withoutRoleModel(config, "statsModel");
  if (
    isReviewStage(run.stage) &&
    run.failedOperation?.kind !== OPERATION_KIND.FUSION
  )
    return withoutRoleModel(config, "reviewerModel");
  return config;
}

function withoutRoleModel(
  config: FrozenRunConfig,
  key: "workerModel" | "reviewerModel" | "statsModel",
): FrozenRunConfig {
  const copy = { ...config };
  delete copy[key];
  return copy;
}

function bridgeModel(
  config: FrozenRunConfig,
  kind: ActiveOperation["kind"],
): string | undefined {
  if (kind === OPERATION_KIND.STATS) return config.statsModel;
  if (kind === OPERATION_KIND.REVIEW) return config.reviewerModel;
  return config.workerModel;
}

function workerPrompt(
  run: PlanExecRun,
  taskId: number,
  title: string,
  unchecked: string[],
): string {
  const execution = run.tasks?.[String(taskId)];
  const recoveryStrategy = (execution?.attempts ?? 0) % 2 === 0
    ? "First reproduce the previous failure with the smallest concrete check; inspect its root cause and change the failing approach before implementation."
    : "First audit the preserved checkpoint and prerequisite evidence, compare a simpler alternative approach, then validate the smallest repair before broader work.";
  return [
    "You are the sole implementation worker for a ralphex plan run.",
    `Run: ${run.id}`,
    `Plan: ${run.planPath}`,
    `Task ${taskId}: ${title}`,
    `Attempt ${(execution?.attempts ?? 0) + 1}. Previous concrete failure: ${execution?.reason ?? "none"}.`,
    ...(execution?.reason ? [recoveryStrategy, "Do not repeat an unchanged failed action without new evidence that its prerequisite recovered. If still unavailable, report the current evidence and preserve the checkpoint."] : []),
    "Complete only this task. Inspect and preserve valid work already present in the worktree before making changes, then run relevant verification, commit your work, and mark only its completed plan checkboxes [x].",
    "Change only checkbox markers from [ ] to [x]. Do not change checkbox text, headings, task numbers, or add/remove plan items.",
    "Record verification in your response and progress artifacts, not by rewriting plan item text.",
    "Do not start later tasks. Do not report success until the checkboxes are updated and verification is complete.",
    `Accepted baseline: ${run.acceptedHead ?? "current HEAD"}. When resuming a preserved lane, checkpoint only known task source changes on its existing branch, then integrate this accepted baseline before implementing further. Preserve untracked and ignored artifacts; never stage secrets or generated output. Resolve integration conflicts and verify the combined candidate before committing.`,
    ...(execution?.recoverySource ? [
      `Recovery source working files are read-only: ${execution.recoverySource.cwd} (branch ${execution.recoverySource.branch}, recorded HEAD ${execution.recoverySource.headCommit}). Preserve their exact bytes and all unrelated untracked/ignored files.`,
      `This new verification lane starts from the latest accepted baseline. Checkpoint only known task source on the original task branch without changing its working-file bytes, retain that commit at ${execution.recoverySource.checkpointRef}, then integrate the checkpoint here. Do not stage secret, generated, unrelated, or ambiguous user files; report a concrete prerequisite if a safe checkpoint is impossible. The checkpoint must descend from the recorded source HEAD and be an ancestor of the final candidate.`,
    ] : []),
    ...(execution?.recoveryHistory?.length ? [`Earlier preserved source checkpoints must remain recoverable and ancestral to the candidate: ${execution.recoveryHistory.map((source) => `${source.checkpointRef} (${source.cwd})`).join(", ")}.`] : []),
    `Already accepted tasks: ${Object.values(run.tasks ?? {}).filter((task) => task.state === "accepted").map((task) => task.taskId).join(", ") || "none"}. Preserve their implementation and reflect their accepted checkbox completion when integrating the plan.`,
    `If a required approval, external prerequisite, or verification cannot be satisfied, do not invent evidence, skip it, or make dummy edits. Leave incomplete checkboxes open and start your final response with ${TASK_FAILED_MARKER} on its own line, followed by Blocker: <exact reason> and Next step: <what is needed>. Partial work is preserved and recovery will be scheduled automatically.`,
    "Only when you actually observed an external prerequisite failure, also include Prerequisite: credentials|permission|missing_executable|runtime and Evidence: <the exact observed provider error or failed command result>. Do not invent these fields from a guess, silence, elapsed time, or a generic failure. Recheck the prerequisite on the next automatically scheduled attempt.",
    "A supervisor stop decision is final for this attempt. Return the blocker; do not ask repeatedly or launch another worker.",
    "Remaining checkbox items:",
    ...unchecked.map((item) => `- [ ] ${item}`),
  ].join("\n");
}

function retryDelay(base: number, attempts: number): number {
  return Math.min(MAX_AUTOMATIC_RETRY_DELAY_MS, base * 2 ** Math.min(Math.max(attempts - 1, 0), MAX_BACKOFF_EXPONENT));
}

function parseNativeActivity(value: unknown): { signal?: WorkerSignal; lastActivityAt?: number } {
  if (!value || typeof value !== "object") return {};
  const activity = value as Record<string, unknown>;
  const parts = [text(activity.phase), text(activity.state), text(activity.currentTool)].filter(Boolean);
  const lastActivityAt = typeof activity.lastActivityAt === "number" && Number.isFinite(new Date(activity.lastActivityAt).getTime()) && activity.lastActivityAt > 0
    ? activity.lastActivityAt : undefined;
  return {
    ...(parts.length || lastActivityAt ? { signal: {
      ...(parts.length ? { activity: parts.join(" / ") } : {}),
      ...(lastActivityAt ? { updated: new Date(lastActivityAt).toISOString() } : {}),
    } } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

function nativeUsage(data: Record<string, unknown> | undefined): NonNullable<ActiveOperation["reportedUsage"]> {
  if (!data) return {};
  const status = data.statusPayload && typeof data.statusPayload === "object" ? data.statusPayload as Record<string, unknown> : data;
  const tokens = status.totalTokens && typeof status.totalTokens === "object" ? status.totalTokens as Record<string, unknown> : {};
  const cost = status.totalCost && typeof status.totalCost === "object" ? status.totalCost as Record<string, unknown> : {};
  const input = safeTokenCount(tokens.input) ? tokens.input : cost.inputTokens;
  const output = safeTokenCount(tokens.output) ? tokens.output : cost.outputTokens;
  return { ...(safeTokenCount(input) ? { inputTokens: input } : {}), ...(safeTokenCount(output) ? { outputTokens: output } : {}),
    ...(finiteUsageAmount(cost.costUsd) ? { cost: cost.costUsd } : {}) };
}

function finiteUsageAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeTokenCount(value: unknown): value is number {
  return finiteUsageAmount(value) && Number.isSafeInteger(value);
}

function reviewerPrompt(run: PlanExecRun): string {
  const focus =
    run.stage === RUN_STAGE.COMPREHENSIVE_REVIEW
      ? "quality, implementation correctness, testing, simplification, and documentation"
      : run.stage === RUN_STAGE.SMELLS_REVIEW
        ? "code smells, accidental complexity, dead code, leaky abstractions, and fragile seams"
        : "only CRITICAL and MAJOR correctness, safety, and reliability defects";
  return [
    "You are a read-only code reviewer. Do not edit files or run destructive commands.",
    `Review focus: ${focus}.`,
    run.goal ? `Goal: ${run.goal.text}` : `Plan: ${run.planPath}`,
    `Worktree: ${run.worktreeCwd}`,
    run.goal
      ? `Inspect the implementation and the diff from ${run.outputTarget?.initialHead ?? "the goal start"} to HEAD.`
      : "Inspect the implementation and diff against the default branch.",
    "Return exactly one of:",
    "NO_FINDINGS",
    "or one or more blocks:",
    "FINDING: CRITICAL|MAJOR|MINOR | concise summary",
    "Evidence: file:line and scenario",
    "Fix: concrete correction",
    "Do not include unsupported speculation.",
  ].join("\n");
}

function fusionPrompt(run: PlanExecRun): string {
  return [
    run.goal
      ? "Perform an adversarial implementation review for this completed goal run."
      : "Perform an adversarial implementation review for this completed plan execution.",
    run.goal ? `Goal: ${run.goal.text}` : `Plan: ${run.planPath}`,
    `Worktree: ${run.worktreeCwd}`,
    run.goal
      ? `Inspect the diff from ${run.outputTarget?.initialHead ?? "the goal start"} to HEAD.`
      : `Default branch: ${run.defaultBranch}`,
    "Return findings using the exact review contract:",
    "NO_FINDINGS",
    "or FINDING: CRITICAL|MAJOR|MINOR | summary, followed by Evidence: and Fix: lines.",
  ].join("\n");
}

function fixerPrompt(
  run: PlanExecRun,
  findings: ReviewFinding[],
  rawOutput: string,
): string {
  return [
    run.goal
      ? "You are the sole worker fixing review findings in an existing goal run."
      : "You are the sole worker fixing review findings in an existing plan execution.",
    run.goal ? `Goal: ${run.goal.text}` : `Plan: ${run.planPath}`,
    `Stage: ${run.stage}`,
    ...(run.reviewRecovery && run.reviewRecovery.repeats > 1 ? [
      `The same normalized findings remain after ${run.reviewRecovery.repeats} reviews, including commit ${run.reviewRecovery.lastReviewedCommit ?? "unavailable"}. Commit creation has not resolved them.`,
      "Change the diagnosis before editing again: reproduce each blocking scenario, identify why the previous fix missed it, and validate a different repair against that reproduction. Do not repeat the same edit or dismiss the finding to finish.",
    ] : []),
    "Apply only justified findings, run relevant verification, and commit the fixes.",
    run.goal
      ? "Do not weaken, delete, or skip tests to satisfy a finding; the goal completion guard checks the final commit."
      : "Do not modify plan task checkboxes unless the implementation task itself requires it.",
    "Structured findings:",
    formatFindings(findings),
    "Raw reviewer output:",
    rawOutput,
  ].join("\n\n");
}

function reviewFingerprint(findings: ReviewFinding[]): string {
  const normalized = [...new Set(findings.map((finding) =>
    `${finding.severity}:${normalizedSummary(finding.summary)}`))].sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizedSummary(summary: string): string {
  return summary.trim().replace(/\s+/g, " ").toLowerCase();
}

function reconcileTaskFacts(plan: ParsedPlan, existing: PlanExecRun["tasks"]) {
  const tasks = reconcileTasks(plan.tasks, existing);
  for (const task of plan.tasks) {
    const execution = tasks[String(task.id)]!;
    if (execution.state !== "accepted" || task.unchecked.length === 0) continue;
    const reopened = { ...execution, state: "ready" as const };
    delete reopened.laneCwd;
    delete reopened.laneBranch;
    delete reopened.baselineCommit;
    delete reopened.candidateCommit;
    delete reopened.operationId;
    tasks[String(task.id)] = reopened;
  }
  return reconcileTasks(plan.tasks, tasks);
}

function assertAcceptedCheckboxes(run: PlanExecRun, plan: ParsedPlan): void {
  if (plan.hash !== run.planHash) throw new Error(PLAN_STRUCTURE_CHANGED_ERROR);
  for (const task of Object.values(run.tasks ?? {})) {
    if (task.state !== "accepted") continue;
    if (plan.tasks.find((entry) => entry.id === task.taskId)?.unchecked.length !== 0)
      throw new Error(`Previously accepted task ${task.taskId} has reopened or missing committed checkboxes.`);
  }
}

function statsPrompt(run: PlanExecRun): string {
  return [
    "Produce compact execution statistics without editing files.",
    run.goal ? `Goal: ${run.goal.text}` : `Plan: ${run.planPath}`,
    ...(run.goal ? [`Turns: ${run.goal.iteration}/${run.goal.maxTurns}`, `Checks: ${run.goal.lastCheck?.failures ? "failing" : "passing"}`] : []),
    `Worktree: ${run.worktreeCwd}`,
    "Use git churn and available artifacts. Return concise Markdown with changed files, commits, verification, and residual findings.",
  ].join("\n");
}

function withoutOperation(run: PlanExecRun): PlanExecRun {
  const next = { ...run };
  delete next.activeOperation;
  return next;
}

function clearError(run: PlanExecRun): PlanExecRun {
  const next = { ...run };
  delete next.error;
  delete next.failedOperation;
  delete next.blocked;
  return next;
}

function sameOperationState(
  before: PlanExecRun,
  after: PlanExecRun,
  operation: ActiveOperation,
): boolean {
  return (
    after.status === before.status &&
    after.activeOperation?.operationId === operation.operationId
  );
}

export const TASK_RETRY_OPTION = "--retry-task";

function taskFailureReason(output: string | undefined): string | undefined {
  const lines = output?.trim().split(/\r?\n/);
  if (lines?.[0]?.trim() !== TASK_FAILED_MARKER) return undefined;
  const report = lines.slice(1).join("\n").trim();
  return (report || "Worker reported TASK_FAILED without a reason; inspect its output before retrying.")
    .slice(0, MAX_TERMINAL_ERROR_LENGTH);
}

function parseExternalPrerequisite(value: unknown, source: ExternalPrerequisite["source"]): ExternalPrerequisite | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "credentials" && kind !== "permission" && kind !== "missing_executable" && kind !== "runtime") return undefined;
  const evidence = text(input.evidence);
  return evidence ? { kind, source, evidence: evidence.slice(0, MAX_TERMINAL_ERROR_LENGTH) } : undefined;
}

function workerExternalPrerequisite(output: string | undefined): ExternalPrerequisite | undefined {
  if (!taskFailureReason(output)) return undefined;
  const kind = output?.match(/^Prerequisite:\s*(credentials|permission|missing_executable|runtime)\s*$/m)?.[1];
  const evidence = output?.match(/^Evidence:\s*(.+)$/m)?.[1];
  return parseExternalPrerequisite({ kind, evidence }, "worker");
}

export function isDetachedWorkflowFailure(run: PlanExecRun): boolean {
  if (
    run.status !== RUN_STATUS.FAILED ||
    run.failedOperation?.service !== OPERATION_SERVICE.BRIDGE ||
    !run.failedOperation.externalRunId
  )
    return false;
  return [run.error, run.failedOperation.terminalError].some((value) =>
    /\b(?:operation ended as paused|run ['"]?main['"]? detached)\b/i.test(
      value ?? "",
    ),
  );
}

export function isRecoverableImplementationFailure(run: PlanExecRun): boolean {
  return (
    run.status === RUN_STATUS.FAILED &&
    run.stage === RUN_STAGE.IMPLEMENTATION &&
    run.activeOperation === undefined &&
    (/^Worker .+ ended as .+ and left task \d+ checkboxes unchecked\.$/.test(
      run.error ?? "",
    ) ||
      /Task \d+ exhausted its retry limit\./.test(run.error ?? ""))
  );
}

export function isExternalManualBlocker(run: PlanExecRun): boolean {
  if (run.stage !== RUN_STAGE.IMPLEMENTATION || run.activeOperation)
    return false;
  return Boolean(run.blocked) || recoveryEvidence(run).includes(TASK_FAILED_MARKER) ||
    /\b(billing|payment|quota|rate[- ]limit|provider|credential|authentication|authorization|permission|unavailable|outage|network|manual|external|checkpoint)\b/i.test(
      recoveryEvidence(run),
    );
}

export function isTaskRetryConfirmationRequired(run: PlanExecRun): boolean {
  if (isGoalRun(run)) return false;
  return (
    (run.status === RUN_STATUS.FAILED ||
      (run.status === RUN_STATUS.PAUSED && run.blocked !== undefined)) &&
    run.stage === RUN_STAGE.IMPLEMENTATION &&
    run.activeOperation === undefined &&
    !isModelProviderFailure(run) &&
    isExternalManualBlocker(run)
  );
}

export function isModelProviderFailure(run: PlanExecRun): boolean {
  return !run.blocked && isModelProviderFailureText(recoveryEvidence(run));
}

function isModelProviderFailureText(value: string | undefined): boolean {
  if (!value) return false;
  return (
    /string_above_max_length.*call[_ -]?id|call[_ -]?id.*(?:string_above_max_length|maximum length)/i.test(
      value,
    ) ||
    /out of extra usage/i.test(value) ||
    /model .*(?:not found|does not exist|unavailable)/i.test(value) ||
    /(?:invalid|missing) api key|authentication failed/i.test(value) ||
    /invalid_grant|refresh token expired|oauth .*refresh.*failed/i.test(value)
  );
}

export function taskRetryRequiredMessage(run: PlanExecRun): string {
  const taskId =
    run.blocked?.taskId ??
    run.failedOperation?.taskId ??
    run.error?.match(/Task (\d+)/)?.[1] ??
    run.error?.match(/task (\d+)/i)?.[1] ??
    "the incomplete task";
  return [
    `Task ${taskId} is blocked; no automatic retry will be started.`,
    run.blocked?.reason ?? run.failedOperation?.terminalError ?? run.error ?? "Inspect the worker output for the blocker.",
    "Resolve the reported prerequisite or record the required operator decision first. Retrying does not waive plan requirements.",
    `Implementation checkboxes are sequential; the controller cannot bypass an incomplete implementation task. Re-run the same task only with /exec resume ${run.id} ${TASK_RETRY_OPTION}.`,
  ].join(" ");
}

function recoveryEvidence(run: PlanExecRun): string {
  return [
    run.error,
    run.activeOperation?.lastLaunchError,
    run.activeOperation?.lastStatusError,
    run.failedOperation?.lastLaunchError,
    run.failedOperation?.lastStatusError,
    run.failedOperation?.terminalError,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function isRecoverableFailure(run: PlanExecRun): boolean {
  return isRecoverableRun(run);
}

function gitPath(path: string): string {
  return path.split(sep).join("/");
}

function isInsideWorktree(path: string): boolean {
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

async function assertNoSymlinkPath(
  worktreeCwd: string,
  target: string,
): Promise<void> {
  const root = resolve(worktreeCwd);
  let current = resolve(target);
  while (current !== root) {
    const currentRelative = relative(root, current);
    if (!isInsideWorktree(currentRelative))
      throw new Error(`Archive path escapes the execution worktree: ${target}.`);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Archive path uses a symbolic link: ${target}.`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  if ((await lstat(root)).isSymbolicLink())
    throw new Error(`Execution worktree is a symbolic link: ${worktreeCwd}.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function bridgeOperationOwner(
  run: PlanExecRun,
  operation: ActiveOperation | undefined,
): BridgeOperationOwner | undefined {
  if (!operation?.params) return undefined;
  return {
    kind: "pi-plan-exec",
    runId: run.id,
    key: operation.operationId,
    requestDigest:
      operation.requestDigest ?? bridgeRequestDigest(operation.params),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `Step 1:`, `Step 1/3 Agent 2/2:`, `Agent 1/2:`, `Workflow child build:`. */
const WORKER_SIGNAL_STEP_LINE =
  /^(?:Step\b|Agent \d|Workflow child\b)[^:]*:\s*(?<detail>.+)$/;
const MAX_WORKER_SIGNAL_STEPS = 5;

/**
 * Digest the provider status blob. The format is upstream's, so nothing here
 * may throw: unreadable status text yields no signal, not a failed run.
 *
 * No liveness fact is persisted. Anything stamped by the polling session
 * freezes when that session dies, which is exactly when it matters; the read
 * surface measures liveness live instead.
 */
export function parseWorkerSignal(value: unknown): WorkerSignal | undefined {
  const blob = text(value);
  if (!blob) return undefined;
  const lines = blob.split("\n").map((line) => line.trim());
  const field = (label: string): string | undefined => {
    const prefix = `${label}: `;
    return text(
      lines.find((line) => line.startsWith(prefix))?.slice(prefix.length),
    );
  };
  // Read every field before deciding: upstream renders `Mode:` after
  // `Activity:`, so a single forward pass would judge activity too early.
  const mode = field("Mode");
  const workflow = mode === WORKFLOW_MODE;
  // Workflow-mode step lines carry the same launch-anchored activity fragment
  // as `Activity:`, so they are dropped whole rather than edited.
  const steps = workflow
    ? []
    : lines
        .map((line) => WORKER_SIGNAL_STEP_LINE.exec(line)?.groups?.detail)
        .filter((detail): detail is string => Boolean(detail))
        .slice(0, MAX_WORKER_SIGNAL_STEPS);
  const activity = workflow ? undefined : field("Activity");
  const progress = field("Progress");
  const turnBudget = field("Turn budget");
  const updated = field("Updated");
  const signal: WorkerSignal = {
    ...(mode ? { mode } : {}),
    ...(activity ? { activity } : {}),
    ...(progress ? { progress } : {}),
    ...(turnBudget ? { turnBudget } : {}),
    ...(updated ? { updated } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
  return Object.keys(signal).length > 0 ? signal : undefined;
}
