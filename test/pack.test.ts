import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("package manifest ships only plan-exec resources and requires recovery-capable bridge peers", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    pi: { extensions: string[]; skills: string[] };
    dependencies?: Record<string, string>;
    bundledDependencies?: string[];
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  for (const packageName of [
    "@alexeiled/pi-fusion",
    "@tintinweb/pi-tasks",
    "pi-subagents",
  ]) {
    assert.equal(manifest.peerDependencies[packageName], "*");
    assert.equal(manifest.peerDependenciesMeta[packageName]?.optional, true);
  }
  assert.equal(
    manifest.peerDependencies["@alexeiled/pi-subagents-bridge"],
    ">=0.2.0",
  );
  assert.equal(
    manifest.peerDependenciesMeta["@alexeiled/pi-subagents-bridge"]?.optional,
    true,
  );
  assert.match(
    await readFile(
      join(root, "skills", "exec-plan", "references", "recovery.md"),
      "utf8",
    ),
    /Resume the plan run ID, not the child\s+ID/,
  );
});
