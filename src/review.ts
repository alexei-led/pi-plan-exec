import type { ReviewFinding } from './types.js';

const FINDING = /^FINDING:[ \t]*(CRITICAL|MAJOR|MINOR)[ \t]*\|[ \t]*(.+)$/i;

export function parseReviewFindings(output: string): ReviewFinding[] {
  if (output.trim() === 'NO_FINDINGS') return [];
  if (/^[\t ]*NO_FINDINGS[\t ]*$/im.test(output))
    throw new Error('Reviewer output contradicts NO_FINDINGS.');
  const findings: ReviewFinding[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = FINDING.exec(line);
    const severity = match?.[1]?.toUpperCase();
    const summary = match?.[2]?.trim();
    if (
      summary &&
      (severity === 'CRITICAL' || severity === 'MAJOR' || severity === 'MINOR')
    ) {
      findings.push({
        id: `${severity.toLowerCase()}-${findings.length + 1}`,
        severity,
        summary,
      });
      continue;
    }
    const current = findings.at(-1);
    const evidence = /^Evidence:[ \t]*(.+)$/i.exec(line)?.[1]?.trim();
    const suggestion = /^Fix:[ \t]*(.+)$/i.exec(line)?.[1]?.trim();
    if (current && evidence && !current.evidence) current.evidence = evidence;
    else if (current && suggestion && !current.suggestion)
      current.suggestion = suggestion;
    else
      throw new Error(
        'Reviewer output contains a malformed structured FINDING.',
      );
  }
  if (findings.length === 0) {
    throw new Error(
      'Reviewer output did not contain NO_FINDINGS or a structured FINDING.',
    );
  }
  if (findings.some((finding) => !finding.evidence || !finding.suggestion))
    throw new Error(
      'Each structured FINDING requires its own Evidence and Fix.',
    );
  return findings;
}

export function hasBlockingFindings(
  findings: readonly ReviewFinding[],
): boolean {
  return findings.some(
    (finding) =>
      finding.severity === 'CRITICAL' || finding.severity === 'MAJOR',
  );
}

export function formatFindings(findings: readonly ReviewFinding[]): string {
  return findings
    .map((finding) =>
      [
        `FINDING: ${finding.severity} | ${finding.summary}`,
        ...(finding.evidence ? [`Evidence: ${finding.evidence}`] : []),
        ...(finding.suggestion ? [`Fix: ${finding.suggestion}`] : []),
      ].join('\n'),
    )
    .join('\n\n');
}
