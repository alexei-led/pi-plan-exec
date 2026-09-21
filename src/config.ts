import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_FROZEN_RUN_CONFIG, MAX_EXECUTION_TIMEOUT_MS, type FrozenRunConfig } from "./types.js";

/** Read once at run creation. Restart uses the durable frozen copy. */
export async function resolveRunConfig(repositoryRoot: string): Promise<FrozenRunConfig> {
  let raw: string;
  try {
    raw = await readFile(join(repositoryRoot, ".pi", "plan-exec.json"), "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return parseRunConfig({});
    throw error;
  }
  return parseRunConfig(JSON.parse(raw) as unknown);
}

export function parseRunConfig(value: unknown): FrozenRunConfig {
  if (!isRecord(value)) throw new Error("Plan execution config must be an object.");
  const optional = ["workerModel", "reviewerModel", "statsModel", "fusionProfile", "revmuxExecutable", "revmuxProfile"];
  const allowed = new Set([...Object.keys(DEFAULT_FROZEN_RUN_CONFIG), ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown plan execution setting: ${key}.`);
  const config: Record<string, unknown> = { ...structuredClone(DEFAULT_FROZEN_RUN_CONFIG), ...value };
  const lifetime = config.executionLifetime;
  if (!isRecord(lifetime) ||
    (lifetime.mode !== "unbounded" && lifetime.mode !== "bounded") ||
    (lifetime.mode === "bounded" && (!positiveInteger(lifetime.timeoutMs) || Number(lifetime.timeoutMs) > MAX_EXECUTION_TIMEOUT_MS)) ||
    (lifetime.mode === "unbounded" && Object.keys(lifetime).some((key) => key !== "mode")))
    throw new Error("executionLifetime must explicitly select unbounded or bounded with a positive timeoutMs.");
  for (const key of ["retryDelayMs", "workerMaxTurns", "reviewerMaxTurns", "statsMaxTurns", "reviewIterations", "fusionIterations"])
    if (!positiveInteger(config[key])) throw new Error(`${key} must be a positive integer.`);
  for (const key of ["taskRetries", "maxTaskIterations"])
    if (typeof config[key] !== "number" || !Number.isSafeInteger(config[key]) || Number(config[key]) < 0)
      throw new Error(`${key} must be a nonnegative diagnostic value.`);
  for (const key of ["workerAgent", "reviewerAgent", "statsAgent", ...optional])
    if (config[key] !== undefined && (typeof config[key] !== "string" || !String(config[key]).trim()))
      throw new Error(`${key} must be a nonempty string.`);
  for (const key of ["reviewEnabled", "reviewRequired", "finalizeEnabled", "statsEnabled"])
    if (typeof config[key] !== "boolean") throw new Error(`${key} must be boolean.`);
  if (config.reviewRequired && !config.reviewEnabled)
    throw new Error("Required review cannot be disabled.");
  const backends = new Set(["subagent", "fusion", "revmux"]);
  if (typeof config.reviewBackend !== "string" || !backends.has(config.reviewBackend) ||
    !Array.isArray(config.reviewFallback) ||
    !config.reviewFallback.every((backend: unknown) => typeof backend === "string" && backends.has(backend)))
    throw new Error("Review backend and fallback must name subagent, fusion or revmux.");
  for (const key of ["requiredChecks", "bootstrapCommands"])
    if (!Array.isArray(config[key]) || !config[key].every((command: unknown) =>
      Array.isArray(command) && command.length > 0 && command.every((arg: unknown) => typeof arg === "string" && arg.length > 0)))
      throw new Error(`${key} must contain nonempty command argument arrays.`);
  return config as unknown as FrozenRunConfig;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
