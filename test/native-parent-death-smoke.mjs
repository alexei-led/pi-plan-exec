import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
