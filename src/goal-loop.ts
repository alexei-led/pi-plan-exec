import { createHash } from "node:crypto";
import type { PlanExecRun } from "./types.js";

export const GOAL_DONE_MARKER = "<<<RALPHEX:GOAL_DONE>>>";
export const TASK_FAILED_MARKER = "<<<RALPHEX:TASK_FAILED>>>";
export const GOAL_NO_PROGRESS_LIMIT = 3;
export const GOAL_FINGERPRINT_LENGTH = 12;
export const GOAL_DISABLED_SAMPLE_LIMIT = 3;
export const GOAL_CHECK_OUTPUT_LIMIT = 1_200;
export const GOAL_OUTCOME = {
  DONE: "done",
  CONTINUE: "continue",
  BLOCKED: "blocked",
} as const;
export type GoalOutcomeKind = (typeof GOAL_OUTCOME)[keyof typeof GOAL_OUTCOME];

const GOAL_MAX_LENGTH = 240;
const GOAL_HASH_LENGTH = 12;
const GOAL_SLUG_WORDS = 5;
const GOAL_PROMPT_TAIL_LIMIT = 4_000;

export interface GoalOutcome {
  kind: GoalOutcomeKind;
  summary: string;
  reason?: string;
}

/** Normalize only the command input; the goal keeps its exact meaning after this. */
export function normalizeGoalText(goal: string): string {
  const normalized = goal.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Usage: /goal <goal>");
  if (/\p{Cc}/u.test(normalized))
    throw new Error("Goal text must not contain control characters.");
  if (Array.from(normalized).length > GOAL_MAX_LENGTH)
    throw new Error(`Goal text must be at most ${GOAL_MAX_LENGTH} characters.`);
  return normalized;
}

export function goalHash(goal: string): string {
  return createHash("sha256").update(normalizeGoalText(goal)).digest("hex").slice(0, GOAL_HASH_LENGTH);
}

export function goalBranchSlug(goal: string, token: string): string {
  const words = normalizeGoalText(goal)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .split("-")
    .filter(Boolean)
    .slice(0, GOAL_SLUG_WORDS)
    .join("-");
  return `goal-${words || "run"}-${token}`;
}

export interface GoalPromptContext {
  lastOutcome?: string | undefined;
  checkFailure?: string | undefined;
  recentCommits?: string | undefined;
}

export function goalPrompt(run: PlanExecRun, context: GoalPromptContext = {}): string {
  const goal = run.goal;
  if (!goal) throw new Error("Goal prompt requires a goal run.");
  return [
    "You are pursuing a goal autonomously in this repository. Work only from the current state; never assume a plan file or checkbox list exists.",
    `Goal: ${goal.text}`,
    `Turn: ${goal.iteration + 1}.`,
    context.lastOutcome
      ? `Previous turn outcome: ${tail(context.lastOutcome)}`
      : "Previous turn outcome: none yet; start by inspecting the repository state relevant to the goal.",
    context.checkFailure
      ? `Required checks are failing after the last turn: ${tail(context.checkFailure)}`
      : "Required checks passed after the last turn.",
    context.recentCommits
      ? `Commits made so far:\n${tail(context.recentCommits)}`
      : "No commits have been made for this goal yet.",
    "Inspect the current state, choose and execute the single most useful next action, verify what you changed, and commit your work with a clear message. Leave the worktree clean. Do not start work that belongs to a later turn.",
    "When the goal is fully achieved and verified, end your final response with this marker on its own line:",
    GOAL_DONE_MARKER,
    "If you cannot continue without an external decision, credential, or prerequisite, end with:",
    TASK_FAILED_MARKER,
    "Blocker: <exact reason>",
    "Next step: <what is needed>",
    "Otherwise end with a concise summary of what changed and what remains; the controller continues automatically.",
  ].join("\n");
}

function tail(value: string): string {
  return value.length <= GOAL_PROMPT_TAIL_LIMIT ? value : value.slice(-GOAL_PROMPT_TAIL_LIMIT);
}

/**
 * Timing values must not look like new progress between turns. Replace values
 * in place so real failure lines survive; only the volatile parts change.
 */
export function normalizeCheckOutput(output: string): string {
  return output
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/0x[0-9a-f]+/giu, "<addr>")
    .replace(/\b(duration_ms|duration|start at|elapsed|passed in|took)\b(\s*[:=]\s*|\s*)(\d\S*)/giu, "$1$2<time>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m)\b/giu, "<time>")
    .trim();
}

/** Parse the worker's final answer; markers count only as standalone lines. */
export function parseGoalOutcome(output: string | undefined): GoalOutcome {
  const text = (output ?? "").trim();
  const lines = text.split(/\r?\n/u);
  const exact = (marker: string) => lines.findIndex((line) => line.trim() === marker);
  const blockerIndex = exact(TASK_FAILED_MARKER);
  if (blockerIndex >= 0) {
    const blocker = lines.slice(blockerIndex + 1)
      .find((line) => /^Blocker:/iu.test(line.trim()))?.replace(/^Blocker:\s*/iu, "").trim();
    const next = lines.slice(blockerIndex + 1)
      .find((line) => /^Next step:/iu.test(line.trim()))?.replace(/^Next step:\s*/iu, "").trim();
    return {
      kind: GOAL_OUTCOME.BLOCKED,
      summary: lines.filter((_, index) => index !== blockerIndex).join("\n").trim(),
      reason: [blocker, next].filter(Boolean).join(" — ") || "Worker reported a blocker.",
    };
  }
  const doneIndex = exact(GOAL_DONE_MARKER);
  if (doneIndex >= 0)
    return {
      kind: GOAL_OUTCOME.DONE,
      summary: lines.filter((_, index) => index !== doneIndex).join("\n").trim() || "Worker reported the goal achieved.",
    };
  return { kind: GOAL_OUTCOME.CONTINUE, summary: text || "Worker ended without a summary." };
}
