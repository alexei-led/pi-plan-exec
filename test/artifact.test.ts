import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSubagentArtifact } from "../src/artifact.js";

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
