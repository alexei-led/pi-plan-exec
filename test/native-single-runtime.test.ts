import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { onTestFinished, test, vi } from 'vitest';
import { NativeRuntimeClient } from '../src/native-runtime.js';
import { NativeSingleRuntimeClient } from '../src/native-single-runtime.js';
import { nativeOperationDigest } from '../src/operation-safety.js';
import { RunRegistry } from '../src/registry.js';
import { required } from '../src/required.js';
import type { EventBus } from '../src/rpc.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../src/types.js';

vi.mock('pi-subagents/preflight', () => ({
  resolveSubagentLaunchContract: async () => ({
    ok: true,
    contract: { agent: { name: 'worker' } },
  }),
}));
vi.mock('pi-subagents/capability-ceiling', () => ({
  resolveCurrentSubagentCapabilityCeiling: () => undefined,
}));
vi.mock('pi-subagents/intercom-bridge', () => ({
  resolveIntercomSessionTarget: () => 'supervisor',
}));

const NATIVE_ID = '11111111-1111-4111-8111-111111111111';
const CONTRACT = 'a'.repeat(64);
type Request = {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};

class Bus implements EventBus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => {
      handlers.delete(handler);
    };
  }
  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

async function fixture(schema = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'native-single-test-')),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const registry = new RunRegistry(join(root, 'runs'));
  const bus = new Bus();
  let session = 'session';
  const context = () =>
    ({
      cwd: root,
      isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => [] },
      scopedModels: [],
      sessionManager: {
        getSessionId: () => session,
        getSessionFile: () => '/parent.jsonl',
      },
    }) as unknown as ExtensionContext;
  const client = new NativeSingleRuntimeClient(bus, registry, context, {
    rpcTimeoutMs: 20,
  });
  onTestFinished(() => client.dispose());
  let run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: root,
    worktreeCwd: root,
    planPath: join(root, 'plan.md'),
    planHash: 'hash',
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
  const operation = await client.prepare(run, {
    operationId: 'operation',
    kind: 'implementation',
    taskId: 1,
    agent: 'worker',
    task: 'Complete only this task',
    maxTurns: 50,
    ...(schema ? { outputSchema: { type: 'object' } } : {}),
  });
  run = await registry.update({ ...run, activeOperation: operation });
  const meta = required(operation.native);
  const binding = {
    operationId: operation.operationId,
    requestDigest: required(operation.requestDigest),
  };
  const asyncDir = join(root, 'provider', NATIVE_ID);
  const resultPath = join(root, 'results', NATIVE_ID + '.json');
  await mkdir(asyncDir, { recursive: true });
  await mkdir(join(root, 'results'));
  const proof = {
    version: 1,
    state: 'observed',
    runId: NATIVE_ID,
    runnerProcessInstanceId: 'runner',
    observedAt: 200,
    instances: [
      {
        kind: 'runner',
        processInstanceId: 'runner',
        closeObservedAt: 100,
        exitCode: 0,
        signal: null,
      },
    ],
  };
  const source: Record<string, unknown> = {
    lifecycleArtifactVersion: 3,
    mode: 'single',
    runId: NATIVE_ID,
    sessionId: meta.nativeSessionId,
    toolCallId: 'rpc-spawn-' + meta.request.requestId,
    cwd: root,
    launchContractDigest: CONTRACT,
    state: 'complete',
    timeoutMs: 1_800_000,
    processTerminal: {
      version: 1,
      state: 'pending',
      runId: NATIVE_ID,
      runnerProcessInstanceId: 'runner',
    },
    steps: [
      {
        agent: 'worker',
        status: 'complete',
        exitCode: 0,
        model: 'fixture/model',
        ...(schema ? { structuredOutput: { reviewed: true } } : {}),
      },
    ],
  };
  const structured = { reviewed: true };
  const result: Record<string, unknown> = {
    id: NATIVE_ID,
    mode: 'single',
    sessionId: meta.nativeSessionId,
    cwd: root,
    toolCallId: source.toolCallId,
    launchContractDigest: CONTRACT,
    success: true,
    state: 'complete',
    exitCode: 0,
    results: [
      {
        agent: 'worker',
        success: true,
        savedOutputPath: meta.outputPath,
        launchContractDigest: CONTRACT,
        ...(schema ? { structuredOutput: structured } : {}),
      },
    ],
  };
  let publishedProof: unknown = proof;
  let reportedResultPath: unknown = resultPath;
  const details = () => ({
    mode: 'single',
    runId: NATIVE_ID,
    asyncId: NATIVE_ID,
    asyncDir,
    resultPath: reportedResultPath,
    toolCallId: source.toolCallId,
    launchContractDigest: CONTRACT,
    lifecycleStatus: { processTerminal: publishedProof },
  });
  const save = async () => {
    await writeFile(join(asyncDir, 'status.json'), JSON.stringify(source));
    await writeFile(resultPath, JSON.stringify(result));
    await writeFile(
      meta.outputPath,
      schema ? JSON.stringify(structured) : 'Completed task',
    );
  };
  await save();
  const requests: Request[] = [];
  let dropSpawn = false;
  bus.on('subagents:rpc:v1:request', (value) => {
    const request = value as Request;
    requests.push(request);
    if (request.method === 'spawn' && dropSpawn) return;
    bus.emit('subagents:rpc:v1:reply:' + request.requestId, {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: true,
      data: { details: details() },
    });
  });
  return {
    root,
    registry,
    bus,
    client,
    context,
    run,
    operation,
    meta,
    binding,
    asyncDir,
    resultPath,
    source,
    result,
    proof,
    save,
    requests,
    setResultPath(value: unknown) {
      reportedResultPath = value;
    },
    setProof(value: unknown) {
      publishedProof = value;
    },
    setSession(value: string) {
      session = value;
    },
    dropSpawnReply() {
      dropSpawn = true;
    },
  };
}

for (const session of [
  { sessionId: 'session', sessionFile: '/parent.jsonl' },
  {},
  { sessionId: 'stale-session', sessionFile: '/parent.jsonl' },
  { sessionId: 'session', sessionFile: '/another.jsonl' },
])
  test(`native readiness requires the active matching SDK session: ${JSON.stringify(session)}`, async () => {
    const bus = new Bus();
    const context = () =>
      ({
        sessionManager: {
          getSessionId: () => 'session',
          getSessionFile: () => '/parent.jsonl',
        },
      }) as unknown as ExtensionContext;
    const client = new NativeSingleRuntimeClient(
      bus,
      new RunRegistry('/unused'),
      context,
    );
    onTestFinished(() => client.dispose());
    bus.on('subagents:rpc:v1:request', (value) => {
      const request = value as Request;
      bus.emit('subagents:rpc:v1:reply:' + request.requestId, {
        version: 1,
        requestId: request.requestId,
        method: request.method,
        success: true,
        data: {
          version: 1,
          session,
          capabilities: {
            asyncSpawn: true,
            stop: true,
            processTerminalProof: { version: 1 },
          },
          events: {
            asyncStarted: 'subagent:async-started',
            jobsChanged: 'subagent:jobs-changed',
          },
        },
      });
    });
    assert.equal(
      await client.available(),
      'sessionId' in session &&
        session.sessionId === 'session' &&
        session.sessionFile === '/parent.jsonl',
    );
  });

test('new native intent is a unique direct single with honest limits and file-only schema output', async () => {
  const f = await fixture(true);
  assert.equal(f.meta.version, 2);
  assert.equal(f.meta.request.params.script, undefined);
  assert.equal(f.meta.request.params.agent, 'worker');
  assert.equal(f.meta.request.params.async, true);
  assert.equal(f.meta.request.params.outputMode, 'file-only');
  assert.deepEqual(f.meta.request.params.outputSchema, { type: 'object' });
  assert.equal(f.meta.limits.maxTurnsEnforced, false);
  assert.equal(f.meta.limits.childTimeout, 'native-default');
  assert.equal(f.operation.requestDigest, nativeOperationDigest(f.operation));
});

for (const schema of [false, true])
  test(`single settlement requires its exact output and observed runner proof (schema=${schema})`, async () => {
    const f = await fixture(schema);
    await f.client.spawn(f.run.id, f.binding);
    const observed = await f.client.result(f.run.id, f.binding);
    assert.equal(observed.state, 'retired', observed.reason);
    assert.ok(observed.result, observed.reason);
    assert.equal(observed.result.runId, NATIVE_ID);
    assert.equal(observed.result.envelope.mode, 'single');
    assert.equal(observed.proof?.runId, NATIVE_ID);
    assert.equal(observed.operation.native?.reportedModel, 'fixture/model');
    assert.equal(
      f.requests.filter((request) => request.method === 'spawn').length,
      1,
    );
  });

for (const value of ['relative.json', '/tmp/other-run.json', '', 42])
  test(`an explicitly contradictory result path stays fenced: ${JSON.stringify(value)}`, async () => {
    const f = await fixture(true);
    f.setResultPath(value);
    const observed = await f.client.spawn(f.run.id, f.binding);
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.result, undefined);
  });

test('retained exact status and schema output do not require an ephemeral result path', async () => {
  const f = await fixture(true);
  f.setResultPath(undefined);
  await f.client.spawn(f.run.id, f.binding);
  const observed = await f.client.result(f.run.id, f.binding);
  assert.ok(observed.result, observed.reason);
  assert.deepEqual(observed.result.structuredOutput, { reviewed: true });
});

test('a delivered native result can disappear without losing bound status/schema settlement', async () => {
  const f = await fixture(true);
  await f.client.spawn(f.run.id, f.binding);
  await rm(f.resultPath);
  const observed = await f.client.result(f.run.id, f.binding);
  assert.ok(observed.result, observed.reason);
  assert.deepEqual(observed.result.structuredOutput, { reviewed: true });
});

test('a different reported agent cannot pass even when status and result agree', async () => {
  const f = await fixture();
  required((f.source.steps as Array<Record<string, unknown>>)[0]).agent =
    'another-agent';
  required((f.result.results as Array<Record<string, unknown>>)[0]).agent =
    'another-agent';
  await f.save();
  const observed = await f.client.spawn(f.run.id, f.binding);
  assert.equal(observed.state, 'unknown');
  assert.equal(observed.result, undefined);
});

test('durable dispatch and stop intent serialize on the same record fence', async () => {
  const f = await fixture();
  const events: string[] = [];
  let stopped: Promise<unknown> | undefined;
  const claimed = await f.registry.dispatchNative(
    f.run,
    f.operation,
    'session',
    () => {
      events.push('emit');
      stopped = f.registry
        .updateLatest(f.run.id, (current) => ({
          ...current,
          status: 'cancel_pending',
          userStopped: true,
          stopGeneration: 1,
        }))
        .then(() => {
          events.push('stop');
        });
    },
  );
  assert.equal(claimed.applied, true);
  await stopped;
  assert.deepEqual(events, ['emit', 'stop']);
  const current = required(await f.registry.get(f.run.id));
  assert.equal(current.status, 'cancel_pending');
  assert.equal(current.activeOperation?.native?.phase, 'dispatching');
  assert.equal(
    (
      await f.registry.dispatchNative(f.run, f.operation, 'session', () =>
        assert.fail('No second emit'),
      )
    ).applied,
    false,
  );
});

test('stop intent winning the final dispatch fence emits nothing', async () => {
  const f = await fixture();
  await f.registry.updateLatest(f.run.id, (current) => ({
    ...current,
    status: 'cancel_pending',
    userStopped: true,
    stopGeneration: 1,
  }));
  const claimed = await f.registry.dispatchNative(
    f.run,
    f.operation,
    'session',
    () => assert.fail('No emit after stop'),
  );
  assert.equal(claimed.applied, false);
  assert.equal(claimed.run.activeOperation?.native?.phase, 'prepared');
});

test('a dropped spawn reply recovers by exact persisted alias, never a second spawn', async () => {
  const f = await fixture();
  f.dropSpawnReply();
  assert.equal((await f.client.spawn(f.run.id, f.binding)).state, 'unknown');
  const observed = await f.client.operation(f.run.id, f.binding);
  assert.equal(observed.state, 'retired', observed.reason);
  assert.equal(observed.operation.externalRunId, NATIVE_ID);
  assert.equal(
    f.requests.at(-1)?.params.id,
    'rpc-spawn-' + f.meta.request.requestId,
  );
  assert.equal(
    f.requests.filter((request) => request.method === 'spawn').length,
    1,
  );
});

test('initial runner status binds identity without claiming missing metadata or retirement', async () => {
  const f = await fixture();
  delete f.source.cwd;
  delete f.source.launchContractDigest;
  f.source.state = 'running';
  f.source.steps = [{ agent: 'worker', status: 'pending' }];
  f.setProof({ ...f.proof, state: 'pending' });
  await f.save();
  const bound = await f.client.spawn(f.run.id, f.binding);
  assert.equal(bound.state, 'bound', bound.reason);
  assert.equal(bound.operation.externalRunId, NATIVE_ID);
  assert.notEqual(bound.operation.processTreeExited, true);
  assert.equal(bound.proof, undefined);
});

for (const field of [
  'runId',
  'sessionId',
  'toolCallId',
  'cwd',
  'mode',
] as const)
  test(`contradictory source ${field} stays fenced without output`, async () => {
    const f = await fixture();
    f.source[field] = 'wrong';
    await f.save();
    const observed = await f.client.spawn(f.run.id, f.binding);
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.result, undefined);
    assert.notEqual(observed.operation.processTreeExited, true);
    assert.equal(
      f.requests.filter((request) => request.method === 'spawn').length,
      1,
    );
  });

for (const state of ['pending', 'unknown', 'not-started'])
  test(`standalone ${state} proof is not observed runner retirement`, async () => {
    const f = await fixture();
    f.setProof({ ...f.proof, state, reason: 'unverified' });
    const observed = await f.client.spawn(f.run.id, f.binding);
    assert.equal(observed.state, 'bound', observed.reason);
    assert.notEqual(observed.operation.processTreeExited, true);
  });

test('an observed proof for another runner or without runner closure cannot retire the single', async () => {
  for (const proof of [
    { runnerProcessInstanceId: 'other' },
    { instances: [] },
  ]) {
    const f = await fixture();
    f.setProof({ ...f.proof, ...proof });
    assert.equal((await f.client.spawn(f.run.id, f.binding)).state, 'bound');
  }
});

test('read-only inspection does not bind or change the registry', async () => {
  const f = await fixture();
  const dispatching = {
    ...f.operation,
    native: {
      ...f.meta,
      phase: 'dispatching' as const,
      admittedAgent: 'worker',
    },
  };
  await f.registry.update({ ...f.run, activeOperation: dispatching });
  const before = await readFile(f.registry.authorizationPath(f.run.id));
  const observed = await f.client.inspect(f.run.id, f.binding);
  assert.equal(observed.operation.externalRunId, NATIVE_ID);
  assert.equal(observed.state, 'retired');
  assert.deepEqual(
    await readFile(f.registry.authorizationPath(f.run.id)),
    before,
  );
});

test('reading a run from another session never grants stop authority', async () => {
  const f = await fixture();
  await f.client.spawn(f.run.id, f.binding);
  f.setSession('another-session');
  await assert.rejects(
    f.client.cancelOperation(f.run.id, f.binding),
    /Foreign session/,
  );
  assert.equal(
    f.requests.some((request) => request.method === 'stop'),
    false,
  );
});

test('schema disagreement, output path substitution and symlinks cannot produce a successful result', async () => {
  for (const corruption of ['schema', 'path', 'symlink'] as const) {
    const f = await fixture(true);
    await f.client.spawn(f.run.id, f.binding);
    if (corruption === 'schema')
      await writeFile(f.meta.outputPath, '{"reviewed":false}');
    else if (corruption === 'path') {
      required(
        (f.result.results as Array<Record<string, unknown>>)[0],
      ).savedOutputPath = join(f.root, 'other.json');
      await writeFile(f.resultPath, JSON.stringify(f.result));
    } else {
      await rm(f.meta.outputPath);
      await symlink(f.resultPath, f.meta.outputPath);
    }
    const observed = await f.client.result(f.run.id, f.binding);
    assert.equal(observed.result, undefined);
    assert.equal(observed.successfulChild, true);
  }
});

test('an older observation without a model cannot overwrite a concurrent reported model', async () => {
  const f = await fixture();
  f.setProof(undefined);
  await f.client.spawn(f.run.id, f.binding);
  delete (f.source.steps as Array<Record<string, unknown>>)[0]?.model;
  await f.save();
  const update = f.registry.updateIfCurrent.bind(f.registry);
  vi.spyOn(f.registry, 'updateIfCurrent').mockImplementationOnce(
    async (next, expected) => {
      const current = required(await f.registry.get(f.run.id));
      const operation = required(current.activeOperation);
      await f.registry.update({
        ...current,
        activeOperation: {
          ...operation,
          native: {
            ...required(operation.native),
            reportedModel: 'fixture/newer',
          },
        },
      });
      return update(next, expected);
    },
  );
  await f.client.operation(f.run.id, f.binding);
  assert.equal(
    (await f.registry.get(f.run.id))?.activeOperation?.native?.reportedModel,
    'fixture/newer',
  );
});

for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
  test(`invalid optional native timeout does not block matching retirement: ${timeoutMs}`, async () => {
    const f = await fixture();
    f.source.timeoutMs = timeoutMs;
    await f.save();
    const observed = await f.client.spawn(f.run.id, f.binding);
    assert.equal(observed.state, 'retired', observed.reason);
    assert.equal(observed.operation.native?.observedLimits, undefined);
  });

test('historical prepared workflows cannot dispatch through the new production adapter', async () => {
  const f = await fixture();
  const legacy = new NativeRuntimeClient(f.bus, f.registry, f.context);
  onTestFinished(() => legacy.dispose());
  const operation = await legacy.prepare(f.run, {
    operationId: 'old-workflow',
    kind: 'implementation',
    agent: 'worker',
    task: 'Old intent',
  });
  await f.registry.update({ ...f.run, activeOperation: operation });
  await assert.rejects(
    f.client.spawn(f.run.id, {
      operationId: operation.operationId,
      requestDigest: required(operation.requestDigest),
    }),
    /Historical native workflow/,
  );
  assert.equal(f.requests.length, 0);
});
