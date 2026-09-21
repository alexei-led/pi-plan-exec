import { createHash } from "node:crypto";
import {
  PROCESS_TERMINAL_STATE,
  type ProcessTerminalProof,
} from "./lifecycle.js";
import { requestRpc, type EventBus } from "./rpc.js";
import type { BridgeResult, ExecutionLifetime } from "./types.js";

export type { EventBus } from "./rpc.js";

export const BRIDGE_REQUEST_EVENT = "plan-exec:bridge:v1:request";
const BRIDGE_REPLY_PREFIX = "plan-exec:bridge:v1:reply:";
export const BRIDGE_V2_REQUEST_EVENT = "plan-exec:bridge:v2:request";
const BRIDGE_V2_REPLY_PREFIX = "plan-exec:bridge:v2:reply:";
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 1_500;
const MAX_NEGOTIATION_TIMEOUT_MS = 2_000;

export interface BridgeOperationOwner {
  kind: "pi-plan-exec";
  runId: string;
  key: string;
  requestDigest: string;
}

export interface BridgeCapabilities {
  protocolVersion: 1 | 2;
  healthy: boolean;
  workflowScriptSpawn: boolean;
  durableOperationLookup: boolean;
  processTerminalProofVersion?: number;
  workflowTerminalProofVersion?: 1;
  executionLifetimeVersion?: 1;
  executionLifetimeModes?: readonly ExecutionLifetime["mode"][];
  processTreeOwnership?: ProcessTreeOwnership;
}

export interface ProcessTreeOwnership {
  version: 1;
  scope: "owned-process-tree" | "posix-process-group" | "process-groups";
  escapedDescendants: "contained" | "unverified" | "unsupported";
}

export function processTreeOwnershipCapabilities(value: unknown):
  Pick<BridgeCapabilities, "processTreeOwnership"> {
  if (!isRecord(value) || value.version !== 1 ||
    (value.scope !== "owned-process-tree" && value.scope !== "posix-process-group" && value.scope !== "process-groups") ||
    (value.escapedDescendants !== "contained" && value.escapedDescendants !== "unverified" && value.escapedDescendants !== "unsupported"))
    return {};
  return { processTreeOwnership: { version: 1, scope: value.scope, escapedDescendants: value.escapedDescendants } };
}

export function supportsOwnedProcessTree(capabilities: Pick<BridgeCapabilities, "processTreeOwnership"> | undefined): boolean {
  return capabilities?.processTreeOwnership?.version === 1 &&
    capabilities.processTreeOwnership.scope === "owned-process-tree" &&
    capabilities.processTreeOwnership.escapedDescendants === "contained";
}

export interface WorkflowTerminalProof {
  version: 1;
  kind: "workflow";
  state: "observed";
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
  depth = 0,
): WorkflowTerminalProof | undefined {
  if (depth > MAX_WORKFLOW_PROOF_DEPTH || !isRecord(value) || value.version !== 1 ||
    value.scope === "process-groups" || value.scope === "posix-process-group" ||
    value.escapedDescendants === "unsupported" || value.escapedDescendants === "unverified" ||
    value.containment === "unverified" ||
    value.kind !== "workflow" || value.state !== PROCESS_TERMINAL_STATE.OBSERVED ||
    value.runId !== expectedRunId || value.dispatchClosed !== true ||
    typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt) ||
    !Array.isArray(value.children)) return undefined;
  const children: WorkflowTerminalProof["children"] = [];
  for (const child of value.children) {
    if (!isRecord(child) || typeof child.runId !== "string" || !child.runId) return undefined;
    const parsed = child.kind === "workflow"
      ? workflowTerminalProof(child, child.runId, depth + 1)
      : processTerminalProof(child, child.runId);
    if (!parsed || parsed.state !== PROCESS_TERMINAL_STATE.OBSERVED) return undefined;
    children.push(parsed);
  }
  return { version: 1, kind: "workflow", state: "observed", runId: expectedRunId,
    dispatchClosed: true, observedAt: value.observedAt, children };
}

export function terminalProofObserved(value: unknown, expectedRunId: string): boolean {
  return workflowTerminalProof(value, expectedRunId) !== undefined ||
    processTerminalProof(value, expectedRunId)?.state === PROCESS_TERMINAL_STATE.OBSERVED;
}

export function hasTerminalOwnershipProof(data: Record<string, unknown>, runId: string): boolean {
  if (data.workflowTerminalProof !== undefined)
    return workflowTerminalProof(data.workflowTerminalProof, runId) !== undefined;
  return terminalProofObserved(data.processTerminalProof, runId);
}

const V1_CAPABILITIES: BridgeCapabilities = {
  protocolVersion: 1,
  healthy: false,
  workflowScriptSpawn: true,
  durableOperationLookup: false,
};

export function bridgeRequestDigest(
  params: Record<string, unknown>,
): string {
  const { cwd, ...spawnParams } = params;
  const payload = {
    ...(typeof cwd === "string" ? { cwd } : {}),
    params: spawnParams,
  };
  return `sha256:${createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex")}`;
}

export function processTerminalProof(
  value: unknown,
  expectedRunId: string,
): ProcessTerminalProof | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.scope === "process-groups" ||
    value.scope === "posix-process-group" ||
    value.escapedDescendants === "unsupported" ||
    value.escapedDescendants === "unverified" ||
    value.containment === "unverified" ||
    value.runId !== expectedRunId ||
    typeof value.runnerProcessInstanceId !== "string" ||
    !value.runnerProcessInstanceId.trim() ||
    (value.state !== PROCESS_TERMINAL_STATE.PENDING &&
      value.state !== PROCESS_TERMINAL_STATE.NOT_STARTED &&
      value.state !== PROCESS_TERMINAL_STATE.OBSERVED &&
      value.state !== PROCESS_TERMINAL_STATE.UNKNOWN) ||
    (value.observedAt !== undefined &&
      (typeof value.observedAt !== "number" ||
        !Number.isFinite(value.observedAt))) ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.state === PROCESS_TERMINAL_STATE.OBSERVED &&
      (typeof value.observedAt !== "number" ||
        !Number.isFinite(value.observedAt) ||
        !Array.isArray(value.instances) ||
        !supportsOwnedProcessTree(processTreeOwnershipCapabilities(value.processTreeOwnership)) ||
        value.instances.some((instance: unknown) => !isRecord(instance) ||
          (isRecord(instance.processTree) && (instance.processTree.mechanism === "posix-process-group" ||
            instance.processTree.containment === "unverified"))))) ||
    (value.state === PROCESS_TERMINAL_STATE.UNKNOWN &&
      (typeof value.reason !== "string" || !value.reason.trim()))
  )
    return undefined;
  return {
    version: 1,
    state: value.state,
    runId: value.runId,
    runnerProcessInstanceId: value.runnerProcessInstanceId,
    ...(typeof value.observedAt === "number"
      ? { observedAt: value.observedAt }
      : {}),
    ...(Array.isArray(value.instances) ? { instances: value.instances } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...processTreeOwnershipCapabilities(value.processTreeOwnership),
  };
}

/** Absence or a malformed capability never implies support for no deadline. */
export function executionLifetimeCapabilities(value: unknown):
  Pick<BridgeCapabilities, "executionLifetimeVersion" | "executionLifetimeModes"> {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.modes) ||
    !value.modes.length || value.modes.some((mode) => mode !== "unbounded" && mode !== "bounded"))
    return {};
  return { executionLifetimeVersion: 1,
    executionLifetimeModes: value.modes.filter((mode): mode is ExecutionLifetime["mode"] =>
      mode === "unbounded" || mode === "bounded") };
}

export function parseExecutionLifetime(value: unknown): ExecutionLifetime | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode === "unbounded" && value.timeoutMs === undefined)
    return { mode: "unbounded" };
  if (value.mode === "bounded" && typeof value.timeoutMs === "number" &&
    Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0)
    return { mode: "bounded", timeoutMs: value.timeoutMs };
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
    if (this.capabilityProbe) return this.capabilityProbe;
    this.capabilityProbe = this.refreshCapabilities();
    try { return await this.capabilityProbe; }
    finally { delete this.capabilityProbe; }
  }

  private async refreshCapabilities(): Promise<BridgeResult> {
    const v2Reply = await this.request(
      2,
      "ping",
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
      "ping",
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
      if (!lifetime || this.negotiated?.healthy !== true ||
        !this.negotiated.executionLifetimeModes?.includes(lifetime.mode) || !supportsOwnedProcessTree(this.negotiated))
        return Promise.resolve({ success: false, error: { code: "unsupported",
          message: "Bridge has not advertised the requested explicit execution lifetime and full owned-process-tree containment." } });
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
          code: "invalid_request",
          message: "Bridge spawn owner requestDigest does not match params.",
        },
      });
    return this.request(this.protocolVersion(), "spawn", {
      operationId,
      ...(typeof cwd === "string" ? { cwd } : {}),
      params: spawnParams,
      ...(this.protocolVersion() === 2 && owner ? { owner } : {}),
    });
  }

  operation(
    operationId: string,
    owner?: BridgeOperationOwner,
  ): Promise<BridgeResult> {
    return this.request(this.protocolVersion(), "operation", {
      operationId,
      ...(this.protocolVersion() === 2 && owner ? { owner } : {}),
    });
  }

  cancelOperation(operationId: string, owner?: BridgeOperationOwner): Promise<BridgeResult> {
    return this.request(this.protocolVersion(), "cancelOperation", {
      operationId,
      ...(this.protocolVersion() === 2 && owner ? { owner } : {}),
    });
  }

  status(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe("status", runId, asyncDir);
  }

  result(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe("result", runId, asyncDir);
  }

  adopt(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe("adopt", runId, asyncDir);
  }

  stop(runId: string, asyncDir?: string): Promise<BridgeResult> {
    return this.observe("stop", runId, asyncDir);
  }

  private protocolVersion(): 1 | 2 {
    return this.negotiated?.protocolVersion ?? 1;
  }

  private observe(
    method: "status" | "result" | "adopt" | "stop",
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
      replyPrefix:
        version === 2 ? BRIDGE_V2_REPLY_PREFIX : BRIDGE_REPLY_PREFIX,
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
    reply.data.protocol !== "plan-exec-bridge" ||
    reply.data.version !== 2 ||
    !isRecord(capabilities) ||
    capabilities.workflowScriptSpawn !== true ||
    !hasDurableOperationLookup
  )
    return undefined;
  const processTerminalProof = capabilities.processTerminalProof;
  if (
    !isRecord(processTerminalProof) ||
    processTerminalProof.version !== 1
  )
    return undefined;
  return {
    protocolVersion: 2,
    healthy: true,
    workflowScriptSpawn: true,
    durableOperationLookup: true,
    processTerminalProofVersion: 1,
    ...(isRecord(capabilities.workflowTerminalProof) && capabilities.workflowTerminalProof.version === 1
      ? { workflowTerminalProofVersion: 1 as const } : {}),
    ...executionLifetimeCapabilities(capabilities.executionLifetime),
    ...processTreeOwnershipCapabilities(capabilities.processTreeOwnership),
  };
}

function parseReply(value: unknown): BridgeResult {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    return {
      success: false,
      error: {
        code: "malformed",
        message: "Bridge returned a malformed reply.",
      },
    };
  }
  if (value.success) {
    return isRecord(value.data)
      ? { success: true, data: value.data }
      : {
          success: false,
          error: {
            code: "malformed",
            message: "Bridge returned non-object data.",
          },
        };
  }
  const error = isRecord(value.error) ? value.error : {};
  return {
    success: false,
    error: {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      message:
        typeof error.message === "string"
          ? error.message
          : "Bridge request failed.",
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
