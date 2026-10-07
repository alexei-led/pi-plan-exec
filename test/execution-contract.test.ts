import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  executionLifetimeCapabilities,
  executionRequestDigest,
  hasTerminalOwnershipProof,
  parseExecutionLifetime,
  processTerminalProof,
} from '../src/execution-contract.js';
import {
  hasBoundNeverStarted,
  hasBoundOperation,
} from '../src/legacy-operation.js';

const CALLER_BINDING = {
  operationId: 'caller-op',
  requestDigest: 'caller-digest',
};

/** The released runtime publishes a writer-exit observation with its instances. */
function observedProof(runId: string) {
  return {
    version: 1,
    state: 'observed',
    runId,
    runnerProcessInstanceId: 'released-instance',
    observedAt: 1_789_992_000_000,
    callerBinding: CALLER_BINDING,
    instances: [],
  };
}

test('pre-launch rejection receipts bind owner, operation, digest and correlated RPC', () => {
  const proof = {
    version: 1,
    source: 'subagents-rpc',
    requestId: 'rpc-1',
    method: 'spawn',
    code: 'invalid_params',
    message: 'Rejected before execution',
    ...CALLER_BINDING,
    ownerRunId: 'plan-1',
  };
  const data = {
    ...CALLER_BINDING,
    state: 'not_started',
    neverStarted: true,
    replaySafe: false,
    launchRejection: proof,
  };
  assert.equal(hasBoundNeverStarted(data, CALLER_BINDING, 'plan-1'), true);
  for (const patch of [
    { version: 2 },
    { source: 'log' },
    { requestId: '' },
    { method: 'status' },
    { code: 'execution_failed' },
    { message: '' },
    { operationId: 'other' },
    { requestDigest: 'other' },
    { ownerRunId: 'other' },
  ])
    assert.equal(
      hasBoundNeverStarted(
        { ...data, launchRejection: { ...proof, ...patch } },
        CALLER_BINDING,
        'plan-1',
      ),
      false,
    );
  for (const patch of [
    { launchRejection: undefined },
    { launchRejection: null },
    { replaySafe: true },
    { runId: 'running-child' },
    { neverStarted: false },
    { operationId: 'other' },
    { requestDigest: 'other' },
  ])
    assert.equal(
      hasBoundNeverStarted({ ...data, ...patch }, CALLER_BINDING, 'plan-1'),
      false,
    );
});

test('live-child binding permits only exact identity and frozen lifetime reattachment', () => {
  const operation = {
    operationId: 'operation',
    requestDigest: 'digest',
    expectedLifetime: { mode: 'unbounded' as const },
  };
  const data = {
    state: 'found',
    operationId: 'operation',
    requestDigest: 'digest',
    runId: 'child',
    effectiveExecutionLifetime: { mode: 'unbounded' },
  };
  assert.equal(hasBoundOperation(data, operation), true);
  assert.equal(
    hasBoundOperation(data, { ...operation, externalRunId: 'child' }),
    true,
  );
  for (const patch of [
    { state: 'unknown' },
    { operationId: 'other' },
    { operationId: undefined },
    { requestDigest: 'other' },
    { requestDigest: undefined },
    { runId: '' },
    { runId: undefined },
    { neverStarted: true },
    { launchRetirement: { version: 1 } },
    { effectiveExecutionLifetime: undefined },
    { effectiveExecutionLifetime: { mode: 'bounded', timeoutMs: 10 } },
  ])
    assert.equal(hasBoundOperation({ ...data, ...patch }, operation), false);
  assert.equal(
    hasBoundOperation(data, { ...operation, externalRunId: 'other' }),
    false,
  );
  assert.equal(
    hasBoundOperation(data, {
      operationId: 'operation',
      requestDigest: 'digest',
    }),
    false,
  );
  assert.equal(
    hasBoundOperation(
      {
        ...data,
        effectiveExecutionLifetime: { mode: 'bounded', timeoutMs: 11 },
      },
      { ...operation, expectedLifetime: { mode: 'bounded', timeoutMs: 10 } },
    ),
    false,
  );
});

test('retirement claims cannot masquerade as never-started evidence', () => {
  const binding = {
    operationId: 'legacy-operation',
    requestDigest: 'legacy-digest',
  };
  for (const receipt of [
    { ...binding, state: 'retired', neverStarted: true },
    {
      ...binding,
      state: 'cancelled',
      neverStarted: true,
      launchRetirement: { version: 1, kind: 'host-reboot' },
    },
    {
      ...binding,
      state: 'found',
      neverStarted: true,
      launchRetirement: { bootChanged: true, operatorConfirmed: true },
    },
  ]) {
    assert.equal(hasBoundNeverStarted(receipt, binding, 'legacy-plan'), false);
  }
});

test('observed process proofs bind the exact run and caller', () => {
  const proof = observedProof('native-run');
  assert.ok(processTerminalProof(proof, 'native-run', CALLER_BINDING));
  assert.ok(processTerminalProof(proof, 'native-run'));
  assert.equal(
    processTerminalProof(proof, 'other-run', CALLER_BINDING),
    undefined,
  );
  for (const invalid of [
    { ...proof, observedAt: undefined },
    { ...proof, runnerProcessInstanceId: '' },
    { ...proof, instances: undefined },
    { ...proof, callerBinding: { ...CALLER_BINDING, requestDigest: 'other' } },
    { ...proof, state: 'unknown' },
  ])
    assert.equal(
      processTerminalProof(invalid, 'native-run', CALLER_BINDING),
      undefined,
    );
});

test('workflow proof requires closed dispatch and terminal child evidence', () => {
  const child = observedProof('child');
  const workflow = {
    version: 1,
    kind: 'workflow',
    state: 'observed',
    runId: 'flow',
    dispatchClosed: true,
    observedAt: 2,
    children: [child],
    callerBinding: CALLER_BINDING,
  };
  assert.equal(
    hasTerminalOwnershipProof(
      { workflowTerminalProof: workflow },
      'flow',
      CALLER_BINDING,
    ),
    true,
  );
  assert.equal(
    hasTerminalOwnershipProof({ workflowTerminalProof: workflow }, 'flow'),
    true,
  );
  const failedToStart = {
    version: 1,
    state: 'not-started',
    runId: 'child',
    runnerProcessInstanceId: 'released-instance',
  };
  assert.equal(
    hasTerminalOwnershipProof(
      { workflowTerminalProof: { ...workflow, children: [failedToStart] } },
      'flow',
      CALLER_BINDING,
    ),
    true,
  );
  assert.equal(
    hasTerminalOwnershipProof(
      { processTerminalProof: failedToStart },
      'child',
      CALLER_BINDING,
    ),
    false,
  );
  assert.equal(
    hasTerminalOwnershipProof(
      {
        workflowTerminalProof: {
          ...workflow,
          children: [{ ...workflow, runId: 'nested' }],
        },
      },
      'flow',
      CALLER_BINDING,
    ),
    true,
  );
  for (const invalid of [
    { ...workflow, dispatchClosed: false },
    { ...workflow, children: [{ ...child, state: 'pending' }] },
    {
      ...workflow,
      children: [{ ...failedToStart, state: 'unknown', reason: 'unknown' }],
    },
    { ...workflow, children: [{ ...child, instances: undefined }] },
    {
      ...workflow,
      children: [{ ...failedToStart, runnerProcessInstanceId: '' }],
    },
    { ...workflow, children: [{}] },
    { ...workflow, runId: 'different' },
  ])
    assert.equal(
      hasTerminalOwnershipProof(
        { workflowTerminalProof: invalid },
        'flow',
        CALLER_BINDING,
      ),
      false,
    );
});

test('explicit lifetime capabilities never infer unbounded support', () => {
  for (const value of [
    undefined,
    true,
    { version: 1 },
    { version: 1, modes: ['unlimited'] },
  ])
    assert.deepEqual(executionLifetimeCapabilities(value), {});
  assert.deepEqual(
    executionLifetimeCapabilities({
      version: 1,
      modes: ['unbounded', 'bounded'],
    }),
    {
      executionLifetimeVersion: 1,
      executionLifetimeModes: ['unbounded', 'bounded'],
    },
  );
  assert.deepEqual(parseExecutionLifetime({ mode: 'unbounded' }), {
    mode: 'unbounded',
  });
  assert.equal(
    parseExecutionLifetime({ mode: 'unbounded', timeoutMs: 0 }),
    undefined,
  );
  assert.equal(
    parseExecutionLifetime({ mode: 'bounded', timeoutMs: 0 }),
    undefined,
  );
  assert.notEqual(
    executionRequestDigest({ executionLifetime: { mode: 'unbounded' } }),
    executionRequestDigest({
      executionLifetime: { mode: 'bounded', timeoutMs: 100 },
    }),
  );
});

test('process terminal proof accepts only complete observed upstream receipts', () => {
  const proof = observedProof('native-run-1');
  assert.deepEqual(
    processTerminalProof(proof, 'native-run-1', CALLER_BINDING),
    proof,
  );
  assert.equal(
    processTerminalProof(
      { ...proof, runId: 'other-run' },
      'native-run-1',
      CALLER_BINDING,
    ),
    undefined,
  );
});
