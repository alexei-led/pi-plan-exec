import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
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
  createWorktree,
  currentBranch,
  defaultBranch,
  ensureCleanForWorktree,
  isPathWithin,
  requireGitRepository,
  verifyExistingWorktree,
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
import { readPlan, parsePlan } from "./plan.js";
import {
  appendProgress,
  appendProgressOnce,
  initializeProgress,
} from "./progress.js";
import { RunRegistry } from "./registry.js";
import { resolveRunConfig } from "./config.js";
import { RevmuxReviewClient, validateReviewResult } from "./review-backend.js";
import { LocalOperationUnknownError, type LocalOperationOptions } from "./local-operation.js";
import { reconcileTasks, selectReadyTask, nextTaskWake } from "./scheduler.js";
import { bootstrapCommands, gitValue, requiredChecks, runCommands } from "./lanes.js";
import {
  formatFindings,
  hasBlockingFindings,
  parseReviewFindings,
} from "./review.js";
import {
  COMPLETED_PLANS_DIRECTORY,
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
const PORCELAIN_PATH_OFFSET = 3;
const MAX_AUTOMATIC_RETRY_DELAY_MS = 300_000;
const MAX_BACKOFF_EXPONENT = 16;
const REVIEW_DIAGNOSTIC_BURST = 2;
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
    if (options.existingWorktree !== undefined && options.useWorktree)
      throw new Error("Choose either an existing worktree or a new worktree.");
    const targetPath = options.existingWorktree === undefined
      ? options.cwd
      : resolve(options.cwd, options.existingWorktree);
    const requestedPlan = resolve(targetPath, options.planPath);
    const plan = await readPlan(options.existingWorktree === undefined
      ? requestedPlan
      : await realpath(requestedPlan));
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
        ? await this.createExecutionWorktree(repositoryRoot, plan.path, branch)
        : resolve(options.cwd);
      if (options.useWorktree) {
        executionPlanPath = worktreePlanPath(
          executionWorktreeCwd,
          repositoryRoot,
          plan.path,
        );
        await copyPlanIntoWorktree(plan.path, executionPlanPath);
      }
    }

    const configured = await resolveRunConfig(repositoryRoot);
    const config: FrozenRunConfig = { ...configured,
      requiredChecks: await requiredChecks(executionWorktreeCwd, configured.requiredChecks),
      bootstrapCommands: await bootstrapCommands(executionWorktreeCwd, configured.bootstrapCommands),
    };
    const run = await this.registry.create({
      schemaVersion: 1,
      repositoryRoot,
      planPath: executionPlanPath,
      planHash: plan.hash,
      worktreeCwd: executionWorktreeCwd,
      branch,
      defaultBranch: baseBranch,
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
        baselineCommit: await gitValue(this.runCommand, executionWorktreeCwd, ["rev-parse", "HEAD"]),
        taskId: 0, state: "bootstrap" as const } } : {}),
    }, { exclusive: true });
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
      if (isTerminalStatus(run.status) || (run.status === RUN_STATUS.PAUSED && !run.activeOperation)) return run;
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
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.resumeLocked(
        runId,
        sessionId,
        explicit,
        reviewedPlanHash,
        retryTask,
        recoveryModel,
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
  ): Promise<PlanExecRun> {
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
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
    if (reviewedPlanHash !== undefined) {
      const adopted = await this.registry.updateIfCurrent(
        {
          ...prepared,
          planHash: reviewedPlanHash,
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
    await this.registry.assertExclusive(existing);
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
    if ((claimed.config.reviewRequired && isReviewStage(claimed.stage)) ||
      (claimed.config.finalizeEnabled && claimed.stage === RUN_STAGE.FINALIZE))
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
    run = (await this.registry.get(run.id)) ?? run;
    if (isTerminalStatus(run.status)) return run;
    if (run.status === RUN_STATUS.CANCEL_PENDING) return this.cancel(run);
    if (run.status === RUN_STATUS.SKIP_PENDING)
      return this.advanceStageSkip(run);
    if (run.status === RUN_STATUS.PAUSED) {
      if ((run.nextAttemptAt ?? 0) > Date.now()) return run;
      return run.activeOperation ? this.observePausedOperation(run) : run;
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
    if (Object.values(tasks).every((task) => task.state === "accepted"))
      return this.transition(
        { ...run, tasks },
        RUN_STAGE.COMPREHENSIVE_REVIEW,
        "All plan checkboxes are complete.",
      );
    const selected = selectReadyTask(tasks);
    if (!selected) return (await this.registry.updateIfCurrent({ ...run, tasks,
      nextAttemptAt: nextTaskWake(tasks, Date.now()), wakeReason: "Waiting for task prerequisites or retry", }, run.updatedAt)).run;
    const task = plan.tasks.find((candidate) => candidate.id === selected.taskId)!;
    const acceptedHead = run.acceptedHead ?? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    if (selected.laneCwd && selected.laneCwd !== run.worktreeCwd) {
      const laneRun = await this.registry.updateIfCurrent({ ...run, tasks, acceptedHead,
        planPath: join(selected.laneCwd, relative(run.worktreeCwd, run.planPath)),
        worktreeCwd: selected.laneCwd, branch: selected.laneBranch!,
        ...(run.progressPath ? { progressPath: join(selected.laneCwd, relative(run.worktreeCwd, run.progressPath)) } : {}),
      }, run.updatedAt);
      return laneRun.run;
    }
    const occupied = Object.values(tasks).some((other) => other.taskId !== task.id && other.state !== "accepted" && other.laneCwd === run.worktreeCwd);
    if (occupied && !selected.laneCwd) {
      const token = randomUUID().slice(0, LANE_TOKEN_LENGTH);
      return (await this.registry.updateIfCurrent({ ...run, tasks, acceptedHead,
        lanePreparation: { taskId: task.id, cwd: join(dirname(run.worktreeCwd), `plan-exec-${run.id}-${token}`),
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

  private async launchReview(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.config.reviewEnabled && !run.config.reviewRequired)
      return this.transition(run, RUN_STAGE.FINALIZE, "Optional review disabled by configuration.");
    if (run.config.reviewBackend !== "subagent") return this.launchFusion(run);
    const iteration = (run.stageAttempts[run.stage] ?? 0) + 1;
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

  private async prepareLane(run: PlanExecRun): Promise<PlanExecRun> {
    if (run.status === RUN_STATUS.STARTING) return this.registry.update({ ...run, status: RUN_STATUS.RUNNING });
    const preparation = run.lanePreparation!;
    try {
      if (preparation.state === "create") {
        const existing = await this.runCommand("git", ["rev-parse", "--show-toplevel"], preparation.cwd).catch(() => undefined);
        if (existing?.code !== 0 || existing.stdout.trim() !== preparation.cwd) {
          await gitValue(this.runCommand, run.repositoryRoot, ["worktree", "add", "-b", preparation.branch, preparation.cwd, preparation.baselineCommit]);
        } else {
          await verifyExecutionTree(this.runCommand, preparation.cwd, run.repositoryRoot, preparation.branch);
          const head = await gitValue(this.runCommand, preparation.cwd, ["rev-parse", "HEAD"]);
          if (head !== preparation.baselineCommit) throw new Error("Lane creation found an unexpected HEAD; refusing to reuse it.");
        }
        const planPath = join(preparation.cwd, relative(run.worktreeCwd, run.planPath));
        if (!await pathExists(planPath)) await copyPlanIntoWorktree(run.planPath, planPath);
        return (await this.registry.updateIfCurrent({ ...run, lanePreparation: { ...preparation, state: "bootstrap" } }, run.updatedAt)).run;
      }
      await runCommands(this.runCommand, preparation.cwd, await bootstrapCommands(preparation.cwd, run.config.bootstrapCommands),
        await this.localOptions(run, `bootstrap:${preparation.cwd}:${preparation.nextAttemptAt ?? 0}`));
      const task = run.tasks?.[String(preparation.taskId)];
      if (!task && preparation.taskId !== 0) throw new Error("Lane preparation lost its task.");
      const prepared = { ...run,
        worktreeCwd: preparation.cwd, branch: preparation.branch,
        planPath: join(preparation.cwd, relative(run.worktreeCwd, run.planPath)),
        ...(run.progressPath ? { progressPath: join(preparation.cwd, relative(run.worktreeCwd, run.progressPath)) } : {}),
        ...(task ? { tasks: { ...run.tasks, [String(task.taskId)]: { ...task, laneCwd: preparation.cwd,
          laneBranch: preparation.branch, baselineCommit: preparation.baselineCommit } } } : {}),
        nextAttemptAt: 0,
      };
      delete prepared.lanePreparation;
      return (await this.registry.updateIfCurrent(prepared, run.updatedAt)).run;
    } catch (error) {
      return this.fail(error instanceof LocalOperationUnknownError ? run : { ...run,
        lanePreparation: { ...preparation, nextAttemptAt: Date.now() + run.config.retryDelayMs } },
      `Lane preparation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async verifyCandidate(run: PlanExecRun, candidate: string): Promise<void> {
    if (run.acceptedHead) await gitValue(this.runCommand, run.worktreeCwd, ["merge-base", "--is-ancestor", run.acceptedHead, candidate]);
    await runCommands(this.runCommand, run.worktreeCwd, run.config.requiredChecks,
      await this.localOptions(run, `verify:${candidate}:${run.activeOperation?.operationId ?? run.stage}`, candidate));
    const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    if (head !== candidate) throw new Error("HEAD changed while verifying the candidate.");
    const dirtyResult = await this.runCommand("git", ["status", "--porcelain", "-z", "--untracked-files=normal"], run.worktreeCwd);
    if (dirtyResult.code !== 0) throw new Error(dirtyResult.stderr || "Cannot inspect candidate worktree.");
    const progress = run.progressPath ? relative(run.worktreeCwd, run.progressPath) : undefined;
    if (dirtyResult.stdout.split("\0").some((line) => line && line.slice(PORCELAIN_PATH_OFFSET) !== progress))
      throw new Error("Candidate has uncommitted source changes after verification.");
  }

  private async localOptions(run: PlanExecRun, operationId: string, candidate?: string): Promise<LocalOperationOptions> {
    const commonDir = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "--git-common-dir"]);
    return { journalRoot: join(resolve(run.worktreeCwd, commonDir), "plan-exec-local"), runId: run.id, operationId,
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
    const client = await this.reviewClient(run);
    const capabilities = await client.capabilities?.();
    if (!supportsExecution(capabilities, run.config.executionLifetime))
      return this.reviewFailure(run, `${run.config.reviewBackend} runtime does not support the requested explicit execution lifetime, durable lookup and process-tree proof.`);
    const iteration = (run.stageAttempts[RUN_STAGE.FUSION_REVIEW] ?? 0) + 1;
    const profile = run.config.reviewBackend === "revmux" ? run.config.revmuxProfile : run.config.fusionProfile;
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
            backend: run.config.reviewBackend,
            executionLifetime: run.config.executionLifetime,
            reviewedCommit: await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]),
            ...(profile
              ? { profile }
              : {}),
          },
        },
      },
      run.updatedAt,
    );
    if (!persisted.applied) return persisted.run;
    const intended = persisted.run;
    const reply = await client.start(
      operationId,
      text(intended.activeOperation?.params?.prompt) ?? fusionPrompt(intended),
      text(intended.activeOperation?.params?.profile),
      intended.config.executionLifetime,
    );
    if (!reply.success)
      return this.fail(intended, reply.error.message, true);
    if (!sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), run.config.executionLifetime))
      return this.failUnknownLaunch(intended, intended.activeOperation, "Fusion did not attest the effective execution lifetime.");
    const state = fusionState(reply.data);
    if (!state)
      return this.fail(intended, "Fusion launch outcome requires reconciliation.", true);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId: state.runId,
      recovery: OPERATION_RECOVERY.OBSERVE,
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
    return new RevmuxReviewClient({ cwd: run.worktreeCwd,
      stateDirectory: join(resolve(run.worktreeCwd, commonDir), "plan-exec-review", run.id),
      reviewedCommit: text(run.activeOperation?.params?.reviewedCommit) ?? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]),
      ...(run.config.revmuxExecutable ? { executable: run.config.revmuxExecutable } : {}),
    });
  }

  private async launchFinalizer(run: PlanExecRun): Promise<PlanExecRun> {
    const candidate = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    await this.verifyCandidate(run, candidate);
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
    const capabilities = await this.bridgeCapabilities();
    if (!supportsExecution(capabilities, run.config.executionLifetime)) {
      const reason = "Bridge runtime does not support the requested explicit execution lifetime, durable lookup and process-tree proof.";
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
      task: reviewedCommit ? `${input.task}\nReview exactly commit ${reviewedCommit}.` : input.task,
      cwd: run.worktreeCwd,
      context: "fresh",
      executionLifetime: run.config.executionLifetime,
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
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.reviewIteration
            ? { reviewIteration: input.reviewIteration }
            : {}),
        },
        ...(input.taskId && run.tasks?.[String(input.taskId)] ? { tasks: { ...run.tasks,
          [String(input.taskId)]: { ...run.tasks[String(input.taskId)]!, state: "running", operationId,
            attempts: run.tasks[String(input.taskId)]!.attempts + 1 } } } : {}),
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
    if (!sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), run.config.executionLifetime))
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
      effectiveLifetime: run.config.executionLifetime,
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
      if (lookupState === EXTERNAL_OPERATION_STATE.FOUND) {
        if (!sameLifetime(parseExecutionLifetime(lookup.data.effectiveExecutionLifetime), run.config.executionLifetime))
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
            return this.registry.update(withoutOperation(run));
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

    const reply = await (await this.reviewClient(run)).status(undefined, operation.operationId);
    if (!reply.success)
      return this.failUnknownLaunch(run, operation, reply.error.message);
    const state = fusionState(reply.data);
    if (!state)
      return this.failUnknownLaunch(run, operation, "Fusion lookup did not prove an adoptable operation; retaining ownership.");
    return this.updateActiveOperation(run, operation.operationId, {
      externalRunId: state.runId,
      recovery: OPERATION_RECOVERY.OBSERVE,
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
    const reply = await this.bridge.spawn(
      operation.operationId,
      operation.params,
      owner,
    );
    if (!reply.success)
      return this.failUnknownLaunch(run, operation, reply.error.message);
    if (!sameLifetime(parseExecutionLifetime(reply.data.effectiveExecutionLifetime), run.config.executionLifetime))
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

  private async observePausedOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation) return run;
    if (!operation.externalRunId) {
      const reply = operation.service === OPERATION_SERVICE.BRIDGE
        ? await this.bridge.operation(operation.operationId, bridgeOperationOwner(run, operation))
        : await (await this.reviewClient(run)).status(undefined, operation.operationId);
      if (!reply.success) return this.recordObservationFailure(run, operation, reply.error.message);
      const runId = operation.service === OPERATION_SERVICE.BRIDGE ? text(reply.data.runId) : fusionState(reply.data)?.runId;
      if (!runId || (operation.service === OPERATION_SERVICE.BRIDGE &&
        (reply.data.state !== EXTERNAL_OPERATION_STATE.FOUND || reply.data.requestDigest !== operation.requestDigest)))
        return this.recordObservationFailure(run, operation, "Paused operation launch remains unresolved; no replacement is authorized.");
      return this.updateActiveOperation(run, operation.operationId, { externalRunId: runId, recovery: OPERATION_RECOVERY.OBSERVE });
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
    );
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
    const status = await this.bridgeStatus(run, operation);
    if (!status.success)
      return this.recordObservationFailure(
        run,
        operation,
        status.error.message,
      );
    const state = text(status.data.state);
    const observed = await this.recordObservation(
      run,
      operation,
      status.data.text,
      state,
      status.data.activity,
      status.data,
    );
    if (!sameOperationState(run, observed, operation)) return observed;
    if (
      !state ||
      state === EXTERNAL_OPERATION_STATE.RUNNING ||
      state === EXTERNAL_OPERATION_STATE.STOPPING
    )
      return observed;
    if (!hasProcessExit(status.data, operation.externalRunId!))
      return this.recordObservationFailure(observed, operation, "Terminal wrapper state has no confirmed process-tree exit; retaining ownership.");
    operation = { ...operation, processTreeExited: true, lastObservedState: state };
    const terminalError = bridgeTerminalError(status.data);
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
      return this.finishImplementation(current, operation, state, terminalError, output);
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
    const observed = await this.recordObservation(run, operation, status.data.text, undefined, status.data.activity, status.data);
    if (!sameOperationState(run, observed, operation)) return observed;
    const state = fusionState(status.data);
    if (!state || !state.terminal) return observed;
    if (state.runId !== operation.externalRunId)
      return this.recordObservationFailure(observed, operation, "Fusion status did not match the tracked run identity.");
    if (!hasProcessExit(status.data, operation.externalRunId!))
      return this.recordObservationFailure(observed, operation, "Fusion termination has no confirmed process-tree exit; retaining ownership.");
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
      accumulated[key] = Math.max(prior, value);
      taskUsage[key] = (taskUsage[key] ?? 0) + Math.max(value - prior, 0);
      runUsage[key] = (runUsage[key] ?? 0) + Math.max(value - prior, 0);
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

  private async recordObservationFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = (operation.statusFailures ?? 0) + 1;
    const failedRun = {
      ...run,
      nextAttemptAt: Date.now() + retryDelay(run.config.retryDelayMs, failures),
      wakeReason: error,
      needsAttention: failures >= MAX_STATUS_FAILURES,
      activeOperation: {
        ...operation,
        statusFailures: failures,
        lastStatusError: error,
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
    const plan =
      run.stage === RUN_STAGE.ARCHIVE
        ? undefined
        : await readPlan(run.planPath);
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
    terminalError?: string,
    output?: string,
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
    const blocker = taskFailureReason(output);
    const attempts = (run.taskAttempts[String(taskId)] ?? 0) + 1;
    const tasks = reconcileTasks(plan.tasks, run.tasks);
    const execution = tasks[String(taskId)]!;
    let reason = blocker ?? terminalError ?? `Worker ended as ${state} with incomplete task ${taskId}.`;
    if (isSuccessfulOperationState(state) && !blocker && task.unchecked.length === 0) {
      try {
        const candidate = execution.candidateCommit ?? await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
        if (candidate === execution.baselineCommit) throw new Error("Task candidate did not advance its baseline commit.");
        const committedPlanText = await gitValue(this.runCommand, run.worktreeCwd, ["show", `${candidate}:${gitPath(relative(run.worktreeCwd, run.planPath))}`]);
        const committedPlan = parsePlan(run.planPath, committedPlanText);
        if (committedPlan.hash !== run.planHash || committedPlan.tasks.find((entry) => entry.id === taskId)?.unchecked.length !== 0)
          throw new Error("Task checkboxes must be complete in the committed candidate plan.");
        const verifying = await this.registry.updateIfCurrent({ ...run, tasks: { ...tasks,
          [String(taskId)]: { ...execution, state: "verifying", candidateCommit: candidate },
        } }, run.updatedAt);
        if (!verifying.applied) return verifying.run;
        run = verifying.run;
        await this.verifyCandidate(run, candidate);
        const accepted = await this.registry.updateIfCurrent(withoutOperation({ ...run,
          acceptedHead: candidate, nextAttemptAt: 0, needsAttention: false,
          tasks: { ...tasks, [String(taskId)]: { ...execution, state: "accepted", acceptedCommit: candidate, candidateCommit: candidate } },
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
    const waiting = await this.registry.updateIfCurrent(withoutOperation({ ...run,
      status: RUN_STATUS.RUNNING, nextAttemptAt: 0,
      tasks: { ...tasks, [String(taskId)]: { ...execution,
        state: "retry_wait", reason, nextAttemptAt: retryAt,
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
    const cleared = withoutOperation({ ...run, reviewFindings: findings });
    if (findings.length === 0) {
      delete cleared.reviewRecovery;
      cleared.reviewedCommit = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
      await appendProgress(cleared, `${run.stage} found no issues.`);
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
    if (
      !isInsideWorktree(sourceRelative) ||
      !isInsideWorktree(destinationRelative) ||
      (progressRelative !== undefined && !isInsideWorktree(progressRelative))
    )
      return this.fail(run, "Archive paths must stay inside the execution worktree.");

    const status = completionStatus(run);
    const source = gitPath(sourceRelative);
    const destinationPath = gitPath(destinationRelative);
    try {
      await assertNoSymlinkPath(run.worktreeCwd, run.planPath);
      await assertNoSymlinkPath(run.worktreeCwd, destination);
      if (run.progressPath)
        await assertNoSymlinkPath(run.worktreeCwd, run.progressPath);
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
      await appendProgressOnce(run, `Run completed as ${status}.`);

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
      const add = await this.runCommand(
        "git",
        ["add", "-f", "-A", "--", ...addPaths],
        run.worktreeCwd,
      );
      if (add.code !== 0)
        throw new Error(add.stderr.trim() || "Could not stage archived plan.");
      const pending = await this.runCommand(
        "git",
        ["status", "--porcelain", "--", ...literalPaths],
        run.worktreeCwd,
      );
      if (pending.code !== 0)
        throw new Error(
          pending.stderr.trim() || "Could not verify archived plan state.",
        );
      if (pending.stdout.trim()) {
        const commit = await this.runCommand(
          "git",
          [
            "commit",
            "--only",
            "-m",
            `chore: archive ${basename(destination)}`,
            "--",
            ...literalPaths,
          ],
          run.worktreeCwd,
        );
        if (commit.code !== 0)
          throw new Error(
            commit.stderr.trim() || "Could not commit archived plan.",
          );
      }
    } catch (error: unknown) {
      return this.fail(
        run,
        `Plan archival failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Git has durably completed. A registry failure must not turn that fact
    // into a new archival failure; the next resume can reconcile this state.
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
    if (!run.tasks || !Object.values(run.tasks).length || Object.values(run.tasks).some((task) => task.state !== "accepted"))
      return "Completion requires every implementation task to be accepted; skipped or unchecked tasks remain unmet.";
    const head = await gitValue(this.runCommand, run.worktreeCwd, ["rev-parse", "HEAD"]);
    if (!run.verifiedCommit) return "Required checks do not cover the current final commit.";
    if (run.config.reviewRequired && run.reviewedCommit !== run.verifiedCommit) return "Required review does not cover the final verified commit.";
    const archivePaths = new Set([relative(run.worktreeCwd, run.planPath),
      relative(run.worktreeCwd, join(dirname(run.planPath), COMPLETED_PLANS_DIRECTORY, basename(run.planPath))),
      ...(run.progressPath ? [relative(run.worktreeCwd, run.progressPath)] : [])]);
    if (run.verifiedCommit !== head) {
      const archived = !(await pathExists(run.planPath));
      const changes = await this.runCommand("git", ["diff", "--name-only", "-z", run.verifiedCommit, head], run.worktreeCwd);
      if (!archived || changes.code !== 0 || changes.stdout.split("\0").some((path) => path && !archivePaths.has(path)))
        return "Current code differs from the final verified and reviewed commit.";
    }
    const dirty = await this.runCommand("git", ["status", "--porcelain", "-z", "--untracked-files=normal"], run.worktreeCwd);
    if (dirty.code !== 0 || dirty.stdout.split("\0").some((entry) => entry && !archivePaths.has(entry.slice(PORCELAIN_PATH_OFFSET))))
      return "Uncommitted source changes prevent completion.";
    if (hasBlockingFindings(run.reviewFindings) || hasBlockingFindings(run.unresolvedFindings)) return "Blocking review findings remain unresolved.";
    return undefined;
  }

  private async advanceStageSkip(run: PlanExecRun): Promise<PlanExecRun> {
    const request = run.pendingStageSkip;
    if (!request || request.stage !== run.stage)
      return this.fail(
        run,
        "Force-skip state does not match the current stage.",
      );
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
        const launched = await (await this.reviewClient(run)).status(undefined, operation.operationId);
        if (!launched.success)
          return this.recordStageSkipFailure(run, operation, launched.error.message);
        const state = fusionState(launched.data);
        if (
          !state ||
          state.phase === FUSION_PHASE.FAILED ||
          state.phase === FUSION_PHASE.CANCELLED
        )
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
    if (terminal && hasProcessExit(status.data, operation.externalRunId)) return this.finishStageSkip(observed, state);
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
        ? this.bridge.cancelOperation && operation.params
          ? await this.bridge.cancelOperation(operation.operationId, bridgeOperationOwner(run, operation))
          : await this.bridge.stop(operation.externalRunId, operation.asyncDir)
        : await (await this.reviewClient(run)).cancel(operation.externalRunId);
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
      {
        const owner = bridgeOperationOwner(run, operation);
        const cancellation = operation.service === OPERATION_SERVICE.BRIDGE
          ? await this.bridge.cancelOperation?.(operation.operationId, owner)
          : await (await this.reviewClient(run)).cancel(undefined, operation.operationId);
        if (cancellation?.success && cancellation.data.neverStarted === true &&
          cancellation.data.cancellationRequested === true &&
          (operation.service !== OPERATION_SERVICE.BRIDGE || cancellation.data.requestDigest === owner?.requestDigest))
          return this.registry.update(withoutOperation({ ...run, status: RUN_STATUS.CANCELLED }));
        return this.recoverActiveOperation(run, operation);
      }
    if (!operation.stopRequested) {
      const stopped =
        operation.service === OPERATION_SERVICE.BRIDGE
          ? this.bridge.cancelOperation && operation.params
            ? await this.bridge.cancelOperation(operation.operationId, bridgeOperationOwner(run, operation))
            : await this.bridge.stop(operation.externalRunId, operation.asyncDir)
          : await (await this.reviewClient(run)).cancel(operation.externalRunId);
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
    if (!bridgeState || isActiveExternalOperationState(bridgeState) || !hasProcessExit(terminal.data, operation.externalRunId)) {
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
      ...withoutOperation({ ...run,
        status: run.status === RUN_STATUS.CANCEL_PENDING || run.status === RUN_STATUS.SKIP_PENDING || run.status === RUN_STATUS.PAUSED ? run.status : RUN_STATUS.RUNNING,
        error, recoveryAttempts: (run.recoveryAttempts ?? 0) + 1,
        nextAttemptAt: Date.now() + retryDelay(run.config.retryDelayMs, (run.recoveryAttempts ?? 0) + 1), wakeReason: error, needsAttention: true }),
      ...(failedOperation ? { failedOperation } : {}),
      ...(preserveOperation ? { activeOperation: run.activeOperation } : {}),
    });
    try {
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

function hasProcessExit(data: Record<string, unknown>, runId: string): boolean {
  return hasTerminalOwnershipProof(data, runId);
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
    `Already accepted tasks: ${Object.values(run.tasks ?? {}).filter((task) => task.state === "accepted").map((task) => task.taskId).join(", ") || "none"}. Preserve their implementation and reflect their accepted checkbox completion when integrating the plan.`,
    `If a required approval, external prerequisite, or verification cannot be satisfied, do not invent evidence, skip it, or make dummy edits. Leave incomplete checkboxes open and start your final response with ${TASK_FAILED_MARKER} on its own line, followed by Blocker: <exact reason> and Next step: <what is needed>. Partial work is preserved and recovery will be scheduled automatically.`,
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
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const input = finite(tokens.input) ? tokens.input : cost.inputTokens;
  const output = finite(tokens.output) ? tokens.output : cost.outputTokens;
  return { ...(finite(input) ? { inputTokens: input } : {}), ...(finite(output) ? { outputTokens: output } : {}),
    ...(finite(cost.costUsd) ? { cost: cost.costUsd } : {}) };
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
    ...(run.reviewRecovery && run.reviewRecovery.repeats > 1 ? [
      `The same normalized findings remain after ${run.reviewRecovery.repeats} reviews, including commit ${run.reviewRecovery.lastReviewedCommit ?? "unavailable"}. Commit creation has not resolved them.`,
      "Change the diagnosis before editing again: reproduce each blocking scenario, identify why the previous fix missed it, and validate a different repair against that reproduction. Do not repeat the same edit or dismiss the finding to finish.",
    ] : []),
    "Apply only justified findings, run relevant verification, and commit the fixes.",
    "Do not modify plan task checkboxes unless the implementation task itself requires it.",
    "Structured findings:",
    formatFindings(findings),
    "Raw reviewer output:",
    rawOutput,
  ].join("\n\n");
}

function reviewFingerprint(findings: ReviewFinding[]): string {
  const normalized = [...new Set(findings.map((finding) =>
    `${finding.severity}:${finding.summary.trim().replace(/\s+/g, " ").toLowerCase()}`))].sort();
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
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
  delete next.blockedTask;
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
const TASK_FAILED_MARKER = "<<<RALPHEX:TASK_FAILED>>>";

function taskFailureReason(output: string | undefined): string | undefined {
  const lines = output?.trim().split(/\r?\n/);
  if (lines?.[0]?.trim() !== TASK_FAILED_MARKER) return undefined;
  const report = lines.slice(1).join("\n").trim();
  return (report || "Worker reported TASK_FAILED without a reason; inspect its output before retrying.")
    .slice(0, MAX_TERMINAL_ERROR_LENGTH);
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
  return Boolean(run.blockedTask) || recoveryEvidence(run).includes(TASK_FAILED_MARKER) ||
    /\b(billing|payment|quota|rate[- ]limit|provider|credential|authentication|authorization|permission|unavailable|outage|network|manual|external|checkpoint)\b/i.test(
      recoveryEvidence(run),
    );
}

export function isTaskRetryConfirmationRequired(run: PlanExecRun): boolean {
  return (
    (run.status === RUN_STATUS.FAILED ||
      (run.status === RUN_STATUS.PAUSED && run.blockedTask !== undefined)) &&
    run.stage === RUN_STAGE.IMPLEMENTATION &&
    run.activeOperation === undefined &&
    !isModelProviderFailure(run) &&
    isExternalManualBlocker(run)
  );
}

export function isModelProviderFailure(run: PlanExecRun): boolean {
  return !run.blockedTask && isModelProviderFailureText(recoveryEvidence(run));
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
    run.blockedTask?.taskId ??
    run.failedOperation?.taskId ??
    run.error?.match(/Task (\d+)/)?.[1] ??
    run.error?.match(/task (\d+)/i)?.[1] ??
    "the incomplete task";
  return [
    `Task ${taskId} is blocked; no automatic retry will be started.`,
    run.blockedTask?.reason ?? run.failedOperation?.terminalError ?? run.error ?? "Inspect the worker output for the blocker.",
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
