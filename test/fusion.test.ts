import assert from "node:assert/strict";
import test from "node:test";
import {
  FusionClient,
  FUSION_REQUEST_EVENT,
  parseFusionCallerOutput,
  PLAN_REVIEW_OUTPUT_CONTRACT,
} from "../src/fusion.js";

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
    outputContract: PLAN_REVIEW_OUTPUT_CONTRACT,
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

test("every Fusion start, including replay, requests the plan review contract", async () => {
  const bus = new FakeEventBus();
  const client = new FusionClient(bus, 100);

  for (const operationId of ["operation-1", "operation-1"]) {
    const started = client.start(operationId, "Review this diff.");
    const request = bus.last(FUSION_REQUEST_EVENT);
    assert.ok(isRecord(request));
    assert.deepEqual(request.params, {
      operationId,
      prompt: "Review this diff.",
      outputContract: PLAN_REVIEW_OUTPUT_CONTRACT,
    });
    bus.emit(`${FUSION_REPLY_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: "start",
      success: true,
      data: {
        operationId,
        run: { runId: "fusion-1", phase: "panel", terminal: false },
      },
    });
    await started;
  }
  assert.equal(bus.count(FUSION_REQUEST_EVENT), 2);
});

test("parses only validated plan review caller output", () => {
  assert.deepEqual(
    parseFusionCallerOutput({
      contract: PLAN_REVIEW_OUTPUT_CONTRACT,
      output: "NO_FINDINGS",
    }),
    { contract: PLAN_REVIEW_OUTPUT_CONTRACT, output: "NO_FINDINGS" },
  );
  for (const value of [
    undefined,
    null,
    "NO_FINDINGS",
    { contract: PLAN_REVIEW_OUTPUT_CONTRACT, output: "   " },
    { contract: PLAN_REVIEW_OUTPUT_CONTRACT },
    { contract: "other-contract", output: "NO_FINDINGS" },
    { contract: PLAN_REVIEW_OUTPUT_CONTRACT, output: 42 },
  ]) {
    assert.equal(parseFusionCallerOutput(value), undefined);
  }
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

test("Fusion start and replay preserve explicit no-deadline policy", async () => {
  const bus = new FakeEventBus();
  const client = new FusionClient(bus, 100);
  const preflight = client.capabilities();
  const ping = bus.last(FUSION_REQUEST_EVENT);
  assert.ok(isRecord(ping));
  bus.emit(`${FUSION_REPLY_PREFIX}${ping.requestId}`, { success: true, data: { capabilities: {
    executionLifetime: { version: 1, modes: ["unbounded"] },
    processTreeOwnership: { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" },
  } } });
  await preflight;
  for (const operationId of ["operation-1", "operation-1"]) {
    const pending = client.start(operationId, "Review", undefined, { mode: "unbounded" }, "caller-digest",
      { cwd: "/repo/worktree", reviewedCommit: "a".repeat(40) });
    const request = bus.last(FUSION_REQUEST_EVENT);
    assert.ok(isRecord(request) && isRecord(request.params));
    assert.deepEqual(request.params.executionLifetime, { mode: "unbounded" });
    assert.equal(request.params.digest, "caller-digest");
    assert.equal(request.params.cwd, "/repo/worktree");
    assert.equal(request.params.reviewedCommit, "a".repeat(40));
    bus.emit(`${FUSION_REPLY_PREFIX}${request.requestId}`, { success: true, data: { runId: "fusion-1" } });
    assert.equal((await pending).success, true);
  }
  const count = bus.count(FUSION_REQUEST_EVENT);
  for (const context of [undefined, { cwd: "relative", reviewedCommit: "abc" }, { cwd: "/repo", reviewedCommit: "" }]) {
    const result = await client.start("invalid", "Review", undefined, { mode: "unbounded" }, "caller-digest", context);
    assert.ok(!result.success);
    assert.equal(result.error.code, "invalid_request");
  }
  assert.equal(bus.count(FUSION_REQUEST_EVENT), count);
});

test("Fusion refuses group-only runtime before starting a strict review", async () => {
  const bus = new FakeEventBus();
  const client = new FusionClient(bus, 100);
  const pending = client.capabilities();
  const request = bus.last(FUSION_REQUEST_EVENT);
  assert.ok(isRecord(request));
  bus.emit(`${FUSION_REPLY_PREFIX}${request.requestId}`, { success: true, data: { capabilities: {
    executionLifetime: { version: 1, modes: ["unbounded"] },
    processTreeOwnership: { version: 1, scope: "posix-process-group", escapedDescendants: "unverified" },
  } } });
  assert.deepEqual((await pending).executionLifetimeModes, ["unbounded"]);
  const result = await client.start("op", "Review", undefined, { mode: "unbounded" });
  assert.ok(!result.success);
  assert.equal(result.error.code, "unsupported");
  assert.equal(bus.count(FUSION_REQUEST_EVENT), 1);
});

test("Fusion preflight recognizes only explicit advertised capabilities", async () => {
  const bus = new FakeEventBus();
  const client = new FusionClient(bus, 100);
  const pending = client.capabilities();
  const request = bus.last(FUSION_REQUEST_EVENT);
  assert.ok(isRecord(request));
  bus.emit(`${FUSION_REPLY_PREFIX}${request.requestId}`, { success: true, data: { capabilities: {
    executionLifetime: { version: 1, modes: ["unbounded"] },
    processTerminalProof: { version: 1 }, durableOperationLookup: { version: 1 },
  } } });
  assert.deepEqual(await pending, { healthy: true, durableOperationLookup: true,
    executionLifetimeVersion: 1, executionLifetimeModes: ["unbounded"], processTerminalProofVersion: 1 });
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
