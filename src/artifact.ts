import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
