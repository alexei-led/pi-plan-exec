import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import {
  createNativeRuntimeHost,
  nativeFixtureFactoryModulePath,
} from './fixtures/native-runtime-host.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function stopRequests(asyncDir: string): Promise<string[]> {
  return readdir(join(asyncDir, 'control', 'stop-requests'));
}

function rpcReply(result: {
  requestId: string;
  delivered: boolean;
  reply?: unknown;
}): Record<string, unknown> {
  expect(result.delivered).toBe(true);
  const reply = record(result.reply);
  expect(reply?.version).toBe(1);
  expect(reply?.requestId).toBe(result.requestId);
  return reply ?? {};
}

let sandbox: string | undefined;
let host: Awaited<ReturnType<typeof createNativeRuntimeHost>> | undefined;
let passed = false;

afterAll(async () => {
  await host?.dispose();
  if (sandbox && passed) await rm(sandbox, { recursive: true, force: true });
  else if (sandbox)
    console.error(`Retained native contract sandbox: ${sandbox}`);
});

test('fixture setup restores process state and disposes partial native registrations', async () => {
  const setupRoot = await mkdtemp(join(tmpdir(), 'pi-plan-exec-native-setup-'));
  const savedEnvironment = { ...process.env };
  const savedHomeFunction = os.homedir;
  const fixtureUrl = new URL(
    './fixtures/native-runtime-host.ts',
    import.meta.url,
  );
  const script = `
    import assert from 'node:assert/strict';
    import os from 'node:os';
    import { createNativeRuntimeHost, nativeFixtureFactoryModulePath }
      from ${JSON.stringify(fixtureUrl.href)};
    const saved = { ...process.env };
    const home = os.homedir;
    const listeners = new Map();
    const events = {
      on(name, handler) {
        const handlers = listeners.get(name) ?? new Set();
        handlers.add(handler);
        listeners.set(name, handlers);
        return () => {
          handlers.delete(handler);
          if (handlers.size === 0) listeners.delete(name);
        };
      },
      emit(name, payload) {
        for (const handler of [...(listeners.get(name) ?? [])]) handler(payload);
      },
    };
    await assert.rejects(
      createNativeRuntimeHost(process.argv[1], { events, failAfterRegistration: true }),
      /Fixture setup fault after native registration/,
    );
    assert.ok(JSON.stringify(process.env) === JSON.stringify(saved), 'environment restored');
    assert.equal(os.homedir, home);
    assert.equal(listeners.size, 0);
    assert.equal(nativeFixtureFactoryModulePath(), undefined);
  `;
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, setupRoot],
      {
        timeout: 30_000,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: setupRoot,
          TMPDIR: tmpdir(),
        },
      },
    );
    expect(
      JSON.stringify(process.env) === JSON.stringify(savedEnvironment),
    ).toBe(true);
    expect(os.homedir).toBe(savedHomeFunction);
    expect(nativeFixtureFactoryModulePath()).toBeUndefined();
  } finally {
    await rm(setupRoot, { recursive: true, force: true });
  }
});

test('released public RPC characterizes rejection, stop parity, ownership, and missing proof', async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'pi-plan-exec-native-contract-'));
  host = await createNativeRuntimeHost(sandbox);
  expect(host.asyncDirRoot).toBe(
    join(sandbox, 'native-temp', 'async-subagent-runs'),
  );
  expect(host.resultsDir).toBe(
    join(sandbox, 'native-temp', 'async-subagent-results'),
  );

  const ping = rpcReply(await host.rpc('ping'));
  expect(ping.success).toBe(true);
  expect(record(ping.data)?.version).toBe(1);
  expect(record(record(ping.data)?.capabilities)?.asyncSpawn).toBe(true);
  expect(record(record(ping.data)?.capabilities)?.processTerminalProof).toEqual(
    {
      version: 1,
      lifecycleArtifactVersion: 3,
    },
  );

  const nonStart = rpcReply(
    await host.rpc('spawn', {
      agent: 'worker',
      task: 'This launch must be rejected before dispatch.',
      async: false,
      cwd: host.repository,
      context: 'fresh',
      worktree: false,
    }),
  );
  expect(nonStart.success).toBe(false);
  expect(record(nonStart.error)?.code).toBe('invalid_params');
  expect(record(nonStart.error)?.message).toContain('detached async launches');
  expect(await host.calls()).toHaveLength(0);

  const queuedRunId = `fixture-queued-${Date.now()}`;
  const queuedDir = await host.seedStatus({
    runId: queuedRunId,
    state: 'queued',
  });
  const rpcQueuedStop = rpcReply(await host.rpc('stop', { id: queuedRunId }));
  expect(rpcQueuedStop.success).toBe(false);
  expect(record(rpcQueuedStop.error)?.code).toBe('invalid_state');

  const toolQueuedStop = record(
    await host.executeTool({ action: 'stop', id: queuedRunId }),
  );
  expect(toolQueuedStop?.isError).not.toBe(true);
  await access(join(queuedDir, 'control', 'stop-requests'));
  expect(await stopRequests(queuedDir)).toHaveLength(1);

  const runningRunId = `fixture-running-${Date.now()}`;
  const runningDir = await host.seedStatus({
    runId: runningRunId,
    state: 'running',
    runnerProcessInstanceId: `fixture-runner-${Date.now()}`,
  });
  const rpcRunningStop = rpcReply(await host.rpc('stop', { id: runningRunId }));
  expect(rpcRunningStop.success).toBe(true);
  expect(record(rpcRunningStop.data)?.state).toBe('stopping');
  const stopRequestBeforeForeignAttempt = await stopRequests(runningDir);
  expect(stopRequestBeforeForeignAttempt).toHaveLength(1);

  const ownerSessionId = host.sessionId;
  host.setSessionId('foreign-session-fixture');
  const foreignStop = rpcReply(await host.rpc('stop', { id: runningRunId }));
  expect(foreignStop.success).toBe(false);
  expect(record(foreignStop.error)?.code).toBe('not_found');
  expect(await stopRequests(runningDir)).toEqual(
    stopRequestBeforeForeignAttempt,
  );
  host.setSessionId(ownerSessionId);

  const pausedRunId = `fixture-paused-${Date.now()}`;
  const pausedDir = await host.seedStatus({
    runId: pausedRunId,
    state: 'paused',
    runnerProcessInstanceId: `fixture-runner-${Date.now()}`,
  });
  const rpcPausedStop = rpcReply(await host.rpc('stop', { id: pausedRunId }));
  expect(rpcPausedStop.success).toBe(false);
  expect(record(rpcPausedStop.error)?.code).toBe('invalid_state');

  const toolPausedStop = record(
    await host.executeTool({ action: 'stop', id: pausedRunId }),
  );
  expect(toolPausedStop?.isError).toBe(true);
  const toolText = Array.isArray(toolPausedStop?.content)
    ? toolPausedStop.content
        .map((part) => record(part)?.text)
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
    : '';
  expect(toolText).toContain('process-terminal proof is missing');
  await access(join(pausedDir, 'control', 'stop-requests'));
  expect(await stopRequests(pausedDir)).toHaveLength(1);
  await expect(
    access(join(pausedDir, 'process-terminal.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });

  const unsupportedControls = rpcReply(
    await host.rpc('spawn', {
      agent: 'missing-native-contract-fixture-agent',
      task: 'Characterize unknown lifetime fields before any child can start.',
      executionLifetime: { mode: 'unbounded' },
      cwd: host.repository,
      context: 'fresh',
      worktree: false,
    }),
  );
  expect(unsupportedControls.success).toBe(false);
  expect(record(unsupportedControls.error)?.code).toBe('execution_failed');
  expect(record(unsupportedControls.error)?.message).toMatch(/agent/i);
  expect(record(unsupportedControls.error)?.message).not.toContain(
    'executionLifetime',
  );
  expect(await host.calls()).toHaveLength(0);

  passed = true;
});
