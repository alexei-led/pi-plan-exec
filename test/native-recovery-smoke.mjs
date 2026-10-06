import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeRuntimeHost } from './fixtures/native-runtime-host.ts';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function reply(result) {
  assert.equal(result.delivered, true, 'RPC reply reached the caller');
  const value = record(result.reply);
  assert.ok(value, 'RPC reply is a structured object');
  assert.equal(value.version, 1);
  assert.equal(value.requestId, result.requestId);
  return value;
}

async function waitForObservedProof(host, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'status unavailable';
  while (Date.now() < deadline) {
    const result = await host.rpc(
      'status',
      { id: runId },
      { timeoutMs: 5_000 },
    );
    const statusReply = record(result.reply);
    const data = record(statusReply?.data);
    const details = record(data?.details);
    const lifecycleStatus = record(details?.lifecycleStatus);
    const proof = record(lifecycleStatus?.processTerminal);
    if (proof?.state === 'observed' && proof.runId === runId) return proof;
    last =
      typeof data?.text === 'string' ? data.text : JSON.stringify(statusReply);
    await delay(50);
  }
  throw new Error(`Timed out waiting for observed proof for ${runId}: ${last}`);
}

async function retireKnownRuns(host, knownRuns, observedRuns) {
  const unresolved = [];
  for (const runId of knownRuns) {
    if (observedRuns.has(runId)) continue;
    let stopError;
    try {
      const stopped = reply(
        await host.rpc('stop', { id: runId }, { timeoutMs: 2_000 }),
      );
      if (!stopped.success)
        stopError = record(stopped.error)?.message ?? 'Stop refused';
    } catch (error) {
      stopError = String(error);
    }
    try {
      await waitForObservedProof(host, runId, 5_000);
      observedRuns.add(runId);
    } catch (error) {
      unresolved.push({ runId, stopError, proofError: String(error) });
    }
  }
  return unresolved;
}

test('failure cleanup leaves unproven runners unresolved after stop delivery', async () => {
  const calls = [];
  const host = {
    async rpc(method, params) {
      calls.push({ method, id: params.id });
      if (method === 'status') throw new Error('Proof unavailable');
      return {
        delivered: true,
        requestId: 'stop',
        reply: { version: 1, requestId: 'stop', success: true },
      };
    },
  };
  const observed = new Set();
  const unresolved = await retireKnownRuns(host, new Set(['runner']), observed);
  assert.deepEqual(calls, [
    { method: 'stop', id: 'runner' },
    { method: 'status', id: 'runner' },
  ]);
  assert.equal(observed.size, 0);
  assert.equal(unresolved[0].runId, 'runner');
  assert.match(unresolved[0].proofError, /Proof unavailable/);
});

test('failure cleanup never signals a runner with observed retirement', async () => {
  const host = {
    rpc() {
      assert.fail('Retired runner must not be signalled');
    },
  };
  assert.deepEqual(
    await retireKnownRuns(host, new Set(['runner']), new Set(['runner'])),
    [],
  );
});

test('released public RPC launches direct worker/reviewer leaves and preserves exact run proof identity', {
  timeout: 90_000,
}, async (t) => {
  const sandbox = await mkdtemp(
    join(tmpdir(), 'pi-plan-exec-native-recovery-'),
  );
  let passed = false;
  let host;
  const knownRuns = new Set();
  const observedRuns = new Set();
  try {
    host = await createNativeRuntimeHost(sandbox);
    t.diagnostic(
      `pi-subagents 0.76.1; fixture sandbox (removed on pass, retained on failure): ${sandbox}`,
    );

    const started = [];
    const unsubscribe = host.events.on('subagent:async-started', (raw) => {
      const value = record(raw);
      if (value) started.push(value);
      if (typeof value?.id === 'string') knownRuns.add(value.id);
    });
    t.after(() => unsubscribe());

    const worker = reply(
      await host.rpc('spawn', {
        agent: 'worker',
        task: 'Complete the deterministic native contract fixture.',
        cwd: host.repository,
        context: 'fresh',
        worktree: false,
        timeoutMs: 15_000,
        toolBudget: { hard: 20 },
        executionLifetime: { mode: 'unbounded' },
      }),
    );
    assert.equal(worker.success, true);
    const workerData = record(worker.data);
    const workerDetails = record(workerData?.details);
    const workerRunId = workerDetails?.runId;
    assert.equal(typeof workerRunId, 'string');
    knownRuns.add(workerRunId);
    assert.equal(workerDetails?.asyncId, workerRunId);
    assert.equal(workerDetails?.context, 'fresh');
    assert.equal(workerDetails?.timeoutMs, 15_000);
    assert.equal(record(workerDetails?.toolBudget)?.hard, 20);
    assert.equal(typeof workerDetails?.launchContractDigest, 'string');

    const workerProof = await waitForObservedProof(host, workerRunId);
    observedRuns.add(workerRunId);
    assert.equal(workerProof.runId, workerRunId);
    assert.equal(typeof workerProof.runnerProcessInstanceId, 'string');
    assert.ok(Array.isArray(workerProof.instances));
    assert.ok(
      workerProof.instances.some(
        (instance) =>
          record(instance)?.kind === 'runner' &&
          record(instance)?.processInstanceId ===
            workerProof.runnerProcessInstanceId,
      ),
    );
    assert.equal(Object.hasOwn(workerProof, 'requestId'), false);

    const workerCalls = await host.calls();
    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0]?.agent, 'worker');
    assert.equal(workerCalls[0]?.cwd, host.repository);
    assert.notEqual(workerCalls[0]?.pid, process.pid);
    assert.equal(workerCalls[0]?.executionLifetime, null);

    const startCountBeforeDrop = started.length;
    const dropped = await host.rpc(
      'spawn',
      {
        agent: 'reviewer',
        task: 'Verify the deterministic worker result and return findings.',
        cwd: host.repository,
        context: 'fresh',
        worktree: false,
        timeoutMs: 15_000,
      },
      { dropReply: true },
    );
    assert.equal(dropped.delivered, false);
    const reviewerStarted = started
      .slice(startCountBeforeDrop)
      .find((event) => event.agent === 'reviewer');
    assert.ok(
      reviewerStarted,
      'native start event followed the dropped RPC reply',
    );
    assert.equal(typeof reviewerStarted.id, 'string');
    assert.equal(Object.hasOwn(reviewerStarted, 'requestId'), false);
    assert.notEqual(reviewerStarted.id, dropped.requestId);

    // A replacement RPC runtime has no in-memory request-to-run binding. It can
    // still observe the exact native run and process proof when given that run id.
    host.replaceRuntime();
    const reviewerProof = await waitForObservedProof(host, reviewerStarted.id);
    observedRuns.add(reviewerStarted.id);
    assert.equal(reviewerProof.runId, reviewerStarted.id);
    assert.equal(typeof reviewerProof.runnerProcessInstanceId, 'string');
    assert.equal(Object.hasOwn(reviewerProof, 'requestId'), false);

    // Asking status with the lost RPC request id returns not-found even though
    // the detached reviewer actually ran. It is not proof that spawn did not start.
    const requestIdStatus = reply(
      await host.rpc('status', { id: dropped.requestId }),
    );
    assert.equal(requestIdStatus.success, false);
    assert.match(record(requestIdStatus.error)?.message ?? '', /not found/i);
    const reviewerCalls = await host.calls();
    assert.equal(reviewerCalls.length, 2);
    assert.deepEqual(
      reviewerCalls.map((call) => call.agent),
      ['worker', 'reviewer'],
    );
    assert.ok(reviewerCalls.every((call) => call.pid !== process.pid));

    passed = true;
  } finally {
    try {
      if (!passed && host) {
        const unresolved = await retireKnownRuns(host, knownRuns, observedRuns);
        if (unresolved.length)
          console.error('Unresolved fixture runners:', unresolved);
      }
    } finally {
      await host?.dispose();
      if (passed) await rm(sandbox, { recursive: true, force: true });
      else console.error(`Retained native recovery sandbox: ${sandbox}`);
    }
  }
});
