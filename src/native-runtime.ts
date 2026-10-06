import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type WorkflowTerminalProof, workflowTerminalProof } from './bridge.js';
import {
  nativeBindingAllowed,
  nativeDispatchAllowed,
  nativeOperationDigest,
  nativeWorkflowIdentity,
  record,
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
}
export interface NativeObservation {
  state: 'prepared' | 'unknown' | 'bound' | 'retired';
  operation: ActiveOperation;
  reason?: string;
  workflowState?: string;
  proof?: WorkflowTerminalProof;
  stopPending?: boolean;
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
  constructor(
    private readonly events: EventBus,
    private readonly registry: RunRegistry,
    private readonly getContext: () => ExtensionContext,
    private readonly options: { rpcTimeoutMs?: number } = {},
  ) {}

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
      executionGeneration: run.executionGeneration ?? 0,
      stopGeneration: run.stopGeneration ?? 0,
      native: {
        version: 1,
        ownerRunId: run.id,
        ownerSessionId: sessionId,
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
      if (this.sessionId() !== operation.native?.ownerSessionId)
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
    // Released status snapshots supply candidates, never identity proof. No
    // completeness assumption: omitted/expired entries remain unknown.
    const list = await this.call('status', {});
    if (!list.success)
      return { state: 'unknown', operation, reason: list.message };
    const snapshot = list.data.asyncSnapshot;
    if (
      record(snapshot) &&
      snapshot.version === 1 &&
      snapshot.kind === 'pi-subagents.async-status-snapshot' &&
      Array.isArray(snapshot.runs)
    ) {
      for (const candidate of snapshot.runs.slice(0, 64)) {
        if (
          !record(candidate) ||
          candidate.kind !== 'workflow' ||
          typeof candidate.id !== 'string'
        )
          continue;
        const observed = await this.observeTarget(runId, binding, candidate.id);
        if (observed.state !== 'unknown') return observed;
      }
    }
    return {
      state: 'unknown',
      operation,
      reason:
        'No exact retained workflow correlation; dispatch is fenced, not replayable.',
    };
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
    try {
      const status: unknown = JSON.parse(
        await readFile(join(op.asyncDir, 'status.json'), 'utf8'),
      );
      if (
        !record(status) ||
        status.runId !== op.externalRunId ||
        status.sessionId !== op.native.ownerSessionId ||
        status.toolCallId !== `rpc-spawn-${op.native.request.requestId}` ||
        !nativeWorkflowIdentity(
          status.workflowChildren,
          op.native,
          op.externalRunId,
        ) ||
        !record(status.workflow) ||
        !record(status.workflow.value)
      )
        throw new Error('Native result source identity mismatch.');
      const child = status.workflow.value;
      if (
        child.key !== 'main' ||
        child.runId !== op.native.childRunId ||
        child.ok !== true ||
        child.state === 'running' ||
        child.detached === true ||
        child.interrupted === true ||
        child.stopped === true ||
        status.state !== 'complete'
      )
        throw new Error('Native workflow has no successful final main child.');
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

  dispose(): void {
    this.disposed = true;
    for (const finish of [...this.pending]) finish();
  }

  private async observeTarget(
    runId: string,
    binding: NativeOperationBinding,
    id: string,
  ): Promise<NativeObservation> {
    const reply = await this.call('status', { id });
    if (!reply.success)
      return {
        state: 'unknown',
        operation: (await this.load(runId, binding)).operation,
        reason: reply.message,
      };
    return this.observeData(runId, binding, reply.data, id);
  }

  private async observeData(
    runId: string,
    binding: NativeOperationBinding,
    data: Record<string, unknown>,
    targetId?: string,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(runId, binding);
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
    if (asyncDir) {
      try {
        const source: unknown = JSON.parse(
          await readFile(join(asyncDir, 'status.json'), 'utf8'),
        );
        if (
          !record(source) ||
          source.runId !== identity.runId ||
          source.sessionId !== meta.ownerSessionId ||
          source.toolCallId !== `rpc-spawn-${meta.request.requestId}` ||
          !nativeWorkflowIdentity(source.workflowChildren, meta, identity.runId)
        )
          throw new Error('Native status source identity mismatch.');
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
    const proof = parsedProof?.children.every(
      (child) => child.runId === identity.childRunId,
    )
      ? parsedProof
      : undefined;
    // For this single synchronous main child, native may publish an empty
    // process roster. Do not synthesize an OS-process proof for the host.
    const updated = await this.mutate(runId, binding, (op) => ({
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
    }));
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
  ): Promise<{ run: PlanExecRun; operation: ActiveOperation }> {
    this.assertLive();
    const run = await this.registry.get(runId);
    if (!run) throw new Error('Native owning run not found.');
    if (run.status === 'abandoned')
      throw new Error(
        'Run is abandoned; ordinary native writes are forbidden.',
      );
    const operation = run.activeOperation ?? run.failedOperation;
    if (
      !operation?.native ||
      operation.operationId !== binding.operationId ||
      operation.requestDigest !== binding.requestDigest ||
      nativeOperationDigest(operation) !== binding.requestDigest ||
      !nativeBindingAllowed(run, operation)
    )
      throw new Error('Native operation identity mismatch.');
    if (
      control &&
      (operation.native.ownerSessionId !== this.sessionId() ||
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
    } catch (error) {
      if (mustExist || !record(error) || error.code !== 'ENOENT') throw error;
    }
  }
  private sessionId(): string {
    const id = this.getContext().sessionManager.getSessionId();
    if (!id) throw new Error('Current Pi session required.');
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
