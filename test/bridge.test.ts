import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_REQUEST_EVENT,
  BridgeClient,
  type EventBus,
} from "../src/bridge.js";

class TestEvents implements EventBus {
  private readonly handlers = new Map<string, (payload: unknown) => void>();
  emitted?: { event: string; payload: Record<string, unknown> };
  throwOnEmit = false;

  on(event: string, handler: (payload: unknown) => void): () => void {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }

  emit(event: string, payload: unknown): void {
    if (this.throwOnEmit) throw new Error("event bus unavailable");
    this.emitted = { event, payload: payload as Record<string, unknown> };
  }

  reply(prefix: string, payload: unknown): void {
    const requestId = String(this.emitted?.payload.requestId);
    this.handlers.get(`${prefix}${requestId}`)?.(payload);
  }
}

test("Bridge client sends spawn and cleans up a parsed reply", async () => {
  const events = new TestEvents();
  const bridge = new BridgeClient(events, 50);
  const pending = bridge.spawn("operation-1", {
    agent: "worker",
    task: "work",
    cwd: "/repo",
  });

  assert.equal(events.emitted?.event, BRIDGE_REQUEST_EVENT);
  assert.equal(events.emitted?.payload.method, "spawn");
  events.reply("plan-exec:bridge:v1:reply:", {
    success: true,
    data: { runId: "run-1" },
  });

  assert.deepEqual(await pending, { success: true, data: { runId: "run-1" } });
});

test("Bridge client returns a transport failure when event emission throws", async () => {
  const events = new TestEvents();
  events.throwOnEmit = true;
  const bridge = new BridgeClient(events, 50);

  const reply = await bridge.ping();

  assert.deepEqual(reply, {
    success: false,
    error: { code: "transport", message: "event bus unavailable" },
  });
});
