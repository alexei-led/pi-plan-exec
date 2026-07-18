import { requestRpc, type EventBus } from "./rpc.js";
import type { BridgeResult } from "./types.js";

export type { EventBus } from "./rpc.js";

export const BRIDGE_REQUEST_EVENT = "plan-exec:bridge:v1:request";
const BRIDGE_REPLY_PREFIX = "plan-exec:bridge:v1:reply:";
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

export class BridgeClient {
  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
  ) {}

  ping(): Promise<BridgeResult> {
    return this.request("ping", {});
  }

  spawn(
    operationId: string,
    params: Record<string, unknown>,
  ): Promise<BridgeResult> {
    const { cwd, ...spawnParams } = params;
    return this.request("spawn", {
      operationId,
      ...(typeof cwd === "string" ? { cwd } : {}),
      params: spawnParams,
    });
  }

  operation(operationId: string): Promise<BridgeResult> {
    return this.request("operation", { operationId });
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

  private observe(
    method: "status" | "result" | "adopt" | "stop",
    runId: string,
    asyncDir?: string,
  ): Promise<BridgeResult> {
    return this.request(method, {
      params: { runId, ...(asyncDir ? { asyncDir } : {}) },
    });
  }

  private request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<BridgeResult> {
    return requestRpc({
      events: this.events,
      requestEvent: BRIDGE_REQUEST_EVENT,
      replyPrefix: BRIDGE_REPLY_PREFIX,
      timeoutMs: this.timeoutMs,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
