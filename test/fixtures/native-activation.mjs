import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const { PlanExecController } = await jiti.import('../../src/controller.ts');
const { RunRegistry } = await jiti.import('../../src/registry.ts');
const { registerNativeReviewer } = await jiti.import(
  '../../src/native-reviewer.ts',
);
const { createControllerLocalExecutor } = await jiti.import(
  './controller-local-executor.ts',
);
const mode = process.argv[2];
const sandbox = await realpath(
  await mkdtemp(join(tmpdir(), 'native-activation-')),
);
const sessionFile = join(sandbox, 'parent.jsonl');
await writeFile(
  sessionFile,
  JSON.stringify({ type: 'session', version: 3, id: 'parent' }) + '\n',
);
const host = await createNativeRuntimeHost(join(sandbox, 'host'), {
  nativeController: mode,
  sessionFile,
});
const registry = new RunRegistry(join(sandbox, 'registry'));
const native = new NativeRuntimeClient(
  host.events,
  registry,
  () => host.context,
  { rpcTimeoutMs: mode === 'plan' ? 200 : 30000 },
);
const role = registerNativeReviewer(host.events);
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
  throw new Error('Explicit Fusion must not be selected by default');
};
const fusion = {
  start: unavailable,
  status: unavailable,
  result: unavailable,
  adopt: unavailable,
  cancel: unavailable,
};
const controller = new PlanExecController(
  registry,
  native,
  fusion,
  command,
  createControllerLocalExecutor(),
);
let firstSpawn;
const originalEmit = host.events.emit.bind(host.events);
host.events.emit = (name, value) => {
  if (
    mode === 'plan' &&
    name === 'subagents:rpc:v1:request' &&
    value.method === 'spawn' &&
    !firstSpawn
  )
    firstSpawn = value.requestId;
  if (mode === 'plan' && name === `subagents:rpc:v1:reply:${firstSpawn}`)
    return;
  originalEmit(name, value);
};
const launches = [];
host.events.on('subagents:rpc:v1:request', (request) => {
  if (request.method === 'spawn') launches.push(request);
});
host.events.on('plan-exec:bridge:v1:request', () => {
  throw new Error('Bridge RPC emitted');
});
host.events.on('plan-exec:bridge:v2:request', () => {
  throw new Error('Bridge RPC emitted');
});
try {
  await command('git', ['branch', 'main'], host.repository);
  await mkdir(join(host.repository, '.pi'), { recursive: true });
  await writeFile(
    join(host.repository, '.pi', 'plan-exec.json'),
    JSON.stringify({
      reviewEnabled: true,
      reviewRequired: true,
      finalizeEnabled: false,
      statsEnabled: mode === 'plan',
      retryDelayMs: 20,
      executionLifetime: { mode: 'bounded', timeoutMs: 60000 },
    }),
  );
  await command('git', ['add', '.pi/plan-exec.json'], host.repository);
  await command(
    'git',
    ['commit', '-m', 'Configure required native review'],
    host.repository,
  );
  let run =
    mode === 'goal'
      ? await controller.startGoal({
          goal: 'Deliver the fixture',
          checks: [[process.execPath, 'check.mjs']],
          cwd: host.repository,
          sessionId: host.sessionId,
        })
      : await controller.start({
          cwd: host.repository,
          planPath: join(host.repository, 'plan.md'),
          useWorktree: false,
          sessionId: host.sessionId,
        });
  const operations = new Map();
  for (let tick = 0; tick < 350 && run.status !== 'completed'; tick++) {
    if (run.activeOperation)
      operations.set(run.activeOperation.operationId, run.activeOperation);
    run = await controller.tick(run.id, host.sessionId);
    if (
      run.needsAttention &&
      run.error &&
      !(
        mode === 'plan' &&
        /Native RPC response lost|Native launch is uncertain/.test(run.error)
      )
    ) {
      console.error(
        (run.activeOperation ?? run.failedOperation)?.asyncDir
          ? await readFile(
              join(
                (run.activeOperation ?? run.failedOperation).asyncDir,
                'status.json',
              ),
              'utf8',
            )
          : JSON.stringify(run),
      );
      throw new Error(`${run.stage}: ${run.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(
    launches.length,
    mode === 'plan' ? 3 : mode === 'fix' ? 4 : 2,
    'Only authorized worker/review/fix/stats launches, no replay',
  );
  assert.equal(operations.size, launches.length);
  for (const op of operations.values()) {
    assert.equal(op.service, 'native');
    assert.equal(op.native.nativeSessionId, sessionFile);
    assert.equal(op.native.limits.maxTurnsEnforced, false);
    const evidence = JSON.parse(
      await readFile(
        join(op.native.outputPath, '..', 'controller-result.json'),
        'utf8',
      ),
    );
    assert.equal(
      evidence.result.envelope.steps[0].async,
      true,
      'Selected workflow actually launches an async child',
    );
    assert.equal(evidence.proof.children.length, 1);
    assert.equal(evidence.proof.children[0].runId, evidence.result.childRunId);
  }
  const calls = await host.calls();
  assert.deepEqual(
    calls.map((call) => call.agent),
    mode === 'plan'
      ? ['worker', 'plan-exec-reviewer', 'plan-exec-reviewer']
      : mode === 'fix'
        ? ['worker', 'plan-exec-reviewer', 'worker', 'plan-exec-reviewer']
        : ['worker', 'plan-exec-reviewer'],
  );
  assert.ok(
    calls.every((call) => call.pid !== process.pid),
    'Real detached native children',
  );
  assert.equal(run.reviewFindings.length, 0);
  console.log(
    JSON.stringify({
      mode,
      status: run.status,
      launches: launches.length,
      agents: calls.map((call) => call.agent),
      detached: true,
    }),
  );
} finally {
  role.dispose();
  native.dispose();
  await host.dispose();
  await rm(sandbox, { recursive: true, force: true });
}
