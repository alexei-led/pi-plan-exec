import { createHash } from 'node:crypto';
import {
  executionLifetimeCapabilities,
  type ProcessTreeOwnership,
  parseExecutionLifetime,
  processTreeOwnershipCapabilities,
  supportsOwnedProcessTree,
} from './execution-contract.js';
import { type EventBus, requestRpc } from './rpc.js';
import type { BridgeResult, ExecutionLifetime } from './types.js';

export * from './execution-contract.js';
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
  prelaunchRejectionVersion?: 1;
}

/** Validate new rejection receipts; legacy never-started fences retain their contract. */
export function hasBoundNeverStarted(
  data: Record<string, unknown>,
  binding: { operationId: string; requestDigest?: string },
  ownerRunId: string,
): boolean {
  if (
    data.state === 'retired' ||
    data.launchRetirement !== undefined ||
    data.neverStarted !== true ||
    data.operationId !== binding.operationId ||
    !binding.requestDigest ||
    data.requestDigest !== binding.requestDigest
  )
    return false;
  const proof = data.launchRejection;
  if (proof === undefined && data.state !== 'not_started') return true;
  return (
    isRecord(proof) &&
    proof.version === 1 &&
    proof.source === 'subagents-rpc' &&
    typeof proof.requestId === 'string' &&
    Boolean(proof.requestId.trim()) &&
    proof.method === 'spawn' &&
    proof.code === 'invalid_params' &&
    typeof proof.message === 'string' &&
    Boolean(proof.message.trim()) &&
    proof.operationId === binding.operationId &&
    proof.requestDigest === binding.requestDigest &&
    proof.ownerRunId === ownerRunId &&
    data.runId === undefined &&
    data.replaySafe === false
  );
}

/** An exact lookup can reattach a writer; it is not evidence that the writer exited. */
export function hasBoundOperation(
  data: unknown,
  operation: {
    operationId: string;
    requestDigest?: string;
    externalRunId?: string;
    expectedLifetime?: ExecutionLifetime;
    effectiveLifetime?: ExecutionLifetime;
    params?: Record<string, unknown>;
  },
): boolean {
  if (
    !isRecord(data) ||
    data.state !== 'found' ||
    data.operationId !== operation.operationId ||
    !operation.requestDigest ||
    data.requestDigest !== operation.requestDigest ||
    typeof data.runId !== 'string' ||
    !data.runId.trim() ||
    (operation.externalRunId !== undefined &&
      data.runId !== operation.externalRunId) ||
    data.launchRetirement !== undefined ||
    data.neverStarted === true
  )
    return false;
  const expected =
    operation.expectedLifetime ??
    parseExecutionLifetime(operation.params?.executionLifetime) ??
    operation.effectiveLifetime;
  const actual = parseExecutionLifetime(data.effectiveExecutionLifetime);
  return (
    expected !== undefined &&
    actual !== undefined &&
    expected.mode === actual.mode &&
    (expected.mode === 'unbounded' ||
      (actual.mode === 'bounded' && actual.timeoutMs === expected.timeoutMs))
  );
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
    ...(isRecord(capabilities.prelaunchRejection) &&
    capabilities.prelaunchRejection.version === 1
      ? { prelaunchRejectionVersion: 1 as const }
      : {}),
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
      ...(typeof error.upstreamCode === 'string'
        ? { upstreamCode: error.upstreamCode }
        : {}),
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
