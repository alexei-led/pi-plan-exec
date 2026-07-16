import { randomUUID } from "node:crypto";

export interface EventBus {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

export function requestRpc<T>(options: {
  events: EventBus;
  requestEvent: string;
  replyPrefix: string;
  timeoutMs: number;
  method: string;
  label?: string;
  body: Record<string, unknown>;
  parseReply(value: unknown): T;
  failure(code: "timeout" | "transport", message: string): T;
}): Promise<T> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(value);
    };
    const timeout = setTimeout(
      () =>
        finish(
          options.failure(
            "timeout",
            `${options.label ?? options.method} timed out after ${options.timeoutMs}ms.`,
          ),
        ),
      options.timeoutMs,
    );
    try {
      const registered = options.events.on(
        `${options.replyPrefix}${requestId}`,
        (payload: unknown) => finish(options.parseReply(payload)),
      );
      unsubscribe =
        typeof registered === "function" ? registered : () => undefined;
      if (settled) {
        unsubscribe();
        return;
      }
      options.events.emit(options.requestEvent, {
        version: 1,
        requestId,
        method: options.method,
        ...options.body,
      });
    } catch (error: unknown) {
      finish(
        options.failure(
          "transport",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });
}
