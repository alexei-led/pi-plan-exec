import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_REQUEST_EVENT,
  BRIDGE_V2_REQUEST_EVENT,
  bridgeRequestDigest,
  BridgeClient,
  processTerminalProof,
  type EventBus,
} from "../src/bridge.js";

class TestEvents implements EventBus {
  private readonly handlers = new Map<string, (payload: unknown) => void>();
  emitted?: { event: string; payload: Record<string, unknown> };
  readonly emissions: Array<{
    event: string;
    payload: Record<string, unknown>;
  }> = [];
  throwOnEmit = false;

  on(event: string, handler: (payload: unknown) => void): () => void {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }

  emit(event: string, payload: unknown): void {
    if (this.throwOnEmit) throw new Error("event bus unavailable");
    this.emitted = { event, payload: payload as Record<string, unknown> };
    this.emissions.push(this.emitted);
  }

  reply(prefix: string, payload: unknown): void {
    this.replyAt(this.emissions.length - 1, prefix, payload);
  }

  replyAt(index: number, prefix: string, payload: unknown): void {
    const requestId = String(this.emissions[index]?.payload.requestId);
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

test("Bridge client negotiates v2 and sends durable operation identity", async () => {
  const events = new TestEvents();
  const bridge = new BridgeClient(events, 50);
  const ping = bridge.ping();

  assert.equal(events.emissions[0]?.event, BRIDGE_V2_REQUEST_EVENT);
  events.replyAt(0, "plan-exec:bridge:v2:reply:", {
    success: true,
    data: {
      protocol: "plan-exec-bridge",
      version: 2,
      capabilities: {
        workflowScriptSpawn: true,
        durableOperationLookup: { version: 1 },
        processTerminalProof: { version: 1 },
      },
    },
  });
  await ping;

  const params = {
    agent: "worker",
    task: "work",
    cwd: "/repo",
    mission: false,
  };
  const requestDigest = bridgeRequestDigest(params);
  const pending = bridge.spawn("operation-1", params, {
    kind: "pi-plan-exec",
    runId: "plan-run-1",
    key: "operation-1",
    requestDigest,
  });
  const emitted = events.emissions.at(-1);
  assert.equal(emitted?.event, BRIDGE_V2_REQUEST_EVENT);
  assert.deepEqual(emitted?.payload.owner, {
    kind: "pi-plan-exec",
    runId: "plan-run-1",
    key: "operation-1",
    requestDigest,
  });
  events.reply("plan-exec:bridge:v2:reply:", {
    success: true,
    data: { runId: "run-1", requestDigest },
  });
  assert.equal((await pending).success, true);
});

test("process terminal proof validates exact native identity", () => {
  assert.deepEqual(
    processTerminalProof(
      {
        version: 1,
        state: "observed",
        runId: "native-run-1",
        runnerProcessInstanceId: "instance-1",
        observedAt: 42,
        instances: [],
      },
      "native-run-1",
    ),
    {
      version: 1,
      state: "observed",
      runId: "native-run-1",
      runnerProcessInstanceId: "instance-1",
      observedAt: 42,
      instances: [],
    },
  );
  assert.equal(
    processTerminalProof(
      {
        version: 1,
        state: "observed",
        runId: "other-run",
        runnerProcessInstanceId: "instance-1",
        observedAt: 42,
        instances: [],
      },
      "native-run-1",
    ),
    undefined,
  );
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
