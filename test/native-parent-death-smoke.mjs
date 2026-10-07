import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
async function waitFor(fn, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

test('S23 SIGKILL after native launch barrier leaves one surviving child and no recovery redispatch', {
  timeout: 100000,
}, async () => {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), 'native-parent-death-')),
  );
  const script = resolve('test/fixtures/native-crash-host.mjs');
  const parent = spawn(process.execPath, [script, 'origin', sandbox], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  parent.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const closed = once(parent, 'close');
  let origin;
  let passed = false;
  try {
    origin = await waitFor(async () => {
      if (parent.exitCode !== null) throw new Error(errors);
      return json(join(sandbox, 'origin.json'));
    }, 'known launch barrier');
    assert.equal(origin.hostPid, parent.pid);
    assert.equal(origin.spawns, 1);
    assert.equal(parent.kill('SIGKILL'), true); // Only the process this fixture spawned.
    assert.equal((await closed)[1], 'SIGKILL');
    const before = await waitFor(
      () => json(join(sandbox, 'child-barrier.json')),
      'post-death heartbeat baseline',
    );
    const survivor = await waitFor(async () => {
      const current = await json(join(sandbox, 'child-barrier.json'));
      return current?.tick > before.tick + 2 && current;
    }, 'same child survives parent death');
    assert.equal(survivor.pid, origin.child.pid);
    assert.equal(survivor.sessionId, origin.child.sessionId);
    assert.equal(survivor.sessionFile, origin.child.sessionFile);
    await writeFile(join(sandbox, 'release-child'), 'release exactly once');
    await execute(process.execPath, [script, 'recover', sandbox], {
      timeout: 70000,
      maxBuffer: 2000000,
    });
    const recovered = await json(join(sandbox, 'recovery.json'));
    assert.notEqual(recovered.hostPid, origin.hostPid);
    assert.equal(recovered.sideEffects, 1);
    assert.equal(recovered.spawns, 0);
    assert.equal(recovered.controllerTicks, 3);
    assert.ok(recovered.controllerStatusRequests > 0);
    assert.equal(recovered.controllerOperationId, origin.binding.operationId);
    assert.equal(recovered.controllerLeasePid, recovered.hostPid);
    assert.equal(recovered.rootId, origin.rootId);
    assert.equal(recovered.childRunId, origin.childRunId);
    await waitFor(() => {
      try {
        process.kill(origin.child.pid, 0);
        return false;
      } catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
    }, 'fixture child OS cleanup (not retirement proof)');
    console.log(JSON.stringify({ scenario: 'S23', ...recovered }));
    passed = true;
    if (recovered.state === 'retired')
      await rm(sandbox, { recursive: true, force: true });
    else console.log(`Retained safe-uncertainty evidence: ${sandbox}`);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null)
      parent.kill('SIGKILL');
    if (!passed) {
      await writeFile(
        join(sandbox, 'release-child'),
        'failure cleanup permits the known fixture child to settle',
      );
      console.error(`Retained parent-death evidence: ${sandbox}; ${errors}`);
    }
  }
});

for (const [scenario, barrier, name] of [
  [
    'S08',
    'prepared',
    'S08 fresh controller recovers the real prepared filesystem barrier without duplicate launch',
  ],
  [
    'S09',
    'dispatch',
    'S09 fresh controller recovers the real dispatch filesystem barrier without duplicate launch',
  ],
  [
    'S11',
    'binding',
    'S11 fresh controller recovers the real binding filesystem barrier without duplicate launch',
  ],
]) {
  test(name, {
    timeout: 100000,
  }, async () => {
    const sandbox = await realpath(
      await mkdtemp(join(tmpdir(), `native-${barrier}-`)),
    );
    const script = resolve('test/fixtures/native-crash-host.mjs');
    const parent = spawn(
      process.execPath,
      [script, 'origin', sandbox, barrier],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    parent.stderr.on('data', (value) => {
      errors += value;
    });
    const closed = once(parent, 'close');
    let origin;
    try {
      origin = await waitFor(async () => {
        if (parent.exitCode !== null) throw new Error(errors);
        return json(join(sandbox, 'origin.json'));
      }, 'durable filesystem barrier');
      assert.equal(origin.hostPid, parent.pid);
      assert.equal(origin.spawns, barrier === 'binding' ? 1 : 0);
      const before = await json(join(origin.registryDirectory, 'run.json'));
      assert.equal(
        before.activeOperation.native.phase,
        barrier === 'prepared' ? 'prepared' : 'dispatching',
      );
      assert.equal(before.activeOperation.externalRunId, undefined);
      if (barrier === 'binding') {
        assert.equal(origin.failure.code, 'EACCES');
        assert.equal(origin.successfulReply.success, true);
        await waitFor(
          () => json(join(sandbox, 'child-barrier.json')),
          'launched original child',
        );
      }
      assert.equal(parent.kill('SIGKILL'), true);
      assert.equal((await closed)[1], 'SIGKILL');
      await chmod(origin.registryDirectory, 0o755);
      await execute(process.execPath, [script, 'recover', sandbox, barrier], {
        timeout: 70000,
        maxBuffer: 2000000,
      });
      const recovered = await json(join(sandbox, 'recovery.json'));
      assert.notEqual(recovered.hostPid, origin.hostPid);
      assert.equal(recovered.controllerTicks, 3);
      assert.equal(recovered.spawns, barrier === 'prepared' ? 1 : 0);
      assert.equal(recovered.sideEffects, barrier === 'dispatch' ? 0 : 1);
      if (origin.rootId && recovered.operation.externalRunId)
        assert.equal(recovered.operation.externalRunId, origin.rootId);
      console.log(
        JSON.stringify({
          scenario,
          barrier,
          originalRoot: origin.rootId,
          recoveredRoot: recovered.operation.externalRunId,
          phase: recovered.operation.native.phase,
          spawns: recovered.spawns,
          sideEffects: recovered.sideEffects,
          sandbox,
        }),
      );
    } finally {
      if (parent.exitCode === null && parent.signalCode === null)
        parent.kill('SIGKILL');
      if (origin) await chmod(origin.registryDirectory, 0o755);
      await writeFile(join(sandbox, 'release-child'), 'fixture cleanup');
      console.log(
        `Retained filesystem-barrier evidence: ${sandbox}; ${errors}`,
      );
    }
  });
}

test('S26 fresh foreign native host can take the plan lease but cannot control the original child', {
  timeout: 100000,
}, async () => {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), 'native-foreign-')),
  );
  const script = resolve('test/fixtures/native-crash-host.mjs');
  const parent = spawn(process.execPath, [script, 'origin', sandbox], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  parent.stderr.on('data', (value) => {
    errors += value;
  });
  const closed = once(parent, 'close');
  try {
    const origin = await waitFor(async () => {
      if (parent.exitCode !== null) throw new Error(errors);
      return json(join(sandbox, 'origin.json'));
    }, 'original owned child');
    assert.equal(parent.kill('SIGKILL'), true);
    assert.equal((await closed)[1], 'SIGKILL');
    await execute(process.execPath, [script, 'foreign', sandbox], {
      timeout: 70000,
      maxBuffer: 2000000,
    });
    const report = await json(join(sandbox, 'foreign.json'));
    assert.notEqual(report.hostPid, origin.hostPid);
    assert.equal(report.rootId, origin.rootId);
    assert.equal(report.leaseSession, 'foreign-native-session');
    assert.equal(report.nativeSession, 'owned-crash-session');
    assert.equal(report.spawns, 0);
    assert.equal(report.adapterStops, 0);
    assert.equal(report.sideEffects, 1);
    console.log(JSON.stringify({ scenario: 'S26', ...report, sandbox }));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null)
      parent.kill('SIGKILL');
    await writeFile(join(sandbox, 'release-child'), 'fixture cleanup');
    console.log(`Retained foreign-session evidence: ${sandbox}; ${errors}`);
  }
});
