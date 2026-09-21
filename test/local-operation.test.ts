import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { cancelActiveLocalOperations, durableJson, hasActiveLocalOperations, localOperationDirectory, LocalOperationCancelledError, LocalOperationFailedError, LocalOperationUnknownError, runLocalOperation, type LocalOperationOptions } from "../src/local-operation.js";

const nativeTest = process.platform === "darwin" ? test : test.skip;
const require = createRequire(import.meta.url);

async function fixture(native = true) {
  const cwd = await mkdtemp(join(tmpdir(), "plan-local-op-"));
  const runtimeModule = native ? process.env.PI_PLAN_EXEC_KERNEL_TEST_MODULE ?? pathToFileURL(require.resolve("pi-subagents/kernel-owned-process")).href : pathToFileURL(join(cwd, "runtime.mjs")).href;
  const options: LocalOperationOptions = { journalRoot: cwd, runId: "run", operationId: "checks", candidate: "candidate", runtimeModule, isAuthorized: async () => true };
  return { cwd, options, directory: localOperationDirectory(options) };
}

async function untilFile(path: string): Promise<string> {
  const end = Date.now() + 25_000;
  for (;;) {
    try { return await readFile(path, "utf8"); } catch { if (Date.now() > end) throw new Error(`File absent: ${path}`); }
    await delay(20);
  }
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
  const operation = join(localOperationDirectory(options), "owned-process");
  try { await stat(operation); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await rm(cwd, { recursive: true, force: true }); return; } throw error; }
  const runtime = await import(options.runtimeModule!);
  const observation = await runtime.cancelKernelOwnedProcess(operation, { deadlineMs: 10_000 });
  assert.ok(observation.proof && (observation.status === "retired" || observation.status === "never-started"), `Cleanup retained unproven operation at ${cwd}: ${JSON.stringify(observation)}`);
  await rm(cwd, { recursive: true, force: true });
}

nativeTest("lost result reply and concurrent attachment execute the unbounded batch exactly once", async () => {
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

nativeTest("controller death leaves one command that a new controller adopts", async () => {
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

nativeTest("a pending bootstrap without a launched process is reconciled under the same durable identity", async () => {
  const { cwd, options } = await fixture();
  const actualRuntime = options.runtimeModule!;
  const proxy = join(cwd, "pending-launch.mjs");
  await writeFile(proxy, `export * from ${JSON.stringify(actualRuntime)};
import { prepareKernelOwnedProcess, observeKernelOwnedProcess } from ${JSON.stringify(actualRuntime)};
export async function launchKernelOwnedProcess(request) {
  const prepared = await prepareKernelOwnedProcess(request);
  return { ...prepared, observation: await observeKernelOwnedProcess(request.operationDirectory) };
}
`);
  options.runtimeModule = pathToFileURL(proxy).href;
  try {
    const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x')"]];
    await Promise.all([runLocalOperation(cwd, commands, options), runLocalOperation(cwd, commands, options)]);
    await runLocalOperation(cwd, commands, options);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
  } finally { await clean(cwd, options); }
});

nativeTest("local worker excludes inherited Git selectors and injected config from its immutable environment", async () => {
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

nativeTest("fast detached descendant remains owned after batch wrapper exits", async () => {
  const { cwd, options } = await fixture();
  try {
    const descendant = "setTimeout(()=>require('fs').writeFileSync('descendant-done','yes'),600)";
    const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true}).unref()`;
    await runLocalOperation(cwd, [[process.execPath, "-e", command]], options);
    assert.equal(await readFile(join(cwd, "descendant-done"), "utf8"), "yes");
  } finally { await clean(cwd, options); }
});

nativeTest("stop retires escaped descendants and fences later commands and late success", async () => {
  const { cwd, options } = await fixture();
  let authorized = true;
  options.isAuthorized = async () => authorized;
  const descendant = "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)";
  const commands = [[process.execPath, "-e", `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true}).unref();setInterval(()=>{},1000)`], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
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

nativeTest("stop before launch is durable and has no command side effects", async () => {
  const { cwd, options } = await fixture();
  try {
    options.isAuthorized = async () => false;
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('bad','bad')"]], options), LocalOperationCancelledError);
    await assert.rejects(readFile(join(cwd, "bad")), { code: "ENOENT" });
    options.isAuthorized = async () => true;
    await assert.rejects(runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('bad','bad')"]], options), LocalOperationCancelledError);
  } finally { await clean(cwd, options); }
});

nativeTest("nonzero exit is durable and a later attempt requires a fresh operation ID", async () => {
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

nativeTest("offline batch observes durable registry stop without its controller", async () => {
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
    const runtime = await import(options.runtimeModule!);
    const deadline = Date.now() + 15_000;
    let observation;
    do {
      observation = await runtime.observeKernelOwnedProcess(join(localOperationDirectory(options), "owned-process"));
      if (Date.now() > deadline) throw new Error(`Offline cancellation did not retire: ${JSON.stringify(observation)}`);
      await delay(50);
    } while (observation.status !== "retired");
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
  } finally { await killController(controller); await clean(cwd, options); }
});

nativeTest("authorization lookup failure preserves the running operation for reconciliation", async () => {
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

nativeTest("batch monitor death cancels surviving descendants before a fresh retry", async () => {
  const { cwd, options } = await fixture();
  try {
    const running = runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"]], options);
    const failed = assert.rejects(running, error => error instanceof LocalOperationFailedError && error.message.includes("lost-result-after-exit"));
    await untilFile(join(cwd, "started"));
    const runtime = await import(options.runtimeModule!);
    const observation = await runtime.observeKernelOwnedProcess(join(localOperationDirectory(options), "owned-process"));
    assert.equal(observation.status, "active");
    assert.ok(observation.workloadIdentity?.pid);
    process.kill(observation.workloadIdentity.pid, "SIGKILL");
    await failed;
    await runLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('retry','yes')"]], { ...options, operationId: "checks:after-monitor-death" });
    assert.equal(await readFile(join(cwd, "retry"), "utf8"), "yes");
  } finally { await clean(cwd, options); }
});

nativeTest("a restarted stop discovers and retires local descendants after both monitors die", async () => {
  const { cwd, options } = await fixture();
  options.activeDirectory = join(cwd, "active-local");
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('child-pid',String(process.pid));setInterval(()=>{},1000)"]];
  const controller = await controllerFor(cwd, commands, options);
  try {
    const childPid = Number(await untilFile(join(cwd, "child-pid")));
    assert.equal(await hasActiveLocalOperations(options.activeDirectory), true);
    const runtime = await import(options.runtimeModule!);
    const observation = await runtime.observeKernelOwnedProcess(join(localOperationDirectory(options), "owned-process"));
    assert.ok(observation.workloadIdentity?.pid);
    await killController(controller);
    process.kill(observation.workloadIdentity.pid, "SIGKILL");
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

nativeTest("a new stop generation starts only after prior kernel ownership retires", async () => {
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

const fakeRuntime = `
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const binding={operationId:'owned',requestDigest:'digest',hostId:'host',bootId:'boot'};
export async function prepareKernelOwnedProcess(request){await writeFile(join(dirname(request.operationDirectory),'effective-lifetime.json'),JSON.stringify(request.lifetime));return {...binding,operationDirectory:request.operationDirectory,stdoutPath:'out',stderrPath:'err'};}
export async function launchKernelOwnedProcess(request){const directory=dirname(request.operationDirectory);const intent=JSON.parse(await readFile(join(directory,'intent.json'),'utf8'));await writeFile(join(directory,'result.json'),JSON.stringify({digest:intent.digest,code:0,cancelled:false}));return {observation:await observeKernelOwnedProcess(request.operationDirectory)};}
export async function observeKernelOwnedProcess(directory){const config=JSON.parse(await readFile(join(dirname(dirname(dirname(dirname(directory)))),'fake.json'),'utf8'));return {status:'retired',operationDirectory:directory,exitCode:0,proof:{...binding,...config.binding,kind:'darwin-coalition-retired',observedAt:new Date().toISOString(),identity:{...binding,version:1,backend:'darwin-resource-coalition-v1',coalitionId:'123',leader:{pid:1,uniqueId:'1',pidVersion:1}}}};}
export async function requestKernelOwnedProcessCancellation(){}
export async function cancelKernelOwnedProcess(directory){return observeKernelOwnedProcess(directory);}
`;

test("local runtime passes explicit unbounded lifetime and rejects mismatched retirement proof", async () => {
  const { cwd, options, directory } = await fixture(false);
  try {
    await writeFile(join(cwd, "runtime.mjs"), fakeRuntime);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({ binding: { requestDigest: "other" } }));
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), /terminal proof/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "effective-lifetime.json"), "utf8")), { kind: "unbounded" });
    await writeFile(join(cwd, "fake.json"), JSON.stringify({}));
    await runLocalOperation(cwd, [["unused"]], options);
    const intent = JSON.parse(await readFile(join(directory, "intent.json"), "utf8"));
    intent.commands = [["different"]];
    await durableJson(join(directory, "intent.json"), intent);
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), /digest mismatch/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("confirmed kernel retirement with lost result permits retry but cannot accept success", async () => {
  const { cwd, options } = await fixture(false);
  try {
    await writeFile(join(cwd, "runtime.mjs"), fakeRuntime.replace("await writeFile(join(directory,'result.json'),JSON.stringify({digest:intent.digest,code:0,cancelled:false}));", "void intent;"));
    await writeFile(join(cwd, "fake.json"), JSON.stringify({}));
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), error => error instanceof LocalOperationFailedError && error.message.includes("lost-result-after-exit"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a stop racing the launch reply wins over a matching late successful result", async () => {
  const { cwd, options } = await fixture(false);
  try {
    await writeFile(join(cwd, "runtime.mjs"), fakeRuntime);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({}));
    let reads = 0;
    options.isAuthorized = async () => reads++ === 0;
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), LocalOperationCancelledError);
    options.isAuthorized = async () => true;
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), LocalOperationCancelledError);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a new stop generation cannot replace a prior mismatched ownership proof", async () => {
  const { cwd, options, directory } = await fixture(false);
  try {
    await writeFile(join(cwd, "runtime.mjs"), fakeRuntime);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({ binding: { bootId: "old-boot" } }));
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), LocalOperationUnknownError);
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await assert.rejects(runLocalOperation(cwd, [], options), /same generation/);
    await assert.rejects(runLocalOperation(cwd, [], successor), /Previous local command generation/);
    await assert.rejects(runLocalOperation(cwd, [["unused"]], successor), /Previous local command generation/);
    await assert.rejects(readFile(join(localOperationDirectory(successor), "intent.json")), { code: "ENOENT" });
    assert.ok(await readFile(join(directory, "binding.json"), "utf8"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("an empty local batch needs no runtime backend", async () => {
  const { cwd, options } = await fixture(false);
  try { await runLocalOperation(cwd, [], options); }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

nativeTest("an empty successor batch retires the prior generation before returning", async () => {
  const { cwd, options, directory } = await fixture();
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"]];
  const running = runLocalOperation(cwd, commands, options);
  const cancelled = assert.rejects(running, LocalOperationCancelledError);
  try {
    await untilFile(join(cwd, "started"));
    const runtime = await import(options.runtimeModule!);
    assert.equal((await runtime.observeKernelOwnedProcess(join(directory, "owned-process"))).status, "active");
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await runLocalOperation(cwd, [], successor);
    const retired = await runtime.observeKernelOwnedProcess(join(directory, "owned-process"));
    assert.equal(retired.status, "retired");
    assert.equal(retired.proof?.kind, "darwin-coalition-retired");
    await cancelled;
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
  } finally {
    options.isAuthorized = async () => false;
    await cancelled;
    await clean(cwd, options);
  }
});

test("a new stop generation fences an empty interrupted generation before starting", async () => {
  const { cwd, options, directory } = await fixture(false);
  try {
    await writeFile(join(cwd, "runtime.mjs"), fakeRuntime);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({}));
    await mkdir(directory, { recursive: true });
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await runLocalOperation(cwd, [], successor);
    assert.ok(await readFile(join(directory, "stop.json"), "utf8"));
    await runLocalOperation(cwd, [["unused"]], successor);
    assert.ok(await readFile(join(directory, "stop.json"), "utf8"));
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), LocalOperationCancelledError);
    await runLocalOperation(cwd, [["unused"]], successor);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("abandoned intent and cancellation publications cannot park an unstarted generation", async () => {
  const { cwd, options, directory } = await fixture(false);
  try {
    await writeFile(join(cwd, "runtime.mjs"), fakeRuntime);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({}));
    await mkdir(directory, { recursive: true });
    for (const name of ["intent", "stop"]) await writeFile(join(directory, `${name}.json.00000000-0000-0000-0000-000000000000.tmp`), "{");
    const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
    await runLocalOperation(cwd, [["unused"]], successor);
    assert.ok(await readFile(join(directory, "stop.json"), "utf8"));
    await assert.rejects(runLocalOperation(cwd, [["unused"]], options), LocalOperationCancelledError);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const publication of ["after successor starts", "while the fence is published"]) {
  nativeTest(`a fenced incomplete generation cannot launch ${publication}`, async () => {
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
      const runtime = await import(options.runtimeModule!);
      assert.equal((await runtime.observeKernelOwnedProcess(join(directory, "owned-process"))).status, "never-started");
      await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationCancelledError);
      await runLocalOperation(cwd, commands, successor);
      assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    } finally {
      await killController(stale);
      if (current) await killController(current);
      const runtime = await import(options.runtimeModule!);
      await runtime.cancelKernelOwnedProcess(join(localOperationDirectory(successor), "owned-process"), { deadlineMs: 10_000 });
      await clean(cwd, options);
    }
  });
}

for (const artifact of ["binding.json", "request.json", "result.json", "owned-process", "intent.json", "active-index"]) {
  test(`an incomplete generation with ${artifact} remains fenced`, async () => {
    const { cwd, options, directory } = await fixture(false);
    try {
      await writeFile(join(cwd, "runtime.mjs"), fakeRuntime);
      await writeFile(join(cwd, "fake.json"), JSON.stringify({}));
      await mkdir(directory, { recursive: true });
      if (artifact === "active-index") {
        options.activeDirectory = join(cwd, "active-local");
        await mkdir(options.activeDirectory);
        await writeFile(join(options.activeDirectory, `${createHash("sha256").update(directory).digest("hex")}.json`), "{}");
      } else if (artifact === "owned-process") await mkdir(join(directory, artifact));
      else await writeFile(join(directory, artifact), "{}");
      const successor = { ...options, authorization: { path: join(cwd, "run.json"), stopGeneration: 1 } };
      await assert.rejects(runLocalOperation(cwd, [["unused"]], successor), LocalOperationUnknownError);
      await assert.rejects(readFile(join(localOperationDirectory(successor), "intent.json")), { code: "ENOENT" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
