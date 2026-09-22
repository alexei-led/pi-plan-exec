import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  diagnoseOperation,
  parseOperationActivity,
} from '../src/diagnostics.js';

test('a silent long-running tool remains an observation without a cancellation decision', () => {
  const activity = {
    phase: 'tool',
    state: 'active_long_running',
    currentTool: 'bash',
    toolCallId: 'call-1',
    currentToolStartedAt: 100,
    lastActivityAt: 100,
    lastToolActivityAt: 100,
  };
  const observation = diagnoseOperation(
    activity,
    { runnerPid: 42, cpu: 0, io: 0 },
    {
      now: 259_200_100,
      nextProbeAt: 259_230_100,
      treeExited: false,
    },
  );
  assert.equal(observation.assessment, 'observing');
  assert.equal(observation.action, 'probe');
  assert.equal(observation.currentTool, 'bash');
  assert.equal(observation.toolCallId, 'call-1');
  assert.equal(observation.currentToolStartedAt, 100);
  assert.equal(observation.runnerPid, 42);
  assert.equal(observation.failureKey, undefined);
});

test('an explicit tool failure has one stable repair identity across polls and reload', () => {
  const activity = {
    phase: 'model',
    lastToolFailure: {
      kind: 'tool-execution-error',
      toolCallId: 'call-1',
      toolName: 'bash',
      observedAt: 200,
      message: 'Process exited with status 127: compiler not found',
    },
  };
  const first = diagnoseOperation(
    activity,
    {},
    { now: 300, nextProbeAt: 400, treeExited: false },
  );
  const reloaded = JSON.parse(JSON.stringify(first)) as typeof first;
  const second = diagnoseOperation(
    activity,
    {},
    { now: 500, nextProbeAt: 600, treeExited: false, prior: reloaded },
  );
  assert.equal(first.assessment, 'tool_fault_reported');
  assert.equal(first.action, 'repair_tool');
  assert.match(first.failureKey ?? '', /^[a-f0-9]{64}$/);
  assert.equal(first.failureKey, second.failureKey);
  assert.deepEqual(second.lastToolFailure, first.lastToolFailure);
});

test('transport failure preserves last phase as stale evidence and only schedules another probe', () => {
  const prior = diagnoseOperation(
    {
      phase: 'tool',
      currentTool: 'read',
      lastToolFailure: {
        kind: 'tool-execution-error',
        toolCallId: 'call-2',
        toolName: 'read',
        observedAt: 200,
        message: 'ENOENT',
      },
    },
    { runnerPid: 42 },
    { now: 300, nextProbeAt: 400, treeExited: false },
  );
  const observation = diagnoseOperation(undefined, undefined, {
    now: 500,
    nextProbeAt: 900,
    treeExited: false,
    prior,
    statusUnavailable: true,
    error: 'status RPC timed out',
  });
  assert.equal(observation.assessment, 'status_unavailable');
  assert.equal(observation.action, 'probe');
  assert.equal(observation.phase, 'tool');
  assert.equal(observation.runnerPid, 42);
  assert.equal(observation.nextProbeAt, 900);
  assert.equal(observation.error, 'status RPC timed out');
});

test('malformed telemetry does not turn a healthy status into a failed worker', () => {
  const observation = diagnoseOperation(
    {
      state: 'needs_attention',
      currentTool: [],
      lastActivityAt: Infinity,
      currentToolStartedAt: -1,
      lastToolFailure: { kind: 'tool-execution-error', toolCallId: 'x' },
    },
    { runnerPid: Number.MAX_SAFE_INTEGER },
    { now: 300, nextProbeAt: 400, treeExited: false },
  );
  assert.equal(observation.assessment, 'observing');
  assert.equal(observation.action, 'probe');
  assert.equal(observation.lastActivityAt, undefined);
  assert.equal(observation.currentToolStartedAt, undefined);
  assert.equal(observation.runnerPid, undefined);
  assert.equal(observation.lastToolFailure, undefined);
});

test('reported wrapper completion never substitutes for validated owned-tree exit', () => {
  const status = {
    state: 'complete',
    processTerminalProof: { state: 'observed' },
  };
  const unverified = diagnoseOperation(undefined, status, {
    now: 300,
    nextProbeAt: 400,
    treeExited: false,
  });
  assert.equal(unverified.assessment, 'observing');
  assert.equal(unverified.action, 'probe');
  const verified = diagnoseOperation(
    {
      lastToolFailure: {
        kind: 'tool-execution-error',
        toolCallId: 'x',
        toolName: 'bash',
        observedAt: 200,
        message: 'tool failed',
      },
    },
    status,
    { now: 300, nextProbeAt: 400, treeExited: true },
  );
  assert.equal(verified.assessment, 'exit_confirmed');
  assert.equal(verified.action, 'reconcile');
});

test('a new reported phase does not retain an obsolete current tool', () => {
  const prior = diagnoseOperation(
    { phase: 'tool', currentTool: 'bash', toolCallId: 'old' },
    {},
    { now: 300, nextProbeAt: 400, treeExited: false },
  );
  const current = diagnoseOperation(
    { phase: 'model', lastModelActivityAt: 500 },
    {},
    { now: 500, nextProbeAt: 600, treeExited: false, prior },
  );
  assert.equal(current.currentTool, undefined);
  assert.equal(current.toolCallId, undefined);
  assert.equal(current.lastModelActivityAt, 500);
  assert.deepEqual(parseOperationActivity(undefined), {});
});
