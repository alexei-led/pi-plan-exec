import assert from 'node:assert/strict';
import { test } from 'vitest';
import { taskSummary } from '../src/task-summary.js';
import type { TaskExecution } from '../src/types.js';

test('task summary uses only durable task states, including attention and verification', () => {
  const states: TaskExecution['state'][] = [
    'accepted',
    'ready',
    'running',
    'verifying',
    'retry_wait',
    'waiting_dependency',
    'waiting_external',
  ];
  const tasks = Object.fromEntries(
    states.map((state, taskId) => [
      String(taskId),
      {
        taskId,
        state,
        attempts: 0,
        dependsOn: [],
        ...(state === 'retry_wait' ? { reason: 'retry' } : {}),
      },
    ]),
  );
  const before = JSON.stringify(tasks);
  assert.deepEqual(taskSummary({ tasks }), {
    total: 7,
    accepted: 1,
    ready: 1,
    running: 2,
    retry: 1,
    dependency: 1,
    external: 1,
    attention: 2,
  });
  assert.equal(JSON.stringify(tasks), before);
  assert.deepEqual(taskSummary({}), {
    total: 0,
    accepted: 0,
    ready: 0,
    running: 0,
    retry: 0,
    dependency: 0,
    external: 0,
    attention: 0,
  });
});
