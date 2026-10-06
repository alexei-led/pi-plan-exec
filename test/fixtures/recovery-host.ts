import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BridgeClient, bridgeRequestDigest } from '../../src/bridge.js';
import { parsePlan } from '../../src/plan.js';
import { RunRegistry } from '../../src/registry.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../../src/types.js';

export default function recoveryFixture(pi: ExtensionAPI) {
  const sandbox = process.env.PLAN_EXEC_RECOVERY_SANDBOX;
  const bridgeRoot = process.env.PLAN_EXEC_RECOVERY_BRIDGE;
  assert.ok(sandbox && bridgeRoot && homedir() === join(sandbox, 'home'));
  pi.on('session_start', async (_event, ctx) => {
    const sourceRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../..',
    );
    const paths = [
      'bridge',
      'controller',
      'index',
      'isolation',
      'lifecycle',
      'registry',
      'task-summary',
      'types',
    ].map((name) => join(sourceRoot, 'src', `${name}.ts`));
    paths.push(
      join(bridgeRoot, 'src/plan-exec-rpc.ts'),
      join(bridgeRoot, 'src/operation-journal.ts'),
    );
    const sessionId = ctx.sessionManager.getSessionId();
    writeFileSync(
      join(sandbox, `loaded-${sessionId}.json`),
      JSON.stringify(
        {
          sessionId,
          pid: process.pid,
          cwd: ctx.cwd,
          node: process.version,
          sources: paths.map((path) => ({
            path,
            sha256: createHash('sha256')
              .update(readFileSync(path))
              .digest('hex'),
          })),
        },
        null,
        2,
      ),
    );
  });
  const registry = new RunRegistry();
  const bridge = new BridgeClient(pi.events);
  pi.events.on('subagents:rpc:v1:request', (raw: unknown) => {
    if (
      raw &&
      typeof raw === 'object' &&
      'method' in raw &&
      raw.method === 'spawn'
    )
      appendFileSync(
        join(sandbox, 'dispatches.jsonl'),
        `${JSON.stringify({ at: Date.now() })}\n`,
      );
  });
  pi.registerCommand('fixture-seed', {
    description: 'Create isolated rejection and legacy recovery fixtures',
    handler: async (args, ctx) => {
      assert.ok(
        ['', 'lost-reply', 'isolation'].includes(args.trim()),
        'Use /fixture-seed [lost-reply|isolation]',
      );
      const lostReply = args.trim() === 'lost-reply';
      const isolation = args.trim() === 'isolation';
      assert.equal((await registry.list()).length, 0, 'Seed once only');
      await bridge.capabilities();
      const ids: Record<string, string> = {
        mode: isolation ? 'isolation' : lostReply ? 'lost-reply' : 'rejection',
      };
      if (lostReply)
        writeFileSync(
          join(sandbox, 'hold-worker'),
          'Hold the model response until /fixture-release.',
        );
      for (const kind of isolation ? ['legacy'] : ['rejected', 'legacy']) {
        const cwd = join(sandbox, kind);
        const planPath = join(cwd, 'plan.md');
        const content = readFileSync(planPath, 'utf8');
        const head = (
          await pi.exec('git', ['rev-parse', 'HEAD'], { cwd })
        ).stdout.trim();
        const operationId = randomUUID();
        const params = {
          cwd,
          agent: 'recovery-worker',
          task: 'Implement the fixture plan.',
          ...(!lostReply ? { workflowScriptPath: './removed.js' } : {}),
          mission: false,
          executionLifetime: { mode: 'unbounded' },
        };
        const requestDigest = bridgeRequestDigest(params);
        const oldProgress = join(cwd, '.ralphex/progress/old-progress.txt');
        if (isolation) {
          mkdirSync(dirname(oldProgress), { recursive: true });
          writeFileSync(oldProgress, 'Preserved original progress.\n');
        }
        let run = await registry.create({
          schemaVersion: 1,
          repositoryRoot: cwd,
          worktreeCwd: cwd,
          planPath,
          planHash: parsePlan(planPath, content).hash,
          approvedPlan: { hash: parsePlan(planPath, content).hash, content },
          branch: 'main',
          defaultBranch: 'main',
          status: 'running',
          lease: {
            sessionId: ctx.sessionManager.getSessionId(),
            pid: process.pid,
            heartbeatAt: Date.now(),
            hostname: hostname(),
          },
          stage: 'implementation',
          acceptedHead: head,
          ...(isolation ? { progressPath: oldProgress } : {}),
          taskAttempts: {},
          stageAttempts: {},
          reviewFindings: [],
          unresolvedFindings: [],
          skippedStages: [],
          branchRebindings: [],
          tasks: {
            '1': {
              taskId: 1,
              dependsOn: [],
              state: 'running',
              attempts: 1,
              operationId,
              baselineCommit: head,
            },
          },
          activeOperation: {
            operationId,
            service: 'bridge',
            kind: 'implementation',
            taskId: 1,
            params,
            requestDigest,
            expectedLifetime: { mode: 'unbounded' },
            recovery: 'recovery_required',
            lastObservedState: 'unknown_launch',
            launchStartedAt: 0,
          },
          config: {
            ...DEFAULT_FROZEN_RUN_CONFIG,
            retryDelayMs: 1,
            reviewEnabled: false,
            reviewRequired: false,
            workerAgent: 'recovery-worker',
            workerModel: 'recovery/fixture',
            requiredChecks: [
              [
                'node',
                '-e',
                "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'done\\n')",
              ],
            ],
          },
        });
        const owner = {
          kind: 'pi-plan-exec' as const,
          runId: run.id,
          key: operationId,
          requestDigest,
        };
        if (kind === 'rejected') {
          const rejected = await bridge.spawn(operationId, params, owner);
          assert.equal(rejected.success, false);
          if (rejected.success) throw new Error('Expected rejection');
          if (lostReply) {
            assert.equal(
              JSON.parse(readFileSync(join(sandbox, 'lost-reply.json'), 'utf8'))
                .dropped,
              true,
            );
            ids.initialOperationId = operationId;
          } else assert.equal(rejected.error.upstreamCode, 'invalid_params');
          assert.ok(run.activeOperation);
          assert.ok(rejected.error.code);
          run = await registry.update({
            ...run,
            activeOperation: {
              ...run.activeOperation,
              lastLaunchError: rejected.error.message,
              lastLaunchErrorCode: rejected.error.code,
              ...(rejected.error.upstreamCode
                ? { lastLaunchUpstreamCode: rejected.error.upstreamCode }
                : {}),
            },
          });
          if (!lostReply) {
            const lookup = await bridge.operation(operationId, owner);
            assert.ok(lookup.success && lookup.data.state === 'not_started');
            const replay = await bridge.spawn(operationId, params, owner);
            assert.equal(replay.success, false);
          }
        } else {
          const { OperationJournal } = await import(
            join(bridgeRoot, 'src/operation-journal.ts')
          );
          const journal = new OperationJournal(
            join(
              homedir(),
              '.pi/pi-subagents-bridge/plan-exec-operations.sqlite',
            ),
          );
          journal.begin(
            operationId,
            requestDigest,
            run.id,
            { mode: 'unbounded' },
            { operationId, digest: requestDigest },
          );
          const lookup = await bridge.operation(operationId, owner);
          assert.ok(lookup.success && lookup.data.state === 'unknown');
        }
        ids[kind] = run.id;
        if (isolation) {
          ids.originalOperationId = operationId;
          ids.originalCwd = cwd;
          ids.baseline = head;
          ids.oldProgress = oldProgress;
          writeFileSync(
            join(cwd, 'partial.txt'),
            'Preserved unaccepted old work.\n',
          );
        }
      }
      writeFileSync(join(sandbox, 'ids.json'), JSON.stringify(ids, null, 2));
      ctx.ui.notify(
        'Seeded isolated fixtures. Restart Pi before /exec resume. ' +
          JSON.stringify(ids),
        'info',
      );
    },
  });
  pi.registerCommand('fixture-old', {
    description:
      'Launch a genuine old fixture worker in the quarantined source only',
    handler: async (_args, ctx) => {
      const ids = JSON.parse(readFileSync(join(sandbox, 'ids.json'), 'utf8'));
      assert.equal(ids.mode, 'isolation');
      await bridge.capabilities();
      const operationId = randomUUID();
      const params = {
        cwd: ids.originalCwd,
        agent: 'recovery-old-worker',
        task: 'Keep writing old-live.txt until the fixture releases you.',
        mission: false,
        worktree: false,
        executionLifetime: { mode: 'unbounded' },
      };
      const owner = {
        kind: 'pi-plan-exec' as const,
        runId: `fixture-old-${ids.legacy}`,
        key: operationId,
        requestDigest: bridgeRequestDigest(params),
      };
      const reply = await bridge.spawn(operationId, params, owner);
      assert.ok(reply.success, JSON.stringify(reply));
      writeFileSync(
        join(sandbox, 'old-worker.json'),
        JSON.stringify({ operationId, ...reply.data }),
      );
      ctx.ui.notify(
        'Old fixture worker launched. Its host must remain alive during isolated recovery.',
        'info',
      );
    },
  });
  pi.registerCommand('fixture-release-old', {
    description: 'Let only the isolated old fixture worker finish and commit',
    handler: async (_args, ctx) => {
      writeFileSync(join(sandbox, 'release-old'), 'finish');
      ctx.ui.notify(
        'Old fixture worker released; its result must not affect recovered progress.',
        'info',
      );
    },
  });
  pi.registerCommand('fixture-isolation-proof', {
    description:
      'Verify same-run isolation with preserved old source and independent progress',
    handler: async (_args, ctx) => {
      const ids = JSON.parse(readFileSync(join(sandbox, 'ids.json'), 'utf8'));
      const run = await registry.get(ids.legacy);
      assert.equal(run?.status, 'completed');
      assert.equal(run.tasks?.['1']?.state, 'accepted');
      assert.equal(
        run.quarantinedExecutions?.[0]?.operation.operationId,
        ids.originalOperationId,
      );
      assert.equal(
        run.quarantinedExecutions?.[0]?.operation.processTreeExited,
        undefined,
      );
      assert.equal(run.quarantinedExecutions?.[0]?.dispatchFenced, true);
      assert.notEqual(run.worktreeCwd, ids.originalCwd);
      assert.equal(
        run.quarantinedExecutions?.[0]?.progressPath,
        ids.oldProgress,
      );
      assert.notEqual(run.progressPath, ids.oldProgress);
      assert.ok(run.progressPath);
      assert.doesNotMatch(
        readFileSync(run.progressPath, 'utf8'),
        /OLD_WRITER_TICK/,
      );
      assert.equal(
        readFileSync(join(ids.originalCwd, 'partial.txt'), 'utf8'),
        'Preserved unaccepted old work.\n',
      );
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(join(run.worktreeCwd, 'partial.txt')), false);
      assert.equal(existsSync(join(run.worktreeCwd, 'old-live.txt')), false);
      const dispatches = readFileSync(join(sandbox, 'dispatches.jsonl'), 'utf8')
        .trim()
        .split('\n').length;
      assert.equal(
        dispatches,
        existsSync(join(sandbox, 'old-worker.json')) ? 2 : 1,
      );
      const report = {
        success: true,
        runId: run.id,
        oldOperationId: ids.originalOperationId,
        newOperationId: run.tasks?.['1']?.operationId,
        oldCwd: ids.originalCwd,
        newCwd: run.worktreeCwd,
        generation: run.executionGeneration,
        dispatches,
        accepted: 1,
      };
      writeFileSync(
        join(sandbox, 'isolation-proof.json'),
        JSON.stringify(report, null, 2),
      );
      ctx.ui.notify(
        'ISOLATION PASS: same run accepted once in independent target; old target and unknown operation preserved.',
        'info',
      );
    },
  });
  pi.registerCommand('fixture-release', {
    description: 'Release only the isolated held model response',
    handler: async (_args, ctx) => {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(sandbox, 'hold-worker'));
      ctx.ui.notify(
        'Fixture model released; no worker was launched by this command.',
        'info',
      );
    },
  });
  pi.registerCommand('fixture-proof', {
    description: 'Verify isolated recovery evidence',
    handler: async (_args, ctx) => {
      const ids = JSON.parse(readFileSync(join(sandbox, 'ids.json'), 'utf8'));
      const recovered = await registry.get(ids.rejected);
      const legacy = await registry.get(ids.legacy);
      assert.equal(recovered?.status, 'completed');
      assert.equal(recovered.tasks?.['1']?.state, 'accepted');
      assert.equal(legacy?.activeOperation?.externalRunId, undefined);
      assert.equal(
        legacy?.activeOperation?.lastObservedState,
        'unknown_launch',
      );
      const dispatches = readFileSync(join(sandbox, 'dispatches.jsonl'), 'utf8')
        .trim()
        .split('\n').length;
      assert.equal(
        dispatches,
        ids.mode === 'lost-reply' ? 1 : 2,
        'native dispatch count must not increase during recovery',
      );
      if (ids.mode === 'lost-reply')
        assert.equal(
          recovered.tasks?.['1']?.operationId,
          ids.initialOperationId,
        );
      writeFileSync(
        join(sandbox, 'proof.json'),
        JSON.stringify(
          { success: true, ids, dispatches, accepted: 1, legacyFenced: true },
          null,
          2,
        ),
      );
      ctx.ui.notify(
        'RECOVERY PASS: one worker accepted; legacy still fenced; no duplicate dispatch.',
        'info',
      );
    },
  });
}
