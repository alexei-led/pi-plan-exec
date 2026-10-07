import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { createNativeRuntimeHost } = await jiti.import(
  './native-runtime-host.ts',
);
const { NativeRuntimeClient } = await jiti.import(
  '../../src/native-runtime.ts',
);
const { RunRegistry } = await jiti.import('../../src/registry.ts');
const { DEFAULT_FROZEN_RUN_CONFIG } = await jiti.import('../../src/types.ts');
const [phase, sandbox] = process.argv.slice(2);
const host = await createNativeRuntimeHost(sandbox, {
  sessionId: 'owned-crash-session',
  reattach: phase === 'recover',
  holdChild: phase === 'origin',
});
const registry = new RunRegistry(join(sandbox, 'registry'));
const client = new NativeRuntimeClient(
  host.events,
  registry,
  () => host.context,
);
let spawns = 0;
host.events.on('subagents:rpc:v1:request', (request) => {
  if (request.method === 'spawn') spawns++;
});
async function waitFor(read, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out: ${label}`);
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
if (phase === 'origin') {
  let run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: host.repository,
    worktreeCwd: host.repository,
    planPath: join(host.repository, 'plan.md'),
    planHash: 'fixture',
    branch: 'feature',
    defaultBranch: 'main',
    status: 'running',
    stage: 'implementation',
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    config: DEFAULT_FROZEN_RUN_CONFIG,
  });
  run = await registry.claim(run, host.sessionId);
  const op = await client.prepare(run, {
    operationId: 'crash-operation',
    kind: 'implementation',
    agent: 'worker',
    task: 'Deliver fixture exactly once',
    executionLifetime: { mode: 'bounded', timeoutMs: 60000 },
  });
  await registry.update({ ...run, activeOperation: op });
  const binding = {
    operationId: op.operationId,
    requestDigest: op.requestDigest,
  };
  await client.spawn(run.id, binding);
  const child = await waitFor(
    () => readJson(join(sandbox, 'child-barrier.json')),
    'child model barrier',
  );
  const observed = await client.operation(run.id, binding);
  assert.equal(observed.state, 'bound');
  assert.notEqual(child.pid, process.pid);
  await writeFile(
    join(sandbox, 'origin.json'),
    JSON.stringify({
      hostPid: process.pid,
      child,
      runId: run.id,
      binding,
      rootId: observed.operation.externalRunId,
      childRunId: observed.operation.native.childRunId,
      spawns,
    }),
  );
  setInterval(() => {}, 1000); // Parent test owns and SIGKILLs this exact ChildProcess.
} else {
  try {
    assert.equal(phase, 'recover');
    const origin = await readJson(join(sandbox, 'origin.json'));
    const settled = await waitFor(async () => {
      const child = await readJson(
        join(host.asyncDirRoot, origin.childRunId, 'status.json'),
      );
      return child?.state === 'complete' && child;
    }, 'orphan child settlement');
    let observed;
    for (let attempt = 0; attempt < 30; attempt++) {
      observed = await client.operation(origin.runId, origin.binding);
      if (observed.state === 'retired') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const calls = await host.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pid, origin.child.pid);
    assert.equal(settled.steps[0].sessionFile, origin.child.sessionFile);
    assert.equal(spawns, 0);
    if (observed.state !== 'retired') {
      assert.notEqual(observed.operation.processTreeExited, true);
      assert.equal(
        (await client.result(origin.runId, origin.binding)).result,
        undefined,
      );
    }
    await writeFile(
      join(sandbox, 'recovery.json'),
      JSON.stringify(
        {
          hostPid: process.pid,
          spawns,
          sideEffects: calls.length,
          rootId: observed.operation.externalRunId,
          childRunId: observed.operation.native.childRunId,
          childSessionFile: settled.steps[0].sessionFile,
          nativeProof: settled.processTerminal,
          state: observed.state,
          reason:
            observed.reason ??
            observed.proof ??
            'Retirement unproven after parent SIGKILL',
        },
        null,
        2,
      ),
    );
  } finally {
    client.dispose();
    await host.dispose();
  }
}
