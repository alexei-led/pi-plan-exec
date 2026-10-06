import { basename } from 'node:path';
import {
  stripTerminalSequences,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { parseAdvisoryObservation } from './advisory-observation.js';
import { isGoalRun, isInFlightStatus, isTerminalStatus } from './lifecycle.js';
import { taskProjectionSummary } from './task-projection.js';
import type { PlanExecRun } from './types.js';

export type ProgressTone = 'success' | 'warning' | 'error' | 'muted';
export interface ProgressView {
  title: string;
  label: string;
  tone: ProgressTone;
  accepted: number;
  total: number;
  detail: string;
  warning?: string;
}

function clean(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pendingCleanup(run: PlanExecRun): boolean {
  return Boolean(
    run.localOperationActive ||
      (run.activeOperation &&
        !run.activeOperation.processTreeExited &&
        !run.activeOperation.launchFenced),
  );
}

export function progressView(
  run: PlanExecRun,
  now = Date.now(),
  observing = false,
): ProgressView {
  const view = currentProgressView(run, now);
  const inFlight =
    isInFlightStatus(run.status) ||
    (run.status === 'paused' && pendingCleanup(run));
  if (inFlight && !observing)
    return {
      ...view,
      label: `${view.label} · Snapshot`,
      tone: 'warning',
      detail: `Saved: ${view.detail}`,
      warning: 'No live updates here · /exec status',
    };
  return view;
}

function currentProgressView(run: PlanExecRun, now: number): ProgressView {
  const summary = taskProjectionSummary(run);
  const title = isGoalRun(run)
    ? run.goal.text
    : basename(run.planPath ?? 'Plan')
        .replace(/\.md$/i, '')
        .replace(/^\d{4}-\d{2}-\d{2}-/, '')
        .replace(/[-_]+/g, ' ');
  const active = Object.values(run.tasks ?? {}).find(
    (task) => task.state === 'running' || task.state === 'verifying',
  );
  const view: ProgressView = {
    title: clean(title),
    label: '● Working',
    tone: 'success',
    accepted: summary.accepted,
    total: summary.total,
    detail: isGoalRun(run)
      ? `Turn ${run.goal.iteration}`
      : active
        ? `Task ${active.taskId} of ${summary.total} · ${active.state === 'verifying' ? 'verifying' : 'implementing'}`
        : 'Preparing the next task',
  };
  if (run.status === 'cancel_pending') {
    return {
      ...view,
      label: '◌ Cancelling',
      tone: 'warning',
      detail: 'Stop requested · worker exit not confirmed',
    };
  }
  if (run.status === 'paused') {
    const stopping = pendingCleanup(run);
    return {
      ...view,
      label: stopping ? '◌ Pausing' : 'Ⅱ Paused',
      tone: stopping ? 'warning' : 'muted',
      detail: stopping
        ? 'Stop requested · worker exit not confirmed'
        : 'Checkpoint saved · resume when ready',
    };
  }
  if (run.status === 'cancelled')
    return {
      ...view,
      label: '× Cancelled',
      tone: 'muted',
      detail: 'Run ended · saved work preserved',
    };
  if (run.status === 'failed')
    return {
      ...view,
      label: '! Failed',
      tone: 'error',
      detail: 'Inspect /exec status for recovery',
      warning: 'Recovery needs attention',
    };
  if (run.status === 'completed')
    return {
      ...view,
      label: '✓ Complete',
      detail: 'Required checks and review finished',
    };
  if (run.status === 'completed_with_findings')
    return {
      ...view,
      label: '! Complete with findings',
      tone: 'warning',
      detail: 'Inspect unresolved findings with /exec status',
    };
  if (run.status === 'skip_pending')
    return {
      ...view,
      label: '◌ Stopping optional stage',
      tone: 'warning',
      detail: 'Waiting for confirmed worker exit',
    };
  if (
    run.activeOperation?.lastObservedState === 'unknown_launch' ||
    run.activeOperation?.lastStatusError ||
    run.activeOperation?.diagnostics?.assessment === 'status_unavailable'
  ) {
    return {
      ...view,
      label: '? Worker status unknown',
      tone: 'warning',
      detail: 'Checking the same operation · no replacement worker',
    };
  }
  if (run.activeOperation?.lastObservedState === 'paused')
    return {
      ...view,
      label: 'Ⅱ Operation paused',
      tone: 'warning',
      detail: 'Still tracking the same operation · inspect /exec status',
    };
  if (summary.external > 0 || run.activeOperation?.externalPrerequisite) {
    if (active && !run.activeOperation?.externalPrerequisite)
      return {
        ...view,
        label: `● Working · ${summary.external} task${summary.external === 1 ? '' : 's'} waiting`,
        tone: 'warning',
      };
    return {
      ...view,
      label: '◌ Waiting on prerequisite',
      tone: 'warning',
      detail: 'External prerequisite · inspect /exec status',
    };
  }
  const taskRetryAt = Math.min(
    ...Object.values(run.tasks ?? {})
      .filter(
        (task) =>
          task.state === 'retry_wait' && (task.nextAttemptAt ?? 0) > now,
      )
      .map((task) => task.nextAttemptAt ?? Infinity),
  );
  const retryAt =
    (run.nextAttemptAt ?? 0) > now
      ? run.nextAttemptAt
      : Number.isFinite(taskRetryAt)
        ? taskRetryAt
        : undefined;
  if (retryAt && retryAt > now)
    return {
      ...view,
      label: '↻ Retry scheduled',
      tone: 'warning',
      detail: `Retry in ${Math.ceil((retryAt - now) / 1000)}s · pause to prevent retry`,
    };
  if (run.needsAttention || run.blocked)
    return {
      ...view,
      label: '! Needs attention',
      tone: 'warning',
      detail: 'Inspect /exec status for the blocker',
    };
  if (run.stage.includes('review'))
    return {
      ...view,
      label: '◇ Reviewing',
      detail: 'Implementation accepted · review still required',
    };
  if (run.stage === 'finalize')
    return {
      ...view,
      label: '● Checking',
      detail: 'Running final verification',
    };
  if (run.stage === 'archive')
    return {
      ...view,
      label: '● Finishing',
      detail: 'Archiving the checked result',
    };
  if (run.status === 'starting')
    return {
      ...view,
      label: '● Preparing',
      detail: 'Preparing the execution workspace',
    };
  const advisory = parseAdvisoryObservation(
    run.activeOperation?.advisoryObservation,
    run.activeOperation?.externalRunId,
    now,
  );
  if (advisory?.activity?.currentTool)
    view.detail += ` · reported: ${advisory.activity.currentTool}`;
  return view;
}

export function renderProgressStrip(
  run: PlanExecRun,
  width = 100,
  color: (tone: ProgressTone | 'text', text: string) => string = (
    _tone,
    text,
  ) => text,
  now = Date.now(),
  observing = false,
): string[] {
  const view = progressView(run, now, observing);
  const columns = Math.max(0, Math.floor(width));
  const slots = Math.min(12, Math.max(2, Math.floor(columns / 6)));
  const filled = view.total
    ? Math.floor((view.accepted / view.total) * slots)
    : 0;
  const bar = color(view.tone, '█'.repeat(filled) + '░'.repeat(slots - filled));
  const count = view.total
    ? `${view.accepted}/${view.total} accepted`
    : isGoalRun(run)
      ? 'Goal'
      : 'Preparing plan';
  return [
    `${color(view.tone, view.label)}${color('text', ` · ${view.title}`)}`,
    `${bar}${color('text', ` ${count} · ${view.detail}`)}`,
    ...(view.warning ? [color(view.tone, view.warning)] : []),
  ].map((line) => truncateToWidth(line, columns));
}

export interface ViewPreferences {
  hidden: boolean;
  dismissed: string[];
  selected?: string;
}
export const VIEW_ENTRY = 'plan-exec-view';

export function readViewPreferences(
  entries: readonly unknown[],
): ViewPreferences | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('type' in entry) ||
      entry.type !== 'custom' ||
      !('customType' in entry) ||
      entry.customType !== VIEW_ENTRY ||
      !('data' in entry)
    )
      continue;
    const data = entry.data;
    if (
      !data ||
      typeof data !== 'object' ||
      !('hidden' in data) ||
      typeof data.hidden !== 'boolean' ||
      !('dismissed' in data) ||
      !Array.isArray(data.dismissed) ||
      !data.dismissed.every((id: unknown) => typeof id === 'string')
    )
      continue;
    return {
      hidden: data.hidden,
      dismissed: data.dismissed,
      ...('selected' in data && typeof data.selected === 'string'
        ? { selected: data.selected }
        : {}),
    };
  }
  return undefined;
}

/** Presentation only: never claims, resumes, or mutates an execution record. */
export class RunPresentation {
  private readonly runs = new Map<string, PlanExecRun>();
  private readonly removed = new Set<string>();
  private hidden = false;
  private readonly dismissed = new Set<string>();
  private selected: string | undefined;

  constructor(preferences?: ViewPreferences) {
    this.restorePreferences(preferences);
  }
  restorePreferences(preferences?: ViewPreferences): void {
    this.hidden = preferences?.hidden ?? false;
    this.dismissed.clear();
    for (const id of preferences?.dismissed ?? []) this.dismissed.add(id);
    this.selected = preferences?.selected;
  }
  preferences(): ViewPreferences {
    return {
      hidden: this.hidden,
      dismissed: [...this.dismissed],
      ...(this.selected ? { selected: this.selected } : {}),
    };
  }
  remember(run: PlanExecRun): void {
    if (this.removed.has(run.id)) return;
    const previous = this.runs.get(run.id);
    if (
      previous &&
      (previous.revision ?? previous.updatedAt) >
        (run.revision ?? run.updatedAt)
    )
      return;
    this.runs.set(run.id, run);
  }
  reconcile(runs: PlanExecRun[]): void {
    const ids = new Set(runs.map((run) => run.id));
    for (const id of this.runs.keys())
      if (!ids.has(id)) {
        this.runs.delete(id);
        this.removed.add(id);
      }
    for (const run of runs) this.remember(run);
  }
  current(): PlanExecRun | undefined {
    if (this.hidden) return undefined;
    const selected = this.selected && this.runs.get(this.selected);
    if (selected && !this.dismissed.has(selected.id)) return selected;
    return [...this.runs.values()]
      .filter((run) => !this.dismissed.has(run.id))
      .sort(
        (a, b) =>
          Number(isTerminalStatus(a.status)) -
            Number(isTerminalStatus(b.status)) ||
          b.updatedAt - a.updatedAt ||
          a.id.localeCompare(b.id),
      )[0];
  }
  hide(): void {
    this.hidden = true;
  }
  show(id?: string): void {
    if (id && !this.runs.has(id))
      throw new Error('Run not found in this project.');
    this.hidden = false;
    if (id) {
      this.dismissed.delete(id);
      this.selected = id;
    } else {
      this.dismissed.clear();
      this.selected = undefined;
    }
  }
  clear(id?: string): void {
    const target = id ?? this.current()?.id;
    if (id && !this.runs.has(id))
      throw new Error('Run not found in this project.');
    if (target) this.dismissed.add(target);
    if (this.selected === target) this.selected = undefined;
  }
}
