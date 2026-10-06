import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  link,
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
import { promisify } from 'node:util';
import { onTestFinished, test } from 'vitest';
import { bridgeRequestDigest } from '../src/bridge.js';
import { PlanExecController } from '../src/controller.js';
import type { RunCommand } from '../src/git.js';
import { formatRunStatus, formatRunWidget } from '../src/index.js';
import { prepareIsolationDirectory } from '../src/isolation.js';
import { runCommands } from '../src/lanes.js';
import { parsePlan } from '../src/plan.js';
import { RunRegistry } from '../src/registry.js';
import { required } from '../src/required.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../src/types.js';

const execute = promisify(execFile);
const command: RunCommand = async (program, args, cwd) => {
  try {
    const result = await execute(program, args, { cwd });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.code ?? 1,
    };
  }
};
const ok = (data: Record<string, unknown>) => ({
  success: true as const,
  data,
});

async function fixture(
  plan = '### Task 1: Local characterization\n- [ ] Add a local test\n',
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'isolated-recovery-')),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old');
  await mkdir(old);
  const git = (args: string[]) => execute('git', args, { cwd: old });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.test']);
  await git(['config', 'core.hooksPath', '/dev/null']);
  const planPath = join(old, 'plan.md');
  await writeFile(planPath, plan);
  await git(['add', 'plan.md']);
  await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
  const baseline = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(old, 'partial.txt'), 'unaccepted old work\n');
  const params = {
    cwd: old,
    agent: 'worker',
    task: 'Local characterization',
    mission: false,
    executionLifetime: { mode: 'unbounded' },
  };
  const registry = new RunRegistry(join(root, 'runs'));
  const run = await registry.create({
    schemaVersion: 1,
    repositoryRoot: old,
    worktreeCwd: old,
    planPath,
    planHash: parsePlan(planPath, plan).hash,
    initialPlan: { hash: parsePlan(planPath, plan).hash, content: plan },
    branch: 'main',
    defaultBranch: 'main',
    status: 'running',
    stage: 'implementation',
    acceptedHead: baseline,
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    unresolvedFindings: [],
    tasks: {
      '1': {
        taskId: 1,
        dependsOn: [],
        state: 'running',
        attempts: 1,
        operationId: 'legacy-op',
        baselineCommit: baseline,
      },
    },
    activeOperation: {
      operationId: 'legacy-op',
      service: 'bridge',
      kind: 'implementation',
      taskId: 1,
      params,
      requestDigest: bridgeRequestDigest(params),
      expectedLifetime: { mode: 'unbounded' },
      recovery: 'recovery_required',
      lastObservedState: 'unknown_launch',
    },
    config: {
      ...DEFAULT_FROZEN_RUN_CONFIG,
      reviewEnabled: false,
      reviewRequired: false,
    },
  });
  let spawns = 0;
  let fences = 0;
  const bridge = {
    capabilities: async () => ({
      protocolVersion: 2 as const,
      healthy: true,
      workflowScriptSpawn: true,
      singleAgentSpawn: true,
      durableOperationLookup: true,
      processTerminalProofVersion: 1,
      executionLifetimeVersion: 1 as const,
      executionLifetimeModes: ['unbounded' as const],
      processTreeOwnership: {
        version: 1 as const,
        scope: 'owned-process-tree' as const,
        escapedDescendants: 'best-effort' as const,
      },
    }),
    spawn: async (operationId: string, params: Record<string, unknown>) => {
      spawns++;
      return ok({
        operationId,
        runId: 'new-worker',
        requestDigest: bridgeRequestDigest(params),
        effectiveExecutionLifetime: { mode: 'unbounded' },
      });
    },
    operation: async () => ok({ state: 'unknown' }),
    cancelOperation: async (
      operationId: string,
      owner?: { requestDigest: string },
    ) => {
      fences++;
      return ok({
        state: 'unknown',
        operationId,
        requestDigest: owner?.requestDigest,
        cancellationRequested: true,
        neverStarted: false,
        replaySafe: false,
      });
    },
    status: async () => ok({ state: 'running' }),
    result: async () => ok({}),
    adopt: async () => ok({ state: 'running' }),
    stop: async () => ok({ state: 'stopping' }),
  };
  const makeController = (localCommands = runCommands, observe = command) =>
    new PlanExecController(
      registry,
      bridge,
      {
        start: async () => ok({}),
        status: async () => ok({}),
        result: async () => ok({}),
        adopt: async () => ok({}),
        cancel: async () => ok({}),
      },
      observe,
      localCommands,
    );
  const controller = makeController();
  return {
    root,
    old,
    baseline,
    registry,
    run,
    bridge,
    controller,
    makeController,
    spawns: () => spawns,
    fences: () => fences,
  };
}

test('force abandonment preserves isolated recovery lineage and every quarantined reservation', async () => {
  const f = await fixture();
  const isolated = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    join(f.root, 'new'),
    true,
  );
  const result = await f.controller.forceStop(f.run.id, 'owner');
  assert.equal(result.run.status, 'abandoned');
  assert.equal(result.removed, false);
  assert.deepEqual(
    result.run.quarantinedExecutions,
    isolated.quarantinedExecutions,
  );
  assert.deepEqual(result.run.isolationRecovery, isolated.isolationRecovery);
  await assert.rejects(
    () => f.registry.assertExclusive({ ...f.run, id: 'other' }),
    /already exists/,
  );
  assert.equal(f.spawns(), 0);
});

test('explicit isolation preserves legacy uncertainty and creates one independent same-run writer', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const isolated = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(isolated.id, f.run.id);
  assert.equal(isolated.worktreeCwd, target);
  assert.equal(isolated.isolationRecovery?.state, 'active');
  assert.equal(
    isolated.quarantinedExecutions?.[0]?.operation.operationId,
    'legacy-op',
  );
  assert.equal(
    isolated.quarantinedExecutions?.[0]?.operation.processTreeExited,
    undefined,
  );
  assert.equal(isolated.quarantinedExecutions?.[0]?.dispatchFenced, true);
  assert.equal(
    await readFile(join(f.old, 'partial.txt'), 'utf8'),
    'unaccepted old work\n',
  );
  await assert.rejects(readFile(join(target, 'partial.txt')), {
    code: 'ENOENT',
  });
  assert.equal(
    (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: target })
    ).stdout.trim(),
    f.baseline,
  );
  assert.equal(
    (await execute('git', ['remote'], { cwd: target })).stdout.trim(),
    '',
  );
  assert.equal(
    (
      await execute('git', ['rev-parse', '--git-common-dir'], { cwd: target })
    ).stdout.trim(),
    '.git',
  );
  const same = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(same.executionGeneration, isolated.executionGeneration);
  await Promise.all([
    f.controller.resume(f.run.id, 'owner'),
    f.controller.resume(f.run.id, 'owner'),
  ]);
  assert.equal(f.spawns(), 1);
  assert.equal(f.fences(), 1);
});

test('rendering isolated recovery never writes task files to either checkout', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const run = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(run.isolationRecovery?.state, 'active');
  formatRunStatus(f.run);
  formatRunWidget(run);
  for (const cwd of [f.old, target])
    await assert.rejects(
      readFile(join(cwd, '.pi/tasks/tasks-stale-session.json')),
      { code: 'ENOENT' },
    );
  assert.equal((await f.registry.get(run.id))?.worktreeCwd, run.worktreeCwd);
});

test('isolation materializes an explicitly approved plan newer than the accepted commit', async () => {
  const f = await fixture();
  const content =
    '### Task 1: Local characterization\n- [ ] Add a local test\n### Task 2: Additional local check\n- [ ] Check the result\n';
  const path = required(f.run.planPath);
  await writeFile(path, content);
  const current = required(await f.registry.get(f.run.id));
  const hash = parsePlan(path, content).hash;
  await f.registry.update({
    ...current,
    planHash: hash,
    approvedPlan: { hash, content },
  });
  const isolated = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    join(f.root, 'new'),
    true,
  );
  assert.equal(isolated.isolationRecovery?.state, 'active', isolated.error);
  assert.equal(await readFile(required(isolated.planPath), 'utf8'), content);
  assert.equal(isolated.planHash, hash);
});

test('preview shows immutable-baseline bootstrap and rejects changed confirmation scope', async () => {
  const f = await fixture();
  await writeFile(join(f.old, 'package-lock.json'), '{"lockfileVersion":3}');
  await execute('git', ['add', 'package-lock.json'], { cwd: f.old });
  await execute(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-m', 'accepted lock'],
    { cwd: f.old },
  );
  const baseline = (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: f.old })
  ).stdout.trim();
  let current = required(await f.registry.get(f.run.id));
  current = await f.registry.update({ ...current, acceptedHead: baseline });
  await rm(join(f.old, 'package-lock.json'));
  await writeFile(join(f.old, 'yarn.lock'), 'unaccepted lock');
  const target = join(f.root, 'new');
  const preview = await f.controller.previewIsolated(f.run.id, target);
  assert.equal(preview.taskTitle, 'Local characterization');
  assert.deepEqual(preview.taskItems, ['Add a local test']);
  assert.deepEqual(preview.bootstrapCommands, [['npm', 'ci']]);
  await assert.rejects(readFile(join(target, '.git/config')), {
    code: 'ENOENT',
  });
  await f.registry.update({
    ...current,
    config: { ...current.config, requiredChecks: [['node', '--version']] },
  });
  await assert.rejects(
    f.controller.recoverIsolated(
      f.run.id,
      'owner',
      target,
      true,
      'legacy-op',
      preview.intentDigest,
    ),
    /changed after preview/,
  );
  assert.equal(
    (await f.registry.get(f.run.id))?.quarantinedExecutions,
    undefined,
  );
  assert.equal(f.spawns(), 0);
});

test('quarantine records ignored metadata and exact observed commit delta without copying contents', async () => {
  const f = await fixture();
  await writeFile(join(f.old, '.git/info/exclude'), '.ignored-private\n');
  await writeFile(join(f.old, '.ignored-private'), 'PRIVATE FIXTURE CONTENT');
  await writeFile(join(f.old, 'old-commit.txt'), 'unaccepted committed work');
  await execute('git', ['add', 'old-commit.txt'], { cwd: f.old });
  await execute(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-m', 'partial old commit'],
    { cwd: f.old },
  );
  const oldHead = (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: f.old })
  ).stdout.trim();
  const target = join(f.root, 'new');
  const run = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  const old = required(run.quarantinedExecutions?.[0]);
  assert.equal(old.observedHead, oldHead);
  assert.equal(old.baseline, f.baseline);
  assert.match(old.commitDelta, /partial old commit/);
  assert.match(old.inventory, /!! .ignored-private/);
  assert.doesNotMatch(old.inventory, /PRIVATE FIXTURE CONTENT/);
  assert.ok(old.ignoredEntries >= 1);
  await assert.rejects(readFile(join(target, '.ignored-private')), {
    code: 'ENOENT',
  });
  await assert.rejects(readFile(join(target, 'old-commit.txt')), {
    code: 'ENOENT',
  });
  assert.equal(
    await readFile(join(f.old, '.ignored-private'), 'utf8'),
    'PRIVATE FIXTURE CONTENT',
  );
});

test('isolation refuses existing, shared, symlink and side-effect targets without dispatch', async () => {
  const f = await fixture();
  const existing = join(f.root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'keep'), 'unrelated');
  const alias = join(f.root, 'alias');
  await symlink(f.old, alias);
  for (const target of [
    f.old,
    join(f.old, 'nested'),
    existing,
    join(alias, 'nested'),
  ]) {
    await assert.rejects(
      f.controller.recoverIsolated(f.run.id, 'owner', target, true),
    );
    assert.equal(
      (await f.registry.get(f.run.id))?.activeOperation?.operationId,
      'legacy-op',
    );
  }
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'unrelated');
  assert.equal(f.spawns(), 0);
  assert.equal(f.fences(), 0);
  const unsafe = await fixture(
    '### Task 1: Deploy production\n- [ ] Publish the release\n',
  );
  await assert.rejects(
    unsafe.controller.recoverIsolated(
      unsafe.run.id,
      'owner',
      join(unsafe.root, 'new'),
      true,
    ),
    /external side effects/,
  );
  assert.equal(unsafe.spawns(), 0);
  assert.equal(unsafe.fences(), 0);
});

test('changed branch and missing accepted commit fail before quarantine or dispatch', async () => {
  const f = await fixture();
  await execute('git', ['checkout', '-b', 'moved'], { cwd: f.old });
  await assert.rejects(
    f.controller.recoverIsolated(f.run.id, 'owner', join(f.root, 'new'), true),
    /branch changed/,
  );
  assert.equal(
    (await f.registry.get(f.run.id))?.quarantinedExecutions,
    undefined,
  );
  await execute('git', ['checkout', 'main'], { cwd: f.old });
  const current = required(await f.registry.get(f.run.id));
  await f.registry.update({ ...current, acceptedHead: 'a'.repeat(40) });
  await assert.rejects(
    f.controller.recoverIsolated(f.run.id, 'owner', join(f.root, 'new'), true),
    /Git observation failed/,
  );
  assert.equal(f.spawns(), 0);
  assert.equal(f.fences(), 0);
});

for (const stop of ['paused', 'cancel_pending'] as const) {
  test(`isolation preserves a concurrent ${stop} before activation`, async () => {
    const f = await fixture();
    const target = join(f.root, 'new');
    const controller = f.makeController(async (cwd, commands, options) => {
      await runCommands(cwd, commands, options);
      const current = required(await f.registry.get(f.run.id));
      await f.registry.update({
        ...current,
        status: stop,
        userStopped: true,
        stopGeneration: (current.stopGeneration ?? 0) + 1,
      });
    });
    const stopped = await controller.recoverIsolated(
      f.run.id,
      'owner',
      target,
      true,
    );
    assert.equal(stopped.status, stop);
    assert.equal(stopped.userStopped, true);
    assert.equal(stopped.isolationRecovery?.state, 'fenced');
    assert.equal(stopped.worktreeCwd, f.old);
    assert.equal(f.spawns(), 0);
    if (stop === 'cancel_pending') {
      await assert.rejects(
        f.controller.recoverIsolated(f.run.id, 'owner', target, true),
        /Cancellation wins/,
      );
    } else {
      const continued = await f.controller.recoverIsolated(
        f.run.id,
        'owner',
        target,
        true,
      );
      assert.equal(continued.isolationRecovery?.state, 'active');
      assert.equal(continued.status, 'paused');
      assert.equal(f.spawns(), 0);
    }
  });
}

for (const shared of ['symlink', 'hardlink'] as const) {
  test(`isolation rejects bootstrap-created shared ${shared} files before activation`, async () => {
    const f = await fixture();
    const target = join(f.root, 'new');
    const controller = f.makeController(async (cwd, commands, options) => {
      await runCommands(cwd, commands, options);
      if (shared === 'symlink')
        await symlink(join(f.old, 'partial.txt'), join(target, 'shared'));
      else await link(join(f.old, 'partial.txt'), join(target, 'shared'));
    });
    const run = await controller.recoverIsolated(
      f.run.id,
      'owner',
      target,
      true,
    );
    assert.equal(run.isolationRecovery?.state, 'fenced');
    assert.match(run.error ?? '', /shared external|hardlinked/);
    assert.equal(f.spawns(), 0);
    assert.equal(
      await readFile(join(f.old, 'partial.txt'), 'utf8'),
      'unaccepted old work\n',
    );
  });
}

test('a crash during private marker preparation never exposes an unowned target', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const preview = await f.controller.previewIsolated(f.run.id, target);
  const staging = join(f.root, `.plan-exec-isolation-${preview.id}`);
  await mkdir(staging);
  await writeFile(
    join(staging, '.plan-exec-isolation.json.tmp'),
    'interrupted write',
  );
  await prepareIsolationDirectory(preview);
  await prepareIsolationDirectory(preview);
  assert.equal(
    JSON.parse(
      await readFile(join(target, '.plan-exec-isolation.json'), 'utf8'),
    ).id,
    preview.id,
  );
  await assert.rejects(
    readFile(join(staging, '.plan-exec-isolation.json.tmp')),
    { code: 'ENOENT' },
  );
});

test('a genuine unborn target left after init can resume its original preparation', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const cancel = f.bridge.cancelOperation;
  f.bridge.cancelOperation = async () => {
    throw new Error('interrupt before clone');
  };
  await assert.rejects(
    f.controller.recoverIsolated(f.run.id, 'owner', target, true),
    /interrupt before clone/,
  );
  const pending = required(await f.registry.get(f.run.id));
  await prepareIsolationDirectory(required(pending.isolationRecovery));
  await execute('git', ['init', '--initial-branch', 'main'], { cwd: target });
  f.bridge.cancelOperation = cancel;
  const recovered = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(recovered.isolationRecovery?.state, 'active');
  assert.equal(f.spawns(), 0);
});

test('a lost quarantine fence reply resumes the same pending target without a second lineage entry', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const cancel = f.bridge.cancelOperation;
  f.bridge.cancelOperation = async () => {
    throw new Error('lost fence reply');
  };
  await assert.rejects(
    f.controller.recoverIsolated(f.run.id, 'owner', target, true),
    /lost fence reply/,
  );
  const pending = required(await f.registry.get(f.run.id));
  assert.equal(pending.quarantinedExecutions?.length, 1);
  assert.equal(pending.activeOperation, undefined);
  f.bridge.cancelOperation = cancel;
  const recovered = await f
    .makeController()
    .recoverIsolated(f.run.id, 'owner', target, true);
  assert.equal(recovered.isolationRecovery?.id, pending.isolationRecovery?.id);
  assert.equal(recovered.quarantinedExecutions?.length, 1);
  assert.equal(recovered.isolationRecovery?.state, 'active');
  assert.equal(f.spawns(), 0);
});

test('failed bootstrap pauses and explicit reapply can retry after the prerequisite is repaired', async () => {
  const f = await fixture();
  const current = required(await f.registry.get(f.run.id));
  await f.registry.update({
    ...current,
    config: {
      ...current.config,
      bootstrapCommands: [
        [
          'node',
          '-e',
          "if(!require('node:fs').existsSync('.git/bootstrap-ready'))process.exit(1)",
        ],
      ],
    },
  });
  const target = join(f.root, 'new');
  const paused = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(paused.status, 'paused');
  assert.equal(paused.userStopped, true);
  assert.equal(f.spawns(), 0);
  await assert.rejects(
    f.controller.resume(f.run.id, 'owner'),
    /preparation was stopped/,
  );
  await writeFile(join(target, '.git/bootstrap-ready'), 'ready');
  const recovered = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(recovered.isolationRecovery?.state, 'active');
  assert.equal(recovered.status, 'paused');
  assert.equal(f.fences(), 1);
});

test('retrying an interrupted clone never resets new commits in its pending target', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const interrupted = f.makeController(async (cwd, commands, options) => {
    await runCommands(cwd, commands, options);
    await writeFile(join(target, 'preserve.txt'), 'new partial work');
    await execute('git', ['add', 'preserve.txt'], { cwd: target });
    await execute(
      'git',
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'preserve new partial'],
      { cwd: target },
    );
  });
  const paused = await interrupted.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(paused.status, 'paused');
  const head = (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: target })
  ).stdout.trim();
  const refused = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(refused.isolationRecovery?.state, 'fenced');
  assert.match(refused.error ?? '', /new commits/);
  assert.equal(
    (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: target })
    ).stdout.trim(),
    head,
  );
  assert.equal(
    await readFile(join(target, 'preserve.txt'), 'utf8'),
    'new partial work',
  );
  let cloneCalls = 0;
  const brokenProbe: RunCommand = (program, args, cwd) =>
    cwd === target && args.includes('--verify') && args.includes('HEAD')
      ? Promise.resolve({ code: 128, stdout: '', stderr: 'HEAD read failed' })
      : command(program, args, cwd);
  const guarded = f.makeController(async (cwd, commands, options) => {
    cloneCalls++;
    await runCommands(cwd, commands, options);
  }, brokenProbe);
  const unreadable = await guarded.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(unreadable.isolationRecovery?.state, 'fenced');
  assert.equal(cloneCalls, 0);
  assert.equal(
    (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: target })
    ).stdout.trim(),
    head,
  );
  await execute('git', ['pack-refs', '--all'], { cwd: target });
  const packed = await guarded.recoverIsolated(f.run.id, 'owner', target, true);
  assert.equal(packed.isolationRecovery?.state, 'fenced');
  assert.equal(cloneCalls, 0);
  assert.equal(
    (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: target })
    ).stdout.trim(),
    head,
  );
  await execute('git', ['checkout', '--detach', f.baseline], { cwd: target });
  const detached = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(detached.isolationRecovery?.state, 'fenced');
  assert.equal(
    (
      await execute('git', ['rev-parse', 'refs/heads/main'], { cwd: target })
    ).stdout.trim(),
    head,
  );
  assert.equal(f.spawns(), 0);
});

test('restart after cloned checkout reuses the same target and rejects old-generation state', async () => {
  const f = await fixture();
  const target = join(f.root, 'new');
  const crash = f.makeController(async (cwd, commands, options) => {
    await runCommands(cwd, commands, options);
    throw new Error('Fixture crash after owned clone retired');
  });
  const interrupted = await crash.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  const ticket = interrupted.isolationRecovery?.id;
  assert.equal(interrupted.isolationRecovery?.state, 'fenced');
  assert.equal(f.spawns(), 0);
  const restarted = await f
    .makeController()
    .recoverIsolated(f.run.id, 'owner', target, true);
  assert.equal(restarted.isolationRecovery?.id, ticket);
  assert.equal(restarted.isolationRecovery?.state, 'active');
  assert.equal(f.fences(), 1);
  const stale = await f.registry.updateIfCurrent(
    { ...f.run, tasks: {} },
    restarted.updatedAt,
  );
  assert.equal(stale.applied, false);
  assert.equal(stale.run.executionGeneration, 1);
  assert.equal(stale.run.tasks?.['1']?.state, 'retry_wait');
  const resurrected = await f.registry.updateIfCurrent(
    { ...stale.run, activeOperation: required(f.run.activeOperation) },
    stale.run.updatedAt,
  );
  assert.equal(resurrected.applied, false);
  assert.equal(resurrected.run.activeOperation, undefined);
});

test('interrupted running task with retained prerequisite becomes resumable without losing evidence', async () => {
  const f = await fixture();
  const current = required(await f.registry.get(f.run.id));
  const prerequisite = {
    kind: 'permission' as const,
    source: 'worker' as const,
    evidence: 'Prior attempt lacked permission',
  };
  const task = required(current.tasks?.['1']);
  await f.registry.update({
    ...current,
    tasks: {
      '1': { ...task, externalPrerequisite: prerequisite, nextAttemptAt: 0 },
    },
  });
  const isolated = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    join(f.root, 'new'),
    true,
  );
  assert.equal(isolated.tasks?.['1']?.state, 'waiting_external');
  assert.equal(isolated.tasks?.['1']?.operationId, undefined);
  assert.deepEqual(isolated.tasks?.['1']?.externalPrerequisite, prerequisite);
  const resumed = await f.controller.resume(f.run.id, 'owner');
  assert.doesNotMatch(resumed.error ?? '', /unresolved operation ownership/);
  assert.equal(f.spawns(), 1);
});

test('isolation does not unblock unrelated independent tasks or erase their prerequisite', async () => {
  const f = await fixture(
    '### Task 1: Local characterization\n- [ ] Add a local test\n### Task 2: Publish artifact\ndependsOn: []\n- [ ] Publish after authorization\n',
  );
  const current = required(await f.registry.get(f.run.id));
  const blocked = {
    taskId: 2,
    dependsOn: [],
    state: 'waiting_external' as const,
    attempts: 2,
    nextAttemptAt: Date.now() + 60_000,
    reason: 'Permission required',
    externalPrerequisite: {
      kind: 'permission' as const,
      source: 'worker' as const,
      evidence: 'Registry denies publication',
    },
  };
  await f.registry.update({
    ...current,
    tasks: { ...current.tasks, '2': blocked },
  });
  const isolated = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    join(f.root, 'new'),
    true,
  );
  assert.deepEqual(isolated.tasks?.['2'], blocked);
  assert.equal(isolated.tasks?.['1']?.state, 'retry_wait');
  await f.registry.release(isolated);
  const restarted = new RunRegistry(join(f.root, 'runs'));
  assert.deepEqual((await restarted.get(f.run.id))?.tasks?.['2'], blocked);
  await f.makeController().resume(f.run.id, 'after-restart');
  assert.deepEqual((await restarted.get(f.run.id))?.tasks?.['2'], blocked);
  assert.equal(f.spawns(), 1);
});

test('mid-plan isolation retains accepted checkboxes and keeps quarantine reserved after completion', async () => {
  const f = await fixture(
    '### Task 1: Accepted local change\n- [x] Done\n### Task 2: Local characterization\n- [ ] Add a local test\n',
  );
  const current = required(await f.registry.get(f.run.id));
  await f.registry.update({
    ...current,
    activeOperation: { ...required(current.activeOperation), taskId: 2 },
    tasks: {
      '1': {
        taskId: 1,
        dependsOn: [],
        state: 'accepted',
        attempts: 1,
        acceptedCommit: f.baseline,
      },
      '2': {
        taskId: 2,
        dependsOn: [1],
        state: 'running',
        attempts: 3,
        baselineCommit: f.baseline,
        operationId: 'legacy-op',
      },
    },
  });
  const target = join(f.root, 'new');
  let moved = await f.controller.recoverIsolated(
    f.run.id,
    'owner',
    target,
    true,
  );
  assert.equal(moved.tasks?.['1']?.state, 'accepted');
  assert.equal(moved.tasks?.['2']?.attempts, 3);
  assert.match(await readFile(join(target, 'plan.md'), 'utf8'), /- \[x\] Done/);
  await writeFile(
    join(f.old, 'later-old-write'),
    'old worker still writes here',
  );
  await execute('git', ['add', 'later-old-write'], { cwd: f.old });
  await execute(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '-m', 'late old worker'],
    { cwd: f.old },
  );
  assert.equal(
    (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: target })
    ).stdout.trim(),
    f.baseline,
  );
  await assert.rejects(readFile(join(target, 'later-old-write')), {
    code: 'ENOENT',
  });
  moved = await f.registry.update({
    ...moved,
    status: 'completed',
    userStopped: false,
  });
  await assert.rejects(f.registry.remove(moved.id), /quarantined/);
  await assert.rejects(
    f.registry.assertExclusive({
      repositoryRoot: f.old,
      worktreeCwd: f.old,
      planPath: required(f.run.planPath),
    }),
    /already exists/,
  );
});
