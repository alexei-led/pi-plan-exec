import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function appendProgressOnce(
  run: PlanExecRun,
  message: string,
): Promise<void> {
  if (!run.progressPath) return;
  let existing = "";
  try {
    existing = await readFile(run.progressPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const escapedMessage = message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const timestampedMessage = new RegExp(
    `\\[\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\] ${escapedMessage}(?:\\n|$)`,
  );
  if (timestampedMessage.test(existing)) return;
  await appendProgress(run, message);
}

function progressPath(run: PlanExecRun): string {
  const stem = basename(run.planPath).replace(/\.md$/i, "");
  return join(run.worktreeCwd, ".ralphex", "progress", `progress-${stem}.txt`);
}
