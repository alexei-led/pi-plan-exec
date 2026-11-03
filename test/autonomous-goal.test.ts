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
import { onTestFinished, type TestContext, test } from 'vitest';
import { executionRequestDigest } from '../src/execution-contract.js';
import type { RunCommand } from '../src/git.js';
import { normalizeCheckOutput, parseGoalOutcome } from '../src/goal-loop.js';
import {
  formatRunStatus,
  formatRunWidget,
  goalStatusText,
  parseGoalChecks,
  parseGoalCommand,
} from '../src/index.js';
import { LocalOperationFailedError } from '../src/local-operation.js';
import { RunRegistry } from '../src/registry.js';
import type { ExecutionLifetime, PlanExecRun } from '../src/types.js';
import { createControllerLocalExecutor } from './fixtures/controller-local-executor.js';
import type { BridgeResult } from './fixtures/legacy-types.js';
import { PlanExecController } from './fixtures/native-controller.js';

const execute = promisify(execFile);
const command: RunCommand = async (program, args, cwd) => {
  try {
    const result = await execute(program, args, { cwd });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code ?? 1,
    };
  }
};
const ok = (data: Record<string, unknown>): BridgeResult => ({
  success: true,
  data,
});

function observedWorkerProof(id: string, digest: string) {
  return {
    version: 1,
    state: 'observed',
    runId: id,
    runnerProcessInstanceId: 'fixture',
    observedAt: Date.now(),
    callerBinding: { operationId: id, requestDigest: digest },
    instances: [],
  };
}

class GoalWorker {
  launches: { id: string; params: Record<string, unknown> }[] = [];
  output = '';
  state = 'running';
  proof = false;
  available = true;
  terminationReason?: 'execution_lifetime_expired';
  constructor(readonly resultPath: string) {}
  async capabilities() {
    return {
      protocolVersion: 2 as const,
      healthy: this.available,
      workflowScriptSpawn: true,
      singleAgentSpawn: true,
      durableOperationLookup: true,
      processTerminalProofVersion: 1,
      executionLifetimeVersion: 1 as const,
      executionLifetimeModes: ['unbounded' as const, 'bounded' as const],
      processTreeOwnership: {
        version: 1 as const,
        scope: 'owned-process-tree' as const,
        escapedDescendants: 'contained' as const,
      },
    };
  }
  async spawn(
    id: string,
    params: Record<string, unknown>,
  ): Promise<BridgeResult> {
    if (!this.launches.some((item) => item.id === id))
      this.launches.push({ id, params });
    return ok({
      runId: id,
      requestDigest: executionRequestDigest(params),
      effectiveExecutionLifetime: params.executionLifetime,
    });
  }
  async operation(id: string): Promise<BridgeResult> {
    const launch = this.launches.find((item) => item.id === id);
    return ok(
      launch
        ? {
            state: 'found',
            runId: id,
            requestDigest: executionRequestDigest(launch.params),
            effectiveExecutionLifetime: launch.params.executionLifetime,
          }
        : { state: 'unknown' },
    );
  }
  async status(id: string): Promise<BridgeResult> {
    const launch = this.launches.find((item) => item.id === id);
    return ok({
      state: this.state,
      ...(this.terminationReason
        ? { terminationReason: this.terminationReason }
        : {}),
      ...(this.proof
        ? {
            processTerminalProof: observedWorkerProof(
              id,
              executionRequestDigest(launch?.params ?? {}),
            ),
          }
        : {}),
    });
  }
  async result() {
    await writeFile(this.resultPath, JSON.stringify({ result: this.output }));
    return ok({ resultPath: this.resultPath });
  }
  async adopt() {
    return ok({});
  }
  async stop(runId = this.launches.at(-1)?.id) {
    return ok({ state: 'stopping', runId });
  }
}
const fusion = {
  start: async () => ok({}),
  status: async () => ok({}),
  result: async () => ok({}),
  adopt: async () => ok({}),
  cancel: async () => ok({}),
};

const CHECK = [['test', '-f', 'done.txt']];

async function fixture(_t: TestContext, executionLifetime?: ExecutionLifetime) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'autonomous-goal-')),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => {
    const result = await command('git', args, root);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.test');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgSign', 'false');
  await git('config', 'core.hooksPath', '/dev/null');
  await mkdir(join(root, '.pi'), { recursive: true });
  await writeFile(
    join(root, '.pi', 'plan-exec.json'),
    JSON.stringify({
      reviewEnabled: false,
      reviewRequired: false,
      retryDelayMs: 10,
      maxTaskIterations: 20,
      ...(executionLifetime ? { executionLifetime } : {}),
    }),
  );
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(
    join(root, 'tests', 'sample.test.ts'),
    "test('ok', () => {});\n",
  );
  await git('add', '--all');
  await git('commit', '-m', 'baseline');
  await git('checkout', '-b', 'feature');
  const registry = new RunRegistry(join(root, '.git', 'runs'));
  const worker = new GoalWorker(join(root, '.git', 'goal-result.json'));
  const controller = new PlanExecController(
    registry,
    worker,
    fusion,
    command,
    createControllerLocalExecutor(),
  );
  return { root, git, registry, worker, controller };
}

async function start(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<PlanExecRun> {
  return f.controller.startGoal({
    goal: 'Fix the failing tests',
    sessionId: 'session',
    cwd: f.root,
    checks: CHECK,
  });
}

async function finishTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  run: PlanExecRun,
  output: string,
): Promise<PlanExecRun> {
  f.worker.state = 'complete';
  f.worker.proof = true;
  f.worker.output = output;
  return f.controller.tick(run.id, 'session');
}

async function due(
  f: Awaited<ReturnType<typeof fixture>>,
  run: PlanExecRun,
): Promise<PlanExecRun> {
  return f.registry.update({ ...run, nextAttemptAt: 0 });
}

async function advanceToCompletion(
  f: Awaited<ReturnType<typeof fixture>>,
  run: PlanExecRun,
): Promise<PlanExecRun> {
  let current = run;
  for (let step = 0; step < 8 && current.status !== 'completed'; step += 1)
    current = await f.controller.tick(current.id, 'session');
  return current;
}

test('a goal continues after an intermediate answer and completes when checks pass', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  assert.equal(run.goal?.iteration, 1);
  assert.match(
    String(f.worker.launches[0]?.params.task),
    /Fix the failing tests/,
  );

  run = await finishTurn(
    f,
    run,
    'Investigated the repository; tests still fail.',
  );
  assert.equal(run.status, 'running');
  assert.equal(run.activeOperation, undefined);
  assert.equal(run.goal?.iteration, 1);

  run = await f.controller.tick((await due(f, run)).id, 'session');
  assert.equal(
    f.worker.launches.length,
    2,
    'the goal must continue without another user action',
  );

  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'fix failing tests');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nAll tests pass.');
  assert.equal(run.stage, 'finalize');
  assert.equal(run.status, 'running');

  run = await advanceToCompletion(f, run);
  assert.equal(
    run.status,
    'completed',
    JSON.stringify({
      stage: run.stage,
      error: run.error,
      wake: run.wakeReason,
      op: run.activeOperation?.kind,
    }),
  );
  assert.equal(run.goal?.iteration, 2);
  assert.equal(await readFile(join(f.root, 'done.txt'), 'utf8'), 'fixed\n');
});

test('a goal that claims done with failing checks continues instead of completing', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nI fixed it.');
  assert.notEqual(run.status, 'completed');
  assert.equal(run.goal?.iteration, 1);
  assert.match(run.goal?.lastOutcome ?? '', /required checks failed/i);

  run = await f.controller.tick((await due(f, run)).id, 'session');
  assert.equal(run.goal?.iteration, 2);
  assert.match(
    String(f.worker.launches[1]?.params.task),
    /Required checks are failing/,
  );
});

test('a verified goal can complete after unchanged verification-only turns', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'fix failing tests');
  run = await finishTurn(f, run, 'Implementation finished; verifying next.');
  assert.ok(run.goal);
  run = await f.registry.update({
    ...run,
    goal: { ...run.goal, noProgress: 3 },
  });
  run = await f.controller.tick((await due(f, run)).id, 'session');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nVerified.');
  run = await advanceToCompletion(f, run);
  assert.equal(run.status, 'completed');
});

test('a proven bounded goal expiry continues without accepting failure output as done', async (t) => {
  const f = await fixture(t, { mode: 'bounded', timeoutMs: 1_000 });
  let run = await start(f);
  const operationId = run.activeOperation?.operationId;
  f.worker.state = 'failed';
  f.worker.terminationReason = 'execution_lifetime_expired';
  f.worker.output = '<<<RALPHEX:GOAL_DONE>>>\nUnverified failure output.';
  run = await f.controller.tick(run.id, 'session');
  assert.equal(run.activeOperation?.operationId, operationId);
  assert.equal(f.worker.launches.length, 1);
  f.worker.proof = true;
  run = await f.controller.tick((await due(f, run)).id, 'session');
  assert.equal(run.status, 'running');
  assert.equal(run.stage, 'implementation');
  assert.equal(run.activeOperation, undefined);
  assert.ok(!run.needsAttention);
  assert.match(run.goal?.lastOutcome ?? '', /expired/i);
  f.worker.state = 'running';
  run = await f.controller.tick((await due(f, run)).id, 'session');
  assert.equal(f.worker.launches.length, 2);
  assert.equal(run.goal?.iteration, 2);
});

for (const blocker of ['worker', 'prerequisite', 'provider'] as const)
  test(`a bounded goal expiry does not bypass a ${blocker} blocker`, async (t) => {
    const f = await fixture(t, { mode: 'bounded', timeoutMs: 1_000 });
    let run = await start(f);
    f.worker.state = 'failed';
    f.worker.proof = true;
    f.worker.terminationReason = 'execution_lifetime_expired';
    f.worker.output =
      blocker === 'worker'
        ? '<<<RALPHEX:TASK_FAILED>>>\nBlocker: Operator approval required\nNext step: Restore approval UI'
        : blocker === 'provider'
          ? '401: invalid_api_key'
          : '';
    if (blocker === 'prerequisite') {
      assert.ok(run.activeOperation);
      run = await f.registry.update({
        ...run,
        activeOperation: {
          ...run.activeOperation,
          externalPrerequisite: {
            kind: 'permission',
            source: 'provider',
            evidence: 'Operator approval required',
          },
        },
      });
    }
    run = await f.controller.tick(run.id, 'session');
    assert.equal(run.status, 'paused');
    assert.ok(run.blocked);
    if (blocker === 'provider')
      assert.match(run.blocked.reason, /invalid_api_key/);
    assert.equal(f.worker.launches.length, 1);
  });

test('an explicit goal pause stays paused and resume preserves check evidence and the turn budget', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  run = await finishTurn(f, run, 'Read-only investigation.');
  assert.ok(run.goal);
  const evidence = run.goal.lastCheck;
  const maxTurns = run.goal.maxTurns;
  run = await f.registry.update({
    ...run,
    status: 'paused',
    userStopped: true,
    goal: { ...run.goal, noProgress: 3 },
  });
  run = await f.controller.tick(run.id, 'session');
  assert.equal(run.status, 'paused');
  assert.equal(f.worker.launches.length, 1);
  run = await f.controller.resume(run.id, 'session', true);
  assert.equal(run.goal?.noProgress, 0);
  assert.equal(run.goal?.maxTurns, maxTurns);
  assert.deepEqual(run.goal?.lastCheck, evidence);
  assert.equal(f.worker.launches.length, 2);
});

test('a goal refuses to start without at least one check', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.controller.startGoal({
      goal: 'Fix the failing tests',
      sessionId: 'session',
      cwd: f.root,
      checks: [],
    }),
    /at least one required check/,
  );
});

test('unchanged tracked state triggers reassessment, not a false no-progress pause', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  for (let turn = 0; turn < 4; turn += 1) {
    run = await finishTurn(
      f,
      run,
      `Attempt ${turn + 1}: read-only investigation.`,
    );
    assert.equal(run.status, 'running');
    assert.equal(run.blocked, undefined);
    assert.ok(!run.needsAttention);
    run = await f.controller.tick((await due(f, run)).id, 'session');
  }
  assert.equal(run.goal?.noProgress, 3);
  assert.equal(f.worker.launches.length, 5);
  assert.match(
    String(f.worker.launches.at(-1)?.params.task),
    /tracked HEAD and required-check results.*unchanged for 3/,
  );
  assert.match(
    String(f.worker.launches.at(-1)?.params.task),
    /different approach/i,
  );
  assert.match(
    goalStatusText(run),
    /turns with unchanged tracked HEAD\/checks: 3/,
  );
});

test('a goal resumes after a pause and completes', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  run = await finishTurn(
    f,
    run,
    `<<<RALPHEX:TASK_FAILED>>>\nBlocker: need a fixture file\nNext step: provide one`,
  );
  assert.equal(run.status, 'paused');
  assert.match(run.blocked?.reason ?? '', /need a fixture file/);
  const goal = run.goal;
  assert.ok(goal);
  run = await f.registry.update({ ...run, goal: { ...goal, noProgress: 3 } });

  run = await f.controller.resume(run.id, 'session', true);
  assert.equal(run.status, 'running');
  assert.ok(!run.needsAttention);
  assert.equal(run.blocked, undefined);
  assert.equal(run.error, undefined);
  assert.equal(run.goal?.noProgress, 0);
  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'fix failing tests');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nDone.');
  run = await advanceToCompletion(f, run);
  assert.equal(run.status, 'completed');
});

test('a recovered native runtime starts a goal without retaining its readiness warning', async (t) => {
  const f = await fixture(t);
  f.worker.available = false;
  let run = await start(f);
  assert.equal(run.activeOperation, undefined);
  assert.match(run.error ?? '', /Native runtime unavailable/);
  assert.ok(run.needsAttention);
  f.worker.available = true;
  run = await f.controller.tick((await due(f, run)).id, 'session');
  assert.ok(run.activeOperation);
  assert.equal(run.error, undefined);
  assert.ok(!run.needsAttention);
  assert.equal(f.worker.launches.length, 1);
});

test('a healthy goal observation clears a recovered status warning without relaunching', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  const operation = run.activeOperation;
  assert.ok(operation);
  run = await f.registry.update({
    ...run,
    needsAttention: true,
    nextAttemptAt: 0,
    activeOperation: {
      ...operation,
      statusFailures: 4,
      lastStatusError: 'Native runtime temporarily unavailable',
    },
  });
  run = await f.controller.tick(run.id, 'session');
  assert.ok(!run.needsAttention);
  assert.equal(run.activeOperation?.lastStatusError, undefined);
  assert.equal(run.activeOperation?.statusFailures, undefined);
  assert.equal(run.activeOperation?.operationId, operation.operationId);
  assert.equal(f.worker.launches.length, 1);
});

test('a healthy probe does not erase an independent prerequisite without resolution evidence', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  assert.ok(run.activeOperation);
  run = await f.registry.update({
    ...run,
    needsAttention: true,
    activeOperation: {
      ...run.activeOperation,
      lastStatusError: 'Temporary status outage',
      externalPrerequisite: {
        kind: 'permission',
        source: 'provider',
        evidence: 'Approval required',
      },
    },
  });
  run = await f.controller.tick(run.id, 'session');
  assert.equal(run.activeOperation?.lastStatusError, undefined);
  assert.equal(
    run.activeOperation?.externalPrerequisite?.evidence,
    'Approval required',
  );
  const widget = formatRunWidget(run, Date.now(), true).join('\n');
  assert.match(widget, /Waiting on prerequisite/);
  assert.match(widget, /Approval required/);
  assert.doesNotMatch(widget, /Temporary status outage/);
  assert.equal(f.worker.launches.length, 1);
});

test('a restart observes an active turn without relaunching it', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  assert.equal(run.goal?.iteration, 1);
  const restarted = new PlanExecController(
    f.registry,
    f.worker,
    fusion,
    command,
    createControllerLocalExecutor(),
  );
  run = await restarted.tick(run.id, 'session');
  assert.equal(
    f.worker.launches.length,
    1,
    'a persisted active turn must be observed, not relaunched',
  );
  assert.equal(run.goal?.iteration, 1);

  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'fix failing tests');
  f.worker.state = 'complete';
  f.worker.proof = true;
  f.worker.output = '<<<RALPHEX:GOAL_DONE>>>\nDone after restart.';
  run = await restarted.tick(run.id, 'session');
  run = await advanceToCompletion({ ...f, controller: restarted }, run);
  assert.equal(
    run.status,
    'completed',
    JSON.stringify({
      stage: run.stage,
      error: run.error,
      wake: run.wakeReason,
    }),
  );
  assert.equal(
    run.goal?.iteration,
    1,
    'the restarted turn must not increment the iteration twice',
  );
  assert.equal(f.worker.launches.length, 1);
});

test('goal completion pauses when the diff deletes tests', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  await rm(join(f.root, 'tests', 'sample.test.ts'));
  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'delete the failing test');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nGreen now.');
  assert.equal(run.status, 'paused');
  assert.match(run.blocked?.reason ?? '', /deleted test files/);
});

test('/goal parses verbs, checks, and goal text', () => {
  assert.deepEqual(parseGoalCommand(''), { action: 'help' });
  assert.deepEqual(parseGoalCommand('status abc'), {
    action: 'status',
    id: 'abc',
  });
  assert.deepEqual(parseGoalCommand('stop'), { action: 'cancel' });
  assert.deepEqual(
    parseGoalChecks('Fix tests --check "npm test" --check tsc'),
    { goal: 'Fix tests', checks: [['npm', 'test'], ['tsc']] },
  );
  assert.deepEqual(parseGoalCommand('Fix the failing tests'), {
    action: 'start',
    goal: 'Fix the failing tests',
    checks: [],
  });
});

test('goal status and widget show the goal instead of plan tasks', async (t) => {
  const f = await fixture(t);
  const run = await start(f);
  assert.match(goalStatusText(run), /goal: Fix the failing tests/);
  assert.match(goalStatusText(run), /turn: 1\/20/);
  const widget = formatRunWidget(run, Date.now(), true).join('\n');
  assert.match(widget, /Fix the failing tests/);
  assert.match(widget, /Goal · Turn 1/);
  assert.doesNotMatch(widget, /accepted/);
});

test('markers count only as standalone lines and a blocker outranks a mention', () => {
  assert.equal(
    parseGoalOutcome('I cannot emit <<<RALPHEX:GOAL_DONE>>> yet').kind,
    'continue',
  );
  assert.equal(parseGoalOutcome('<<<RALPHEX:GOAL_DONE>>>>').kind, 'continue');
  assert.equal(parseGoalOutcome('<<<RALPHEX:GOAL_DONE>>>\nextra').kind, 'done');
  const blocked = parseGoalOutcome(
    'I cannot emit <<<RALPHEX:GOAL_DONE>>> yet\n<<<RALPHEX:TASK_FAILED>>>\nBlocker: need a token\nNext step: provide one',
  );
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.reason ?? '', /need a token/);
});

test('a goal paused for its turn budget grants more turns on explicit resume', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  run = await finishTurn(f, run, 'Intermediate answer; continuing.');
  const goal = run.goal;
  assert.ok(goal);
  run = await f.registry.update({
    ...run,
    goal: { ...goal, iteration: goal.maxTurns },
  });
  run = await f.controller.tick((await due(f, run)).id, 'session');
  assert.equal(run.status, 'paused');
  assert.match(run.blocked?.reason ?? '', /turn budget reached/);

  const before = run.goal?.maxTurns;
  assert.ok(before !== undefined);
  run = await f.controller.resume(run.id, 'session', true);
  assert.equal(run.goal?.maxTurns, before + run.config.maxTaskIterations);
  assert.match(
    goalStatusText(run),
    new RegExp(
      `turn: ${goal.maxTurns + 1}/${before + run.config.maxTaskIterations}`,
    ),
  );
  assert.match(
    formatRunStatus(run),
    new RegExp(
      `turn: ${goal.maxTurns + 1}/${before + run.config.maxTaskIterations}`,
    ),
  );
  assert.equal(run.status, 'running');
  assert.equal(
    f.worker.launches.length,
    2,
    'the granted budget must launch the next turn',
  );
});

test('omitting --check keeps the configured required checks', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, '.pi', 'plan-exec.json'),
    JSON.stringify({
      reviewEnabled: false,
      reviewRequired: false,
      retryDelayMs: 10,
      maxTaskIterations: 20,
      requiredChecks: [['configured', 'check']],
    }),
  );
  await f.git('add', '--all');
  await f.git('commit', '-m', 'configure required checks');
  const run = await f.controller.startGoal({
    goal: 'Fix the failing tests',
    sessionId: 'session',
    cwd: f.root,
  });
  assert.deepEqual(run.config.requiredChecks, [['configured', 'check']]);
});

test('goal reservations are scoped to their repository', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const runA = await start(first);
  const runB = await start(second);
  assert.notEqual(runA.id, runB.id);
});

test('renaming a test away counts as deleting it', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  await mkdir(join(f.root, 'src'), { recursive: true });
  await f.git('mv', 'tests/sample.test.ts', 'src/sample.ts');
  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'move the test out of the suite');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nGreen now.');
  assert.equal(run.status, 'paused');
  assert.match(run.blocked?.reason ?? '', /deleted test files/);
});

test('the final gate rechecks test weakening after a review-style fix commit', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  await writeFile(join(f.root, 'done.txt'), 'fixed\n');
  await f.git('add', '--all');
  await f.git('commit', '-m', 'fix failing tests');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nDone.');
  assert.equal(run.stage, 'finalize');

  await rm(join(f.root, 'tests', 'sample.test.ts'));
  await f.git('add', '--all');
  await f.git('commit', '-m', 'review fixer deletes the test');
  run = await advanceToCompletion(f, run);
  assert.equal(run.status, 'paused');
  assert.equal(
    run.stage,
    'implementation',
    'resume must be able to run a worker turn after a final-gate guard pause',
  );
  assert.match(run.blocked?.reason ?? '', /deleted test files/);

  await writeFile(
    join(f.root, 'tests', 'sample.test.ts'),
    "test('ok', () => {});\n",
  );
  await f.git('add', '--all');
  await f.git('commit', '-m', 'restore the test');
  run = await f.controller.resume(run.id, 'session', true);
  assert.equal(run.stage, 'implementation');
  run = await finishTurn(f, run, '<<<RALPHEX:GOAL_DONE>>>\nRestored.');
  run = await advanceToCompletion(f, run);
  assert.equal(
    run.status,
    'completed',
    'a restored goal must be able to complete',
  );
});

test('startGoal reports its allocated run to the caller', async (t) => {
  const f = await fixture(t);
  let allocated: PlanExecRun | undefined;
  await f.controller.startGoal({
    goal: 'Fix the failing tests',
    sessionId: 'session',
    cwd: f.root,
    checks: CHECK,
    onRunAllocated: (run) => {
      allocated = run;
      assert.equal(run.ownerSessionId, 'session');
      assert.equal(run.lease, undefined);
    },
  });
  assert.ok(
    allocated,
    'the allocation callback must run so session retirement can track the goal',
  );
});

test('a failing check reports its commands and output and keeps a stable fingerprint', async (t) => {
  const f = await fixture(t);
  let attempt = 0;
  const failing = async () => {
    attempt += 1;
    throw new LocalOperationFailedError(
      'Local command failed (exit 1): /journal/local-operations/deadbeef/generation-1',
      {
        code: 1,
        outputTail: `${'failure context line\n'.repeat(200)}duration_ms: ${100 + attempt * 1000}\nStart at 12:0${attempt}\nAssertionError: expected 5 got 4`,
      },
    );
  };
  const controller = new PlanExecController(
    f.registry,
    f.worker,
    fusion,
    command,
    failing,
  );
  let run = await controller.startGoal({
    goal: 'Fix the failing tests',
    sessionId: 'session',
    cwd: f.root,
    checks: CHECK,
  });
  const finish = async (): Promise<PlanExecRun> => {
    f.worker.state = 'complete';
    f.worker.proof = true;
    f.worker.output = '<<<RALPHEX:GOAL_DONE>>>\nTrying.';
    return controller.tick(run.id, 'session');
  };
  run = await finish();
  assert.match(run.goal?.lastCheck?.failures ?? '', /checks: test -f done.txt/);
  assert.match(
    run.goal?.lastCheck?.failures ?? '',
    /AssertionError: expected 5 got 4/,
  );
  const fingerprint = run.goal?.lastCheck?.fingerprint;

  run = await controller.tick((await due(f, run)).id, 'session');
  run = await finish();
  assert.equal(
    run.goal?.lastCheck?.fingerprint,
    fingerprint,
    'test-runner timings must not look like progress',
  );
  assert.doesNotMatch(run.goal?.lastCheck?.failures ?? '', /duration_ms: \d/);
});

test('check-output normalization keeps real failure lines and replaces only timing values', () => {
  const normalized = normalizeCheckOutput(
    'AssertionError: duration must be positive\nduration_ms: 987.12\nfinished in 12.3ms\n0xdeadbeef',
  );
  assert.match(normalized, /AssertionError: duration must be positive/);
  assert.match(normalized, /duration_ms: <time>/);
  assert.match(normalized, /finished in <time>/);
  assert.match(normalized, /<addr>/);
});

test('a failed native child cannot complete a goal by printing GOAL_DONE', async (t) => {
  const f = await fixture(t);
  let run = await start(f);
  run = await f.controller.tick(run.id, 'session');
  await writeFile(join(f.root, 'done.txt'), 'done');
  await f.git('add', 'done.txt');
  await f.git('commit', '-m', 'candidate');
  f.worker.state = 'failed';
  f.worker.proof = true;
  f.worker.output = '<<<RALPHEX:GOAL_DONE>>>';
  run = await f.controller.tick(run.id, 'session');
  assert.equal(run.status, 'paused');
  assert.equal(run.stage, 'implementation');
  assert.equal(f.worker.launches.length, 1);
});

test('goal controls reject extra arguments instead of ignoring them', () => {
  for (const input of [
    'cancel abc extra',
    'stop --force',
    'pause --bad',
    'hide abc',
  ])
    assert.throws(() => parseGoalCommand(input), /Usage:/);
  assert.deepEqual(parseGoalCommand('hide'), { action: 'hide' });
});
