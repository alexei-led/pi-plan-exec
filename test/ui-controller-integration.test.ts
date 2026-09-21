import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import planExecExtension from "../src/index.js";
import { PlanExecController } from "../src/controller.js";
import { RunRegistry } from "../src/registry.js";
import { TaskProjector } from "../src/task-projection.js";
import {
  DEFAULT_FROZEN_RUN_CONFIG,
  RUN_STAGE,
  RUN_STATUS,
  type PlanExecRun,
} from "../src/types.js";

test("background recovery keeps ticking through UI failure and a pending projection", async (t) => {
  const cwd = "/tmp/pi-plan-exec-ui-controller-integration";
  const sessionId = "session-ui-controller-integration";
  const run: PlanExecRun = {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    repositoryRoot: cwd,
    planPath: `${cwd}/plan.md`,
    planHash: "plan-hash",
    worktreeCwd: cwd,
    branch: "feature",
    defaultBranch: "main",
    status: RUN_STATUS.RUNNING,
    stage: RUN_STAGE.IMPLEMENTATION,
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    taskProjection: {
      sessionId,
      taskIds: {},
    },
    config: DEFAULT_FROZEN_RUN_CONFIG,
    createdAt: 1,
    updatedAt: 1,
  };
  let tickCount = 0;
  let projectionStarted = false;
  let firstProjectionReleased = false;
  const projectedUpdates: number[] = [];
  let releaseProjection!: () => void;
  const projectionPending = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  const originalListWithErrors = RunRegistry.prototype.listWithErrors;
  const originalTick = PlanExecController.prototype.tick;
  const originalSync = TaskProjector.prototype.sync;
  t.after(() => {
    RunRegistry.prototype.listWithErrors = originalListWithErrors;
    PlanExecController.prototype.tick = originalTick;
    TaskProjector.prototype.sync = originalSync;
    releaseProjection();
  });

  RunRegistry.prototype.listWithErrors = async () => ({
    runs: [run],
    errors: [],
  });
  PlanExecController.prototype.tick = async () => {
    tickCount += 1;
    if (tickCount === 1)
      return { ...run, stage: RUN_STAGE.COMPREHENSIVE_REVIEW, updatedAt: 2 };
    if (tickCount === 2)
      return { ...run, stage: RUN_STAGE.COMPREHENSIVE_REVIEW, updatedAt: 3 };
    return { ...run, status: RUN_STATUS.COMPLETED, stage: RUN_STAGE.COMPLETE, updatedAt: 4 };
  };
  TaskProjector.prototype.sync = async (projectedRun) => {
    projectionStarted = true;
    projectedUpdates.push(projectedRun.updatedAt);
    if (projectedUpdates.length === 1) {
      await projectionPending;
      firstProjectionReleased = true;
    }
    return projectedRun;
  };

  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  let statusCalls = 0;
  let statusFailures = 0;
  let widgetCalls = 0;
  let widgetFailures = 0;
  let notifyCalls = 0;
  const pi = {
    events: { on() {}, emit() {} },
    on(event: string, handler: unknown) {
      events.set(event, handler as (event: unknown, ctx: ExtensionContext) => Promise<void>);
    },
    registerCommand() {},
    registerTool() {},
    getAllTools() { return []; },
    getActiveTools() { return []; },
    setActiveTools() {},
    async exec() { return { stdout: `${cwd}\n`, stderr: "", code: 0 }; },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  planExecExtension(pi);
  const context = {
    cwd,
    mode: "rpc",
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus() {
        statusCalls += 1;
        if (statusCalls === 1) {
          statusFailures += 1;
          throw new Error("UI closed");
        }
      },
      setWidget() {
        widgetCalls += 1;
        if (widgetCalls === 2) {
          widgetFailures += 1;
          throw new Error("UI closed");
        }
      },
      notify(message: string) {
        void message;
        notifyCalls += 1;
        throw new Error("UI closed");
      },
    },
  } as unknown as ExtensionContext;

  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const sessionStart = events.get("session_start");
  assert.ok(sessionStart);
  const startup = sessionStart({}, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(projectionStarted, true);
  assert.equal(tickCount, 0);
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tickCount, 1);
  assert.equal(projectionStarted, true);
  assert.equal(notifyCalls, 1);
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tickCount, 2);
  assert.equal(projectionStarted, true);
  assert.equal(statusCalls >= 2, true);
  t.mock.timers.tick(1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(tickCount, 3);
  assert.equal(statusFailures, 1);
  assert.equal(widgetFailures, 1);
  assert.equal(widgetCalls >= 3, true);
  assert.equal(notifyCalls >= 2, true);
  assert.equal(firstProjectionReleased, false);
  await events.get("session_shutdown")?.({}, context);
  releaseProjection();
  await startup;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(projectedUpdates, [1, 4]);
});
