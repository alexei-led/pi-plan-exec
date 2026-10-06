import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished, test } from 'vitest';
import { NativeRuntimeClient } from '../src/native-runtime.js';
import { RunRegistry } from '../src/registry.js';
import { required } from '../src/required.js';
import type { EventBus } from '../src/rpc.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../src/types.js';
import { createNativeRuntimeHost } from './fixtures/native-runtime-host.js';

class Bus implements EventBus {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, fn: (value: unknown) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(name);
    };
  }
  emit(name: string, value: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn(value);
  }
}

type Request = {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};
async function fixture(sessionFile?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'native-runtime-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const registry = new RunRegistry(directory);
  let session = 'session';
  const context = () =>
    ({
      sessionManager: {
        getSessionId: () => session,
        getSessionFile: () => sessionFile,
      },
    }) as ExtensionContext;
  const bus = new Bus();
  const client = new NativeRuntimeClient(bus, registry, context, {
    rpcTimeoutMs: 30,
  });
  onTestFinished(() => client.dispose());
  let run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: directory,
    planPath: join(directory, 'plan.md'),
    planHash: 'hash',
    worktreeCwd: directory,
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
  const op = await client.prepare(run, {
    operationId: 'op',
    kind: 'implementation',
    agent: 'worker',
    task: 'Do work',
  });
  run = await registry.update({ ...run, activeOperation: op });
  const binding = {
    operationId: op.operationId,
    requestDigest: required(op.requestDigest),
  };
  const requests: Request[] = [];
  let handler = (_request: Request): void => {};
  bus.on('subagents:rpc:v1:request', (value) => {
    const req = value as Request;
    requests.push(req);
    handler(req);
  });
  const reply = (req: Request, data: unknown) =>
    bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
      version: 1,
      requestId: req.requestId,
      method: req.method,
      success: true,
      data,
    });
  const summary = (state = 'running') => ({
    version: 1,
    parentToolCallId: `rpc-spawn-${required(op.native).request.requestId}`,
    workflowRunId: 'root',
    inventoryComplete: true,
    workflowState: state,
    children: [
      {
        childId: 'main',
        runId: 'child',
        state: state === 'completed' ? 'completed' : 'running',
      },
    ],
  });
  return {
    directory,
    registry,
    bus,
    client,
    run,
    op,
    binding,
    requests,
    reply,
    summary,
    setHandler(fn: typeof handler) {
      handler = fn;
    },
    setSession(id: string) {
      session = id;
    },
  };
}

test('double spawn CAS-claims once and freezes body before emit', async () => {
  const f = await fixture();
  f.setHandler((req) => {
    if (req.method === 'spawn')
      f.reply(req, {
        details: { runId: 'root', workflowChildren: f.summary() },
      });
    else f.reply(req, { details: { workflowChildren: f.summary() } });
  });
  await Promise.all([
    f.client.spawn(f.run.id, f.binding),
    f.client.spawn(f.run.id, f.binding),
  ]);
  expect(f.requests.filter((r) => r.method === 'spawn')).toHaveLength(1);
  expect(f.requests[0]?.params).toEqual(required(f.op.native).request.params);
  expect((await f.registry.get(f.run.id))?.activeOperation?.externalRunId).toBe(
    'root',
  );
  await expect(
    f.client.spawn(f.run.id, { ...f.binding, requestDigest: 'wrong' }),
  ).rejects.toThrow(/identity/);
});

test('lost response discovers only exact structured correlation; unknown is never absence or replay', async () => {
  const f = await fixture();
  expect((await f.client.spawn(f.run.id, f.binding)).state).toBe('unknown');
  f.setHandler((req) =>
    f.reply(
      req,
      req.params.id
        ? { details: { workflowChildren: f.summary() } }
        : {
            asyncSnapshot: {
              kind: 'pi-subagents.async-status-snapshot',
              version: 1,
              runs: [{ id: 'root', kind: 'workflow' }],
            },
          },
    ),
  );
  expect((await f.client.operation(f.run.id, f.binding)).state).toBe('bound');
  await f.client.spawn(f.run.id, f.binding);
  expect(f.requests.filter((r) => r.method === 'spawn')).toHaveLength(1);
});

test('stop before emit retires locally without launch; foreign control and abandoned writes denied', async () => {
  const f = await fixture();
  f.setSession('foreign');
  await expect(f.client.spawn(f.run.id, f.binding)).rejects.toThrow(/session/);
  await expect(f.client.stop(f.run.id, f.binding)).rejects.toThrow(/session/);
  f.setSession('session');
  expect((await f.client.cancelOperation(f.run.id, f.binding)).state).toBe(
    'retired',
  );
  await f.client.spawn(f.run.id, f.binding);
  expect(f.requests).toHaveLength(0);
  await f.registry.abandon(f.run.id, 'session');
  await expect(f.client.spawn(f.run.id, f.binding)).rejects.toThrow(
    /abandoned/,
  );
});

test('late response binds after stop without overwriting stop intent; queued rejection is retryable', async () => {
  const f = await fixture();
  let launch: Request | undefined;
  f.setHandler((req) => {
    if (req.method === 'spawn') {
      launch = req;
      return;
    }
    if (req.method === 'stop')
      f.bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
        version: 1,
        requestId: req.requestId,
        method: 'stop',
        success: false,
        error: { code: 'invalid_state', message: 'queued' },
      });
    else f.reply(req, { details: { workflowChildren: f.summary() } });
  });
  const spawning = f.client.spawn(f.run.id, f.binding);
  while (!launch) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    stopGeneration: 1,
    activeOperation: { ...required(run.activeOperation), stopRequested: true },
  }));
  f.reply(launch, {
    details: { runId: 'root', workflowChildren: f.summary() },
  });
  await spawning;
  expect((await f.registry.get(f.run.id))?.activeOperation?.stopRequested).toBe(
    true,
  );
  expect((await f.client.stop(f.run.id, f.binding)).stopPending).toBe(true);
  expect(
    (await f.registry.get(f.run.id))?.activeOperation?.stopAcknowledged,
  ).not.toBe(true);
});

test('prepare records unsupported limits honestly and freezes configured agent/model into awaited child', async () => {
  const f = await fixture();
  const prepared = await f.client.prepare(f.run, {
    operationId: 'limits',
    kind: 'implementation',
    agent: 'custom-agent',
    model: 'provider/exact-model',
    task: 'Keep the chosen model',
    executionLifetime: { mode: 'unbounded' },
    maxTurns: 75,
  });
  const meta = required(prepared.native);
  expect(meta.limits).toEqual({
    requestedLifetime: { mode: 'unbounded' },
    requestedMaxTurns: 75,
    childTimeout: 'native-default',
    maxTurnsEnforced: false,
  });
  expect(meta.request.params.timeoutMs).toBeUndefined();
  expect(meta.request.params.script).toContain('return await runs.run("main",');
  expect(meta.request.params.script).toContain('"agent":"custom-agent"');
  expect(meta.request.params.script).toContain(
    '"model":"provider/exact-model"',
  );
  expect(meta.request.params.script).not.toContain('"async":true');
  expect(meta.request.params.script).not.toContain('maxTurns');
});

test('malformed replies and unknown lookups never authorize a second spawn', async () => {
  const f = await fixture();
  f.setHandler((req) =>
    f.bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
      version: 1,
      requestId: 'wrong',
      method: req.method,
      success: true,
      data: {},
    }),
  );
  expect((await f.client.spawn(f.run.id, f.binding)).state).toBe('unknown');
  f.setHandler((req) =>
    f.reply(req, { text: 'Run: fake-id\\nState: complete', details: {} }),
  );
  expect((await f.client.spawn(f.run.id, f.binding)).state).toBe('unknown');
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(1);
  expect((await f.registry.get(f.run.id))?.activeOperation?.native?.phase).toBe(
    'dispatching',
  );
});

test('wrong root, child identity and malformed published proof cannot retire ownership', async () => {
  const f = await fixture();
  f.setHandler((req) =>
    f.reply(req, { details: { workflowChildren: f.summary() } }),
  );
  await f.client.spawn(f.run.id, f.binding);
  for (const details of [
    {
      workflowChildren: { ...f.summary('completed'), workflowRunId: 'foreign' },
    },
    {
      workflowChildren: {
        ...f.summary('completed'),
        children: [{ childId: 'main', runId: 'foreign', state: 'completed' }],
      },
    },
    {
      workflowChildren: f.summary('completed'),
      workflowTerminalProof: {
        version: 1,
        kind: 'workflow',
        state: 'observed',
        runId: 'root',
        dispatchClosed: false,
        observedAt: 1,
        children: [],
      },
    },
  ]) {
    f.setHandler((req) => f.reply(req, { details }));
    expect((await f.client.operation(f.run.id, f.binding)).state).not.toBe(
      'retired',
    );
    expect(
      (await f.registry.get(f.run.id))?.activeOperation?.processTreeExited,
    ).not.toBe(true);
  }
});

test('caller-bound output rejects symlinks before any dispatch', async () => {
  const f = await fixture();
  const outside = join(f.directory, 'outside.txt');
  await writeFile(outside, 'not an operation result');
  await symlink(outside, required(f.op.native).outputPath);
  await expect(f.client.spawn(f.run.id, f.binding)).rejects.toThrow(
    /non-symlink/,
  );
  expect(f.requests).toHaveLength(0);
});

test('prepare refuses an aliased output parent without creating files outside the run', async () => {
  const f = await fixture();
  const outside = join(f.directory, 'outside-directory');
  await mkdir(outside);
  const nativeDirectory = dirname(dirname(required(f.op.native).outputPath));
  await rm(nativeDirectory, { recursive: true });
  await symlink(outside, nativeDirectory);
  await expect(
    f.client.prepare(f.run, {
      operationId: 'other',
      kind: 'implementation',
      agent: 'worker',
      task: 'Do not escape',
    }),
  ).rejects.toThrow(/symlinks/);
  expect(await readdir(outside)).toEqual([]);
});

test('registry rejects changed native request/digest and ownership', async () => {
  const f = await fixture();
  for (const native of [
    { ...required(f.op.native), ownerRunId: 'foreign' },
    {
      ...required(f.op.native),
      request: {
        ...required(f.op.native).request,
        params: { script: 'different' },
      },
    },
    { ...required(f.op.native), phase: 'retired', retirement: 'native-proof' },
  ]) {
    await writeFile(
      f.registry.authorizationPath(f.run.id),
      JSON.stringify({ ...f.run, activeOperation: { ...f.op, native } }),
    );
    await expect(f.registry.get(f.run.id)).rejects.toThrow(/Invalid plan-exec/);
  }
});

test('released public RPC publishes real proof/output with healthy and lost spawn replies', async () => {
  const f = await fixture();
  const sessionFile = join(f.directory, 'parent-session.jsonl');
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent' })}\n`,
  );
  const host = await createNativeRuntimeHost(join(f.directory, 'host'), {
    events: f.bus,
    sessionFile,
  });
  try {
    f.setSession(host.sessionId);
    const emit = f.bus.emit.bind(f.bus);
    for (const dropReply of [false, true]) {
      f.bus.emit = (name, value) => {
        if (
          dropReply &&
          name.startsWith('subagents:rpc:v1:reply:') &&
          (value as { method?: string }).method === 'spawn'
        )
          return;
        emit(name, value);
      };
      const client = new NativeRuntimeClient(
        f.bus,
        f.registry,
        () =>
          ({
            sessionManager: {
              getSessionId: () => host.sessionId,
              getSessionFile: () => sessionFile,
            },
          }) as ExtensionContext,
        { rpcTimeoutMs: dropReply ? 100 : 10_000 },
      );
      onTestFinished(() => client.dispose());
      const op = await client.prepare(f.run, {
        operationId: dropReply ? 'lost-review' : 'real-worker',
        kind: 'implementation',
        agent: dropReply ? 'reviewer' : 'worker',
        task: 'Deliver fixture',
        cwd: host.repository,
        executionLifetime: { mode: 'bounded', timeoutMs: 60_000 },
        maxTurns: 75,
      });
      await f.registry.updateLatest(f.run.id, (run) => ({
        ...run,
        activeOperation: op,
      }));
      const binding = {
        operationId: op.operationId,
        requestDigest: required(op.requestDigest),
      };
      const launched = await client.spawn(f.run.id, binding);
      expect(launched.state, launched.reason).toBe(
        dropReply ? 'unknown' : 'bound',
      );
      let observed = launched;
      for (
        let attempt = 0;
        attempt < 100 && observed.state !== 'retired';
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        observed = await client.operation(f.run.id, binding);
      }
      expect(observed.state, observed.reason).toBe('retired');
      expect(observed.proof?.kind).toBe('workflow');
      expect(observed.operation.native?.observedLimits?.workflowTimeoutMs).toBe(
        60_000,
      );
      expect(await host.calls()).toHaveLength(dropReply ? 2 : 1);
      const result = await client.result(f.run.id, binding);
      expect(result.result?.output, result.reason).toContain(
        dropReply ? 'NO_FINDINGS' : 'Task completed and committed.',
      );
      expect(result.result?.outputPath).toBe(required(op.native).outputPath);
      const statusPath = join(
        required(observed.operation.asyncDir),
        'status.json',
      );
      const originalStatus = await readFile(statusPath, 'utf8');
      const actualStatus = JSON.parse(originalStatus);
      expect(actualStatus.steps).toHaveLength(1);
      expect(typeof actualStatus.steps[0].async).toBe('boolean');
      if (actualStatus.steps[0].async) {
        expect(observed.proof?.children).toHaveLength(1);
        expect(observed.proof?.children[0]?.runId).toBe(
          actualStatus.steps[0].runId,
        );
      } else expect(observed.proof?.children).toHaveLength(0);
      // The exact S25 receipt can recover a successful child without replaying
      // the failed JavaScript wrapper or accepting arbitrary failure output.
      const receiptPath = join(
        required(observed.operation.asyncDir),
        'workflow-receipt.json',
      );
      const receiptText = await readFile(receiptPath, 'utf8');
      const receipt = JSON.parse(receiptText);
      const detached = JSON.parse(originalStatus);
      detached.state = 'failed';
      detached.workflowChildren.workflowState = 'failed';
      delete detached.workflow.value;
      receipt.state = 'failed';
      receipt.workflowResolution = 'settled-awaiting-resume';
      receipt.workflowChildren = detached.workflowChildren;
      await writeFile(statusPath, JSON.stringify(detached));
      await writeFile(receiptPath, JSON.stringify(receipt));
      expect((await client.result(f.run.id, binding)).result?.output).toBe(
        result.result?.output,
      );
      receipt.entries.main.latestRunId = 'foreign-child';
      await writeFile(receiptPath, JSON.stringify(receipt));
      expect((await client.result(f.run.id, binding)).result).toBeUndefined();
      await writeFile(receiptPath, receiptText);
      await writeFile(statusPath, originalStatus);

      const wrongSource = JSON.parse(originalStatus);
      wrongSource.sessionId = 'foreign';
      await writeFile(statusPath, JSON.stringify(wrongSource));
      expect((await client.result(f.run.id, binding)).result).toBeUndefined();
      await writeFile(statusPath, originalStatus);
      await rm(required(op.native).outputPath);
      const outsideOutput = join(f.directory, `outside-${op.operationId}.txt`);
      await writeFile(outsideOutput, 'forged output');
      await symlink(outsideOutput, required(op.native).outputPath);
      expect((await client.result(f.run.id, binding)).result).toBeUndefined();
      const requestsBeforeStop = f.requests.filter(
        (req) => req.method === 'stop',
      ).length;
      expect((await client.stop(f.run.id, binding)).stopPending).toBe(false);
      expect(f.requests.filter((req) => req.method === 'stop')).toHaveLength(
        requestsBeforeStop,
      );
      client.dispose();
    }
  } finally {
    await host.dispose();
  }
}, 30_000);

test('disposal settles pending RPC without permitting replay and removes listeners', async () => {
  const f = await fixture();
  f.setHandler(() => f.client.dispose());
  expect((await f.client.spawn(f.run.id, f.binding)).state).toBe('unknown');
  expect([...f.bus.listeners.keys()]).toEqual(['subagents:rpc:v1:request']);
  await expect(f.client.operation(f.run.id, f.binding)).rejects.toThrow(
    /disposed/,
  );
});

test('native session authority is separate from the controller UUID and immutable', async () => {
  const f = await fixture('/isolated/session.jsonl');
  expect(f.op.native?.ownerSessionId).toBe('session');
  expect(f.op.native?.nativeSessionId).toBe('/isolated/session.jsonl');
  const foreign = new NativeRuntimeClient(
    f.bus,
    f.registry,
    () =>
      ({
        sessionManager: {
          getSessionId: () => 'session',
          getSessionFile: () => '/other/session.jsonl',
        },
      }) as ExtensionContext,
  );
  onTestFinished(() => foreign.dispose());
  await expect(foreign.spawn(f.run.id, f.binding)).rejects.toThrow(/session/);
  expect(f.requests).toHaveLength(0);
  const noFile = await fixture();
  expect(noFile.op.native?.nativeSessionId).toBe('session');
});

function retiredDetails(summary: unknown) {
  return {
    workflowChildren: summary,
    workflowTerminalProof: {
      version: 1,
      kind: 'workflow',
      state: 'observed',
      runId: 'root',
      dispatchClosed: true,
      observedAt: Date.now(),
      children: [],
    },
  };
}

test('abandoned observation and stop are read-only and inspect retirement before delivery', async () => {
  const f = await fixture();
  f.setHandler((req) =>
    f.reply(req, { details: { workflowChildren: f.summary() } }),
  );
  await f.client.spawn(f.run.id, f.binding);
  await f.registry.abandon(f.run.id, 'session');
  const before = await readFile(f.registry.authorizationPath(f.run.id), 'utf8');
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'root',
      sessionId: 'session',
      toolCallId: `rpc-spawn-${required(f.op.native).request.requestId}`,
      workflowChildren: f.summary('completed'),
      steps: [
        {
          runId: 'child',
          workflowKey: 'main',
          async: false,
          status: 'completed',
        },
      ],
    }),
  );
  f.setHandler((req) =>
    f.reply(req, {
      details: { ...retiredDetails(f.summary('completed')), asyncDir },
    }),
  );
  expect((await f.client.stopAbandoned(f.run.id, f.binding)).state).toBe(
    'retired',
  );
  expect(f.requests.filter((req) => req.method === 'stop')).toHaveLength(0);
  expect(await readFile(f.registry.authorizationPath(f.run.id), 'utf8')).toBe(
    before,
  );
  await expect(f.client.operation(f.run.id, f.binding)).rejects.toThrow(
    /abandoned/,
  );
  expect((await f.registry.get(f.run.id))?.status).toBe('abandoned');
});

test('abandoned stop refusal stays pending, foreign control refuses, and prepared operations never emit', async () => {
  const f = await fixture();
  f.setHandler((req) =>
    f.reply(req, { details: { workflowChildren: f.summary() } }),
  );
  await f.client.spawn(f.run.id, f.binding);
  await f.registry.abandon(f.run.id, 'session');
  const before = await readFile(f.registry.authorizationPath(f.run.id), 'utf8');
  f.setHandler((req) => {
    if (req.method !== 'stop')
      return f.reply(req, { details: { workflowChildren: f.summary() } });
    f.bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
      version: 1,
      requestId: req.requestId,
      method: 'stop',
      success: false,
      error: { code: 'invalid_state', message: 'queued workflow' },
    });
  });
  expect((await f.client.stopAbandoned(f.run.id, f.binding)).stopPending).toBe(
    true,
  );
  expect(f.requests.filter((req) => req.method === 'stop')).toHaveLength(1);
  f.setSession('foreign');
  await expect(f.client.stopAbandoned(f.run.id, f.binding)).rejects.toThrow(
    /session/,
  );
  expect(f.requests.filter((req) => req.method === 'stop')).toHaveLength(1);
  expect(await readFile(f.registry.authorizationPath(f.run.id), 'utf8')).toBe(
    before,
  );
  const prepared = await fixture();
  await prepared.registry.abandon(prepared.run.id, 'session');
  expect(
    (await prepared.client.stopAbandoned(prepared.run.id, prepared.binding))
      .operation.launchFenced,
  ).toBe(true);
  expect(prepared.requests).toHaveLength(0);
});

test('unbound recovery targets only its persisted request alias, never snapshot candidates', async () => {
  const f = await fixture();
  await f.client.spawn(f.run.id, f.binding);
  const alias = `rpc-spawn-${required(f.op.native).request.requestId}`;
  f.setHandler((req) => {
    expect(req.method).toBe('status');
    expect(req.params).toEqual({ id: alias });
    f.reply(req, { details: { workflowChildren: f.summary() } });
  });
  expect(
    (await f.client.operation(f.run.id, f.binding)).operation.externalRunId,
  ).toBe('root');
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(1);
});

test('correlated completion retains binding after lost reply without replay or late abandoned writes', async () => {
  const f = await fixture();
  await f.client.spawn(f.run.id, f.binding);
  const completed = {
    sessionId: 'session',
    runId: 'root',
    workflowChildren: f.summary('completed'),
  };
  f.bus.emit('subagent:async-complete', { ...completed, sessionId: 'foreign' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    (await f.registry.get(f.run.id))?.activeOperation?.externalRunId,
  ).toBeUndefined();
  f.bus.emit('subagent:async-complete', completed);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await f.registry.get(f.run.id))?.activeOperation?.externalRunId) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await f.registry.get(f.run.id))?.activeOperation?.externalRunId).toBe(
    'root',
  );
  // A completion notification binds identity only; it is not retirement evidence.
  expect(
    (await f.registry.get(f.run.id))?.activeOperation?.processTreeExited,
  ).not.toBe(true);
  await f.registry.abandon(f.run.id, 'session');
  const before = await readFile(f.registry.authorizationPath(f.run.id), 'utf8');
  f.bus.emit('subagent:async-complete', {
    ...completed,
    ...retiredDetails(f.summary('completed')),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await readFile(f.registry.authorizationPath(f.run.id), 'utf8')).toBe(
    before,
  );
  f.client.dispose();
  expect(f.bus.listeners.has('subagent:async-complete')).toBe(false);
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(1);
});

test('actual async child classification requires its exact nonempty proof roster', async () => {
  const f = await fixture();
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  const source = {
    runId: 'root',
    sessionId: 'session',
    toolCallId: `rpc-spawn-${required(f.op.native).request.requestId}`,
    workflowChildren: f.summary('completed'),
    steps: [
      { runId: 'child', workflowKey: 'main', async: true, status: 'completed' },
    ],
  };
  await writeFile(join(asyncDir, 'status.json'), JSON.stringify(source));
  const details = { ...retiredDetails(source.workflowChildren), asyncDir };
  f.setHandler((req) => f.reply(req, { details }));
  expect((await f.client.spawn(f.run.id, f.binding)).state).toBe('bound');
  expect((await f.client.operation(f.run.id, f.binding)).state).toBe('bound');
  const proof = {
    version: 1,
    state: 'observed',
    runId: 'child',
    runnerProcessInstanceId: 'actual-child',
    observedAt: Date.now(),
    instances: [],
  };
  f.setHandler((req) =>
    f.reply(req, {
      details: {
        ...details,
        workflowTerminalProof: {
          ...details.workflowTerminalProof,
          children: [proof],
        },
      },
    }),
  );
  expect((await f.client.operation(f.run.id, f.binding)).state).toBe('retired');
});

test('native controller force-stop abandons before provider calls and cannot revive', async () => {
  const { PlanExecController } = await import('../src/controller.js');
  const f = await fixture();
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  const source = {
    runId: 'root',
    sessionId: 'session',
    toolCallId: `rpc-spawn-${required(f.op.native).request.requestId}`,
    workflowChildren: f.summary(),
    steps: [
      { runId: 'child', workflowKey: 'main', async: false, status: 'running' },
    ],
  };
  await writeFile(join(asyncDir, 'status.json'), JSON.stringify(source));
  let retired = false;
  let stoppedAfterAbandon = false;
  f.setHandler(async (req) => {
    if (req.method === 'stop') {
      expect((await f.registry.get(f.run.id))?.status).toBe('abandoned');
      expect(
        await readFile(f.registry.abandonmentBackupPath(f.run.id), 'utf8'),
      ).toContain(f.run.id);
      stoppedAfterAbandon = true;
      retired = true;
      source.workflowChildren = f.summary('completed');
      required(source.steps[0]).status = 'completed';
      await writeFile(join(asyncDir, 'status.json'), JSON.stringify(source));
      f.reply(req, { runId: 'root', state: 'stopping' });
      return;
    }
    f.reply(req, {
      details: {
        asyncDir,
        ...(retired
          ? retiredDetails(f.summary('completed'))
          : { workflowChildren: f.summary() }),
      },
    });
  });
  await f.client.spawn(f.run.id, f.binding);
  const refuse = async () => {
    throw new Error('No Fusion allowed');
  };
  const controller = new PlanExecController(
    f.registry,
    f.client,
    {
      start: refuse,
      status: refuse,
      result: refuse,
      adopt: refuse,
      cancel: refuse,
    },
    async () => ({ code: 0, stdout: '', stderr: '' }),
  );
  const stopped = await controller.forceStop(f.run.id, 'session');
  expect(stoppedAfterAbandon).toBe(true);
  expect(stopped.run.status).toBe('abandoned');
  expect(stopped.run.activeOperation?.processTreeExited).toBe(true);
  const spawnCount = f.requests.filter((req) => req.method === 'spawn').length;
  await expect(f.client.spawn(f.run.id, f.binding)).rejects.toThrow();
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(
    spawnCount,
  );
});

test('legacy observation and same-session stop retain the original digest without dispatch', async () => {
  const f = await fixture();
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'root',
      sessionId: 'session',
      state: 'running',
      steps: [{ runId: 'child', async: false }],
    }),
  );
  const original = {
    operationId: 'legacy',
    service: 'bridge' as const,
    kind: 'implementation' as const,
    requestDigest: 'original-digest',
    params: { immutable: 'original' },
    externalRunId: 'root',
    asyncDir,
  };
  await f.registry.update({ ...f.run, activeOperation: original });
  const binding = { operationId: 'legacy', requestDigest: 'original-digest' };
  f.setHandler((req) =>
    f.reply(
      req,
      req.method === 'stop'
        ? { runId: 'root', state: 'stopping' }
        : { details: { workflowChildren: f.summary() } },
    ),
  );
  expect((await f.client.observeLegacy(f.run.id, binding)).retired).toBe(false);
  expect((await f.client.stopLegacy(f.run.id, binding)).reason).toMatch(
    /retirement still unobserved/,
  );
  f.setSession('other-session');
  await expect(f.client.stopLegacy(f.run.id, binding)).rejects.toThrow(
    /session/,
  );
  expect((await f.registry.get(f.run.id))?.activeOperation).toEqual(original);
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(0);
  expect(f.requests.filter((req) => req.method === 'stop')).toHaveLength(1);
});

test('no-child failed workflow can retire but never supply task success', async () => {
  const f = await fixture();
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  const summary = { ...f.summary('failed'), children: [] };
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'root',
      sessionId: 'session',
      toolCallId: `rpc-spawn-${required(f.op.native).request.requestId}`,
      workflowChildren: summary,
      state: 'failed',
      steps: [],
    }),
  );
  f.setHandler((req) =>
    f.reply(req, { details: { ...retiredDetails(summary), asyncDir } }),
  );
  expect((await f.client.spawn(f.run.id, f.binding)).state).toBe('retired');
  expect((await f.client.result(f.run.id, f.binding)).result).toBeUndefined();
});

test('bound historical native ID without a digest is observed read-only, while unbound identity stays fenced', async () => {
  const f = await fixture();
  const op = {
    operationId: 'historical',
    service: 'bridge' as const,
    kind: 'implementation' as const,
    externalRunId: 'leaf',
  };
  await f.registry.update({ ...f.run, activeOperation: op });
  f.setHandler((req) =>
    f.reply(req, {
      details: {
        processTerminalProof: {
          version: 1,
          runId: 'leaf',
          state: 'observed',
          runnerProcessInstanceId: 'leaf-instance',
          instances: [],
          observedAt: Date.now(),
        },
      },
    }),
  );
  const before = await readFile(f.registry.authorizationPath(f.run.id), 'utf8');
  expect(
    (await f.client.observeLegacy(f.run.id, { operationId: op.operationId }))
      .retired,
  ).toBe(true);
  expect(await readFile(f.registry.authorizationPath(f.run.id), 'utf8')).toBe(
    before,
  );
  await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    activeOperation: {
      operationId: op.operationId,
      service: 'bridge',
      kind: 'implementation',
    },
  }));
  const count = f.requests.length;
  expect(
    (await f.client.observeLegacy(f.run.id, { operationId: op.operationId }))
      .retired,
  ).toBe(false);
  expect(f.requests).toHaveLength(count);
});

test('native controller pause observes exact retirement without accepting output or relaunching', async () => {
  const { PlanExecController } = await import('../src/controller.js');
  const f = await fixture();
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  let stopped = false;
  const source = {
    runId: 'root',
    sessionId: 'session',
    toolCallId: `rpc-spawn-${required(f.op.native).request.requestId}`,
    workflowChildren: f.summary(),
    steps: [
      { runId: 'child', workflowKey: 'main', async: false, status: 'running' },
    ],
  };
  await writeFile(join(asyncDir, 'status.json'), JSON.stringify(source));
  f.setHandler(async (req) => {
    if (req.method === 'stop') {
      stopped = true;
      source.workflowChildren = f.summary('completed');
      required(source.steps[0]).status = 'completed';
      await writeFile(join(asyncDir, 'status.json'), JSON.stringify(source));
      f.reply(req, { runId: 'root', state: 'stopping' });
    } else
      f.reply(req, {
        details: {
          asyncDir,
          ...(stopped
            ? retiredDetails(source.workflowChildren)
            : { workflowChildren: source.workflowChildren }),
        },
      });
  });
  await f.client.spawn(f.run.id, f.binding);
  await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    status: 'paused',
    userStopped: true,
    stopGeneration: 1,
  }));
  const refuse = async () => {
    throw new Error('Pause cannot run workspace commands or Fusion');
  };
  const controller = new PlanExecController(
    f.registry,
    f.client,
    {
      start: refuse,
      status: refuse,
      result: refuse,
      adopt: refuse,
      cancel: refuse,
    },
    refuse,
  );
  const paused = await controller.tick(f.run.id, 'session');
  expect(paused.status).toBe('paused');
  expect(paused.userStopped).toBe(true);
  expect(paused.activeOperation?.processTreeExited).toBe(true);
  expect(paused.stage).toBe('implementation');
  await controller.tick(f.run.id, 'session');
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(1);
  await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    status: 'cancel_pending',
  }));
  expect((await controller.tick(f.run.id, 'session')).status).toBe('cancelled');
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(1);
});

test('cancellation recovery binds a lost launch but cannot consume a successful review or revive the run', async () => {
  const { PlanExecController } = await import('../src/controller.js');
  const f = await fixture();
  const op = await f.client.prepare(f.run, {
    operationId: 'review',
    kind: 'review',
    agent: 'reviewer',
    task: 'Review only',
    reviewedCommit: 'a'.repeat(40),
  });
  await f.registry.update({
    ...f.run,
    stage: 'comprehensive_review',
    activeOperation: op,
  });
  const binding = {
    operationId: op.operationId,
    requestDigest: required(op.requestDigest),
  };
  await f.client.spawn(f.run.id, binding); // Lost reply, dispatch remains fenced.
  const asyncDir = join(f.directory, 'root');
  await mkdir(asyncDir);
  const summary = {
    ...f.summary('completed'),
    parentToolCallId: `rpc-spawn-${required(op.native).request.requestId}`,
  };
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'root',
      sessionId: 'session',
      toolCallId: summary.parentToolCallId,
      workflowChildren: summary,
      state: 'complete',
      steps: [
        {
          runId: 'child',
          workflowKey: 'main',
          async: false,
          status: 'completed',
        },
      ],
    }),
  );
  let observations = 0;
  f.setHandler((req) => {
    observations++;
    if (observations === 1) {
      f.bus.emit(`subagents:rpc:v1:reply:${req.requestId}`, {
        version: 1,
        requestId: req.requestId,
        method: req.method,
        success: false,
        error: { code: 'not_found', message: 'Temporarily unavailable' },
      });
    } else f.reply(req, { details: { ...retiredDetails(summary), asyncDir } });
  });
  await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    status: 'cancel_pending',
    userStopped: true,
    stopGeneration: 1,
  }));
  const refuse = async () => {
    throw new Error('Cancellation cannot verify or accept a review');
  };
  const controller = new PlanExecController(
    f.registry,
    f.client,
    {
      start: refuse,
      status: refuse,
      result: refuse,
      adopt: refuse,
      cancel: refuse,
    },
    refuse,
  );
  const pending = await controller.tick(f.run.id, 'session');
  expect(pending.status).toBe('cancel_pending');
  expect(pending.stage).toBe('comprehensive_review');
  expect(pending.activeOperation?.externalRunId).toBe('root');
  expect(pending.reviewedCommit).toBeUndefined();
  await f.registry.updateLatest(f.run.id, (run) => ({
    ...run,
    nextAttemptAt: 0,
  }));
  expect((await controller.tick(f.run.id, 'session')).status).toBe('cancelled');
  expect(f.requests.filter((req) => req.method === 'spawn')).toHaveLength(1);
});

test('native request digest binds controller task, review iteration and candidate before dispatch', async () => {
  const f = await fixture();
  const op = await f.client.prepare(f.run, {
    operationId: 'bound-review',
    kind: 'review',
    agent: 'reviewer',
    task: 'Review task two',
    taskId: 2,
    reviewIteration: 3,
    reviewedCommit: 'a'.repeat(40),
  });
  await f.registry.update({
    ...f.run,
    stage: 'comprehensive_review',
    activeOperation: op,
  });
  for (const change of [
    { taskId: 4 },
    { reviewIteration: 5 },
    { reviewedCommit: 'b'.repeat(40) },
  ]) {
    await expect(
      f.registry.update({
        ...required(await f.registry.get(f.run.id)),
        activeOperation: { ...op, ...change },
      }),
    ).rejects.toThrow();
  }
  expect(f.requests).toHaveLength(0);
});
