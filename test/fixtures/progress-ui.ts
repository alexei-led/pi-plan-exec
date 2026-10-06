import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RunRegistry } from '../../src/registry.js';
import type { PlanExecRun, RunStatus } from '../../src/types.js';

/** Display fixtures in the explicitly isolated recovery sandbox, never live runs. */
export default function progressUiFixture(pi: ExtensionAPI): void {
  const sandbox = process.env.PLAN_EXEC_RECOVERY_SANDBOX;
  assert.ok(sandbox && homedir() === join(sandbox, 'home'));
  const registry = new RunRegistry();
  const marker = join(sandbox, 'ui-run-id.txt');
  let displayId: string | undefined = existsSync(marker)
    ? readFileSync(marker, 'utf8')
    : undefined;
  pi.registerCommand('fixture-theme', {
    description: 'Set only this fixture host theme: light or dark',
    handler: async (name, ctx) => {
      assert.ok(name === 'light' || name === 'dark');
      assert.ok(ctx.ui.setTheme(name).success);
    },
  });
  pi.registerCommand('fixture-strip', {
    description:
      'Display-only run fixture: running, waiting, failed, paused, cancelling, complete',
    handler: async (args, ctx) => {
      const states: Record<string, RunStatus> = {
        running: 'running',
        waiting: 'running',
        failed: 'failed',
        paused: 'paused',
        cancelling: 'cancel_pending',
        complete: 'completed',
      };
      const status = states[args.trim()];
      assert.ok(status, 'Unknown fixture state');
      const ids = JSON.parse(
        readFileSync(join(sandbox, 'ids.json'), 'utf8'),
      ) as { rejected: string };
      const original = await registry.get(ids.rejected);
      assert.ok(original);
      const tasks: NonNullable<PlanExecRun['tasks']> = {};
      for (let i = 1; i <= 12; i++)
        tasks[String(i)] = {
          taskId: i,
          dependsOn: i === 1 ? [] : [i - 1],
          attempts: i <= 5 ? 1 : 0,
          state:
            args.trim() === 'complete' || i <= 4
              ? 'accepted'
              : i === 5
                ? 'running'
                : 'waiting_dependency',
        };
      const data = {
        ...original,
        repositoryRoot: ctx.cwd,
        worktreeCwd: ctx.cwd,
        planPath: join(ctx.cwd, 'router-ui-and-observability.md'),
        status,
        stage:
          status === 'completed'
            ? ('complete' as const)
            : ('implementation' as const),
        tasks,
        updatedAt: Date.now(),
        needsAttention: args.trim() === 'waiting',
        lease: {
          sessionId: 'display-only',
          pid: process.pid,
          hostname: 'display-fixture.invalid',
          heartbeatAt: Date.now(),
        },
      };
      delete data.activeOperation;
      delete data.failedOperation;
      delete data.error;
      delete data.taskProjection;
      delete data.archiveOperation;
      delete data.nextAttemptAt;
      const display = displayId
        ? await registry.updateLatest(displayId, (current) => ({
            ...data,
            id: current.id,
            updatedAt: current.updatedAt,
            revision: current.revision ?? 1,
          }))
        : await registry.create(data);
      displayId = display.id;
      writeFileSync(join(sandbox, 'ui-run-id.txt'), display.id);
      ctx.ui.notify(`Display fixture ready. /exec show ${display.id}`, 'info');
    },
  });
}
