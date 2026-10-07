import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { executionRequestDigest } from '../../src/execution-contract.js';
import { NativeRuntimeClient } from '../../src/native-runtime.js';
import { parsePlan } from '../../src/plan.js';
import { RunRegistry } from '../../src/registry.js';
import { required } from '../../src/required.js';
import { DEFAULT_FROZEN_RUN_CONFIG } from '../../src/types.js';
import { writeLegacyJournal } from './legacy-journal.js';

/** Optional manual fixture. Only isolated native RPC and closed legacy data. */
export default function recoveryFixture(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  const sandbox = process.env.PLAN_EXEC_RECOVERY_SANDBOX;
  assert.ok(sandbox && homedir() === join(sandbox, 'home'));
  const registry = new RunRegistry();
  let context: ExtensionContext | undefined;
  const native = new NativeRuntimeClient(
    pi.events,
    registry,
    () => required(context),
    { rpcTimeoutMs: 1000 },
  );
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
  });
  pi.on('session_shutdown', () => native.dispose());
  pi.events.on('subagents:rpc:v1:request', (raw) => {
    if (
      raw &&
      typeof raw === 'object' &&
      'method' in raw &&
      raw.method === 'spawn'
    )
      appendFileSync(
        join(sandbox, 'dispatches.jsonl'),
        JSON.stringify(raw) + '\n',
      );
  });
  pi.registerCommand('fixture-seed', {
    description:
      'Seed isolated native prepared/lost-response and readonly legacy snapshot records',
    handler: async (args, ctx) => {
      context = ctx;
      assert.ok(
        ['', 'lost-reply'].includes(args.trim()),
        'Use /fixture-seed [lost-reply]',
      );
      assert.equal((await registry.list()).length, 0, 'Seed once only');
      const ids: Record<string, string> = {};
      for (const kind of ['native', 'legacy']) {
        const cwd = join(sandbox, kind);
        const planPath = join(cwd, 'plan.md');
        const plan = parsePlan(planPath, readFileSync(planPath, 'utf8'));
        let run = await registry.create({
          schemaVersion: 1,
          repositoryRoot: cwd,
          worktreeCwd: cwd,
          planPath,
          planHash: plan.hash,
          branch: 'feature',
          defaultBranch: 'main',
          status: 'running',
          stage: 'implementation',
          taskAttempts: {},
          stageAttempts: {},
          reviewFindings: [],
          unresolvedFindings: [],
          config: {
            ...DEFAULT_FROZEN_RUN_CONFIG,
            workerModel: 'recovery/fixture',
            retryDelayMs: 100,
            reviewEnabled: false,
            reviewRequired: false,
          },
        });
        run = await registry.claim(run, ctx.sessionManager.getSessionId());
        const operationId = randomUUID();
        if (kind === 'native') {
          const operation = await native.prepare(run, {
            operationId,
            kind: 'implementation',
            taskId: 1,
            agent: 'worker',
            model: 'recovery/fixture',
            task: `Complete task 1 in ${planPath}, verify and commit it.`,
          });
          await registry.update({ ...run, activeOperation: operation });
          if (args.trim() === 'lost-reply') {
            writeFileSync(join(sandbox, 'drop-next-reply'), 'drop');
            await native.spawn(run.id, {
              operationId,
              requestDigest: required(operation.requestDigest),
            });
          }
        } else {
          const params = {
            cwd,
            agent: 'worker',
            task: 'Original legacy task',
            mission: false,
          };
          const requestDigest = executionRequestDigest(params);
          await registry.update({
            ...run,
            activeOperation: {
              operationId,
              service: 'bridge',
              kind: 'implementation',
              taskId: 1,
              requestDigest,
              params,
            },
          });
          const snapshot = join(sandbox, 'legacy-offline.sqlite');
          await writeLegacyJournal(
            snapshot,
            { operationId, requestDigest, ownerRunId: run.id },
            {
              binding: 'unknown',
              run_id: null,
              error: 'Native identity was not retained',
            },
          );
          ids.snapshot = snapshot;
        }
        ids[kind] = run.id;
      }
      writeFileSync(join(sandbox, 'ids.json'), JSON.stringify(ids));
      ctx.ui.notify(
        `Native/legacy fixtures seeded: ${JSON.stringify(ids)}. Legacy snapshot import cannot authorize replay.`,
        'info',
      );
    },
  });
}
