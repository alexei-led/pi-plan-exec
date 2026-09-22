import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, type TestContext, test } from 'vitest';
import { hasTerminalOwnershipProof } from '../src/bridge.js';
import {
  parseRevmuxReport,
  RevmuxReviewClient,
  reviewRequestDigest,
  validateReviewResult,
} from '../src/review-backend.js';

test('review acceptance binds valid output to the exact reviewed commit', () => {
  assert.deepEqual(validateReviewResult('NO_FINDINGS', 'abc', 'abc'), {
    reviewedCommit: 'abc',
    findings: [],
    blocking: false,
  });
  assert.throws(
    () => validateReviewResult('NO_FINDINGS', 'abc', 'def'),
    /commit/,
  );
  assert.throws(() =>
    validateReviewResult('NO_FINDINGS\nreview incomplete', 'abc', 'abc'),
  );
  assert.equal(
    validateReviewResult(
      'FINDING: MAJOR | Invalid boundary\nEvidence: src/a.ts:1 throws\nFix: validate',
      'abc',
      'abc',
    ).blocking,
    true,
  );
});

test('review request identity includes commit and explicit execution lifetime', () => {
  const request = {
    operationId: 'op',
    backend: 'subagent' as const,
    reviewedCommit: 'abc',
    cwd: '/repo',
    prompt: 'Review',
    executionLifetime: { mode: 'unbounded' as const },
  };
  assert.equal(
    reviewRequestDigest(request),
    reviewRequestDigest({ ...request }),
  );
  assert.notEqual(
    reviewRequestDigest(request),
    reviewRequestDigest({ ...request, reviewedCommit: 'def' }),
  );
  assert.notEqual(
    reviewRequestDigest(request),
    reviewRequestDigest({
      ...request,
      executionLifetime: { mode: 'bounded', timeoutMs: 1000 },
    }),
  );
});

function report() {
  return {
    sources: {
      expected: 1,
      reported: 1,
      degraded: [],
      agents: [{ degraded: false }],
    },
    findings: [],
    open_questions: [],
    pre_existing: [],
    immaterial: [],
  };
}

test('Revmux partial and contradictory reports never pass a required review', () => {
  assert.deepEqual(parseRevmuxReport(report()), []);
  for (const value of [
    {},
    { ...report(), sources: { expected: 2, reported: 1, degraded: [] } },
    { ...report(), open_questions: ['Can the failure be reproduced?'] },
    {
      ...report(),
      findings: [{ severity: 'major', title: 'Missing evidence' }],
    },
    { ...report(), immaterial: [{ severity: 'major', verdict: 'immaterial' }] },
    {
      ...report(),
      sources: { ...report().sources, agents: [{ degraded: true }] },
    },
  ])
    assert.throws(() => parseRevmuxReport(value));
});

test('Revmux preserves confirmed blocker severity and supporting evidence', () => {
  assert.deepEqual(
    parseRevmuxReport({
      ...report(),
      findings: [
        {
          id: 'f1',
          severity: 'critical',
          title: 'Broken authorization',
          file: 'auth.ts',
          line: 9,
          body: 'Missing check',
          fix: 'Check permission',
          verdict: 'confirmed',
        },
      ],
    }),
    [
      {
        id: 'f1',
        severity: 'CRITICAL',
        summary: 'Broken authorization',
        evidence: 'auth.ts:9 Missing check',
        suggestion: 'Check permission',
      },
    ],
  );
});

test('Revmux optional fixes remain unavailable without weakening finding validation', () => {
  const finding = {
    id: 'f1',
    severity: 'minor',
    title: 'Missing retry detail',
    file: 'retry.ts',
    line: 9,
    body: 'The failed attempt omits its retry reason.',
    verdict: 'confirmed',
  };
  for (const severity of ['minor', 'major']) {
    for (const optional of [{}, { fix: '' }, { fix: ' \t' }]) {
      const findings = parseRevmuxReport({
        ...report(),
        findings: [{ ...finding, severity, ...optional }],
      });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.severity, severity.toUpperCase());
      assert.equal(findings[0]?.suggestion, undefined);
      assert.equal(
        findings[0]?.evidence,
        'retry.ts:9 The failed attempt omits its retry reason.',
      );
    }
  }
  for (const invalid of [
    { fix: null },
    { fix: 42 },
    { body: '' },
    { title: ' ' },
    { file: '' },
    { severity: 'unknown' },
    { verdict: 'unverified' },
    { line: -1 },
  ])
    assert.throws(() =>
      parseRevmuxReport({
        ...report(),
        findings: [{ ...finding, ...invalid }],
      }),
    );
});

async function harness(_t: TestContext, behavior = 'complete') {
  const cwd = await mkdtemp(join(tmpdir(), 'plan-exec-review-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const executable = join(cwd, 'revmux-test.cjs');
  await writeFile(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const behavior = `}${JSON.stringify(behavior)}${String.raw`;
if (args.includes('--capabilities')) {
  console.log(JSON.stringify({protocol:'plan-exec-revmux',version:1,
    ...(behavior === 'unsupported' ? {} : {executionLifetime:{version:1,modes:['unbounded','bounded'],flag:'--execution-lifetime'}}),
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
  if (behavior === 'optional-fix-minor' || behavior === 'optional-fix-major') {
    report.findings.push({id:'f1',severity:behavior === 'optional-fix-minor' ? 'minor' : 'major',
      title:'Missing retry detail',file:'retry.ts',line:9,body:'The failed attempt omits its retry reason.',verdict:'confirmed',
      ...(behavior === 'optional-fix-minor' ? {fix:''} : {})});
  }
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
`}`,
    { mode: 0o700 },
  );
  const options = {
    cwd,
    executable,
    stateDirectory: join(cwd, 'operations'),
    reviewedCommit: 'abc',
  };
  return { cwd, options, client: new RevmuxReviewClient(options) };
}

async function eventually(action: () => Promise<boolean>, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Review did not reach the expected state.');
}

test('completed Revmux review preserves optional-fix findings through the strict caller contract', async (t) => {
  for (const severity of ['minor', 'major']) {
    const { client } = await harness(t, `optional-fix-${severity}`);
    await client.start(
      'op',
      'Review',
      undefined,
      { mode: 'unbounded' },
      'caller-digest',
    );
    await eventually(async () => {
      const result = await client.result('op');
      return (
        result.success && (result.data.run as { terminal: boolean }).terminal
      );
    });
    const result = await client.result('op');
    assert.ok(result.success);
    assert.equal((result.data.run as { phase: string }).phase, 'done');
    const output = (result.data.callerOutput as { output: string }).output;
    assert.match(
      output,
      /Fix: Unavailable: reviewer supplied no suggested fix\./,
    );
    const validated = validateReviewResult(output, 'abc', 'abc');
    assert.equal(validated.findings[0]?.severity, severity.toUpperCase());
    assert.equal(validated.blocking, severity === 'major');
    assert.equal(result.data.requestDigest, 'caller-digest');
  }
});

test('controlled Revmux review survives client restart and replays exactly one operation', async (t) => {
  const { client, options, cwd } = await harness(t);
  assert.equal(
    (await client.start('op', 'Review', undefined, { mode: 'unbounded' }))
      .success,
    true,
  );
  const restarted = new RevmuxReviewClient(options);
  await eventually(async () => {
    const result = await restarted.result('op');
    return (
      result.success && (result.data.run as { terminal: boolean }).terminal
    );
  });
  const result = await restarted.start('op', 'Review', undefined, {
    mode: 'unbounded',
  });
  assert.ok(result.success);
  assert.deepEqual(result.data.callerOutput, {
    contract: 'plan-review-v1',
    output: 'NO_FINDINGS',
  });
  assert.equal(result.data.reviewedCommit, 'abc');
  const launches = (await readFile(join(cwd, 'launches'), 'utf8'))
    .trim()
    .split('\n');
  assert.equal(launches.length, 1);
  assert.match(launches[0] ?? '', /--execution-lifetime=unbounded/);
  assert.doesNotMatch(launches[0] ?? '', /--hard-timeout|--idle-timeout/);
  assert.equal(
    (await restarted.start('op', 'Different request')).success,
    false,
  );
});

test('bounded compatibility mode is explicit in the process request and the Revmux CLI', async (t) => {
  const { client, cwd, options } = await harness(t);
  await client.start(
    'op',
    'Review',
    undefined,
    { mode: 'bounded', timeoutMs: 7000 },
    'caller-digest',
  );
  await eventually(async () => {
    const result = await client.result('op');
    return (
      result.success && (result.data.run as { terminal: boolean }).terminal
    );
  });
  const argv = await readFile(join(cwd, 'launches'), 'utf8');
  assert.match(argv, /--execution-lifetime=bounded/);
  assert.match(argv, /--hard-timeout=7000ms/);
  const directory = join(
    options.stateDirectory,
    createHash('sha256').update('op').digest('hex'),
  );
  const request = JSON.parse(
    await readFile(join(directory, 'owned-process', 'request.json'), 'utf8'),
  );
  assert.deepEqual(request.lifetime, { kind: 'bounded', timeoutMs: 7000 });
});

test('Revmux freezes a worktree-safe process environment and preserves it on replay', async (t) => {
  const { client, cwd, options } = await harness(t);
  const canaries = {
    GIT_DIR: '/foreign/.git',
    GIT_WORK_TREE: '/foreign',
    GIT_INDEX_FILE: '/foreign/index',
    GIT_COMMON_DIR: '/foreign/common',
    GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: '/foreign',
    GIT_AUTHOR_NAME: 'Fixture author',
    GIT_SSH_COMMAND: 'ssh -F /fixture/config',
    PLAN_EXEC_TEST_AUTH: 'fixture-auth',
  };
  const previous = Object.fromEntries(
    Object.keys(canaries).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, canaries);
  try {
    assert.equal(
      (
        await client.start(
          'op',
          'Review',
          undefined,
          { mode: 'unbounded' },
          'caller-digest',
        )
      ).success,
      true,
    );
    await eventually(async () => {
      const result = await client.result('op');
      return (
        result.success && (result.data.run as { terminal: boolean }).terminal
      );
    });
    const directory = join(
      options.stateDirectory,
      createHash('sha256').update('op').digest('hex'),
    );
    const requestPath = join(directory, 'owned-process', 'request.json');
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.equal(request.cwd, cwd);
    for (const name of Object.keys(canaries).filter(
      (name) =>
        name !== 'GIT_AUTHOR_NAME' &&
        name !== 'GIT_SSH_COMMAND' &&
        name !== 'PLAN_EXEC_TEST_AUTH',
    ))
      assert.equal(request.env[name], undefined, name);
    assert.equal(request.env.GIT_AUTHOR_NAME, 'Fixture author');
    assert.equal(request.env.GIT_SSH_COMMAND, 'ssh -F /fixture/config');
    assert.equal(request.env.PLAN_EXEC_TEST_AUTH, 'fixture-auth');
    const intent = JSON.parse(
      await readFile(join(directory, 'request.json'), 'utf8'),
    );
    assert.equal(intent.request.cwd, cwd);
    assert.equal(intent.request.reviewedCommit, 'abc');
    process.env.GIT_AUTHOR_NAME = 'Changed parent author';
    process.env.PLAN_EXEC_TEST_AUTH = 'changed-parent-auth';
    assert.equal(
      (
        await new RevmuxReviewClient(options).start(
          'op',
          'Review',
          undefined,
          { mode: 'unbounded' },
          'caller-digest',
        )
      ).success,
      true,
    );
    const replayed = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.equal(replayed.env.GIT_AUTHOR_NAME, 'Fixture author');
    assert.equal(replayed.env.PLAN_EXEC_TEST_AUTH, 'fixture-auth');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('killing the reviewer process group before its receipt fails the review without a relaunch', async (t) => {
  const { client, cwd, options } = await harness(t, 'wait');
  await client.start(
    'op',
    'Review',
    undefined,
    { mode: 'unbounded' },
    'caller-digest',
  );
  await eventually(async () =>
    readFile(join(cwd, 'launches')).then(
      () => true,
      () => false,
    ),
  );
  const directory = join(
    options.stateDirectory,
    createHash('sha256').update('op').digest('hex'),
  );
  const launch = JSON.parse(
    await readFile(join(directory, 'owned-process', 'launch.json'), 'utf8'),
  );
  process.kill(-launch.pgid, 'SIGKILL');
  await eventually(async () => {
    const result = await client.result('op');
    return (
      result.success && (result.data.run as { terminal: boolean }).terminal
    );
  });
  const result = await client.result('op');
  assert.ok(result.success);
  assert.equal((result.data.run as { phase: string }).phase, 'failed');
  assert.equal(
    hasTerminalOwnershipProof(result.data, 'op', {
      operationId: 'op',
      requestDigest: 'caller-digest',
    }),
    true,
  );
  assert.equal(
    (await readFile(join(cwd, 'launches'), 'utf8')).trim().split('\n').length,
    1,
  );
});

test('cancel retires the reviewer process group and reports escaped descendants as best-effort', async (t) => {
  const { client, cwd } = await harness(t, 'escaped-wait');
  await client.start(
    'op',
    'Review',
    undefined,
    { mode: 'unbounded' },
    'caller-digest',
  );
  await eventually(async () =>
    readFile(join(cwd, 'escaped-pid')).then(
      () => true,
      () => false,
    ),
  );
  const pid = Number(await readFile(join(cwd, 'escaped-pid'), 'utf8'));
  assert.doesNotThrow(() => process.kill(pid, 0));
  const cancellation = await client.cancel(undefined, 'op');
  assert.ok(cancellation.success);
  await eventually(async () => {
    const result = await client.status('op');
    return (
      result.success &&
      (result.data.run as { phase: string }).phase === 'cancelled'
    );
  });
  // The detached descendant left the owned process group; v2-lite makes no containment promise for it.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
});

test('Revmux cancellation is fenced and reconciled by the persistent monitor', async (t) => {
  const { client, cwd, options } = await harness(t, 'wait');
  await client.start('op', 'Review');
  await eventually(async () =>
    readFile(join(cwd, 'launches')).then(
      () => true,
      () => false,
    ),
  );
  const cancellation = await client.cancel(undefined, 'op');
  assert.ok(cancellation.success);
  assert.equal(cancellation.data.neverStarted, false);
  const restarted = new RevmuxReviewClient(options);
  await eventually(async () => {
    const result = await restarted.status('op');
    return (
      result.success &&
      (result.data.run as { phase: string }).phase === 'cancelled'
    );
  });
  const result = await restarted.start('op', 'Review');
  assert.ok(result.success);
  assert.equal((result.data.run as { phase: string }).phase, 'cancelled');
  assert.equal(
    (await readFile(join(cwd, 'launches'), 'utf8')).trim().split('\n').length,
    1,
  );
});

test('a reviewer without explicit execution-lifetime support is rejected before launching', async (t) => {
  const { client, cwd } = await harness(t, 'unsupported');
  const capabilities = await client.capabilities();
  assert.equal(capabilities.healthy, true);
  assert.equal(capabilities.executionLifetimeModes, undefined);
  const result = await client.start('op', 'Review');
  assert.ok(!result.success);
  assert.equal(result.error.code, 'unsupported');
  await assert.rejects(readFile(join(cwd, 'launches')), { code: 'ENOENT' });
});

test('a durable cancellation fence wins a delayed Revmux start', async (t) => {
  const { client, cwd, options } = await harness(t);
  const cancellation = await client.cancel(undefined, 'op');
  assert.deepEqual(cancellation, {
    success: true,
    data: {
      operationId: 'op',
      state: 'cancelled',
      cancellationRequested: true,
      neverStarted: true,
      replaySafe: false,
    },
  });
  const restarted = new RevmuxReviewClient(options);
  assert.deepEqual(await restarted.status(undefined, 'op'), cancellation);
  const delayed = await restarted.start(
    'op',
    'Review',
    undefined,
    { mode: 'unbounded' },
    'caller-digest',
  );
  assert.ok(delayed.success);
  assert.equal(delayed.data.neverStarted, true);
  assert.equal(delayed.data.requestDigest, 'caller-digest');
  await assert.rejects(readFile(join(cwd, 'launches')), { code: 'ENOENT' });
});

test('authoritative absent receipt permits same-ID immutable replay racing the original start', async (t) => {
  const { client, cwd, options } = await harness(t);
  const missing = await client.status(undefined, 'op');
  assert.deepEqual(missing, {
    success: true,
    data: { operationId: 'op', state: 'absent', replaySafe: true },
  });
  const restarted = new RevmuxReviewClient(options);
  const starts = await Promise.all([
    client.start(
      'op',
      'Review',
      undefined,
      { mode: 'unbounded' },
      'caller-digest',
    ),
    restarted.start(
      'op',
      'Review',
      undefined,
      { mode: 'unbounded' },
      'caller-digest',
    ),
  ]);
  assert.ok(
    starts.every(
      (result) =>
        result.success && result.data.requestDigest === 'caller-digest',
    ),
  );
  await eventually(async () => {
    const result = await restarted.result('op');
    return (
      result.success && (result.data.run as { terminal: boolean }).terminal
    );
  });
  const conflicting = await restarted.start(
    'op',
    'Review',
    undefined,
    { mode: 'unbounded' },
    'different-digest',
  );
  assert.ok(!conflicting.success);
  assert.equal(conflicting.error.code, 'conflict');
  assert.equal(
    (await readFile(join(cwd, 'launches'), 'utf8')).trim().split('\n').length,
    1,
  );
});

test('reviewer capabilities advertise a best-effort owned process tree and still complete', async (t) => {
  const { client } = await harness(t, 'scoped');
  const capabilities = await client.capabilities();
  assert.deepEqual(capabilities.processTreeOwnership, {
    version: 1,
    scope: 'owned-process-tree',
    escapedDescendants: 'best-effort',
  });
  await client.start(
    'op',
    'Review',
    undefined,
    { mode: 'unbounded' },
    'caller-digest',
  );
  await eventually(async () => {
    const result = await client.result('op');
    return (
      result.success &&
      hasTerminalOwnershipProof(result.data, 'op', {
        operationId: 'op',
        requestDigest: 'caller-digest',
      })
    );
  });
});

test('missing request plus existing admission is uncertain rather than replayable', async (t) => {
  const { client, options } = await harness(t);
  await client.status(undefined, 'op');
  const directory = join(
    options.stateDirectory,
    createHash('sha256').update('op').digest('hex'),
  );
  await writeFile(
    join(directory, 'admission.json'),
    JSON.stringify({ operationId: 'op', state: 'dispatching' }),
  );
  const result = await client.status(undefined, 'op');
  assert.ok(!result.success);
  assert.equal(result.error.code, 'launch_unknown');
});

test('cancel during payload setup retires the owned process group before release', async (t) => {
  const { client, cwd, options } = await harness(t, 'delayed-setup');
  await client.start(
    'op',
    'Review',
    undefined,
    { mode: 'unbounded' },
    'caller-digest',
  );
  await eventually(async () =>
    readFile(join(cwd, 'setup-started')).then(
      () => true,
      () => false,
    ),
  );
  const cancellation = await client.cancel(undefined, 'op');
  assert.ok(cancellation.success);
  assert.equal(cancellation.data.neverStarted, false);
  assert.equal((cancellation.data.run as { phase: string }).phase, 'cancelled');
  const restored = await new RevmuxReviewClient(options).status(
    undefined,
    'op',
  );
  assert.ok(restored.success);
  assert.equal((restored.data.run as { phase: string }).phase, 'cancelled');
  await assert.rejects(readFile(join(cwd, 'launches')), { code: 'ENOENT' });
});
