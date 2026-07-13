import type { ReviewFinding } from "./types.js";

const FINDING = /^FINDING:\s*(CRITICAL|MAJOR|MINOR)\s*\|\s*(.+)$/gim;
const EVIDENCE = /^Evidence:\s*(.+)$/im;
const FIX = /^Fix:\s*(.+)$/im;

export function parseReviewFindings(output: string): ReviewFinding[] {
  if (/^\s*NO_FINDINGS\s*$/im.test(output)) return [];
  const findings: ReviewFinding[] = [];
  for (const match of output.matchAll(FINDING)) {
    const severity = match[1] as ReviewFinding["severity"] | undefined;
    const summary = match[2]?.trim();
    if (!severity || !summary) continue;
    const remaining = output.slice((match.index ?? 0) + match[0].length);
    const evidence = EVIDENCE.exec(remaining)?.[1]?.trim();
    const suggestion = FIX.exec(remaining)?.[1]?.trim();
    findings.push({
      id: `${severity.toLowerCase()}-${findings.length + 1}`,
      severity,
      summary,
      ...(evidence ? { evidence } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  if (findings.length === 0) {
    throw new Error(
      "Reviewer output did not contain NO_FINDINGS or a structured FINDING.",
    );
  }
  return findings;
}

export function hasBlockingFindings(
  findings: readonly ReviewFinding[],
): boolean {
  return findings.some(
    (finding) =>
      finding.severity === "CRITICAL" || finding.severity === "MAJOR",
  );
}

export function formatFindings(findings: readonly ReviewFinding[]): string {
  return findings
    .map((finding) =>
      [
        `FINDING: ${finding.severity} | ${finding.summary}`,
        ...(finding.evidence ? [`Evidence: ${finding.evidence}`] : []),
        ...(finding.suggestion ? [`Fix: ${finding.suggestion}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}
