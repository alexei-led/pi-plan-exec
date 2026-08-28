import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  EXTERNAL_OPERATION_STATE,
  RUN_STATUS,
  WORKFLOW_MODE,
  WORKFLOW_RESOLUTION,
} from "./types.js";

export interface SettledWorkflowCompletion {
  output?: string;
}

const COMPLETED_STEP_STATES = new Set<string>([
  EXTERNAL_OPERATION_STATE.COMPLETE,
  RUN_STATUS.COMPLETED,
]);

/**
 * pi-subagents status exposes a result path only when output was configured.
 * For normal agent runs, its durable status artifact retains final recentOutput.
 */
export async function readSubagentArtifact(
  resultPath: string | undefined,
  asyncDir: string | undefined,
): Promise<string> {
  if (resultPath) {
    const output = await readOutputFile(resultPath);
    if (output) return output;
  }
  if (asyncDir) {
    const output = await readAsyncOutput(join(asyncDir, "status.json"));
    if (output) return output;
  }
  throw new Error("Subagent result output was unavailable.");
}

/**
 * A child can detach while it waits for a supervisor reply. pi-subagents then
 * settles the child but cannot continue the in-memory JavaScript workflow. The
 * receipt is the durable proof that the sole child completed successfully; its
 * output may already have moved to the normal output archive.
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
      "async-subagent-results",
      "output-archives",
      `${runId}.json`,
    );
    output = archivedWorkflowOutput(
      await readJsonFile(archivePath),
      expectedRunId,
    );
  }
  if (!output) output = await readAsyncOutput(join(asyncDir, "status.json"));
  return output ? { output } : {};
}

async function readOutputFile(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    try {
      return extractText(JSON.parse(raw));
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return raw.trim() || undefined;
      return undefined;
    }
  } catch {
    return undefined;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function settledWorkflowChild(value: unknown): Record<string, unknown> | undefined {
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
    readJsonFile(join(asyncDir, "status.json")),
    readJsonFile(join(asyncDir, "workflow-receipt.json")),
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
    receipt.state !== EXTERNAL_OPERATION_STATE.FAILED ||
    receipt.workflowResolution !==
      WORKFLOW_RESOLUTION.SETTLED_AWAITING_RESUME ||
    !isRecord(receipt.entries)
  )
    return false;
  const [key, entry] = Object.entries(receipt.entries)[0] ?? [];
  return (
    Object.keys(receipt.entries).length === 1 &&
    isRecord(entry) &&
    (!expectedRunId || entry.parentWorkflowRunId === expectedRunId) &&
    isRecord(status.steps[0]) &&
    (!status.steps[0].workflowKey || status.steps[0].workflowKey === key)
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

async function readAsyncOutput(path: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) return undefined;
    const durable = await readDurableOutput(value);
    if (durable) return durable;
    if (!Array.isArray(value.steps)) return undefined;
    const step = [...value.steps].reverse().find(isRecord);
    if (!step || !Array.isArray(step.recentOutput)) return undefined;
    const output = step.recentOutput
      .filter((line): line is string => typeof line === "string")
      .join("\n")
      .trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

async function readDurableOutput(
  status: Record<string, unknown>,
): Promise<string | undefined> {
  if (
    typeof status.artifactsDir !== "string" ||
    typeof status.runId !== "string"
  )
    return undefined;
  const prefix = `${status.runId}_`;
  const candidates = (await readdir(status.artifactsDir))
    .filter((name) => name.startsWith(prefix) && name.endsWith("_output.md"))
    .sort();
  if (candidates.length === 0) return undefined;
  return readOutputFile(join(status.artifactsDir, candidates.at(-1)!));
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value))
    throw new Error("Subagent result artifact is malformed.");
  if (
    value.mode === "workflow" &&
    Array.isArray(value.results) &&
    value.results.length === 1
  ) {
    try {
      return extractText(value.results[0]);
    } catch {
      // Failed children can lack output while the workflow summary remains useful.
    }
  }
  for (const key of ["output", "result", "text", "summary", "content"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter(isRecord)
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  throw new Error("Subagent result artifact contains no text output.");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
