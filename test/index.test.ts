import assert from "node:assert/strict";
import test from "node:test";
import {
  execHelp,
  execSetup,
  formatRunList,
  formatRunStatus,
  getExecArgumentCompletions,
  missingRuntimeTools,
} from "../src/index.js";
import type { PlanExecRun } from "../src/types.js";

const config = {
  taskRetries: 1,
  maxTaskIterations: 50,
  reviewIterations: 5,
  fusionIterations: 10,
  finalizeEnabled: true,
  workerAgent: "worker",
  workerMaxTurns: 50,
  reviewerAgent: "reviewer",
  reviewerMaxTurns: 30,
  statsAgent: "reviewer",
  statsMaxTurns: 30,
};

function run(overrides: Partial<PlanExecRun> = {}): PlanExecRun {
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    repositoryRoot: "/repo",
    planPath: "/repo/docs/plans/example.md",
    planHash: "hash",
    worktreeCwd: "/repo",
    branch: "feature",
    defaultBranch: "main",
    status: "running",
    stage: "implementation",
    taskAttempts: {},
    stageAttempts: {},
    reviewFindings: [],
    progressPath: "/repo/.ralphex/progress.txt",
    activeOperation: {
      operationId: "operation-1",
      service: "bridge",
      kind: "implementation",
      taskId: 1,
    },
    config,
    createdAt: 1,
    updatedAt: Date.now(),
    unresolvedFindings: [],
    ...overrides,
  };
}

test("exec command completions explain the command family", () => {
  const items = getExecArgumentCompletions("st");
  assert.deepEqual(
    items?.map((item) => item.value),
    ["start", "status"],
  );
  assert.match(items?.[0]?.description ?? "", /Start a plan/);
  assert.match(
    getExecArgumentCompletions("")
      ?.map((item) => item.value)
      .join(" ") ?? "",
    /setup/,
  );
});

test("runtime prerequisite check identifies missing provider extensions", () => {
  assert.deepEqual(missingRuntimeTools(["TaskCreate"]), ["pi-subagents"]);
  assert.deepEqual(missingRuntimeTools(["subagent", "TaskCreate"]), []);
});

test("help and setup explain the installed command surface", () => {
  assert.match(execHelp(), /\/exec status \[run-id\]/);
  assert.match(execHelp(), /\/skill:exec-plan/);
  assert.match(execSetup(), /pi install npm:@alexeiled\/pi-fusion/);
  assert.match(execSetup(), /pi install npm:@alexeiled\/pi-plan-exec/);
});

test("run status includes live operation, progress, and recovery hints", () => {
  const status = formatRunStatus(
    run({ status: "failed", error: "Plan structure changed" }),
  );
  assert.match(status, /status: failed/);
  assert.match(status, /operation: bridge\/implementation \(Task 1\)/);
  assert.match(status, /progress: \/repo\/\.ralphex\/progress\.txt/);
  assert.match(status, /error: Plan structure changed/);
  assert.match(status, /worktree preserved/);
});

test("run status distinguishes unavailable observation from normal polling", () => {
  const status = formatRunStatus(
    run({
      activeOperation: {
        operationId: "operation-1",
        service: "bridge",
        kind: "implementation",
        taskId: 1,
        statusFailures: 2,
        lastStatusError: "bridge unavailable",
      },
    }),
  );
  assert.match(status, /observation: unavailable \(2\/3\)/);
  assert.match(status, /bridge unavailable/);
});

test("run list tells users how to inspect an unambiguous run", () => {
  const list = formatRunList([run()]);
  assert.match(list, /example\.md running\/implementation/);
  assert.match(list, /\/exec status/);
});
