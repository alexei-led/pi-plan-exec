import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ParsedPlan, PlanTask } from "./types.js";

const TASK_HEADING = /^### (?:Task|Iteration) (\d+):\s*(.+?)\s*$/;
const CHECKBOX = /^\s*- \[([ xX])\]\s+(.+?)\s*$/;

export async function readPlan(path: string): Promise<ParsedPlan> {
  const absolutePath = resolve(path);
  const content = await readFile(absolutePath, "utf8");
  return parsePlan(absolutePath, content);
}

export function parsePlan(path: string, content: string): ParsedPlan {
  const lines = content.split(/\r?\n/);
  const headings: Array<{ id: number; title: string; line: number }> = [];
  const ids = new Set<number>();

  for (const [index, line] of lines.entries()) {
    const match = TASK_HEADING.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    const title = match[2]?.trim();
    if (!Number.isSafeInteger(id) || id < 1 || !title) {
      throw new Error(`Invalid task heading at line ${index + 1}.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate task number ${id}.`);
    ids.add(id);
    headings.push({ id, title, line: index });
  }

  if (headings.length === 0) {
    throw new Error(
      "Plan contains no '### Task N:' or '### Iteration N:' sections.",
    );
  }
  for (const [index, heading] of headings.entries()) {
    if (heading.id !== index + 1) {
      throw new Error("Task numbers must be consecutive and start at 1.");
    }
  }

  const tasks: PlanTask[] = headings.map((heading, index) => {
    const endLine = headings[index + 1]?.line ?? lines.length;
    const checkboxes = lines
      .slice(heading.line + 1, endLine)
      .flatMap((line) => {
        const match = CHECKBOX.exec(line);
        return match
          ? [{ checked: match[1]?.toLowerCase() === "x", text: match[2] ?? "" }]
          : [];
      });
    if (checkboxes.length === 0) {
      throw new Error(`Task ${heading.id} has no checkbox items.`);
    }
    return {
      id: heading.id,
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

function structureHash(tasks: PlanTask[]): string {
  const canonical = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    items: task.items,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
