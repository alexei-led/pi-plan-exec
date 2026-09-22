import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readPlan } from "../src/plan.js";
import { localOperationDirectory } from "../src/local-operation.js";
import { RunRegistry } from "../src/registry.js";
import { DEFAULT_FROZEN_RUN_CONFIG } from "../src/types.js";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const controllerFixture = fileURLToPath(new URL("./fixtures/owned-git-controller.mjs", import.meta.url));
const nativeOptions = { skip: process.platform === "win32" ? "requires a POSIX process group" : false };
const SESSION_ID = "owned-git-controller-death";

type GitResult = { stdout: string; stderr: string; code: number };

async function git(cwd: string, ...args: string[]): Promise<GitResult> {
  try {
    const result = await execute("git", args, { cwd });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
  }
}

async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, ...args);
  assert.equal(result.code, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
    }
    await delay(25);
  }
}

async function fileText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function waitForFile(path: string, label = path): Promise<string> {
  return waitFor(label, () => fileText(path));
}

function lineCount(text: string | undefined): number {
  return text?.trim() ? text.trim().split("\n").length : 0;
}

async function waitForLine(path: string, expected: number, label: string): Promise<void> {
  await waitFor(label, async () => lineCount(await fileText(path)) >= expected ? true : undefined);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    if (!child.kill("SIGKILL")) resolve();
  });
}

async function ownedWriter(path: string, gate: string, pid: number): Promise<boolean> {
  try {
    const result = await execute("ps", ["-p", String(pid), "-o", "command="]);
    return result.stdout.includes(path) && result.stdout.includes(gate);
  } catch {
    return false;
  }
}

async function terminateDetachedWriters(path: string, gate: string): Promise<void> {
  const text = await fileText(path);
  for (const raw of text?.trim().split("\n") ?? []) {
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!await ownedWriter(path, gate, pid)) continue;
    try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  await delay(50);
  for (const raw of text?.trim().split("\n") ?? []) {
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!await ownedWriter(path, gate, pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

async function childExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0);
    return;
  }
  await waitFor("controller child exit", async () => child.exitCode !== null || child.signalCode !== null ? true : undefined, timeoutMs);
  assert.equal(child.exitCode, 0);
}

function controllerProcess(
  mode: "start" | "tick" | "until-spawn",
  root: string,
  registryDirectory: string,
  statePath: string,
  markerPath: string,
  readyPath: string,
  executorEntryPath: string,
  value: string,
): ChildProcess {
  const child = spawn(process.execPath, ["--import", "jiti/register", controllerFixture, mode, root, registryDirectory, SESSION_ID, statePath, markerPath, readyPath, executorEntryPath, value], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

async function createHookFixture(kind: "post-checkout" | "post-merge", plan: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "owned-git-controller-")));
  const root = join(directory, "repo");
  const hooks = join(directory, "hooks");
  const gate = join(directory, "gate");
  const hookInvocations = join(directory, "hook-invocations");
  const writerStarted = join(directory, "writer-started");
  const writerDone = join(directory, "writer-done");
  const bridgeMarker = join(directory, "bridge-spawn");
  const statePath = join(directory, "controller-state.json");
  await mkdir(root);
  await mkdir(hooks);
  await gitOk(root, "init", "-b", "main");
  await gitOk(root, "config", "user.email", "test@example.test");
  await gitOk(root, "config", "user.name", "Test");
  await gitOk(root, "config", "commit.gpgSign", "false");
  await writeFile(join(root, ".gitignore"), "owned-git-artifact\n");
  await writeFile(join(root, "plan.md"), plan);
  await gitOk(root, "add", ".gitignore", "plan.md");
  await gitOk(root, "commit", "-m", "baseline");
  await writeHook(join(hooks, kind), gate, hookInvocations, writerStarted, writerDone);
  await gitOk(root, "config", "core.hooksPath", hooks);
  return { directory, root, hooks, gate, hookInvocations, writerStarted, writerDone, bridgeMarker, statePath };
}

async function writeHook(path: string, gate: string, invocations: string, started: string, done: string): Promise<void> {
  const writer = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const gate = ${JSON.stringify(gate)};
const started = ${JSON.stringify(started)};
const done = ${JSON.stringify(done)};
const artifact = ${JSON.stringify("owned-git-artifact")};
appendFileSync(started, String(process.pid) + "\\n");
const timer = setInterval(() => {
  if (!existsSync(gate)) return;
  writeFileSync(artifact, "owned by detached Git hook\\n");
  appendFileSync(done, String(process.pid) + "\\n");
  clearInterval(timer);
  process.exit(0);
}, 20);
`;
  const hook = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
appendFileSync(${JSON.stringify(invocations)}, String(process.pid) + "\\n");
const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(writer)}], { cwd: process.cwd(), detached: true, stdio: "ignore" });
child.unref();
`;
  await writeFile(path, hook);
  await chmod(path, 0o755);
}

async function releaseAndClean(fixture: Awaited<ReturnType<typeof createHookFixture>>, children: ChildProcess[], extraPaths: string[] = []): Promise<void> {
  await writeFile(fixture.gate, "release\n");
  let retired = true;
  try { await waitForLine(fixture.writerDone, 1, "detached Git hook writer retirement"); }
  catch { retired = false; }
  for (const child of children) await terminate(child);
  if (!retired) await terminateDetachedWriters(fixture.writerStarted, fixture.gate);
  for (const path of extraPaths) {
    const removed = await git(fixture.root, "worktree", "remove", "--force", path);
    if (removed.code !== 0) await rm(path, { recursive: true, force: true });
  }
  await git(fixture.root, "worktree", "prune");
  await rm(fixture.directory, { recursive: true, force: true });
}

async function readControllerState(path: string): Promise<{ id: string; lane?: string; status: string; stage: string }> {
  return JSON.parse(await waitForFile(path, "controller state")) as { id: string; lane?: string; status: string; stage: string };
}

async function assertSameOperationIntent(root: string, runId: string, operationId: string, before: string | undefined): Promise<string> {
  const directory = localOperationDirectory({ journalRoot: join(root, ".git", "plan-exec-local"), runId, operationId, authorization: { path: "unused", stopGeneration: 0 } });
  const intent = await waitForFile(join(directory, "intent.json"), "durable Git operation intent");
  const digest = createHash("sha256").update(intent).digest("hex");
  if (before !== undefined) assert.equal(digest, before);
  return digest;
}

async function waitForOperationEntry(path: string, operationId: string): Promise<void> {
  await waitFor("owned executor entry", async () => {
    const text = await fileText(path);
    return text?.split("\n").some((line) => {
      if (!line) return false;
      try { return (JSON.parse(line) as { operationId?: string }).operationId === operationId; }
      catch { return false; }
    }) ? true : undefined;
  });
}

test("owned post-checkout survives controller death and reconciles without duplicate worktree creation", nativeOptions, async () => {
  const fixture = await createHookFixture("post-checkout", "### Task 1: A\n- [ ] A\n");
  const children: ChildProcess[] = [];
  let lane: string | undefined;
  try {
    const startReady = join(fixture.directory, "start-ready");
    const startEntry = join(fixture.directory, "start-entry");
    const controller = controllerProcess("start", fixture.root, join(fixture.root, ".git", "runs"), fixture.statePath, fixture.bridgeMarker, startReady, startEntry, "plan.md");
    children.push(controller);
    await waitForFile(startReady, "initial controller readiness");
    const started = await readControllerState(fixture.statePath);
    lane = started.lane;
    assert.ok(lane);
    await waitFor("worktree HEAD and detached writer", async () => {
      const head = await git(lane!, "rev-parse", "HEAD");
      return head.code === 0 && await fileText(fixture.writerStarted) !== undefined ? true : undefined;
    });
    const operationId = `git:worktree:${lane}`;
    const intentDigest = await assertSameOperationIntent(fixture.root, started.id, operationId, undefined);
    await terminate(controller);
    assert.equal(lineCount(await fileText(fixture.hookInvocations)), 1);

    const restartReady = join(fixture.directory, "restart-ready");
    const restartEntry = join(fixture.directory, "restart-entry");
    const restarted = controllerProcess("until-spawn", fixture.root, join(fixture.root, ".git", "runs"), fixture.statePath, fixture.bridgeMarker, restartReady, restartEntry, started.id);
    children.push(restarted);
    await waitForFile(restartReady, "restarted controller readiness");
    assert.equal(lineCount(await fileText(restartEntry)), 0);
    await waitForOperationEntry(restartEntry, operationId);
    assert.equal(lineCount(await fileText(fixture.bridgeMarker)), 0);
    assert.equal(lineCount(await fileText(fixture.writerDone)), 0);
    assert.equal(await assertSameOperationIntent(fixture.root, started.id, operationId, intentDigest), intentDigest);

    await writeFile(fixture.gate, "release\n");
    await waitForLine(fixture.writerDone, 1, "post-checkout writer completion");
    await childExit(restarted);
    assert.equal(lineCount(await fileText(fixture.hookInvocations)), 1);
    assert.equal(lineCount(await fileText(fixture.bridgeMarker)), 1);
    assert.equal(await gitOk(fixture.root, "worktree", "list", "--porcelain").then((output) => output.includes(lane!)), true);
    assert.equal(await readFile(join(lane!, "owned-git-artifact"), "utf8"), "owned by detached Git hook\n");
    assert.equal((await git(lane!, "status", "--porcelain", "--", "owned-git-artifact")).stdout, "");
    assert.equal((await git(lane!, "check-ignore", "--", "owned-git-artifact")).code, 0);
  } finally {
    await releaseAndClean(fixture, children, lane ? [lane] : []);
  }
});

test("owned post-merge survives controller death and promotes the same accepted candidate", nativeOptions, async () => {
  const fixture = await createHookFixture("post-merge", "### Task 1: A\n- [x] A\n");
  const children: ChildProcess[] = [];
  const lane = join(fixture.directory, "internal-lane");
  try {
    const baseline = await gitOk(fixture.root, "rev-parse", "HEAD");
    await gitOk(fixture.root, "worktree", "add", "-b", "internal-output", lane, baseline);
    await writeFile(join(lane, "accepted.txt"), "accepted output\n");
    await gitOk(lane, "add", "accepted.txt");
    await gitOk(lane, "commit", "-m", "accepted output");
    const candidate = await gitOk(lane, "rev-parse", "HEAD");
    const planPath = join(lane, "plan.md");
    const plan = await readPlan(planPath);
    const registry = new RunRegistry(join(fixture.root, ".git", "runs"));
    const run = await registry.create({ schemaVersion: 1, repositoryRoot: fixture.root, planPath, planHash: plan.hash,
      worktreeCwd: lane, branch: "internal-output", defaultBranch: "main", status: "running", stage: "finalize",
      taskAttempts: {}, stageAttempts: {}, reviewFindings: [], unresolvedFindings: [], skippedStages: [], branchRebindings: [],
      acceptedHead: candidate, reviewedCommit: candidate,
      outputTarget: { cwd: fixture.root, branch: "main", initialHead: baseline, planRelativePath: "plan.md" },
      outputPromotion: { candidate, state: "pending", commandStarted: true },
      tasks: { "1": { taskId: 1, dependsOn: [], state: "accepted", attempts: 1, acceptedCommit: candidate, laneCwd: lane, laneBranch: "internal-output", baselineCommit: baseline } },
      config: { ...DEFAULT_FROZEN_RUN_CONFIG, retryDelayMs: 10, statsEnabled: true },
    });
    const startReady = join(fixture.directory, "start-ready");
    const startEntry = join(fixture.directory, "start-entry");
    const controller = controllerProcess("tick", fixture.root, join(fixture.root, ".git", "runs"), fixture.statePath, fixture.bridgeMarker, startReady, startEntry, run.id);
    children.push(controller);
    await waitForFile(startReady, "initial controller readiness");
    await waitFor("promoted HEAD and detached writer", async () => {
      const head = await git(fixture.root, "rev-parse", "HEAD");
      return head.stdout.trim() === candidate && await fileText(fixture.writerStarted) !== undefined ? true : undefined;
    });
    const operationId = `git:promote:${candidate}:0`;
    const intentDigest = await assertSameOperationIntent(fixture.root, run.id, operationId, undefined);
    const intentText = await waitForFile(join(localOperationDirectory({ journalRoot: join(fixture.root, ".git", "plan-exec-local"), runId: run.id, operationId, authorization: { path: "unused", stopGeneration: 0 } }), "intent.json"), "promotion intent");
    assert.equal((JSON.parse(intentText) as { commands?: string[][] }).commands?.[0]?.includes("--no-overwrite-ignore"), true);
    await terminate(controller);
    assert.equal(lineCount(await fileText(fixture.hookInvocations)), 1);

    const restartReady = join(fixture.directory, "restart-ready");
    const restartEntry = join(fixture.directory, "restart-entry");
    const restarted = controllerProcess("until-spawn", fixture.root, join(fixture.root, ".git", "runs"), fixture.statePath, fixture.bridgeMarker, restartReady, restartEntry, run.id);
    children.push(restarted);
    await waitForFile(restartReady, "restarted controller readiness");
    assert.equal(lineCount(await fileText(restartEntry)), 0);
    await waitForOperationEntry(restartEntry, operationId);
    assert.equal(lineCount(await fileText(fixture.bridgeMarker)), 0);
    assert.equal(lineCount(await fileText(fixture.writerDone)), 0);
    assert.equal(await assertSameOperationIntent(fixture.root, run.id, operationId, intentDigest), intentDigest);

    await writeFile(fixture.gate, "release\n");
    await waitForLine(fixture.writerDone, 1, "post-merge writer completion");
    await childExit(restarted);
    assert.equal(lineCount(await fileText(fixture.hookInvocations)), 1);
    assert.equal(await gitOk(fixture.root, "rev-parse", "HEAD"), candidate);
    assert.equal(lineCount(await fileText(fixture.bridgeMarker)), 1);
    assert.equal(lineCount(await fileText(fixture.hookInvocations)), 1);
    assert.equal(await readFile(join(fixture.root, "owned-git-artifact"), "utf8"), "owned by detached Git hook\n");
    assert.equal((await git(fixture.root, "status", "--porcelain", "--", "owned-git-artifact")).stdout, "");
    assert.equal((await git(fixture.root, "check-ignore", "--", "owned-git-artifact")).code, 0);
  } finally {
    await releaseAndClean(fixture, children, [lane]);
  }
});
