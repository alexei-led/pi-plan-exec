import { open, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { required } from './required.js';
import {
  EXTERNAL_OPERATION_STATE,
  RUN_STATUS,
  WORKFLOW_MODE,
  WORKFLOW_RESOLUTION,
} from './types.js';

export interface SettledWorkflowCompletion {
  output?: string;
}

export interface SubagentArtifactExpectation {
  runId: string;
  agent?: string;
  successful?: boolean;
}

const SINGLE_MODE = 'single';
const TERMINAL_RESULT_STATES = new Set<string>([
  EXTERNAL_OPERATION_STATE.COMPLETE,
  EXTERNAL_OPERATION_STATE.FAILED,
  EXTERNAL_OPERATION_STATE.STOPPED,
  EXTERNAL_OPERATION_STATE.ABORTED,
]);

const COMPLETED_STEP_STATES = new Set<string>([
  EXTERNAL_OPERATION_STATE.COMPLETE,
  RUN_STATUS.COMPLETED,
]);

/**
 * Native single-agent results use the sole correlated child output.
 * Bound callers never accept a potentially truncated recentOutput tail.
 */
export async function readSubagentArtifact(
  resultPath: string | undefined,
  asyncDir: string | undefined,
  expected?: SubagentArtifactExpectation | string,
): Promise<string> {
  const expectation =
    typeof expected === 'string' ? { runId: expected } : expected;
  if (resultPath) {
    const output = await readOutputFile(resultPath, expectation);
    if (output) return output;
  }
  if (asyncDir) {
    const output = await readAsyncOutput(
      join(asyncDir, 'status.json'),
      expectation,
    );
    if (output) return output;
  }
  throw new Error('Subagent result output was unavailable.');
}

/**
 * A child can detach while it waits for a supervisor reply. pi-subagents then
 * settles the child but cannot continue the in-memory JavaScript workflow. The
 * receipt identifies the sole completed result; process ownership still needs
 * independent runtime proof. Output may have moved to the normal archive.
 */
export async function readSettledWorkflowCompletion(
  resultPath: string | undefined,
  asyncDir: string | undefined,
  expectedRunId?: string,
): Promise<SettledWorkflowCompletion | undefined> {
  const direct = resultPath ? await readJsonFile(resultPath) : undefined;
  if (expectedRunId && isRecord(direct) && direct.runId !== expectedRunId)
    return undefined;
  const directChild = settledWorkflowChild(direct);
  if (directChild) {
    const output = extractTextOptional(directChild);
    return output ? { output } : {};
  }
  if (
    !asyncDir ||
    (expectedRunId && basename(asyncDir) !== expectedRunId) ||
    !(await hasSettledWorkflowReceipt(asyncDir, expectedRunId))
  )
    return undefined;

  let output: string | undefined;
  if (resultPath) output = await readOutputFile(resultPath);
  if (!output) {
    const runId = basename(asyncDir);
    const archivePath = join(
      dirname(dirname(asyncDir)),
      'async-subagent-results',
      'output-archives',
      `${runId}.json`,
    );
    output = archivedWorkflowOutput(
      await readJsonFile(archivePath),
      expectedRunId,
    );
  }
  if (!output)
    output = await readAsyncOutput(
      join(asyncDir, 'status.json'),
      expectedRunId ? { runId: expectedRunId } : undefined,
    );
  return output ? { output } : {};
}

async function readOutputFile(
  path: string,
  expected?: SubagentArtifactExpectation,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return raw.trim() || undefined;
    throw error;
  }
  if (isRecord(value) && value.mode === SINGLE_MODE)
    return singleAgentOutput(value, expected);
  if (
    isRecord(value) &&
    ((isRecord(value.details) &&
      (value.details.runId !== undefined ||
        value.details.asyncId !== undefined)) ||
      (isRecord(value.data) &&
        (value.data.runId !== undefined || value.data.asyncId !== undefined)))
  )
    throw new Error(
      'Subagent launch/status receipt is not an authoritative worker outcome.',
    );
  try {
    return extractText(value);
  } catch {
    return undefined;
  }
}

function singleAgentOutput(
  value: Record<string, unknown>,
  expected?: SubagentArtifactExpectation,
): string {
  const result =
    Array.isArray(value.results) && value.results.length === 1
      ? value.results[0]
      : undefined;
  const runId = text(value.id);
  const agent = text(value.agent);
  if (
    !runId ||
    !agent ||
    (expected && runId !== expected.runId) ||
    (expected?.agent !== undefined && agent !== expected.agent) ||
    (value.runId !== undefined && value.runId !== runId) ||
    !TERMINAL_RESULT_STATES.has(String(value.state)) ||
    typeof value.success !== 'boolean' ||
    (value.success && value.state !== EXTERNAL_OPERATION_STATE.COMPLETE) ||
    (expected?.successful && !value.success) ||
    value.truncated === true ||
    !isRecord(result) ||
    result.agent !== agent ||
    result.success !== value.success ||
    (result.runId !== undefined && result.runId !== runId) ||
    result.outputState !== 'present' ||
    (value.launchContractDigest !== undefined &&
      result.launchContractDigest !== value.launchContractDigest)
  )
    throw new Error(
      'Single-agent result artifact has mismatched identity, cardinality, or terminal outcome.',
    );
  const output = text(result.output);
  if (!output)
    throw new Error(
      'Single-agent result artifact has no authoritative child output.',
    );
  return output;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function settledWorkflowChild(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    value.mode !== WORKFLOW_MODE ||
    value.state !== EXTERNAL_OPERATION_STATE.FAILED ||
    value.workflowResolution !== WORKFLOW_RESOLUTION.SETTLED_AWAITING_RESUME ||
    !Array.isArray(value.results) ||
    value.results.length !== 1 ||
    !isRecord(value.results[0]) ||
    value.results[0].success !== true
  )
    return undefined;
  return value.results[0];
}

async function hasSettledWorkflowReceipt(
  asyncDir: string,
  expectedRunId?: string,
): Promise<boolean> {
  const [status, receipt] = await Promise.all([
    readJsonFile(join(asyncDir, 'status.json')),
    readJsonFile(join(asyncDir, 'workflow-receipt.json')),
  ]);
  if (
    !isRecord(status) ||
    (expectedRunId && status.runId !== expectedRunId) ||
    status.mode !== WORKFLOW_MODE ||
    status.state !== EXTERNAL_OPERATION_STATE.FAILED ||
    !Array.isArray(status.steps) ||
    status.steps.length !== 1 ||
    !isRecord(status.steps[0]) ||
    !COMPLETED_STEP_STATES.has(String(status.steps[0].status))
  )
    return false;
  if (
    !isRecord(receipt) ||
    (expectedRunId && receipt.workflowRunId !== expectedRunId) ||
    receipt.state !== EXTERNAL_OPERATION_STATE.FAILED ||
    receipt.workflowResolution !==
      WORKFLOW_RESOLUTION.SETTLED_AWAITING_RESUME ||
    !isRecord(receipt.entries)
  )
    return false;
  const [key, entry] = Object.entries(receipt.entries)[0] ?? [];
  const step = status.steps[0];
  return (
    Object.keys(receipt.entries).length === 1 &&
    isRecord(entry) &&
    (!expectedRunId ||
      (step.parentWorkflowRunId === expectedRunId &&
        (entry.parentWorkflowRunId === undefined ||
          entry.parentWorkflowRunId === expectedRunId))) &&
    (!step.workflowKey || step.workflowKey === key)
  );
}

function archivedWorkflowOutput(
  value: unknown,
  expectedRunId?: string,
): string | undefined {
  if (
    !isRecord(value) ||
    (expectedRunId && value.runId !== expectedRunId) ||
    !Array.isArray(value.entries) ||
    value.entries.length !== 1 ||
    !isRecord(value.entries[0])
  )
    return undefined;
  return text(value.entries[0].text);
}

function extractTextOptional(value: unknown): string | undefined {
  try {
    return extractText(value);
  } catch {
    return undefined;
  }
}

async function readAsyncOutput(
  path: string,
  expected?: SubagentArtifactExpectation,
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value)) return undefined;
    if (expected && value.runId !== expected.runId) return undefined;
    if (value.mode === SINGLE_MODE) {
      const step =
        Array.isArray(value.steps) && value.steps.length === 1
          ? value.steps[0]
          : undefined;
      if (
        !TERMINAL_RESULT_STATES.has(String(value.state)) ||
        !isRecord(step) ||
        !TERMINAL_RESULT_STATES.has(String(step.status)) ||
        !text(step.agent) ||
        (expected?.agent !== undefined && step.agent !== expected.agent) ||
        (expected?.successful &&
          (value.state !== EXTERNAL_OPERATION_STATE.COMPLETE ||
            step.status !== EXTERNAL_OPERATION_STATE.COMPLETE))
      )
        return undefined;
      if (typeof value.outputFile === 'string') {
        const output = await readFile(value.outputFile, 'utf8').catch(
          () => undefined,
        );
        if (text(output)) return text(output);
      }
    }
    if (
      value.mode === WORKFLOW_MODE &&
      isRecord(value.workflow) &&
      isRecord(value.workflow.value) &&
      Array.isArray(value.steps) &&
      value.steps.length === 1
    ) {
      const step = value.steps[0];
      const result = value.workflow.value;
      if (
        isRecord(step) &&
        typeof step.runId === 'string' &&
        result.runId === step.runId &&
        result.key === step.workflowKey &&
        (!expected?.successful || result.ok === true)
      ) {
        const output = text(result.output);
        if (output) return output;
      }
    }
    const durable = await readDurableOutput(value, expected);
    if (durable) return durable;
    if (expected) return undefined;
    if (!Array.isArray(value.steps)) return undefined;
    const step = [...value.steps].reverse().find(isRecord);
    if (!step || !Array.isArray(step.recentOutput)) return undefined;
    const output = step.recentOutput
      .filter((line): line is string => typeof line === 'string')
      .join('\n')
      .trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

async function readDurableOutput(
  status: Record<string, unknown>,
  expected?: SubagentArtifactExpectation,
): Promise<string | undefined> {
  if (
    typeof status.artifactsDir !== 'string' ||
    typeof status.runId !== 'string'
  )
    return undefined;
  const prefix = `${status.runId}_`;
  const candidates = (await readdir(status.artifactsDir))
    .filter((name) => name.startsWith(prefix) && name.endsWith('_output.md'))
    .sort();
  if (candidates.length === 0) return undefined;
  if (expected) {
    if (candidates.length !== 1) return undefined;
    return text(
      await readFile(
        join(status.artifactsDir, required(candidates[0])),
        'utf8',
      ),
    );
  }
  return readOutputFile(join(status.artifactsDir, required(candidates.at(-1))));
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value))
    throw new Error('Subagent result artifact is malformed.');
  if (
    value.mode === 'workflow' &&
    Array.isArray(value.results) &&
    value.results.length === 1
  ) {
    try {
      return extractText(value.results[0]);
    } catch {
      // Failed children can lack output while the workflow summary remains useful.
    }
  }
  for (const key of ['output', 'result', 'text', 'content']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim())
      return candidate.trim();
  }
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter(isRecord)
      .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  throw new Error('Subagent result artifact contains no text output.');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface NativeArtifactExpectation {
  workflowRunId: string;
  childRunId: string;
  workflowKey: string;
  parentToolCallId: string;
}

export type NativeArtifactSource =
  | { kind: 'bound-file'; path: string }
  | { kind: 'workflow-file'; path: string; expected: NativeArtifactExpectation }
  | {
      kind: 'workflow-envelope';
      value: unknown;
      expected: NativeArtifactExpectation;
    };

const MAX_NATIVE_ARTIFACT_BYTES = 1024 * 1024;

/**
 * Paths must be caller-owned bindings, not references extracted from runtime prose.
 * This decodes content only; retirement, success proof and candidate verification
 * remain controller responsibilities. There is deliberately no fallback search.
 */
export async function readNativeArtifact(
  source: NativeArtifactSource,
): Promise<unknown> {
  if (source.kind === 'workflow-envelope')
    return decodeNativeWorkflow(source.value, source.expected);
  if (!isAbsolute(source.path))
    throw new Error('Native artifact requires an absolute caller-bound path.');
  const file = await open(source.path, 'r');
  let raw: string;
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Native artifact must be a regular file.');
    const buffer = Buffer.alloc(MAX_NATIVE_ARTIFACT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_NATIVE_ARTIFACT_BYTES)
      throw new Error('Native artifact exceeds the size limit.');
    raw = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, size),
    );
  } finally {
    await file.close();
  }
  if (!raw.trim()) throw new Error('Native artifact output is missing.');
  if (source.kind === 'workflow-file')
    return decodeNativeWorkflow(JSON.parse(raw), source.expected);
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Worker/goal markers are text. The typed review parser still requires JSON.
    if (error instanceof SyntaxError) return raw;
    throw error;
  }
}

function decodeNativeWorkflow(
  value: unknown,
  expected: NativeArtifactExpectation,
): unknown {
  if (
    !text(expected.workflowRunId) ||
    !text(expected.childRunId) ||
    !text(expected.workflowKey) ||
    !text(expected.parentToolCallId) ||
    !isRecord(value) ||
    value.mode !== 'workflow' ||
    value.state !== 'complete' ||
    (value.id ?? value.runId) !== expected.workflowRunId ||
    (value.id !== undefined && value.id !== expected.workflowRunId) ||
    (value.runId !== undefined && value.runId !== expected.workflowRunId) ||
    (value.toolCallId !== undefined &&
      value.toolCallId !== expected.parentToolCallId) ||
    (value.success !== undefined && value.success !== true) ||
    incompleteNativeResult(value)
  )
    throw new Error(
      'Native workflow has mismatched identity or incomplete outcome.',
    );
  const inventory = value.workflowChildren;
  const child = isRecord(inventory)
    ? soleNativeChild(inventory.children)
    : undefined;
  if (
    !isRecord(inventory) ||
    inventory.version !== 1 ||
    inventory.workflowRunId !== expected.workflowRunId ||
    inventory.parentToolCallId !== expected.parentToolCallId ||
    inventory.inventoryComplete !== true ||
    inventory.workflowState !== 'completed' ||
    !child ||
    child.childId !== expected.workflowKey ||
    child.runId !== expected.childRunId ||
    child.state !== 'completed'
  )
    throw new Error(
      'Native workflow child inventory has mismatched identity or cardinality.',
    );

  let resultOutput: unknown;
  if (value.results !== undefined) {
    const result = soleNativeChild(value.results);
    if (
      !result ||
      result.runId !== expected.childRunId ||
      result.workflowKey !== expected.workflowKey ||
      result.success !== true ||
      result.outputState !== 'present' ||
      incompleteNativeResult(result)
    )
      throw new Error(
        'Native workflow result has mismatched identity or missing child output.',
      );
    resultOutput = nativeChildOutput(result);
  }
  if (value.steps !== undefined) {
    const step = soleNativeChild(value.steps);
    if (
      !step ||
      step.runId !== expected.childRunId ||
      step.workflowKey !== expected.workflowKey ||
      (step.parentWorkflowRunId !== undefined &&
        step.parentWorkflowRunId !== expected.workflowRunId) ||
      !COMPLETED_STEP_STATES.has(String(step.status)) ||
      incompleteNativeResult(step)
    )
      throw new Error(
        'Native workflow steps have mismatched identity or cardinality.',
      );
  }
  let workflowOutput: unknown;
  if (value.workflow !== undefined) {
    const returned = isRecord(value.workflow)
      ? value.workflow.value
      : undefined;
    if (
      !isRecord(returned) ||
      returned.runId !== expected.childRunId ||
      returned.key !== expected.workflowKey ||
      returned.ok !== true ||
      incompleteNativeResult(returned)
    )
      throw new Error(
        'Native workflow return has mismatched identity or incomplete output.',
      );
    workflowOutput = nativeChildOutput(returned);
  }
  if (
    resultOutput !== undefined &&
    workflowOutput !== undefined &&
    !isDeepStrictEqual(resultOutput, workflowOutput)
  )
    throw new Error('Native workflow contains contradictory child outputs.');
  const output = resultOutput ?? workflowOutput;
  if (output === undefined)
    throw new Error('Native workflow has no authoritative child output.');
  return output;
}

function soleNativeChild(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) && value.length === 1 && isRecord(value[0])
    ? value[0]
    : undefined;
}

function incompleteNativeResult(value: Record<string, unknown>): boolean {
  return (
    [
      'truncated',
      'previewTruncated',
      'detached',
      'interrupted',
      'stopped',
      'timedOut',
      'structuredOutputFailed',
    ].some((key) => value[key] !== undefined && value[key] !== false) ||
    (value.state !== undefined &&
      value.state !== 'complete' &&
      value.state !== 'completed') ||
    value.terminalOutcome !== undefined ||
    Boolean(value.error)
  );
}

function nativeChildOutput(value: Record<string, unknown>): unknown {
  const output =
    value.structuredOutput !== undefined
      ? value.structuredOutput
      : text(value.output);
  if (output === undefined || output === null)
    throw new Error('Native workflow child output is missing.');
  const serialized = JSON.stringify(output);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > MAX_NATIVE_ARTIFACT_BYTES
  )
    throw new Error('Native workflow child output is malformed or excessive.');
  return output;
}
