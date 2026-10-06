import { expect, test } from 'vitest';
import {
  nativeBindingAllowed,
  nativeDigest,
  nativeDispatchAllowed,
  nativeWorkflowIdentity,
} from '../src/operation-safety.js';
import { required } from '../src/required.js';
import type { ActiveOperation, PlanExecRun } from '../src/types.js';

const operation = {
  operationId: 'op',
  requestDigest: 'digest',
  service: 'native',
  kind: 'implementation',
  executionGeneration: 0,
  native: {
    ownerRunId: 'run',
    ownerSessionId: 'session',
    phase: 'prepared',
    request: { requestId: 'uuid' },
  },
} as ActiveOperation;
const run = {
  id: 'run',
  status: 'running',
  executionGeneration: 0,
  activeOperation: operation,
} as PlanExecRun;

test('dispatch authorization differs from late binding after stop', () => {
  expect(nativeDispatchAllowed(run, operation, 'session')).toBe(true);
  const stopped = {
    ...run,
    status: 'cancel_pending',
    stopGeneration: 1,
    activeOperation: { ...operation, stopRequested: true },
  } as PlanExecRun;
  expect(nativeDispatchAllowed(stopped, operation, 'session')).toBe(false);
  expect(nativeBindingAllowed(stopped, operation)).toBe(true);
  expect(
    nativeBindingAllowed({ ...stopped, status: 'abandoned' }, operation),
  ).toBe(false);
  expect(nativeDispatchAllowed(run, operation, 'foreign')).toBe(false);
  expect(
    nativeBindingAllowed(run, { ...operation, requestDigest: 'wrong' }),
  ).toBe(false);
  expect(
    nativeBindingAllowed({ ...run, executionGeneration: 1 }, operation),
  ).toBe(false);
});

test('digest is canonical and exact structured workflow correlation rejects foreign children', () => {
  expect(nativeDigest({ b: 2, a: 1 })).toBe(nativeDigest({ a: 1, b: 2 }));
  const summary = {
    version: 1,
    parentToolCallId: 'rpc-spawn-uuid',
    workflowRunId: 'root',
    inventoryComplete: true,
    workflowState: 'completed',
    children: [{ childId: 'main', runId: 'child', state: 'completed' }],
  };
  expect(
    nativeWorkflowIdentity(summary, required(operation.native), 'root')
      ?.childRunId,
  ).toBe('child');
  expect(
    nativeWorkflowIdentity(
      { ...summary, parentToolCallId: 'foreign' },
      required(operation.native),
    ),
  ).toBeUndefined();
  expect(
    nativeWorkflowIdentity(
      { ...summary, children: [{ childId: 'other', state: 'running' }] },
      required(operation.native),
    ),
  ).toBeUndefined();
  expect(
    nativeWorkflowIdentity(summary, required(operation.native), 'other'),
  ).toBeUndefined();
});
