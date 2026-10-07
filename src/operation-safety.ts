import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { workflowTerminalProof } from './execution-contract.js';
import type {
  ActiveOperation,
  NativeOperationMetadata,
  PlanExecRun,
} from './types.js';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only JSON is admitted; property order must not alter durable identity. */
export function nativeDigest(value: unknown): string {
  function canonical(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (record(input))
      return `{${Object.keys(input)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
        .join(',')}}`;
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean' ||
      (typeof input === 'number' && Number.isFinite(input))
    )
      return JSON.stringify(input);
    throw new Error('Native request must contain only JSON values.');
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function nativeOperationDigest(operation: ActiveOperation): string {
  const meta = operation.native;
  if (!meta) throw new Error('Native operation metadata missing.');
  return nativeDigest({
    operationId: operation.operationId,
    kind: operation.kind,
    ...(operation.taskId !== undefined ? { taskId: operation.taskId } : {}),
    ...(operation.reviewIteration !== undefined
      ? { reviewIteration: operation.reviewIteration }
      : {}),
    ...(operation.reviewedCommit
      ? { reviewedCommit: operation.reviewedCommit }
      : {}),
    executionGeneration: operation.executionGeneration ?? 0,
    ownerRunId: meta.ownerRunId,
    ownerSessionId: meta.ownerSessionId,
    nativeSessionId: meta.nativeSessionId,
    request: meta.request,
    outputPath: meta.outputPath,
    limits: meta.limits,
  });
}

/** Binding records a fact that may have happened before a newer stop request. */
export function nativeBindingAllowed(
  run: PlanExecRun,
  expected: ActiveOperation,
): boolean {
  const op = run.activeOperation ?? run.failedOperation;
  return (
    run.status !== 'abandoned' &&
    expected.native?.ownerRunId === run.id &&
    op?.service === 'native' &&
    op.operationId === expected.operationId &&
    op.requestDigest === expected.requestDigest &&
    (op.executionGeneration ?? 0) === (run.executionGeneration ?? 0) &&
    (expected.executionGeneration ?? 0) === (run.executionGeneration ?? 0)
  );
}

export function nativeDispatchAllowed(
  run: PlanExecRun,
  expected: ActiveOperation,
  sessionId: string,
): boolean {
  const op = run.activeOperation;
  return (
    nativeBindingAllowed(run, expected) &&
    op?.operationId === expected.operationId &&
    op.native?.phase === 'prepared' &&
    op.native.ownerSessionId === sessionId &&
    (!run.lease || run.lease.sessionId === sessionId) &&
    ['running', 'starting'].includes(run.status) &&
    !run.userStopped &&
    !run.pendingStageSkip &&
    !op.stopRequested &&
    !op.launchFenced &&
    (op.stopGeneration ?? 0) === (run.stopGeneration ?? 0)
  );
}

export function nativeWorkflowIdentity(
  value: unknown,
  meta: NativeOperationMetadata,
  expectedRunId?: string,
):
  | {
      runId: string;
      childRunId?: string;
      state: string;
      inventoryComplete: boolean;
    }
  | undefined {
  return correlatedWorkflowIdentity(
    value,
    meta.request.requestId,
    expectedRunId,
    meta.childRunId,
  );
}

export function correlatedWorkflowIdentity(
  value: unknown,
  requestId: string,
  expectedRunId?: string,
  expectedChildRunId?: string,
):
  | {
      runId: string;
      childRunId?: string;
      state: string;
      inventoryComplete: boolean;
    }
  | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.parentToolCallId !== `rpc-spawn-${requestId}` ||
    typeof value.workflowRunId !== 'string' ||
    !value.workflowRunId ||
    basename(value.workflowRunId) !== value.workflowRunId ||
    (expectedRunId !== undefined && value.workflowRunId !== expectedRunId) ||
    typeof value.inventoryComplete !== 'boolean' ||
    !['queued', 'running', 'completed', 'failed', 'paused', 'stopped'].includes(
      String(value.workflowState),
    ) ||
    !Array.isArray(value.children) ||
    value.children.length > 1
  )
    return undefined;
  const child: unknown = value.children[0];
  if (
    child !== undefined &&
    (!record(child) ||
      child.childId !== 'main' ||
      ![
        'pending',
        'running',
        'completed',
        'failed',
        'paused',
        'stopped',
        'rejected',
        'detached',
      ].includes(String(child.state)) ||
      (child.runId !== undefined &&
        (typeof child.runId !== 'string' || !child.runId)) ||
      (expectedChildRunId !== undefined && child.runId !== expectedChildRunId))
  )
    return undefined;
  return {
    runId: value.workflowRunId,
    ...(record(child) && typeof child.runId === 'string'
      ? { childRunId: child.runId }
      : {}),
    state: String(value.workflowState),
    inventoryComplete: value.inventoryComplete,
  };
}

/** Narrow additive registry validation; legacy metadata is left untouched. */
export function validNativeOperation(
  operation: ActiveOperation | undefined,
  runId: string,
): boolean {
  if (!operation) return true;
  const meta = operation.native;
  if (!meta) return operation.service !== 'native';
  if (
    operation.service !== 'native' ||
    !record(meta) ||
    meta.version !== 1 ||
    meta.ownerRunId !== runId ||
    typeof meta.ownerSessionId !== 'string' ||
    !meta.ownerSessionId.trim() ||
    typeof meta.nativeSessionId !== 'string' ||
    !meta.nativeSessionId.trim() ||
    !['prepared', 'dispatching', 'bound', 'retired'].includes(meta.phase) ||
    !record(meta.request) ||
    meta.request.version !== 1 ||
    meta.request.method !== 'spawn' ||
    typeof meta.request.requestId !== 'string' ||
    !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(meta.request.requestId) ||
    !record(meta.request.params) ||
    typeof meta.outputPath !== 'string' ||
    !isAbsolute(meta.outputPath) ||
    !record(meta.limits) ||
    meta.limits.maxTurnsEnforced !== false ||
    !['native-default', 'explicit'].includes(meta.limits.childTimeout)
  )
    return false;
  const lifetime = meta.limits.requestedLifetime;
  if (
    !record(lifetime) ||
    (lifetime.mode !== 'unbounded' &&
      !(
        lifetime.mode === 'bounded' &&
        Number.isSafeInteger(lifetime.timeoutMs) &&
        lifetime.timeoutMs > 0 &&
        lifetime.timeoutMs <= 2_147_483_647
      ))
  )
    return false;
  if (
    meta.limits.requestedMaxTurns !== undefined &&
    (!Number.isSafeInteger(meta.limits.requestedMaxTurns) ||
      meta.limits.requestedMaxTurns < 1)
  )
    return false;
  for (const value of [meta.childRunId, meta.workflowReceiptPath])
    if (value !== undefined && (typeof value !== 'string' || !value.trim()))
      return false;
  if (
    meta.retirement !== undefined &&
    !['local-not-started', 'native-proof'].includes(meta.retirement)
  )
    return false;
  if (
    (meta.phase === 'bound' || meta.retirement === 'native-proof') &&
    !operation.externalRunId
  )
    return false;
  if (meta.observedLimits !== undefined) {
    if (
      !record(meta.observedLimits) ||
      !Number.isSafeInteger(meta.observedLimits.observedAt) ||
      meta.observedLimits.observedAt < 0
    )
      return false;
    for (const timeout of [
      meta.observedLimits.workflowTimeoutMs,
      meta.observedLimits.childTimeoutMs,
    ])
      if (
        timeout !== undefined &&
        (!Number.isSafeInteger(timeout) || timeout < 1)
      )
        return false;
  }
  if (meta.phase === 'retired' && !meta.retirement) return false;
  if (meta.retirement !== undefined && meta.phase !== 'retired') return false;
  if (
    meta.retirement === 'local-not-started' &&
    operation.externalRunId !== undefined
  )
    return false;
  if (
    meta.terminalProof !== undefined &&
    (!operation.externalRunId ||
      !workflowTerminalProof(meta.terminalProof, operation.externalRunId))
  )
    return false;
  if (meta.retirement === 'native-proof' && !meta.terminalProof) return false;
  try {
    return operation.requestDigest === nativeOperationDigest(operation);
  } catch {
    return false;
  }
}

/** Retained recovery evidence is not an additional dispatch ledger. */
export function validProviderFailure(
  operation: ActiveOperation | undefined,
  runId: string,
  taskId?: number,
): boolean {
  return Boolean(
    operation &&
      typeof operation === 'object' &&
      operation.service === 'native' &&
      operation.kind === 'implementation' &&
      operation.taskId === taskId &&
      operation.processTreeExited === true &&
      operation.lastObservedState === 'failed' &&
      operation.native?.phase === 'retired' &&
      operation.native.retirement === 'native-proof' &&
      operation.externalRunId &&
      operation.requestDigest &&
      validNativeOperation(operation, runId) &&
      workflowTerminalProof(
        operation.native.terminalProof,
        operation.externalRunId,
        {
          operationId: operation.operationId,
          requestDigest: operation.requestDigest,
        },
      ),
  );
}
