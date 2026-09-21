import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_REQUEST_EVENT,
  BRIDGE_V2_REQUEST_EVENT,
  bridgeRequestDigest,
  BridgeClient,
  processTerminalProof,
  executionLifetimeCapabilities,
  parseExecutionLifetime,
  hasTerminalOwnershipProof,
  supportsOwnedProcessTree,
  type EventBus,
} from "../src/bridge.js";

const FULL_OWNERSHIP = { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" } as const;

test("workflow proof requires closed dispatch and recursively observed child exit", () => {
  const child = { version: 1, state: "observed", runId: "child", runnerProcessInstanceId: "instance",
    observedAt: 1, instances: [], processTreeOwnership: FULL_OWNERSHIP };
  const workflow = { version: 1, kind: "workflow", state: "observed", runId: "flow",
    dispatchClosed: true, observedAt: 2, children: [child] };
  assert.equal(hasTerminalOwnershipProof({ workflowTerminalProof: workflow }, "flow"), true);
  assert.equal(hasTerminalOwnershipProof({ workflowTerminalProof: { ...workflow, children: [{ ...workflow, runId: "nested" }] } }, "flow"), true);
  for (const invalid of [
    { ...workflow, dispatchClosed: false }, { ...workflow, children: [{ ...child, state: "pending" }] },
    { ...workflow, children: [{ ...child, scope: "process-groups" }] },
    { ...workflow, children: [{ ...child, processTreeOwnership: undefined }] },
    { ...workflow, children: [{ ...child, instances: [{ processTree: { mechanism: "posix-process-group", containment: "unverified" } }] }] },
    { ...workflow, children: [{}] }, { ...workflow, runId: "different" },
  ]) assert.equal(hasTerminalOwnershipProof({ workflowTerminalProof: invalid }, "flow"), false);
});

test("explicit lifetime capabilities never infer unbounded support", () => {
  for (const value of [undefined, true, { version: 1 }, { version: 1, modes: ["unlimited"] }])
    assert.deepEqual(executionLifetimeCapabilities(value), {});
  assert.deepEqual(executionLifetimeCapabilities({ version: 1, modes: ["unbounded", "bounded"] }), {
    executionLifetimeVersion: 1, executionLifetimeModes: ["unbounded", "bounded"],
  });
  assert.deepEqual(parseExecutionLifetime({ mode: "unbounded" }), { mode: "unbounded" });
  assert.equal(parseExecutionLifetime({ mode: "unbounded", timeoutMs: 0 }), undefined);
  assert.equal(parseExecutionLifetime({ mode: "bounded", timeoutMs: 0 }), undefined);
  assert.notEqual(bridgeRequestDigest({ executionLifetime: { mode: "unbounded" } }),
    bridgeRequestDigest({ executionLifetime: { mode: "bounded", timeoutMs: 100 } }));
});

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

test("Bridge refuses explicit lifetime dispatch without a verified capability", async () => {
  const events = new TestEvents();
  const bridge = new BridgeClient(events, 50);
  const result = await bridge.spawn("op", { executionLifetime: { mode: "unbounded" } });
  assert.ok(!result.success);
  assert.equal(result.error.code, "unsupported");
  assert.equal(events.emissions.length, 0);
});

test("Bridge keeps lifetime support distinct and blocks group-only ownership before dispatch", async () => {
  const events = new TestEvents();
  const bridge = new BridgeClient(events, 50);
  const ping = bridge.capabilities();
  events.reply("plan-exec:bridge:v2:reply:", { success: true, data: {
    protocol: "plan-exec-bridge", version: 2, capabilities: {
      workflowScriptSpawn: true, durableOperationLookup: { version: 1 }, processTerminalProof: { version: 1 },
      executionLifetime: { version: 1, modes: ["unbounded", "bounded"] },
      processTreeOwnership: { version: 1, scope: "posix-process-group", escapedDescendants: "unverified" },
    },
  } });
  const capabilities = await ping;
  assert.deepEqual(capabilities.executionLifetimeModes, ["unbounded", "bounded"]);
  assert.equal(supportsOwnedProcessTree(capabilities), false);
  const started = await bridge.spawn("op", { executionLifetime: { mode: "unbounded" } });
  assert.ok(!started.success);
  assert.equal(started.error.code, "unsupported");
  assert.equal(events.emissions.length, 1);
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

test("Bridge v2 negotiation accepts a delayed local capability reply", async () => {
  const events = new TestEvents();
  const bridge = new BridgeClient(events, 30_000, 250);
  const pending = bridge.capabilities();
  setTimeout(() => {
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
  }, 125);

  const capabilities = await pending;
  assert.equal(capabilities.healthy, true);
  assert.equal(capabilities.protocolVersion, 2);
});

test("Bridge preflight upgrades and recovers without downgrading tracked v2 operations", async () => {
  const events = new class extends TestEvents {
    mode: "v1" | "group" | "full" | "outage" = "v1";

    override emit(event: string, payload: unknown): void {
      super.emit(event, payload);
      const request = this.emitted?.payload;
      if (!request) return;
      const prefix = event === BRIDGE_V2_REQUEST_EVENT ? "plan-exec:bridge:v2:reply:" : "plan-exec:bridge:v1:reply:";
      if (request.method !== "ping") {
        this.reply(prefix, { success: true, data: { state: "pending" } });
        return;
      }
      if (this.mode === "outage" || (event === BRIDGE_V2_REQUEST_EVENT && this.mode === "v1")) return;
      if (event === BRIDGE_REQUEST_EVENT) {
        this.reply(prefix, { success: true, data: {} });
        return;
      }
      this.reply(prefix, { success: true, data: {
        protocol: "plan-exec-bridge", version: 2, capabilities: {
          workflowScriptSpawn: true, durableOperationLookup: { version: 1 }, processTerminalProof: { version: 1 },
          executionLifetime: { version: 1, modes: ["unbounded"] },
          processTreeOwnership: this.mode === "full" ? FULL_OWNERSHIP : {
            version: 1, scope: "posix-process-group", escapedDescendants: "unverified",
          },
        },
      } });
    }
  }();
  const bridge = new BridgeClient(events, 50, 10);
  assert.equal((await bridge.capabilities()).protocolVersion, 1);
  events.mode = "group";
  const limited = await bridge.capabilities();
  assert.equal(limited.protocolVersion, 2);
  assert.equal(supportsOwnedProcessTree(limited), false);
  events.mode = "full";
  assert.equal(supportsOwnedProcessTree(await bridge.capabilities()), true);
  events.mode = "outage";
  const outage = await bridge.capabilities();
  assert.equal(outage.healthy, false);
  assert.equal(outage.protocolVersion, 2);
  assert.equal(events.emissions.at(-1)?.event, BRIDGE_V2_REQUEST_EVENT);
  assert.equal((await bridge.spawn("new", { executionLifetime: { mode: "unbounded" } })).success, false);
  await bridge.operation("existing");
  assert.equal(events.emissions.at(-1)?.event, BRIDGE_V2_REQUEST_EVENT);
  events.mode = "full";
  const recovered = await bridge.capabilities();
  assert.equal(recovered.healthy, true);
  assert.equal(supportsOwnedProcessTree(recovered), true);
  assert.equal((await bridge.spawn("new", { executionLifetime: { mode: "unbounded" } })).success, true);
});

test("Bridge negotiation stays bounded when no bridge is installed", async () => {
  const events = new TestEvents();
  const bridge = new BridgeClient(events, 100, 20);
  const startedAt = Date.now();

  const reply = await bridge.ping();

  assert.equal(reply.success, false);
  assert.equal(reply.error.code, "timeout");
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(
    events.emissions.map((entry) => entry.event),
    [BRIDGE_V2_REQUEST_EVENT, BRIDGE_REQUEST_EVENT],
  );
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
        processTreeOwnership: FULL_OWNERSHIP,
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
      processTreeOwnership: FULL_OWNERSHIP,
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
