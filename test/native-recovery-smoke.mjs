import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const nativeHostFixtureUrl = new URL(
  './fixtures/native-runtime-host.ts',
  import.meta.url,
).href;
const freshHostPhaseScript = [
  "import assert from 'node:assert/strict';",
  "import { execFileSync } from 'node:child_process';",
  "import { readFile, writeFile } from 'node:fs/promises';",
  "import { join } from 'node:path';",
  `import { createNativeRuntimeHost } from ${JSON.stringify(nativeHostFixtureUrl)};`,
  'const [phase, sandbox, sessionId, shape] = process.argv.slice(2);',
  "const originPath = join(sandbox, 'u2-origin.json');",
  "const reportPath = join(sandbox, 'u2-recovery.json');",
  'function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }',
  'function identityFields(value, path, found = []) {',
  '  if (Array.isArray(value)) { value.forEach((entry, index) => identityFields(entry, path + "[" + index + "]", found)); return found; }',
  '  const object = isRecord(value) ? value : undefined;',
  '  if (!object) return found;',
  '  for (const [key, entry] of Object.entries(object)) {',
  '    if (key === "text") continue;',
  '    if (["id", "runId", "workflowRunId", "parentToolCallId", "requestId", "toolCallId", "sessionId"].includes(key) && typeof entry === "string") found.push({ path: path + "." + key, key, value: entry });',
  '    identityFields(entry, path + "." + key, found);',
  '  }',
  '  return found;',
  '}',
  'function summarize(result) {',
  '  const envelope = isRecord(result.reply) ? result.reply : {};',
  '  const data = isRecord(envelope.data) ? envelope.data : undefined;',
  '  const details = isRecord(data && data.details) ? data.details : undefined;',
  '  const lifecycle = isRecord(details && details.lifecycleStatus) ? details.lifecycleStatus : undefined;',
  '  const proof = isRecord(details && details.workflowTerminalProof) ? details.workflowTerminalProof : isRecord(lifecycle && lifecycle.processTerminal) ? lifecycle.processTerminal : undefined;',
  '  const error = isRecord(envelope.error) ? envelope.error : undefined;',
  '  return { delivered: result.delivered, success: envelope.success === true, error: error ? { code: error.code, message: error.message } : undefined, processTerminal: proof ? { state: proof.state, runId: proof.runId, runnerProcessInstanceId: proof.runnerProcessInstanceId, children: proof.children } : undefined, structuredIdentityFields: identityFields(data, "data") };',
  '}',
  'async function waitForProof(host, runId, timeoutMs) {',
  '  const deadline = Date.now() + timeoutMs;',
  '  while (Date.now() < deadline) {',
  '    const result = await host.rpc("status", { id: runId }, { timeoutMs: 5000 });',
  '    const summary = summarize(result);',
  '    if (summary.processTerminal && summary.processTerminal.state === "observed" && summary.processTerminal.runId === runId) return summary.processTerminal;',
  '    await new Promise(resolve => setTimeout(resolve, 50));',
  '  }',
  '  throw new Error("Timed out waiting for observed native process proof for " + runId);',
  '}',
  'let host;',
  'let startedRunId;',
  'let proofObserved = false;',
  'try {',
  '  const origin = phase === "reattach" ? JSON.parse(await readFile(originPath, "utf8")) : undefined;',
  '  assert.equal(phase === "reattach" ? origin.sessionId : sessionId, sessionId);',
  '  host = await createNativeRuntimeHost(sandbox, { sessionId, reattach: phase === "reattach" });',
  '  if (phase === "origin") {',
  '    const starts = [];',
  '    host.events.on("subagent:async-started", event => { if (isRecord(event)) starts.push(event); });',
  '    const params = { agent: "worker", task: "Complete the deterministic native U2 fixture.", cwd: host.repository, context: "fresh", worktree: false, mission: false, acceptance: false, timeoutMs: 15000 }; const launched = await host.rpc("spawn", shape === "workflow" ? { script: "return await runs.run(" + JSON.stringify("main") + ", " + JSON.stringify(params) + ");", cwd: host.repository, worktree: false, mission: false, acceptance: false, timeoutMs: 15000 } : params, { dropReply: true, timeoutMs: 15000 });',
  '    assert.equal(launched.delivered, false, "spawn reply is dropped from the caller");',
  '    const started = starts.find(event => shape === "workflow" ? event.mode === "workflow" : event.agent === "worker");',
  '    assert.ok(started && typeof started.id === "string", "native run identity was observed independently by the fixture");',
  '    assert.equal(started.sessionId, sessionId);',
  '    assert.equal(Object.hasOwn(started, "requestId"), false);',
  '    startedRunId = started.id;',
  '    const base = { sessionId, requestId: launched.requestId, nativeRunId: startedRunId, hostPid: process.pid, runnerPid: started.pid };',
  '    await writeFile(originPath, JSON.stringify(base));',
  '    const proof = await waitForProof(host, startedRunId, 40000);',
  '    proofObserved = true;',
  '    const calls = await host.calls();',
  '    assert.equal(calls.length, 1);',
  '    assert.equal(calls[0].agent, "worker");',
  '    assert.notEqual(calls[0].pid, process.pid);',
  '    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: host.repository, encoding: "utf8" }).trim();',
  '    await writeFile(originPath, JSON.stringify({ ...base, proof: { state: proof.state, runId: proof.runId, runnerProcessInstanceId: proof.runnerProcessInstanceId }, childPid: calls[0].pid, sideEffects: calls.length, head }));',
  '  } else {',
  '    assert.equal(phase, "reattach");',
  '    assert.equal(host.sessionId, origin.sessionId);',
  '    const requestId = origin.requestId;',
  '    const aliasId = "rpc-spawn-" + requestId;',
  '    const rawRequestId = summarize(await host.rpc("status", { id: requestId }, { timeoutMs: 5000 }));',
  '    const rpcSpawnAlias = summarize(await host.rpc("status", { id: aliasId }, { timeoutMs: 5000 }));',
  '    const untargetedStatus = summarize(await host.rpc("status", undefined, { timeoutMs: 5000 }));',
  '    const fleetStatus = summarize(await host.rpc("status", { view: "fleet" }, { timeoutMs: 5000 }));',
  '    const knownRunStatus = summarize(await host.rpc("status", { id: origin.nativeRunId }, { timeoutMs: 5000 }));',
  '    const nativeStatus = JSON.parse(await readFile(join(host.asyncDirRoot, origin.nativeRunId, "status.json"), "utf8"));',
  '    const calls = await host.calls();',
  '    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: host.repository, encoding: "utf8" }).trim();',
  '    await writeFile(reportPath, JSON.stringify({ sessionId, requestId, aliasId, rawRequestId, rpcSpawnAlias, untargetedStatus, fleetStatus, knownRunStatus, nativeStatusArtifact: { runId: nativeStatus.runId, sessionId: nativeStatus.sessionId, state: nativeStatus.state, toolCallId: nativeStatus.toolCallId ?? null, processTerminal: nativeStatus.processTerminal ? { state: nativeStatus.processTerminal.state, runId: nativeStatus.processTerminal.runId, runnerProcessInstanceId: nativeStatus.processTerminal.runnerProcessInstanceId } : undefined }, publicIdentityFields: [rawRequestId, rpcSpawnAlias, untargetedStatus, fleetStatus].flatMap(value => value.structuredIdentityFields), hostPid: process.pid, childPids: calls.map(call => call.pid), sideEffects: calls.length, head }));',
  '  }',
  '} finally {',
  '  if (phase === "origin" && host && startedRunId && !proofObserved) {',
  '    try { await host.rpc("stop", { id: startedRunId }, { timeoutMs: 3000 }); await waitForProof(host, startedRunId, 10000); }',
  '    catch (error) { await writeFile(join(sandbox, "u2-cleanup-unresolved.json"), JSON.stringify({ sessionId, runId: startedRunId, proofError: String(error) })); }',
  '  }',
  '  await host?.dispose();',
  '}',
  'if (phase !== "origin" && phase !== "reattach") throw new Error("Unknown host phase: " + phase);',
].join('\n');

async function runFreshHostPhase(
  phase,
  sandbox,
  sessionId,
  timeoutMs = 75_000,
  shape = 'direct',
) {
  const { spawn } = await import('node:child_process');
  const scriptPath = join(sandbox, 'host-phase.mjs');
  await writeFile(scriptPath, freshHostPhaseScript);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, phase, sandbox, sessionId, shape],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: join(sandbox, 'home'),
          TMPDIR: join(sandbox, 'tmp'),
          LANG: 'C',
          LC_ALL: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          NODE_OPTIONS: '',
          NODE_PATH: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            'Fresh native host phase ' +
              phase +
              ' failed: code=' +
              code +
              ' signal=' +
              signal +
              ' stderr=' +
              stderr.slice(-4000),
          ),
        );
        return;
      }
      resolve(child.pid);
    });
  });
}

function structuredBindingFields(view, candidateId, runId) {
  const fields = view?.structuredIdentityFields ?? [];
  const runFields = fields.filter(
    (field) =>
      ['runId', 'workflowRunId'].includes(field.key) && field.value === runId,
  );
  const bindingFields = fields.filter(
    (field) =>
      (field.key === 'toolCallId' ||
        field.key === 'parentToolCallId' ||
        field.key === 'requestId' ||
        field.key === 'id') &&
      field.value === candidateId,
  );
  return runFields.some((runField) => {
    const runParent = runField.path.slice(0, runField.path.lastIndexOf('.'));
    return bindingFields.some(
      (bindingField) =>
        bindingField.path.slice(0, bindingField.path.lastIndexOf('.')) ===
        runParent,
    );
  });
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

test('released public status correlation after a fresh OS host process', {
  timeout: 180_000,
}, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'pi-plan-exec-native-u2-'));
  const sessionId = `native-u2-${randomUUID()}`;
  let passed = false;
  try {
    const originHostPid = await runFreshHostPhase('origin', sandbox, sessionId);
    const origin = JSON.parse(
      await readFile(join(sandbox, 'u2-origin.json'), 'utf8'),
    );
    assert.equal(origin.hostPid, originHostPid);
    assert.equal(origin.sessionId, sessionId);
    assert.equal(origin.sideEffects, 1);
    assert.equal(origin.proof.state, 'observed');
    assert.equal(origin.proof.runId, origin.nativeRunId);

    const recoveryHostPid = await runFreshHostPhase(
      'reattach',
      sandbox,
      sessionId,
    );
    const recovery = JSON.parse(
      await readFile(join(sandbox, 'u2-recovery.json'), 'utf8'),
    );
    assert.notEqual(originHostPid, recoveryHostPid);
    assert.notEqual(originHostPid, process.pid);
    assert.notEqual(recoveryHostPid, process.pid);
    assert.equal(recovery.hostPid, recoveryHostPid);
    assert.equal(recovery.sessionId, sessionId);
    assert.equal(recovery.sideEffects, 1);
    assert.deepEqual(recovery.childPids, [origin.childPid]);
    assert.ok(
      recovery.childPids.every(
        (pid) => pid !== originHostPid && pid !== recoveryHostPid,
      ),
    );
    assert.equal(
      recovery.head,
      origin.head,
      'reattach must not reset the fixture repository',
    );
    assert.equal(recovery.nativeStatusArtifact.runId, origin.nativeRunId);
    assert.equal(recovery.nativeStatusArtifact.sessionId, sessionId);
    assert.equal(recovery.nativeStatusArtifact.toolCallId, null);
    assert.equal(recovery.rawRequestId.success, false);
    assert.equal(recovery.rawRequestId.error?.code, 'execution_failed');
    assert.match(
      recovery.rawRequestId.error?.message ?? '',
      /Async run not found/i,
    );
    assert.equal(recovery.rpcSpawnAlias.success, false);
    assert.equal(recovery.rpcSpawnAlias.error?.code, 'execution_failed');
    assert.match(
      recovery.rpcSpawnAlias.error?.message ?? '',
      /Async run not found/i,
    );
    assert.equal(
      recovery.nativeStatusArtifact.processTerminal?.state,
      'observed',
    );

    const knownRunProof = recovery.knownRunStatus.processTerminal;
    assert.equal(knownRunProof?.state, 'observed');
    assert.equal(knownRunProof?.runId, origin.nativeRunId);
    assert.equal(typeof knownRunProof?.runnerProcessInstanceId, 'string');

    const rawRecovered =
      recovery.rawRequestId.processTerminal?.runId === origin.nativeRunId;
    const aliasRecovered =
      recovery.rpcSpawnAlias.processTerminal?.runId === origin.nativeRunId;
    const publicStatusViews = [
      recovery.rawRequestId,
      recovery.rpcSpawnAlias,
      recovery.untargetedStatus,
      recovery.fleetStatus,
    ];
    const rawStructuredBinding = publicStatusViews.some((view) =>
      structuredBindingFields(view, origin.requestId, origin.nativeRunId),
    );
    const aliasStructuredBinding = publicStatusViews.some((view) =>
      structuredBindingFields(view, recovery.aliasId, origin.nativeRunId),
    );
    assert.equal(rawRecovered, false);
    assert.equal(aliasRecovered, false);
    assert.equal(rawStructuredBinding, false);
    assert.equal(aliasStructuredBinding, false);
    t.diagnostic(
      JSON.stringify({
        rawRequestId: {
          success: recovery.rawRequestId.success,
          error: recovery.rawRequestId.error,
          exactRunProof: rawRecovered,
        },
        rpcSpawnAlias: {
          success: recovery.rpcSpawnAlias.success,
          error: recovery.rpcSpawnAlias.error,
          exactRunProof: aliasRecovered,
        },
        structuredStatusBindings: {
          rawRequestId: rawStructuredBinding,
          rpcSpawnAlias: aliasStructuredBinding,
        },
        nativeStatusArtifact: recovery.nativeStatusArtifact,
        publicIdentityFields: recovery.publicIdentityFields,
        sideEffects: recovery.sideEffects,
        hostPids: [originHostPid, recoveryHostPid],
      }),
    );
    passed = true;
  } finally {
    if (passed) await rm(sandbox, { recursive: true, force: true });
    else console.error(`Retained U2 fresh-host sandbox: ${sandbox}`);
  }
});

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

test('selected keyed workflow recovers exact request correlation across fresh OS hosts without redispatch', {
  timeout: 180000,
}, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'native-workflow-restart-'));
  const sessionId = `native-workflow-${randomUUID()}`;
  let passed = false;
  try {
    await runFreshHostPhase('origin', sandbox, sessionId, 75000, 'workflow');
    const origin = JSON.parse(
      await readFile(join(sandbox, 'u2-origin.json'), 'utf8'),
    );
    await runFreshHostPhase('reattach', sandbox, sessionId, 75000, 'workflow');
    const recovered = JSON.parse(
      await readFile(join(sandbox, 'u2-recovery.json'), 'utf8'),
    );
    assert.equal(recovered.rpcSpawnAlias.success, true);
    assert.equal(
      recovered.nativeStatusArtifact.toolCallId,
      `rpc-spawn-${origin.requestId}`,
    );
    assert.equal(
      structuredBindingFields(
        recovered.rpcSpawnAlias,
        `rpc-spawn-${origin.requestId}`,
        origin.nativeRunId,
      ),
      true,
    );
    assert.equal(recovered.knownRunStatus.processTerminal?.state, 'observed');
    assert.equal(recovered.knownRunStatus.processTerminal?.children.length, 1);
    assert.equal(recovered.sideEffects, 1);
    assert.equal(recovered.head, origin.head);
    assert.deepEqual(recovered.childPids, [origin.childPid]);
    passed = true;
  } finally {
    if (passed) await rm(sandbox, { recursive: true, force: true });
    else console.error(`Unresolved recovery fixture retained: ${sandbox}`);
  }
});

test('S42/S45 real old Bridge workflow excludes a new controller and imports exact settlement after quiescence', {
  timeout: 150000,
}, async () => {
  const { execFile, spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdir, realpath } = await import('node:fs/promises');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const execute = promisify(execFile);
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), 'native-legacy-hosts-')),
  );
  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return undefined;
    }
  }
  async function until(fn, label) {
    const end = Date.now() + 65000;
    while (Date.now() < end) {
      const result = await fn();
      if (result) return result;
      await delay(30);
    }
    throw new Error(`Timed out: ${label}`);
  }
  await mkdir(join(sandbox, 'frozen'));
  await mkdir(join(sandbox, 'bridge'));
  await mkdir(join(sandbox, 'npm-home'));
  const packageEnv = {
    PATH: process.env.PATH,
    HOME: join(sandbox, 'npm-home'),
    npm_config_userconfig: join(sandbox, 'npm-home/user.npmrc'),
    npm_config_globalconfig: join(sandbox, 'npm-home/global.npmrc'),
    npm_config_cache: join(sandbox, 'npm-cache'),
    npm_config_registry: 'https://registry.npmjs.org',
  };
  const baseline = 'bc5fb6ef800b6e88f3edeef542869bbd84a9ed3a';
  await execute('git', [
    'archive',
    '--format=tar',
    `--output=${join(sandbox, 'old.tar')}`,
    baseline,
    'src',
  ]);
  await execute('tar', [
    '-xf',
    join(sandbox, 'old.tar'),
    '-C',
    join(sandbox, 'frozen'),
  ]);
  for (const file of ['controller.ts', 'registry.ts', 'bridge.ts'])
    assert.equal(
      await readFile(join(sandbox, 'frozen/src', file), 'utf8'),
      (
        await execute('git', ['show', `${baseline}:src/${file}`], {
          maxBuffer: 2000000,
        })
      ).stdout,
    );
  const packed = await execute(
    'npm',
    [
      'exec',
      '--yes',
      '--package=npm@12.0.2',
      '--',
      'npm',
      'pack',
      '@alexeiled/pi-subagents-bridge@0.5.5',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      join(sandbox, 'bridge'),
    ],
    { env: packageEnv, timeout: 60000, maxBuffer: 2000000 },
  );
  const packing = JSON.parse(packed.stdout);
  const manifest = Array.isArray(packing)
    ? packing[0]
    : Object.values(packing)[0];
  await writeFile(
    join(sandbox, 'bridge-package.json'),
    JSON.stringify(manifest),
  );
  await execute('tar', [
    '-xf',
    join(sandbox, 'bridge', manifest.filename),
    '-C',
    join(sandbox, 'bridge'),
  ]);
  const script = new URL('./fixtures/legacy-runtime-host.mjs', import.meta.url);
  const child = spawn(
    process.execPath,
    [fileURLToPath(script), 'origin', sandbox],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const closed = once(child, 'close');
  let origin;
  try {
    origin = await until(async () => {
      if (child.exitCode !== null) throw new Error(errors);
      return readJson(join(sandbox, 'origin.json'));
    }, 'old process owns active workflow');
    await execute(
      process.execPath,
      [fileURLToPath(script), 'admission', sandbox],
      { timeout: 30000, maxBuffer: 2000000 },
    );
    const admission = await readJson(join(sandbox, 'admission.json'));
    assert.equal(admission.refused, true);
    assert.equal(admission.spawns, 0);
    assert.notEqual(admission.hostPid, origin.hostPid);
    await writeFile(join(sandbox, 'quiesce.json'), '{}');
    await until(async () => {
      if (child.exitCode !== null) throw new Error(errors);
      return readJson(join(sandbox, 'quiescent.json'));
    }, 'explicit old-controller quiescence and settlement');
    await execute(
      process.execPath,
      [fileURLToPath(script), 'recover', sandbox],
      { timeout: 30000, maxBuffer: 2000000 },
    );
    const recovered = await readJson(join(sandbox, 'recovery.json'));
    assert.equal(recovered.rootId, origin.rootId);
    assert.equal(recovered.spawns, 0);
    assert.equal(recovered.sideEffects, 1);
    assert.equal(recovered.retired, true);
    console.log(
      JSON.stringify({ scenario: 'S42/S45', admission, recovered, sandbox }),
    );
    await writeFile(join(sandbox, 'finish.json'), '{}');
    assert.equal((await closed)[0], 0, errors);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await writeFile(join(sandbox, 'host/release-child'), 'fixture cleanup');
    if (origin?.child?.pid)
      await until(() => {
        try {
          process.kill(origin.child.pid, 0);
          return false;
        } catch (error) {
          if (error.code === 'ESRCH') return true;
          throw error;
        }
      }, 'known legacy child OS cleanup, not retirement proof');
    console.log(`Retained real legacy-host evidence: ${sandbox}; ${errors}`);
  }
});
