import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { acquireLock, LockTimeoutError } from "../src/registry-lock.js";
import { RunRegistry } from "../src/registry.js";
import { DEFAULT_FROZEN_RUN_CONFIG } from "../src/types.js";

const fixture = new URL("./fixtures/registry-lock-worker.ts", import.meta.url);
function worker(t: TestContext, args: string[], env?: NodeJS.ProcessEnv) {
  const child = fork(fixture, args, { execArgv: ["--import", "jiti/register"], silent: true, ...(env ? { env } : {}) });
  const events: Array<{ event: string; value: unknown }> = [];
  let waiting: (() => void) | undefined;
  let output = "";
  child.stderr?.on("data", data => { output += String(data); });
  child.on("message", message => {
    events.push(message as { event: string; value: unknown });
    waiting?.();
  });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child,
    exited,
    send: (message: string) => child.send(message),
    async event(name: string): Promise<unknown> {
      while (!events.length) {
        await Promise.race([
          new Promise<void>(resolve => { waiting = resolve; }),
          exited.then(() => { throw new Error(`Worker exited before ${name}: ${output}`); }),
        ]);
        waiting = undefined;
      }
      const event = events.shift()!;
      assert.equal(event.event, name, output);
      return event.value;
    },
  };
}
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "registry-kernel-lock-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("kernel lock survives old metadata and only releases on owner death", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const path = join(root, "held.lock");
  const holder = worker(t, ["hold", path]);
  await holder.event("held");
  const before = await stat(path);
  await writeFile(path, JSON.stringify({ pid: -1, createdAt: 1 }));
  await utimes(path, new Date(0), new Date(0));
  const contender = worker(t, ["probe", path]);
  await contender.event("contended");
  assert.equal((await contender.exited).code, 0);
  holder.child.kill("SIGKILL");
  await holder.exited;
  const recovered = await acquireLock(path, 1);
  assert.equal((await stat(path)).ino, before.ino);
  await recovered.release();
});

test("releasing an old handle twice cannot release its successor", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const path = join(root, "held.lock");
  const first = worker(t, ["hold", path]);
  await first.event("held");
  first.send("release");
  await first.event("released");
  const successor = worker(t, ["hold", path]);
  await successor.event("held");
  first.send("release-again");
  await first.event("released-again");
  await assert.rejects(acquireLock(path, 1), LockTimeoutError);
  first.send("quit");
  assert.equal((await first.exited).code, 0);
  successor.child.kill("SIGKILL");
  await successor.exited;
  const recovered = await acquireLock(path, 1);
  await recovered.release();
});

test("two crash recoverers admit only one run while the first pauses before publication", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const crashed = worker(t, ["hold", join(root, "registry.lock")]);
  await crashed.event("held");
  crashed.child.kill("SIGKILL");
  await crashed.exited;
  const first = worker(t, ["create", root, "first"]);
  await first.event("checked");
  const second = worker(t, ["create", root, "contender"]);
  await second.event("contended");
  assert.equal((await new RunRegistry(root).list()).length, 0);
  first.send("publish");
  const admitted = await first.event("result") as { created: boolean };
  const refused = await second.event("result") as { created: boolean; error: string };
  assert.equal(admitted.created, true);
  assert.equal(refused.created, false);
  assert.match(refused.error, /Plan execution already exists/);
  assert.equal((await new RunRegistry(root).list()).length, 1);
  assert.equal((await first.exited).code, 0);
  assert.equal((await second.exited).code, 0);
});

test("cross-process compare-and-set applies exactly one shared revision", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const registry = new RunRegistry(root);
  const run = await registry.create({
    schemaVersion: 1, repositoryRoot: root, planPath: join(root, "plan.md"), planHash: "hash",
    worktreeCwd: root, branch: "feature", defaultBranch: "main", status: "running", stage: "implementation",
    taskAttempts: {}, stageAttempts: {}, reviewFindings: [], unresolvedFindings: [], config: DEFAULT_FROZEN_RUN_CONFIG,
  });
  const snapshot = join(root, "snapshot.json");
  await writeFile(snapshot, JSON.stringify(run));
  const crashed = worker(t, ["hold", join(root, ".locks", `${run.id}.record.lock`)]);
  await crashed.event("held");
  const first = worker(t, ["update", root, snapshot]);
  const second = worker(t, ["update", root, snapshot]);
  await Promise.all([first.event("ready"), second.event("ready")]);
  first.send("update");
  second.send("update");
  crashed.child.kill("SIGKILL");
  await crashed.exited;
  const results = await Promise.all([first.event("result"), second.event("result")]) as Array<{ applied: boolean }>;
  assert.equal(results.filter(result => result.applied).length, 1);
  assert.equal((await registry.get(run.id))?.revision, 2);
  assert.equal((await first.exited).code, 0);
  assert.equal((await second.exited).code, 0);
});

test("cold native compilation needs no Node headers or checkout artifacts", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const child = worker(t, ["hold", join(root, "lock")], { ...process.env, TMPDIR: root });
  await child.event("held");
  child.send("release");
  await child.event("released");
  child.send("release-again");
  await child.event("released-again");
  child.send("quit");
  assert.equal((await child.exited).code, 0);
  const cachePath = join(root, `pi-plan-exec-registry-lock-${process.getuid!()}`);
  const cache = await stat(cachePath);
  assert.equal(cache.mode & 0o777, 0o700);
  const binaries = (await readdir(cachePath)).filter(name => name.endsWith(".node"));
  assert.equal(binaries.length, 1);
  assert.equal((await stat(join(cachePath, binaries[0]!))).mode & 0o777, 0o600);
});

test("removing a run preserves the lock inodes seen by waiting writers", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const registry = new RunRegistry(root);
  const run = await registry.create({
    schemaVersion: 1, repositoryRoot: root, planPath: join(root, "plan.md"), planHash: "hash",
    worktreeCwd: root, branch: "feature", defaultBranch: "main", status: "completed", stage: "complete",
    taskAttempts: {}, stageAttempts: {}, reviewFindings: [], unresolvedFindings: [], config: DEFAULT_FROZEN_RUN_CONFIG,
  });
  await registry.withControllerLock(run.id, async () => undefined);
  const controllerPath = join(root, ".locks", `${run.id}.controller.lock`);
  const recordPath = join(root, ".locks", `${run.id}.record.lock`);
  const before = await Promise.all([stat(controllerPath), stat(recordPath)]);
  assert.equal(await registry.remove(run.id), true);
  const after = await Promise.all([stat(controllerPath), stat(recordPath)]);
  assert.deepEqual(after.map(value => value.ino), before.map(value => value.ino));
  await assert.rejects(registry.updateIfCurrent(run, run.updatedAt), /run not found/);
  assert.equal(await registry.get(run.id), undefined);
});

test("distributed TypeScript lock module works outside the checkout with a fresh compiler cache", { timeout: 15_000 }, async t => {
  const root = await directory(t);
  const consumer = join(root, "consumer");
  await mkdir(consumer);
  await copyFile(new URL("../src/registry-lock.ts", import.meta.url), join(consumer, "registry-lock.ts"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  const jiti = createRequire(import.meta.url).resolve("jiti");
  await writeFile(join(consumer, "probe.mjs"), `
    import { createJiti } from ${JSON.stringify(jiti)};
    const { acquireLock } = await createJiti(import.meta.url).import("./registry-lock.ts");
    const lock = await acquireLock(${JSON.stringify(join(root, "consumer.lock"))});
    await lock.release();
  `);
  const child = fork(join(consumer, "probe.mjs"), [], {
    execArgv: [], silent: true, cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, TMPDIR: root },
  });
  let error = "";
  child.stderr?.on("data", data => { error += String(data); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, error);
});
