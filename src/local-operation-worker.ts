import { spawn, execFile } from "node:child_process";
import { open, readFile, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalOperationIntent } from "./local-operation.js";

const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 2_000;
const CANCEL_GRACE_MS = 2_000;
const MAX_PS_BYTES = 8_388_608;
const execFileAsync = promisify(execFile);
interface ProcessRow { pid: number; parent: number; group: number; started: string; }

async function snapshot(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_PS_BYTES });
  return stdout.trim().split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("Process ownership probe returned malformed data.");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4]?.trim() ?? "" };
  });
}

async function publish(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `${name}.tmp`);
  const file = await open(temporary, "w");
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(directory, name));
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function readIntent(raw: unknown): LocalOperationIntent {
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("digest" in raw) || typeof raw.digest !== "string" || !("runId" in raw) || typeof raw.runId !== "string" || !("operationId" in raw) || typeof raw.operationId !== "string" || !("candidate" in raw) || (raw.candidate !== null && typeof raw.candidate !== "string") || !("cwd" in raw) || typeof raw.cwd !== "string" || !("commands" in raw) || !Array.isArray(raw.commands) || raw.commands.some((command: unknown) => !Array.isArray(command) || !command.length || command.some((arg: unknown) => typeof arg !== "string")) || !("authorization" in raw)) throw new Error("Invalid local command intent.");
  const authorization = raw.authorization;
  if (authorization !== null && (!authorization || typeof authorization !== "object" || !("path" in authorization) || typeof authorization.path !== "string" || !("stopGeneration" in authorization) || !Number.isSafeInteger(authorization.stopGeneration))) throw new Error("Invalid local command authorization.");
  return raw as LocalOperationIntent;
}

async function granted(directory: string, digest: string, index: number): Promise<boolean> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(directory, `grant-${index}.json`), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!raw || typeof raw !== "object" || !("digest" in raw) || raw.digest !== digest || !("index" in raw) || raw.index !== index) throw new Error("Invalid local command launch grant.");
  return true;
}

async function authorized(intent: LocalOperationIntent, directory: string): Promise<boolean> {
  if (await exists(join(directory, "stop.json"))) return false;
  if (!intent.authorization) return true;
  const raw: unknown = JSON.parse(await readFile(intent.authorization.path, "utf8"));
  return !!raw && typeof raw === "object" && "id" in raw && raw.id === intent.runId &&
    Reflect.get(raw, "status") === AUTHORIZED_STATUS && !("userStopped" in raw && raw.userStopped) &&
    ("stopGeneration" in raw ? raw.stopGeneration : 0) === intent.authorization.stopGeneration;
}

const AUTHORIZED_STATUS = "running";

async function main(directory: string): Promise<void> {
  const intent = readIntent(JSON.parse(await readFile(join(directory, "intent.json"), "utf8"))) ;
  let lock;
  try { lock = await open(join(directory, "owner.lock"), "wx"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  try {
    const own = (await snapshot()).find((row) => row.pid === process.pid);
    if (!own || own.group !== process.pid) throw new Error("Monitor does not own its process group.");
    await lock.sync();
    await publish(directory, "owner.json", { digest: intent.digest, pid: process.pid, started: own.started, hostname: hostname() });
  } finally { await lock.close(); }
  process.on("SIGTERM", () => { /* Cancellation targets the owned group; the monitor must acknowledge its drain. */ });
  let cancelled = false;
  let code: number | null = 0;
  let error = "";
  for (const [index, command] of intent.commands.entries()) {
    await publish(directory, "request.json", { digest: intent.digest, index });
    while (!(await granted(directory, intent.digest, index))) {
      if (!(await authorized(intent, directory))) { cancelled = true; break; }
      await delay(POLL_MS);
    }
    if (cancelled || !(await authorized(intent, directory))) { cancelled = true; break; }
    const [program, ...args] = command;
    if (!program) throw new Error("Empty local command.");
    const output = await open(join(directory, "output.log"), "a");
    let exited = false;
    let commandCode: number | null = null;
    const child = spawn(program, args, { cwd: intent.cwd, stdio: ["ignore", output.fd, output.fd], detached: false });
    child.once("error", (failure) => { error = failure.message; exited = true; commandCode = 1; });
    child.once("exit", (status, signal) => { commandCode = status; if (signal) error = `Terminated by ${signal}`; exited = true; });
    let cancelAt: number | undefined;
    let escaped = false;
    const descendants = new Map<number, string>();
    for (;;) {
      const rows = await snapshot();
      const knownParents = new Set([process.pid, ...descendants.keys()]);
      for (let previous = -1; previous !== knownParents.size;) {
        previous = knownParents.size;
        for (const row of rows) if (knownParents.has(row.parent)) knownParents.add(row.pid);
      }
      for (const row of rows) {
        if (row.pid !== process.pid && knownParents.has(row.pid)) {
          descendants.set(row.pid, row.started);
          if (row.group !== process.pid) escaped = true;
        }
      }
      // The probe itself is an owned descendant and is already reaped when snapshot resolves.
      const members = rows.filter((row) => row.group === process.pid && row.pid !== process.pid && row.parent !== process.pid);
      const direct = rows.filter((row) => row.group === process.pid && row.parent === process.pid && row.pid === child.pid);
      if (!(await authorized(intent, directory))) {
        cancelled = true;
        if (cancelAt === undefined) {
          cancelAt = Date.now();
          process.kill(-process.pid, "SIGTERM");
        } else if (Date.now() - cancelAt >= CANCEL_GRACE_MS) {
          for (const row of [...members, ...direct]) {
            const identity = (await snapshot()).find((current) => current.pid === row.pid);
            if (!identity) continue;
            if (identity.started !== row.started || identity.group !== process.pid) throw new Error("Cancellation target identity changed; ownership remains unknown.");
            try { process.kill(row.pid, "SIGKILL"); }
            catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure; }
          }
        }
      }
      if (exited && members.length === 0 && direct.length === 0) {
        if (escaped) {
          await publish(directory, "result.json", { digest: intent.digest, groupDrained: false, error: "A descendant escaped the owned process group." });
          await output.close();
          return;
        }
        break;
      }
      await delay(POLL_MS);
    }
    await output.close();
    code = commandCode;
    if (cancelled || code !== 0) break;
  }
  await publish(directory, "result.json", { digest: intent.digest, code, cancelled, groupDrained: true, proofScope: "observed-posix-process-group", error });
}

const directory = process.argv[2];
if (directory) await main(directory).catch(() => { process.exitCode = 1; });
