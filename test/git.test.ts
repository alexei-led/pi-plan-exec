import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import {
  branchNameFromPlan,
  createWorktree,
  isPathWithin,
  verifyExistingWorktree,
  worktreeIdentity,
} from "../src/git.js";

test("plan-derived branches include a stable path hash to avoid collisions", () => {
  const first = branchNameFromPlan("/repo/docs/plans/20260712-example.md");
  const second = branchNameFromPlan("/repo/other/20260712-example.md");

  assert.match(first, /^example-[0-9a-f]{8}$/);
  assert.notEqual(first, second);
  assert.equal(
    first,
    branchNameFromPlan("/repo/docs/plans/20260712-example.md"),
  );
});

test("path containment does not confuse sibling repository names", () => {
  assert.equal(isPathWithin("/repo", "/repo/docs/plans/example.md"), true);
  assert.equal(isPathWithin("/repo", "/repo-other/docs/plans/example.md"), false);
  assert.equal(isPathWithin("/repo", "/other/example.md"), false);
});

test("accepts a symlink alias of a registered worktree with a newline in its path", async (t) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "exec-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = resolve(root, "feature tree\nλ");
  const alias = resolve(root, "alias");
  await mkdir(target);
  await mkdir(resolve(root, ".git"));
  await mkdir(resolve(target, ".git"));
  await mkdir(resolve(target, "nested"));
  await symlink(target, alias);
  assert.equal(await worktreeIdentity(resolve(alias, "nested")), target);
  assert.equal(await worktreeIdentity(root), root);
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = async (_command: string, args: string[], cwd: string) => {
    calls.push({ args, cwd });
    if (args[0] === "worktree")
      return { stdout: `worktree ${root}\0\0worktree ${target}\0\0`, stderr: "", code: 0 };
    if (args.includes("--git-common-dir"))
      return { stdout: "/repo/.git\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };

  assert.equal(await verifyExistingWorktree(run, root, alias), target);
  assert.deepEqual(calls[0], {
    args: ["worktree", "list", "--porcelain", "-z"],
    cwd: root,
  });
});

test("rejects a directory that is not a registered worktree", async (t) => {
  const target = await mkdtemp(resolve(tmpdir(), "exec-git-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const run = async () => ({
    stdout: "worktree /repo\0\0",
    stderr: "",
    code: 0,
  });
  await assert.rejects(
    verifyExistingWorktree(run, "/repo", target),
    /not registered with Git/,
  );
});

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
