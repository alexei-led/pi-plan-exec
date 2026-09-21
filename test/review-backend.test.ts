import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  parseRevmuxReport, reviewRequestDigest, validateReviewResult, RevmuxReviewClient,
} from "../src/review-backend.js";
import { hasTerminalOwnershipProof } from "../src/bridge.js";

test("review acceptance binds valid output to the exact reviewed commit", () => {
  assert.deepEqual(validateReviewResult("NO_FINDINGS", "abc", "abc"), {
    reviewedCommit: "abc", findings: [], blocking: false,
  });
  assert.throws(() => validateReviewResult("NO_FINDINGS", "abc", "def"), /commit/);
  assert.throws(() => validateReviewResult("NO_FINDINGS\nreview incomplete", "abc", "abc"));
  assert.equal(validateReviewResult(
    "FINDING: MAJOR | Invalid boundary\nEvidence: src/a.ts:1 throws\nFix: validate",
    "abc", "abc",
  ).blocking, true);
});

test("review request identity includes commit and explicit execution lifetime", () => {
  const request = { operationId: "op", backend: "subagent" as const,
    reviewedCommit: "abc", cwd: "/repo", prompt: "Review", executionLifetime: { mode: "unbounded" as const } };
  assert.equal(reviewRequestDigest(request), reviewRequestDigest({ ...request }));
  assert.notEqual(reviewRequestDigest(request), reviewRequestDigest({ ...request, reviewedCommit: "def" }));
  assert.notEqual(reviewRequestDigest(request), reviewRequestDigest({ ...request,
    executionLifetime: { mode: "bounded", timeoutMs: 1000 } }));
});

function report() {
  return { sources: { expected: 1, reported: 1, degraded: [], agents: [{ degraded: false }] },
    findings: [], open_questions: [], pre_existing: [], immaterial: [] };
}

test("Revmux partial and contradictory reports never pass a required review", () => {
  assert.deepEqual(parseRevmuxReport(report()), []);
  for (const value of [
    {}, { ...report(), sources: { expected: 2, reported: 1, degraded: [] } },
    { ...report(), open_questions: ["Can the failure be reproduced?"] },
    { ...report(), findings: [{ severity: "major", title: "Missing evidence" }] },
    { ...report(), immaterial: [{ severity: "major", verdict: "immaterial" }] },
    { ...report(), sources: { ...report().sources, agents: [{ degraded: true }] } },
  ]) assert.throws(() => parseRevmuxReport(value));
});

test("Revmux preserves confirmed blocker severity and supporting evidence", () => {
  assert.deepEqual(parseRevmuxReport({ ...report(), findings: [{ id: "f1", severity: "critical",
    title: "Broken authorization", file: "auth.ts", line: 9, body: "Missing check",
    fix: "Check permission", verdict: "confirmed" }] }), [{ id: "f1", severity: "CRITICAL",
    summary: "Broken authorization", evidence: "auth.ts:9 Missing check", suggestion: "Check permission" }]);
});

async function harness(t: test.TestContext, behavior = "complete") {
  const cwd = await mkdtemp(join(tmpdir(), "plan-exec-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executable = join(cwd, "revmux-test.cjs");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const behavior = ` + JSON.stringify(behavior) + String.raw`;
if (args.includes('--capabilities')) {
  console.log(JSON.stringify({protocol:'plan-exec-revmux',version:1,
    executionLifetime:{version:1,modes:['unbounded','bounded'],flag:'--execution-lifetime'},
    processTreeOwnership:{version:1,scope:behavior === 'scoped' ? 'posix-process-group' : 'owned-process-tree',
      escapedDescendants:behavior === 'scoped' ? 'unverified' : 'contained'},
    processTerminalProof:{version:1,...(behavior === 'scoped' ? {scope:'process-groups',escapedDescendants:'unsupported'} : {})}}));
} else if (args[0] === 'new') {
  const root = args[args.indexOf('--tasks-dir') + 1];
  fs.mkdirSync(root, {recursive:true});
  const output = () => console.log(JSON.stringify({scope:path.join(root,'scope.md'),goal:path.join(root,'goal.md')}));
  if (behavior === 'delayed-setup') {
    fs.writeFileSync(path.join(process.cwd(),'setup-started'),'ready');
    const wait = setInterval(() => {
      if (fs.existsSync(path.join(process.cwd(),'allow-setup'))) { clearInterval(wait); output(); }
    },10);
  } else output();
} else {
  fs.appendFileSync(path.join(process.cwd(),'launches'), JSON.stringify(args)+'\n');
  const report = {sources:{expected:1,reported:1,degraded:[],agents:[{degraded:false}]},
    findings:[],open_questions:[],pre_existing:[],immaterial:[]};
  if (behavior === 'escaped-wait') {
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    fs.writeFileSync(path.join(process.cwd(),'escaped-pid'),String(child.pid));
    child.unref();
    setInterval(()=>{},1000);
  } else if (behavior === 'wait') {
    process.on('SIGTERM', () => { process.exit(2); });
    setInterval(()=>{},1000);
  } else {
    console.log(JSON.stringify(report));
  }
}
`, { mode: 0o700 });
  const kernelPath = join(cwd, "fixture-kernel.mjs");
  await writeFile(kernelPath, String.raw`
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
const behavior = ` + JSON.stringify(behavior) + String.raw`;
const operations = new Map();
const fences = new Set();
export async function preflightKernelOwnedProcess() { return {supported:behavior !== 'unsupported'}; }
export async function prepareKernelOwnedProcess(request) {
  const directory=request.operationDirectory;
  const digest=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const existing=operations.get(directory);
  if(existing) { if(existing.prepared.requestDigest!==digest) throw Error('request conflict'); return existing.prepared; }
  const prepared={operationDirectory:directory,operationId:directory,requestDigest:digest,
    hostId:'00000000-0000-0000-0000-000000000001',bootId:'00000000-0000-0000-0000-000000000002',
    stdoutPath:join(directory,'stdout'),stderrPath:join(directory,'stderr')};
  operations.set(directory,{request,prepared,status:fences.has(directory)?'never-started':'pending'});
  await writeFile(join(request.cwd,'kernel-lifetime.json'),JSON.stringify(request.lifetime));
  return prepared;
}
export function capturedRequest(directory) { return operations.get(directory)?.request; }
export async function observeKernelOwnedProcess(directory) {
  const state=operations.get(directory);
  if(!state) return {operationDirectory:directory,status:'unknown'};
  const binding=state.prepared;
  const proof=state.status==='retired' ? {...binding,kind:'darwin-coalition-retired',identity:state.identity,observedAt:new Date().toISOString()}
    :state.status==='never-started'?{...binding,kind:'never-started',observedAt:new Date().toISOString()}:undefined;
  return {operationDirectory:directory,status:state.status,binding,identity:state.identity,exitCode:state.exitCode,
    ...(behavior==='missing-proof' && state.status==='retired'?{reason:'Kernel retirement proof is unavailable.'}:{proof})};
}
export async function launchKernelOwnedProcess(request) {
  const prepared=await prepareKernelOwnedProcess(request);
  const state=operations.get(request.operationDirectory);
  if(state.status==='pending' && !fences.has(request.operationDirectory)) {
    state.status='active';
    state.child=spawn(request.argv[0],request.argv.slice(1),{cwd:request.cwd,env:request.env,detached:true,stdio:'ignore'});
    state.identity={...prepared,version:1,backend:'darwin-resource-coalition-v1',coalitionId:'42',
      leader:{pid:state.child.pid,uniqueId:'123456',pidVersion:1}};
    state.closed=new Promise(resolve=>state.child.once('close',(code)=>{state.exitCode=code;state.status='retired';resolve();}));
    if(behavior==='lost-launch-reply') throw Error('Lost launch response');
  }
  return {...prepared,observation:await observeKernelOwnedProcess(request.operationDirectory)};
}
export async function cancelKernelOwnedProcess(directory) {
  fences.add(directory);
  const state=operations.get(directory);
  if(state?.status==='pending') state.status='never-started';
  else if(state?.status==='active') {
    try {process.kill(-state.child.pid,'SIGTERM');} catch(error) {if(error.code!=='ESRCH')throw error;}
    await state.closed;
  }
  return observeKernelOwnedProcess(directory);
}
`);
  const options = { cwd, executable, stateDirectory: join(cwd, "operations"), reviewedCommit: "abc",
    kernelRuntimeModule: pathToFileURL(kernelPath).href };
  return { cwd, options, client: new RevmuxReviewClient(options) };
}

async function eventually(action: () => Promise<boolean>, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Review did not reach the expected state.");
}

test("controlled Revmux review survives client restart and replays exactly one operation", async (t) => {
  const { client, options, cwd } = await harness(t);
  assert.equal((await client.start("op", "Review", undefined, { mode: "unbounded" })).success, true);
  const restarted = new RevmuxReviewClient(options);
  await eventually(async () => {
    const result = await restarted.result("op");
    return result.success && (result.data.run as { terminal: boolean }).terminal;
  });
  const result = await restarted.start("op", "Review", undefined, { mode: "unbounded" });
  assert.ok(result.success);
  assert.deepEqual(result.data.callerOutput, { contract: "plan-review-v1", output: "NO_FINDINGS" });
  assert.equal(result.data.reviewedCommit, "abc");
  const launches = (await readFile(join(cwd, "launches"), "utf8")).trim().split("\n");
  assert.equal(launches.length, 1);
  assert.match(launches[0] ?? "", /--execution-lifetime=unbounded/);
  assert.doesNotMatch(launches[0] ?? "", /--hard-timeout|--idle-timeout/);
  assert.equal((await restarted.start("op", "Different request")).success, false);
});

test("bounded compatibility mode is explicit in both the kernel root and Revmux CLI", async (t) => {
  const { client, cwd } = await harness(t);
  await client.start("op", "Review", undefined, { mode: "bounded", timeoutMs: 7000 }, "caller-digest");
  await eventually(async () => {
    const result = await client.result("op");
    return result.success && (result.data.run as { terminal: boolean }).terminal;
  });
  const argv = await readFile(join(cwd, "launches"), "utf8");
  assert.match(argv, /--execution-lifetime=bounded/);
  assert.match(argv, /--hard-timeout=7000ms/);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, "kernel-lifetime.json"), "utf8")), { kind: "bounded", timeoutMs: 7000 });
});

test("Revmux freezes a worktree-safe kernel environment and preserves it on replay", async (t) => {
  const { client, cwd, options } = await harness(t);
  const canaries = {
    GIT_DIR: "/foreign/.git", GIT_WORK_TREE: "/foreign", GIT_INDEX_FILE: "/foreign/index",
    GIT_COMMON_DIR: "/foreign/common", GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "/foreign",
    GIT_AUTHOR_NAME: "Fixture author", GIT_SSH_COMMAND: "ssh -F /fixture/config", PLAN_EXEC_TEST_AUTH: "fixture-auth",
  };
  const previous = Object.fromEntries(Object.keys(canaries).map((name) => [name, process.env[name]]));
  Object.assign(process.env, canaries);
  try {
    assert.equal((await client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest")).success, true);
    await eventually(async () => {
      const result = await client.result("op");
      return result.success && (result.data.run as { terminal: boolean }).terminal;
    });
    const directory = join(options.stateDirectory, createHash("sha256").update("op").digest("hex"));
    const runtime = await import(options.kernelRuntimeModule);
    const request = runtime.capturedRequest(join(directory, "kernel-operation"));
    assert.equal(request.cwd, cwd);
    for (const name of Object.keys(canaries).filter((name) => name !== "GIT_AUTHOR_NAME" && name !== "GIT_SSH_COMMAND" && name !== "PLAN_EXEC_TEST_AUTH"))
      assert.equal(request.env[name], undefined, name);
    assert.equal(request.env.GIT_AUTHOR_NAME, "Fixture author");
    assert.equal(request.env.GIT_SSH_COMMAND, "ssh -F /fixture/config");
    assert.equal(request.env.PLAN_EXEC_TEST_AUTH, "fixture-auth");
    const intent = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
    assert.equal(intent.request.cwd, cwd);
    assert.equal(intent.request.reviewedCommit, "abc");
    process.env.GIT_AUTHOR_NAME = "Changed parent author";
    process.env.PLAN_EXEC_TEST_AUTH = "changed-parent-auth";
    assert.equal((await new RevmuxReviewClient(options).start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest")).success, true);
    assert.equal(runtime.capturedRequest(join(directory, "kernel-operation")).env.GIT_AUTHOR_NAME, "Fixture author");
    assert.equal(runtime.capturedRequest(join(directory, "kernel-operation")).env.PLAN_EXEC_TEST_AUTH, "fixture-auth");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("installed kernel launcher reconciles a lost Revmux launch reply with actual retirement evidence", { skip: process.platform !== "darwin" }, async (t) => {
  const { options, cwd } = await harness(t);
  const runtimeModule = process.env.PI_PLAN_EXEC_KERNEL_RUNTIME ?? "pi-subagents/kernel-owned-process";
  const runtimeUrl = runtimeModule.startsWith("file:") ? runtimeModule : pathToFileURL(createRequire(import.meta.url).resolve(runtimeModule)).href;
  const runtime = await import(runtimeUrl);
  const preflight = await runtime.preflightKernelOwnedProcess({ artifactDirectory: join(options.stateDirectory, "kernel-artifacts") });
  assert.equal(preflight.supported, true, preflight.reason);
  const proxy = join(cwd, "lost-kernel-reply.mjs");
  await writeFile(proxy, `export * from ${JSON.stringify(runtimeUrl)};\n` +
    `import {launchKernelOwnedProcess as launch} from ${JSON.stringify(runtimeUrl)};\n` +
    "let lost=false; export async function launchKernelOwnedProcess(request) {const value=await launch(request); if(!lost){lost=true;throw Error('Lost response after owned launch');} return value;}\n");
  const ownedOptions = { ...options, kernelRuntimeModule: pathToFileURL(proxy).href };
  const client = new RevmuxReviewClient(ownedOptions);
  const operationDirectory = join(options.stateDirectory, createHash("sha256").update("op").digest("hex"), "kernel-operation");
  try {
    const started = await client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest");
    assert.ok(!started.success);
    assert.equal(started.error.code, "launch_unknown");
    const restored = new RevmuxReviewClient(ownedOptions);
    await eventually(async () => {
      const result = await restored.result("op");
      return result.success && hasTerminalOwnershipProof(result.data, "op", { operationId: "op", requestDigest: "caller-digest" });
    }, 1000);
    const result = await restored.result("op");
    assert.ok(result.success);
    assert.deepEqual(result.data.callerOutput, { contract: "plan-review-v1", output: "NO_FINDINGS" });
    assert.equal((await readFile(join(cwd, "launches"), "utf8")).trim().split("\n").length, 1);
  } finally { await runtime.cancelKernelOwnedProcess(operationDirectory, { deadlineMs: 5000 }); }
});

test("installed kernel launcher cancels escaped reviewer descendants before accepting cleanup", { skip: process.platform !== "darwin" }, async (t) => {
  const { options, cwd } = await harness(t, "escaped-wait");
  const runtimeModule = process.env.PI_PLAN_EXEC_KERNEL_RUNTIME ?? "pi-subagents/kernel-owned-process";
  const runtimeUrl = runtimeModule.startsWith("file:") ? runtimeModule : pathToFileURL(createRequire(import.meta.url).resolve(runtimeModule)).href;
  const runtime = await import(runtimeUrl);
  const preflight = await runtime.preflightKernelOwnedProcess({ artifactDirectory: join(options.stateDirectory, "kernel-artifacts") });
  assert.equal(preflight.supported, true, preflight.reason);
  const client = new RevmuxReviewClient({ cwd: options.cwd, executable: options.executable,
    stateDirectory: options.stateDirectory, reviewedCommit: options.reviewedCommit,
    ...(process.env.PI_PLAN_EXEC_KERNEL_RUNTIME ? { kernelRuntimeModule: runtimeUrl } : {}) });
  const operationDirectory = join(options.stateDirectory, createHash("sha256").update("op").digest("hex"), "kernel-operation");
  try {
    assert.equal((await client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest")).success, true);
    await eventually(async () => readFile(join(cwd, "escaped-pid")).then(() => true, () => false), 1000);
    const pid = Number(await readFile(join(cwd, "escaped-pid"), "utf8"));
    assert.doesNotThrow(() => process.kill(pid, 0));
    await client.cancel(undefined, "op");
    await eventually(async () => {
      const result = await client.status("op");
      return result.success && hasTerminalOwnershipProof(result.data, "op", { operationId: "op", requestDigest: "caller-digest" });
    }, 1000);
    const result = await client.status("op");
    assert.ok(result.success);
    assert.equal((result.data.run as { phase: string }).phase, "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await runtime.cancelKernelOwnedProcess(operationDirectory, { deadlineMs: 5000 }); }
});

test("CLI completion without observed process proof never completes a Revmux review", async (t) => {
  const { client, cwd } = await harness(t, "missing-proof");
  await client.start("op", "Review");
  await eventually(async () => {
    const result = await client.status("op");
    return result.success && typeof result.data.error === "string";
  });
  const result = await client.result("op");
  assert.ok(result.success);
  assert.equal((result.data.run as { terminal: boolean }).terminal, false);
  assert.equal((await readFile(join(cwd, "launches"), "utf8")).trim().split("\n").length, 1);
});

test("Revmux cancellation is fenced and reconciled by the persistent monitor", async (t) => {
  const { client, cwd, options } = await harness(t, "wait");
  await client.start("op", "Review");
  await eventually(async () => readFile(join(cwd, "launches")).then(() => true, () => false));
  const cancellation = await client.cancel(undefined, "op");
  assert.ok(cancellation.success);
  assert.equal(cancellation.data.neverStarted, false);
  const restarted = new RevmuxReviewClient(options);
  await eventually(async () => {
    const result = await restarted.status("op");
    return result.success && (result.data.run as { phase: string }).phase === "cancelled";
  });
  const result = await restarted.start("op", "Review");
  assert.ok(result.success);
  assert.equal((result.data.run as { phase: string }).phase, "cancelled");
  assert.equal((await readFile(join(cwd, "launches"), "utf8")).trim().split("\n").length, 1);
});

test("unavailable kernel ownership is rejected before launching a required Revmux review", async (t) => {
  const { client, cwd } = await harness(t, "unsupported");
  const capabilities = await client.capabilities();
  assert.equal(capabilities.healthy, true);
  assert.deepEqual(capabilities.executionLifetimeModes, ["unbounded", "bounded"]);
  assert.equal(capabilities.processTreeOwnership, undefined);
  const result = await client.start("op", "Review");
  assert.ok(!result.success);
  assert.equal(result.error.code, "unsupported");
  await assert.rejects(readFile(join(cwd, "launches")), { code: "ENOENT" });
});

test("a durable cancellation fence wins a delayed Revmux start", async (t) => {
  const { client, cwd, options } = await harness(t);
  const cancellation = await client.cancel(undefined, "op");
  assert.deepEqual(cancellation, { success: true, data: { operationId: "op", state: "cancelled",
    cancellationRequested: true, neverStarted: true, replaySafe: false } });
  const restarted = new RevmuxReviewClient(options);
  assert.deepEqual(await restarted.status(undefined, "op"), cancellation);
  const delayed = await restarted.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest");
  assert.ok(delayed.success);
  assert.equal(delayed.data.neverStarted, true);
  assert.equal(delayed.data.requestDigest, "caller-digest");
  await assert.rejects(readFile(join(cwd, "launches")), { code: "ENOENT" });
});

test("authoritative absent receipt permits same-ID immutable replay racing the original start", async (t) => {
  const { client, cwd, options } = await harness(t);
  const missing = await client.status(undefined, "op");
  assert.deepEqual(missing, { success: true, data: { operationId: "op", state: "absent", replaySafe: true } });
  const restarted = new RevmuxReviewClient(options);
  const starts = await Promise.all([
    client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest"),
    restarted.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest"),
  ]);
  assert.ok(starts.every((result) => result.success && result.data.requestDigest === "caller-digest"));
  await eventually(async () => {
    const result = await restarted.result("op");
    return result.success && (result.data.run as { terminal: boolean }).terminal;
  });
  const conflicting = await restarted.start("op", "Review", undefined, { mode: "unbounded" }, "different-digest");
  assert.ok(!conflicting.success);
  assert.equal(conflicting.error.code, "conflict");
  assert.equal((await readFile(join(cwd, "launches"), "utf8")).trim().split("\n").length, 1);
});

test("lost kernel launch reply reconciles the same owned reviewer after client restart", async (t) => {
  const { client, cwd, options } = await harness(t, "lost-launch-reply");
  const launched = await client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest");
  assert.ok(!launched.success);
  assert.equal(launched.error.code, "launch_unknown");
  const restarted = new RevmuxReviewClient(options);
  await eventually(async () => {
    const result = await restarted.status("op");
    return result.success && (result.data.run as { terminal: boolean }).terminal;
  });
  const result = await restarted.result("op");
  assert.ok(result.success);
  assert.equal(hasTerminalOwnershipProof(result.data, "op", { operationId: "op", requestDigest: "caller-digest" }), true);
  assert.equal((await readFile(join(cwd, "launches"), "utf8")).trim().split("\n").length, 1);
});

test("kernel retirement owns Revmux descendants independently of its internal process-group proof", async (t) => {
  const { client } = await harness(t, "scoped");
  const capabilities = await client.capabilities();
  assert.equal(capabilities.processTreeOwnership?.scope, "owned-process-tree");
  await client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest");
  await eventually(async () => {
    const result = await client.result("op");
    return result.success && hasTerminalOwnershipProof(result.data, "op", { operationId: "op", requestDigest: "caller-digest" });
  });
});

test("missing request plus existing admission is uncertain rather than replayable", async (t) => {
  const { client, options } = await harness(t);
  await client.status(undefined, "op");
  const directory = join(options.stateDirectory, createHash("sha256").update("op").digest("hex"));
  await writeFile(join(directory, "admission.json"), JSON.stringify({ operationId: "op", state: "dispatching" }));
  const result = await client.status(undefined, "op");
  assert.ok(!result.success);
  assert.equal(result.error.code, "launch_unknown");
});

test("cancel during owned payload setup requires kernel retirement before release", async (t) => {
  const { client, cwd, options } = await harness(t, "delayed-setup");
  await client.start("op", "Review", undefined, { mode: "unbounded" }, "caller-digest");
  await eventually(async () => readFile(join(cwd, "setup-started")).then(() => true, () => false));
  const cancellation = await client.cancel(undefined, "op");
  assert.ok(cancellation.success);
  assert.equal(cancellation.data.neverStarted, false);
  assert.equal((cancellation.data.run as { phase: string }).phase, "cancelled");
  const restored = await new RevmuxReviewClient(options).status(undefined, "op");
  assert.ok(restored.success);
  assert.equal((restored.data.run as { phase: string }).phase, "cancelled");
  await assert.rejects(readFile(join(cwd, "launches")), { code: "ENOENT" });
});
