import type { PlanExecRun } from './types.js';

export const TASK_EXECUTION_STATE = {
  READY: 'ready',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  RETRY_WAIT: 'retry_wait',
  WAITING_DEPENDENCY: 'waiting_dependency',
  WAITING_EXTERNAL: 'waiting_external',
  ACCEPTED: 'accepted',
} as const;

export interface TaskSummary {
  total: number;
  accepted: number;
  ready: number;
  running: number;
  retry: number;
  dependency: number;
  external: number;
  attention: number;
}

/** Summarise durable task state without reading any external state. */
export function taskSummary(run: Pick<PlanExecRun, 'tasks'>): TaskSummary {
  const tasks = Object.values(run.tasks ?? {});
  const summary: TaskSummary = {
    total: tasks.length,
    accepted: 0,
    ready: 0,
    running: 0,
    retry: 0,
    dependency: 0,
    external: 0,
    attention: 0,
  };
  for (const task of tasks) {
    if (task.state === TASK_EXECUTION_STATE.ACCEPTED) summary.accepted += 1;
    else if (task.state === TASK_EXECUTION_STATE.READY) summary.ready += 1;
    else if (
      task.state === TASK_EXECUTION_STATE.RUNNING ||
      task.state === TASK_EXECUTION_STATE.VERIFYING
    )
      summary.running += 1;
    else if (task.state === TASK_EXECUTION_STATE.RETRY_WAIT) summary.retry += 1;
    else if (task.state === TASK_EXECUTION_STATE.WAITING_DEPENDENCY)
      summary.dependency += 1;
    else if (task.state === TASK_EXECUTION_STATE.WAITING_EXTERNAL)
      summary.external += 1;
    if (task.reason || task.state === TASK_EXECUTION_STATE.WAITING_EXTERNAL)
      summary.attention += 1;
  }
  return summary;
}
