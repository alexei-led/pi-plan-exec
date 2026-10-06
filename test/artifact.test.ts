import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test } from 'vitest';
import {
  readNativeArtifact,
  readSettledWorkflowCompletion,
  readSubagentArtifact,
} from '../src/artifact.js';
import { parseNativeReviewReport, parseReviewFindings } from '../src/review.js';

function nativeSingleResult() {
  return {
    lifecycleArtifactVersion: 3,
    id: 'native-review',
    agent: 'reviewer',
    mode: 'single',
    success: true,
    state: 'complete',
    summary: 'reviewer:\nNO_FINDINGS',
    truncated: false,
    launchContractDigest: 'launch-contract',
    results: [
      {
        agent: 'reviewer',
        success: true,
        output: 'NO_FINDINGS',
        outputState: 'present',
        launchContractDigest: 'launch-contract',
      },
    ],
  };
}

test('extracts the authoritative sole native reviewer output instead of decorated summary', async (_t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const result = join(root, 'result.json');
  await writeFile(result, JSON.stringify(nativeSingleResult()));
  const output = await readSubagentArtifact(result, undefined, {
    runId: 'native-review',
    agent: 'reviewer',
    successful: true,
  });
  assert.equal(output, 'NO_FINDINGS');
  assert.deepEqual(parseReviewFindings(output), []);
});

test('invalid native reviewer envelopes cannot fall back to clean status text', async (_t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const result = join(root, 'result.json');
  await writeFile(
    join(root, 'status.json'),
    JSON.stringify({
      runId: 'native-review',
      mode: 'single',
      state: 'complete',
      steps: [
        {
          agent: 'reviewer',
          status: 'complete',
          recentOutput: ['NO_FINDINGS'],
        },
      ],
    }),
  );
  const valid = nativeSingleResult();
  const child = valid.results[0];
  for (const invalid of [
    { ...valid, results: [] },
    { ...valid, results: [child, child] },
    { ...valid, id: 'other-run' },
    { ...valid, agent: 'worker' },
    { ...valid, results: [{ ...child, agent: 'other-reviewer' }] },
    { ...valid, results: [{ ...child, launchContractDigest: 'other-launch' }] },
    { ...valid, results: [{ ...child, output: '' }] },
    { ...valid, results: [{ ...child, outputState: 'missing' }] },
    { ...valid, state: 'running' },
    { ...valid, truncated: true },
    {
      ...valid,
      state: 'failed',
      success: false,
      results: [{ ...child, success: false }],
    },
  ]) {
    await writeFile(result, JSON.stringify(invalid));
    await assert.rejects(
      readSubagentArtifact(result, root, {
        runId: 'native-review',
        agent: 'reviewer',
        successful: true,
      }),
      /Single-agent/,
    );
  }
});

test('failed task diagnostics use actual child output rather than a launch summary', async (_t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const result = join(root, 'result.json');
  const output =
    '<<<RALPHEX:TASK_FAILED>>>\nBlocker: AssertEqual failed at test/input.test.ts:9.';
  await writeFile(
    result,
    JSON.stringify({
      ...nativeSingleResult(),
      id: 'native-task',
      agent: 'worker',
      state: 'failed',
      success: false,
      summary: 'Subagent was scheduled with task instructions.',
      results: [
        {
          agent: 'worker',
          success: false,
          outputState: 'present',
          output,
          launchContractDigest: 'launch-contract',
        },
      ],
    }),
  );
  assert.equal(
    await readSubagentArtifact(result, undefined, {
      runId: 'native-task',
      agent: 'worker',
    }),
    output,
  );
});

test('launch receipts and metadata are never interpreted as worker outcomes', async (_t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const result = join(root, 'result.json');
  for (const receipt of [
    {
      details: { runId: 'native-task', asyncDir: root },
      content: [
        {
          text: '<<<RALPHEX:TASK_FAILED>>>\nInstruction: report this marker on failure.',
        },
      ],
    },
    {
      summary: 'NO_FINDINGS',
      instructions: 'Return NO_FINDINGS only after review.',
    },
  ]) {
    await writeFile(result, JSON.stringify(receipt));
    await assert.rejects(
      readSubagentArtifact(result, undefined, {
        runId: 'native-task',
        agent: 'worker',
      }),
    );
  }
});

test('bound single-agent recovery requires full output rather than a potentially truncated status tail', async (_t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const status = {
    runId: 'native-review',
    mode: 'single',
    state: 'complete',
    steps: [
      { agent: 'reviewer', status: 'complete', recentOutput: ['NO_FINDINGS'] },
    ],
  };
  await writeFile(join(root, 'status.json'), JSON.stringify(status));
  const expected = {
    runId: 'native-review',
    agent: 'reviewer',
    successful: true,
  };
  await assert.rejects(readSubagentArtifact(undefined, root, expected));
  const outputFile = join(root, 'output-0.log');
  const output =
    'FINDING: MAJOR | Assertion fails\nEvidence: test/input.ts:9 fails\nFix: Check the empty input case.';
  await writeFile(outputFile, output);
  await writeFile(
    join(root, 'status.json'),
    JSON.stringify({ ...status, outputFile }),
  );
  assert.equal(await readSubagentArtifact(undefined, root, expected), output);
});

test('uses pi-subagents status recentOutput when no configured result path exists', async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      steps: [{ recentOutput: ['Reviewed the change.', 'NO_FINDINGS'] }],
    }),
  );
  assert.equal(
    await readSubagentArtifact(undefined, asyncDir),
    'Reviewed the change.\nNO_FINDINGS',
  );
});

test('recovers the sole workflow return after the result file was archived', async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const output =
    '<<<RALPHEX:TASK_FAILED>>>\nBlocker: Operator release checkpoint is missing.';
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      mode: 'workflow',
      state: 'complete',
      steps: [{ runId: 'child-1', workflowKey: 'main', status: 'completed' }],
      workflow: { value: { key: 'main', runId: 'child-1', ok: true, output } },
    }),
  );
  assert.equal(
    await readSubagentArtifact(join(asyncDir, 'expired.json'), asyncDir),
    output,
  );
});

test('does not adopt a workflow return with a different child identity', async () => {
  const asyncDir = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      mode: 'workflow',
      state: 'complete',
      steps: [{ runId: 'child-1', workflowKey: 'main', status: 'completed' }],
      workflow: {
        value: {
          key: 'main',
          runId: 'unrelated-child',
          output: 'unrelated output',
        },
      },
    }),
  );
  await assert.rejects(
    readSubagentArtifact(undefined, asyncDir),
    /Subagent result output was unavailable/,
  );
});

test('uses the durable async output before truncated status recentOutput', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const asyncDir = join(root, 'async');
  const artifactsDir = join(root, 'artifacts');
  await mkdir(asyncDir);
  await mkdir(artifactsDir);
  await writeFile(
    join(artifactsDir, 'review-run_reviewer_output.md'),
    'FINDING: MAJOR | first finding\nEvidence: complete output',
  );
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'review-run',
      artifactsDir,
      steps: [{ recentOutput: ['Evidence: complete output'] }],
    }),
  );
  assert.equal(
    await readSubagentArtifact(undefined, asyncDir),
    'FINDING: MAJOR | first finding\nEvidence: complete output',
  );
});

test('uses the latest durable output when a retry produced multiple artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const asyncDir = join(root, 'async');
  const artifactsDir = join(root, 'artifacts');
  await mkdir(asyncDir);
  await mkdir(artifactsDir);
  await writeFile(join(artifactsDir, 'review-run_01_output.md'), 'old');
  await writeFile(
    join(artifactsDir, 'review-run_02_output.md'),
    'FINDING: MAJOR | complete retry output',
  );
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'review-run',
      artifactsDir,
      steps: [{ recentOutput: ['truncated tail'] }],
    }),
  );

  assert.equal(
    await readSubagentArtifact(undefined, asyncDir),
    'FINDING: MAJOR | complete retry output',
  );
});

test('falls back when an explicit result artifact is metadata-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const asyncDir = join(root, 'async');
  await mkdir(asyncDir);
  const result = join(root, 'result.json');
  await writeFile(result, JSON.stringify({ state: 'complete' }));
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      steps: [{ recentOutput: ['NO_FINDINGS'] }],
    }),
  );
  assert.equal(await readSubagentArtifact(result, asyncDir), 'NO_FINDINGS');
});

test('uses the single workflow child output instead of the workflow summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const result = join(root, 'result.json');
  await writeFile(
    result,
    JSON.stringify({
      mode: 'workflow',
      output: 'Workflow completed successfully (1 child).',
      results: [{ agent: 'main', output: 'NO_FINDINGS' }],
    }),
  );

  assert.equal(await readSubagentArtifact(result, undefined), 'NO_FINDINGS');
});

test('uses an explicit output artifact before status fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const asyncDir = join(root, 'async');
  await mkdir(asyncDir);
  const result = join(root, 'result.json');
  await writeFile(result, JSON.stringify({ output: 'NO_FINDINGS' }));
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      steps: [{ recentOutput: ['wrong fallback'] }],
    }),
  );
  assert.equal(await readSubagentArtifact(result, asyncDir), 'NO_FINDINGS');
});

test('recognizes a settled detached workflow from its result artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const result = join(root, 'result.json');
  await writeFile(
    result,
    JSON.stringify({
      mode: 'workflow',
      state: 'failed',
      workflowResolution: 'settled-awaiting-resume',
      results: [{ success: true, output: 'NO_FINDINGS' }],
    }),
  );

  assert.deepEqual(await readSettledWorkflowCompletion(result, undefined), {
    output: 'NO_FINDINGS',
  });
});

test('recovers a settled detached workflow after its result was archived', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const runId = 'workflow-1';
  const asyncDir = join(root, 'async-subagent-runs', runId);
  const archiveDir = join(root, 'async-subagent-results', 'output-archives');
  await mkdir(asyncDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  await writeFile(
    join(asyncDir, 'status.json'),
    JSON.stringify({
      runId,
      mode: 'workflow',
      state: 'failed',
      steps: [
        {
          workflowKey: 'main',
          parentWorkflowRunId: runId,
          status: 'completed',
        },
      ],
    }),
  );
  await writeFile(
    join(asyncDir, 'workflow-receipt.json'),
    JSON.stringify({
      workflowRunId: runId,
      state: 'failed',
      workflowResolution: 'settled-awaiting-resume',
      entries: { main: { key: 'main' } },
    }),
  );
  await writeFile(
    join(archiveDir, `${runId}.json`),
    JSON.stringify({
      runId,
      entries: [{ resultIndex: 0, source: 'result-tail', text: 'stats' }],
    }),
  );

  assert.deepEqual(
    await readSettledWorkflowCompletion(undefined, asyncDir, runId),
    { output: 'stats' },
  );
});

test('rejects a detached workflow result with a different run identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const result = join(root, 'result.json');
  await writeFile(
    result,
    JSON.stringify({
      runId: 'other-workflow',
      mode: 'workflow',
      state: 'failed',
      workflowResolution: 'settled-awaiting-resume',
      results: [{ success: true, output: 'wrong result' }],
    }),
  );
  assert.equal(
    await readSettledWorkflowCompletion(result, undefined, 'expected-workflow'),
    undefined,
  );
});

test('does not recover a detached workflow whose child failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-plan-exec-artifact-'));
  const result = join(root, 'result.json');
  await writeFile(
    result,
    JSON.stringify({
      mode: 'workflow',
      state: 'failed',
      workflowResolution: 'failed-child',
      results: [{ success: false, error: 'review failed' }],
    }),
  );

  assert.equal(
    await readSettledWorkflowCompletion(result, undefined),
    undefined,
  );
});

const nativeExpectation = {
  workflowRunId: 'workflow-root',
  childRunId: 'child-review',
  workflowKey: 'main',
  parentToolCallId: 'rpc-spawn-request-uuid',
};
const nativeReport = {
  schemaVersion: 1,
  reviewedCommit: 'a'.repeat(40),
  findings: [],
};

function nativeWorkflowResult() {
  return {
    id: nativeExpectation.workflowRunId,
    runId: nativeExpectation.workflowRunId,
    mode: 'workflow',
    state: 'complete',
    success: true,
    summary: 'Decorated summary is not a review',
    workflowChildren: {
      version: 1,
      parentToolCallId: nativeExpectation.parentToolCallId,
      workflowRunId: nativeExpectation.workflowRunId,
      inventoryComplete: true,
      workflowState: 'completed',
      children: [
        {
          childId: 'main',
          runId: nativeExpectation.childRunId,
          state: 'completed',
        },
      ],
    },
    results: [
      {
        workflowKey: 'main',
        runId: nativeExpectation.childRunId,
        success: true,
        outputState: 'present',
        structuredOutput: nativeReport,
        output: 'Decorated child text',
      },
    ],
  };
}

function nativeWorkflowStatus() {
  const result = nativeWorkflowResult();
  return {
    runId: result.runId,
    mode: result.mode,
    state: result.state,
    workflowChildren: result.workflowChildren,
    steps: [
      {
        runId: nativeExpectation.childRunId,
        workflowKey: 'main',
        parentWorkflowRunId: result.runId,
        status: 'completed',
        recentOutput: ['NO_FINDINGS'],
      },
    ],
    workflow: {
      value: {
        key: 'main',
        runId: nativeExpectation.childRunId,
        ok: true,
        output: '',
        structuredOutput: nativeReport,
      },
    },
  };
}

test('native explicit files and structuredOutput decode without filename or text identity inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-result-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'owned-arbitrary-name');
  await writeFile(path, JSON.stringify(nativeReport));
  assert.deepEqual(
    await readNativeArtifact({ kind: 'bound-file', path }),
    nativeReport,
  );
  for (const value of [
    nativeWorkflowResult(),
    nativeWorkflowStatus(),
    { ...nativeWorkflowResult(), workflow: nativeWorkflowStatus().workflow },
  ]) {
    assert.deepEqual(
      await readNativeArtifact({
        kind: 'workflow-envelope',
        value,
        expected: nativeExpectation,
      }),
      nativeReport,
    );
    await writeFile(path, JSON.stringify(value));
    const report = await readNativeArtifact({
      kind: 'workflow-file',
      path,
      expected: nativeExpectation,
    });
    assert.deepEqual(
      parseNativeReviewReport(report, nativeReport.reviewedCommit),
      nativeReport,
    );
  }
  const marker = '<<<RALPHEX:TASK_COMPLETED>>>';
  await writeFile(path, marker);
  assert.equal(await readNativeArtifact({ kind: 'bound-file', path }), marker);
  const value = nativeWorkflowResult();
  assert.equal(
    await readNativeArtifact({
      kind: 'workflow-envelope',
      expected: nativeExpectation,
      value: {
        ...value,
        results: [
          { ...value.results[0], structuredOutput: undefined, output: marker },
        ],
      },
    }),
    marker,
  );
});

test('native workflow identity, cardinality, truncation and launch receipts fail closed', async () => {
  const valid = nativeWorkflowResult();
  const child = valid.results[0];
  const status = nativeWorkflowStatus();
  const summary = valid.workflowChildren;
  for (const value of [
    { ...valid, id: 'other' },
    { ...valid, runId: 'other' },
    { ...valid, state: 'running' },
    { ...valid, success: false },
    { ...valid, results: [] },
    { ...valid, results: [child, child] },
    { ...valid, truncated: true },
    { ...valid, workflowChildren: undefined },
    ...[
      { runId: 'other' },
      { workflowKey: 'other' },
      { success: false },
      { state: 'running' },
      { detached: true },
      { truncated: true },
      { outputState: 'absent' },
      { structuredOutput: undefined, output: '' },
      { structuredOutput: null },
      { structuredOutput: 'x'.repeat(1024 * 1024 + 1) },
    ].map((change) => ({ ...valid, results: [{ ...child, ...change }] })),
    ...[
      { workflowRunId: 'other' },
      { parentToolCallId: 'other' },
      { inventoryComplete: false },
      { children: [] },
      { children: [...summary.children, ...summary.children] },
      { children: [{ ...summary.children[0], runId: 'other' }] },
      { children: [{ ...summary.children[0], childId: 'other' }] },
    ].map((change) => ({
      ...valid,
      workflowChildren: { ...summary, ...change },
    })),
    { ...status, steps: [] },
    { ...status, steps: [...status.steps, ...status.steps] },
    {
      ...status,
      workflow: { value: { ...status.workflow.value, runId: 'other' } },
    },
    {
      ...status,
      workflow: { value: { ...status.workflow.value, key: 'other' } },
    },
    { ...status, workflow: { value: { ...status.workflow.value, ok: false } } },
    { ...status, workflow: undefined },
    {
      ...status,
      workflow: {
        value: {
          ...status.workflow.value,
          structuredOutput: undefined,
          output: '',
        },
      },
    },
    { ...status, steps: [{ ...status.steps[0], runId: 'other' }] },
    { ...status, steps: [{ ...status.steps[0], workflowKey: 'other' }] },
    {
      ...valid,
      workflow: {
        value: {
          ...status.workflow.value,
          structuredOutput: { ...nativeReport, findings: ['contradictory'] },
        },
      },
    },
    {
      ...status,
      steps: [{ ...status.steps[0], parentWorkflowRunId: 'other' }],
    },
    {
      ...valid,
      workflow: { value: { ...status.workflow.value, key: 'other' } },
    },
    {
      details: { runId: 'workflow-root' },
      content: [{ text: JSON.stringify(nativeReport) }],
    },
    { runId: 'workflow-root', summary: JSON.stringify(nativeReport) },
  ])
    await assert.rejects(
      readNativeArtifact({
        kind: 'workflow-envelope',
        value,
        expected: nativeExpectation,
      }),
    );
});

test('native bound files never infer fallback output for missing, truncated or excessive reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-result-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'owned-report');
  await writeFile(
    join(root, 'status.json'),
    JSON.stringify(nativeWorkflowStatus()),
  );
  await assert.rejects(readNativeArtifact({ kind: 'bound-file', path }));
  await assert.rejects(
    readNativeArtifact({ kind: 'bound-file', path: 'relative.json' }),
  );
  for (const raw of [
    '',
    JSON.stringify(nativeReport).slice(0, -1),
    JSON.stringify({ summary: 'NO_FINDINGS' }),
  ]) {
    await writeFile(path, raw);
    await assert.rejects(async () =>
      parseNativeReviewReport(
        await readNativeArtifact({ kind: 'bound-file', path }),
        nativeReport.reviewedCommit,
      ),
    );
  }
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readNativeArtifact({ kind: 'bound-file', path }));
  await writeFile(path, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(readNativeArtifact({ kind: 'bound-file', path }));
});
