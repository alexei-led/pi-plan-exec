import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planExecExtension from "../src/index.js";
import { RunRegistry } from "../src/registry.js";

const plan = `# Add greeting endpoint

Goal: Add greeting endpoint

## Repository evidence
- \`src/index.ts\`: owns command registration for the package.
- \`test/index.test.ts\`: owns command-level behavior checks.

### Task 1: Add the endpoint contract beside existing commands
- [ ] Implement the request and response contract in \`src/index.ts\` using current command conventions.
- [ ] Add focused command coverage in \`test/index.test.ts\`.

### Task 2: Verify no execution worker is involved
- [ ] Confirm the endpoint does not call the controller, bridge, or run registry.
- [ ] Run \`npm test\` after the endpoint change.`;

interface RegisteredCommand {
  handler: (args: string, ctx: CommandContext) => Promise<void>;
}

interface RegisteredTool {
  execute: (
    toolCallId: string,
    params: { markdown: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Pick<CommandContext, "cwd" | "sessionManager">,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    terminate?: boolean;
  }>;
}

interface CommandContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  isIdle(): boolean;
  ui: { notify(message: string, level: string): void };
}

function isBlocked(value: unknown): boolean {
  return typeof value === "object" && value !== null && "block" in value && value.block === true;
}

function extensionHarness(root: string) {
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, (event: unknown, ctx: CommandContext) => Promise<unknown>>();
  const sentMessages: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const activeToolHistory: string[][] = [];
  let activeTools = ["read", "edit", "write", "subagent"];
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const pi = {
    events: { on() {}, emit() {} },
    on(event: string, handler: unknown) {
      const registered = handler as (
        event: unknown,
        ctx: CommandContext,
      ) => Promise<unknown>;
      const previous = events.get(event);
      events.set(
        event,
        previous
          ? async (nextEvent, ctx) => {
              await previous(nextEvent, ctx);
              return registered(nextEvent, ctx);
            }
          : registered,
      );
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as RegisteredCommand);
    },
    registerTool(tool: unknown) {
      const record = tool as { name: string } & RegisteredTool;
      tools.set(record.name, record);
    },
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
      activeToolHistory.push(activeTools);
    },
    async exec(command: string, args: string[]) {
      execCalls.push({ command, args });
      return { stdout: `${root}\n`, stderr: "", code: 0 };
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  planExecExtension(pi);
  const contextFor = (sessionId: string, idle = true): CommandContext => ({
    cwd: root,
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => idle,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });
  const context = contextFor("session-1");
  return {
    commands,
    tools,
    events,
    sentMessages,
    notifications,
    activeToolHistory,
    activeTools: () => activeTools,
    execCalls,
    context,
    contextFor,
  };
}

test("/goal uses the main session for read-only planning and finalizes without a run or child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-goal-command-"));
  const harness = extensionHarness(root);
  const goal = harness.commands.get("goal");
  const finalizer = harness.tools.get("finalize_goal_plan");
  assert.ok(goal);
  assert.ok(finalizer);

  await goal.handler("Add greeting endpoint", harness.context);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /at most 12 read-tool calls/);
  assert.deepEqual(harness.activeTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "finalize_goal_plan",
  ]);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(harness.execCalls, [
    { command: "git", args: ["rev-parse", "--show-toplevel"] },
  ]);

  const result = await finalizer.execute(
    "tool-1",
    { markdown: plan },
    undefined,
    undefined,
    { cwd: root, sessionManager: harness.context.sessionManager },
  );

  assert.equal(result.terminate, true);
  assert.equal(
    (result.content[0]?.text.match(/\/exec /gu) ?? []).length,
    1,
  );
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "subagent"]);
  assert.deepEqual(await new RunRegistry(join(root, "runs")).list(), []);
  assert.equal(harness.execCalls.length, 1);
  assert.equal(
    harness.notifications.some((entry) => /No run or child was started/.test(entry.message)),
    true,
  );
});

test("malformed finalization keeps edit and bash blocked until the goal turn settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-goal-invalid-"));
  const harness = extensionHarness(root);
  const goal = harness.commands.get("goal");
  const finalizer = harness.tools.get("finalize_goal_plan");
  const toolCall = harness.events.get("tool_call");
  const settled = harness.events.get("agent_settled");
  assert.ok(goal);
  assert.ok(finalizer);
  assert.ok(toolCall);
  assert.ok(settled);

  await goal.handler("Add greeting endpoint", harness.context);
  await assert.rejects(
    () =>
      finalizer.execute(
        "invalid-plan",
        { markdown: plan.replace("### Task 1:", "### Task 2:") },
        undefined,
        undefined,
        { cwd: root, sessionManager: harness.context.sessionManager },
      ),
    /Duplicate task number 2/,
  );

  assert.deepEqual(harness.activeTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "finalize_goal_plan",
  ]);
  assert.equal(isBlocked(await toolCall({ toolName: "edit" }, harness.context)), true);
  assert.equal(isBlocked(await toolCall({ toolName: "bash" }, harness.context)), true);

  await settled({}, harness.context);
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "subagent"]);
  assert.equal(await toolCall({ toolName: "edit" }, harness.context), undefined);
});

test("a rejected second /goal leaves the original preparation guard intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-goal-owner-"));
  const harness = extensionHarness(root);
  const goal = harness.commands.get("goal");
  const finalizer = harness.tools.get("finalize_goal_plan");
  assert.ok(goal);
  assert.ok(finalizer);

  await goal.handler("Add greeting endpoint", harness.context);
  await goal.handler("Add another endpoint", harness.contextFor("session-1", false));
  await goal.handler("Add a third endpoint", harness.context);

  assert.deepEqual(harness.activeTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "finalize_goal_plan",
  ]);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(
    harness.notifications.some((entry) => /Goal preparation requires an idle Pi session/.test(entry.message)),
    true,
  );
  assert.equal(
    harness.notifications.some((entry) => /Another goal preparation is already active/.test(entry.message)),
    true,
  );

  await finalizer.execute(
    "original-plan",
    { markdown: plan },
    undefined,
    undefined,
    { cwd: root, sessionManager: harness.context.sessionManager },
  );
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "subagent"]);
});

test("goal read budget is enforced by tool-call preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-goal-budget-"));
  const harness = extensionHarness(root);
  const goal = harness.commands.get("goal");
  const toolCall = harness.events.get("tool_call");
  assert.ok(goal);
  assert.ok(toolCall);

  await goal.handler("Add greeting endpoint", harness.context);
  for (let index = 0; index < 12; index += 1)
    assert.equal(await toolCall({ toolName: "read" }, harness.context), undefined);
  assert.equal(isBlocked(await toolCall({ toolName: "read" }, harness.context)), true);
});

test("cancelled goal preparation restores its previous tools without publishing a plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-goal-interrupted-"));
  const harness = extensionHarness(root);
  const goal = harness.commands.get("goal");
  const settled = harness.events.get("agent_settled");
  assert.ok(goal);
  assert.ok(settled);

  await goal.handler("Добавить русские сообщения статуса", harness.context);
  await settled({}, harness.context);

  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "subagent"]);
  assert.deepEqual(await readdir(root), []);
  assert.equal(
    harness.notifications.some((entry) => /without a validated ready plan/.test(entry.message)),
    true,
  );
});

test("session shutdown restores only its owner and does not leak preparation into a replacement session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-goal-session-switch-"));
  const harness = extensionHarness(root);
  const goal = harness.commands.get("goal");
  const toolCall = harness.events.get("tool_call");
  const shutdown = harness.events.get("session_shutdown");
  assert.ok(goal);
  assert.ok(toolCall);
  assert.ok(shutdown);

  await goal.handler("Add greeting endpoint", harness.context);
  await shutdown({}, harness.contextFor("session-2"));
  assert.equal(isBlocked(await toolCall({ toolName: "edit" }, harness.context)), true);

  await shutdown({}, harness.context);
  assert.deepEqual(harness.activeTools(), ["read", "edit", "write", "subagent"]);
  assert.equal(
    await toolCall({ toolName: "edit" }, harness.contextFor("session-2")),
    undefined,
  );
});
