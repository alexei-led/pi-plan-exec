import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  beginGoalPreparation,
  finalizeGoalPlan,
  goalPreparationMessage,
  publishNewFile,
  renderGoalPlan,
  validateGoalPlan,
} from "../src/goal.js";
import { RunRegistry } from "../src/registry.js";

async function repository(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-plan-exec-goal-"));
}

const englishPlan = `# Add greeting endpoint

Goal: Add greeting endpoint

## Repository evidence
- \`src/index.ts\`: registers Pi commands and is the command integration point.
- \`test/index.test.ts\`: owns command-facing regression coverage.

### Task 1: Add the endpoint contract beside the existing command surface
- [ ] Define the greeting request and response behavior in \`src/index.ts\` using the repository's current command conventions.
- [ ] Add focused command coverage in \`test/index.test.ts\` for the successful endpoint response.

### Task 2: Verify the endpoint remains isolated from execution startup
- [ ] Confirm the new endpoint does not invoke the execution controller or bridge worker path.
- [ ] Run \`npm test\` and the focused command test after the change.`;

const russianPlan = `# Подготовить локализацию статуса

Goal: Добавить русские сообщения статуса

## Repository evidence
- \`src/index.ts\`: форматирует сообщения статуса и команды расширения.
- \`docs/guide.md\`: описывает пользовательские команды пакета.

### Task 1: Выделить сообщения статуса для локализации
- [ ] Обновить конкретные строки статуса в \`src/index.ts\`, сохранив существующие идентификаторы команд.
- [ ] Добавить проверки русских сообщений в \`test/index.test.ts\`.

### Task 2: Документировать и проверить пользовательский путь
- [ ] Синхронизировать пример статуса в \`docs/guide.md\` с фактическим выводом.
- [ ] Запустить \`npm run check\` и \`npm test\`.`;

test("goal finalization publishes a repository-grounded English plan with bound hashes", async () => {
  const root = await repository();
  const pending = await beginGoalPreparation({
    repositoryRoot: root,
    goal: "Add greeting endpoint",
  });
  assert.equal(pending.state, "preparing");
  assert.deepEqual(await readdir(root), []);
  assert.equal(englishPlan.includes("Goal: Add greeting endpoint"), true);

  const prepared = await finalizeGoalPlan({
    repositoryRoot: root,
    goal: "Add greeting endpoint",
    markdown: englishPlan,
  });
  const content = await readFile(prepared.path, "utf8");
  const { metadata, plan } = validateGoalPlan(
    prepared.path,
    content,
    "Add greeting endpoint",
  );

  assert.equal(prepared.state, "ready");
  assert.equal(prepared.reused, false);
  assert.equal(metadata.goalId, prepared.goalId);
  assert.equal(metadata.goalHash, prepared.goalHash);
  assert.equal(metadata.planHash, prepared.planHash);
  assert.equal(plan.hash, prepared.planHash);
  assert.match(content, /^preparation_status: ready$/m);
  assert.match(content, /^document_hash: [0-9a-f]{64}$/m);
  assert.match(content, /^## Repository evidence$/m);
  assert.throws(
    () =>
      validateGoalPlan(
        prepared.path,
        content.replace("Goal: Add greeting endpoint", "Goal: Add another endpoint"),
        "Add greeting endpoint",
      ),
    /metadata is not bound to its content/,
  );

  const message = goalPreparationMessage(prepared, "docs/plans/goal-plan.md");
  assert.equal((message.match(/\/exec /gu) ?? []).length, 1);
  assert.match(message, /Next action: \/exec docs\/plans\/goal-plan\.md$/);
});

test("goal finalization accepts realistic Russian goals and binds their content", async () => {
  const root = await repository();
  const prepared = await finalizeGoalPlan({
    repositoryRoot: root,
    goal: "Добавить русские сообщения статуса",
    markdown: russianPlan,
  });
  const content = await readFile(prepared.path, "utf8");

  assert.equal(prepared.state, "ready");
  assert.doesNotThrow(() =>
    validateGoalPlan(
      prepared.path,
      content,
      "Добавить русские сообщения статуса",
    ),
  );
  assert.throws(
    () => validateGoalPlan(prepared.path, content, "Добавить английский статус"),
    /metadata is not bound to its content/,
  );
});

test("goal finalization rejects malformed or ungrounded model output", async () => {
  const malformed = englishPlan.replace("### Task 1:", "### Task 2:");
  assert.throws(
    () => renderGoalPlan("Add greeting endpoint", malformed),
    /Duplicate task number 2/,
  );
  assert.throws(
    () =>
      renderGoalPlan(
        "Add greeting endpoint",
        englishPlan.replace("## Repository evidence", "## Evidence"),
      ),
    /must cite inspected repository paths/,
  );
});

test("ready goal retry reuses its validated bytes while an edit is refused", async () => {
  const root = await repository();
  const first = await finalizeGoalPlan({
    repositoryRoot: root,
    goal: "Add greeting endpoint",
    markdown: englishPlan,
  });
  const before = await readFile(first.path, "utf8");
  const retry = await beginGoalPreparation({
    repositoryRoot: root,
    goal: "Add   greeting\nendpoint",
  });

  assert.equal(retry.state, "ready");
  assert.equal(retry.reused, true);
  assert.equal(retry.path, first.path);
  assert.equal(await readFile(first.path, "utf8"), before);

  await writeFile(first.path, `${before}\nUser notes\n`, "utf8");
  await assert.rejects(
    () => beginGoalPreparation({ repositoryRoot: root, goal: "Add greeting endpoint" }),
    /Refusing to overwrite user-edited or incomplete goal plan/,
  );
});

test("atomic publication creates without overwrite and never exposes a partial destination", async () => {
  const root = await repository();
  const path = join(root, "docs", "plans", "published.md");
  const content = renderGoalPlan("Add greeting endpoint", englishPlan);
  const [first, second] = await Promise.all([
    publishNewFile(path, content),
    publishNewFile(path, content),
  ]);

  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(await readFile(path, "utf8"), content);
  assert.equal(await publishNewFile(path, "replacement"), false);
  assert.equal(await readFile(path, "utf8"), content);
  assert.deepEqual(
    (await readdir(join(root, "docs", "plans"))).sort(),
    ["published.md"],
  );
});

test("preparation creates no execution run or child-facing artifact before finalization", async () => {
  const root = await repository();
  const registry = new RunRegistry(join(root, "runs"));

  const pending = await beginGoalPreparation({
    repositoryRoot: root,
    goal: "Add greeting endpoint",
  });

  assert.equal(pending.state, "preparing");
  assert.deepEqual(await registry.list(), []);
  assert.deepEqual(await readdir(root), []);
});
