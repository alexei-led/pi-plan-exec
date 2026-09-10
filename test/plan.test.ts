import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan } from "../src/plan.js";

test("parses ordered tasks and keeps structure hash stable across checkbox completion", () => {
  const pending = parsePlan(
    "plan.md",
    `# Plan

### Task 1: First
- [ ] Do one

### Task 2: Second
- [ ] Do two
`,
  );
  const complete = parsePlan(
    "plan.md",
    `# Plan

### Task 1: First
- [x] Do one

### Task 2: Second
- [ ] Do two
`,
  );

  assert.equal(pending.tasks.length, 2);
  assert.deepEqual(pending.tasks[0]?.unchecked, ["Do one"]);
  assert.deepEqual(complete.tasks[0]?.unchecked, []);
  assert.equal(pending.hash, complete.hash);
});

test("accepts lightweight heading variants and common checkbox markers", () => {
  const plan = parsePlan(
    "plan.md",
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
    plan.tasks.map((task) => ({ id: task.id, title: task.title, items: task.items })),
    [
      {
        id: 1,
        title: "Prepare",
        items: ["Existing work", "Remaining work"],
      },
      { id: 2, title: "Verify", items: ["Run the check"] },
    ],
  );
  assert.deepEqual(plan.tasks[0]?.unchecked, ["Remaining work"]);
});

test("ignores task-looking headings and checkboxes inside fenced examples", () => {
  const plan = parsePlan(
    "plan.md",
    `### P0 — Real task
- [ ] Do the work

\`\`\`markdown
### P1 — Example task
- [ ] Example only
\`\`\`
`,
  );

  assert.equal(plan.tasks.length, 1);
  assert.deepEqual(plan.tasks[0]?.unchecked, ["Do the work"]);
});

test("rejects malformed task numbering and missing checkboxes", () => {
  assert.throws(
    () => parsePlan("plan.md", "### Task 2: Wrong\n- [ ] Item\n"),
    /consecutive/,
  );
  assert.throws(
    () => parsePlan("plan.md", "### Task 1: Empty\nNo items\n"),
    /no checkbox/,
  );
});
