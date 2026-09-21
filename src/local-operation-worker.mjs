import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const POLL_MS = 100;

async function publish(directory, name, value) {
  const temporary = join(directory, `${name}.${process.pid}.tmp`);
  const file = await open(temporary, "w", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(directory, name));
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

async function authorized(intent, directory) {
  if (await json(join(directory, "stop.json")) !== undefined) return false;
  if (!intent.authorization) return true;
  const raw = await json(intent.authorization.path);
  return raw?.id === intent.runId && raw.status === "running" && !raw.userStopped &&
    (raw.stopGeneration ?? 0) === intent.authorization.stopGeneration;
}

async function main(directory, expectedDigest) {
  const intent = await json(join(directory, "intent.json"));
  if (intent?.version !== 2 || typeof intent.digest !== "string" || typeof intent.runtimeModule !== "string" ||
      typeof intent.cwd !== "string" || !Array.isArray(intent.commands) ||
      intent.commands.some(command => !Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string"))) {
    throw new Error("Invalid local command intent.");
  }
  const { digest, ...request } = intent;
  if (digest !== expectedDigest || createHash("sha256").update(JSON.stringify(request)).digest("hex") !== digest) {
    throw new Error("Local command intent identity changed.");
  }
  const runtime = await import(intent.runtimeModule);
  const operationDirectory = join(directory, "owned-process");
  const stop = async () => {
    await publish(directory, "stop.json", { digest: intent.digest });
    await runtime.requestKernelOwnedProcessCancellation(operationDirectory);
  };
  let cancelled = false;
  let code = 0;
  let error = "";
  for (const [index, command] of intent.commands.entries()) {
    await publish(directory, "request.json", { digest: intent.digest, index });
    for (;;) {
      if (!(await authorized(intent, directory))) { cancelled = true; break; }
      const grant = await json(join(directory, `grant-${index}.json`));
      if (grant !== undefined) {
        if (grant?.digest !== intent.digest || grant.index !== index) throw new Error("Invalid local command launch grant.");
        break;
      }
      await delay(POLL_MS);
    }
    if (cancelled || !(await authorized(intent, directory))) { cancelled = true; await stop(); break; }
    const [program, ...args] = command;
    const output = await open(join(directory, "output.log"), "a", 0o600);
    let exited = false;
    const child = spawn(program, args, { cwd: intent.cwd, stdio: ["ignore", output.fd, output.fd] });
    child.once("error", failure => { error = failure.message; code = 1; exited = true; });
    child.once("exit", (status, signal) => { code = status; if (signal) error = `Terminated by ${signal}`; exited = true; });
    while (!exited) {
      if (!(await authorized(intent, directory))) { cancelled = true; await stop(); break; }
      await delay(POLL_MS);
    }
    await output.close();
    if (cancelled || code !== 0) break;
  }
  await publish(directory, "result.json", { digest: intent.digest, code, cancelled, error });
}

const directory = process.argv[2];
if (directory) await main(directory, process.argv[3]).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
