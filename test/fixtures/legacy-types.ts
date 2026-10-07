import type { ProcessTreeOwnership } from '../../src/execution-contract.js';
import type { ExecutionLifetime } from '../../src/types.js';
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

export type BridgeResult =
  | { success: true; data: Record<string, unknown> }
  | {
      success: false;
      error: { code?: string; upstreamCode?: string; message: string };
    };
