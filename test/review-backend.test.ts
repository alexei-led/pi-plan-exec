import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canFallbackReview, parseRevmuxReport, reviewRequestDigest, validateReviewResult, RevmuxReviewClient,
} from "../src/review-backend.js";

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

test("fallback is explicit and cannot cross an uncertain launched operation", () => {
  assert.equal(canFallbackReview("subagent", [], { dispatched: false, processTreeExited: false }), false);
  assert.equal(canFallbackReview("subagent", ["subagent"], { dispatched: true, processTreeExited: false }), false);
  assert.equal(canFallbackReview("subagent", ["subagent"], { dispatched: false, processTreeExited: false }), true);
  assert.equal(canFallbackReview("subagent", ["subagent"], { dispatched: true, processTreeExited: true }), true);
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
    executionLifetime:{version:1,modes:['unbounded','bounded']},
    processTreeOwnership:{version:1,scope:behavior === 'scoped' ? 'posix-process-group' : 'owned-process-tree',
      escapedDescendants:behavior === 'scoped' ? 'unverified' : 'contained'},
    processTerminalProof:{version:1,...(behavior === 'scoped' ? {scope:'process-groups',escapedDescendants:'unsupported'} : {})}}));
} else if (args[0] === 'new') {
  const root = args[args.indexOf('--tasks-dir') + 1];
  fs.mkdirSync(root, {recursive:true});
  console.log(JSON.stringify({scope:path.join(root,'scope.md'),goal:path.join(root,'goal.md')}));
} else {
  fs.appendFileSync(path.join(process.cwd(),'launches'), JSON.stringify(args)+'\n');
  const proofPath = args.find(arg=>arg.startsWith('--process-proof=')).slice('--process-proof='.length);
  const prove = () => fs.writeFileSync(proofPath, JSON.stringify({version:1,state:'observed',
    runnerProcessInstanceId:'runner-fixture',observedAt:Date.now(),instances:[],
    processTreeOwnership:{version:1,scope:'owned-process-tree',escapedDescendants:'contained'}}));
  const report = {sources:{expected:1,reported:1,degraded:[],agents:[{degraded:false}]},
    findings:[],open_questions:[],pre_existing:[],immaterial:[]};
  if (behavior === 'wait') {
    process.on('SIGTERM', () => { prove(); process.exit(2); });
    setInterval(()=>{},1000);
  } else {
    if (behavior !== 'missing-proof') prove();
    console.log(JSON.stringify(report));
  }
}
`, { mode: 0o700 });
  const options = { cwd, executable, stateDirectory: join(cwd, "operations"), reviewedCommit: "abc" };
  return { cwd, options, client: new RevmuxReviewClient(options) };
}

async function eventually(action: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
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
  assert.match(launches[0] ?? "", /--hard-timeout=0s/);
  assert.match(launches[0] ?? "", /--idle-timeout=0s/);
  assert.equal((await restarted.start("op", "Different request")).success, false);
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
  await client.cancel(undefined, "op");
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

test("process-group-only proof is rejected before launching a required Revmux review", async (t) => {
  const { client, cwd } = await harness(t, "scoped");
  const capabilities = await client.capabilities();
  assert.equal(capabilities.healthy, true);
  assert.deepEqual(capabilities.executionLifetimeModes, ["unbounded", "bounded"]);
  assert.equal(capabilities.processTreeOwnership?.scope, "posix-process-group");
  const result = await client.start("op", "Review");
  assert.ok(!result.success);
  assert.equal(result.error.code, "unsupported");
  await assert.rejects(readFile(join(cwd, "launches")), { code: "ENOENT" });
});

test("a durable cancellation fence wins a delayed Revmux start", async (t) => {
  const { client, cwd } = await harness(t);
  await client.cancel(undefined, "op");
  await client.start("op", "Review");
  await eventually(async () => {
    const result = await client.status("op");
    return result.success && (result.data.run as { phase: string }).phase === "cancelled";
  });
  await assert.rejects(readFile(join(cwd, "launches")), { code: "ENOENT" });
});
