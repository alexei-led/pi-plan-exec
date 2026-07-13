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
