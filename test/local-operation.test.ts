import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { cancelActiveLocalOperations, durableJson, hasActiveLocalOperations, localOperationDirectory, LocalOperationCancelledError, LocalOperationFailedError, LocalOperationUnknownError, runLocalOperation, type LocalOperationOptions } from "../src/local-operation.js";
import { cancelOwnedProcess, observeOwnedProcess } from "../src/owned-process.js";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "plan-local-op-"));
  const options: LocalOperationOptions = { journalRoot: cwd, runId: "run", operationId: "checks", candidate: "candidate", isAuthorized: async () => true };
  return { cwd, options, directory: localOperationDirectory(options) };
}

function ownedDirectory(options: LocalOperationOptions, generation?: number): string {
  return join(generation === undefined ? localOperationDirectory(options) : localOperationDirectory({
    ...options, authorization: { path: options.authorization?.path ?? "", stopGeneration: generation },
  }), "owned-process");
}

async function untilFile(path: string): Promise<string> {
  const end = Date.now() + 25_000;
  for (;;) {
    try { return await readFile(path, "utf8"); } catch { if (Date.now() > end) throw new Error(`File absent: ${path}`); }
    await delay(20);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function controllerFor(cwd: string, commands: string[][], options: LocalOperationOptions,
  control?: { gate?: { destination: string; ready: string; resume: string; after?: boolean }; cancelled?: boolean }) {
  const module = new URL("../src/local-operation.ts", import.meta.url).href;
  const script = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const control=${JSON.stringify(control ?? {})};
if(control.gate){
  const originalLink=fs.link;
  fs.link=async(source,destination)=>{
    if(destination!==control.gate.destination)return originalLink(source,destination);
    if(control.gate.after)await originalLink(source,destination);
    await fs.writeFile(control.gate.ready,'ready');
    const deadline=Date.now()+25000;
    for(;;){try{await fs.stat(control.gate.resume);break;}catch(error){if(error.code!=='ENOENT'||Date.now()>deadline)throw error;await delay(20);}}
    if(!control.gate.after)await originalLink(source,destination);
  };
  syncBuiltinESMExports();
}
const loaded=await import(${JSON.stringify(module)});
const {runLocalOperation,LocalOperationCancelledError}=loaded.default??loaded;
let cancelled=false;
try{await runLocalOperation(${JSON.stringify(cwd)},${JSON.stringify(commands)},{...${JSON.stringify(options)},isAuthorized:async()=>true});}
catch(error){if(!control.cancelled||!(error instanceof LocalOperationCancelledError))throw error;cancelled=true;}
if(control.cancelled&&!cancelled)throw Error('Stale dispatcher was not cancelled');
`;
  const child = spawn(process.execPath, ["--import", "jiti/register", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  return child;
}

async function killController(controller: ReturnType<typeof spawn>) {
  if (controller.exitCode !== null || controller.signalCode !== null) return;
  const exited = new Promise<void>(resolve => controller.once("exit", () => resolve()));
  controller.kill("SIGKILL");
  await exited;
}

async function clean(cwd: string, options: LocalOperationOptions) {
  const owned = ownedDirectory(options);
  if (await exists(owned)) {
    const observation = await cancelOwnedProcess(owned, { deadlineMs: 10_000, cancelled: true });
    assert.ok(observation.status === "retired" || observation.status === "never-started",
      `Cleanup retained unproven operation at ${cwd}: ${JSON.stringify(observation)}`);
  }
  await rm(cwd, { recursive: true, force: true });
}

test("lost result reply and concurrent attachment execute the unbounded batch exactly once", async () => {
  const { cwd, options, directory } = await fixture();
  try {
    const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x')"]];
    await Promise.all([runLocalOperation(cwd, commands, options), runLocalOperation(cwd, commands, options)]);
    const oldAmbient = process.env.PI_PLAN_EXEC_REPLAY_AMBIENT;
    process.env.PI_PLAN_EXEC_REPLAY_AMBIENT = "different-controller-session";
    try { await runLocalOperation(cwd, commands, options); }
    finally { if (oldAmbient === undefined) delete process.env.PI_PLAN_EXEC_REPLAY_AMBIENT; else process.env.PI_PLAN_EXEC_REPLAY_AMBIENT = oldAmbient; }
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
    assert.ok(intent.environment.PATH);
    await assert.rejects(runLocalOperation(cwd, commands, { ...options, candidate: "different" }), LocalOperationUnknownError);
  } finally { await clean(cwd, options); }
});

test("controller death leaves one command that a new controller adopts", async () => {
  const { cwd, options } = await fixture();
  const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x'); setTimeout(()=>{},1200)"]];
  const controller = await controllerFor(cwd, commands, options);
  try {
    await untilFile(join(cwd, "count"));
    await killController(controller);
    await runLocalOperation(cwd, commands, options);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
  } finally { await killController(controller); await clean(cwd, options); }
});

test("local worker excludes inherited Git selectors and injected config from its immutable environment", async () => {
  const { cwd, options, directory } = await fixture();
  const inherited = {
    GIT_DIR: join(cwd, "canary-not-a-repository"),
    GIT_WORK_TREE: join(cwd, "canary-not-a-worktree"),
    GIT_INDEX_FILE: join(cwd, "canary-not-an-index"),
    GIT_COMMON_DIR: join(cwd, "canary-not-a-common-directory"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: join(cwd, "canary-config-worktree"),
    GIT_CONFIG_PARAMETERS: "'core.worktree=canary-config-parameters'",
    PI_LOCAL_ENV_CANARY: "preserved",
  };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  try {
    const gitKeys = Object.keys(inherited).filter(key => key.startsWith("GIT_"));
    const commands = [[process.execPath, "-e", `require('fs').writeFileSync('environment.json',JSON.stringify({git:${JSON.stringify(gitKeys)}.filter(key=>process.env[key]!==undefined),canary:process.env.PI_LOCAL_ENV_CANARY}))`]];
    await runLocalOperation(cwd, commands, options);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, "environment.json"), "utf8")), { git: [], canary: "preserved" });
    const originalIntent = await readFile(join(directory, "intent.json"), "utf8");
    const intent = JSON.parse(originalIntent);
    assert.equal(intent.environment.GIT_DIR, undefined);
    assert.equal(intent.environment.GIT_CONFIG_COUNT, undefined);
    process.env.GIT_DIR = join(cwd, "different-replay-canary");
    await runLocalOperation(cwd, commands, options);
    assert.equal(createHash("sha256").update(await readFile(join(directory, "intent.json"))).digest("hex"),
      createHash("sha256").update(originalIntent).digest("hex"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await clean(cwd, options);
  }
});

test("fast detached descendant survives its batch wrapper", async () => {
  const { cwd, options } = await fixture();
  try {
    const descendant = "setTimeout(()=>require('fs').writeFileSync('descendant-done','yes'),600)";
    const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true}).unref()`;
    await runLocalOperation(cwd, [[process.execPath, "-e", command]], options);
    assert.equal(await untilFile(join(cwd, "descendant-done")), "yes");
  } finally { await clean(cwd, options); }
});

test("stop retires the owned process group and fences later commands", async () => {
  const { cwd, options } = await fixture();
  let authorized = true;
  options.isAuthorized = async () => authorized;
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
  try {
    const running = runLocalOperation(cwd, commands, options);
    const cancelled = assert.rejects(running, LocalOperationCancelledError);
    await untilFile(join(cwd, "started"));
    authorized = false;
    await cancelled;
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
    authorized = true;
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
  } finally { await clean(cwd, options); }
});

test("stop before launch is durable and has no command side effects", async () => {
  const { cwd, options } = await fixture();
  try {
    options.isAuthorized = async () => false;
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('bad','bad')"]], options), LocalOperationCancelledError);
    await assert.rejects(readFile(join(cwd, "bad")), { code: "ENOENT" });
    options.isAuthorized = async () => true;
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('bad','bad')"]], options), LocalOperationCancelledError);
  } finally { await clean(cwd, options); }
});

test("nonzero exit is durable and a later attempt requires a fresh operation ID", async () => {
  const { cwd, options } = await fixture();
  try {
    const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x');process.exit(7)"], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationFailedError);
    await assert.rejects(runLocalOperation(cwd, commands, options), /exit 7/);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
    await runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('retry','yes')"]], { ...options, operationId: "checks:retry-1" });
    assert.equal(await readFile(join(cwd, "retry"), "utf8"), "yes");
  } finally { await clean(cwd, options); }
});

test("an offline stop is honored by the next dispatcher after controller death", async () => {
  const { cwd, options } = await fixture();
  const authorizationPath = join(cwd, "run.json");
  options.authorization = { path: authorizationPath, stopGeneration: 0 };
  await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 0 });
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes'); setInterval(()=>{},1000)"], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
  const controller = await controllerFor(cwd, commands, options);
  try {
    await untilFile(join(cwd, "started"));
    await killController(controller);
    await durableJson(authorizationPath, { id: "run", status: "paused", userStopped: true, stopGeneration: 1 });
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
  } finally { await killController(controller); await clean(cwd, options); }
});

test("authorization lookup failure preserves the running operation for reconciliation", async () => {
  const { cwd, options } = await fixture();
  let unavailable = false;
  options.isAuthorized = async () => { if (unavailable) throw new Error("Registry unavailable"); return true; };
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes'); setTimeout(()=>{},500)"]];
  try {
    const running = runLocalOperation(cwd, commands, options);
    const rejected = assert.rejects(running, LocalOperationUnknownError);
    await untilFile(join(cwd, "started"));
    unavailable = true;
    await rejected;
    unavailable = false;
    await runLocalOperation(cwd, commands, options);
  } finally { await clean(cwd, options); }
});

test("batch monitor death cancels surviving descendants before a fresh retry", async () => {
  const { cwd, options } = await fixture();
  try {
    const running = runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"]], options);
    const failed = assert.rejects(running, error => error instanceof LocalOperationFailedError && error.message.includes("lost-result-after-exit"));
    await untilFile(join(cwd, "started"));
    const launch = JSON.parse(await readFile(join(ownedDirectory(options), "launch.json"), "utf8"));
    process.kill(launch.pid, "SIGKILL");
    await failed;
    await runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('retry','yes')"]], { ...options, operationId: "checks:after-monitor-death" });
    assert.equal(await readFile(join(cwd, "retry"), "utf8"), "yes");
  } finally { await clean(cwd, options); }
});

test("a restarted stop discovers and retires local descendants after both monitors die", async () => {
  const { cwd, options } = await fixture();
  options.activeDirectory = join(cwd, "active-local");
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('child-pid',String(process.pid));setInterval(()=>{},1000)"]];
  const controller = await controllerFor(cwd, commands, options);
  try {
    const childPid = Number(await untilFile(join(cwd, "child-pid")));
    assert.equal(await hasActiveLocalOperations(options.activeDirectory), true);
    const launch = JSON.parse(await readFile(join(ownedDirectory(options), "launch.json"), "utf8"));
    await killController(controller);
    process.kill(launch.pid, "SIGKILL");
    let cleanup = await cancelActiveLocalOperations(options.activeDirectory, options.runId, 1);
    const deadline = Date.now() + 20_000;
    while (cleanup.pending && Date.now() < deadline) {
      await delay(100);
      cleanup = await cancelActiveLocalOperations(options.activeDirectory, options.runId, 1);
    }
    assert.equal(cleanup.pending, false, cleanup.reason ?? "Local cleanup did not retire the owned scope.");
    assert.equal(await hasActiveLocalOperations(options.activeDirectory), false);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    await runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('retry','safe')"]],
      { ...options, operationId: "checks:after-orphan" });
    assert.equal(await readFile(join(cwd, "retry"), "utf8"), "safe");
  } finally { await killController(controller); await clean(cwd, options); }
});

test("a new stop generation starts only after prior ownership retires", async () => {
  const { cwd, options } = await fixture();
  const authorizationPath = join(cwd, "run.json");
  options.authorization = { path: authorizationPath, stopGeneration: 0 };
  await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 0 });
  const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x');setTimeout(()=>{},300)"]];
  try {
    await runLocalOperation(cwd, commands, options);
    await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 1 });
    const successor = { ...options, authorization: { path: authorizationPath, stopGeneration: 1 } };
    await runLocalOperation(cwd, commands, successor);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "xx");
  } finally { await clean(cwd, options); }
});

test("an empty local batch needs no process backend", async () => {
  const { cwd, options } = await fixture();
  try { await runLocalOperation(cwd, [], options); }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("an empty successor batch retires the prior generation before returning", async () => {
  const { cwd, options, directory } = await fixture();
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"]];
  const running = runLocalOperation(cwd, commands, options);
  const cancelled = assert.rejects(running, LocalOperationCancelledError);
  try {
    await untilFile(join(cwd, "started"));
    assert.equal((await observeOwnedProcess(join(directory, "owned-process"))).status, "running");
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await runLocalOperation(cwd, [], successor);
    const retired = await observeOwnedProcess(join(directory, "owned-process"));
    assert.equal(retired.status, "retired");
    assert.equal(retired.proof?.kind, "process-group-retired");
    await cancelled;
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
  } finally {
    options.isAuthorized = async () => false;
    await cancelled;
    await clean(cwd, options);
  }
});

test("a new stop generation fences an empty interrupted generation before starting", async () => {
  const { cwd, options, directory } = await fixture();
  try {
    await mkdir(directory, { recursive: true });
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await durableJson(join(cwd, "run.json"), { id: "run", status: "running", stopGeneration: 1 });
    await runLocalOperation(cwd, [], successor);
    assert.ok(await readFile(join(directory, "stop.json"), "utf8"));
    await runLocalOperation(cwd, [[process.execPath, "-e", "0"]], successor);
    assert.ok(await readFile(join(directory, "stop.json"), "utf8"));
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "0"]], options), LocalOperationCancelledError);
    await runLocalOperation(cwd, [[process.execPath, "-e", "0"]], successor);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("abandoned intent and cancellation publications cannot park an unstarted generation", async () => {
  const { cwd, options, directory } = await fixture();
  try {
    await mkdir(directory, { recursive: true });
    for (const name of ["intent", "stop"]) await writeFile(join(directory, `${name}.json.00000000-0000-0000-0000-000000000000.tmp`), "{");
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await durableJson(join(cwd, "run.json"), { id: "run", status: "running", stopGeneration: 1 });
    await runLocalOperation(cwd, [[process.execPath, "-e", "0"]], successor);
    assert.ok(await readFile(join(directory, "stop.json"), "utf8"));
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "0"]], options), LocalOperationCancelledError);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a tampered local intent is fenced by its digest", async () => {
  const { cwd, options, directory } = await fixture();
  try {
    await runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('ran','yes')"]], options);
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
    intent.commands = [["different"]];
    await writeFile(join(directory, "intent.json"), JSON.stringify(intent));
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('ran','yes')"]], options), /digest mismatch/);
  } finally { await clean(cwd, options); }
});

for (const publication of ["after successor starts", "while the fence is published"]) {
  test(`a fenced incomplete generation cannot launch ${publication}`, async () => {
    const { cwd, options, directory } = await fixture();
    const authorizationPath = join(cwd, "run.json");
    options.authorization = { path: authorizationPath, stopGeneration: 0 };
    await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 0 });
    const successor = { ...options, authorization: { path: authorizationPath, stopGeneration: 1 } };
    const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x');setTimeout(()=>{},300)"]];
    const ready = join(cwd, "old-intent-pending");
    const resume = publication === "after successor starts" ? join(cwd, "resume-old") : join(directory, "stop.json");
    const stale = await controllerFor(cwd, commands, options, {
      gate: { destination: join(directory, "intent.json"), ready, resume }, cancelled: true,
    });
    const staleExit = new Promise<number | null>(resolve => stale.once("exit", resolve));
    let current: ReturnType<typeof spawn> | undefined;
    try {
      await untilFile(ready);
      await assert.rejects(readFile(join(directory, "intent.json")), { code: "ENOENT" });
      await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 1 });
      current = await controllerFor(cwd, commands, successor, publication === "while the fence is published" ? {
        gate: { destination: join(directory, "stop.json"), ready: join(cwd, "fence-published"), resume: join(directory, "binding.json"), after: true },
      } : undefined);
      const currentExit = new Promise<number | null>(resolve => current!.once("exit", resolve));
      await Promise.race([untilFile(join(cwd, "count")), currentExit.then(code => assert.equal(code, 0))]);
      if (publication === "after successor starts") await writeFile(resume, "resume");
      assert.deepEqual(await Promise.all([staleExit, currentExit]), [0, 0]);
      assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
      assert.equal((await observeOwnedProcess(join(directory, "owned-process"))).status, "never-started");
      await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
      await runLocalOperation(cwd, commands, successor);
      assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    } finally {
      await killController(stale);
      if (current) await killController(current);
      await cancelOwnedProcess(join(localOperationDirectory(successor), "owned-process"), { deadlineMs: 10_000, cancelled: true });
      await clean(cwd, options);
    }
  });
}

for (const artifact of ["binding.json", "request.json", "result.json", "owned-process", "intent.json", "active-index"]) {
  test(`an incomplete generation with ${artifact} remains fenced`, async () => {
    const { cwd, options, directory } = await fixture();
    try {
      await mkdir(directory, { recursive: true });
      if (artifact === "active-index") {
        options.activeDirectory = join(cwd, "active-local");
        await mkdir(options.activeDirectory);
        await writeFile(join(options.activeDirectory, `${createHash("sha256").update(directory).digest("hex")}.json`), "{}");
      } else if (artifact === "owned-process") await mkdir(join(directory, artifact));
      else await writeFile(join(directory, artifact), "{}");
      const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
      await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "0"]], successor), LocalOperationUnknownError);
      await assert.rejects(readFile(join(localOperationDirectory(successor), "intent.json")), { code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
