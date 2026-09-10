import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ParsedPlan, PlanTask } from "./types.js";

const TASK_HEADING =
  /^\s{0,3}#{2,6}\s+(?:(Task|Iteration)\s+(\d+)\s*:\s*(.+?)|((?:P|T)\d+)\s*(?::|[-–—])\s*(.+?)|(Phase|Step)\s+(\d+)\s*:\s*(.+?))\s*$/i;
const CHECKBOX = /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

type TaskHeading = {
  id: number;
  title: string;
  line: number;
  style: "canonical" | "prefixed" | "named";
  sourceId: string;
};

export async function readPlan(path: string): Promise<ParsedPlan> {
  const absolutePath = resolve(path);
  const content = await readFile(absolutePath, "utf8");
  return parsePlan(absolutePath, content);
}

export function parsePlan(path: string, content: string): ParsedPlan {
  const lines = content.split(/\r?\n/);
  const ignoredLines = fencedLines(lines);
  const headings: TaskHeading[] = [];
  const sourceIds = new Set<string>();

  for (const [index, line] of lines.entries()) {
    if (ignoredLines[index]) continue;
    const heading = parseTaskHeading(line, index);
    if (!heading) continue;
    if (sourceIds.has(heading.sourceId))
      throw new Error(
        heading.style === "canonical"
          ? `Duplicate task number ${heading.id}.`
          : `Duplicate task heading ${heading.sourceId}.`,
      );
    sourceIds.add(heading.sourceId);
    headings.push(heading);
  }

  if (headings.length === 0) {
    throw new Error(
      "Plan contains no supported task sections. Use Task, Iteration, P, T, Phase, or Step headings with a number.",
    );
  }
  if (headings.every((heading) => heading.style === "canonical")) {
    for (const [index, heading] of headings.entries()) {
      if (heading.id !== index + 1) {
        throw new Error("Task numbers must be consecutive and start at 1.");
      }
    }
  }

  const tasks: PlanTask[] = headings.map((heading, index) => {
    const endLine = headings[index + 1]?.line ?? lines.length;
    const checkboxes = lines
      .slice(heading.line + 1, endLine)
      .flatMap((line, offset) => {
        if (ignoredLines[heading.line + 1 + offset]) return [];
        const match = CHECKBOX.exec(line);
        return match
          ? [{ checked: match[1]?.toLowerCase() === "x", text: match[2] ?? "" }]
          : [];
      });
    if (checkboxes.length === 0) {
      throw new Error(`Task ${index + 1} has no checkbox items.`);
    }
    return {
      id: index + 1,
      title: heading.title,
      startLine: heading.line + 1,
      endLine,
      items: checkboxes.map((box) => box.text),
      unchecked: checkboxes
        .filter((box) => !box.checked)
        .map((box) => box.text),
    };
  });

  return { path, hash: structureHash(tasks), tasks };
}

function parseTaskHeading(line: string, lineNumber: number): TaskHeading | undefined {
  const match = TASK_HEADING.exec(line);
  if (!match) return undefined;

  const canonicalKind = match[1]?.toLowerCase();
  const prefixedLabel = match[4]?.toUpperCase();
  const namedKind = match[6]?.toLowerCase();
  const rawNumber = match[2] ?? prefixedLabel?.slice(1) ?? match[7];
  const title = (match[3] ?? match[5] ?? match[8])?.trim();
  const id = Number(rawNumber);
  if (!Number.isSafeInteger(id) || id < 0 || !title)
    throw new Error(`Invalid task heading at line ${lineNumber + 1}.`);

  const style = canonicalKind
    ? "canonical"
    : prefixedLabel
      ? "prefixed"
      : "named";
  const sourceId = `${canonicalKind ?? prefixedLabel ?? namedKind}:${id}`;
  return { id, title, line: lineNumber, style, sourceId };
}

function fencedLines(lines: string[]): boolean[] {
  const ignored = lines.map(() => false);
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const [index, line] of lines.entries()) {
    if (fence) {
      ignored[index] = true;
      const closing = CLOSING_FENCE.exec(line)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length)
        fence = undefined;
      continue;
    }
    const opening = FENCE.exec(line)?.[1];
    if (!opening) continue;
    ignored[index] = true;
    fence = { marker: opening[0] as "`" | "~", length: opening.length };
  }
  return ignored;
}

function structureHash(tasks: PlanTask[]): string {
  const canonical = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    items: task.items,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
