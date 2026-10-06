import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  hasTerminalOwnershipProof,
  type WorkflowTerminalProof,
  workflowTerminalProof,
} from './execution-contract.js';
import {
  nativeBindingAllowed,
  nativeDispatchAllowed,
  nativeOperationDigest,
  nativeWorkflowIdentity,
  record,
  validNativeOperation,
} from './operation-safety.js';
import type { RunRegistry } from './registry.js';
import { required } from './required.js';
import type { EventBus } from './rpc.js';
import type {
  ActiveOperation,
  ExecutionLifetime,
  OperationKind,
  PlanExecRun,
} from './types.js';

export type { NativeOperationMetadata } from './types.js';

export interface NativeOperationBinding {
  operationId: string;
  requestDigest: string;
}
export interface NativePrepareInput {
  operationId: string;
  kind: OperationKind;
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  executionLifetime?: ExecutionLifetime;
  /** Recorded as requested, NOT advertised as enforced on 0.76.1. */
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
  reviewedCommit?: string;
}
export interface NativeObservation {
  state: 'prepared' | 'unknown' | 'bound' | 'retired';
  operation: ActiveOperation;
  reason?: string;
  workflowState?: string;
  proof?: WorkflowTerminalProof;
  stopPending?: boolean;
  successfulChild?: boolean;
  /** Only exact, terminal, caller-bound output is returned here. */
  result?: {
    runId: string;
    childRunId: string;
    key: 'main';
    outputPath: string;
    output: string;
    structuredOutput?: unknown;
    envelope: Record<string, unknown>;
  };
}
export interface LegacyNativeBinding {
  operationId: string;
  requestDigest?: string;
}
export interface LegacyObservation {
  operation: ActiveOperation;
  retired: boolean;
  data?: Record<string, unknown>;
  reason?: string;
}
type Reply =
  | { success: true; data: Record<string, unknown> }
  | { success: false; code: string; message: string };
const REQUEST_EVENT = 'subagents:rpc:v1:request';
const REPLY_PREFIX = 'subagents:rpc:v1:reply:';

/**
 * One awaited main-child workflow on public RPC v1. The registry is the only
 * dispatch ledger. RPC deadlines bound waiting, never schedule retries.
 * Omitted workflow timeout does not disable native child defaults. maxTurns is
 * recorded but unsupported; bounded timeoutMs is passed to both root and child.
 */
export class NativeRuntimeClient {
  private disposed = false;
  private readonly pending = new Set<() => void>();
  private readonly unsubscribeCompletion: (() => void) | undefined;
  constructor(
    private readonly events: EventBus,
    private readonly registry: RunRegistry,
    private readonly getContext: () => ExtensionContext,
    private readonly options: { rpcTimeoutMs?: number } = {},
  ) {
    this.unsubscribeCompletion = events.on(
      'subagent:async-complete',
      (value) => {
        void this.retainCompletion(value).catch(() => undefined);
      },
    );
  }

  async available(): Promise<boolean> {
    const reply = await this.call('ping', {});
    return (
      reply.success &&
      reply.data.version === 1 &&
      record(reply.data.capabilities) &&
      reply.data.capabilities.asyncSpawn === true &&
      reply.data.capabilities.stop === true &&
      record(reply.data.capabilities.processTerminalProof) &&
      reply.data.capabilities.processTerminalProof.version === 1
    );
  }

  private async retainCompletion(value: unknown): Promise<void> {
    if (this.disposed || !record(value) || !record(value.workflowChildren))
      return;
    for (const run of await this.registry.list()) {
      if (this.disposed || run.status === 'abandoned') continue;
      const operation = run.activeOperation ?? run.failedOperation;
      if (
        !operation?.native ||
        operation.native.phase === 'prepared' ||
        !operation.requestDigest ||
        value.sessionId !== operation.native.nativeSessionId ||
        !nativeWorkflowIdentity(
          value.workflowChildren,
          operation.native,
          operation.externalRunId,
        )
      )
        continue;
      await this.observeData(
        run.id,
        {
          operationId: operation.operationId,
          requestDigest: operation.requestDigest,
        },
        { details: value },
      );
    }
  }

  async prepare(
    run: PlanExecRun,
    input: NativePrepareInput,
  ): Promise<ActiveOperation> {
    this.assertLive();
    const sessionId = this.sessionId();
    if (run.status === 'abandoned') throw new Error('Run is abandoned.');
    if (run.lease && run.lease.sessionId !== sessionId)
      throw new Error('Foreign session owns run.');
    if (!input.operationId.trim() || !input.agent.trim() || !input.task.trim())
      throw new Error('Operation, agent and task are required.');
    const lifetime = input.executionLifetime ?? run.config.executionLifetime;
    if (
      lifetime.mode === 'bounded' &&
      (!Number.isSafeInteger(lifetime.timeoutMs) ||
        lifetime.timeoutMs < 1 ||
        lifetime.timeoutMs > 2_147_483_647)
    )
      throw new Error('Invalid bounded timeout.');
    if (
      input.maxTurns !== undefined &&
      (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1)
    )
      throw new Error('Invalid requested maxTurns.');
    const requestId = randomUUID();
    const runDirectory = await realpath(
      dirname(this.registry.authorizationPath(run.id)),
    );
    const nativeDirectory = join(runDirectory, 'native');
    try {
      await mkdir(nativeDirectory, { mode: 0o700 });
    } catch (error) {
      if (!record(error) || error.code !== 'EEXIST') throw error;
    }
    if ((await realpath(nativeDirectory)) !== nativeDirectory)
      throw new Error('Native output directory must not traverse symlinks.');
    const outputDirectory = join(nativeDirectory, requestId);
    await mkdir(outputDirectory, { mode: 0o700 });
    if ((await realpath(outputDirectory)) !== outputDirectory)
      throw new Error('Native output directory must not traverse symlinks.');
    const outputPath = join(outputDirectory, 'main.txt');
    const cwd = input.cwd ?? run.worktreeCwd;
    if (!isAbsolute(cwd)) throw new Error('Native cwd must be absolute.');
    const timeout =
      lifetime.mode === 'bounded' ? { timeoutMs: lifetime.timeoutMs } : {};
    const child = {
      agent: input.agent,
      task: input.task,
      cwd,
      context: 'fresh',
      worktree: false,
      mission: false,
      acceptance: false,
      output: outputPath,
      outputMode: 'file-only',
      ...timeout,
      ...(input.model ? { model: input.model } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    };
    const operation: ActiveOperation = {
      operationId: input.operationId,
      kind: input.kind,
      service: 'native',
      ...(input.reviewedCommit ? { reviewedCommit: input.reviewedCommit } : {}),
      executionGeneration: run.executionGeneration ?? 0,
      stopGeneration: run.stopGeneration ?? 0,
      native: {
        version: 1,
        ownerRunId: run.id,
        ownerSessionId: sessionId,
        nativeSessionId: this.nativeSessionId(),
        phase: 'prepared',
        request: {
          version: 1,
          requestId,
          method: 'spawn',
          params: {
            script: `return await runs.run("main", ${JSON.stringify(child)});`,
            async: true,
            cwd,
            context: 'fresh',
            worktree: false,
            mission: false,
            acceptance: false,
            ...timeout,
          },
        },
        outputPath,
        limits: {
          requestedLifetime: structuredClone(lifetime),
          ...(input.maxTurns !== undefined
            ? { requestedMaxTurns: input.maxTurns }
            : {}),
          childTimeout:
            lifetime.mode === 'bounded' ? 'explicit' : 'native-default',
          maxTurnsEnforced: false,
        },
      },
    };
    operation.requestDigest = nativeOperationDigest(operation);
    return operation;
  }

  async spawn(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { run, operation } = await this.load(runId, binding, true);
    if (operation.native?.phase !== 'prepared')
      return this.operation(runId, binding);
    if (!nativeDispatchAllowed(run, operation, this.sessionId()))
      return {
        state: 'prepared',
        operation,
        reason: 'Dispatch revoked; no spawn emitted.',
      };
    await this.checkOutputPath(runId, operation);
    const claimed = await this.registry.updateIfCurrent(
      {
        ...run,
        activeOperation: {
          ...operation,
          launchStartedAt: Date.now(),
          native: { ...operation.native, phase: 'dispatching' },
        },
      },
      run.updatedAt,
    );
    if (!claimed.applied) return this.operation(runId, binding);
    // Re-read authorization after fsync and before the synchronous bus emit.
    const fresh = await this.load(runId, binding, true);
    if (this.stopIntent(fresh.run, fresh.operation))
      return this.retireNotStarted(runId, binding);
    if (this.disposed)
      return {
        state: 'unknown',
        operation: fresh.operation,
        reason: 'Disposed before dispatch; operation remains fenced.',
      };
    const reply = await this.rpc(operation.native.request, () => {
      if (
        this.sessionId() !== operation.native?.ownerSessionId ||
        this.nativeSessionId() !== operation.native?.nativeSessionId
      )
        throw new Error('Current session changed before dispatch.');
    });
    if (!reply.success)
      return {
        state: 'unknown',
        operation: this.disposed
          ? fresh.operation
          : (await this.load(runId, binding)).operation,
        reason: `${reply.code}: ${reply.message}`,
      };
    return this.observeData(runId, binding, reply.data);
  }

  async operation(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(runId, binding);
    if (operation.native?.phase === 'prepared')
      return { state: 'prepared', operation };
    if (operation.native?.phase === 'retired')
      return {
        state: 'retired',
        operation,
        ...(operation.lastObservedState
          ? { workflowState: operation.lastObservedState }
          : {}),
        ...(operation.native.terminalProof
          ? { proof: operation.native.terminalProof }
          : {}),
      };
    if (operation.externalRunId)
      return this.observeTarget(runId, binding, operation.externalRunId);
    // The released runtime resolves the persisted tool-call alias. Never scan
    // unrelated native runs or treat a missing/expired alias as replay authority.
    return this.observeTarget(
      runId,
      binding,
      `rpc-spawn-${required(operation.native).request.requestId}`,
    );
  }

  status(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    return this.operation(runId, binding);
  }

  async result(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const observed = await this.operation(runId, binding);
    const op = observed.operation;
    if (
      observed.state !== 'retired' ||
      op.native?.retirement !== 'native-proof' ||
      !op.externalRunId ||
      !op.native.childRunId ||
      !op.asyncDir
    )
      return observed;
    let successfulChild = false;
    try {
      const status: unknown = JSON.parse(
        await readFile(join(op.asyncDir, 'status.json'), 'utf8'),
      );
      if (
        !record(status) ||
        status.runId !== op.externalRunId ||
        status.sessionId !== op.native.nativeSessionId ||
        status.toolCallId !== `rpc-spawn-${op.native.request.requestId}` ||
        !nativeWorkflowIdentity(
          status.workflowChildren,
          op.native,
          op.externalRunId,
        ) ||
        !Array.isArray(status.steps) ||
        status.steps.length !== 1 ||
        !record(status.steps[0]) ||
        status.steps[0].runId !== op.native.childRunId ||
        status.steps[0].workflowKey !== 'main' ||
        status.steps[0].status !== 'completed' ||
        status.steps[0].error ||
        status.steps[0].stopped ||
        status.steps[0].interrupted
      )
        throw new Error(
          'Native result source identity or successful child mismatch.',
        );
      successfulChild = true;
      let child: Record<string, unknown>;
      if (
        status.state === 'complete' &&
        record(status.workflow) &&
        record(status.workflow.value)
      ) {
        child = status.workflow.value;
        if (
          child.key !== 'main' ||
          child.runId !== op.native.childRunId ||
          child.ok !== true ||
          child.state === 'running' ||
          child.detached === true ||
          child.interrupted === true ||
          child.stopped === true
        )
          throw new Error(
            'Native workflow has no successful final main child.',
          );
      } else {
        // S25 only: the sole awaited child settled successfully, but the released
        // runtime could not persist the JavaScript continuation after detachment.
        const receipt: unknown = JSON.parse(
          await readFile(join(op.asyncDir, 'workflow-receipt.json'), 'utf8'),
        );
        if (
          status.state !== 'failed' ||
          !record(receipt) ||
          receipt.version !== 1 ||
          receipt.state !== 'failed' ||
          receipt.workflowResolution !== 'settled-awaiting-resume' ||
          receipt.workflowRunId !== op.externalRunId ||
          !nativeWorkflowIdentity(
            receipt.workflowChildren,
            op.native,
            op.externalRunId,
          ) ||
          !record(receipt.entries) ||
          Object.keys(receipt.entries).length !== 1 ||
          !record(receipt.entries.main) ||
          receipt.entries.main.key !== 'main' ||
          receipt.entries.main.latestRunId !== op.native.childRunId
        )
          throw new Error(
            'Native workflow has no exact settled successful child.',
          );
        child = receipt.entries.main;
      }
      if (
        child.outputReference !== op.native.outputPath ||
        (child.outputPathMapping !== undefined &&
          (!record(child.outputPathMapping) ||
            child.outputPathMapping.requestedPath !== op.native.outputPath ||
            child.outputPathMapping.savedPath !== op.native.outputPath))
      )
        throw new Error('Native output binding mismatch.');
      await this.checkOutputPath(runId, op, true);
      const output = await readFile(op.native.outputPath, 'utf8');
      return {
        ...observed,
        result: {
          runId: op.externalRunId,
          childRunId: op.native.childRunId,
          key: 'main',
          outputPath: op.native.outputPath,
          output,
          ...(child.structuredOutput !== undefined
            ? { structuredOutput: child.structuredOutput }
            : {}),
          envelope: status,
        },
      };
    } catch (error) {
      return {
        ...observed,
        successfulChild,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cancelOperation(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    await this.load(runId, binding, true);
    const op = await this.mutate(runId, binding, (current) => ({
      ...current,
      stopRequested: true,
    }));
    if (op.native?.phase === 'prepared')
      return this.retireNotStarted(runId, binding);
    return this.stop(runId, binding);
  }

  async stop(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    await this.load(runId, binding, true);
    await this.mutate(runId, binding, (op) => ({ ...op, stopRequested: true }));
    const observed = await this.operation(runId, binding);
    if (observed.state === 'prepared')
      return this.retireNotStarted(runId, binding);
    if (observed.state === 'retired')
      return { ...observed, stopPending: false };
    const id = observed.operation.externalRunId;
    if (!id) return { ...observed, stopPending: true };
    if (observed.operation.stopDeliveredTo === id)
      return {
        ...observed,
        stopPending: true,
        reason: 'Stop delivered; retirement still unobserved.',
      };
    await this.load(runId, binding, true);
    const reply = await this.call('stop', { id });
    const delivered =
      reply.success &&
      reply.data.runId === id &&
      reply.data.state === 'stopping';
    const operation = await this.mutate(runId, binding, (op) => {
      if (delivered) {
        const updated = { ...op, stopDeliveredTo: id };
        delete updated.cancellationDeliveryError;
        return updated;
      }
      return {
        ...op,
        cancellationDeliveryError: {
          message: reply.success
            ? 'Malformed native stop reply.'
            : reply.message,
          ...(!reply.success ? { upstreamCode: reply.code } : {}),
          observedAt: Date.now(),
        },
      };
    });
    return {
      ...observed,
      operation,
      stopPending: true,
      reason: delivered
        ? 'Stop delivered; retirement still unobserved.'
        : (operation.cancellationDeliveryError?.message ??
          'Stop delivery unconfirmed.'),
    };
  }

  private async loadLegacy(
    runId: string,
    binding: LegacyNativeBinding,
  ): Promise<ActiveOperation> {
    this.assertLive();
    const run = await this.registry.get(runId);
    const op = run?.activeOperation ?? run?.failedOperation;
    if (
      op?.service !== 'bridge' ||
      op.operationId !== binding.operationId ||
      op.requestDigest !== binding.requestDigest
    )
      throw new Error('Legacy operation identity mismatch.');
    return op;
  }

  /** Existing native identity only. No journal writes, adoption or legacy dispatch. */
  async observeLegacy(
    runId: string,
    binding: LegacyNativeBinding,
  ): Promise<LegacyObservation> {
    const operation = await this.loadLegacy(runId, binding);
    if (!operation.externalRunId)
      return {
        operation,
        retired: false,
        reason: `Legacy launch is unbound; explicit schema-7 snapshot import is required. No replay is authorized.`,
      };
    const reply = await this.call('status', { id: operation.externalRunId });
    if (!reply.success)
      return { operation, retired: false, reason: reply.message };
    const details = reply.data.details;
    if (!record(details))
      return {
        operation,
        retired: false,
        reason: 'Native legacy status omitted structured evidence.',
      };
    const summary = record(details.workflowChildren)
      ? details.workflowChildren
      : undefined;
    let source: Record<string, unknown> | undefined;
    const asyncDir =
      operation.asyncDir ??
      (typeof details.workflowReceiptPath === 'string'
        ? dirname(details.workflowReceiptPath)
        : undefined);
    if (
      asyncDir &&
      isAbsolute(asyncDir) &&
      basename(asyncDir) === operation.externalRunId
    ) {
      try {
        const value: unknown = JSON.parse(
          await readFile(join(asyncDir, 'status.json'), 'utf8'),
        );
        if (record(value) && value.runId === operation.externalRunId)
          source = value;
      } catch {
        /* Missing legacy artifacts are not non-start or retirement evidence. */
      }
    }
    const lifecycle = record(details.lifecycleStatus)
      ? details.lifecycleStatus
      : undefined;
    const proof =
      details.workflowTerminalProof ??
      details.processTerminalProof ??
      details.processTerminal ??
      lifecycle?.processTerminal;
    if (
      (summary && summary.workflowRunId !== operation.externalRunId) ||
      (!summary && (!record(proof) || proof.runId !== operation.externalRunId))
    )
      return {
        operation,
        retired: false,
        reason: 'Legacy native identity mismatch.',
      };
    const data: Record<string, unknown> = {
      ...details,
      state: summary
        ? summary.workflowState === 'completed'
          ? 'complete'
          : summary.workflowState
        : source?.state,
      ...(summary ? {} : { processTerminalProof: proof }),
    };
    const caller = binding.requestDigest
      ? {
          operationId: binding.operationId,
          requestDigest: binding.requestDigest,
        }
      : undefined;
    let retired = hasTerminalOwnershipProof(
      data,
      operation.externalRunId,
      caller,
    );
    if (summary && retired) {
      const parsed = workflowTerminalProof(
        proof,
        operation.externalRunId,
        caller,
      );
      const steps = source?.steps;
      retired = Boolean(
        parsed &&
          Array.isArray(steps) &&
          steps.every(
            (step) =>
              record(step) &&
              typeof step.async === 'boolean' &&
              (step.async === false ||
                parsed.children.some((child) => child.runId === step.runId)),
          ) &&
          parsed.children.every((child) =>
            steps.some(
              (step) =>
                record(step) &&
                step.async === true &&
                step.runId === child.runId,
            ),
          ),
      );
      if (!retired) delete data.workflowTerminalProof;
    }
    return { operation, data, retired };
  }

  async resultLegacy(
    runId: string,
    binding: LegacyNativeBinding,
  ): Promise<LegacyObservation> {
    return this.observeLegacy(runId, binding);
  }

  async stopLegacy(
    runId: string,
    binding: LegacyNativeBinding,
  ): Promise<LegacyObservation> {
    const observed = await this.observeLegacy(runId, binding);
    if (observed.retired) return observed;
    const operation = await this.loadLegacy(runId, binding);
    const owner = required(await this.registry.get(runId));
    if (owner.lease && owner.lease.sessionId !== this.sessionId())
      throw new Error('Foreign lease cannot control legacy operation.');
    if (!operation.externalRunId || !operation.asyncDir)
      return {
        ...observed,
        reason:
          'Legacy stop lacks retained native session identity; ownership remains reserved.',
      };
    const source: unknown = JSON.parse(
      await readFile(join(operation.asyncDir, 'status.json'), 'utf8'),
    );
    if (
      !record(source) ||
      source.runId !== operation.externalRunId ||
      source.sessionId !== this.nativeSessionId()
    )
      throw new Error(
        'Foreign or unknown native session cannot control legacy operation.',
      );
    const reply = await this.call('stop', { id: operation.externalRunId });
    return {
      ...observed,
      reason:
        reply.success &&
        reply.data.runId === operation.externalRunId &&
        reply.data.state === 'stopping'
          ? 'Stop delivered; retirement still unobserved.'
          : reply.success
            ? 'Malformed native legacy stop receipt.'
            : reply.message,
    };
  }

  /** No record writes: abandonment has already revoked ordinary mutation. */
  async observeAbandoned(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(runId, binding, false, true);
    if (operation.native?.phase === 'prepared')
      return {
        state: 'retired',
        operation: { ...operation, launchFenced: true },
        stopPending: false,
      };
    if (!operation.externalRunId)
      return {
        state: 'unknown',
        operation,
        reason:
          'Abandoned launch has no exact native identity; checkout remains reserved.',
      };
    return this.observeTarget(runId, binding, operation.externalRunId, true);
  }

  /** Best effort only, after observing retirement; never adopts native authority. */
  async stopAbandoned(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const observed = await this.observeAbandoned(runId, binding);
    if (observed.state === 'retired')
      return { ...observed, stopPending: false };
    const { operation } = await this.load(runId, binding, true, true);
    if (!operation.externalRunId) return { ...observed, stopPending: true };
    const reply = await this.call('stop', { id: operation.externalRunId });
    return {
      ...observed,
      stopPending: true,
      reason:
        reply.success &&
        reply.data.runId === operation.externalRunId &&
        reply.data.state === 'stopping'
          ? 'Stop delivered; retirement still unobserved.'
          : reply.success
            ? 'Malformed native stop reply.'
            : reply.message,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeCompletion?.();
    for (const finish of [...this.pending]) finish();
  }

  private async observeTarget(
    runId: string,
    binding: NativeOperationBinding,
    id: string,
    abandoned = false,
  ): Promise<NativeObservation> {
    const reply = await this.call('status', { id });
    if (!reply.success)
      return {
        state: 'unknown',
        operation: (await this.load(runId, binding, false, abandoned))
          .operation,
        reason: reply.message,
      };
    const operation = (await this.load(runId, binding, false, abandoned))
      .operation;
    const alias = `rpc-spawn-${required(operation.native).request.requestId}`;
    return this.observeData(
      runId,
      binding,
      reply.data,
      id === alias ? undefined : id,
      abandoned,
    );
  }

  private async observeData(
    runId: string,
    binding: NativeOperationBinding,
    data: Record<string, unknown>,
    targetId?: string,
    abandoned = false,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(runId, binding, false, abandoned);
    const meta = required(operation.native);
    const details = data.details;
    const identity = record(details)
      ? nativeWorkflowIdentity(
          details.workflowChildren,
          meta,
          operation.externalRunId ?? targetId,
        )
      : undefined;
    if (
      !identity ||
      !record(details) ||
      (details.runId !== undefined && details.runId !== identity.runId)
    )
      return {
        state: 'unknown',
        operation,
        reason: 'Missing or mismatched structured workflow identity.',
      };
    let asyncDir = operation.asyncDir;
    let receiptPath: string | undefined;
    if (
      typeof details.asyncDir === 'string' &&
      isAbsolute(details.asyncDir) &&
      basename(details.asyncDir) === identity.runId
    )
      asyncDir = details.asyncDir;
    if (
      typeof details.workflowReceiptPath === 'string' &&
      isAbsolute(details.workflowReceiptPath)
    ) {
      try {
        const receipt: unknown = JSON.parse(
          await readFile(details.workflowReceiptPath, 'utf8'),
        );
        if (
          !record(receipt) ||
          receipt.version !== 1 ||
          receipt.workflowRunId !== identity.runId ||
          !nativeWorkflowIdentity(
            receipt.workflowChildren,
            meta,
            identity.runId,
          )
        )
          throw new Error('Receipt identity mismatch.');
        receiptPath = details.workflowReceiptPath;
        if (basename(dirname(receiptPath)) === identity.runId)
          asyncDir = dirname(receiptPath);
      } catch {
        return {
          state: 'unknown',
          operation,
          reason: 'Native receipt identity unavailable or invalid.',
        };
      }
    }
    let observedLimits = meta.observedLimits;
    let sourceStatus: Record<string, unknown> | undefined;
    if (asyncDir) {
      try {
        const source: unknown = JSON.parse(
          await readFile(join(asyncDir, 'status.json'), 'utf8'),
        );
        if (
          !record(source) ||
          source.runId !== identity.runId ||
          source.sessionId !== meta.nativeSessionId ||
          source.toolCallId !== `rpc-spawn-${meta.request.requestId}` ||
          !nativeWorkflowIdentity(source.workflowChildren, meta, identity.runId)
        )
          throw new Error('Native status source identity mismatch.');
        sourceStatus = source;
        const childStep = Array.isArray(source.steps)
          ? source.steps.find(
              (step) =>
                record(step) &&
                step.workflowKey === 'main' &&
                step.runId === identity.childRunId,
            )
          : undefined;
        const workflowTimeout = source.timeoutMs;
        const childTimeout = record(childStep)
          ? childStep.timeoutMs
          : undefined;
        observedLimits = {
          observedAt: Date.now(),
          ...(typeof workflowTimeout === 'number' &&
          Number.isSafeInteger(workflowTimeout) &&
          workflowTimeout > 0
            ? { workflowTimeoutMs: workflowTimeout }
            : {}),
          ...(typeof childTimeout === 'number' &&
          Number.isSafeInteger(childTimeout) &&
          childTimeout > 0
            ? { childTimeoutMs: childTimeout }
            : {}),
        };
      } catch {
        return {
          state: 'unknown',
          operation,
          reason: 'Native status source identity unavailable or invalid.',
        };
      }
    }
    const parsedProof =
      identity.inventoryComplete &&
      ['completed', 'failed', 'stopped'].includes(identity.state)
        ? workflowTerminalProof(details.workflowTerminalProof, identity.runId)
        : undefined;
    const steps = sourceStatus?.steps;
    const step =
      Array.isArray(steps) && steps.length === 1 && record(steps[0])
        ? steps[0]
        : undefined;
    const classified =
      step?.runId === identity.childRunId && step?.workflowKey === 'main';
    const proof =
      parsedProof &&
      Array.isArray(steps) &&
      ((steps.length === 0 &&
        !identity.childRunId &&
        identity.state !== 'completed' &&
        parsedProof.children.length === 0) ||
        (classified &&
          step?.async === true &&
          parsedProof.children.length === 1 &&
          parsedProof.children[0]?.runId === identity.childRunId) ||
        (classified &&
          step?.async === false &&
          parsedProof.children.length === 0))
        ? parsedProof
        : undefined;
    // Retirement follows the published closed-inventory proof AND the actual
    // recorded execution mode, never an inferred synchronous child or empty roster.
    const update = (op: ActiveOperation): ActiveOperation => ({
      ...op,
      externalRunId: identity.runId,
      lastObservedState: identity.state,
      lastObservedAt: Date.now(),
      ...(asyncDir ? { asyncDir } : {}),
      ...(proof ? { processTreeExited: true } : {}),
      native: {
        ...required(op.native),
        phase: proof
          ? 'retired'
          : required(op.native).phase === 'retired'
            ? 'retired'
            : 'bound',
        ...(identity.childRunId ? { childRunId: identity.childRunId } : {}),
        ...(receiptPath ? { workflowReceiptPath: receiptPath } : {}),
        ...(observedLimits ? { observedLimits } : {}),
        ...(proof ? { retirement: 'native-proof', terminalProof: proof } : {}),
      },
    });
    const updated = abandoned
      ? update((await this.load(runId, binding, false, true)).operation)
      : await this.mutate(runId, binding, update);
    return {
      state: updated.native?.phase === 'retired' ? 'retired' : 'bound',
      operation: updated,
      workflowState: identity.state,
      ...(proof ? { proof } : {}),
    };
  }

  private async retireNotStarted(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const operation = await this.mutate(runId, binding, (op) => ({
      ...op,
      launchFenced: true,
      native: {
        ...required(op.native),
        phase: 'retired',
        retirement: 'local-not-started',
      },
    }));
    return { state: 'retired', operation, stopPending: false };
  }
  private stopIntent(run: PlanExecRun, operation: ActiveOperation): boolean {
    return Boolean(
      operation.stopRequested ||
        operation.launchFenced ||
        run.activeOperation?.operationId !== operation.operationId ||
        run.userStopped ||
        run.pendingStageSkip ||
        !['running', 'starting'].includes(run.status) ||
        (operation.stopGeneration ?? 0) !== (run.stopGeneration ?? 0),
    );
  }
  private async load(
    runId: string,
    binding: NativeOperationBinding,
    control = false,
    abandoned = false,
  ): Promise<{ run: PlanExecRun; operation: ActiveOperation }> {
    this.assertLive();
    const run = await this.registry.get(runId);
    if (!run) throw new Error('Native owning run not found.');
    if (abandoned ? run.status !== 'abandoned' : run.status === 'abandoned')
      throw new Error(
        abandoned
          ? 'Read-only abandoned observation requires a final abandoned run.'
          : 'Run is abandoned; ordinary native writes are forbidden.',
      );
    const operation = run.activeOperation ?? run.failedOperation;
    if (
      !operation?.native ||
      operation.operationId !== binding.operationId ||
      operation.requestDigest !== binding.requestDigest ||
      nativeOperationDigest(operation) !== binding.requestDigest ||
      !(abandoned
        ? run.activeOperation === operation &&
          validNativeOperation(operation, run.id)
        : nativeBindingAllowed(run, operation))
    )
      throw new Error('Native operation identity mismatch.');
    if (
      control &&
      (operation.native.ownerSessionId !== this.sessionId() ||
        operation.native.nativeSessionId !== this.nativeSessionId() ||
        (run.lease && run.lease.sessionId !== this.sessionId()))
    )
      throw new Error('Foreign session cannot control native operation.');
    return { run, operation };
  }
  private async mutate(
    runId: string,
    binding: NativeOperationBinding,
    apply: (op: ActiveOperation) => ActiveOperation,
  ): Promise<ActiveOperation> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { run, operation } = await this.load(runId, binding);
      const key = run.activeOperation ? 'activeOperation' : 'failedOperation';
      const written = await this.registry.updateIfCurrent(
        { ...run, [key]: apply(operation) },
        run.updatedAt,
      );
      if (written.applied) return required(written.run[key]);
    }
    throw new Error('Native operation changed repeatedly; retry observation.');
  }
  private async checkOutputPath(
    runId: string,
    op: ActiveOperation,
    mustExist = false,
  ): Promise<void> {
    const meta = required(op.native);
    const root = await realpath(
      dirname(this.registry.authorizationPath(runId)),
    );
    const expected = join(root, 'native', meta.request.requestId, 'main.txt');
    if (
      meta.outputPath !== expected ||
      resolve(meta.outputPath) !== expected ||
      (await realpath(dirname(expected))) !== dirname(expected)
    )
      throw new Error('Native output path escaped owning run directory.');
    try {
      const info = await lstat(expected);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Native output must be a regular non-symlink file.');
      if (info.size > 1_048_576)
        throw new Error('Native output exceeds the 1 MiB artifact limit.');
    } catch (error) {
      if (mustExist || !record(error) || error.code !== 'ENOENT') throw error;
    }
  }
  private sessionId(): string {
    const id = this.getContext().sessionManager.getSessionId();
    if (!id) throw new Error('Current Pi session required.');
    return id;
  }
  private nativeSessionId(): string {
    const manager = this.getContext().sessionManager;
    const id = manager.getSessionFile() ?? manager.getSessionId();
    if (!id) throw new Error('Current native runtime session required.');
    return id;
  }
  private assertLive(): void {
    if (this.disposed) throw new Error('Native runtime client disposed.');
  }
  private call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Reply> {
    return this.rpc({ version: 1, requestId: randomUUID(), method, params });
  }
  private rpc(
    request: {
      version: number;
      requestId: string;
      method: string;
      params: Record<string, unknown>;
    },
    beforeEmit?: () => void,
  ): Promise<Reply> {
    if (this.disposed)
      return Promise.resolve({
        success: false,
        code: 'disposed',
        message: 'Native client disposed.',
      });
    return new Promise((resolveReply) => {
      let done = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (reply: Reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.pending.delete(cancel);
        resolveReply(reply);
      };
      const cancel = () =>
        finish({
          success: false,
          code: 'disposed',
          message: 'Native client disposed; dispatch remains fenced.',
        });
      const timer = setTimeout(
        () =>
          finish({
            success: false,
            code: 'timeout',
            message:
              'Native RPC response lost or unavailable; no replay authorized.',
          }),
        this.options.rpcTimeoutMs ?? 30_000,
      );
      this.pending.add(cancel);
      try {
        unsubscribe = this.events.on(
          `${REPLY_PREFIX}${request.requestId}`,
          (value) => {
            if (
              !record(value) ||
              value.version !== 1 ||
              value.requestId !== request.requestId ||
              value.method !== request.method
            )
              return finish({
                success: false,
                code: 'malformed_reply',
                message: 'Native reply identity mismatch.',
              });
            if (value.success === true && record(value.data))
              finish({ success: true, data: value.data });
            else if (
              value.success === false &&
              record(value.error) &&
              typeof value.error.code === 'string' &&
              typeof value.error.message === 'string'
            )
              finish({
                success: false,
                code: value.error.code,
                message: value.error.message,
              });
            else
              finish({
                success: false,
                code: 'malformed_reply',
                message: 'Malformed native RPC reply.',
              });
          },
        );
        if (done) {
          unsubscribe?.();
          return;
        }
        beforeEmit?.();
        this.events.emit(REQUEST_EVENT, structuredClone(request));
      } catch (error) {
        finish({
          success: false,
          code: 'transport',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
