import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { durableJson, localOperationDirectory, LocalOperationCancelledError, LocalOperationUnknownError, observeLocalOperation, runLocalOperation, type LocalOperationOptions } from "../src/local-operation.js";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "plan-local-op-"));
  const options: LocalOperationOptions = { journalRoot: cwd, runId: "run", operationId: "checks", candidate: "candidate", isAuthorized: async () => true };
  return { cwd, options, directory: localOperationDirectory(options) };
}

async function untilFile(path: string): Promise<string> {
  const end = Date.now() + 8_000;
  for (;;) {
    try { return await readFile(path, "utf8"); } catch { if (Date.now() > end) throw new Error(`File absent: ${path}`); }
    await delay(20);
  }
}

test("lost result reply and repeat attachment execute the batch exactly once", async () => {
  const { cwd, options } = await fixture();
  try {
    const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x')"]];
    await Promise.all([observeLocalOperation(cwd, commands, options), observeLocalOperation(cwd, commands, options)]);
    await observeLocalOperation(cwd, commands, options);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
    await assert.rejects(observeLocalOperation(cwd, commands, { ...options, candidate: "different" }), LocalOperationUnknownError);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("controller death leaves one command that a new controller can observe", async () => {
  const { cwd, options, directory } = await fixture();
  const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x'); setTimeout(()=>{},1200)"]];
  const module = new URL("../src/local-operation.ts", import.meta.url).href;
  const script = `import {observeLocalOperation} from ${JSON.stringify(module)}; await observeLocalOperation(${JSON.stringify(cwd)},${JSON.stringify(commands)},{...${JSON.stringify(options)},isAuthorized:async()=>true});`;
  const controller = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "-e", script], { stdio: "ignore" });
  try {
    await untilFile(join(cwd, "count"));
    const exited = controller.exitCode !== null || controller.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => controller.once("exit", () => resolve()));
    controller.kill("SIGKILL");
    await exited;
    await observeLocalOperation(cwd, commands, options);
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    assert.equal(result.groupDrained, true);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "x");
  } finally { controller.kill("SIGKILL"); await rm(cwd, { recursive: true, force: true }); }
});

test("wrapper exit is insufficient while a same-group descendant still writes", async () => {
  const { cwd, options } = await fixture();
  try {
    const descendant = "setTimeout(()=>require('fs').writeFileSync('descendant-done','yes'),500)";
    const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref()`;
    await observeLocalOperation(cwd, [[process.execPath, "-e", command]], options);
    assert.equal(await readFile(join(cwd, "descendant-done"), "utf8"), "yes");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("stop fences later commands and terminal success after a lost reply", async () => {
  const { cwd, options } = await fixture();
  let authorized = true;
  options.isAuthorized = async () => authorized;
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes'); setInterval(()=>{},1000)"], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
  try {
    const running = observeLocalOperation(cwd, commands, options);
    await untilFile(join(cwd, "started"));
    authorized = false;
    await assert.rejects(running, LocalOperationCancelledError);
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
    authorized = true;
    await assert.rejects(observeLocalOperation(cwd, commands, options), LocalOperationCancelledError);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("monitor death retains an unknown ownership fence across restart", async () => {
  const { cwd, options, directory } = await fixture();
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes'); setInterval(()=>{},1000)"]];
  let ownerPid: number | undefined;
  try {
    const running = observeLocalOperation(cwd, commands, options);
    const rejected = assert.rejects(running, LocalOperationUnknownError);
    await untilFile(join(cwd, "started"));
    ownerPid = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")).pid as number;
    process.kill(ownerPid, "SIGKILL");
    await rejected;
    await assert.rejects(observeLocalOperation(cwd, commands, options), LocalOperationUnknownError);
  } finally {
    if (ownerPid) { try { process.kill(-ownerPid, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); } }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop before launch is durable and has no command side effects", async () => {
  const { cwd, options } = await fixture();
  try {
    options.isAuthorized = async () => false;
    await assert.rejects(observeLocalOperation(cwd, [[process.execPath, "-e", "require('fs').writeFileSync('bad','bad')"]], options), LocalOperationCancelledError);
    await assert.rejects(readFile(join(cwd, "bad")), { code: "ENOENT" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test("nonzero exit is durable and does not launch a later command", async () => {
  const { cwd, options } = await fixture();
  try {
    const commands = [[process.execPath, "-e", "process.exit(7)"], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
    await assert.rejects(observeLocalOperation(cwd, commands, options), /exit 7/);
    await assert.rejects(observeLocalOperation(cwd, commands, options), /exit 7/);
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("detected process-group escape cannot produce a terminal ownership proof", async () => {
  const { cwd, options } = await fixture();
  try {
    const escaped = "setTimeout(()=>require('fs').writeFileSync('escaped-done','yes'),800)";
    const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{stdio:'ignore',detached:true}).unref(); setTimeout(()=>{},500)`;
    await assert.rejects(observeLocalOperation(cwd, [[process.execPath, "-e", command]], options), LocalOperationUnknownError);
    await untilFile(join(cwd, "escaped-done"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test("offline monitor sees durable registry stop and never launches the next command", async () => {
  const { cwd, options, directory } = await fixture();
  const authorizationPath = join(cwd, "run.json");
  options.authorization = { path: authorizationPath, stopGeneration: 0 };
  await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 0 });
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes'); setInterval(()=>{},1000)"], [process.execPath, "-e", "require('fs').writeFileSync('late','bad')"]];
  const module = new URL("../src/local-operation.ts", import.meta.url).href;
  const script = `import {observeLocalOperation} from ${JSON.stringify(module)}; await observeLocalOperation(${JSON.stringify(cwd)},${JSON.stringify(commands)},{...${JSON.stringify(options)},isAuthorized:async()=>true});`;
  const controller = spawn(process.execPath, ["--input-type=module", "--experimental-strip-types", "-e", script], { stdio: "ignore" });
  try {
    await untilFile(join(cwd, "started"));
    const exited = new Promise<void>((resolve) => controller.once("exit", () => resolve()));
    controller.kill("SIGKILL");
    await exited;
    await durableJson(authorizationPath, { id: "run", status: "paused", userStopped: true, stopGeneration: 1 });
    const result = JSON.parse(await untilFile(join(directory, "result.json")));
    assert.equal(result.cancelled, true);
    assert.equal(result.groupDrained, true);
    await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
    await assert.rejects(observeLocalOperation(cwd, commands, options), LocalOperationCancelledError);
  } finally { controller.kill("SIGKILL"); await rm(cwd, { recursive: true, force: true }); }
});


test("lost authorization reply preserves unknown ownership rather than reporting command failure", async () => {
  const { cwd, options, directory } = await fixture();
  let unavailable = false;
  options.isAuthorized = async () => { if (unavailable) throw new Error("Registry read unavailable"); return true; };
  const commands = [[process.execPath, "-e", "require('fs').writeFileSync('started','yes'); setTimeout(()=>{},500)"]];
  try {
    const running = observeLocalOperation(cwd, commands, options);
    const rejected = assert.rejects(running, LocalOperationUnknownError);
    await untilFile(join(cwd, "started"));
    unavailable = true;
    await rejected;
    await untilFile(join(directory, "result.json"));
    unavailable = false;
    await observeLocalOperation(cwd, commands, options);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test("new stop generation may retry only after the previous monitor proves exit", async () => {
  const { cwd, options } = await fixture();
  const authorizationPath = join(cwd, "run.json");
  options.authorization = { path: authorizationPath, stopGeneration: 0 };
  await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 0 });
  const commands = [[process.execPath, "-e", "require('fs').appendFileSync('count','x'); setTimeout(()=>{},500)"]];
  try {
    const running = observeLocalOperation(cwd, commands, options);
    const cancelled = assert.rejects(running, LocalOperationCancelledError);
    await untilFile(join(cwd, "count"));
    await durableJson(authorizationPath, { id: "run", status: "paused", stopGeneration: 1 });
    const successor = { ...options, authorization: { path: authorizationPath, stopGeneration: 1 } };
    await assert.rejects(observeLocalOperation(cwd, commands, successor), LocalOperationUnknownError);
    await cancelled;
    await durableJson(authorizationPath, { id: "run", status: "running", stopGeneration: 1 });
    await observeLocalOperation(cwd, commands, successor);
    assert.equal(await readFile(join(cwd, "count"), "utf8"), "xx");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test("group observation misses a fast detached descendant; strict execution remains unsupported", async () => {
  const { cwd, options } = await fixture();
  try {
    const escaped = "setTimeout(()=>require('fs').writeFileSync('escaped-done','yes'),1500)";
    const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{stdio:'ignore',detached:true}).unref()`;
    const commands = [[process.execPath, "-e", command]];
    await assert.rejects(runLocalOperation(cwd, commands, options), /Owned-process-tree containment is unavailable/);
    await assert.rejects(readFile(join(cwd, "escaped-done")), { code: "ENOENT" });
    try {
      const observation = await observeLocalOperation(cwd, commands, options);
      assert.equal(observation.proofScope, "observed-posix-process-group");
      await assert.rejects(readFile(join(cwd, "escaped-done")), { code: "ENOENT" });
    } catch (error) {
      assert.ok(error instanceof LocalOperationUnknownError);
    }
    await untilFile(join(cwd, "escaped-done"));
    await assert.rejects(runLocalOperation(cwd, commands, options), LocalOperationUnknownError);
    await runLocalOperation(cwd, [], options);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
