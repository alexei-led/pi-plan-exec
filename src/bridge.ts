import { createHash } from 'node:crypto';
import {
  PROCESS_TERMINAL_STATE,
  type ProcessTerminalProof,
} from './lifecycle.js';
import { type EventBus, requestRpc } from './rpc.js';
import type { BridgeResult, ExecutionLifetime } from './types.js';

export type { EventBus } from './rpc.js';

export const BRIDGE_REQUEST_EVENT = 'plan-exec:bridge:v1:request';
const BRIDGE_REPLY_PREFIX = 'plan-exec:bridge:v1:reply:';
export const BRIDGE_V2_REQUEST_EVENT = 'plan-exec:bridge:v2:request';
const BRIDGE_V2_REPLY_PREFIX = 'plan-exec:bridge:v2:reply:';
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 1_500;
const MAX_NEGOTIATION_TIMEOUT_MS = 2_000;

export interface BridgeOperationOwner {
  kind: 'pi-plan-exec';
  runId: string;
  key: string;
  requestDigest: string;
}

export interface BridgeCapabilities {
  protocolVersion: 1 | 2;
  healthy: boolean;
  workflowScriptSpawn: boolean;
  singleAgentSpawn?: boolean;
  durableOperationLookup: boolean;
  processTerminalProofVersion?: number;
  executionLifetimeVersion?: 1;
  executionLifetimeModes?: readonly ExecutionLifetime['mode'][];
  processTreeOwnership?: ProcessTreeOwnership;
  diagnosticGuidance?: DiagnosticGuidanceCapability;
}

export interface DiagnosticGuidanceCapability {
  version: 1;
  idempotent: true;
  mode: 'follow_up';
  confirmedToolFailure: true;
}

export interface DiagnosticGuidanceRequest {
  diagnosticId: string;
  toolCallId: string;
  message: string;
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
): Pick<BridgeCapabilities, 'processTreeOwnership'> {
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
  capabilities: Pick<BridgeCapabilities, 'processTreeOwnership'> | undefined,
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

const V1_CAPABILITIES: BridgeCapabilities = {
  protocolVersion: 1,
  healthy: false,
  workflowScriptSpawn: true,
  durableOperationLookup: false,
};

export function bridgeRequestDigest(params: Record<string, unknown>): string {
  const { cwd, ...spawnParams } = params;
  const payload = {
    ...(typeof cwd === 'string' ? { cwd } : {}),
    params: spawnParams,
  };
  return `sha256:${createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex')}`;
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
  BridgeCapabilities,
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

export class BridgeClient {
  private negotiated?: BridgeCapabilities;
  private capabilityProbe?: Promise<BridgeResult>;
  private readonly negotiationTimeoutMs: number;

  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
    negotiationTimeoutMs = DEFAULT_NEGOTIATION_TIMEOUT_MS,
  ) {
    this.negotiationTimeoutMs = Math.max(
      1,
      Math.min(negotiationTimeoutMs, MAX_NEGOTIATION_TIMEOUT_MS),
    );
  }

  async ping(): Promise<BridgeResult> {
    const probe = this.capabilityProbe;
    if (probe && (await probe)) return probe;
    this.capabilityProbe = this.refreshCapabilities();
    try {
      return await this.capabilityProbe;
    } finally {
      delete this.capabilityProbe;
    }
  }

  private async refreshCapabilities(): Promise<BridgeResult> {
    const v2Reply = await this.request(
      2,
      'ping',
      {},
      this.negotiationTimeoutMs,
    );
    const capabilities = parseV2Capabilities(v2Reply);
    if (capabilities) {
      this.negotiated = capabilities;
      return v2Reply;
    }
    if (this.negotiated?.protocolVersion === 2) {
      this.negotiated = { ...this.negotiated, healthy: false };
      return v2Reply;
    }

    const v1Reply = await this.request(
      1,
      'ping',
      {},
      this.negotiationTimeoutMs,
    );
    this.negotiated = { ...V1_CAPABILITIES, healthy: v1Reply.success };
    return v1Reply;
  }

  async capabilities(): Promise<BridgeCapabilities> {
    await this.ping();
    return this.negotiated ?? V1_CAPABILITIES;
  }

  spawn(
    operationId: string,
    params: Record<string, unknown>,
    owner?: BridgeOperationOwner,
  ): Promise<BridgeResult> {
    if (params.executionLifetime !== undefined) {
      const lifetime = parseExecutionLifetime(params.executionLifetime);
      if (
        !lifetime ||
        this.negotiated?.healthy !== true ||
        this.negotiated.singleAgentSpawn !== true ||
        !this.negotiated.executionLifetimeModes?.includes(lifetime.mode) ||
        !supportsOwnedProcessTree(this.negotiated)
      )
        return Promise.resolve({
          success: false,
          error: {
            code: 'unsupported',
            message:
              'Bridge has not advertised the requested explicit execution lifetime and full owned-process-tree containment.',
          },
        });
    }
    const effectiveParams: Record<string, unknown> = {
      ...params,
      mission: false,
    };
    const cwd = effectiveParams.cwd;
    const spawnParams = { ...effectiveParams };
    delete spawnParams.cwd;
    if (
      this.protocolVersion() === 2 &&
      owner &&
      owner.requestDigest !== bridgeRequestDigest(effectiveParams)
    )
      return Promise.resolve({
        success: false,
        error: {
          code: 'invalid_request',
          message: 'Bridge spawn owner requestDigest does not match params.',
        },
      });
    return this.request(this.protocolVersion(), 'spawn', {
      operationId,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      params: spawnParams,
      ...(this.protocolVersion() === 2 && owner ? { owner } : {}),
    });
  }

  operation(
    operationId: string,
    owner?: BridgeOperationOwner,
  ): Promise<BridgeResult> {
    return this.request(owner ? 2 : this.protocolVersion(), 'operation', {
      operationId,
      ...(owner ? { owner } : {}),
    });
  }

  cancelOperation(
    operationId: string,
    owner?: BridgeOperationOwner,
  ): Promise<BridgeResult> {
    return this.request(2, 'cancelOperation', {
      operationId,
      ...(owner ? { owner } : {}),
    });
  }

  diagnoseOperation(
    operationId: string,
    owner: BridgeOperationOwner,
    params: DiagnosticGuidanceRequest,
  ): Promise<BridgeResult> {
    if (
      this.negotiated?.healthy !== true ||
      this.negotiated.protocolVersion !== 2 ||
      !this.negotiated.diagnosticGuidance
    )
      return Promise.resolve({
        success: false,
        error: {
          code: 'unsupported',
          message:
            'Bridge does not advertise confirmed-failure diagnostic guidance.',
        },
      });
    if (
      ![params.diagnosticId, params.toolCallId, params.message].every(
        (value) => typeof value === 'string' && value.trim(),
      )
    )
      return Promise.resolve({
        success: false,
        error: {
          code: 'invalid_request',
          message:
            'Diagnostic guidance requires a stable ID, confirmed tool call, and message.',
        },
      });
    return this.request(2, 'diagnoseOperation', { operationId, owner, params });
  }

  status(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe('status', runId, asyncDir);
  }

  result(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe('result', runId, asyncDir);
  }

  adopt(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe('adopt', runId, asyncDir);
  }

  stop(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe('stop', runId, asyncDir);
  }

  private protocolVersion(): 1 | 2 {
    return this.negotiated?.protocolVersion ?? 1;
  }

  private observe(
    method: 'status' | 'result' | 'adopt' | 'stop',
    runId: string,
    asyncDir?: string,
  ): Promise<BridgeResult> {
    return this.request(this.protocolVersion(), method, {
      params: { runId, ...(asyncDir ? { asyncDir } : {}) },
    });
  }

  private request(
    version: 1 | 2,
    method: string,
    body: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
  ): Promise<BridgeResult> {
    return requestRpc({
      events: this.events,
      requestEvent:
        version === 2 ? BRIDGE_V2_REQUEST_EVENT : BRIDGE_REQUEST_EVENT,
      replyPrefix: version === 2 ? BRIDGE_V2_REPLY_PREFIX : BRIDGE_REPLY_PREFIX,
      timeoutMs,
      version,
      method,
      label: `Bridge ${method}`,
      body,
      parseReply,
      failure: (code, message) => ({
        success: false,
        error: { code, message },
      }),
    });
  }
}

function parseV2Capabilities(
  reply: BridgeResult,
): BridgeCapabilities | undefined {
  if (!reply.success) return undefined;
  const capabilities = reply.data.capabilities;
  const durableOperationLookup = isRecord(capabilities)
    ? capabilities.durableOperationLookup
    : undefined;
  const hasDurableOperationLookup =
    durableOperationLookup === true ||
    (isRecord(durableOperationLookup) && durableOperationLookup.version === 1);
  if (
    reply.data.protocol !== 'plan-exec-bridge' ||
    reply.data.version !== 2 ||
    !isRecord(capabilities) ||
    (capabilities.singleAgentSpawn !== true &&
      capabilities.workflowScriptSpawn !== true) ||
    !hasDurableOperationLookup
  )
    return undefined;
  const processTerminalProof = capabilities.processTerminalProof;
  if (!isRecord(processTerminalProof) || processTerminalProof.version !== 1)
    return undefined;
  return {
    protocolVersion: 2,
    healthy: true,
    workflowScriptSpawn: capabilities.workflowScriptSpawn === true,
    singleAgentSpawn: capabilities.singleAgentSpawn === true,
    durableOperationLookup: true,
    processTerminalProofVersion: 1,
    ...executionLifetimeCapabilities(capabilities.executionLifetime),
    ...processTreeOwnershipCapabilities(capabilities.processTreeOwnership),
    ...(isRecord(capabilities.diagnosticGuidance) &&
    capabilities.diagnosticGuidance.version === 1 &&
    capabilities.diagnosticGuidance.idempotent === true &&
    capabilities.diagnosticGuidance.mode === 'follow_up' &&
    capabilities.diagnosticGuidance.confirmedToolFailure === true
      ? {
          diagnosticGuidance: {
            version: 1,
            idempotent: true,
            mode: 'follow_up',
            confirmedToolFailure: true,
          } as const,
        }
      : {}),
  };
}

function parseReply(value: unknown): BridgeResult {
  if (!isRecord(value) || typeof value.success !== 'boolean') {
    return {
      success: false,
      error: {
        code: 'malformed',
        message: 'Bridge returned a malformed reply.',
      },
    };
  }
  if (value.success) {
    return isRecord(value.data)
      ? { success: true, data: value.data }
      : {
          success: false,
          error: {
            code: 'malformed',
            message: 'Bridge returned non-object data.',
          },
        };
  }
  const error = isRecord(value.error) ? value.error : {};
  return {
    success: false,
    error: {
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      message:
        typeof error.message === 'string'
          ? error.message
          : 'Bridge request failed.',
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      item === undefined ? null : canonicalValue(item),
    );
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
