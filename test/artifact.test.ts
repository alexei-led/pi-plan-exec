import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readSettledWorkflowCompletion,
  readSubagentArtifact,
} from "../src/artifact.js";
import { parseReviewFindings } from "../src/review.js";

function nativeSingleResult() {
  return { lifecycleArtifactVersion: 3, id: "native-review", agent: "reviewer", mode: "single",
    success: true, state: "complete", summary: "reviewer:\nNO_FINDINGS", truncated: false,
    launchContractDigest: "launch-contract", results: [{ agent: "reviewer", success: true,
      output: "NO_FINDINGS", outputState: "present", launchContractDigest: "launch-contract" }] };
}

test("extracts the authoritative sole native reviewer output instead of decorated summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = join(root, "result.json");
  await writeFile(result, JSON.stringify(nativeSingleResult()));
  const output = await readSubagentArtifact(result, undefined, { runId: "native-review", agent: "reviewer", successful: true });
  assert.equal(output, "NO_FINDINGS");
  assert.deepEqual(parseReviewFindings(output), []);
});

test("invalid native reviewer envelopes cannot fall back to clean status text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = join(root, "result.json");
  await writeFile(join(root, "status.json"), JSON.stringify({ runId: "native-review", mode: "single", state: "complete",
    steps: [{ agent: "reviewer", status: "complete", recentOutput: ["NO_FINDINGS"] }] }));
  const valid = nativeSingleResult();
  const child = valid.results[0];
  for (const invalid of [
    { ...valid, results: [] }, { ...valid, results: [child, child] },
    { ...valid, id: "other-run" }, { ...valid, agent: "worker" },
    { ...valid, results: [{ ...child, agent: "other-reviewer" }] },
    { ...valid, results: [{ ...child, launchContractDigest: "other-launch" }] },
    { ...valid, results: [{ ...child, output: "" }] },
    { ...valid, results: [{ ...child, outputState: "missing" }] },
    { ...valid, state: "running" }, { ...valid, truncated: true },
    { ...valid, state: "failed", success: false, results: [{ ...child, success: false }] },
  ]) {
    await writeFile(result, JSON.stringify(invalid));
    await assert.rejects(readSubagentArtifact(result, root, { runId: "native-review", agent: "reviewer", successful: true }), /Single-agent/);
  }
});

test("failed task diagnostics use actual child output rather than a launch summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = join(root, "result.json");
  const output = "<<<RALPHEX:TASK_FAILED>>>\nBlocker: AssertEqual failed at test/input.test.ts:9.";
  await writeFile(result, JSON.stringify({ ...nativeSingleResult(), id: "native-task", agent: "worker", state: "failed",
    success: false, summary: "Subagent was scheduled with task instructions.", results: [{ agent: "worker", success: false,
      outputState: "present", output, launchContractDigest: "launch-contract" }] }));
  assert.equal(await readSubagentArtifact(result, undefined, { runId: "native-task", agent: "worker" }), output);
});

test("launch receipts and metadata are never interpreted as worker outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = join(root, "result.json");
  for (const receipt of [
    { details: { runId: "native-task", asyncDir: root }, content: [{ text: "<<<RALPHEX:TASK_FAILED>>>\nInstruction: report this marker on failure." }] },
    { summary: "NO_FINDINGS", instructions: "Return NO_FINDINGS only after review." },
  ]) {
    await writeFile(result, JSON.stringify(receipt));
    await assert.rejects(readSubagentArtifact(result, undefined, { runId: "native-task", agent: "worker" }));
  }
});

test("bound single-agent recovery requires full output rather than a potentially truncated status tail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = { runId: "native-review", mode: "single", state: "complete",
    steps: [{ agent: "reviewer", status: "complete", recentOutput: ["NO_FINDINGS"] }] };
  await writeFile(join(root, "status.json"), JSON.stringify(status));
  const expected = { runId: "native-review", agent: "reviewer", successful: true };
  await assert.rejects(readSubagentArtifact(undefined, root, expected));
  const outputFile = join(root, "output-0.log");
  const output = "FINDING: MAJOR | Assertion fails\nEvidence: test/input.ts:9 fails\nFix: Check the empty input case.";
  await writeFile(outputFile, output);
  await writeFile(join(root, "status.json"), JSON.stringify({ ...status, outputFile }));
  assert.equal(await readSubagentArtifact(undefined, root, expected), output);
});

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

test("recovers the sole workflow return after the result file was archived", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  const output = "<<<RALPHEX:TASK_FAILED>>>\nBlocker: Operator release checkpoint is missing.";
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({
    mode: "workflow", state: "complete",
    steps: [{ runId: "child-1", workflowKey: "main", status: "completed" }],
    workflow: { value: { key: "main", runId: "child-1", ok: true, output } },
  }));
  assert.equal(await readSubagentArtifact(join(asyncDir, "expired.json"), asyncDir), output);
});

test("does not adopt a workflow return with a different child identity", async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), "pi-plan-exec-artifact-"));
  await writeFile(join(asyncDir, "status.json"), JSON.stringify({
    mode: "workflow", state: "complete",
    steps: [{ runId: "child-1", workflowKey: "main", status: "completed" }],
    workflow: { value: { key: "main", runId: "unrelated-child", output: "unrelated output" } },
  }));
  await assert.rejects(readSubagentArtifact(undefined, asyncDir), /Subagent result output was unavailable/);
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
