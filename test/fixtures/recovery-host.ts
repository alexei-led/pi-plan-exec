import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BridgeClient, bridgeRequestDigest } from '../../src/bridge.js';
import { parsePlan } from '../../src/plan.js';
import { RunRegistry } from '../../src/registry.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../../src/types.js';

export default function recoveryFixture(pi: ExtensionAPI) {
  const sandbox = process.env.PLAN_EXEC_RECOVERY_SANDBOX;
  const bridgeRoot = process.env.PLAN_EXEC_RECOVERY_BRIDGE;
  assert.ok(sandbox && bridgeRoot && homedir() === join(sandbox, 'home'));
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
    handler: async (_args, ctx) => {
      assert.equal((await registry.list()).length, 0, 'Seed once only');
      await bridge.capabilities();
      const ids: Record<string, string> = {};
      for (const kind of ['rejected', 'legacy']) {
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
          workflowScriptPath: './removed.js',
          mission: false,
          executionLifetime: { mode: 'unbounded' },
        };
        const requestDigest = bridgeRequestDigest(params);
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
          assert.equal(rejected.error.upstreamCode, 'invalid_params');
          assert.ok(run.activeOperation);
          assert.ok(rejected.error.code);
          run = await registry.update({
            ...run,
            activeOperation: {
              ...run.activeOperation,
              lastLaunchError: rejected.error.message,
              lastLaunchErrorCode: rejected.error.code,
              lastLaunchUpstreamCode: rejected.error.upstreamCode,
            },
          });
          const lookup = await bridge.operation(operationId, owner);
          assert.ok(lookup.success && lookup.data.state === 'not_started');
          const replay = await bridge.spawn(operationId, params, owner);
          assert.equal(replay.success, false);
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
      }
      writeFileSync(join(sandbox, 'ids.json'), JSON.stringify(ids, null, 2));
      ctx.ui.notify(
        'Seeded isolated fixtures. Restart Pi before /exec resume. ' +
          JSON.stringify(ids),
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
        2,
        'one rejected RPC, one successful worker, no duplicate',
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
