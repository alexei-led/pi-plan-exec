import assert from "node:assert/strict";
import test from "node:test";
import { FusionClient, FUSION_REQUEST_EVENT } from "../src/fusion.js";

const FUSION_REPLY_PREFIX = "fusion:rpc:v1:reply:";

test("Fusion client sends operation IDs and parses a structured start response", async () => {
  const bus = new FakeEventBus();
  const client = new FusionClient(bus, 100);
  const started = client.start("operation-1", "Review this diff.", "quality");

  const request = bus.last(FUSION_REQUEST_EVENT);
  assert.ok(isRecord(request));
  assert.equal(request.version, 1);
  assert.equal(request.method, "start");
  assert.equal(typeof request.requestId, "string");
  assert.deepEqual(request.params, {
    operationId: "operation-1",
    prompt: "Review this diff.",
    profile: "quality",
  });
  bus.emit(`${FUSION_REPLY_PREFIX}${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    method: "start",
    success: true,
    data: {
      operationId: "operation-1",
      replayed: false,
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    },
  });

  assert.deepEqual(await started, {
    success: true,
    data: {
      operationId: "operation-1",
      replayed: false,
      run: { runId: "fusion-1", phase: "panel", terminal: false },
    },
  });
});

test("Fusion client rejects ambiguous selectors without emitting a request", async () => {
  const bus = new FakeEventBus();
  const client = new FusionClient(bus, 100);
  const result = await client.status("fusion-1", "operation-1");
  assert.deepEqual(result, {
    success: false,
    error: {
      code: "invalid_request",
      message: "Specify runId or operationId, not both.",
    },
  });
  assert.equal(bus.count(FUSION_REQUEST_EVENT), 0);
});

class FakeEventBus {
  private readonly handlers = new Map<
    string,
    Set<(payload: unknown) => void>
  >();
  private readonly emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  count(event: string): number {
    return this.emitted.filter((entry) => entry.event === event).length;
  }

  last(event: string): unknown {
    const entry = this.emitted.findLast((item) => item.event === event);
    assert.ok(entry, `expected emitted ${event}`);
    return entry.payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
