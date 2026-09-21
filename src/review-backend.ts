import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { executionLifetimeCapabilities, parseExecutionLifetime, processTerminalProof, processTreeOwnershipCapabilities, supportsOwnedProcessTree } from "./bridge.js";
import { FUSION_PHASE, PLAN_REVIEW_OUTPUT_CONTRACT, type FusionCapabilities, type FusionResult } from "./fusion.js";
import { PROCESS_TERMINAL_STATE } from "./lifecycle.js";
import { formatFindings, hasBlockingFindings, parseReviewFindings } from "./review.js";
import type { ExecutionLifetime, ReviewBackend, ReviewFinding } from "./types.js";

export interface ReviewRequest {
  operationId: string;
  backend: ReviewBackend;
  reviewedCommit: string;
  cwd: string;
  prompt: string;
  executionLifetime: ExecutionLifetime;
  profile?: string;
}

export interface ValidatedReviewResult {
  reviewedCommit: string;
  findings: ReviewFinding[];
  blocking: boolean;
}

/** Persist alongside the launch intent; replay cannot change the scope or lifetime. */
export function reviewRequestDigest(request: ReviewRequest): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    request.operationId, request.backend, request.reviewedCommit,
    request.cwd, request.prompt, request.profile ?? null,
    request.executionLifetime.mode,
    request.executionLifetime.mode === "bounded"
      ? request.executionLifetime.timeoutMs : null,
  ])).digest("hex")}`;
}

/** A completed transport is not a completed review until its exact scope is validated. */
export function validateReviewResult(
  output: string,
  reviewedCommit: string,
  expectedCommit: string,
): ValidatedReviewResult {
  if (!reviewedCommit || reviewedCommit !== expectedCommit)
    throw new Error("Review result does not cover the expected commit.");
  const findings = parseReviewFindings(output);
  return { reviewedCommit, findings, blocking: hasBlockingFindings(findings) };
}

/** Backend changes require explicit policy and proof the previous operation cannot run. */
export function canFallbackReview(
  selected: ReviewBackend,
  fallback: readonly ReviewBackend[],
  previous: { dispatched: boolean; processTreeExited: boolean; launchFencedAbsent?: boolean },
): boolean {
  return fallback.includes(selected) &&
    (!previous.dispatched || previous.processTreeExited || previous.launchFencedAbsent === true);
}

/** Parse the documented Revmux JSON report without treating a partial panel as clean. */
export function parseRevmuxReport(value: unknown): ReviewFinding[] {
  if (!isRecord(value) || !isRecord(value.sources) ||
    !Number.isInteger(value.sources.expected) ||
    typeof value.sources.expected !== "number" || value.sources.expected <= 0 ||
    value.sources.reported !== value.sources.expected ||
    !Array.isArray(value.sources.degraded) || value.sources.degraded.length > 0 ||
    !Array.isArray(value.sources.agents) ||
    value.sources.agents.length !== value.sources.expected ||
    value.sources.agents.some((agent: unknown) => !isRecord(agent) || agent.degraded !== false) ||
    !Array.isArray(value.findings) || !Array.isArray(value.open_questions) ||
    value.open_questions.length > 0 || !Array.isArray(value.pre_existing) ||
    !Array.isArray(value.immaterial))
    throw new Error("Revmux report is malformed, partial, or has unresolved questions.");
  const findings: ReviewFinding[] = [];
  const ids = new Set<string>();
  if (value.immaterial.some((entry: unknown) =>
    !isRecord(entry) || entry.severity !== "minor" || entry.verdict !== "immaterial"))
    throw new Error("Revmux report cannot dismiss blocking findings as immaterial.");
  for (const entry of [...value.findings, ...value.immaterial]) {
    if (!isRecord(entry) || !nonempty(entry.id) || ids.has(entry.id) ||
      !nonempty(entry.title) || !nonempty(entry.body) || !nonempty(entry.fix) ||
      !nonempty(entry.file) || !Number.isInteger(entry.line) ||
      typeof entry.line !== "number" || entry.line < 0 ||
      (entry.verdict !== "confirmed" && entry.verdict !== "refined" &&
        !(entry.verdict === "immaterial" && entry.severity === "minor")))
      throw new Error("Revmux report contains an incomplete or unverified finding.");
    const severity = typeof entry.severity === "string" ? entry.severity.toUpperCase() : "";
    if (severity !== "CRITICAL" && severity !== "MAJOR" && severity !== "MINOR")
      throw new Error("Revmux report contains an invalid finding severity.");
    ids.add(entry.id);
    findings.push({ id: entry.id, severity, summary: singleLine(entry.title),
      evidence: singleLine(`${entry.file}:${entry.line} ${entry.body}`), suggestion: singleLine(entry.fix) });
  }
  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export interface RevmuxReviewOptions {
  cwd: string;
  stateDirectory: string;
  reviewedCommit: string;
  executable?: string;
}

const execFileAsync = promisify(execFile);
const REVMUX_PREFLIGHT_TIMEOUT_MS = 5_000;

/** The monitor owns the CLI handle across Pi restarts; an intent is never relaunched after claiming it. */
export class RevmuxReviewClient {
  constructor(private readonly options: RevmuxReviewOptions) {}

  async capabilities(): Promise<FusionCapabilities> {
    try {
      const { stdout } = await execFileAsync(this.options.executable ?? "revmux", ["--capabilities"], {
        cwd: this.options.cwd, timeout: REVMUX_PREFLIGHT_TIMEOUT_MS,
      });
      const value: unknown = JSON.parse(stdout);
      if (!isRecord(value) || value.protocol !== "plan-exec-revmux" || value.version !== 1 || value.supported === false ||
        !isRecord(value.processTerminalProof) || value.processTerminalProof.version !== 1)
        return { healthy: false, durableOperationLookup: true };
      return { healthy: true, durableOperationLookup: true, processTerminalProofVersion: 1,
        ...executionLifetimeCapabilities(value.executionLifetime),
        ...processTreeOwnershipCapabilities(value.processTreeOwnership) };
    } catch {
      return { healthy: false, durableOperationLookup: true };
    }
  }

  async start(operationId: string, prompt: string, profile?: string,
    executionLifetime: ExecutionLifetime = { mode: "unbounded" }): Promise<FusionResult> {
    const request: ReviewRequest = { operationId, prompt, backend: "revmux",
      reviewedCommit: this.options.reviewedCommit, cwd: resolve(this.options.cwd),
      executionLifetime, ...(profile ? { profile } : {}) };
    const directory = this.directory(operationId);
    const digest = reviewRequestDigest(request);
    await mkdir(directory, { recursive: true });
    try {
      const existing = await readJson(join(directory, "request.json"));
      if (!isRecord(existing) || existing.digest !== digest)
        return failure("conflict", "Review operation identity already belongs to a different request.");
      return this.observe(operationId);
    } catch (error) {
      if (!missingFile(error)) return failure("malformed", String(error));
    }
    const capabilities = await this.capabilities();
    if (!capabilities.healthy || !capabilities.executionLifetimeModes?.includes(executionLifetime.mode) ||
      !supportsOwnedProcessTree(capabilities))
      return failure("unsupported", "Revmux requires explicit execution-lifetime and observed process-tree proof capabilities.");
    const lifetime = parseExecutionLifetime(executionLifetime);
    if (!lifetime) return failure("invalid_request", "Invalid review execution lifetime.");
    try {
      await writeFile(join(directory, "request.json"), JSON.stringify({ request, digest,
        executable: this.options.executable ?? "revmux" }), { flag: "wx" });
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") return this.start(operationId, prompt, profile, lifetime);
      throw error;
    }
    return this.observe(operationId);
  }

  private async ensureMonitor(directory: string): Promise<boolean> {
    try { await readFile(join(directory, "claimed")); return true; }
    catch (error) { if (!missingFile(error)) return false; }
    const monitor = spawn(process.execPath, ["-e", REVMUX_MONITOR, directory], {
      cwd: this.options.cwd, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const launched = await new Promise<boolean>((resolveLaunch) => {
      const timer = setTimeout(() => resolveLaunch(false), REVMUX_PREFLIGHT_TIMEOUT_MS);
      const finish = (ready: boolean) => { clearTimeout(timer); resolveLaunch(ready); };
      monitor.once("message", (message) => finish(message === "claimed"));
      monitor.once("error", () => finish(false));
      monitor.once("exit", () => finish(false));
    });
    monitor.channel?.unref();
    monitor.unref();
    return launched;
  }

  status(runId?: string, operationId?: string): Promise<FusionResult> {
    return this.select(runId, operationId);
  }

  result(runId?: string, operationId?: string): Promise<FusionResult> {
    return this.select(runId, operationId);
  }

  adopt(runId: string): Promise<FusionResult> {
    return this.observe(runId);
  }

  async cancel(runId?: string, operationId?: string): Promise<FusionResult> {
    const id = selectId(runId, operationId);
    if (!id) return failure("invalid_request", "Specify exactly one review operation selector.");
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "cancel"), "cancel\n");
    return this.observe(id);
  }

  private select(runId?: string, operationId?: string): Promise<FusionResult> {
    const id = selectId(runId, operationId);
    return id ? this.observe(id) : Promise.resolve(failure("invalid_request", "Specify exactly one review operation selector."));
  }

  private directory(operationId: string): string {
    return join(resolve(this.options.stateDirectory), createHash("sha256").update(operationId).digest("hex"));
  }

  private async observe(operationId: string): Promise<FusionResult> {
    const directory = this.directory(operationId);
    let stored: unknown;
    try { stored = await readJson(join(directory, "request.json")); }
    catch (error) { return failure(missingFile(error) ? "not_found" : "malformed", "Review launch identity is not available."); }
    if (!isRecord(stored) || !isRecord(stored.request) || stored.request.operationId !== operationId)
      return failure("malformed", "Review launch identity is malformed.");
    if (!(await this.ensureMonitor(directory)))
      return failure("launch_unknown", "Review monitor launch could not be confirmed; reconcile the same operation.");
    const lifetime = parseExecutionLifetime(stored.request.executionLifetime);
    const data: Record<string, unknown> = { operationId,
      reviewedCommit: stored.request.reviewedCommit,
      ...(lifetime ? { effectiveExecutionLifetime: lifetime } : {}),
      run: { runId: operationId, operationId, phase: FUSION_PHASE.PANEL, terminal: false } };
    let outcome: unknown;
    try { outcome = await readJson(join(directory, "outcome.json")); }
    catch (error) { return missingFile(error) ? { success: true, data } : failure("malformed", String(error)); }
    if (!isRecord(outcome)) return failure("malformed", "Review monitor outcome is malformed.");
    let proof: unknown;
    try { proof = await readJson(join(directory, "process-proof.json")); }
    catch { return { success: true, data: { ...data, error: "Review CLI exited; process-tree cleanup remains unconfirmed." } }; }
    const validatedProof = isRecord(proof) && proof.scope !== "process-groups" &&
      proof.escapedDescendants !== "unsupported"
      ? processTerminalProof({ ...proof, runId: operationId }, operationId) : undefined;
    if (!validatedProof || (validatedProof.state !== PROCESS_TERMINAL_STATE.OBSERVED &&
      validatedProof.state !== PROCESS_TERMINAL_STATE.NOT_STARTED))
      return { success: true, data: { ...data, processTerminalProof: validatedProof } };
    data.processTerminalProof = validatedProof;
    const success = outcome.code === 0 || outcome.code === 1;
    data.run = { runId: operationId, operationId,
      phase: outcome.cancelled ? FUSION_PHASE.CANCELLED : success ? FUSION_PHASE.DONE : FUSION_PHASE.FAILED,
      terminal: true, ...(typeof outcome.error === "string" ? { error: outcome.error } : {}) };
    if (success && !outcome.cancelled) {
      try {
        const findings = parseRevmuxReport(await readJson(join(directory, "report.json")));
        data.callerOutput = { contract: PLAN_REVIEW_OUTPUT_CONTRACT,
          output: findings.length ? formatFindings(findings) : "NO_FINDINGS" };
      } catch (error) {
        data.run = { runId: operationId, operationId, phase: FUSION_PHASE.FAILED, terminal: true, error: String(error) };
      }
    }
    return { success: true, data };
  }
}

function selectId(runId?: string, operationId?: string): string | undefined {
  return runId && !operationId ? runId : operationId && !runId ? operationId : undefined;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function missingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function failure(code: string, message: string): FusionResult {
  return { success: false, error: { code, message } };
}

const REVMUX_MONITOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const dir = process.argv[1];
const filename = name => path.join(dir, name);
const persist = (name, value) => {
  const target = filename(name);
  const temporary = target + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temporary, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
};
const acknowledge = () => { if (process.send) { process.send('claimed'); process.disconnect(); } };
try { fs.writeFileSync(filename('claimed'), String(process.pid), {flag:'wx'}); }
catch { acknowledge(); process.exit(0); }
acknowledge();
const {request, executable} = JSON.parse(fs.readFileSync(filename('request.json'), 'utf8'));
const cancelled = () => fs.existsSync(filename('cancel'));
const notStarted = error => {
  persist('process-proof.json', {version:1,state:'not-started',runnerProcessInstanceId:crypto.randomUUID()});
  persist('outcome.json', {code:2,cancelled:cancelled(),error});
};
if (cancelled()) { notStarted('Review cancelled before dispatch.'); process.exit(0); }
const tasks = filename('rounds');
const common = ['--task','review','--run','01','--tasks-dir',tasks];
let paths;
try {
  paths = JSON.parse(cp.execFileSync(executable, ['new', ...common], {cwd:request.cwd,encoding:'utf8',timeout:5000}));
  fs.writeFileSync(paths.scope, request.prompt + '\n\nReview exactly commit ' + request.reviewedCommit + '.\n');
  fs.writeFileSync(paths.goal, 'Required review of the supplied commit. Return complete findings with evidence.\n');
} catch (error) { notStarted(String(error)); process.exit(0); }
if (cancelled()) { notStarted('Review cancelled before dispatch.'); process.exit(0); }
const hardTimeout = request.executionLifetime.mode === 'unbounded' ? '0s' : request.executionLifetime.timeoutMs + 'ms';
const argv = [...common,'--workdir',request.cwd,'--no-tui','--idle-timeout=0s','--hard-timeout='+hardTimeout,
  '--process-proof='+filename('process-proof.json'), ...(request.profile ? ['--profile',request.profile] : [])];
const stdout = fs.openSync(filename('report.json'), 'w');
const stderr = fs.openSync(filename('stderr.log'), 'a');
let child;
try { child = cp.spawn(executable, argv, {cwd:request.cwd,stdio:['ignore',stdout,stderr]}); }
catch (error) { notStarted(String(error)); process.exit(0); }
const timer = setInterval(() => { if (cancelled() && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, 100);
child.once('error', error => { clearInterval(timer); notStarted(String(error)); });
child.once('close', (code, signal) => {
  clearInterval(timer);
  fs.closeSync(stdout); fs.closeSync(stderr);
  persist('outcome.json', {code,signal,cancelled:cancelled()});
});
`;
