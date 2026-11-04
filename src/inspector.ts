import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { ExecutionPreview } from './controller.js';
import { isGoalRun } from './lifecycle.js';
import { taskSummary } from './task-summary.js';
import type { PlanExecRun } from './types.js';

export function executionPreviewText(preview: ExecutionPreview): string {
  const config = preview.config;
  return display(
    [
      `Target: ${preview.cwd}`,
      `Branch: ${preview.branch}`,
      `Worker: ${config.workerAgent} · ${config.workerModel ?? 'inherit parent model'}`,
      `Review: ${config.reviewRequired ? 'required' : 'optional'} · ${config.reviewBackend} · ${config.reviewerAgent} · ${config.reviewerModel ?? 'inherit parent model'}`,
      `Lifetime: ${config.executionLifetime.mode === 'bounded' ? config.executionLifetime.timeoutMs + 'ms requested' : 'unbounded requested; native child defaults still apply'}`,
      'Turn settings are requested, not native-enforced limits.',
      'Bootstrap argv:',
      ...(preview.kind === 'plan' && config.bootstrapCommands.length
        ? config.bootstrapCommands.map((command) => JSON.stringify(command))
        : ['none']),
      'Required check argv:',
      ...(config.requiredChecks.length
        ? config.requiredChecks.map((command) => JSON.stringify(command))
        : ['none']),
      'This is the current configuration; the run freezes it when started.',
      'A worktree is not a sandbox. Repository commands run with your permissions.',
    ].join('\n'),
  );
}

export type InspectorAction = 'resume' | 'pause' | 'cancel';
export type InspectorResult =
  | { kind: 'closed' }
  | { kind: 'text'; text: string }
  | { kind: 'action'; action: InspectorAction };

function display(value: string): string {
  return stripTerminalSequences(value).replace(
    /[\p{Cc}\p{Bidi_Control}]/gu,
    (character) => (character === '\n' ? character : ' '),
  );
}

export function inspectorSections(
  run: PlanExecRun,
  evidence: string,
): Record<string, string> {
  const summary = taskSummary(run);
  const checks = run.config.requiredChecks.map((command) => command.join(' '));
  return {
    Overview: display(
      [
        `${isGoalRun(run) ? 'Goal' : 'Plan'} ${run.id}`,
        run.goal?.text ?? run.planPath ?? '',
        `State: ${run.status} · ${run.stage}`,
        isGoalRun(run)
          ? `Turn ${run.goal.iteration}/${run.goal.maxTurns}`
          : `${summary.accepted}/${summary.total} accepted; required review/checks are separate gates`,
        `Saved: ${new Date(run.updatedAt).toISOString()}`,
        run.blocked?.reason ?? run.error ?? run.wakeReason ?? '',
        run.blocked?.nextStep ? `Next: ${run.blocked.nextStep}` : '',
        `Details: /exec status ${run.id}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    Tasks: display(
      isGoalRun(run)
        ? 'Goal runs have no task DAG.\n' +
            (run.goal.lastOutcome ?? 'No turn outcome recorded.')
        : Object.values(run.tasks ?? {})
            .map(
              (task) =>
                `Task ${task.taskId}: ${task.state} · ${task.attempts} attempt(s)${task.reason ? '\n  ' + task.reason : ''}`,
            )
            .join('\n') || 'No task state recorded.',
    ),
    'Checks and review': display(
      [
        `Review: ${run.config.reviewRequired ? 'required' : 'optional'} · ${run.config.reviewBackend}`,
        `Reviewed commit: ${run.reviewedCommit ?? 'not verified'}`,
        `Checked commit: ${run.verifiedCommit ?? 'not verified'}`,
        'Required checks:',
        ...(checks.length ? checks : ['None configured']),
        `Worker turn limit: ${run.config.workerMaxTurns} requested, not enforced by native RPC`,
        `Goal iteration budget: ${run.config.maxTaskIterations}; not a plan retry limit`,
        'Native child timeouts may still apply to unbounded requests.',
        'taskRetries, reviewIterations and fusionIterations are legacy diagnostic settings, not enforced retry caps.',
      ].join('\n'),
    ),
    'Ownership evidence': display(evidence),
  };
}

/** A snapshot picker: every returned action remains bound to the displayed full ID. */
export async function inspectRun(
  ctx: ExtensionContext,
  run: PlanExecRun,
  evidence: string,
  actions: readonly InspectorAction[],
): Promise<InspectorResult> {
  if (ctx.mode !== 'tui') return { kind: 'text', text: evidence };
  const sections = inspectorSections(run, evidence);
  const labels = new Map(
    actions.map((action) => [
      `${action[0]?.toUpperCase()}${action.slice(1)} this run`,
      action,
    ]),
  );
  const choice = await ctx.ui.select(
    `${isGoalRun(run) ? 'Goal' : 'Plan'} ${run.id} · ${run.status}`,
    [...Object.keys(sections), ...labels.keys()],
  );
  if (!choice) return { kind: 'closed' };
  const section = sections[choice];
  if (section !== undefined) return { kind: 'text', text: section };
  const action = labels.get(choice);
  if (!action) return { kind: 'closed' };
  if (
    action === 'cancel' &&
    !(await ctx.ui.confirm(
      'Cancel this run finally?',
      `Run ${run.id}\nSaved work stays. Worker retirement is tracked separately. Use pause to continue later.`,
    ))
  )
    return { kind: 'closed' };
  return { kind: 'action', action };
}
