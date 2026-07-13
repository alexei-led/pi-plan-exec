import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { createWorktree } from "../src/git.js";

test("creates plan-exec worktrees outside the source repository", async () => {
  const repositoryRoot = "/tmp/example-repository";
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const run = async (command: string, args: string[], cwd: string) => {
    calls.push({ command, args, cwd });
    return { stdout: "", stderr: "", code: 0 };
  };

  const worktree = await createWorktree(
    run,
    repositoryRoot,
    `${repositoryRoot}/docs/plans/20260712-example.md`,
    "example",
  );

  const repositoryId = createHash("sha256")
    .update(resolve(repositoryRoot))
    .digest("hex")
    .slice(0, 12);
  const expected = resolve(
    homedir(),
    ".pi",
    "plan-exec",
    "worktrees",
    `${basename(repositoryRoot)}-${repositoryId}-example`,
  );
  assert.equal(worktree, expected);
  assert.equal(worktree.startsWith(repositoryRoot), false);
  assert.deepEqual(calls[1], {
    command: "git",
    args: ["worktree", "add", "-b", "example", expected],
    cwd: repositoryRoot,
  });
});
