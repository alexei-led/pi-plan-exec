import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { readSubagentArtifact } from "./artifact.js";
import { fusionState } from "./fusion.js";
import {
  branchNameFromPlan,
  createWorktree,
  currentBranch,
  defaultBranch,
  ensureCleanForWorktree,
  requireGitRepository,
  verifyExecutionRepository,
  verifyExecutionTree,
  worktreePlanPath,
  type RunCommand,
} from "./git.js";
import {
  isRecoverableRun,
  isReviewStage,
  isSkippableStage,
  isTerminalStatus,
  nextStage,
} from "./lifecycle.js";
import { readPlan } from "./plan.js";
import { appendProgress, initializeProgress } from "./progress.js";
import { RunRegistry } from "./registry.js";
import {
  formatFindings,
  hasBlockingFindings,
  parseReviewFindings,
} from "./review.js";
import {
  COMPLETED_PLANS_DIRECTORY,
  DEFAULT_FROZEN_RUN_CONFIG,
  EXTERNAL_OPERATION_STATE,
  OPERATION_KIND,
  OPERATION_RECOVERY,
  OPERATION_SERVICE,
  RUN_STAGE,
  RUN_STATUS,
  type ActiveOperation,
  type FrozenRunConfig,
  type PlanExecRun,
  type ReviewFinding,
  type RunStage,
} from "./types.js";

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
export const PLAN_STRUCTURE_CHANGED_ERROR =
  "Plan task structure changed outside checkbox completion.";

type ServiceReply =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { code?: string; message: string } };

interface BridgeLike {
  spawn(
    operationId: string,
    params: Record<string, unknown>,
  ): Promise<ServiceReply>;
  operation(operationId: string): Promise<ServiceReply>;
  status(runId: string, asyncDir?: string): Promise<ServiceReply>;
  result(runId: string, asyncDir?: string): Promise<ServiceReply>;
  adopt(runId: string, asyncDir?: string): Promise<ServiceReply>;
  stop(runId: string, asyncDir?: string): Promise<ServiceReply>;
}

interface FusionLike {
  start(
    operationId: string,
    prompt: string,
    profile?: string,
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
  sessionId: string;
}

/** Deterministic controller. It chooses transitions; existing extensions execute work. */
export class PlanExecController {
  constructor(
    private readonly registry: RunRegistry,
    private readonly bridge: BridgeLike,
    private readonly fusion: FusionLike,
    private readonly runCommand: RunCommand,
  ) {}

  async start(options: StartRunOptions): Promise<PlanExecRun> {
    const plan = await readPlan(options.planPath);
    const repositoryRoot = await requireGitRepository(
      this.runCommand,
      options.cwd,
    );
    if (!plan.path.startsWith(repositoryRoot)) {
      throw new Error("Plan must be stored inside the Git repository.");
    }
    const baseBranch = await defaultBranch(this.runCommand, repositoryRoot);
    const current = await currentBranch(this.runCommand, options.cwd);
    const planBranch = branchNameFromPlan(plan.path);
    const branch = options.useWorktree
      ? current === baseBranch
        ? planBranch
        : `${current}-${planBranch}`
      : current;
    const worktreeCwd = options.useWorktree
      ? await this.createExecutionWorktree(repositoryRoot, plan.path, branch)
      : options.cwd;
    const executionPlanPath = options.useWorktree
      ? worktreePlanPath(worktreeCwd, repositoryRoot, plan.path)
      : plan.path;
    if (options.useWorktree)
      await copyPlanIntoWorktree(plan.path, executionPlanPath);

    const run = await this.registry.create({
      schemaVersion: 1,
      repositoryRoot,
      planPath: executionPlanPath,
      planHash: plan.hash,
      worktreeCwd,
      branch,
      defaultBranch: baseBranch,
      status: RUN_STATUS.STARTING,
      stage: RUN_STAGE.RESOLVE,
      taskAttempts: {},
      stageAttempts: {},
      reviewFindings: [],
      config: DEFAULT_FROZEN_RUN_CONFIG,
      unresolvedFindings: [],
      skippedStages: [],
      branchRebindings: [],
    });
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

  async resume(
    runId: string,
    sessionId: string,
    explicit = true,
    reviewedPlanHash?: string,
    retryTask = false,
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.resumeLocked(
        runId,
        sessionId,
        explicit,
        reviewedPlanHash,
        retryTask,
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
  ): Promise<PlanExecRun> {
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    const claimed = await this.registry.claim(existing, sessionId);
    let prepared = claimed;
    if (reviewedPlanHash !== undefined) {
      const adopted = await this.registry.updateIfCurrent(
        {
          ...claimed,
          planHash: reviewedPlanHash,
          status: RUN_STATUS.PAUSED,
        },
        claimed.updatedAt,
      );
      if (!adopted.applied) return adopted.run;
      prepared = adopted.run;
    }
    const preservedOperationId = prepared.activeOperation?.operationId;
    if (explicit && isRecoverableFailure(prepared)) {
      if (isTaskRetryConfirmationRequired(prepared) && !retryTask)
        throw new Error(taskRetryRequiredMessage(prepared));
      prepared = await this.recoverFailedRun(prepared, retryTask);
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
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.rebindBranchAndResumeLocked(runId, sessionId),
    );
    if (coordinated) return coordinated;
    const current = await this.registry.get(runId);
    if (!current) throw new Error(`Plan execution run not found: ${runId}`);
    return current;
  }

  private async rebindBranchAndResumeLocked(
    runId: string,
    sessionId: string,
  ): Promise<PlanExecRun> {
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    const claimed = await this.registry.claim(existing, sessionId);
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
      return this.resumeLocked(runId, sessionId, true);
    return this.advanceUnlocked(rebound.run);
  }

  async skip(
    runId: string,
    sessionId: string,
    reason: string,
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.skipLocked(runId, sessionId, reason),
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
  ): Promise<PlanExecRun> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) throw new Error("Force-skip requires a reason.");
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    const claimed = await this.registry.claim(existing, sessionId);
    if (!isSkippableStage(claimed.stage))
      throw new Error(`Stage ${claimed.stage} cannot be force-skipped.`);
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
    } else if (claimed.status !== RUN_STATUS.SKIP_PENDING) {
      const resetOperation = resetOperationFailures(claimed.activeOperation);
      const persisted = await this.registry.updateIfCurrent(
        clearError({
          ...claimed,
          status: RUN_STATUS.SKIP_PENDING,
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
    const coordinated = await this.registry.withControllerLock(run.id, () =>
      this.advanceUnlocked(run),
    );
    if (coordinated) return coordinated;
    return (await this.registry.get(run.id)) ?? run;
  }

  private async advanceUnlocked(run: PlanExecRun): Promise<PlanExecRun> {
    if (isTerminalStatus(run.status)) return run;
    if (run.status === RUN_STATUS.CANCEL_PENDING) return this.cancel(run);
    if (run.status === RUN_STATUS.SKIP_PENDING)
      return this.advanceStageSkip(run);
    if (run.status === RUN_STATUS.PAUSED) {
      return run.activeOperation ? this.observePausedOperation(run) : run;
    }
    if (run.activeOperation) return this.observeActiveOperation(run);

    await verifyExecutionTree(
      this.runCommand,
      run.worktreeCwd,
      run.repositoryRoot,
      run.branch,
    );
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
          { ...run, progressPath },
          RUN_STAGE.IMPLEMENTATION,
          "Progress log initialized.",
        );
      }
      case RUN_STAGE.IMPLEMENTATION:
        return this.advanceImplementation(run);
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
        return this.archive(run);
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
    const plan = await readPlan(run.planPath);
    if (plan.hash !== run.planHash) {
      return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
    }
    const task = plan.tasks.find((candidate) => candidate.unchecked.length > 0);
    if (!task)
      return this.transition(
        run,
        RUN_STAGE.COMPREHENSIVE_REVIEW,
        "All plan checkboxes are complete.",
      );
    const attempts = run.taskAttempts[String(task.id)] ?? 0;
    if (attempts >= run.config.taskRetries + 1) {
      return this.fail(run, `Task ${task.id} exhausted its retry limit.`);
    }
    if (
      Object.values(run.taskAttempts).reduce((sum, value) => sum + value, 0) >=
      run.config.maxTaskIterations
    ) {
      return this.fail(
        run,
        `Plan execution exceeded ${run.config.maxTaskIterations} task iterations.`,
      );
    }
    return this.launchBridge(run, {
      kind: OPERATION_KIND.IMPLEMENTATION,
      taskId: task.id,
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: workerPrompt(run, task.id, task.title, task.unchecked),
    });
  }

  private async launchReview(run: PlanExecRun): Promise<PlanExecRun> {
    const iteration = (run.stageAttempts[run.stage] ?? 0) + 1;
    const limit =
      run.stage === RUN_STAGE.COMPREHENSIVE_REVIEW
        ? run.config.reviewIterations
        : 1;
    if (iteration > limit) {
      return this.advanceUnlocked(
        await this.recordUnresolvedAndAdvance(run, run.reviewFindings),
      );
    }
    const updated = {
      ...run,
      stageAttempts: { ...run.stageAttempts, [run.stage]: iteration },
      reviewFindings: [],
    };
    return this.launchBridge(updated, {
      kind: OPERATION_KIND.REVIEW,
      reviewIteration: iteration,
      agent: updated.config.reviewerAgent,
      maxTurns: updated.config.reviewerMaxTurns,
      task: reviewerPrompt(updated),
    });
  }

  private async launchFusion(run: PlanExecRun): Promise<PlanExecRun> {
    const iteration =
      (run.stageAttempts[RUN_STAGE.FUSION_REVIEW] ?? 0) + 1;
    if (iteration > run.config.fusionIterations) {
      return this.advanceUnlocked(
        await this.recordUnresolvedAndAdvance(run, run.reviewFindings),
      );
    }
    const operationId = randomUUID();
    const launchStartedAt = Date.now();
    const persisted = await this.registry.updateIfCurrent(
      {
        ...run,
        stageAttempts: {
          ...run.stageAttempts,
          [RUN_STAGE.FUSION_REVIEW]: iteration,
        },
        reviewFindings: [],
        activeOperation: {
          operationId,
          service: OPERATION_SERVICE.FUSION,
          kind: OPERATION_KIND.FUSION,
          reviewIteration: iteration,
          launchStartedAt,
          recovery: OPERATION_RECOVERY.REPLAY,
          params: {
            prompt: fusionPrompt(run),
            ...(run.config.fusionProfile
              ? { profile: run.config.fusionProfile }
              : {}),
          },
        },
      },
      run.updatedAt,
    );
    if (!persisted.applied) return persisted.run;
    const intended = persisted.run;
    const reply = await this.fusion.start(
      operationId,
      text(intended.activeOperation?.params?.prompt) ?? fusionPrompt(intended),
      text(intended.activeOperation?.params?.profile) ??
        intended.config.fusionProfile,
    );
    if (!reply.success) return this.fail(intended, reply.error.message, true);
    const state = fusionState(reply.data);
    if (!state)
      return this.fail(intended, "Fusion start returned no run ID.", true);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId: state.runId,
      recovery: OPERATION_RECOVERY.OBSERVE,
    });
  }

  private launchFinalizer(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.config.finalizeEnabled)
      return this.transition(
        run,
        RUN_STAGE.STATS,
        "Finalization disabled.",
      );
    return this.launchBridge(run, {
      kind: OPERATION_KIND.FINALIZE,
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: finalizerPrompt(run),
    });
  }

  private launchStats(run: PlanExecRun): Promise<PlanExecRun> {
    return this.launchBridge(run, {
      kind: OPERATION_KIND.STATS,
      agent: run.config.statsAgent,
      maxTurns: run.config.statsMaxTurns,
      task: statsPrompt(run),
    });
  }

  private async launchBridge(
    run: PlanExecRun,
    input: {
      kind: ActiveOperation["kind"];
      taskId?: number;
      reviewIteration?: number;
      agent: string;
      maxTurns: number;
      task: string;
    },
  ): Promise<PlanExecRun> {
    const operationId = randomUUID();
    const launchStartedAt = Date.now();
    const params = {
      agent: input.agent,
      task: input.task,
      cwd: run.worktreeCwd,
      context: "fresh",
      turnBudget: { maxTurns: input.maxTurns },
      acceptance: false,
      ...(input.kind === OPERATION_KIND.FIX
        ? { completionGuard: false }
        : {}),
    };
    const persisted = await this.registry.updateIfCurrent(
      {
        ...run,
        status: RUN_STATUS.RUNNING,
        activeOperation: {
          operationId,
          service: OPERATION_SERVICE.BRIDGE,
          kind: input.kind,
          params,
          launchStartedAt,
          recovery: OPERATION_RECOVERY.REPLAY,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.reviewIteration
            ? { reviewIteration: input.reviewIteration }
            : {}),
        },
      },
      run.updatedAt,
    );
    if (!persisted.applied) return persisted.run;
    const intended = persisted.run;
    const reply = await this.bridge.spawn(operationId, params);
    if (!reply.success) return this.fail(intended, reply.error.message, true);
    const externalRunId = text(reply.data.runId);
    if (!externalRunId)
      return this.fail(intended, "Bridge spawn returned no run ID.", true);
    const asyncDir = text(reply.data.asyncDir);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId,
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
      const lookup = await this.bridge.operation(operation.operationId);
      if (!lookup.success)
        return this.fail(
          run,
          `Unable to look up bridge operation: ${lookup.error.message}`,
          true,
        );
      const lookupState = text(lookup.data.state);
      if (lookupState === EXTERNAL_OPERATION_STATE.FOUND) {
        const externalRunId = text(lookup.data.runId);
        if (!externalRunId)
          return this.fail(
            run,
            "Bridge operation lookup omitted a run ID.",
            true,
          );
        const asyncDir = text(lookup.data.asyncDir);
        return this.updateActiveOperation(run, operation.operationId, {
          externalRunId,
          recovery: OPERATION_RECOVERY.OBSERVE,
          ...(asyncDir ? { asyncDir } : {}),
        });
      }
      if (lookupState === EXTERNAL_OPERATION_STATE.PENDING) return run;
      if (lookupState === EXTERNAL_OPERATION_STATE.UNKNOWN)
        return this.fail(
          run,
          "Bridge operation lookup is unresolved; retry /exec resume after the provider recovers.",
          true,
        );
      if (lookupState === EXTERNAL_OPERATION_STATE.ABSENT)
        return this.fail(
          run,
          "Bridge has no record of this operation; refusing to launch a possible duplicate worker.",
          true,
        );
      return this.fail(
        run,
        "Bridge operation lookup returned an invalid state.",
        true,
      );
    }

    const reply = await this.fusion.start(
      operation.operationId,
      text(operation.params?.prompt) ?? fusionPrompt(run),
      text(operation.params?.profile) ?? run.config.fusionProfile,
    );
    if (!reply.success) return this.fail(run, reply.error.message, true);
    const state = fusionState(reply.data);
    if (!state) return this.fail(run, "Fusion start returned no run ID.", true);
    return this.updateActiveOperation(run, operation.operationId, {
      externalRunId: state.runId,
      recovery: OPERATION_RECOVERY.OBSERVE,
    });
  }

  private async updateActiveOperation(
    run: PlanExecRun,
    operationId: string,
    patch: Partial<ActiveOperation>,
  ): Promise<PlanExecRun> {
    let current = (await this.registry.get(run.id)) ?? run;
    for (let attempt = 0; attempt < OPERATION_UPDATE_CAS_RETRIES; attempt += 1) {
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

  private async reconstructBridgeParams(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<Record<string, unknown>> {
    let task: string;
    if (operation.kind === OPERATION_KIND.IMPLEMENTATION) {
      const plan = await readPlan(run.planPath);
      const taskData = plan.tasks.find(
        (candidate) => candidate.id === operation.taskId,
      );
      if (!taskData)
        throw new Error(
          "Cannot recover an implementation task that no longer exists.",
        );
      task = workerPrompt(run, taskData.id, taskData.title, taskData.unchecked);
    } else if (operation.kind === OPERATION_KIND.REVIEW) {
      task = reviewerPrompt(run);
    } else if (operation.kind === OPERATION_KIND.FIX) {
      task = fixerPrompt(
        run,
        run.reviewFindings,
        formatFindings(run.reviewFindings),
      );
    } else if (operation.kind === OPERATION_KIND.FINALIZE) {
      task = finalizerPrompt(run);
    } else if (operation.kind === OPERATION_KIND.STATS) {
      task = statsPrompt(run);
    } else {
      throw new Error(
        `Cannot recover unsupported bridge operation kind: ${operation.kind}.`,
      );
    }
    return {
      agent:
        operation.kind === OPERATION_KIND.STATS
          ? run.config.statsAgent
          : operation.kind === OPERATION_KIND.REVIEW
            ? run.config.reviewerAgent
            : run.config.workerAgent,
      task,
      cwd: run.worktreeCwd,
      context: "fresh",
      turnBudget: {
        maxTurns:
          operation.kind === OPERATION_KIND.STATS
            ? run.config.statsMaxTurns
            : operation.kind === OPERATION_KIND.REVIEW
              ? run.config.reviewerMaxTurns
              : run.config.workerMaxTurns,
      },
      acceptance: false,
      ...(operation.kind === OPERATION_KIND.FIX
        ? { completionGuard: false }
        : {}),
    };
  }

  private async observePausedOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation?.externalRunId) return run;
    const status =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridge.status(operation.externalRunId, operation.asyncDir)
        : await this.fusion.status(operation.externalRunId);
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    const observed = await this.recordObservation(run, operation);
    if (!sameOperationState(run, observed, operation)) return observed;
    const state =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? text(status.data.state)
        : fusionState(status.data)?.phase;
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
    const operation = run.activeOperation;
    if (!operation) return this.fail(run, "Active operation is missing.");
    if (!operation.externalRunId)
      return this.recoverActiveOperation(run, operation);
    if (operation.service === OPERATION_SERVICE.FUSION)
      return this.observeFusion(run, operation);
    return this.observeBridge(run, operation);
  }

  private async observeBridge(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<PlanExecRun> {
    const status = await this.bridge.status(
      operation.externalRunId!,
      operation.asyncDir,
    );
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    const observed = await this.recordObservation(run, operation);
    if (!sameOperationState(run, observed, operation)) return observed;
    const state = text(status.data.state);
    if (
      !state ||
      state === EXTERNAL_OPERATION_STATE.RUNNING ||
      state === EXTERNAL_OPERATION_STATE.STOPPING
    )
      return observed;

    if (operation.kind === OPERATION_KIND.IMPLEMENTATION)
      return this.finishImplementation(observed, operation, state);
    if (operation.kind === OPERATION_KIND.REVIEW) {
      let output: string;
      try {
        output = await this.bridgeOutput(operation);
      } catch (error: unknown) {
        return this.retryReviewOutput(
          observed,
          operation,
          error instanceof Error ? error.message : String(error),
        );
      }
      const current = (await this.registry.get(run.id)) ?? observed;
      if (!sameOperationState(observed, current, operation)) return current;
      return this.finishReview(current, operation, state, output);
    }
    if (operation.kind === OPERATION_KIND.FIX)
      return this.finishFix(observed, operation, state);
    if (operation.kind === OPERATION_KIND.FINALIZE)
      return this.finishBestEffort(
        observed,
        operation,
        state,
        RUN_STAGE.STATS,
      );
    if (operation.kind === OPERATION_KIND.STATS)
      return this.finishBestEffort(
        observed,
        operation,
        state,
        RUN_STAGE.ARCHIVE,
      );
    return this.fail(
      run,
      `Unexpected bridge operation kind: ${operation.kind}.`,
    );
  }

  private async observeFusion(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<PlanExecRun> {
    const status = await this.fusion.status(operation.externalRunId);
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    const observed = await this.recordObservation(run, operation);
    if (!sameOperationState(run, observed, operation)) return observed;
    const state = fusionState(status.data);
    if (!state || !state.terminal) return observed;
    const result = await this.fusion.result(state.runId);
    if (!result.success) return this.fail(observed, result.error.message, true);
    const current = (await this.registry.get(run.id)) ?? observed;
    if (!sameOperationState(observed, current, operation)) return current;
    const final = fusionState(result.data);
    if (!final?.report)
      return this.fail(
        current,
        "Fusion completed without a machine-readable report.",
      );
    return this.finishReview(current, operation, final.phase, final.report);
  }

  private async recordObservation(
    run: PlanExecRun,
    operation: ActiveOperation,
  ): Promise<PlanExecRun> {
    const observedOperation = { ...operation, lastObservedAt: Date.now() };
    delete observedOperation.statusFailures;
    delete observedOperation.lastStatusError;
    return this.registry.heartbeat({
      ...run,
      activeOperation: observedOperation,
    });
  }

  private async recordObservationFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = (operation.statusFailures ?? 0) + 1;
    const message = `Unable to observe ${operation.service}/${operation.kind} (${failures}/${MAX_STATUS_FAILURES}): ${error}`;
    const failedRun = {
      ...run,
      activeOperation: {
        ...operation,
        statusFailures: failures,
        lastStatusError: error,
      },
    };
    if (failures >= MAX_STATUS_FAILURES)
      return this.fail(failedRun, message, true);
    return this.registry.heartbeat(failedRun);
  }

  private recordCancellationFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = (operation.statusFailures ?? 0) + 1;
    const message = `Unable to cancel ${operation.service}/${operation.kind} (${failures}/${MAX_STATUS_FAILURES}): ${error}`;
    const failedRun = {
      ...run,
      activeOperation: {
        ...operation,
        recovery: OPERATION_RECOVERY.CANCEL,
        statusFailures: failures,
        lastStatusError: error,
      },
    };
    if (failures >= MAX_STATUS_FAILURES)
      return this.fail(failedRun, message, true);
    return this.registry.heartbeat(failedRun);
  }

  private async recoverFailedRun(
    run: PlanExecRun,
    retryTask = false,
  ): Promise<PlanExecRun> {
    const plan =
      run.stage === RUN_STAGE.ARCHIVE
        ? undefined
        : await readPlan(run.planPath);
    if (plan && plan.hash !== run.planHash)
      return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
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
    const retryFailedReview =
      isReviewStage(run.stage) &&
      (run.failedOperation?.kind === OPERATION_KIND.REVIEW ||
        run.failedOperation?.kind === OPERATION_KIND.FUSION);
    const recovered = await this.registry.updateIfCurrent(
      clearError({
        ...run,
        status:
          run.activeOperation?.recovery === OPERATION_RECOVERY.CANCEL
            ? RUN_STATUS.CANCEL_PENDING
            : RUN_STATUS.RUNNING,
        config,
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
        ? `Manual recovery reset Task ${task.id} and retried the failed implementation stage.`
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

  private async pauseForReview(
    run: PlanExecRun,
    error: string,
  ): Promise<PlanExecRun> {
    const paused = await this.registry.updateIfCurrent(
      withoutOperation({ ...run, status: RUN_STATUS.PAUSED, error }),
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
  ): Promise<PlanExecRun> {
    const taskId = operation.taskId;
    if (!taskId)
      return this.fail(run, "Implementation operation has no task ID.");
    const plan = await readPlan(run.planPath);
    if (plan.hash !== run.planHash)
      return this.pauseForReview(run, PLAN_STRUCTURE_CHANGED_ERROR);
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task)
      return this.fail(run, `Task ${taskId} disappeared from the plan.`);
    const attempts = (run.taskAttempts[String(taskId)] ?? 0) + 1;
    const cleared = withoutOperation({
      ...run,
      taskAttempts: { ...run.taskAttempts, [String(taskId)]: attempts },
    });
    if (task.unchecked.length === 0) {
      await appendProgress(
        cleared,
        `Task ${taskId} completed after ${attempts} attempt(s).`,
      );
      return this.advanceUnlocked(await this.registry.update(cleared));
    }
    if (attempts > run.config.taskRetries) {
      return this.fail(
        cleared,
        `Worker ${operation.externalRunId} ended as ${state} and left task ${taskId} checkboxes unchecked.`,
      );
    }
    return this.advanceUnlocked(await this.registry.update(cleared));
  }

  private async retryReviewOutput(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const cleared = withoutOperation(run);
    const iteration = operation.reviewIteration ?? 1;
    const limit =
      run.stage === RUN_STAGE.COMPREHENSIVE_REVIEW
        ? run.config.reviewIterations
        : 1;
    if (iteration >= limit) {
      return this.fail(
        run,
        `Review result output was unavailable after ${iteration} attempt(s): ${error}`,
      );
    }
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
    return this.launchReview(ready);
  }

  private async finishReview(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
    output: string,
  ): Promise<PlanExecRun> {
    if (!isSuccessfulOperationState(state))
      return this.fail(run, `Review operation ended as ${state}.`);
    let findings: ReviewFinding[];
    try {
      findings = parseReviewFindings(output);
    } catch (error: unknown) {
      return this.fail(
        run,
        error instanceof Error ? error.message : String(error),
      );
    }
    const cleared = withoutOperation({ ...run, reviewFindings: findings });
    if (findings.length === 0) {
      await appendProgress(cleared, `${run.stage} found no issues.`);
      return this.advanceUnlocked(
        await this.transition(
          cleared,
          nextStage(run.stage),
          `${run.stage} passed.`,
        ),
      );
    }
    const iteration = operation.reviewIteration ?? 1;
    const limit =
      run.stage === RUN_STAGE.COMPREHENSIVE_REVIEW
        ? run.config.reviewIterations
        : run.stage === RUN_STAGE.FUSION_REVIEW
          ? run.config.fusionIterations
          : 1;
    const singlePass =
      run.stage === RUN_STAGE.SMELLS_REVIEW ||
      run.stage === RUN_STAGE.CRITICAL_REVIEW;
    const minorOnlyFusion =
      run.stage === RUN_STAGE.FUSION_REVIEW && !hasBlockingFindings(findings);
    if (!singlePass && !minorOnlyFusion && iteration >= limit) {
      return this.advanceUnlocked(
        await this.recordUnresolvedAndAdvance(cleared, findings),
      );
    }
    return this.launchBridge(cleared, {
      kind: OPERATION_KIND.FIX,
      reviewIteration: iteration,
      agent: cleared.config.workerAgent,
      maxTurns: cleared.config.workerMaxTurns,
      task: fixerPrompt(cleared, findings, output),
    });
  }

  private async finishFix(
    run: PlanExecRun,
    operation: ActiveOperation,
    state: string,
  ): Promise<PlanExecRun> {
    const cleared = withoutOperation(run);
    if (state !== EXTERNAL_OPERATION_STATE.COMPLETE)
      return this.fail(run, `Fix operation ended as ${state}.`);
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
  ): Promise<PlanExecRun> {
    if (!isSuccessfulOperationState(state))
      return this.fail(run, `${operation.kind} operation ended as ${state}.`);
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
    const destination = join(
      dirname(run.planPath),
      COMPLETED_PLANS_DIRECTORY,
      basename(run.planPath),
    );
    const status = completionStatus(run);
    try {
      await mkdir(dirname(destination), { recursive: true });
      const sourceExists = await pathExists(run.planPath);
      const destinationExists = await pathExists(destination);
      if (sourceExists && destinationExists)
        throw new Error(
          `Completed plan destination already exists: ${destination}.`,
        );
      if (sourceExists) await rename(run.planPath, destination);
      else if (!destinationExists)
        throw new Error(`Plan to archive is missing: ${run.planPath}.`);
      await appendProgress(run, `Archived plan to ${destination}.`);
      await appendProgress(run, `Run completed as ${status}.`);
      const paths = [
        relative(run.worktreeCwd, run.planPath),
        relative(run.worktreeCwd, destination),
      ];
      if (run.progressPath) {
        const progress = relative(run.worktreeCwd, run.progressPath);
        if (progress !== ".." && !progress.startsWith(`..${sep}`))
          paths.push(progress);
      }
      const add = await this.runCommand(
        "git",
        ["add", "-A", "--", ...paths],
        run.worktreeCwd,
      );
      if (add.code !== 0)
        throw new Error(add.stderr.trim() || "Could not stage archived plan.");
      const pending = await this.runCommand(
        "git",
        ["status", "--porcelain", "--", ...paths],
        run.worktreeCwd,
      );
      if (pending.code !== 0)
        throw new Error(
          pending.stderr.trim() || "Could not verify archived plan state.",
        );
      if (pending.stdout.trim()) {
        const commit = await this.runCommand(
          "git",
          ["commit", "-m", `chore: archive ${basename(destination)}`],
          run.worktreeCwd,
        );
        if (commit.code !== 0)
          throw new Error(
            commit.stderr.trim() || "Could not commit archived plan.",
          );
      }
      const completed = await this.registry.update({
        ...run,
        status,
        stage: RUN_STAGE.COMPLETE,
      });
      return this.registry.release(completed);
    } catch (error: unknown) {
      return this.fail(
        run,
        `Plan archival failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async complete(run: PlanExecRun): Promise<PlanExecRun> {
    const status = completionStatus(run);
    const completed = await this.registry.update({
      ...run,
      status,
      stage: RUN_STAGE.COMPLETE,
    });
    await appendProgress(completed, `Run completed as ${status}.`);
    return this.registry.release(completed);
  }

  private async recordUnresolvedAndAdvance(
    run: PlanExecRun,
    findings: ReviewFinding[],
  ): Promise<PlanExecRun> {
    const updated = await this.registry.update({
      ...withoutOperation(run),
      unresolvedFindings: [...run.unresolvedFindings, ...findings],
    });
    await appendProgress(
      updated,
      `${run.stage} reached its iteration cap with unresolved findings.\n${formatFindings(findings)}`,
    );
    return this.transition(
      updated,
      nextStage(run.stage),
      `${run.stage} reached its iteration cap.`,
    );
  }

  private async advanceStageSkip(run: PlanExecRun): Promise<PlanExecRun> {
    const request = run.pendingStageSkip;
    if (!request || request.stage !== run.stage)
      return this.fail(run, "Force-skip state does not match the current stage.");
    const operation = run.activeOperation;
    if (!operation) return this.finishStageSkip(run, "no active operation");

    if (!operation.externalRunId) {
      if (operation.service === OPERATION_SERVICE.FUSION) {
        const params = operation.params ?? {};
        const prompt = text(params.prompt);
        if (!prompt)
          return this.recordStageSkipFailure(
            run,
            operation,
            "Fusion recovery is missing its launch prompt during force-skip.",
          );
        const launched = await this.fusion.start(
          operation.operationId,
          prompt,
          text(params.profile),
        );
        if (!launched.success)
          return this.recordStageSkipFailure(
            run,
            operation,
            `Unable to recover Fusion operation before force-skip: ${launched.error.message}`,
          );
        const state = fusionState(launched.data);
        if (!state)
          return this.recordStageSkipFailure(
            run,
            operation,
            "Fusion recovery omitted the run ID or phase during force-skip.",
          );
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
      const lookup = await this.bridge.operation(operation.operationId);
      if (!lookup.success)
        return this.recordStageSkipFailure(
          run,
          operation,
          `Unable to look up bridge operation: ${lookup.error.message}`,
        );
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
        ? await this.bridge.status(operation.externalRunId, operation.asyncDir)
        : await this.fusion.status(operation.externalRunId);
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
    if (terminal) return this.finishStageSkip(observed, state);
    if (operation.service === OPERATION_SERVICE.BRIDGE) {
      if (state === EXTERNAL_OPERATION_STATE.PENDING) return observed;
      if (!isActiveBridgeOperationState(state))
        return this.recordStageSkipFailure(
          observed,
          observed.activeOperation ?? operation,
          `Bridge returned unrecognized non-terminal state during force-skip: ${state}`,
        );
    }
    if (operation.stopRequested) return observed;

    const stopped =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridge.stop(operation.externalRunId, operation.asyncDir)
        : await this.fusion.cancel(operation.externalRunId);
    if (!stopped.success)
      return this.recordStageSkipFailure(
        observed,
        observed.activeOperation ?? operation,
        `Unable to stop ${operation.service}/${operation.kind}: ${stopped.error.message}`,
      );
    return this.updateActiveOperation(observed, operation.operationId, {
      stopRequested: true,
      recovery: OPERATION_RECOVERY.CANCEL,
    });
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
        `Unable to finish force-skip (${failures}/${MAX_STATUS_FAILURES}): ${error}`,
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
    const next = nextStage(request.stage);
    const ready = clearError(
      withoutOperation({
        ...run,
        status: RUN_STATUS.RUNNING,
        stage: next,
        reviewFindings: [],
        unresolvedFindings,
        skippedStages: [
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
    const persisted = await this.registry.update(ready);
    await appendProgressBestEffort(
      persisted,
      `FORCE-SKIPPED ${request.stage} by ${request.requestedBy}: ${request.reason}\nOperation state: ${terminalOperationState}\nNext stage: ${next}`,
    );
    return this.advanceUnlocked(persisted);
  }

  private async cancel(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation)
      return this.registry.release(
        await this.registry.update({
          ...run,
          status: RUN_STATUS.CANCELLED,
        }),
      );
    if (!operation.externalRunId)
      return this.fail(
        run,
        "Cannot confirm cancellation before the provider assigned a run ID.",
        true,
      );
    if (!operation.stopRequested) {
      const stopped =
        operation.service === OPERATION_SERVICE.BRIDGE
          ? await this.bridge.stop(operation.externalRunId, operation.asyncDir)
          : await this.fusion.cancel(operation.externalRunId);
      if (!stopped.success)
        return this.recordCancellationFailure(
          run,
          operation,
          stopped.error.message,
        );
      return this.registry.update({
        ...run,
        activeOperation: { ...operation, stopRequested: true },
      });
    }
    const terminal =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridge.status(operation.externalRunId, operation.asyncDir)
        : await this.fusion.status(operation.externalRunId);
    if (!terminal.success)
      return this.recordCancellationFailure(
        run,
        operation,
        terminal.error.message,
      );
    const observed = await this.recordObservation(run, operation);
    const bridgeState =
      operation.service === OPERATION_SERVICE.BRIDGE
        ? text(terminal.data.state)
        : fusionState(terminal.data)?.phase;
    if (!bridgeState || isActiveExternalOperationState(bridgeState)) {
      return observed;
    }
    const cancelled = withoutOperation({
      ...observed,
      status: RUN_STATUS.CANCELLED,
    });
    await appendProgress(
      cancelled,
      `Cancellation completed after ${operation.kind} reached ${bridgeState}.`,
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
    const adopted = await this.fusion.adopt(operation.externalRunId);
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
    if (!result.success) throw new Error(result.error.message);
    return readSubagentArtifact(
      text(result.data.resultPath),
      operation.asyncDir,
    );
  }

  private async transition(
    run: PlanExecRun,
    stage: RunStage,
    message: string,
  ): Promise<PlanExecRun> {
    const transitioned = await this.registry.update({
      ...withoutOperation(run),
      stage,
      status: RUN_STATUS.RUNNING,
    });
    await appendProgress(transitioned, message);
    return transitioned;
  }

  private async createExecutionWorktree(
    repositoryRoot: string,
    planPath: string,
    branch: string,
  ): Promise<string> {
    await ensureCleanForWorktree(this.runCommand, repositoryRoot, planPath);
    return createWorktree(this.runCommand, repositoryRoot, planPath, branch);
  }

  private async fail(
    run: PlanExecRun,
    error: string,
    preserveOperation = false,
  ): Promise<PlanExecRun> {
    const failedOperation = run.activeOperation ?? run.failedOperation;
    const failed = await this.registry.update({
      ...withoutOperation({ ...run, status: RUN_STATUS.FAILED, error }),
      ...(failedOperation ? { failedOperation } : {}),
      ...(preserveOperation ? { activeOperation: run.activeOperation } : {}),
    });
    try {
      await appendProgress(failed, `Run failed at ${failed.stage}: ${error}`);
    } catch {
      // The registry is authoritative if the optional progress file is unavailable.
    }
    return failed;
  }
}

function isSuccessfulOperationState(state: string): boolean {
  return (
    state === EXTERNAL_OPERATION_STATE.COMPLETE ||
    state === EXTERNAL_OPERATION_STATE.DONE
  );
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

function isActiveExternalOperationState(state: string): boolean {
  return (
    isActiveBridgeOperationState(state) ||
    state === EXTERNAL_OPERATION_STATE.CHAIN ||
    state === EXTERNAL_OPERATION_STATE.PANEL ||
    state === EXTERNAL_OPERATION_STATE.JUDGE
  );
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

function recoveryConfig(run: PlanExecRun): FrozenRunConfig {
  if (
    run.stage === RUN_STAGE.IMPLEMENTATION ||
    run.stage === RUN_STAGE.FINALIZE
  )
    return {
      ...run.config,
      workerMaxTurns: Math.max(
        run.config.workerMaxTurns,
        RECOVERY_WORKER_MAX_TURNS,
      ),
    };
  if (run.stage === RUN_STAGE.STATS)
    return {
      ...run.config,
      statsMaxTurns: Math.max(
        run.config.statsMaxTurns,
        RECOVERY_REVIEWER_MAX_TURNS,
      ),
    };
  if (isReviewStage(run.stage))
    return {
      ...run.config,
      reviewerMaxTurns: Math.max(
        run.config.reviewerMaxTurns,
        RECOVERY_REVIEWER_MAX_TURNS,
      ),
    };
  return run.config;
}

function workerPrompt(
  run: PlanExecRun,
  taskId: number,
  title: string,
  unchecked: string[],
): string {
  return [
    "You are the sole implementation worker for a ralphex plan run.",
    `Run: ${run.id}`,
    `Plan: ${run.planPath}`,
    `Task ${taskId}: ${title}`,
    "Complete only this task. Inspect and preserve valid work already present in the worktree before making changes, then run relevant verification, commit your work, and mark only its completed plan checkboxes [x].",
    "Change only checkbox markers from [ ] to [x]. Do not change checkbox text, headings, task numbers, or add/remove plan items.",
    "Record verification in your response and progress artifacts, not by rewriting plan item text.",
    "Do not start later tasks. Do not report success until the checkboxes are updated and verification is complete.",
    "Remaining checkbox items:",
    ...unchecked.map((item) => `- [ ] ${item}`),
  ].join("\n");
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
    `Plan: ${run.planPath}`,
    `Worktree: ${run.worktreeCwd}`,
    "Inspect the implementation and diff against the default branch. Return exactly one of:",
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
    "Perform an adversarial implementation review for this completed plan execution.",
    `Plan: ${run.planPath}`,
    `Worktree: ${run.worktreeCwd}`,
    `Default branch: ${run.defaultBranch}`,
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
    "You are the sole worker fixing review findings in an existing plan execution.",
    `Plan: ${run.planPath}`,
    `Stage: ${run.stage}`,
    "Apply only justified findings, run relevant verification, and commit the fixes.",
    "Do not modify plan task checkboxes unless the implementation task itself requires it.",
    "Structured findings:",
    formatFindings(findings),
    "Raw reviewer output:",
    rawOutput,
  ].join("\n\n");
}

function finalizerPrompt(run: PlanExecRun): string {
  return [
    "Finalize this completed plan execution best-effort.",
    `Worktree: ${run.worktreeCwd}`,
    `Default branch: ${run.defaultBranch}`,
    "Inspect the branch, run appropriate verification, and make clean commits if required. Do not push, merge, or destroy work.",
  ].join("\n");
}

function statsPrompt(run: PlanExecRun): string {
  return [
    "Produce compact execution statistics without editing files.",
    `Plan: ${run.planPath}`,
    `Worktree: ${run.worktreeCwd}`,
    "Use git churn and available artifacts. Return concise Markdown with changed files, commits, verification, and residual findings.",
  ].join("\n");
}

async function copyPlanIntoWorktree(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
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

export function isRecoverableImplementationFailure(run: PlanExecRun): boolean {
  return (
    run.status === RUN_STATUS.FAILED &&
    run.stage === RUN_STAGE.IMPLEMENTATION &&
    run.activeOperation === undefined &&
    (/^Worker .+ ended as .+ and left task \d+ checkboxes unchecked\.$/.test(
      run.error ?? "",
    ) || /Task \d+ exhausted its retry limit\./.test(run.error ?? ""))
  );
}

export function isExternalManualBlocker(run: PlanExecRun): boolean {
  if (run.stage !== RUN_STAGE.IMPLEMENTATION || run.activeOperation)
    return false;
  return /\b(billing|payment|quota|rate[- ]limit|provider|credential|authentication|authorization|permission|unavailable|outage|network|manual|external)\b/i.test(
    recoveryEvidence(run),
  );
}

export function isTaskRetryConfirmationRequired(run: PlanExecRun): boolean {
  return (
    run.status === RUN_STATUS.FAILED &&
    run.stage === RUN_STAGE.IMPLEMENTATION &&
    run.activeOperation === undefined &&
    (isRecoverableImplementationFailure(run) || isExternalManualBlocker(run))
  );
}

export function taskRetryRequiredMessage(run: PlanExecRun): string {
  const taskId =
    run.failedOperation?.taskId ??
    run.error?.match(/Task (\d+)/)?.[1] ??
    run.error?.match(/task (\d+)/i)?.[1] ??
    "the incomplete task";
  return [
    `Task ${taskId} is retry-exhausted or made no progress; refusing to retry this stage implicitly.`,
    "Fix or verify the external/manual blocker first.",
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
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

export function isRecoverableFailure(run: PlanExecRun): boolean {
  return isRecoverableRun(run);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
