import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PlanExecRun } from "./types.js";

export async function initializeProgress(run: PlanExecRun): Promise<string> {
  const path = progressPath(run);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      `# Plan execution: ${basename(run.planPath)}`,
      `Run: ${run.id}`,
      `Branch: ${run.branch}`,
      `Worktree: ${run.worktreeCwd}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

export async function appendProgress(
  run: PlanExecRun,
  message: string,
): Promise<void> {
  if (!run.progressPath) return;
  await appendFile(
    run.progressPath,
    `[${new Date().toISOString()}] ${message}\n`,
    "utf8",
  );
}

function progressPath(run: PlanExecRun): string {
  const stem = basename(run.planPath).replace(/\.md$/i, "");
  return join(run.worktreeCwd, ".ralphex", "progress", `progress-${stem}.txt`);
}
