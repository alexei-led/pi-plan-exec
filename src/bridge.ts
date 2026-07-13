import { randomUUID } from "node:crypto";
import type { BridgeResult } from "./types.js";

export const BRIDGE_REQUEST_EVENT = "plan-exec:bridge:v1:request";
const BRIDGE_REPLY_PREFIX = "plan-exec:bridge:v1:reply:";

export interface EventBus {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

export class BridgeClient {
  constructor(
    private readonly events: EventBus,
    private readonly timeoutMs = 30_000,
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
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const state: { timeout?: ReturnType<typeof setTimeout> } = {};
      const registered = this.events.on(
        `${BRIDGE_REPLY_PREFIX}${requestId}`,
        (payload: unknown) => {
          if (state.timeout) clearTimeout(state.timeout);
          unsubscribe();
          resolve(parseReply(payload));
        },
      );
      const unsubscribe =
        typeof registered === "function" ? registered : () => undefined;
      state.timeout = setTimeout(() => {
        unsubscribe();
        resolve({
          success: false,
          error: {
            code: "timeout",
            message: `Bridge ${method} timed out after ${this.timeoutMs}ms.`,
          },
        });
      }, this.timeoutMs);
      this.events.emit(BRIDGE_REQUEST_EVENT, {
        version: 1,
        requestId,
        method,
        ...body,
      });
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
