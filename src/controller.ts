import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readSubagentArtifact } from "./artifact.js";
import { fusionState } from "./fusion.js";
import {
  branchNameFromPlan,
  createWorktree,
  currentBranch,
  defaultBranch,
  ensureCleanForWorktree,
  requireGitRepository,
  verifyExecutionTree,
  worktreePlanPath,
  type RunCommand,
} from "./git.js";
import { readPlan } from "./plan.js";
import { appendProgress, initializeProgress } from "./progress.js";
import { RunRegistry } from "./registry.js";
import {
  formatFindings,
  hasBlockingFindings,
  parseReviewFindings,
} from "./review.js";
import type {
  ActiveOperation,
  FrozenRunConfig,
  PlanExecRun,
  ReviewFinding,
  RunStage,
} from "./types.js";

const MAX_STATUS_FAILURES = 3;
const OPERATION_RECOVERY_DELAY_MS = 35_000;
const SPAWN_CONTENTION_RETRY_MS = 5_000;
export const PLAN_STRUCTURE_CHANGED_ERROR =
  "Plan task structure changed outside checkbox completion.";

const INITIAL_CONFIG: FrozenRunConfig = {
  taskRetries: 1,
  maxTaskIterations: 50,
  reviewIterations: 5,
  fusionIterations: 10,
  finalizeEnabled: true,
  workerAgent: "worker",
  workerMaxTurns: 50,
  reviewerAgent: "reviewer",
  reviewerMaxTurns: 30,
  statsAgent: "reviewer",
  statsMaxTurns: 30,
};

type ServiceReply =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { code?: string; message: string } };

interface BridgeLike {
  spawn(
    operationId: string,
    params: Record<string, unknown>,
  ): Promise<ServiceReply>;
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
      status: "starting",
      stage: "resolve",
      taskAttempts: {},
      stageAttempts: {},
      reviewFindings: [],
      config: INITIAL_CONFIG,
      unresolvedFindings: [],
    });
    return this.advance(await this.registry.claim(run, options.sessionId));
  }

  async markFailed(
    runId: string,
    error: unknown,
  ): Promise<PlanExecRun | undefined> {
    const run = await this.registry.get(runId);
    if (!run || isTerminal(run.status)) return run;
    return this.fail(
      run,
      error instanceof Error ? error.message : String(error),
    );
  }

  async resume(
    runId: string,
    sessionId: string,
    explicit = true,
    reviewedPlanHash?: string,
  ): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(runId, () =>
      this.resumeLocked(runId, sessionId, explicit, reviewedPlanHash),
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
  ): Promise<PlanExecRun> {
    const existing = await this.registry.get(runId);
    if (!existing) throw new Error(`Plan execution run not found: ${runId}`);
    const claimed = await this.registry.claim(existing, sessionId);
    let prepared = claimed;
    if (reviewedPlanHash !== undefined) {
      const adopted = await this.registry.updateIfCurrent(
        { ...claimed, planHash: reviewedPlanHash, status: "paused" },
        claimed.updatedAt,
      );
      if (!adopted.applied) return adopted.run;
      prepared = adopted.run;
    }
    if (explicit && prepared.status === "paused") {
      const resumed = await this.registry.updateIfCurrent(
        clearError({ ...prepared, status: "running" }),
        prepared.updatedAt,
      );
      if (!resumed.applied) return resumed.run;
      prepared = resumed.run;
    }
    return this.advanceUnlocked(await this.adoptActiveOperation(prepared));
  }

  async advance(run: PlanExecRun): Promise<PlanExecRun> {
    const coordinated = await this.registry.withControllerLock(run.id, () =>
      this.advanceUnlocked(run),
    );
    if (coordinated) return coordinated;
    return (await this.registry.get(run.id)) ?? run;
  }

  private async advanceUnlocked(run: PlanExecRun): Promise<PlanExecRun> {
    if (isTerminal(run.status)) return run;
    if (run.status === "cancel_pending") return this.cancel(run);
    if (run.status === "paused") {
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
      case "resolve":
        return this.transition(
          run,
          "project_tasks",
          "Plan validated; projecting task list.",
        );
      case "project_tasks":
        return this.transition(run, "branch", "Task projection created.");
      case "branch":
        return this.transition(
          run,
          "progress",
          `Execution branch ready: ${run.branch}.`,
        );
      case "progress": {
        const progressPath = await initializeProgress(run);
        return this.transition(
          { ...run, progressPath },
          "implementation",
          "Progress log initialized.",
        );
      }
      case "implementation":
        return this.advanceImplementation(run);
      case "comprehensive_review":
      case "smells_review":
      case "critical_review":
        return this.launchReview(run);
      case "fusion_review":
        return this.launchFusion(run);
      case "finalize":
        return this.launchFinalizer(run);
      case "stats":
        return this.launchStats(run);
      case "archive":
        return this.archive(run);
      case "isolation":
        return this.transition(
          run,
          "project_tasks",
          "Isolation was selected before run creation.",
        );
      case "complete":
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
        "comprehensive_review",
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
      kind: "implementation",
      taskId: task.id,
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: workerPrompt(run, task.id, task.title, task.unchecked),
    });
  }

  private async launchReview(run: PlanExecRun): Promise<PlanExecRun> {
    const iteration = (run.stageAttempts[run.stage] ?? 0) + 1;
    const limit =
      run.stage === "comprehensive_review" ? run.config.reviewIterations : 1;
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
      kind: "review",
      reviewIteration: iteration,
      agent: updated.config.reviewerAgent,
      maxTurns: updated.config.reviewerMaxTurns,
      task: reviewerPrompt(updated),
    });
  }

  private async launchFusion(run: PlanExecRun): Promise<PlanExecRun> {
    const iteration = (run.stageAttempts.fusion_review ?? 0) + 1;
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
        stageAttempts: { ...run.stageAttempts, fusion_review: iteration },
        reviewFindings: [],
        activeOperation: {
          operationId,
          service: "fusion",
          kind: "fusion",
          reviewIteration: iteration,
          launchStartedAt,
        },
      },
      run.updatedAt,
    );
    if (!persisted.applied) return persisted.run;
    const intended = persisted.run;
    const reply = await this.fusion.start(
      operationId,
      fusionPrompt(intended),
      intended.config.fusionProfile,
    );
    if (!reply.success) {
      return isAmbiguousLaunchFailure(reply.error)
        ? this.deferActiveOperationRetry(intended, operationId)
        : this.fail(intended, reply.error.message);
    }
    const state = fusionState(reply.data);
    if (!state) return this.deferActiveOperationRetry(intended, operationId);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId: state.runId,
    });
  }

  private launchFinalizer(run: PlanExecRun): Promise<PlanExecRun> {
    if (!run.config.finalizeEnabled)
      return this.transition(run, "stats", "Finalization disabled.");
    return this.launchBridge(run, {
      kind: "finalize",
      agent: run.config.workerAgent,
      maxTurns: run.config.workerMaxTurns,
      task: finalizerPrompt(run),
    });
  }

  private launchStats(run: PlanExecRun): Promise<PlanExecRun> {
    return this.launchBridge(run, {
      kind: "stats",
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
    };
    const persisted = await this.registry.updateIfCurrent(
      {
        ...run,
        status: "running",
        activeOperation: {
          operationId,
          service: "bridge",
          kind: input.kind,
          params,
          launchStartedAt,
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
    if (!reply.success) {
      if (
        isSpawnContention(reply.error.message) ||
        isAmbiguousLaunchFailure(reply.error)
      ) {
        return this.deferActiveOperationRetry(intended, operationId);
      }
      return this.fail(intended, reply.error.message);
    }
    const externalRunId = text(reply.data.runId);
    if (!externalRunId)
      return this.deferActiveOperationRetry(intended, operationId);
    const asyncDir = text(reply.data.asyncDir);
    return this.updateActiveOperation(intended, operationId, {
      externalRunId,
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
    ) {
      return run;
    }
    if (operation.service === "bridge") {
      const params =
        operation.params ??
        (await this.reconstructBridgeParams(run, operation));
      const reply = await this.bridge.spawn(operation.operationId, params);
      if (!reply.success) {
        if (
          isSpawnContention(reply.error.message) ||
          isAmbiguousLaunchFailure(reply.error)
        ) {
          return this.deferActiveOperationRetry(run, operation.operationId);
        }
        return this.fail(run, reply.error.message);
      }
      const externalRunId = text(reply.data.runId);
      if (!externalRunId)
        return this.deferActiveOperationRetry(run, operation.operationId);
      const asyncDir = text(reply.data.asyncDir);
      return this.updateActiveOperation(run, operation.operationId, {
        params,
        externalRunId,
        ...(asyncDir ? { asyncDir } : {}),
      });
    }

    const reply = await this.fusion.start(
      operation.operationId,
      fusionPrompt(run),
      run.config.fusionProfile,
    );
    if (!reply.success) {
      return isAmbiguousLaunchFailure(reply.error)
        ? this.deferActiveOperationRetry(run, operation.operationId)
        : this.fail(run, reply.error.message);
    }
    const state = fusionState(reply.data);
    if (!state)
      return this.deferActiveOperationRetry(run, operation.operationId);
    return this.updateActiveOperation(run, operation.operationId, {
      externalRunId: state.runId,
    });
  }

  private deferActiveOperationRetry(
    run: PlanExecRun,
    operationId: string,
  ): Promise<PlanExecRun> {
    return this.updateActiveOperation(run, operationId, {
      launchStartedAt:
        Date.now() - (OPERATION_RECOVERY_DELAY_MS - SPAWN_CONTENTION_RETRY_MS),
    });
  }

  private async updateActiveOperation(
    run: PlanExecRun,
    operationId: string,
    patch: Partial<ActiveOperation>,
  ): Promise<PlanExecRun> {
    let current = (await this.registry.get(run.id)) ?? run;
    for (let attempt = 0; attempt < 5; attempt += 1) {
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
    if (operation.kind === "implementation") {
      const plan = await readPlan(run.planPath);
      const taskData = plan.tasks.find(
        (candidate) => candidate.id === operation.taskId,
      );
      if (!taskData)
        throw new Error(
          "Cannot recover an implementation task that no longer exists.",
        );
      task = workerPrompt(run, taskData.id, taskData.title, taskData.unchecked);
    } else if (operation.kind === "review") {
      task = reviewerPrompt(run);
    } else if (operation.kind === "fix") {
      task = fixerPrompt(
        run,
        run.reviewFindings,
        formatFindings(run.reviewFindings),
      );
    } else if (operation.kind === "finalize") {
      task = finalizerPrompt(run);
    } else if (operation.kind === "stats") {
      task = statsPrompt(run);
    } else {
      throw new Error(
        `Cannot recover unsupported bridge operation kind: ${operation.kind}.`,
      );
    }
    return {
      agent:
        operation.kind === "stats"
          ? run.config.statsAgent
          : operation.kind === "review"
            ? run.config.reviewerAgent
            : run.config.workerAgent,
      task,
      cwd: run.worktreeCwd,
      context: "fresh",
      turnBudget: {
        maxTurns:
          operation.kind === "stats"
            ? run.config.statsMaxTurns
            : operation.kind === "review"
              ? run.config.reviewerMaxTurns
              : run.config.workerMaxTurns,
      },
      acceptance: false,
    };
  }

  private async observePausedOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation?.externalRunId) return run;
    const status =
      operation.service === "bridge"
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
      operation.service === "bridge"
        ? text(status.data.state)
        : fusionState(status.data)?.phase;
    if (
      !state ||
      state === "running" ||
      state === "stopping" ||
      state === "chain" ||
      state === "panel" ||
      state === "judge"
    ) {
      return observed;
    }
    await appendProgress(
      observed,
      `Paused after active ${operation.kind} operation reached ${state}.`,
    );
    return this.registry.update(withoutOperation(observed));
  }

  private async observeActiveOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation) return this.fail(run, "Active operation is missing.");
    if (!operation.externalRunId)
      return this.recoverActiveOperation(run, operation);
    if (operation.service === "fusion")
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
    if (!state || state === "running" || state === "stopping") return observed;

    if (operation.kind === "implementation")
      return this.finishImplementation(observed, operation, state);
    if (operation.kind === "review") {
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
    if (operation.kind === "fix")
      return this.finishFix(observed, operation, state);
    if (operation.kind === "finalize")
      return this.finishBestEffort(observed, operation, state, "stats");
    if (operation.kind === "stats")
      return this.finishBestEffort(observed, operation, state, "archive");
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
    if (!result.success) return this.fail(run, result.error.message);
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
    if (failures >= MAX_STATUS_FAILURES) return this.fail(run, message);
    return this.registry.heartbeat({
      ...run,
      activeOperation: {
        ...operation,
        statusFailures: failures,
        lastStatusError: error,
      },
    });
  }

  private recordCancellationFailure(
    run: PlanExecRun,
    operation: ActiveOperation,
    error: string,
  ): Promise<PlanExecRun> {
    const failures = Math.min(
      (operation.statusFailures ?? 0) + 1,
      MAX_STATUS_FAILURES,
    );
    return this.registry.heartbeat({
      ...run,
      activeOperation: {
        ...operation,
        statusFailures: failures,
        lastStatusError: error,
      },
    });
  }

  private async pauseForReview(
    run: PlanExecRun,
    error: string,
  ): Promise<PlanExecRun> {
    const paused = await this.registry.updateIfCurrent(
      withoutOperation({ ...run, status: "paused", error }),
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
      run.stage === "comprehensive_review" ? run.config.reviewIterations : 1;
    if (iteration >= limit) {
      return this.fail(
        cleared,
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
    if (state !== "complete" && state !== "done")
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
      run.stage === "comprehensive_review"
        ? run.config.reviewIterations
        : run.stage === "fusion_review"
          ? run.config.fusionIterations
          : 1;
    const singlePass =
      run.stage === "smells_review" || run.stage === "critical_review";
    const minorOnlyFusion =
      run.stage === "fusion_review" && !hasBlockingFindings(findings);
    if (!singlePass && !minorOnlyFusion && iteration >= limit) {
      return this.advanceUnlocked(
        await this.recordUnresolvedAndAdvance(cleared, findings),
      );
    }
    return this.launchBridge(cleared, {
      kind: "fix",
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
    if (state !== "complete")
      return this.fail(cleared, `Fix operation ended as ${state}.`);
    await appendProgress(
      cleared,
      `Applied fixes for ${run.stage} iteration ${operation.reviewIteration ?? 1}.`,
    );
    if (run.stage === "smells_review" || run.stage === "critical_review") {
      return this.advanceUnlocked(
        await this.transition(
          cleared,
          nextStage(run.stage),
          `${run.stage} fixes applied.`,
        ),
      );
    }
    if (
      run.stage === "fusion_review" &&
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
      "completed",
      basename(run.planPath),
    );
    try {
      await mkdir(dirname(destination), { recursive: true });
      await rename(run.planPath, destination);
      const relative = destination.slice(run.worktreeCwd.length + 1);
      const add = await this.runCommand(
        "git",
        ["add", "-A", "--", relative],
        run.worktreeCwd,
      );
      if (add.code === 0) {
        await this.runCommand(
          "git",
          ["commit", "-m", `chore: archive ${basename(destination)}`],
          run.worktreeCwd,
        );
      }
      await appendProgress(run, `Archived plan to ${destination}.`);
    } catch (error: unknown) {
      await appendProgress(
        run,
        `Plan archival failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.complete(
      await this.registry.update({ ...run, stage: "complete" }),
    );
  }

  private async complete(run: PlanExecRun): Promise<PlanExecRun> {
    const status =
      run.unresolvedFindings.length > 0
        ? "completed_with_findings"
        : "completed";
    const completed = await this.registry.update({
      ...run,
      status,
      stage: "complete",
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

  private async cancel(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation)
      return this.registry.release(
        await this.registry.update({ ...run, status: "cancelled" }),
      );
    if (!operation.externalRunId) {
      const recovered = await this.recoverActiveOperation(run, operation);
      return recovered.activeOperation?.externalRunId
        ? this.cancel(recovered)
        : recovered;
    }
    if (!operation.stopRequested) {
      const stopped =
        operation.service === "bridge"
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
      operation.service === "bridge"
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
      operation.service === "bridge"
        ? text(terminal.data.state)
        : fusionState(terminal.data)?.phase;
    if (
      !bridgeState ||
      bridgeState === "running" ||
      bridgeState === "stopping" ||
      bridgeState === "chain" ||
      bridgeState === "panel" ||
      bridgeState === "judge"
    ) {
      return observed;
    }
    const cancelled = withoutOperation({ ...observed, status: "cancelled" });
    await appendProgress(
      cancelled,
      `Cancellation completed after ${operation.kind} reached ${bridgeState}.`,
    );
    return this.registry.release(await this.registry.update(cancelled));
  }

  private async adoptActiveOperation(run: PlanExecRun): Promise<PlanExecRun> {
    const operation = run.activeOperation;
    if (!operation?.externalRunId) return run;
    if (operation.service === "bridge") {
      const adopted = await this.bridge.adopt(
        operation.externalRunId,
        operation.asyncDir,
      );
      if (adopted.success) {
        const asyncDir = text(adopted.data.asyncDir);
        return this.registry.update({
          ...run,
          activeOperation: { ...operation, ...(asyncDir ? { asyncDir } : {}) },
        });
      }
      return run;
    }
    const adopted = await this.fusion.adopt(operation.externalRunId);
    return adopted.success ? run : run;
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
      status: "running",
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

  private async fail(run: PlanExecRun, error: string): Promise<PlanExecRun> {
    const failed = await this.registry.update(
      withoutOperation({ ...run, status: "failed", error }),
    );
    try {
      await appendProgress(failed, `Run failed at ${failed.stage}: ${error}`);
    } catch {
      // The registry is authoritative if the optional progress file is unavailable.
    }
    return failed;
  }
}

function nextStage(stage: RunStage): RunStage {
  const next: Partial<Record<RunStage, RunStage>> = {
    comprehensive_review: "smells_review",
    smells_review: "fusion_review",
    fusion_review: "critical_review",
    critical_review: "finalize",
    finalize: "stats",
    stats: "archive",
    archive: "complete",
  };
  const resolved = next[stage];
  if (!resolved) throw new Error(`No next stage after ${stage}.`);
  return resolved;
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
    "Complete only this task. Modify source code as needed, run relevant verification, commit your work, and mark only its completed plan checkboxes [x].",
    "Change only checkbox markers from [ ] to [x]. Do not change checkbox text, headings, task numbers, or add/remove plan items.",
    "Record verification in your response and progress artifacts, not by rewriting plan item text.",
    "Do not start later tasks. Do not report success until the checkboxes are updated and verification is complete.",
    "Remaining checkbox items:",
    ...unchecked.map((item) => `- [ ] ${item}`),
  ].join("\n");
}

function reviewerPrompt(run: PlanExecRun): string {
  const focus =
    run.stage === "comprehensive_review"
      ? "quality, implementation correctness, testing, simplification, and documentation"
      : run.stage === "smells_review"
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

function isAmbiguousLaunchFailure(error: {
  code?: string;
  message: string;
}): boolean {
  return (
    error.code === "timeout" ||
    error.code === "malformed" ||
    /timed out|malformed reply/i.test(error.message)
  );
}

function isSpawnContention(message: string): boolean {
  return /subagent call is already in progress|exactly ONE subagent call per turn/i.test(
    message,
  );
}

function isTerminal(status: PlanExecRun["status"]): boolean {
  return (
    status === "completed" ||
    status === "completed_with_findings" ||
    status === "cancelled" ||
    status === "failed"
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
