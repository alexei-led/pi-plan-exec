import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, link, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { KernelOperationBinding, KernelOwnedProcessObservation, KernelOwnedProcessRequest, PreparedKernelOwnedProcess } from "pi-subagents/kernel-owned-process";
import { EXTERNAL_OPERATION_STATE } from "./types.js";
import { workspaceEnvironment } from "./workspace-environment.js";

const POLL_MS = 100;
const RPC_TIMEOUT_MS = 15_000;
const CANCEL_PROBE_MS = 2_000;
const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIRECTORY_MODE = 0o700;
const CANCELLATION_BATCH_SIZE = 4;
const require = createRequire(import.meta.url);
type KernelRuntime = typeof import("pi-subagents/kernel-owned-process");

export interface LocalOperationOptions {
  journalRoot: string;
  runId: string;
  operationId: string;
  candidate?: string;
  authorization?: { path: string; stopGeneration: number };
  isAuthorized: () => Promise<boolean>;
  runtimeModule?: string;
  activeDirectory?: string;
}

interface LocalOperationIntent {
  version: 2;
  digest: string;
  runId: string;
  operationId: string;
  candidate: string | null;
  cwd: string;
  commands: string[][];
  authorization: { path: string; stopGeneration: number } | null;
  runtimeModule: string;
  environment: Record<string, string>;
  executable: string;
  worker: string;
}

export class LocalOperationUnknownError extends Error {}
export class LocalOperationCancelledError extends Error {}
export class LocalOperationFailedError extends Error {}

interface LocalOperationIndex {
  version: 1;
  runId: string;
  operationId: string;
  generation: number;
  directory: string;
  digest: string;
  runtimeModule: string;
  binding: KernelOperationBinding;
}

async function activeEntries(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function hasActiveLocalOperations(directory: string): Promise<boolean> {
  try { return (await activeEntries(directory)).length > 0; }
  catch { return true; }
}

async function removeActiveEntry(path: string): Promise<void> {
  try { await unlink(path); await syncDirectory(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function cancelActiveLocalOperations(directory: string, runId: string, generation: number): Promise<{
  pending: boolean;
  reason?: string;
}> {
  try {
    const names = await activeEntries(directory);
    if (!names.length) return { pending: false };
    const cursorPath = join(directory, "cursor.json");
    let cursor: unknown;
    try { cursor = await json(cursorPath); } catch { cursor = undefined; }
    const previous = record(cursor) && cursor.generation === generation && typeof cursor.name === "string" ? cursor.name : "";
    const after = names.findIndex(name => name > previous);
    const offset = after < 0 ? 0 : after;
    const ordered = [...names.slice(offset), ...names.slice(0, offset)].slice(0, CANCELLATION_BATCH_SIZE);
    let reason: string | undefined;
    for (const name of ordered) {
      try {
        const entryPath = join(directory, name);
        const raw = await json(entryPath);
        if (raw === undefined) continue;
        if (!record(raw) || raw.version !== 1 || raw.runId !== runId || typeof raw.operationId !== "string" ||
          typeof raw.directory !== "string" || typeof raw.digest !== "string" || typeof raw.runtimeModule !== "string" ||
          !Number.isSafeInteger(raw.generation) || typeof raw.generation !== "number" || raw.generation > generation)
          throw new LocalOperationUnknownError("Local operation cancellation index is unresolved.");
        const entry = raw as unknown as LocalOperationIndex;
        const intent = readIntent(await json(join(entry.directory, "intent.json")));
        const binding = readBinding(entry.binding);
        if (intent.runId !== runId || intent.operationId !== entry.operationId || intent.digest !== entry.digest ||
          intent.runtimeModule !== entry.runtimeModule || (intent.authorization?.stopGeneration ?? 0) !== entry.generation)
          throw new LocalOperationUnknownError("Local operation cancellation identity changed.");
        const runtime = await import(entry.runtimeModule) as KernelRuntime;
        const operationDirectory = join(entry.directory, "owned-process");
        let observation = await bounded(runtime.observeKernelOwnedProcess(operationDirectory));
        if (!terminal(observation, binding)) {
          await durableJson(join(entry.directory, "stop.json"), { digest: intent.digest });
          observation = await bounded(runtime.cancelKernelOwnedProcess(operationDirectory, { deadlineMs: CANCEL_PROBE_MS }));
        }
        if (terminal(observation, binding)) await removeActiveEntry(entryPath);
        else reason = observation.reason ?? "Local command process-tree exit remains unconfirmed.";
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      await durableJson(cursorPath, { generation, name });
    }
    return { pending: await hasActiveLocalOperations(directory), ...(reason ? { reason } : {}) };
  } catch (error) { return { pending: true, reason: error instanceof Error ? error.message : String(error) }; }
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "w", JOURNAL_FILE_MODE);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function json(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new LocalOperationUnknownError(`Unreadable local operation journal: ${path}`); }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LocalOperationUnknownError("Local command control request timed out; its operation remains fenced.")), RPC_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** The immutable request identity is also the cancellation and result fence. */
export function localOperationDirectory(options: Pick<LocalOperationOptions, "journalRoot" | "runId" | "operationId" | "authorization">): string {
  const key = createHash("sha256").update(JSON.stringify([options.runId, options.operationId])).digest("hex");
  return join(options.journalRoot, "local-operations", key, `generation-${options.authorization?.stopGeneration ?? 0}`);
}

function bindingMatches(a: KernelOperationBinding, b: KernelOperationBinding): boolean {
  return a.operationId === b.operationId && a.requestDigest === b.requestDigest && a.hostId === b.hostId && a.bootId === b.bootId;
}

function terminal(observation: KernelOwnedProcessObservation, binding: KernelOperationBinding): boolean {
  if (!observation.proof || !bindingMatches(observation.proof, binding)) return false;
  return observation.status === "never-started" && observation.proof.kind === "never-started" ||
    observation.status === "retired" && observation.proof.kind === "darwin-coalition-retired" && bindingMatches(observation.proof.identity, binding);
}

async function immutableJson(path: string, value: unknown): Promise<unknown> {
  const pending = `${path}.${randomUUID()}.tmp`;
  const file = await open(pending, "wx", JOURNAL_FILE_MODE);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await link(pending, path); await syncDirectory(dirname(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await unlink(pending); }
  return json(path);
}

function readIntent(value: unknown): LocalOperationIntent {
  if (!record(value) || value.version !== 2 || typeof value.digest !== "string" || typeof value.runId !== "string" ||
      typeof value.operationId !== "string" || (value.candidate !== null && typeof value.candidate !== "string") ||
      typeof value.cwd !== "string" || typeof value.runtimeModule !== "string" || typeof value.executable !== "string" || typeof value.worker !== "string" || !Array.isArray(value.commands) ||
      value.commands.some((command: unknown) => !Array.isArray(command) || !command.length || command.some((arg: unknown) => typeof arg !== "string")) ||
      !record(value.environment) || Object.values(value.environment).some(entry => typeof entry !== "string") ||
      (value.authorization !== null && (!record(value.authorization) || typeof value.authorization.path !== "string" || !Number.isSafeInteger(value.authorization.stopGeneration)))) {
    throw new LocalOperationUnknownError("Malformed local operation intent; ownership remains fenced.");
  }
  const intent = value as unknown as LocalOperationIntent;
  const { digest, ...request } = intent;
  if (createHash("sha256").update(JSON.stringify(request)).digest("hex") !== digest) throw new LocalOperationUnknownError("Local operation intent digest mismatch.");
  return intent;
}

function readBinding(value: unknown): KernelOperationBinding {
  if (!record(value) || [value.operationId, value.requestDigest, value.hostId, value.bootId].some(entry => typeof entry !== "string" || !entry)) {
    throw new LocalOperationUnknownError("Missing local command ownership binding.");
  }
  return value as unknown as KernelOperationBinding;
}

function kernelRequestFor(directory: string, intent: LocalOperationIntent, artifactDirectory: string): KernelOwnedProcessRequest {
  return {
    operationDirectory: join(directory, "owned-process"), artifactDirectory,
    argv: [intent.executable, intent.worker, directory, intent.digest], cwd: intent.cwd,
    env: intent.environment, lifetime: { kind: "unbounded" },
  };
}

async function runOwnedOperation(cwd: string, commands: string[][], options: LocalOperationOptions): Promise<void> {
  if (!commands.length) return;
  if (commands.some(command => !command.length || !command[0] || command.some(arg => typeof arg !== "string"))) throw new Error("An empty verification/bootstrap command is invalid.");
  const directory = localOperationDirectory(options);
  await mkdir(dirname(directory), { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
  const runtimeModule = options.runtimeModule ?? pathToFileURL(require.resolve("pi-subagents/kernel-owned-process")).href;
  const runtime: KernelRuntime = await bounded(import(runtimeModule));
  for (const previous of await readdir(dirname(directory), { withFileTypes: true })) {
    const prior = join(dirname(directory), previous.name);
    if (prior === directory) continue;
    if (!previous.isDirectory() || !/^generation-\d+$/.test(previous.name)) throw new LocalOperationUnknownError("Unrecognized local command generation journal.");
    const priorIntent = readIntent(await json(join(prior, "intent.json")));
    const priorPrepared = await bounded(runtime.prepareKernelOwnedProcess(kernelRequestFor(prior, priorIntent, join(options.journalRoot, "kernel-runtime"))));
    const priorBinding = readBinding(await immutableJson(join(prior, "binding.json"), priorPrepared));
    if (!bindingMatches(priorBinding, priorPrepared)) throw new LocalOperationUnknownError("Previous local command ownership binding changed.");
    const observation = await bounded(runtime.cancelKernelOwnedProcess(join(prior, "owned-process"), { deadlineMs: CANCEL_PROBE_MS }));
    if (!terminal(observation, priorBinding) || priorIntent.runId !== options.runId || priorIntent.operationId !== options.operationId) {
      throw new LocalOperationUnknownError("Previous local command generation has not proven exit; replacement remains fenced.");
    }
    if (options.activeDirectory) await removeActiveEntry(join(options.activeDirectory, `${createHash("sha256").update(prior).digest("hex")}.json`));
  }
  await mkdir(directory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
  const logical = { version: 2 as const, runId: options.runId, operationId: options.operationId, candidate: options.candidate ?? null, cwd: resolve(cwd), commands, authorization: options.authorization ?? null };
  let raw = await json(join(directory, "intent.json"));
  if (raw === undefined) {
    const environment = workspaceEnvironment();
    const request = { ...logical, runtimeModule, environment, executable: process.execPath, worker: fileURLToPath(new URL("./local-operation-worker.mjs", import.meta.url)) };
    raw = await immutableJson(join(directory, "intent.json"), { ...request, digest: createHash("sha256").update(JSON.stringify(request)).digest("hex") });
  }
  const intent = readIntent(raw);
  if (Object.entries(logical).some(([key, value]) => JSON.stringify(Reflect.get(intent, key)) !== JSON.stringify(value))) {
    throw new LocalOperationUnknownError("Local operation request changed; the original operation remains fenced.");
  }
  const kernelRequest = kernelRequestFor(directory, intent, join(options.journalRoot, "kernel-runtime"));
  const prepared: PreparedKernelOwnedProcess = await bounded(runtime.prepareKernelOwnedProcess(kernelRequest));
  const binding = readBinding(await immutableJson(join(directory, "binding.json"), prepared));
  if (!bindingMatches(binding, prepared)) throw new LocalOperationUnknownError("Local command ownership binding changed.");
  let activePath: string | undefined;
  if (options.activeDirectory) {
    await mkdir(options.activeDirectory, { recursive: true, mode: JOURNAL_DIRECTORY_MODE });
    activePath = join(options.activeDirectory, `${createHash("sha256").update(directory).digest("hex")}.json`);
    const entry: LocalOperationIndex = { version: 1, runId: options.runId, operationId: options.operationId,
      generation: options.authorization?.stopGeneration ?? 0, directory, digest: intent.digest,
      runtimeModule: intent.runtimeModule, binding };
    const existing = await immutableJson(activePath, entry);
    if (JSON.stringify(existing) !== JSON.stringify(entry)) throw new LocalOperationUnknownError("Local operation cancellation index changed.");
  }
  const stop = async (): Promise<void> => {
    await durableJson(join(directory, "stop.json"), { digest: intent.digest });
    await bounded(runtime.requestKernelOwnedProcessCancellation(kernelRequest.operationDirectory));
  };
  if (!(await bounded(options.isAuthorized()))) await stop();
  if (await json(join(directory, "stop.json")) === undefined) await bounded(runtime.launchKernelOwnedProcess(kernelRequest));
  for (;;) {
    if (!(await bounded(options.isAuthorized()))) await stop();
    let stopped = await json(join(directory, "stop.json"));
    if (stopped !== undefined && (!record(stopped) || stopped.digest !== intent.digest)) throw new LocalOperationUnknownError("Local command cancellation identity mismatch.");
    let observation = stopped === undefined
      ? await bounded(runtime.observeKernelOwnedProcess(kernelRequest.operationDirectory))
      : await bounded(runtime.cancelKernelOwnedProcess(kernelRequest.operationDirectory, { deadlineMs: CANCEL_PROBE_MS }));
    if (stopped === undefined && observation.status === EXTERNAL_OPERATION_STATE.PENDING) {
      const lateStop = await json(join(directory, "stop.json"));
      if (lateStop !== undefined && (!record(lateStop) || lateStop.digest !== intent.digest)) throw new LocalOperationUnknownError("Local command cancellation identity mismatch.");
      if (!(await bounded(options.isAuthorized())) || lateStop !== undefined) {
        await stop();
        stopped = { digest: intent.digest };
        observation = await bounded(runtime.cancelKernelOwnedProcess(kernelRequest.operationDirectory, { deadlineMs: CANCEL_PROBE_MS }));
      } else {
        observation = await bounded(runtime.reconcileKernelOwnedProcess(kernelRequest.operationDirectory));
      }
    }
    if (observation.status === EXTERNAL_OPERATION_STATE.UNKNOWN) throw new LocalOperationUnknownError(observation.reason ?? "Local command ownership is unknown.");
    if (terminal(observation, binding)) {
      if (activePath) await removeActiveEntry(activePath);
      if (stopped !== undefined || !(await bounded(options.isAuthorized()))) throw new LocalOperationCancelledError("Local operation was cancelled after confirmed process-tree exit.");
      const result = await json(join(directory, "result.json"));
      if (result === undefined) throw new LocalOperationFailedError("Local command failed: lost-result-after-exit.");
      if (!record(result) || result.digest !== intent.digest || typeof result.cancelled !== "boolean" || (result.code !== null && !Number.isSafeInteger(result.code))) {
        throw new LocalOperationUnknownError("Local command result identity is malformed.");
      }
      if (result.cancelled || observation.status === "never-started") throw new LocalOperationCancelledError("Local operation was cancelled.");
      if (result.code !== 0 || observation.exitCode !== 0) throw new LocalOperationFailedError(`Local command failed (exit ${String(result.code ?? observation.exitCode)}): ${String(result.error ?? directory)}`);
      return;
    }
    if (observation.status === "retired" || observation.status === "never-started") throw new LocalOperationUnknownError("Local command terminal proof does not match its durable binding.");
    if (observation.exitCode !== undefined) {
      const result = await json(join(directory, "result.json"));
      if (result === undefined || record(result) && result.digest === intent.digest && result.code !== 0) {
        await bounded(runtime.requestKernelOwnedProcessCancellation(kernelRequest.operationDirectory));
      }
    }
    const request = await json(join(directory, "request.json"));
    if (request !== undefined) {
      if (!record(request) || request.digest !== intent.digest || typeof request.index !== "number" || !Number.isSafeInteger(request.index) || request.index < 0 || request.index >= commands.length) throw new LocalOperationUnknownError("Malformed local command launch request.");
      if (stopped === undefined && await bounded(options.isAuthorized())) {
        await immutableJson(join(directory, `grant-${request.index}.json`), { digest: intent.digest, index: request.index });
      } else await stop();
    }
    await delay(POLL_MS);
  }
}

/** Reconciles one immutable unbounded batch, including descendants that detach or outlive its wrapper. */
export async function runLocalOperation(cwd: string, commands: string[][], options: LocalOperationOptions): Promise<void> {
  try { await runOwnedOperation(cwd, commands, options); }
  catch (error) {
    if (error instanceof LocalOperationUnknownError || error instanceof LocalOperationCancelledError || error instanceof LocalOperationFailedError) throw error;
    throw new LocalOperationUnknownError(`Local operation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
