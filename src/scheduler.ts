import { required } from './required.js';
import type { PlanTask, TaskExecution } from './types.js';

const DEPENDENCY_PROBE_DELAY_MS = 30_000;

export function reconcileTasks(
  plan: PlanTask[],
  existing: Record<string, TaskExecution> = {},
  now = Date.now(),
): Record<string, TaskExecution> {
  const tasks = Object.fromEntries(
    plan.map((task) => [
      String(task.id),
      existing[String(task.id)]
        ? {
            ...required(existing[String(task.id)]),
            dependsOn: [...task.dependsOn],
          }
        : ({
            taskId: task.id,
            dependsOn: [...task.dependsOn],
            state: task.unchecked.length === 0 ? 'accepted' : 'ready',
            attempts: 0,
          } satisfies TaskExecution),
    ]),
  );
  for (const task of Object.values(tasks)) {
    if (['accepted', 'running', 'verifying'].includes(task.state)) continue;
    if (task.dependsOn.some((id) => tasks[String(id)]?.state !== 'accepted')) {
      tasks[String(task.taskId)] = { ...task, state: 'waiting_dependency' };
    } else if ((task.nextAttemptAt ?? 0) <= now) {
      tasks[String(task.taskId)] = { ...task, state: 'ready' };
    } else {
      tasks[String(task.taskId)] = {
        ...task,
        state: task.externalPrerequisite ? 'waiting_external' : 'retry_wait',
      };
    }
  }
  return tasks;
}

export function selectReadyTask(
  tasks: Record<string, TaskExecution>,
): TaskExecution | undefined {
  return Object.values(tasks)
    .filter((task) => task.state === 'ready')
    .sort(
      (a, b) =>
        (a.lastScheduledAt ?? 0) - (b.lastScheduledAt ?? 0) ||
        a.taskId - b.taskId,
    )[0];
}

export function nextTaskWake(
  tasks: Record<string, TaskExecution>,
  now: number,
): number {
  const wakeTimes = Object.values(tasks)
    .filter(
      (task) =>
        task.state === 'retry_wait' || task.state === 'waiting_external',
    )
    .map((task) => Math.max(task.nextAttemptAt ?? now, now));
  return wakeTimes.length
    ? Math.min(...wakeTimes)
    : now + DEPENDENCY_PROBE_DELAY_MS;
}
