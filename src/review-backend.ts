import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { executionLifetimeCapabilities, hasKernelRetirementProof, parseExecutionLifetime, supportsOwnedProcessTree } from "./bridge.js";
import { FUSION_PHASE, PLAN_REVIEW_OUTPUT_CONTRACT, type FusionCapabilities, type FusionResult, type ReviewExecutionContext } from "./fusion.js";
import { formatFindings, hasBlockingFindings, parseReviewFindings } from "./review.js";
import { workspaceEnvironment } from "./workspace-environment.js";
import { EXTERNAL_OPERATION_STATE, type ExecutionLifetime, type ReviewBackend, type ReviewFinding } from "./types.js";
import type {
  KernelOperationBinding, KernelOwnedProcessObservation, KernelOwnedProcessRequest, PreparedKernelOwnedProcess,
} from "pi-subagents/kernel-owned-process";

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

const UNAVAILABLE_REVMUX_FIX = "Unavailable: reviewer supplied no suggested fix.";

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
      !nonempty(entry.title) || !nonempty(entry.body) ||
      (entry.fix !== undefined && typeof entry.fix !== "string") ||
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
      evidence: singleLine(`${entry.file}:${entry.line} ${entry.body}`),
      ...(nonempty(entry.fix) ? { suggestion: singleLine(entry.fix) } : {}) });
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

function storedReviewRequest(value: unknown): ReviewRequest | undefined {
  if (!isRecord(value) || value.backend !== "revmux" || !nonempty(value.operationId) ||
    !nonempty(value.reviewedCommit) || !nonempty(value.cwd) || !nonempty(value.prompt) ||
    (value.profile !== undefined && !nonempty(value.profile))) return undefined;
  const executionLifetime = parseExecutionLifetime(value.executionLifetime);
  if (!executionLifetime) return undefined;
  return { operationId: value.operationId, backend: "revmux", reviewedCommit: value.reviewedCommit,
    cwd: value.cwd, prompt: value.prompt, executionLifetime,
    ...(typeof value.profile === "string" ? { profile: value.profile } : {}) };
}

export interface RevmuxReviewOptions {
  cwd: string;
  stateDirectory: string;
  reviewedCommit: string;
  executable?: string;
  kernelRuntimeModule?: string;
}

const execFileAsync = promisify(execFile);
const REVMUX_PREFLIGHT_TIMEOUT_MS = 5_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OWNED_TREE = { version: 1, scope: "owned-process-tree", escapedDescendants: "contained" } as const;
type KernelRuntime = typeof import("pi-subagents/kernel-owned-process");

/** The monitor owns the CLI handle across Pi restarts; an intent is never relaunched after claiming it. */
export class RevmuxReviewClient {
  constructor(private readonly options: RevmuxReviewOptions) {}

  async capabilities(): Promise<FusionCapabilities> {
    try {
      const { stdout } = await execFileAsync(this.options.executable ?? "revmux", ["--capabilities"], {
        cwd: this.options.cwd, timeout: REVMUX_PREFLIGHT_TIMEOUT_MS,
      });
      const value: unknown = JSON.parse(stdout);
      if (!isRecord(value) || value.protocol !== "plan-exec-revmux" || value.version !== 1 || value.supported === false)
        return { healthy: false, durableOperationLookup: true };
      const runtime = await this.kernelRuntime();
      const ownership = await controlDeadline(runtime.preflightKernelOwnedProcess({ artifactDirectory: this.kernelArtifacts() }));
      return { healthy: true, durableOperationLookup: true, processTerminalProofVersion: 1,
        ...(isRecord(value.executionLifetime) && value.executionLifetime.flag === "--execution-lifetime"
          ? executionLifetimeCapabilities(value.executionLifetime) : {}),
        ...(ownership.supported ? { processTreeOwnership: OWNED_TREE } : {}) };
    } catch {
      return { healthy: false, durableOperationLookup: true };
    }
  }

  async start(operationId: string, prompt: string, profile?: string,
    executionLifetime: ExecutionLifetime = { mode: "unbounded" }, callerDigest?: string,
    context?: ReviewExecutionContext): Promise<FusionResult> {
    if (callerDigest !== undefined && !callerDigest.trim())
      return failure("invalid_request", "Review request digest must be nonempty.");
    if (context && (resolve(context.cwd) !== resolve(this.options.cwd) || context.reviewedCommit !== this.options.reviewedCommit))
      return failure("conflict", "Review execution context differs from the frozen worktree and commit.");
    const request: ReviewRequest = { operationId, prompt, backend: "revmux",
      reviewedCommit: this.options.reviewedCommit, cwd: resolve(this.options.cwd),
      executionLifetime, ...(profile ? { profile } : {}) };
    const directory = this.directory(operationId);
    const digest = reviewRequestDigest(request);
    await this.reserve(operationId);
    try {
      const existing = await readJson(join(directory, "request.json"));
      if (!isRecord(existing) || existing.digest !== digest || existing.callerDigest !== callerDigest)
        return failure("conflict", "Review operation identity already belongs to a different request.");
      return this.observe(operationId);
    } catch (error) {
      if (!missingFile(error)) return failure("malformed", String(error));
    }
    const lifetime = parseExecutionLifetime(executionLifetime);
    if (!lifetime) return failure("invalid_request", "Invalid review execution lifetime.");
    const admission = await optionalJson(join(directory, "admission.json"));
    if (!isRecord(admission) || admission.state !== "never-started") {
      const capabilities = await this.capabilities();
      if (!capabilities.healthy || !capabilities.executionLifetimeModes?.includes(executionLifetime.mode) ||
        !supportsOwnedProcessTree(capabilities))
        return failure("unsupported", "Revmux requires explicit execution-lifetime and observed process-tree proof capabilities.");
    }
    const inserted = await insertJson(join(directory, "request.json"), { request, digest,
      ...(callerDigest ? { callerDigest } : {}), executable: this.options.executable ?? "revmux",
      kernelArgv: [process.execPath, "-e", REVMUX_PAYLOAD, directory],
      env: workspaceEnvironment() });
    if (!inserted) return this.start(operationId, prompt, profile, lifetime, callerDigest, context);
    return this.observe(operationId);
  }

  private async reserve(operationId: string): Promise<string> {
    const directory = this.directory(operationId);
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await insertJson(join(directory, "identity.json"), { version: 1, operationId });
    const identity = await readJson(join(directory, "identity.json"));
    if (!isRecord(identity) || identity.version !== 1 || identity.operationId !== operationId)
      throw new Error("Review admission identity is malformed.");
    return directory;
  }

  private async kernelRuntime(): Promise<KernelRuntime> {
    return await import(this.options.kernelRuntimeModule ?? "pi-subagents/kernel-owned-process") as KernelRuntime;
  }

  private kernelArtifacts(): string {
    return join(resolve(this.options.stateDirectory), "kernel-artifacts");
  }

  private async prepareExecution(directory: string, stored: Record<string, unknown>): Promise<{
    request: KernelOwnedProcessRequest; prepared: PreparedKernelOwnedProcess; runtime: KernelRuntime;
  }> {
    if (!isRecord(stored.request) || typeof stored.request.cwd !== "string" || !isRecord(stored.env) ||
      Object.values(stored.env).some((value) => typeof value !== "string") ||
      !Array.isArray(stored.kernelArgv) || !stored.kernelArgv.length ||
      stored.kernelArgv.some((value: unknown) => typeof value !== "string"))
      throw new Error("Review command environment is missing; refusing to reconstruct a dispatched request.");
    const lifetime = parseExecutionLifetime(stored.request.executionLifetime);
    if (!lifetime) throw new Error("Review execution lifetime is missing.");
    const request: KernelOwnedProcessRequest = {
      operationDirectory: join(directory, "kernel-operation"), artifactDirectory: this.kernelArtifacts(),
      argv: stored.kernelArgv as [string, ...string[]], cwd: stored.request.cwd,
      env: stored.env as Record<string, string>, lifetime: lifetime.mode === "unbounded"
        ? { kind: "unbounded" } : { kind: "bounded", timeoutMs: lifetime.timeoutMs },
    };
    const runtime = await this.kernelRuntime();
    const prepared = await controlDeadline(runtime.prepareKernelOwnedProcess(request));
    const receiptPath = join(directory, "kernel-binding.json");
    await insertJson(receiptPath, prepared);
    const receipt = await readJson(receiptPath);
    if (!sameKernelBinding(receipt, prepared)) throw new Error("Review kernel ownership binding changed.");
    return { request, prepared, runtime };
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
    const directory = await this.reserve(id);
    await insertJson(join(directory, "admission.json"), { operationId: id, state: "never-started" });
    await insertJson(join(directory, "cancel"), { operationId: id });
    const admission = await readJson(join(directory, "admission.json"));
    if (isRecord(admission) && admission.state === "dispatching") {
      const runtime = await this.kernelRuntime();
      await controlDeadline(runtime.cancelKernelOwnedProcess(join(directory, "kernel-operation"),
        { deadlineMs: REVMUX_PREFLIGHT_TIMEOUT_MS }));
    }
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
    const directory = await this.reserve(operationId);
    let stored: unknown;
    let admission: unknown;
    try {
      stored = await optionalJson(join(directory, "request.json"));
      admission = await optionalJson(join(directory, "admission.json"));
    } catch { return failure("malformed", "Review admission journal is unreadable."); }
    const requestDigest = isRecord(stored)
      ? typeof stored.callerDigest === "string" ? stored.callerDigest : stored.digest : undefined;
    if (admission !== undefined && (!isRecord(admission) || admission.operationId !== operationId ||
      (admission.state !== "never-started" && admission.state !== "dispatching")))
      return failure("launch_unknown", "Review admission winner is malformed; replay is not safe.");
    if (isRecord(admission) && admission.operationId === operationId && admission.state === "never-started")
      return { success: true, data: { operationId, state: FUSION_PHASE.CANCELLED,
        cancellationRequested: true, neverStarted: true, replaySafe: false,
        ...(typeof requestDigest === "string" ? { requestDigest } : {}) } };
    if (stored === undefined) {
      for (const artifact of ["admission.json", "claimed", "outcome.json", "process-proof.json", "cancel", "kernel-binding.json", "kernel-operation"])
        if (await filePresent(join(directory, artifact)))
          return failure("launch_unknown", "Review execution evidence exists without its immutable request; replay is not safe.");
      return { success: true, data: { operationId, state: "absent", replaySafe: true } };
    }
    const registeredRequest = isRecord(stored) ? storedReviewRequest(stored.request) : undefined;
    if (!isRecord(stored) || !registeredRequest || registeredRequest.operationId !== operationId ||
      stored.digest !== reviewRequestDigest(registeredRequest))
      return failure("malformed", "Review launch identity is malformed.");
    if (await filePresent(join(directory, "claimed")) && !await filePresent(join(directory, "kernel-binding.json")))
      return failure("launch_unknown", "Legacy reviewer monitor has no kernel ownership receipt; retaining ownership.");
    let prepared: PreparedKernelOwnedProcess;
    let observation: KernelOwnedProcessObservation;
    try {
      const execution = await this.prepareExecution(directory, stored);
      prepared = execution.prepared;
      await insertJson(join(directory, "admission.json"), { operationId, state: "dispatching" });
      const admitted = await readJson(join(directory, "admission.json"));
      if (!isRecord(admitted) || admitted.state !== "dispatching") return this.observe(operationId);
      const cancelled = await filePresent(join(directory, "cancel"));
      if (cancelled) {
        observation = await controlDeadline(execution.runtime.cancelKernelOwnedProcess(execution.request.operationDirectory,
          { deadlineMs: REVMUX_PREFLIGHT_TIMEOUT_MS }));
      } else {
        observation = await controlDeadline(execution.runtime.observeKernelOwnedProcess(execution.request.operationDirectory));
        if (observation.status === EXTERNAL_OPERATION_STATE.PENDING)
          observation = (await controlDeadline(execution.runtime.launchKernelOwnedProcess(execution.request))).observation;
      }
    } catch (error) { return failure("launch_unknown", `Review kernel operation needs reconciliation: ${String(error)}`); }
    const lifetime = registeredRequest.executionLifetime;
    const data: Record<string, unknown> = { operationId,
      ...(typeof requestDigest === "string" ? { requestDigest } : {}),
      replaySafe: false, neverStarted: false,
      cancellationRequested: await filePresent(join(directory, "cancel")),
      reviewedCommit: registeredRequest.reviewedCommit,
      ...(lifetime ? { effectiveExecutionLifetime: lifetime } : {}),
      run: { runId: operationId, operationId, phase: FUSION_PHASE.PANEL, terminal: false } };
    if (observation.status === "never-started" && sameKernelBinding(observation.proof, prepared) &&
      observation.proof?.kind === "never-started" && data.cancellationRequested === true)
      return { success: true, data: { operationId, requestDigest, state: FUSION_PHASE.CANCELLED,
        cancellationRequested: true, neverStarted: true, replaySafe: false } };
    if (observation.status !== "retired" || !hasKernelRetirementProof(observation, prepared))
      return { success: true, data: { ...data,
        ...(observation.reason ? { error: observation.reason } : {}) } };
    const proof = observation.proof;
    if (!proof || proof.kind !== "darwin-coalition-retired") return failure("malformed", "Review kernel retirement proof is missing.");
    data.processTerminalProof = { version: 1, state: "observed", runId: operationId,
      runnerProcessInstanceId: `${proof.identity.coalitionId}:${proof.identity.leader.uniqueId}`,
      observedAt: Date.parse(proof.observedAt), processTreeOwnership: OWNED_TREE,
      callerBinding: { operationId, requestDigest }, nativeOperation: { operationId, digest: stored.digest },
      kernelBinding: kernelBinding(prepared), kernelProof: observation };
    const outcome = await optionalJson(join(directory, "outcome.json"));
    const success = isRecord(outcome) && (outcome.code === 0 || outcome.code === 1) &&
      (observation.exitCode === 0 || observation.exitCode === 1);
    const cancelled = data.cancellationRequested === true;
    data.run = { runId: operationId, operationId,
      phase: cancelled ? FUSION_PHASE.CANCELLED : success ? FUSION_PHASE.DONE : FUSION_PHASE.FAILED,
      terminal: true, ...(!success && !cancelled ? { error: "Review CLI failed or its complete outcome receipt is missing." } : {}) };
    if (success && !cancelled) {
      try {
        const findings = parseRevmuxReport(await readJson(join(directory, "report.json")));
        data.callerOutput = { contract: PLAN_REVIEW_OUTPUT_CONTRACT,
          output: findings.length ? formatFindings(findings.map((finding) => ({
            ...finding, suggestion: finding.suggestion ?? UNAVAILABLE_REVMUX_FIX,
          }))) : "NO_FINDINGS" };
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

async function optionalJson(path: string): Promise<unknown> {
  try { return await readJson(path); }
  catch (error) { if (missingFile(error)) return undefined; throw error; }
}

async function filePresent(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if (missingFile(error)) return false; throw error; }
}

/** Publish fully written immutable records; readers never see a partially written admission. */
async function insertJson(path: string, value: unknown): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", PRIVATE_FILE_MODE);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") return false;
    throw error;
  } finally { await unlink(temporary); }
}

function missingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function failure(code: string, message: string): FusionResult {
  return { success: false, error: { code, message } };
}

function kernelBinding(value: KernelOperationBinding): KernelOperationBinding {
  return { operationId: value.operationId, requestDigest: value.requestDigest, hostId: value.hostId, bootId: value.bootId };
}

function sameKernelBinding(value: unknown, expected: KernelOperationBinding): boolean {
  return isRecord(value) && value.operationId === expected.operationId && value.requestDigest === expected.requestDigest &&
    value.hostId === expected.hostId && value.bootId === expected.bootId;
}

async function controlDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Kernel ownership control request timed out; reconcile the same operation.")),
        REVMUX_PREFLIGHT_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const REVMUX_PAYLOAD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const dir = process.argv[1];
const filename = name => path.join(dir, name);
const persist = (name, value) => {
  const target = filename(name);
  const temporary = target + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temporary, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
};
const {request, executable} = JSON.parse(fs.readFileSync(filename('request.json'), 'utf8'));
const cancelled = () => fs.existsSync(filename('cancel'));
const failed = error => {
  persist('outcome.json', {code:2,cancelled:cancelled(),error});
  process.exitCode = 2;
};
if (cancelled()) { failed('Review cancelled before CLI dispatch.'); process.exit(2); }
const tasks = filename('rounds');
const common = ['--task','review','--run','01','--tasks-dir',tasks];
let paths;
try {
  paths = JSON.parse(cp.execFileSync(executable, ['new', ...common], {cwd:request.cwd,encoding:'utf8',timeout:5000}));
  fs.writeFileSync(paths.scope, request.prompt + '\n\nReview exactly commit ' + request.reviewedCommit + '.\n');
  fs.writeFileSync(paths.goal, 'Required review of the supplied commit. Return complete findings with evidence.\n');
} catch (error) { failed(String(error)); process.exit(2); }
if (cancelled()) { failed('Review cancelled before CLI dispatch.'); process.exit(2); }
const argv = [...common,'--workdir',request.cwd,'--no-tui','--execution-lifetime='+request.executionLifetime.mode,
  ...(request.executionLifetime.mode === 'bounded' ? ['--hard-timeout='+request.executionLifetime.timeoutMs+'ms','--idle-timeout=0s'] : []),
  ...(request.profile ? ['--profile',request.profile] : [])];
const stdout = fs.openSync(filename('report.json'), 'w');
const stderr = fs.openSync(filename('stderr.log'), 'a');
let child;
try { child = cp.spawn(executable, argv, {cwd:request.cwd,stdio:['ignore',stdout,stderr]}); }
catch (error) { failed(String(error)); process.exit(2); }
child.once('error', error => { failed(String(error)); });
child.once('close', (code, signal) => {
  fs.closeSync(stdout); fs.closeSync(stderr);
  persist('outcome.json', {code,signal,cancelled:cancelled()});
  process.exitCode = code === 0 || code === 1 ? code : 2;
});
`;
