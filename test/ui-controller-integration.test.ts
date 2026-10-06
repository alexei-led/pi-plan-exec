import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { onTestFinished, test, vi } from 'vitest';
import planExecExtension from '../src/index.js';
import { RunRegistry } from '../src/registry.js';
import { required } from '../src/required.js';
import { PlanExecRuntimeIntegration } from '../src/runtime-integration.js';
import {
  DEFAULT_FROZEN_RUN_CONFIG,
  type PlanExecRun,
  RUN_STAGE,
  RUN_STATUS,
} from '../src/types.js';

test('background recovery keeps ticking through UI failure and pending Fleet publication', async (_t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'exec-ui-controller-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'plan.md'), '### Task 1: Work\n- [ ] Work\n');
  const registry = new RunRegistry(join(cwd, 'runs'));
  const progressPath = join(cwd, 'progress.txt');
  await writeFile(progressPath, '');
  const sessionId = 'session-ui-controller-integration';
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: cwd,
    planPath: `${cwd}/plan.md`,
    planHash: 'plan-hash',
    worktreeCwd: cwd,
    branch: 'feature',
    defaultBranch: 'main',
    status: RUN_STATUS.RUNNING,
    stage: RUN_STAGE.RESOLVE,
    progressPath,
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    skippedStages: [],
    branchRebindings: [],
    ownerSessionId: sessionId,
    config: DEFAULT_FROZEN_RUN_CONFIG,
  });
  // Redirect the extension's default registry to real, isolated files.
  for (const method of [
    'get',
    'listWithErrors',
    'claim',
    'updateIfCurrent',
    'withControllerLock',
    'release',
  ] as const) {
    const implementation = RunRegistry.prototype[method];
    vi.spyOn(RunRegistry.prototype, method).mockImplementation(
      implementation.bind(registry) as never,
    );
  }
  let releaseRuntime!: () => void;
  const pendingRuntime = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  onTestFinished(() => releaseRuntime());
  const published: PlanExecRun[] = [];
  vi.spyOn(PlanExecRuntimeIntegration.prototype, 'sync').mockImplementation(
    async (current) => {
      published.push(current);
      await pendingRuntime;
    },
  );
  const events = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void>
  >();
  let statusCalls = 0;
  let statusFailures = 0;
  let widgetCalls = 0;
  let widgetFailures = 0;
  let notifyCalls = 0;
  const pi = {
    events: { on() {}, emit() {} },
    on(event: string, handler: unknown) {
      events.set(
        event,
        handler as (event: unknown, ctx: ExtensionContext) => Promise<void>,
      );
    },
    registerCommand() {},
    registerTool() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    async exec(_command: string, args: string[]) {
      return {
        stdout: args.includes('--show-current') ? 'feature\n' : `${cwd}\n`,
        stderr: '',
        code: 0,
      };
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const childRole = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    planExecExtension(pi);
  } finally {
    if (childRole !== undefined) process.env.PI_SUBAGENT_CHILD = childRole;
  }
  const context = {
    cwd,
    mode: 'rpc',
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus() {
        statusCalls += 1;
        if (statusCalls === 1) {
          statusFailures += 1;
          throw new Error('UI closed');
        }
      },
      setWidget() {
        widgetCalls += 1;
        if (widgetCalls === 2) {
          widgetFailures += 1;
          throw new Error('UI closed');
        }
      },
      notify(message: string) {
        void message;
        notifyCalls += 1;
        throw new Error('UI closed');
      },
    },
  } as unknown as ExtensionContext;

  vi.useFakeTimers({ toFake: ['setInterval'] });
  onTestFinished(async () => {
    await events.get('session_shutdown')?.({}, context);
  });
  await events.get('session_start')?.({}, context);
  async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await predicate()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('Controller did not settle');
  }
  for (const stage of [
    RUN_STAGE.PROJECT_TASKS,
    RUN_STAGE.BRANCH,
    RUN_STAGE.PROGRESS,
  ]) {
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(async () => (await registry.get(run.id))?.stage === stage);
    await waitFor(async () =>
      published.some((current) => current.stage === stage),
    );
  }
  assert.equal(statusFailures, 1);
  assert.equal(widgetFailures, 1);
  assert.equal(widgetCalls >= 3, true);
  assert.equal(statusCalls >= 2, true);
  assert.equal(notifyCalls >= 2, true);
  assert.match(await readFile(progressPath, 'utf8'), /Execution branch ready/);
  const current = required(await registry.get(run.id));
  await registry.update({ ...current, status: RUN_STATUS.CANCEL_PENDING });
  await vi.advanceTimersByTimeAsync(1_000);
  await waitFor(
    async () => (await registry.get(run.id))?.status === RUN_STATUS.CANCELLED,
  );
  await waitFor(async () =>
    published.some((current) => current.status === RUN_STATUS.CANCELLED),
  );
  releaseRuntime();
  await events.get('session_shutdown')?.({}, context);
});
