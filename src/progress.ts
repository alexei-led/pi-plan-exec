import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
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

const PROGRESS_LOCK_RETRY_MS = 25;
const PROGRESS_LOCK_MAX_RETRIES = 400;
const PROGRESS_LOCK_STALE_MS = 120_000;

type ProgressLock = {
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
  token: string;
};

export async function appendProgressOnce(
  run: PlanExecRun,
  message: string,
): Promise<void> {
  if (!run.progressPath) return;
  await mkdir(dirname(run.progressPath), { recursive: true });
  const lock = await acquireProgressLock(`${run.progressPath}.lock`);
  try {
    let existing = "";
    try {
      existing = await readFile(run.progressPath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (hasProgressRecord(existing, message)) return;
    await appendProgress(run, message);
  } finally {
    await releaseProgressLock(lock);
  }
}

function hasProgressRecord(existing: string, message: string): boolean {
  const escapedMessage = message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const recordPattern = new RegExp(
    `^\\[(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\] ${escapedMessage}(?:\\r?\\n|$)`,
    "gm",
  );
  for (const match of existing.matchAll(recordPattern)) {
    const timestamp = new Date(match[1]!);
    if (
      !Number.isNaN(timestamp.getTime()) &&
      timestamp.toISOString() === match[1]
    )
      return true;
  }
  return false;
}

async function acquireProgressLock(path: string): Promise<ProgressLock> {
  for (let attempt = 0; attempt < PROGRESS_LOCK_MAX_RETRIES; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      const token = randomUUID();
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            createdAt: Date.now(),
            token,
          })}\n`,
          "utf8",
        );
        return { handle, path, token };
      } catch (error: unknown) {
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleProgressLock(path);
      await delay(PROGRESS_LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out acquiring progress lock: ${path}`);
}

async function removeStaleProgressLock(path: string): Promise<void> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const pid =
      parsed && typeof parsed === "object" && "pid" in parsed
        ? Number((parsed as { pid?: unknown }).pid)
        : 0;
    const ownerHostname =
      parsed && typeof parsed === "object" && "hostname" in parsed
        ? String((parsed as { hostname?: unknown }).hostname)
        : "";
    if (ownerHostname) {
      if (ownerHostname.toLowerCase() !== hostname().toLowerCase()) return;
      if (Number.isSafeInteger(pid) && pid > 0 && isProcessRunning(pid)) return;
      await rm(path, { force: true });
      return;
    }
    const createdAt =
      parsed && typeof parsed === "object" && "createdAt" in parsed
        ? Number((parsed as { createdAt?: unknown }).createdAt)
        : (await stat(path)).mtimeMs;
    if (Number.isFinite(createdAt) && Date.now() - createdAt > PROGRESS_LOCK_STALE_MS)
      await rm(path, { force: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function releaseProgressLock(lock: ProgressLock): Promise<void> {
  await lock.handle.close();
  try {
    const parsed: unknown = JSON.parse(await readFile(lock.path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "token" in parsed &&
      (parsed as { token?: unknown }).token === lock.token
    )
      await rm(lock.path, { force: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
      throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressPath(run: PlanExecRun): string {
  const stem = basename(run.planPath).replace(/\.md$/i, "");
  return join(run.worktreeCwd, ".ralphex", "progress", `progress-${stem}.txt`);
}
