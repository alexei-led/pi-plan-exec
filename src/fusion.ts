import { requestRpc, type EventBus } from "./rpc.js";

export const FUSION_REQUEST_EVENT = "fusion:rpc:v1:request";
const FUSION_REPLY_PREFIX = "fusion:rpc:v1:reply:";
const DEFAULT_FUSION_TIMEOUT_MS = 30_000;

export const FUSION_PHASE = {
  CHAIN: "chain",
  PANEL: "panel",
  JUDGE: "judge",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type FusionPhase =
  (typeof FUSION_PHASE)[keyof typeof FUSION_PHASE];
const FUSION_PHASES = new Set<FusionPhase>(Object.values(FUSION_PHASE));

export interface FusionRunState {
  runId: string;
  operationId?: string;
  phase: FusionPhase;
  terminal: boolean;
  report?: string;
  error?: string;
}

export type FusionResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: { code?: string; message: string } };

export class FusionClient {
  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs = DEFAULT_FUSION_TIMEOUT_MS,
  ) {}

  ping(): Promise<FusionResult> {
    return this.request("ping", {});
  }

  start(
    operationId: string,
    prompt: string,
    profile?: string,
  ): Promise<FusionResult> {
    return this.request("start", {
      params: { operationId, prompt, ...(profile ? { profile } : {}) },
    });
  }

  status(runId?: string, operationId?: string): Promise<FusionResult> {
    return this.select("status", runId, operationId);
  }

  result(runId?: string, operationId?: string): Promise<FusionResult> {
    return this.select("result", runId, operationId);
  }

  adopt(runId: string): Promise<FusionResult> {
    return this.request("adopt", { params: { runId } });
  }

  cancel(runId?: string, operationId?: string): Promise<FusionResult> {
    return this.select("cancel", runId, operationId);
  }

  private select(
    method: "status" | "result" | "cancel",
    runId?: string,
    operationId?: string,
  ): Promise<FusionResult> {
    if (runId && operationId) {
      return Promise.resolve({
        success: false,
        error: {
          code: "invalid_request",
          message: "Specify runId or operationId, not both.",
        },
      });
    }
    return this.request(method, {
      params: {
        ...(runId ? { runId } : {}),
        ...(operationId ? { operationId } : {}),
      },
    });
  }

  private request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<FusionResult> {
    return requestRpc({
      events: this.events,
      requestEvent: FUSION_REQUEST_EVENT,
      replyPrefix: FUSION_REPLY_PREFIX,
      timeoutMs: this.timeoutMs,
      method,
      label: `Fusion ${method}`,
      body,
      parseReply,
      failure: (code, message) => ({
        success: false,
        error: { code, message },
      }),
    });
  }
}

export function fusionState(value: unknown): FusionRunState | undefined {
  if (!isRecord(value)) return undefined;
  const run = isRecord(value.run) ? value.run : value;
  const runId = text(run.runId);
  const phase = text(run.phase);
  const operationId = text(run.operationId);
  const report = text(run.report);
  const error = text(run.error);
  if (
    !runId ||
    !phase ||
    !isFusionPhase(phase) ||
    typeof run.terminal !== "boolean"
  ) {
    return undefined;
  }
  return {
    runId,
    phase,
    terminal: run.terminal,
    ...(operationId ? { operationId } : {}),
    ...(report ? { report } : {}),
    ...(error ? { error } : {}),
  };
}

function parseReply(value: unknown): FusionResult {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    return {
      success: false,
      error: {
        code: "malformed",
        message: "Fusion returned a malformed reply.",
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
            message: "Fusion returned non-object data.",
          },
        };
  }
  const error = isRecord(value.error) ? value.error : {};
  const code = text(error.code);
  return {
    success: false,
    error: {
      ...(code ? { code } : {}),
      message: text(error.message) ?? "Fusion request failed.",
    },
  };
}

function isFusionPhase(value: string): value is FusionPhase {
  return FUSION_PHASES.has(value as FusionPhase);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
