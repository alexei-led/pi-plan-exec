import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { processTerminalProof } from './execution-contract.js';
import {
  type NativeObservation,
  type NativeOperationBinding,
  type NativePrepareInput,
  NativeRuntimeClient,
} from './native-runtime.js';
import { record } from './operation-safety.js';
import { required } from './required.js';
import type {
  ActiveOperation,
  NativeOperationMetadata,
  PlanExecRun,
} from './types.js';

const MAX_NATIVE_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SINGLE_MODE = 'single';

function pathHint(text: unknown, label: string): string | undefined {
  if (typeof text !== 'string') return undefined;
  const paths = text
    .split('\n')
    .filter((line) => line.startsWith(label + ': '))
    .map((line) => line.slice(label.length + 2));
  return paths.length === 0 ? undefined : paths.length === 1 ? paths[0] : '';
}

async function jsonArtifact(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_NATIVE_ARTIFACT_BYTES
  )
    throw new Error(
      'Native artifact must be a bounded regular non-symlink file.',
    );
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!record(value))
    throw new Error('Native artifact must contain an object.');
  return value;
}

function exactSource(
  source: Record<string, unknown>,
  operation: ActiveOperation,
  id: string,
): boolean {
  const meta = required(operation.native);
  return (
    source.mode === SINGLE_MODE &&
    source.runId === id &&
    source.toolCallId === `rpc-spawn-${meta.request.requestId}` &&
    source.sessionId === meta.nativeSessionId &&
    source.cwd === meta.request.params.cwd &&
    typeof source.launchContractDigest === 'string' &&
    (!meta.launchContractDigest ||
      source.launchContractDigest === meta.launchContractDigest) &&
    Array.isArray(source.steps) &&
    source.steps.length === 1 &&
    record(source.steps[0]) &&
    typeof meta.admittedAgent === 'string' &&
    source.steps[0].agent === meta.admittedAgent
  );
}

/**
 * One direct native leaf per operation. Unlike script roots, mode:single is not
 * eligible for native workflow auto-resume. The inherited authority/transport
 * seams and historical decoder keep their original CAS and stop fences.
 */
export class NativeSingleRuntimeClient extends NativeRuntimeClient {
  private readonly disposers: Array<() => void> = [];
  private closed = false;

  constructor(...args: ConstructorParameters<typeof NativeRuntimeClient>) {
    super(...args);
    for (const event of ['subagent:async-started', 'subagent:async-complete']) {
      const dispose = this.events.on(event, (value) => {
        void this.retainSingleBinding(value).catch(() => undefined);
      });
      if (dispose) this.disposers.push(dispose);
    }
  }

  override async available(): Promise<boolean> {
    const reply = await this.call('ping', {});
    if (!reply.success) return false;
    const data = reply.data;
    let sessionId: string;
    let sessionFile: string | null;
    try {
      const manager = this.getContext().sessionManager;
      sessionId = manager.getSessionId();
      sessionFile = manager.getSessionFile() ?? null;
    } catch {
      return false;
    }
    return (
      data.version === 1 &&
      record(data.session) &&
      data.session.sessionId === sessionId &&
      data.session.sessionFile === sessionFile &&
      record(data.capabilities) &&
      data.capabilities.asyncSpawn === true &&
      data.capabilities.stop === true &&
      record(data.capabilities.processTerminalProof) &&
      data.capabilities.processTerminalProof.version === 1 &&
      record(data.events) &&
      data.events.asyncStarted === 'subagent:async-started' &&
      data.events.jobsChanged === 'subagent:jobs-changed'
    );
  }

  assertRunCompatible(run: PlanExecRun): void {
    for (const operation of [run.activeOperation, run.failedOperation]) {
      if (
        operation?.native?.version === 1 &&
        operation.native.retirement !== 'local-not-started' &&
        !(
          operation.native.phase === 'retired' &&
          operation.lastObservedState === 'completed'
        )
      )
        throw new Error(
          'Historical native workflow requires quiescence before this upgrade. Its original identity and checkout remain reserved; no replacement or in-place work is authorized. Inspect /exec status and retire it with its original runtime, or use explicitly approved isolated recovery. New runs use non-replaying direct singles.',
        );
    }
  }

  override async prepare(
    run: PlanExecRun,
    input: NativePrepareInput,
  ): Promise<ActiveOperation> {
    this.assertRunCompatible(run);
    return this.prepareIntent(run, input, 2);
  }

  override async spawn(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { run, operation } = await this.load(runId, binding, true);
    if (
      operation.native?.version !== 2 &&
      operation.native?.phase === 'prepared'
    )
      this.assertRunCompatible(run);
    return super.spawn(runId, binding);
  }

  override async operation(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(runId, binding);
    if (
      operation.native?.version === 1 &&
      operation.native.retirement !== 'local-not-started' &&
      operation.lastObservedState !== 'completed'
    )
      return {
        state: 'unknown',
        operation,
        reason:
          'Historical workflow recovery is not a direct-single retirement guarantee; preserve the old operation and checkout.',
      };
    return super.operation(runId, binding);
  }

  private async retainSingleBinding(value: unknown): Promise<void> {
    if (
      this.closed ||
      !record(value) ||
      value.mode !== SINGLE_MODE ||
      typeof value.toolCallId !== 'string'
    )
      return;
    for (const run of await this.registry.list()) {
      if (this.closed) return;
      if (run.status === 'abandoned') continue;
      const operation = run.activeOperation ?? run.failedOperation;
      const meta = operation?.native;
      if (
        !operation ||
        meta?.version !== 2 ||
        meta.phase === 'prepared' ||
        value.sessionId !== meta.nativeSessionId ||
        value.toolCallId !== `rpc-spawn-${meta.request.requestId}`
      )
        continue;
      await this.observeData(
        run.id,
        {
          operationId: operation.operationId,
          requestDigest: required(operation.requestDigest),
        },
        { details: { ...value, runId: value.runId ?? value.id } },
      );
    }
  }

  protected override async observeData(
    runId: string,
    binding: NativeOperationBinding,
    data: Record<string, unknown>,
    targetId?: string,
    abandoned: boolean | 'inspect' = false,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(
      runId,
      binding,
      false,
      abandoned === true,
    );
    const meta = required(operation.native);
    if (meta.version === 1) {
      const observed = await super.observeData(
        runId,
        binding,
        data,
        targetId,
        'inspect',
      );
      if (observed.workflowState !== 'completed')
        return {
          state: 'unknown',
          operation,
          reason:
            'Historical workflow successor ownership is not proven; no replacement or retirement is authorized.',
        };
      return super.observeData(runId, binding, data, targetId, abandoned);
    }
    const details = data.details;
    const unknown = (reason: string): NativeObservation => ({
      state: 'unknown',
      operation,
      reason,
    });
    if (
      !record(details) ||
      details.mode !== SINGLE_MODE ||
      typeof details.runId !== 'string' ||
      details.toolCallId !== `rpc-spawn-${meta.request.requestId}`
    )
      return unknown('Missing or mismatched direct-single identity.');
    const id = details.runId;
    if (
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id) ||
      (operation.externalRunId && operation.externalRunId !== id) ||
      (targetId && targetId !== id) ||
      (details.asyncId !== undefined && details.asyncId !== id)
    )
      return unknown('Native direct-single run identity changed.');
    const directory =
      operation.asyncDir ??
      (typeof details.asyncDir === 'string'
        ? details.asyncDir
        : pathHint(data.text, 'Dir'));
    if (!directory || !isAbsolute(directory) || basename(directory) !== id)
      return unknown(
        'Native status path unavailable; correlation is not replay permission.',
      );
    try {
      const asyncDir = await realpath(directory);
      if (basename(asyncDir) !== id)
        throw new Error('Native directory identity mismatch.');
      const source = await jsonArtifact(join(asyncDir, 'status.json'));
      if (
        source.mode !== SINGLE_MODE ||
        source.runId !== id ||
        source.sessionId !== meta.nativeSessionId ||
        source.toolCallId !== `rpc-spawn-${meta.request.requestId}` ||
        (source.cwd !== undefined && source.cwd !== meta.request.params.cwd) ||
        (meta.launchContractDigest &&
          source.launchContractDigest !== undefined &&
          source.launchContractDigest !== meta.launchContractDigest) ||
        !Array.isArray(source.steps) ||
        source.steps.length !== 1 ||
        !record(source.steps[0])
      )
        throw new Error(
          'Native source run/session/request/cwd identity mismatch.',
        );
      const projected = exactSource(source, operation, id);
      if (
        source.cwd !== undefined &&
        source.launchContractDigest !== undefined &&
        meta.admittedAgent &&
        source.steps[0].agent !== meta.admittedAgent
      )
        throw new Error(
          'Native source does not match the admitted agent identity.',
        );
      if (
        details.launchContractDigest !== undefined &&
        source.launchContractDigest !== undefined &&
        details.launchContractDigest !== source.launchContractDigest
      )
        throw new Error('Native launch contract identity mismatch.');
      const lifecycle = record(details.lifecycleStatus)
        ? details.lifecycleStatus
        : undefined;
      const rawProof =
        lifecycle?.processTerminal ?? details.processTerminalProof;
      const parsed = processTerminalProof(rawProof, id);
      const sourceProof = source.processTerminal;
      const runner = parsed?.instances?.find(
        (instance: unknown) =>
          record(instance) &&
          instance.kind === 'runner' &&
          instance.processInstanceId === parsed.runnerProcessInstanceId &&
          typeof instance.closeObservedAt === 'number',
      );
      const proof =
        projected &&
        parsed?.state === 'observed' &&
        runner &&
        record(sourceProof) &&
        sourceProof.runnerProcessInstanceId ===
          parsed.runnerProcessInstanceId &&
        ['complete', 'failed', 'stopped'].includes(String(source.state))
          ? parsed
          : undefined;
      const resultPath =
        typeof details.resultPath === 'string'
          ? details.resultPath
          : pathHint(data.text, 'Result');
      if (
        (details.resultPath !== undefined &&
          typeof details.resultPath !== 'string') ||
        (resultPath !== undefined &&
          (!isAbsolute(resultPath) || basename(resultPath) !== id + '.json'))
      )
        throw new Error('Native result artifact path is contradictory.');
      const step = required(source.steps as Array<Record<string, unknown>>)[0];
      const updatedMeta: Partial<NativeOperationMetadata> = {
        ...(typeof source.launchContractDigest === 'string'
          ? { launchContractDigest: source.launchContractDigest }
          : {}),
        ...(resultPath ? { resultPath } : {}),
        ...(typeof step?.model === 'string' && step.model.length <= 256
          ? { reportedModel: step.model }
          : {}),
        ...(typeof source.timeoutMs === 'number' &&
        Number.isSafeInteger(source.timeoutMs) &&
        source.timeoutMs > 0
          ? {
              observedLimits: {
                childTimeoutMs: source.timeoutMs,
                observedAt: Date.now(),
              },
            }
          : {}),
        ...(proof ? { retirement: 'native-proof', terminalProof: proof } : {}),
      };
      const apply = (op: ActiveOperation): ActiveOperation => ({
        ...op,
        externalRunId: id,
        asyncDir,
        native: {
          ...required(op.native),
          ...updatedMeta,
          phase: proof || op.native?.phase === 'retired' ? 'retired' : 'bound',
          ...(op.native?.retirement && !proof
            ? { retirement: op.native.retirement }
            : {}),
          ...(op.native?.terminalProof && !proof
            ? { terminalProof: op.native.terminalProof }
            : {}),
        },
        lastObservedAt: Date.now(),
        lastObservedState:
          op.native?.phase === 'retired'
            ? (op.lastObservedState ?? String(source.state))
            : String(source.state),
        ...(proof ? { processTreeExited: true } : {}),
      });
      const updated = abandoned
        ? apply(operation)
        : await this.mutate(runId, binding, apply);
      const status: Record<string, unknown> = {};
      for (const key of [
        'activity',
        'totalTokens',
        'totalCost',
        'terminationReason',
        'advisoryObservation',
      ])
        if (source[key] !== undefined) status[key] = source[key];
      if (typeof source.error === 'string')
        status.text = 'Error: ' + source.error;
      else if (typeof data.text === 'string') status.text = data.text;
      return {
        state: proof ? 'retired' : 'bound',
        operation: updated,
        status,
        workflowState: String(source.state),
        ...(proof ? { proof } : {}),
      };
    } catch (error) {
      return unknown(error instanceof Error ? error.message : String(error));
    }
  }

  override async result(
    runId: string,
    binding: NativeOperationBinding,
  ): Promise<NativeObservation> {
    const { operation } = await this.load(runId, binding);
    if (operation.native?.version !== 2) return super.result(runId, binding);
    const observed = await this.operation(runId, binding);
    const op = observed.operation;
    const meta = required(op.native);
    if (
      observed.state !== 'retired' ||
      meta.retirement !== 'native-proof' ||
      !op.externalRunId ||
      !op.asyncDir
    )
      return observed;
    let successfulChild = false;
    try {
      const source = await jsonArtifact(join(op.asyncDir, 'status.json'));
      const retainedProof = processTerminalProof(
        meta.terminalProof,
        op.externalRunId,
      );
      if (
        !exactSource(source, op, op.externalRunId) ||
        !record(source.processTerminal) ||
        !retainedProof ||
        source.processTerminal.runnerProcessInstanceId !==
          retainedProof.runnerProcessInstanceId
      )
        throw new Error('Native result source identity mismatch.');
      const step = (source.steps as Array<Record<string, unknown>>)[0];
      if (
        source.state !== 'complete' ||
        step?.status !== 'complete' ||
        source.error ||
        step.error ||
        step.stopped ||
        step.interrupted ||
        step.exitCode !== 0
      ) {
        let failureOutput: string | undefined;
        try {
          await this.checkOutputPath(runId, op, true);
          failureOutput = await readFile(meta.outputPath, 'utf8');
        } catch {
          /* Failure output is diagnostic only. */
        }
        return {
          ...observed,
          reason:
            typeof step?.error === 'string'
              ? step.error
              : typeof source.error === 'string'
                ? source.error
                : 'Native single did not succeed.',
          ...(failureOutput ? { failureOutput } : {}),
        };
      }
      successfulChild = true;
      let result: Record<string, unknown> | undefined;
      if (meta.resultPath) {
        if (basename(meta.resultPath) !== op.externalRunId + '.json')
          throw new Error('Native result artifact path is contradictory.');
        try {
          result = await jsonArtifact(meta.resultPath);
        } catch (error) {
          // The normal native watcher removes delivered result files. The
          // exact retained single status and caller-bound output remain authoritative.
          if (!record(error) || error.code !== 'ENOENT') throw error;
        }
      }
      const child =
        result &&
        Array.isArray(result.results) &&
        result.results.length === 1 &&
        record(result.results[0])
          ? result.results[0]
          : undefined;
      if (
        result &&
        (result.id !== op.externalRunId ||
          result.mode !== SINGLE_MODE ||
          result.sessionId !== meta.nativeSessionId ||
          result.toolCallId !== `rpc-spawn-${meta.request.requestId}` ||
          result.cwd !== meta.request.params.cwd ||
          result.launchContractDigest !== meta.launchContractDigest ||
          result.success !== true ||
          result.state !== 'complete' ||
          result.exitCode !== 0 ||
          !child ||
          child.success !== true ||
          child.agent !== meta.admittedAgent ||
          child.savedOutputPath !== meta.outputPath ||
          child.launchContractDigest !== meta.launchContractDigest)
      )
        throw new Error(
          'Native successful result identity/output binding mismatch.',
        );
      await this.checkOutputPath(runId, op, true);
      const output = await readFile(meta.outputPath, 'utf8');
      const structured = step.structuredOutput ?? child?.structuredOutput;
      if (
        (step.structuredOutput !== undefined &&
          child?.structuredOutput !== undefined &&
          !isDeepStrictEqual(step.structuredOutput, child.structuredOutput)) ||
        (meta.request.params.outputSchema !== undefined &&
          (structured === undefined ||
            !isDeepStrictEqual(JSON.parse(output), structured)))
      )
        throw new Error(
          'Bound output contradicts native structured settlement.',
        );
      return {
        ...observed,
        result: {
          runId: op.externalRunId,
          outputPath: meta.outputPath,
          output,
          ...(structured !== undefined ? { structuredOutput: structured } : {}),
          envelope: source,
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

  override dispose(): void {
    this.closed = true;
    for (const dispose of this.disposers) dispose();
    super.dispose();
  }
}
