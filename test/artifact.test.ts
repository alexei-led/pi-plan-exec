import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readSettledWorkflowCompletion,
  readSubagentArtifact,
} from "../src/artifact.js";

test("uses pi-subagents status recentOutput when no configured result path exists", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      steps: [{ recentOutput: ["Reviewed the change.", "NO_FINDINGS"] }],
    }),
  );
  assert.equal(
    await readSubagentArtifact(undefined, asyncDir),
    "Reviewed the change.\nNO_FINDINGS",
  );
});

test("uses the durable async output before truncated status recentOutput", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const asyncDir = join(root, "async");
  const artifactsDir = join(root, "artifacts");
  await mkdir(asyncDir);
  await mkdir(artifactsDir);
  await writeFile(
    join(artifactsDir, "review-run_reviewer_output.md"),
    "FINDING: MAJOR | first finding\nEvidence: complete output",
  );
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      runId: "review-run",
      artifactsDir,
      steps: [{ recentOutput: ["Evidence: complete output"] }],
    }),
  );
  assert.equal(
    await readSubagentArtifact(undefined, asyncDir),
    "FINDING: MAJOR | first finding\nEvidence: complete output",
  );
});

test("uses the latest durable output when a retry produced multiple artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const asyncDir = join(root, "async");
  const artifactsDir = join(root, "artifacts");
  await mkdir(asyncDir);
  await mkdir(artifactsDir);
  await writeFile(join(artifactsDir, "review-run_01_output.md"), "old");
  await writeFile(
    join(artifactsDir, "review-run_02_output.md"),
    "FINDING: MAJOR | complete retry output",
  );
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      runId: "review-run",
      artifactsDir,
      steps: [{ recentOutput: ["truncated tail"] }],
    }),
  );

  assert.equal(
    await readSubagentArtifact(undefined, asyncDir),
    "FINDING: MAJOR | complete retry output",
  );
});

test("falls back when an explicit result artifact is metadata-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const asyncDir = join(root, "async");
  await mkdir(asyncDir);
  const result = join(root, "result.json");
  await writeFile(result, JSON.stringify({ state: "complete" }));
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      steps: [{ recentOutput: ["NO_FINDINGS"] }],
    }),
  );
  assert.equal(await readSubagentArtifact(result, asyncDir), "NO_FINDINGS");
});

test("uses the single workflow child output instead of the workflow summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const result = join(root, "result.json");
  await writeFile(
    result,
    JSON.stringify({
      mode: "workflow",
      output: "Workflow completed successfully (1 child).",
      results: [{ agent: "main", output: "NO_FINDINGS" }],
    }),
  );

  assert.equal(await readSubagentArtifact(result, undefined), "NO_FINDINGS");
});

test("uses an explicit output artifact before status fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const asyncDir = join(root, "async");
  await mkdir(asyncDir);
  const result = join(root, "result.json");
  await writeFile(result, JSON.stringify({ output: "NO_FINDINGS" }));
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      steps: [{ recentOutput: ["wrong fallback"] }],
    }),
  );
  assert.equal(await readSubagentArtifact(result, asyncDir), "NO_FINDINGS");
});

test("recognizes a settled detached workflow from its result artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const result = join(root, "result.json");
  await writeFile(
    result,
    JSON.stringify({
      mode: "workflow",
      state: "failed",
      workflowResolution: "settled-awaiting-resume",
      results: [{ success: true, output: "NO_FINDINGS" }],
    }),
  );

  assert.deepEqual(await readSettledWorkflowCompletion(result, undefined), {
    output: "NO_FINDINGS",
  });
});

test("recovers a settled detached workflow after its result was archived", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const runId = "workflow-1";
  const asyncDir = join(root, "async-subagent-runs", runId);
  const archiveDir = join(
    root,
    "async-subagent-results",
    "output-archives",
  );
  await mkdir(asyncDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(
    join(asyncDir, "status.json"),
    JSON.stringify({
      runId,
      mode: "workflow",
      state: "failed",
      steps: [
        {
          workflowKey: "main",
          parentWorkflowRunId: runId,
          status: "completed",
        },
      ],
    }),
  );
  await writeFile(
    join(asyncDir, "workflow-receipt.json"),
    JSON.stringify({
      workflowRunId: runId,
      state: "failed",
      workflowResolution: "settled-awaiting-resume",
      entries: { main: { key: "main" } },
    }),
  );
  await writeFile(
    join(archiveDir, `${runId}.json`),
    JSON.stringify({
      runId,
      entries: [{ resultIndex: 0, source: "result-tail", text: "stats" }],
    }),
  );

  assert.deepEqual(
    await readSettledWorkflowCompletion(undefined, asyncDir, runId),
    { output: "stats" },
  );
});

test("rejects a detached workflow result with a different run identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const result = join(root, "result.json");
  await writeFile(
    result,
    JSON.stringify({
      runId: "other-workflow",
      mode: "workflow",
      state: "failed",
      workflowResolution: "settled-awaiting-resume",
      results: [{ success: true, output: "wrong result" }],
    }),
  );
  assert.equal(
    await readSettledWorkflowCompletion(result, undefined, "expected-workflow"),
    undefined,
  );
});

test("does not recover a detached workflow whose child failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const result = join(root, "result.json");
  await writeFile(
    result,
    JSON.stringify({
      mode: "workflow",
      state: "failed",
      workflowResolution: "failed-child",
      results: [{ success: false, error: "review failed" }],
    }),
  );

  assert.equal(
    await readSettledWorkflowCompletion(result, undefined),
    undefined,
  );
});
