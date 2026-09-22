import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

/**
 * Local replacement for the removed kernel-owned-process runtime.
 *
 * Ownership is a POSIX process group: the launcher spawns the worker detached,
 * records the leader pid and its `ps` start identity, and proves retirement
 * with a writer-exit result plus a dead group. Liveness is ps-based, so the
 * guarantees stop at "best effort" for descendants that detach into a new
 * group of their own.
 */

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const CANCEL_POLL_MS = 25;
const DEFAULT_CANCEL_DEADLINE_MS = 2_000;
const HOST_ID_LENGTH = 32;
const LAUNCH_CLAIM_GRACE_MS = 30_000;
const MILLISECONDS_PER_SECOND = 1_000;
const execFileAsync = promisify(execFile);

export type OwnedProcessLifetime =
  | { kind: 'unbounded' }
  | { kind: 'bounded'; timeoutMs: number };

export interface OwnedProcessRequest {
  operationDirectory: string;
  argv: [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  lifetime: OwnedProcessLifetime;
}

export interface OwnedProcessBinding {
  operationId: string;
  requestDigest: string;
  hostId: string;
  bootId: string;
}

export interface OwnedProcessIdentity {
  version: 1;
  backend: 'posix-process-group-v1';
  pgid: number;
  leader: { pid: number; startIdentity: string };
}

export interface OwnedProcessProof {
  version: 1;
  kind: 'process-group-retired' | 'never-started';
  operationId: string;
  requestDigest: string;
  hostId: string;
  bootId: string;
  observedAt: string;
  identity?: OwnedProcessIdentity;
}

export interface OwnedProcessObservation {
  status: 'pending' | 'running' | 'retired' | 'never-started' | 'unknown';
  binding?: OwnedProcessBinding;
  identity?: OwnedProcessIdentity;
  proof?: OwnedProcessProof;
  exitCode?: number | null;
  reason?: string;
}

interface OwnedProcessRecord extends OwnedProcessBinding {
  version: 1;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  lifetime: OwnedProcessLifetime;
}

interface LaunchRecord {
  version: 1;
  operationId: string;
  requestDigest: string;
  hostId: string;
  bootId: string;
  pid: number;
  pgid: number;
  startedAt: number;
  startIdentity: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Unreadable owned process journal: ${path}`, {
      cause: error,
    });
  }
}

async function writerExitCode(
  writerDirectory: string,
): Promise<number | null | undefined> {
  const result = await json(join(writerDirectory, 'result.json'));
  if (
    record(result) &&
    (result.code === null || typeof result.code === 'number')
  )
    return result.code;
  const outcome = await json(join(writerDirectory, 'outcome.json'));
  return record(outcome) &&
    (outcome.code === null || typeof outcome.code === 'number')
    ? outcome.code
    : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publish(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

/** One launcher claims the operation; a second sees EEXIST and observes instead. */
async function claimLaunch(path: string, value: unknown): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // A leftover temporary is harmless.
    }
  }
}

/** Immutable launch intent: a second writer loses and the first record wins. */
async function publishImmutable(
  path: string,
  value: unknown,
): Promise<unknown> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // The link already carries the record; a leftover temporary is harmless.
    }
  }
  return json(path);
}

let hostIdentity: Promise<{ hostId: string; bootId: string }> | undefined;

/** Stable host id plus a boot id that changes when the machine restarts. */
function currentHostIdentity(): Promise<{ hostId: string; bootId: string }> {
  hostIdentity ??= (async () => {
    const hostId = createHash('sha256')
      .update(hostname())
      .digest('hex')
      .slice(0, HOST_ID_LENGTH);
    return { hostId, bootId: await currentBootId() };
  })();
  return hostIdentity;
}

async function currentBootId(): Promise<string> {
  try {
    const boot = (
      await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    ).trim();
    if (boot) return boot;
  } catch {
    // Not Linux; fall through to the platform probes.
  }
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.boottime']);
    const seconds = stdout.match(/sec\s*=\s*(\d+)/)?.[1];
    if (seconds) return `darwin-${seconds}`;
  } catch {
    // Not Darwin; fall through to the wall-clock estimate.
  }
  return `uptime-${Math.floor((Date.now() - uptime() * MILLISECONDS_PER_SECOND) / MILLISECONDS_PER_SECOND)}`;
}

function bindingOf(value: unknown): OwnedProcessBinding | undefined {
  if (
    !record(value) ||
    !text(value.operationId) ||
    !text(value.requestDigest) ||
    !text(value.hostId) ||
    !text(value.bootId)
  )
    return undefined;
  return {
    operationId: value.operationId,
    requestDigest: value.requestDigest,
    hostId: value.hostId,
    bootId: value.bootId,
  };
}

function requestDigest(request: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  lifetime: OwnedProcessLifetime;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        argv: request.argv,
        cwd: request.cwd,
        env: request.env,
        lifetime: request.lifetime,
      }),
    )
    .digest('hex');
}

function readRecord(value: unknown): OwnedProcessRecord | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    !text(value.operationId) ||
    !text(value.requestDigest) ||
    !text(value.hostId) ||
    !text(value.bootId) ||
    !Array.isArray(value.argv) ||
    value.argv.some((entry) => typeof entry !== 'string') ||
    !text(value.cwd) ||
    !record(value.env) ||
    Object.values(value.env).some((entry) => typeof entry !== 'string') ||
    !record(value.lifetime)
  )
    return undefined;
  const recordValue = value as unknown as OwnedProcessRecord;
  return requestDigest(recordValue) === recordValue.requestDigest
    ? recordValue
    : undefined;
}

export function ownedProcessBindingMatches(
  a: OwnedProcessBinding | undefined,
  b: OwnedProcessBinding | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.operationId === b.operationId &&
    a.requestDigest === b.requestDigest &&
    a.hostId === b.hostId &&
    a.bootId === b.bootId
  );
}

export function ownedProcessTerminal(
  observation: OwnedProcessObservation,
  binding: OwnedProcessBinding | undefined,
): boolean {
  const proof = observation.proof;
  if (!proof || !ownedProcessBindingMatches(proof, binding)) return false;
  const retired =
    observation.status === 'retired' && proof.kind === 'process-group-retired';
  const neverStarted =
    observation.status === 'never-started' && proof.kind === 'never-started';
  return retired || neverStarted;
}

function proofFor(
  recordValue: OwnedProcessRecord,
  kind: OwnedProcessProof['kind'],
  identity?: OwnedProcessIdentity,
  observedAt = new Date().toISOString(),
): OwnedProcessProof {
  return {
    version: 1,
    kind,
    operationId: recordValue.operationId,
    requestDigest: recordValue.requestDigest,
    hostId: recordValue.hostId,
    bootId: recordValue.bootId,
    observedAt,
    ...(identity ? { identity } : {}),
  };
}

export async function prepareOwnedProcess(
  request: OwnedProcessRequest,
): Promise<OwnedProcessBinding> {
  const directory = request.operationDirectory;
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  if (!request.argv.length || !text(request.argv[0]))
    throw new Error('An owned process needs a program to run.');
  const { hostId, bootId } = await currentHostIdentity();
  const digest = requestDigest(request);
  const existing = readRecord(await json(join(directory, 'request.json')));
  if (existing) {
    if (
      existing.requestDigest !== digest ||
      existing.hostId !== hostId ||
      existing.bootId !== bootId
    ) {
      throw new Error(
        'Owned process request changed; the original operation remains fenced.',
      );
    }
    return bindingOf(existing) as OwnedProcessBinding;
  }
  const created: OwnedProcessRecord = {
    version: 1,
    operationId: randomUUID(),
    requestDigest: digest,
    argv: request.argv,
    cwd: request.cwd,
    env: request.env,
    lifetime: request.lifetime,
    hostId,
    bootId,
  };
  const stored = readRecord(
    await publishImmutable(join(directory, 'request.json'), created),
  );
  if (!stored) throw new Error('Owned process request record is malformed.');
  if (
    stored.requestDigest !== digest ||
    stored.hostId !== hostId ||
    stored.bootId !== bootId
  ) {
    throw new Error(
      'Owned process request changed; the original operation remains fenced.',
    );
  }
  return bindingOf(stored) as OwnedProcessBinding;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function startIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', [
      '-o',
      'lstart=',
      '-p',
      String(pid),
    ]);
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function leaderMatches(
  pid: number,
  expected: string | null,
): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  if (!expected) return true;
  return (await startIdentity(pid)) === expected;
}

function identityOf(launch: LaunchRecord): OwnedProcessIdentity {
  return {
    version: 1,
    backend: 'posix-process-group-v1',
    pgid: launch.pgid,
    leader: { pid: launch.pid, startIdentity: launch.startIdentity ?? '' },
  };
}

function readLaunch(
  value: unknown,
  binding: OwnedProcessBinding,
): LaunchRecord | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.operationId !== binding.operationId ||
    value.requestDigest !== binding.requestDigest ||
    value.hostId !== binding.hostId ||
    value.bootId !== binding.bootId ||
    !positiveInteger(value.pid) ||
    !positiveInteger(value.pgid) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    (value.startIdentity !== null && typeof value.startIdentity !== 'string')
  )
    return undefined;
  return value as unknown as LaunchRecord;
}

async function recordLaunchFailure(
  operationDirectory: string,
  binding: OwnedProcessBinding,
  reason: string,
): Promise<void> {
  try {
    await publish(join(operationDirectory, 'launch-failed.json'), {
      version: 1,
      operationId: binding.operationId,
      requestDigest: binding.requestDigest,
      hostId: binding.hostId,
      bootId: binding.bootId,
      failedAt: new Date().toISOString(),
      reason,
    });
  } catch {
    // Evidence is best effort; the claim removal below is what unblocks retry.
  }
  try {
    await unlink(join(operationDirectory, 'launching.json'));
  } catch {
    // A missing claim is already unblocked.
  }
}

async function storedRetirement(
  operationDirectory: string,
  binding: OwnedProcessBinding,
): Promise<OwnedProcessObservation | undefined> {
  const proof = await json(join(operationDirectory, 'retired.json'));
  if (
    !record(proof) ||
    proof.kind !== 'process-group-retired' ||
    !ownedProcessBindingMatches(bindingOf(proof), binding)
  )
    return undefined;
  const identity = record(proof.identity)
    ? (proof.identity as unknown as OwnedProcessIdentity)
    : undefined;
  // The writer record is final once the group is gone; re-read it so a marker
  // persisted during the publication race never hides the exit code.
  const exitCode = await writerExitCode(dirname(operationDirectory));
  return {
    status: 'retired',
    binding,
    ...(identity ? { identity } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    proof: proof as unknown as OwnedProcessProof,
  };
}

async function persistRetirement(
  operationDirectory: string,
  proof: OwnedProcessProof,
): Promise<void> {
  try {
    await publishImmutable(join(operationDirectory, 'retired.json'), proof);
  } catch {
    // The observation still carries the proof; the marker is an optimization.
  }
}

/** Identity check before any signal: host/boot, retirement marker, leader. */
async function signalableLaunch(
  operationDirectory: string,
): Promise<LaunchRecord | undefined> {
  const binding = bindingOf(
    await json(join(operationDirectory, 'request.json')),
  );
  if (!binding) return undefined;
  const current = await currentHostIdentity();
  if (current.hostId !== binding.hostId || current.bootId !== binding.bootId)
    return undefined;
  if ((await json(join(operationDirectory, 'retired.json'))) !== undefined)
    return undefined;
  const launch = await launchOf(operationDirectory);
  if (!launch) return undefined;
  if (
    pidAlive(launch.pid) &&
    launch.startIdentity !== null &&
    (await startIdentity(launch.pid)) !== launch.startIdentity
  )
    return undefined;
  return launch;
}

export async function observeOwnedProcess(
  operationDirectory: string,
): Promise<OwnedProcessObservation> {
  const stored = await json(join(operationDirectory, 'request.json'));
  if (stored === undefined)
    return { status: 'unknown', reason: 'Owned process request is missing.' };
  const request = requestStubFromRecord(stored);
  const recordValue = request ? readRecord(stored) : undefined;
  const binding = bindingOf(stored);
  if (!recordValue || !binding)
    return {
      status: 'unknown',
      reason: 'Owned process request identity is malformed.',
    };
  const retired = await storedRetirement(operationDirectory, binding);
  if (retired) return retired;
  const current = await currentHostIdentity();
  if (current.hostId !== binding.hostId || current.bootId !== binding.bootId)
    return {
      status: 'unknown',
      reason: 'Owned process host or boot identity changed.',
    };
  const launchRaw = await json(join(operationDirectory, 'launch.json'));
  // Writers publish their terminal record next to the launch intent, one level
  // above the owned-process directory.
  const writerDirectory = dirname(operationDirectory);
  const exitCode = await writerExitCode(writerDirectory);
  if (launchRaw === undefined) {
    const failed = await json(join(operationDirectory, 'launch-failed.json'));
    if (record(failed))
      return {
        status: 'unknown',
        binding,
        reason: `Owned process failed to launch: ${String(failed.reason ?? 'unknown reason')}`,
      };
    const claim = await json(join(operationDirectory, 'launching.json'));
    if (record(claim)) {
      const claimedAt =
        typeof claim.claimedAt === 'number' ? claim.claimedAt : 0;
      // A fresh claim is a peer launcher mid-spawn: wait. A stale claim is a
      // crashed launcher whose worker may still be alive: fence.
      if (Date.now() - claimedAt <= LAUNCH_CLAIM_GRACE_MS)
        return { status: 'pending', binding };
      return {
        status: 'unknown',
        binding,
        reason:
          'Owned process launch is unresolved; a worker may still be alive.',
      };
    }
    if (
      (await pathExists(join(writerDirectory, 'stop.json'))) ||
      (await pathExists(join(operationDirectory, 'stop.json')))
    ) {
      return {
        status: 'never-started',
        binding,
        proof: proofFor(recordValue, 'never-started'),
      };
    }
    return { status: 'pending', binding };
  }
  const launch = readLaunch(launchRaw, binding);
  if (!launch)
    return {
      status: 'unknown',
      reason: 'Owned process launch record identity is malformed.',
    };
  const identity = identityOf(launch);
  if (!(await leaderMatches(launch.pid, launch.startIdentity))) {
    if (!groupAlive(launch.pgid)) {
      // The writer may have published between the first read and the leader
      // check; the exit record is final once the group is gone.
      const finalExit = exitCode ?? (await writerExitCode(writerDirectory));
      const proof = proofFor(recordValue, 'process-group-retired', identity);
      await persistRetirement(operationDirectory, proof);
      return {
        status: 'retired',
        binding,
        identity,
        ...(finalExit !== undefined ? { exitCode: finalExit } : {}),
        proof,
      };
    }
    // The writer exited without a result; report an unknown exit code so the
    // caller terminates the surviving descendants instead of waiting forever.
    return {
      status: 'running',
      binding,
      identity,
      exitCode: exitCode ?? null,
      reason: 'Owned process leader exited; descendants remain.',
    };
  }
  return {
    status: 'running',
    binding,
    identity,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function requestStubFromRecord(
  value: unknown,
): OwnedProcessRequest | undefined {
  if (
    !record(value) ||
    !Array.isArray(value.argv) ||
    value.argv.some((entry) => typeof entry !== 'string') ||
    !text(value.cwd) ||
    !record(value.env) ||
    Object.values(value.env).some((entry) => typeof entry !== 'string') ||
    !record(value.lifetime)
  )
    return undefined;
  return {
    operationDirectory: '',
    argv: value.argv as [string, ...string[]],
    cwd: value.cwd,
    env: value.env as Record<string, string>,
    lifetime: value.lifetime as OwnedProcessLifetime,
  };
}

export function reconcileOwnedProcess(
  operationDirectory: string,
): Promise<OwnedProcessObservation> {
  return observeOwnedProcess(operationDirectory);
}

export async function launchOwnedProcess(
  request: OwnedProcessRequest,
): Promise<OwnedProcessObservation> {
  const binding = await prepareOwnedProcess(request);
  const directory = request.operationDirectory;
  if (await pathExists(join(directory, 'launch.json')))
    return observeOwnedProcess(directory);
  const claimed = await claimLaunch(join(directory, 'launching.json'), {
    version: 1,
    operationId: binding.operationId,
    requestDigest: binding.requestDigest,
    claimedAt: Date.now(),
  });
  if (!claimed) return observeOwnedProcess(directory);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(request.argv[0], request.argv.slice(1), {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordLaunchFailure(directory, binding, reason);
    return {
      status: 'unknown',
      binding,
      reason: `Owned process did not launch: ${reason}`,
    };
  }
  child.once('error', (error: Error) => {
    void recordLaunchFailure(directory, binding, error.message);
  });
  const pid = child.pid;
  if (pid === undefined) {
    // Never call child.kill() here: with no pid Node signals the caller's own
    // process group, which kills the Pi host.
    await recordLaunchFailure(
      directory,
      binding,
      'Owned process did not report a pid.',
    );
    return {
      status: 'unknown',
      binding,
      reason: 'Owned process did not report a pid.',
    };
  }
  const startedAt = Date.now();
  const launch: LaunchRecord = {
    version: 1,
    operationId: binding.operationId,
    requestDigest: binding.requestDigest,
    hostId: binding.hostId,
    bootId: binding.bootId,
    pid,
    pgid: pid,
    startedAt,
    startIdentity: await startIdentity(pid),
  };
  await publish(join(directory, 'launch.json'), launch);
  try {
    await unlink(join(directory, 'launching.json'));
  } catch {
    // A missing claim needs no release.
  }
  child.unref();
  if (request.lifetime.kind === 'bounded') {
    const timer = setTimeout(() => {
      void (async () => {
        if ((await json(join(directory, 'retired.json'))) !== undefined) return;
        await requestOwnedProcessCancellation(directory);
      })();
    }, request.lifetime.timeoutMs);
    timer.unref();
  }
  return observeOwnedProcess(directory);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      // The group is gone or not ours; observation reports what remains.
    }
  }
}

async function launchOf(directory: string): Promise<LaunchRecord | undefined> {
  const raw = await json(join(directory, 'launch.json'));
  const binding = bindingOf(await json(join(directory, 'request.json')));
  return raw === undefined || binding === undefined
    ? undefined
    : readLaunch(raw, binding);
}

export async function requestOwnedProcessCancellation(
  operationDirectory: string,
): Promise<void> {
  const launch = await signalableLaunch(operationDirectory);
  if (launch) signalGroup(launch.pgid, 'SIGTERM');
}

export async function cancelOwnedProcess(
  operationDirectory: string,
  options: { deadlineMs?: number; cancelled?: boolean } = {},
): Promise<OwnedProcessObservation> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_CANCEL_DEADLINE_MS;
  const launch = await signalableLaunch(operationDirectory);
  if (!launch) {
    // A caller that already published its own cancellation fence can retire an
    // operation that never claimed a launch. An unresolved claim is fenced:
    // the worker may be alive even though no launch record was published.
    if (options.cancelled) {
      const stored = await json(join(operationDirectory, 'request.json'));
      const request =
        stored === undefined ? undefined : requestStubFromRecord(stored);
      const recordValue = request ? readRecord(stored) : undefined;
      const binding = bindingOf(stored);
      if (
        (await pathExists(join(operationDirectory, 'launch.json'))) ||
        (await pathExists(join(operationDirectory, 'retired.json')))
      )
        return observeOwnedProcess(operationDirectory);
      const claim = await json(join(operationDirectory, 'launching.json'));
      if (record(claim) && recordValue && binding) {
        const claimedAt =
          typeof claim.claimedAt === 'number' ? claim.claimedAt : 0;
        if (Date.now() - claimedAt > LAUNCH_CLAIM_GRACE_MS)
          return {
            status: 'unknown',
            binding,
            reason:
              'Owned process launch is unresolved; a worker may still be alive.',
          };
      }
      if (recordValue && binding && !record(claim))
        return {
          status: 'never-started',
          binding,
          proof: proofFor(recordValue, 'never-started'),
        };
    }
    return observeOwnedProcess(operationDirectory);
  }
  signalGroup(launch.pgid, 'SIGTERM');
  const until = Date.now() + deadlineMs;
  while (groupAlive(launch.pgid) && Date.now() < until)
    await delay(CANCEL_POLL_MS);
  if (groupAlive(launch.pgid)) {
    signalGroup(launch.pgid, 'SIGKILL');
    const killUntil = Date.now() + deadlineMs;
    while (groupAlive(launch.pgid) && Date.now() < killUntil)
      await delay(CANCEL_POLL_MS);
  }
  return observeOwnedProcess(operationDirectory);
}
