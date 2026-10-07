import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { createNativeRuntimeHost } = await jiti.import(
  './native-runtime-host.ts',
);
const { NativeRuntimeClient } = await jiti.import(
  '../../src/native-runtime.ts',
);
const { RunRegistry } = await jiti.import('../../src/registry.ts');
const { PlanExecController } = await jiti.import('../../src/controller.ts');
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
let statusRequests = 0;
host.events.on('subagents:rpc:v1:request', (request) => {
  if (request.method === 'spawn') spawns++;
  if (request.method === 'status') statusRequests++;
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
    const execute = promisify(execFile);
    const command = async (program, args, cwd) => {
      try {
        return { ...(await execute(program, args, { cwd })), code: 0 };
      } catch (error) {
        return {
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
          code: error.code ?? 1,
        };
      }
    };
    const unavailable = async () => {
      throw new Error('Crash recovery must not switch to Fusion');
    };
    const controller = new PlanExecController(
      registry,
      client,
      {
        start: unavailable,
        status: unavailable,
        result: unavailable,
        adopt: unavailable,
        cancel: unavailable,
      },
      command,
    );
    const beforeStatus = statusRequests;
    let run;
    let controllerTicks = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      run = await controller.tick(origin.runId, host.sessionId);
      controllerTicks++;
      const operation = run.activeOperation ?? run.failedOperation;
      assert.equal(operation?.operationId, origin.binding.operationId);
      assert.equal(operation?.requestDigest, origin.binding.requestDigest);
      assert.equal(operation?.externalRunId, origin.rootId);
      assert.notEqual(operation?.processTreeExited, true);
      assert.equal(run.stage, 'implementation');
    }
    const controllerStatusRequests = statusRequests - beforeStatus;
    assert.ok(controllerStatusRequests > 0);
    assert.equal(run.lease.pid, process.pid);
    const observed = await client.operation(origin.runId, origin.binding);
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
          controllerTicks,
          controllerStatusRequests,
          controllerOperationId: (run.activeOperation ?? run.failedOperation)
            .operationId,
          controllerLeasePid: run.lease.pid,
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
