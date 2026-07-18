import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const PLAN_BRANCH_HASH_LENGTH = 8;
const REPOSITORY_HASH_LENGTH = 12;

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

export async function requireGitRepository(
  run: RunCommand,
  cwd: string,
): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0)
    throw new Error("/exec supports Git repositories only.");
  return result.stdout.trim();
}

export async function defaultBranch(
  run: RunCommand,
  cwd: string,
): Promise<string> {
  const remote = await run(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    cwd,
  );
  if (remote.code === 0) {
    const branch = remote.stdout.trim().replace(/^origin\//, "");
    if (branch) return branch;
  }
  for (const branch of ["main", "master", "trunk"]) {
    const exists = await run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      cwd,
    );
    if (exists.code === 0) return branch;
  }
  throw new Error("Could not determine the default Git branch.");
}

export async function currentBranch(
  run: RunCommand,
  cwd: string,
): Promise<string> {
  const result = await run("git", ["branch", "--show-current"], cwd);
  const branch = result.stdout.trim();
  if (result.code !== 0 || !branch)
    throw new Error("Detached HEAD is not supported by /exec.");
  return branch;
}

export async function ensureCleanForWorktree(
  run: RunCommand,
  cwd: string,
  planPath: string,
): Promise<void> {
  const status = await run("git", ["status", "--porcelain"], cwd);
  if (status.code !== 0)
    throw new Error("Unable to inspect Git working tree state.");
  const dirty = status.stdout.trim().split("\n").filter(Boolean);
  if (dirty.length === 0) return;
  const relativePlan = resolve(planPath).startsWith(resolve(cwd))
    ? resolve(planPath).slice(resolve(cwd).length + 1)
    : undefined;
  const onlyUntrackedPlan =
    dirty.length === 1 && dirty[0] === `?? ${relativePlan}`;
  if (!onlyUntrackedPlan) {
    throw new Error(
      "Current working tree has changes. Choose in-place execution or commit/stash changes before using a worktree.",
    );
  }
}

export function branchNameFromPlan(planPath: string): string {
  const stem = basename(planPath)
    .replace(/\.md$/i, "")
    .replace(/^\d{8}-/, "");
  const branch = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!branch) throw new Error("Plan filename cannot produce a branch name.");
  const identity = createHash("sha256")
    .update(resolve(planPath))
    .digest("hex")
    .slice(0, PLAN_BRANCH_HASH_LENGTH);
  return `${branch}-${identity}`;
}

export async function createWorktree(
  run: RunCommand,
  repositoryRoot: string,
  planPath: string,
  branch: string,
): Promise<string> {
  const repositoryId = createHash("sha256")
    .update(resolve(repositoryRoot))
    .digest("hex")
    .slice(0, REPOSITORY_HASH_LENGTH);
  const target = resolve(
    homedir(),
    ".pi",
    "plan-exec",
    "worktrees",
    `${basename(repositoryRoot)}-${repositoryId}-${branch}`,
  );
  const exists = await run(
    "git",
    ["worktree", "list", "--porcelain"],
    repositoryRoot,
  );
  if (exists.stdout.includes(`worktree ${target}\n`)) {
    throw new Error(`Worktree already exists: ${target}`);
  }
  const created = await run(
    "git",
    ["worktree", "add", "-b", branch, target],
    repositoryRoot,
  );
  if (created.code !== 0)
    throw new Error(
      created.stderr.trim() || "Could not create execution worktree.",
    );
  return target;
}

export async function verifyExecutionRepository(
  run: RunCommand,
  cwd: string,
  expectedRepository: string,
): Promise<void> {
  const commonDirectory = await gitCommonDirectory(run, cwd);
  const expectedCommonDirectory = await gitCommonDirectory(
    run,
    expectedRepository,
  );
  if (commonDirectory !== expectedCommonDirectory) {
    throw new Error(
      "Execution directory no longer belongs to the expected repository.",
    );
  }
}

export async function verifyExecutionTree(
  run: RunCommand,
  cwd: string,
  expectedRepository: string,
  expectedBranch: string,
): Promise<void> {
  await verifyExecutionRepository(run, cwd, expectedRepository);
  const branch = await currentBranch(run, cwd);
  if (branch !== expectedBranch) {
    throw new Error(
      `Execution directory is on ${branch}, expected ${expectedBranch}.`,
    );
  }
}

async function gitCommonDirectory(
  run: RunCommand,
  cwd: string,
): Promise<string> {
  const result = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error("Unable to identify the Git common directory.");
  }
  return resolve(result.stdout.trim());
}

export function worktreePlanPath(
  worktreeCwd: string,
  repositoryRoot: string,
  planPath: string,
): string {
  const relative = resolve(planPath).slice(resolve(repositoryRoot).length + 1);
  if (relative.startsWith(".."))
    throw new Error("Plan must be inside the Git repository.");
  return resolve(worktreeCwd, relative);
}

export function planDirectory(planPath: string): string {
  return dirname(planPath);
}
