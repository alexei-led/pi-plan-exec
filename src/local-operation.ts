import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, link, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 2_000;
const STARTUP_GRACE_MS = 5_000;
const execFileAsync = promisify(execFile);

export interface LocalOperationOptions {
  journalRoot: string;
  runId: string;
  operationId: string;
  candidate?: string;
  authorization?: { path: string; stopGeneration: number };
  isAuthorized: () => Promise<boolean>;
}

export interface LocalOperationIntent {
  version: 1;
  digest: string;
  runId: string;
  operationId: string;
  candidate: string | null;
  cwd: string;
  commands: string[][];
  authorization: { path: string; stopGeneration: number } | null;
}

export class LocalOperationUnknownError extends Error {}
export class LocalOperationCancelledError extends Error {}
export class LocalOperationFailedError extends Error {}

export async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "w");
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new LocalOperationUnknownError(`Unreadable local operation journal: ${path}`); }
}

/** The immutable request identity is also the cancellation and result fence. */
export function localOperationDirectory(options: Pick<LocalOperationOptions, "journalRoot" | "runId" | "operationId" | "authorization">): string {
  const key = createHash("sha256").update(JSON.stringify([options.runId, options.operationId])).digest("hex");
  return join(options.journalRoot, "local-operations", key, `generation-${options.authorization?.stopGeneration ?? 0}`);
}

async function ownerAlive(owner: Record<string, unknown>, directory: string): Promise<boolean> {
  if (owner.hostname !== hostname()) return false;
  if (!Number.isSafeInteger(owner.pid) || typeof owner.pid !== "number" || owner.pid <= 1 || typeof owner.started !== "string") return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(owner.pid), "-o", "lstart=", "-o", "args="], { timeout: PROBE_TIMEOUT_MS });
    return stdout.trim().startsWith(owner.started) && stdout.includes(directory);
  } catch { return false; }
}

/** Diagnostic process-group observation; it cannot prove an entire descendant tree exited. */
async function runLocalOperationInternal(cwd: string, commands: string[][], options: LocalOperationOptions): Promise<void> {
  if (!commands.length) return;
  if (commands.some((command) => !command[0])) throw new Error("An empty verification/bootstrap command is invalid.");
  if (process.platform === "win32") throw new LocalOperationUnknownError("Durable local command ownership requires POSIX process groups.");
  const directory = localOperationDirectory(options);
  await mkdir(dirname(directory), { recursive: true });
  for (const previous of await readdir(dirname(directory), { withFileTypes: true })) {
    const previousDirectory = join(dirname(directory), previous.name);
    if (previousDirectory === directory) continue;
    if (!previous.isDirectory() || !/^generation-\d+$/.test(previous.name)) throw new LocalOperationUnknownError("Unrecognized local command generation journal.");
    const priorIntent = await json(join(previousDirectory, "intent.json"));
    const priorResult = await json(join(previousDirectory, "result.json"));
    if (!record(priorIntent) || !record(priorResult) || typeof priorIntent.digest !== "string" || priorResult.digest !== priorIntent.digest || priorResult.groupDrained !== true || priorResult.proofScope !== "observed-posix-process-group") {
      throw new LocalOperationUnknownError("Previous local command generation has not proven exit; replacement remains fenced.");
    }
  }
  await mkdir(directory, { recursive: true });
  const request = { version: 1 as const, runId: options.runId, operationId: options.operationId, candidate: options.candidate ?? null, cwd: resolve(cwd), commands, authorization: options.authorization ?? null };
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const intent: LocalOperationIntent = { ...request, digest };
  const pending = join(directory, `intent.${randomUUID()}.tmp`);
  const file = await open(pending, "wx");
  try { await file.writeFile(JSON.stringify(intent)); await file.sync(); } finally { await file.close(); }
  try { await link(pending, join(directory, "intent.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = await json(join(directory, "intent.json"));
    if (!record(previous) || previous.digest !== digest) throw new LocalOperationUnknownError("Local operation request changed or its durable intent is incomplete.");
  } finally { await unlink(pending); }
  if (!(await options.isAuthorized())) await durableJson(join(directory, "stop.json"), { digest });
  const began = Date.now();
  let launched = false;
  for (;;) {
    if (!(await options.isAuthorized())) await durableJson(join(directory, "stop.json"), { digest });
    const result = await json(join(directory, "result.json"));
    if (result !== undefined) {
      if (!record(result) || result.digest !== digest || result.groupDrained !== true || result.proofScope !== "observed-posix-process-group" || typeof result.cancelled !== "boolean" || (result.code !== null && !Number.isSafeInteger(result.code))) throw new LocalOperationUnknownError("Local command exit ownership could not be proven.");
      if (await json(join(directory, "stop.json")) !== undefined || result.cancelled === true) throw new LocalOperationCancelledError("Local operation was cancelled.");
      if (result.code !== 0) throw new LocalOperationFailedError(`Local command failed (exit ${String(result.code)}): ${String(result.error ?? directory)}`);
      return;
    }
    const request = await json(join(directory, "request.json"));
    if (record(request) && request.digest === digest && typeof request.index === "number" && Number.isSafeInteger(request.index) && request.index >= 0 && request.index < commands.length) {
      if (await options.isAuthorized()) {
        const grantPath = join(directory, `grant-${request.index}.json`);
        if (await json(grantPath) === undefined) await durableJson(grantPath, { digest, index: request.index });
      } else {
        await durableJson(join(directory, "stop.json"), { digest });
      }
    }
    const owner = await json(join(directory, "owner.json"));
    if (owner !== undefined) {
      if (!record(owner) || owner.digest !== digest || !(await ownerAlive(owner, directory))) {
        // A result may have been committed between the first read and the process probe.
        if (await json(join(directory, "result.json")) !== undefined) continue;
        throw new LocalOperationUnknownError(`Local command owner unavailable; retained fence: ${directory}`);
      }
    } else if (!launched) {
      const worker = fileURLToPath(new URL("./local-operation-worker.ts", import.meta.url));
      const child = spawn(process.execPath, ["--experimental-strip-types", worker, directory], { detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => { /* Missing ownership remains fenced below. */ });
      child.unref();
      launched = true;
    } else if (Date.now() - began > STARTUP_GRACE_MS) {
      throw new LocalOperationUnknownError(`Local command launch not acknowledged; retained fence: ${directory}`);
    }
    await delay(POLL_MS);
  }
}


/** Diagnostic only: process-group drain is not sufficient to authorize another writer. */
export async function observeLocalOperation(cwd: string, commands: string[][], options: LocalOperationOptions): Promise<{ proofScope: "observed-posix-process-group" }> {
  try {
    await runLocalOperationInternal(cwd, commands, options);
    return { proofScope: "observed-posix-process-group" };
  }
  catch (error) {
    if (error instanceof LocalOperationUnknownError || error instanceof LocalOperationCancelledError || error instanceof LocalOperationFailedError) throw error;
    throw new LocalOperationUnknownError(`Local operation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}


/** No available backend can prove exit of descendants that detach between process snapshots. */
export async function runLocalOperation(cwd: string, commands: string[][], options: LocalOperationOptions): Promise<void> {
  if (!commands.length) return;
  throw new LocalOperationUnknownError(`Owned-process-tree containment is unavailable for local operation ${options.operationId} in ${cwd}; process-group observation cannot authorize verification, bootstrap, or another writer.`);
}
