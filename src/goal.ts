import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parsePlan } from "./plan.js";
import type { ParsedPlan } from "./types.js";

const GOAL_MAX_LENGTH = 240;
const GOAL_PLAN_MAX_LENGTH = 48_000;
const GOAL_ID_HASH_LENGTH = 12;
const GOAL_PLANS_DIRECTORY = join("docs", "plans");
const GOAL_FILE_PREFIX = "goal-";
const GOAL_FILE_MODE = 0o644;

export interface GoalPlanMetadata {
  goalId: string;
  goalHash: string;
  planHash: string;
  documentHash: string;
}

export interface ReadyGoalPlan extends GoalPlanMetadata {
  path: string;
  state: "ready";
  reused: boolean;
}

export interface PendingGoalPlan {
  goal: string;
  goalId: string;
  goalHash: string;
  path: string;
  state: "preparing";
}

export type GoalPreparation = ReadyGoalPlan | PendingGoalPlan;

/** Normalize only the command input; the researched plan itself is preserved. */
export function normalizeGoal(goal: string): string {
  const normalized = goal.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Usage: /goal <short goal>");
  if (/\p{Cc}/u.test(normalized))
    throw new Error("Goal text must not contain control characters.");
  if (Array.from(normalized).length > GOAL_MAX_LENGTH)
    throw new Error(`Goal text must be at most ${GOAL_MAX_LENGTH} characters.`);
  return normalized;
}

/**
 * Preparation never writes a draft. It either reuses a semantically bound,
 * intact ready plan or returns the durable identity for a read-only Pi turn.
 */
export async function beginGoalPreparation(options: {
  repositoryRoot: string;
  goal: string;
}): Promise<GoalPreparation> {
  const goal = normalizeGoal(options.goal);
  const goalHash = hash(goal);
  const goalId = `${GOAL_FILE_PREFIX}${goalHash.slice(0, GOAL_ID_HASH_LENGTH)}`;
  const path = resolve(
    options.repositoryRoot,
    GOAL_PLANS_DIRECTORY,
    `${goalId}.md`,
  );
  try {
    const content = await readFile(path, "utf8");
    const { metadata } = validateGoalPlan(path, content, goal);
    return { ...metadata, path, state: "ready", reused: true };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT"))
      return { goal, goalId, goalHash, path, state: "preparing" };
    if (isGoalPlanValidationError(error)) throw editedGoalPlanError(path);
    throw error;
  }
}

/**
 * The extension-owned finalizer is the only writer. It accepts researched
 * Markdown, adds immutable metadata, validates with the executable-plan parser,
 * and atomically publishes a complete file without replacing an existing one.
 */
export async function finalizeGoalPlan(options: {
  repositoryRoot: string;
  goal: string;
  markdown: string;
}): Promise<ReadyGoalPlan> {
  const goal = normalizeGoal(options.goal);
  const goalHash = hash(goal);
  const goalId = `${GOAL_FILE_PREFIX}${goalHash.slice(0, GOAL_ID_HASH_LENGTH)}`;
  const path = resolve(
    options.repositoryRoot,
    GOAL_PLANS_DIRECTORY,
    `${goalId}.md`,
  );
  const content = renderGoalPlan(goal, options.markdown);
  const published = await publishNewFile(path, content);
  if (!published) {
    const existing = await readFile(path, "utf8");
    const { metadata } = validateGoalPlan(path, existing, goal);
    return { ...metadata, path, state: "ready", reused: true };
  }
  const { metadata } = validateGoalPlan(path, content, goal);
  return { ...metadata, path, state: "ready", reused: false };
}

/** Build a ready document from a repository-grounded Markdown plan. */
export function renderGoalPlan(goal: string, markdown: string): string {
  const normalizedGoal = normalizeGoal(goal);
  const body = normalizePlanMarkdown(markdown);
  const plan = validatePlanBody("goal.md", body, normalizedGoal);
  const goalHash = hash(normalizedGoal);
  const goalId = `${GOAL_FILE_PREFIX}${goalHash.slice(0, GOAL_ID_HASH_LENGTH)}`;
  const metadataWithoutDocumentHash = {
    goalId,
    goalHash,
    planHash: plan.hash,
  };
  const documentHash = hash(documentHashInput(metadataWithoutDocumentHash, body));
  return [
    "---",
    `goal_id: ${goalId}`,
    `goal_hash: ${goalHash}`,
    "preparation_status: ready",
    `plan_hash: ${plan.hash}`,
    `document_hash: ${documentHash}`,
    "---",
    "",
    body,
  ].join("\n");
}

/**
 * A ready plan must still satisfy the executable parser, bind its stated goal
 * to its ID/hash, cite the inspected repository, and retain its exact document
 * digest. Any mismatch is an edited or incomplete file, never a retry target.
 */
export function validateGoalPlan(
  path: string,
  content: string,
  goal: string,
): { metadata: GoalPlanMetadata; plan: ParsedPlan } {
  const { metadata, body } = parseGoalDocument(content);
  const normalizedGoal = normalizeGoal(goal);
  const expectedGoalHash = hash(normalizedGoal);
  const expectedGoalId = `${GOAL_FILE_PREFIX}${expectedGoalHash.slice(0, GOAL_ID_HASH_LENGTH)}`;
  if (
    metadata.goalHash !== expectedGoalHash ||
    metadata.goalId !== expectedGoalId ||
    metadata.documentHash !==
      hash(
        documentHashInput(
          {
            goalId: metadata.goalId,
            goalHash: metadata.goalHash,
            planHash: metadata.planHash,
          },
          body,
        ),
      )
  )
    throw new GoalPlanValidationError("Goal plan metadata is not bound to its content.");
  const plan = validatePlanBody(path, body, normalizedGoal);
  if (plan.hash !== metadata.planHash)
    throw new GoalPlanValidationError(
      "Goal plan plan_hash does not match its Markdown structure.",
    );
  return { metadata, plan };
}

export function goalPreparationMessage(
  prepared: ReadyGoalPlan,
  displayPath: string,
): string {
  return [
    `${prepared.reused ? "Reused" : "Prepared"} goal plan: ${displayPath}`,
    `goal_id: ${prepared.goalId}`,
    `goal_hash: ${prepared.goalHash}`,
    `plan_hash: ${prepared.planHash}`,
    `Next action: /exec ${displayPath}`,
  ].join("\n");
}

/** Atomically create a complete file; `link` refuses to replace an existing path. */
export async function publishNewFile(path: string, content: string): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", GOAL_FILE_MODE);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
      await syncDirectory(directory);
      return true;
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function normalizePlanMarkdown(markdown: string): string {
  const body = markdown.trim().replace(/\r\n/gu, "\n");
  if (!body) throw new GoalPlanValidationError("Goal plan Markdown is empty.");
  if (Buffer.byteLength(body, "utf8") > GOAL_PLAN_MAX_LENGTH)
    throw new GoalPlanValidationError(
      `Goal plan Markdown must be at most ${GOAL_PLAN_MAX_LENGTH} bytes.`,
    );
  if (body.startsWith("---\n"))
    throw new GoalPlanValidationError(
      "Goal finalization owns the frontmatter; submit Markdown without it.",
    );
  return body;
}

function validatePlanBody(path: string, body: string, goal: string): ParsedPlan {
  if (!body.includes(`Goal: ${goal}`))
    throw new GoalPlanValidationError("Goal plan must state the exact requested Goal.");
  const evidenceHeading = /^## Repository evidence\s*$/mu.exec(body);
  const taskStart = body.search(/^### (?:Task|Iteration) /mu);
  const evidence =
    evidenceHeading && taskStart >= 0
      ? body.slice(evidenceHeading.index + evidenceHeading[0].length, taskStart)
      : undefined;
  if (!evidence || !/^\s*- .*`[^`]+`/mu.test(evidence))
    throw new GoalPlanValidationError(
      "Goal plan must cite inspected repository paths under ## Repository evidence.",
    );
  let plan: ParsedPlan;
  try {
    plan = parsePlan(path, body);
  } catch (error: unknown) {
    throw asGoalPlanValidationError(error);
  }
  if (plan.tasks.length < 2)
    throw new GoalPlanValidationError(
      "Goal plan must contain at least two repository-grounded tasks.",
    );
  return plan;
}

function parseGoalDocument(content: string): {
  metadata: GoalPlanMetadata;
  body: string;
} {
  const match = /^---\n(?:goal_id: (goal-[0-9a-f]{12})\n)(?:goal_hash: ([0-9a-f]{64})\n)(?:preparation_status: ready\n)(?:plan_hash: ([0-9a-f]{64})\n)(?:document_hash: ([0-9a-f]{64})\n)---\n\n([\s\S]*)$/u.exec(
    content,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || match[5] === undefined)
    throw new GoalPlanValidationError("Goal plan metadata is malformed or not ready.");
  return {
    metadata: {
      goalId: match[1],
      goalHash: match[2],
      planHash: match[3],
      documentHash: match[4],
    },
    body: match[5],
  };
}

function documentHashInput(
  metadata: Pick<GoalPlanMetadata, "goalId" | "goalHash" | "planHash">,
  body: string,
): string {
  return [
    "goal_id: " + metadata.goalId,
    "goal_hash: " + metadata.goalHash,
    "preparation_status: ready",
    "plan_hash: " + metadata.planHash,
    "",
    body,
  ].join("\n");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function editedGoalPlanError(path: string): Error {
  return new Error(
    `Refusing to overwrite user-edited or incomplete goal plan: ${path}. Review the file and start it explicitly when ready.`,
  );
}

class GoalPlanValidationError extends Error {}

function asGoalPlanValidationError(error: unknown): GoalPlanValidationError {
  return error instanceof GoalPlanValidationError
    ? error
    : new GoalPlanValidationError(error instanceof Error ? error.message : String(error));
}

function isGoalPlanValidationError(error: unknown): error is GoalPlanValidationError {
  return error instanceof GoalPlanValidationError;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
