import assert from 'node:assert/strict';
import { test } from 'vitest';
import { materializeApprovedPlan, parsePlan } from '../src/plan.js';

test('approved structure carries only matching committed checkbox facts', () => {
  const baseline =
    '### Task 1: A\n- [x] repeated\n- [ ] repeated\n### Task 2: B\n- [ ] B\n';
  const approved =
    '# Reviewed description\n### Task 1: A\n- [ ] repeated\n- [x] repeated\n- [x] newly added\n```md\n- [x] example\n```\n### Task 2: B\ndependsOn: []\n- [x] B\n';
  const result = materializeApprovedPlan('plan.md', approved, baseline);
  assert.equal(
    result,
    '# Reviewed description\n### Task 1: A\n- [x] repeated\n- [ ] repeated\n- [ ] newly added\n```md\n- [x] example\n```\n### Task 2: B\ndependsOn: []\n- [ ] B\n',
  );
  assert.equal(
    parsePlan('plan.md', result).hash,
    parsePlan('plan.md', approved).hash,
  );
});

test('parses ordered tasks and keeps structure hash stable across checkbox completion', () => {
  const pending = parsePlan(
    'plan.md',
    `# Plan

### Task 1: First
- [ ] Do one

### Task 2: Second
- [ ] Do two
`,
  );
  const complete = parsePlan(
    'plan.md',
    `# Plan

### Task 1: First
- [x] Do one

### Task 2: Second
- [ ] Do two
`,
  );

  assert.equal(pending.tasks.length, 2);
  assert.deepEqual(pending.tasks[0]?.unchecked, ['Do one']);
  assert.deepEqual(complete.tasks[0]?.unchecked, []);
  assert.equal(pending.hash, complete.hash);
});

test('accepts lightweight heading variants and common checkbox markers', () => {
  const plan = parsePlan(
    'plan.md',
    `# Flexible plan

### P0 — Prepare
- [x] Existing work
* [ ] Remaining work

## Phase 2: Verify
1. [ ] Run the check

### Notes
\`\`\`markdown
- [ ] Example only
\`\`\`
`,
  );

  assert.deepEqual(
    plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      items: task.items,
    })),
    [
      {
        id: 1,
        title: 'Prepare',
        items: ['Existing work', 'Remaining work'],
      },
      { id: 2, title: 'Verify', items: ['Run the check'] },
    ],
  );
  assert.deepEqual(plan.tasks[0]?.unchecked, ['Remaining work']);
});

test('ignores task-looking headings and checkboxes inside fenced examples', () => {
  const plan = parsePlan(
    'plan.md',
    `### P0 — Real task
- [ ] Do the work

\`\`\`markdown
### P1 — Example task
- [ ] Example only
\`\`\`
`,
  );

  assert.equal(plan.tasks.length, 1);
  assert.deepEqual(plan.tasks[0]?.unchecked, ['Do the work']);
});

test('rejects malformed task numbering and missing checkboxes', () => {
  assert.throws(
    () => parsePlan('plan.md', '### Task 2: Wrong\n- [ ] Item\n'),
    /consecutive/,
  );
  assert.throws(
    () => parsePlan('plan.md', '### Task 1: Empty\nNo items\n'),
    /no checkbox/,
  );
});

test('explicit dependencies allow independent work while omitted dependencies remain sequential', () => {
  const plan = parsePlan(
    'plan.md',
    `### Task 1: A
- [ ] A
### Task 2: B
dependsOn: []
- [ ] B
### Task 3: C
dependsOn: [1]
- [ ] C
### Task 4: D
- [ ] D
`,
  );
  assert.deepEqual(
    plan.tasks.map((task) => task.dependsOn),
    [[], [], [1], [3]],
  );
});

test('dependency edits change plan identity while checkbox edits do not', () => {
  const source =
    '### Task 1: A\n- [ ] A\n### Task 2: B\ndependsOn: []\n- [ ] B\n';
  const independent = parsePlan('plan.md', source);
  assert.notEqual(
    independent.hash,
    parsePlan('plan.md', source.replace('[]', '[1]')).hash,
  );
  assert.equal(
    independent.hash,
    parsePlan('plan.md', source.replaceAll('[ ]', '[x]')).hash,
  );
});

for (const dependencies of [
  '[2]',
  '[3]',
  '[0]',
  '[-1]',
  '[1, 1]',
  '["1"]',
  'null',
  '{}',
  '[1.5]',
  '1',
  '[1,]',
]) {
  test(`rejects invalid dependencies ${dependencies} before execution`, () => {
    assert.throws(
      () =>
        parsePlan(
          'plan.md',
          `### Task 1: A
- [ ] A
### Task 2: B
dependsOn: ${dependencies}
- [ ] B
`,
        ),
      /dependsOn/,
    );
  });
}

test('rejects duplicate dependency declarations and ignores fenced examples', () => {
  assert.throws(
    () =>
      parsePlan(
        'plan.md',
        '### Task 1: A\ndependsOn: []\ndependsOn: []\n- [ ] A',
      ),
    /duplicate dependsOn/,
  );
  const plan = parsePlan(
    'plan.md',
    '### Task 1: A\n```yaml\ndependsOn: [99]\n```\n- [ ] A',
  );
  assert.deepEqual(plan.tasks[0]?.dependsOn, []);
});
