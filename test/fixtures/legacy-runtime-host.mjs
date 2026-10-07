import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { createJiti } from 'jiti';

const [phase, sandbox] = process.argv.slice(2);
const jiti = createJiti(import.meta.url);
const { createNativeRuntimeHost } = await jiti.import(
  './native-runtime-host.ts',
);
const { RunRegistry } = await jiti.import('../../src/registry.ts');
const { NativeRuntimeClient } = await jiti.import(
  '../../src/native-runtime.ts',
);
const { PlanExecController } = await jiti.import('../../src/controller.ts');
const { createControllerLocalExecutor } = await jiti.import(
  './controller-local-executor.ts',
);
const host = await createNativeRuntimeHost(join(sandbox, 'host'), {
  reattach: phase !== 'origin',
  sessionId: phase === 'origin' ? 'legacy-owner' : 'new-controller',
  holdChild: phase === 'origin',
});
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
  throw new Error('No Fusion fallback in legacy host probe');
};
const fusion = {
  start: unavailable,
  status: unavailable,
  result: unavailable,
  adopt: unavailable,
  cancel: unavailable,
};
const directory = join(sandbox, 'registry');
const registry = new RunRegistry(directory);
const client = new NativeRuntimeClient(
  host.events,
  registry,
  () => host.context,
);
const controller = new PlanExecController(
  registry,
  client,
  fusion,
  command,
  createControllerLocalExecutor(),
);
let spawns = 0;
host.events.on('subagents:rpc:v1:request', (request) => {
  if (request.method === 'spawn') spawns++;
});
async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
async function until(fn, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}
const journalPath = join(sandbox, 'legacy-live.sqlite');
const snapshotPath = join(sandbox, 'legacy-snapshot.sqlite');
let bridgeRegistration;
try {
  if (phase === 'origin') {
    await execute('git', ['branch', 'main'], { cwd: host.repository });
    const old = join(sandbox, 'frozen', 'src');
    const { RunRegistry: OldRegistry } = await jiti.import(
      join(old, 'registry.ts'),
    );
    const { PlanExecController: OldController } = await jiti.import(
      join(old, 'controller.ts'),
    );
    const { BridgeClient, bridgeRequestDigest } = await jiti.import(
      join(old, 'bridge.ts'),
    );
    const { readPlan } = await jiti.import(join(old, 'plan.ts'));
    const { DEFAULT_FROZEN_RUN_CONFIG } = await jiti.import(
      join(old, 'types.ts'),
    );
    const bridgePackage = join(sandbox, 'bridge', 'package');
    assert.equal(
      (await json(join(bridgePackage, 'package.json'))).version,
      '0.5.5',
    );
    const { registerBridge } = await jiti.import(
      join(bridgePackage, 'src/index.ts'),
    );
    bridgeRegistration = registerBridge(
      { events: host.events },
      { planExecJournalPath: journalPath, getSessionId: () => host.sessionId },
    );
    const oldRegistry = new OldRegistry(directory);
    const oldClient = new BridgeClient(host.events);
    const oldController = new OldController(
      oldRegistry,
      oldClient,
      fusion,
      command,
      createControllerLocalExecutor(),
    );
    assert.equal((await oldClient.ping()).success, true);
    const plan = await readPlan(join(host.repository, 'plan.md'));
    const baseline = (
      await execute('git', ['rev-parse', 'HEAD'], { cwd: host.repository })
    ).stdout.trim();
    let run = await oldRegistry.create({
      schemaVersion: 1,
      repositoryRoot: host.repository,
      worktreeCwd: host.repository,
      planPath: plan.path,
      planHash: plan.hash,
      branch: 'feature',
      defaultBranch: 'main',
      status: 'running',
      stage: 'implementation',
      taskAttempts: { 1: 1 },
      stageAttempts: {},
      reviewFindings: [],
      unresolvedFindings: [],
      config: {
        ...DEFAULT_FROZEN_RUN_CONFIG,
        reviewEnabled: false,
        reviewRequired: false,
        statsEnabled: false,
        requiredChecks: [[process.execPath, 'check.mjs']],
      },
      tasks: {
        1: {
          taskId: 1,
          dependsOn: [],
          state: 'running',
          attempts: 1,
          baselineCommit: baseline,
        },
      },
    });
    run = await oldRegistry.claim(run, host.sessionId);
    // Historical workflow shape supported by the released old Bridge, without inventing direct-child lifetime guarantees.
    const params = {
      agent: 'worker',
      task: 'Deliver fixture exactly once',
      cwd: host.repository,
      async: true,
      worktree: false,
      mission: false,
      timeoutMs: 60000,
    };
    const operationId = 'historical-workflow';
    const requestDigest = bridgeRequestDigest(params);
    const operation = {
      operationId,
      requestDigest,
      kind: 'implementation',
      service: 'bridge',
      params,
      taskId: 1,
      startedAt: Date.now(),
      baselineCommit: baseline,
      recovery: 'observe',
    };
    run = await oldRegistry.update({ ...run, activeOperation: operation });
    const launch = await oldClient.spawn(operationId, params, {
      kind: 'pi-plan-exec',
      runId: run.id,
      key: operationId,
      requestDigest,
    });
    assert.equal(launch.success, true, JSON.stringify(launch));
    const rootId = launch.data.runId;
    assert.equal(typeof rootId, 'string');
    const asyncDir = join(host.asyncDirRoot, rootId);
    run = await oldRegistry.update({
      ...run,
      activeOperation: { ...operation, externalRunId: rootId, asyncDir },
    });
    const child = await until(
      () => json(join(sandbox, 'host/child-barrier.json')),
      'old workflow child barrier',
    );
    run = await oldController.tick(run.id, host.sessionId);
    assert.equal(run.activeOperation.operationId, operationId);
    assert.equal(spawns, 1);
    await writeFile(
      join(sandbox, 'origin.json'),
      JSON.stringify({
        runId: run.id,
        rootId,
        asyncDir,
        operationId,
        requestDigest,
        params,
        child,
        hostPid: process.pid,
        spawns,
        journalPath,
      }),
    );
    await until(
      () => json(join(sandbox, 'quiesce.json')),
      'operator quiescence',
    );
    // No old controller tick after this point. Stop Bridge subscriptions, release its management lease,
    // but keep the original native parent alive to observe the real child close.
    bridgeRegistration.dispose();
    bridgeRegistration = undefined;
    await oldRegistry.release(await oldRegistry.get(run.id));
    await writeFile(
      join(sandbox, 'host/release-child'),
      'settle original old child',
    );
    const proof = await until(async () => {
      const reply = await host.rpc('status', { id: rootId });
      const value = reply.reply?.data?.details?.workflowTerminalProof;
      return value?.state === 'observed' && value;
    }, 'original legacy workflow exact public retirement proof');
    assert.equal(proof.runId, rootId);
    assert.equal(proof.children.length, 1);
    const db = new DatabaseSync(journalPath, { readOnly: true });
    try {
      await backup(db, snapshotPath);
    } finally {
      db.close();
    }
    assert.equal((await host.calls()).length, 1);
    await writeFile(
      join(sandbox, 'quiescent.json'),
      JSON.stringify({ rootId, proof, spawns, sideEffects: 1, snapshotPath }),
    );
    await until(() => json(join(sandbox, 'finish.json')), 'fixture finish');
  } else {
    const origin = await json(join(sandbox, 'origin.json'));
    if (phase === 'admission') {
      const before = await readFile(registry.authorizationPath(origin.runId));
      await assert.rejects(
        controller.start({
          cwd: host.repository,
          planPath: join(host.repository, 'plan.md'),
          useWorktree: false,
          sessionId: host.sessionId,
        }),
        /already|owned|another|existing/i,
      );
      await assert.rejects(
        controller.resume(origin.runId, host.sessionId),
        /owned|lease|session|controller/i,
      );
      assert.deepEqual(
        await readFile(registry.authorizationPath(origin.runId)),
        before,
      );
      assert.equal(spawns, 0);
      await writeFile(
        join(sandbox, 'admission.json'),
        JSON.stringify({ hostPid: process.pid, spawns, refused: true }),
      );
    } else {
      assert.equal(phase, 'recover');
      const bytes = await readFile(snapshotPath);
      const imported = await controller.importLegacyJournal(
        origin.runId,
        host.sessionId,
        snapshotPath,
      );
      assert.equal(imported.activeOperation.operationId, origin.operationId);
      assert.equal(
        imported.activeOperation.requestDigest,
        origin.requestDigest,
      );
      assert.deepEqual(imported.activeOperation.params, origin.params);
      assert.equal(imported.activeOperation.externalRunId, origin.rootId);
      assert.equal(imported.lease, undefined);
      const observed = await client.observeLegacy(origin.runId, {
        operationId: origin.operationId,
        requestDigest: origin.requestDigest,
      });
      assert.equal(observed.operation.externalRunId, origin.rootId);
      assert.equal(observed.retired, true, JSON.stringify(observed));
      const run = await controller.tick(origin.runId, host.sessionId);
      assert.equal(spawns, 0);
      assert.deepEqual(await readFile(snapshotPath), bytes);
      assert.equal((await host.calls()).length, 1);
      // Stop before any following stage can dispatch a new, unrelated operation.
      assert.equal(run.activeOperation, undefined, JSON.stringify(run));
      assert.equal(run.tasks['1'].state, 'accepted', JSON.stringify(run));
      await writeFile(
        join(sandbox, 'recovery.json'),
        JSON.stringify({
          hostPid: process.pid,
          spawns,
          sideEffects: 1,
          importedOperation: origin.operationId,
          rootId: observed.operation.externalRunId,
          retired: observed.retired,
          stage: run.stage,
          taskState: run.tasks['1'].state,
          snapshotUnchanged: true,
        }),
      );
    }
  }
} finally {
  bridgeRegistration?.dispose();
  client.dispose();
  await host.dispose();
}
