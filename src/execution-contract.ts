import {
  PROCESS_TERMINAL_STATE,
  type ProcessTerminalProof,
} from './lifecycle.js';
import type { ExecutionLifetime } from './types.js';

/** Provider attestations; requested limits alone never establish enforcement. */
export interface ExecutionCapabilities {
  executionLifetimeVersion?: 1;
  executionLifetimeModes?: readonly ExecutionLifetime['mode'][];
  processTreeOwnership?: ProcessTreeOwnership;
}

export interface ProcessTreeOwnership {
  version: 1;
  scope: 'owned-process-tree' | 'posix-process-group' | 'process-groups';
  escapedDescendants:
    | 'contained'
    | 'best-effort'
    | 'unverified'
    | 'unsupported';
}

export function processTreeOwnershipCapabilities(
  value: unknown,
): Pick<ExecutionCapabilities, 'processTreeOwnership'> {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.scope !== 'owned-process-tree' &&
      value.scope !== 'posix-process-group' &&
      value.scope !== 'process-groups') ||
    (value.escapedDescendants !== 'contained' &&
      value.escapedDescendants !== 'best-effort' &&
      value.escapedDescendants !== 'unverified' &&
      value.escapedDescendants !== 'unsupported')
  )
    return {};
  return {
    processTreeOwnership: {
      version: 1,
      scope: value.scope,
      escapedDescendants: value.escapedDescendants,
    },
  };
}

export function supportsOwnedProcessTree(
  capabilities: Pick<ExecutionCapabilities, 'processTreeOwnership'> | undefined,
): boolean {
  const ownership = capabilities?.processTreeOwnership;
  return (
    ownership?.version === 1 &&
    (ownership.scope === 'owned-process-tree' ||
      ownership.scope === 'posix-process-group') &&
    (ownership.escapedDescendants === 'contained' ||
      ownership.escapedDescendants === 'best-effort')
  );
}

export interface CallerBinding {
  operationId: string;
  requestDigest: string;
}

export function hasOwnedProcessRetirementProof(
  observation: unknown,
  binding: unknown,
): boolean {
  if (
    !isRecord(observation) ||
    observation.status !== 'retired' ||
    !isRecord(observation.proof) ||
    !isRecord(binding)
  )
    return false;
  const proof = observation.proof;
  if (proof.version !== 1 || proof.kind !== 'process-group-retired')
    return false;
  if (
    typeof proof.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(proof.observedAt))
  )
    return false;
  const identity = proof.identity;
  if (
    !isRecord(identity) ||
    identity.version !== 1 ||
    identity.backend !== 'posix-process-group-v1'
  )
    return false;
  if (!Number.isSafeInteger(identity.pgid) || (identity.pgid as number) <= 0)
    return false;
  if (
    !isRecord(identity.leader) ||
    !Number.isSafeInteger(identity.leader.pid) ||
    (identity.leader.pid as number) <= 0
  )
    return false;
  if (typeof identity.leader.startIdentity !== 'string') return false;
  for (const key of ['operationId', 'requestDigest', 'hostId', 'bootId']) {
    if (
      typeof binding[key] !== 'string' ||
      !binding[key] ||
      proof[key] !== binding[key]
    )
      return false;
  }
  return true;
}

export interface WorkflowTerminalProof {
  version: 1;
  kind: 'workflow';
  state: 'observed';
  runId: string;
  dispatchClosed: true;
  observedAt: number;
  children: Array<ProcessTerminalProof | WorkflowTerminalProof>;
}

const MAX_WORKFLOW_PROOF_DEPTH = 32;

/** A persistent workflow host need not exit, but every dispatched child must. */
export function workflowTerminalProof(
  value: unknown,
  expectedRunId: string,
  expectedCaller?: CallerBinding,
): WorkflowTerminalProof | undefined {
  if (callerBindingMismatch(value, expectedCaller)) return undefined;
  return parseWorkflowTerminalProof(value, expectedRunId, 0);
}

function parseWorkflowTerminalProof(
  value: unknown,
  expectedRunId: string,
  depth: number,
): WorkflowTerminalProof | undefined {
  if (
    depth > MAX_WORKFLOW_PROOF_DEPTH ||
    !isRecord(value) ||
    value.version !== 1 ||
    value.scope === 'process-groups' ||
    value.scope === 'posix-process-group' ||
    value.escapedDescendants === 'unsupported' ||
    value.escapedDescendants === 'unverified' ||
    value.containment === 'unverified' ||
    value.kind !== 'workflow' ||
    value.state !== PROCESS_TERMINAL_STATE.OBSERVED ||
    value.runId !== expectedRunId ||
    value.dispatchClosed !== true ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    !Array.isArray(value.children)
  )
    return undefined;
  const children: WorkflowTerminalProof['children'] = [];
  for (const child of value.children) {
    if (!isRecord(child) || typeof child.runId !== 'string' || !child.runId)
      return undefined;
    const parsed =
      child.kind === 'workflow'
        ? parseWorkflowTerminalProof(child, child.runId, depth + 1)
        : parseProcessTerminalProof(child, child.runId);
    if (
      !parsed ||
      (parsed.state !== PROCESS_TERMINAL_STATE.OBSERVED &&
        parsed.state !== PROCESS_TERMINAL_STATE.NOT_STARTED)
    )
      return undefined;
    children.push(parsed);
  }
  return {
    version: 1,
    kind: 'workflow',
    state: 'observed',
    runId: expectedRunId,
    dispatchClosed: true,
    observedAt: value.observedAt,
    children,
  };
}

export function terminalProofObserved(
  value: unknown,
  expectedRunId: string,
  expectedCaller?: CallerBinding,
): boolean {
  return (
    workflowTerminalProof(value, expectedRunId, expectedCaller) !== undefined ||
    processTerminalProof(value, expectedRunId, expectedCaller)?.state ===
      PROCESS_TERMINAL_STATE.OBSERVED
  );
}

export function hasTerminalOwnershipProof(
  data: Record<string, unknown>,
  runId: string,
  expectedCaller?: CallerBinding,
): boolean {
  if (data.workflowTerminalProof !== undefined)
    return (
      workflowTerminalProof(
        data.workflowTerminalProof,
        runId,
        expectedCaller,
      ) !== undefined
    );
  return terminalProofObserved(
    data.processTerminalProof,
    runId,
    expectedCaller,
  );
}

/** A released proof may omit callerBinding; only an explicit mismatch is rejected. */
function callerBindingMismatch(
  value: unknown,
  expected: CallerBinding | undefined,
): boolean {
  if (expected === undefined) return false;
  if (!isRecord(value) || value.callerBinding === undefined) return false;
  return (
    !isRecord(value.callerBinding) ||
    value.callerBinding.operationId !== expected.operationId ||
    value.callerBinding.requestDigest !== expected.requestDigest
  );
}

export function processTerminalProof(
  value: unknown,
  expectedRunId: string,
  expectedCaller?: CallerBinding,
): ProcessTerminalProof | undefined {
  if (callerBindingMismatch(value, expectedCaller)) return undefined;
  return parseProcessTerminalProof(value, expectedRunId);
}

function parseProcessTerminalProof(
  value: unknown,
  expectedRunId: string,
): ProcessTerminalProof | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.scope === 'process-groups' ||
    value.scope === 'posix-process-group' ||
    value.escapedDescendants === 'unsupported' ||
    value.escapedDescendants === 'unverified' ||
    value.containment === 'unverified' ||
    value.runId !== expectedRunId ||
    typeof value.runnerProcessInstanceId !== 'string' ||
    !value.runnerProcessInstanceId.trim() ||
    (value.state !== PROCESS_TERMINAL_STATE.PENDING &&
      value.state !== PROCESS_TERMINAL_STATE.NOT_STARTED &&
      value.state !== PROCESS_TERMINAL_STATE.OBSERVED &&
      value.state !== PROCESS_TERMINAL_STATE.UNKNOWN) ||
    (value.observedAt !== undefined &&
      (typeof value.observedAt !== 'number' ||
        !Number.isFinite(value.observedAt))) ||
    (value.reason !== undefined && typeof value.reason !== 'string') ||
    (value.state === PROCESS_TERMINAL_STATE.OBSERVED &&
      (typeof value.observedAt !== 'number' ||
        !Number.isFinite(value.observedAt) ||
        (!Array.isArray(value.instances) && !isRecord(value.writers)))) ||
    (value.state === PROCESS_TERMINAL_STATE.UNKNOWN &&
      (typeof value.reason !== 'string' || !value.reason.trim()))
  )
    return undefined;
  return {
    version: 1,
    state: value.state,
    runId: value.runId,
    runnerProcessInstanceId: value.runnerProcessInstanceId,
    ...(typeof value.observedAt === 'number'
      ? { observedAt: value.observedAt }
      : {}),
    ...(Array.isArray(value.instances) ? { instances: value.instances } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...processTreeOwnershipCapabilities(value.processTreeOwnership),
    ...(value.nativeOperation !== undefined
      ? { nativeOperation: value.nativeOperation }
      : {}),
    ...(value.callerBinding !== undefined
      ? { callerBinding: value.callerBinding }
      : {}),
  };
}

/** Absence or a malformed capability never implies support for no deadline. */
export function executionLifetimeCapabilities(
  value: unknown,
): Pick<
  ExecutionCapabilities,
  'executionLifetimeVersion' | 'executionLifetimeModes'
> {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.modes) ||
    !value.modes.length ||
    value.modes.some((mode) => mode !== 'unbounded' && mode !== 'bounded')
  )
    return {};
  return {
    executionLifetimeVersion: 1,
    executionLifetimeModes: value.modes.filter(
      (mode): mode is ExecutionLifetime['mode'] =>
        mode === 'unbounded' || mode === 'bounded',
    ),
  };
}

export function parseExecutionLifetime(
  value: unknown,
): ExecutionLifetime | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode === 'unbounded' && value.timeoutMs === undefined)
    return { mode: 'unbounded' };
  if (
    value.mode === 'bounded' &&
    typeof value.timeoutMs === 'number' &&
    Number.isSafeInteger(value.timeoutMs) &&
    value.timeoutMs > 0
  )
    return { mode: 'bounded', timeoutMs: value.timeoutMs };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
