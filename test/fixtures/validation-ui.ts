import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RunRegistry } from '../../src/registry.js';
import {
  DEFAULT_FROZEN_RUN_CONFIG,
  type PlanExecRun,
} from '../../src/types.js';

export default function validationUi(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  const sandbox = process.env.PLAN_EXEC_VALIDATION_SANDBOX;
  assert.ok(
    sandbox && homedir() === join(sandbox, 'home'),
    'Isolated validation HOME is required.',
  );
  const manifest = JSON.parse(
    readFileSync(join(sandbox, 'manifest.json'), 'utf8'),
  ) as {
    runtime: string;
    versions: Record<string, string>;
  };
  const log = (event: Record<string, unknown>) =>
    appendFileSync(
      join(sandbox, 'evidence/ui.jsonl'),
      JSON.stringify({ at: Date.now(), ...event }) + '\n',
    );
  const registry = new RunRegistry();
  pi.on('session_start', (event, ctx) => {
    const hash = createHash('sha256');
    for (const file of readdirSync(join(manifest.runtime, 'src')).sort())
      hash
        .update(file)
        .update(readFileSync(join(manifest.runtime, 'src', file)));
    log({
      event: 'session-start',
      reason: event.reason,
      cwd: ctx.cwd,
      mode: ctx.mode,
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      versions: manifest.versions,
      sourceHash: hash.digest('hex'),
      commands: pi.getCommands().map((command) => command.name),
    });
  });
  pi.events.on('subagents:rpc:v1:request', (value: unknown) => {
    const request = value as {
      method?: string;
      requestId?: string;
      params?: Record<string, unknown>;
    };
    if (request.method === 'spawn') {
      log({
        event: 'spawn',
        requestId: request.requestId,
        mode: request.params?.script ? 'workflow' : 'single',
        cwd: request.params?.cwd,
      });
    }
  });
  pi.registerCommand('fixture', {
    description:
      'Isolated validation controls: dimensions, light, dark, persist, snapshot',
    handler: async (args, ctx) => {
      if (args === 'dimensions') {
        const size = {
          event: 'dimensions',
          columns: process.stdout.columns,
          rows: process.stdout.rows,
        };
        log(size);
        ctx.ui.notify(JSON.stringify(size), 'info');
        return;
      }
      if (args === 'light' || args === 'dark') {
        const result = ctx.ui.setTheme(args);
        assert.ok(result.success, 'Theme must be available.');
        log({
          event: 'theme',
          theme: args,
          columns: process.stdout.columns,
          palette: {
            warning: ctx.ui.theme.fg('warning', 'Snapshot'),
            success: ctx.ui.theme.fg('success', 'Complete'),
            muted: ctx.ui.theme.fg('muted', 'Paused'),
          },
        });
        return;
      }
      if (args === 'persist') {
        pi.sendUserMessage('VALIDATION_PARENT_READY');
        log({ event: 'persist', file: ctx.sessionManager.getSessionFile() });
        return;
      }
      if (args === 'snapshot') {
        const run = await registry.create({
          schemaVersion: 1,
          repositoryRoot: ctx.cwd,
          worktreeCwd: ctx.cwd,
          planPath: join(ctx.cwd, 'validation-検証-👩‍💻.md'),
          planHash: 'display-only',
          branch: 'fixture',
          defaultBranch: 'main',
          status: 'running',
          stage: 'comprehensive_review',
          taskAttempts: {},
          stageAttempts: {},
          reviewFindings: [],
          unresolvedFindings: [],
          ownerSessionId: 'foreign-display-only',
          lease: {
            sessionId: 'foreign-display-only',
            pid: process.pid,
            hostname: 'fixture.invalid',
            heartbeatAt: Date.now(),
          },
          config: DEFAULT_FROZEN_RUN_CONFIG,
          tasks: {
            '1': { taskId: 1, dependsOn: [], state: 'accepted', attempts: 1 },
          },
        });
        pi.appendEntry('plan-exec-view', {
          hidden: false,
          dismissed: [],
          selected: run.id,
        });
        log({ event: 'snapshot', runId: run.id });
        pi.sendUserMessage('/exec show ' + run.id, {
          expandPromptTemplates: true,
        });
        return;
      }
      if (args === 'evidence') {
        const runs = await registry.list();
        log({
          event: 'runs',
          runs: runs.map((run: PlanExecRun) => ({
            id: run.id,
            status: run.status,
            stage: run.stage,
            cwd: run.worktreeCwd,
            taskCount: Object.keys(run.tasks ?? {}).length,
            error: run.error,
            operation: run.activeOperation?.operationId,
            nativeId: run.activeOperation?.externalRunId,
            ownerLocal: run.lease?.hostname === hostname(),
          })),
        });
        ctx.ui.notify('Evidence recorded in the isolated sandbox.', 'info');
        return;
      }
      assert.fail('Unknown fixture command.');
    },
  });
}
