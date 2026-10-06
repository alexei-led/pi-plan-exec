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
  findings: readonly Pick<ReviewFinding, 'severity'>[],
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

export interface NativeReviewFinding {
  severity: ReviewFinding['severity'];
  summary: string;
  evidence: string;
  suggestion: string;
}

export interface NativeReviewReport {
  schemaVersion: 1;
  reviewedCommit: string;
  findings: NativeReviewFinding[];
}

const MAX_REVIEW_BYTES = 256 * 1024;
const MAX_FINDINGS = 100;
const MAX_FIELD_LENGTH = 8192;
const COMMIT_PATTERN = '^(?:[0-9a-f]{40}|[0-9a-f]{64})$';
const reviewTextSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_FIELD_LENGTH,
};

/** Wire contract only: an empty findings array is not proof of successful review. */
export const NATIVE_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'reviewedCommit', 'findings'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    reviewedCommit: { type: 'string', pattern: COMMIT_PATTERN },
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary', 'evidence', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR'] },
          summary: reviewTextSchema,
          evidence: reviewTextSchema,
          suggestion: reviewTextSchema,
        },
      },
    },
  },
} as const;

/** Parses only a complete JSON report, never a receipt, prose or legacy sentinel. */
export function parseNativeReviewReport(
  value: unknown,
  expectedCommit: string,
): NativeReviewReport {
  if (
    (expectedCommit.length !== 40 && expectedCommit.length !== 64) ||
    !new RegExp(COMMIT_PATTERN).test(expectedCommit)
  )
    throw new Error('Native review requires an exact candidate commit.');
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_REVIEW_BYTES)
      throw new Error('Native review report exceeds the size limit.');
    value = JSON.parse(value);
  }
  if (
    !hasExactFields(value, ['schemaVersion', 'reviewedCommit', 'findings']) ||
    value.schemaVersion !== 1 ||
    value.reviewedCommit !== expectedCommit ||
    !Array.isArray(value.findings) ||
    value.findings.length > MAX_FINDINGS
  )
    throw new Error(
      'Native review report has malformed fields or a mismatched commit.',
    );
  const seen = new Set<string>();
  const findings: NativeReviewFinding[] = [];
  for (const finding of value.findings) {
    if (
      !hasExactFields(finding, [
        'severity',
        'summary',
        'evidence',
        'suggestion',
      ]) ||
      (finding.severity !== 'CRITICAL' &&
        finding.severity !== 'MAJOR' &&
        finding.severity !== 'MINOR') ||
      !validReviewText(finding.summary) ||
      !validReviewText(finding.evidence) ||
      !validReviewText(finding.suggestion)
    )
      throw new Error(
        'Native review finding requires valid severity, summary, evidence and suggestion.',
      );
    const identity = JSON.stringify([
      finding.summary.trim(),
      finding.evidence.trim(),
    ]);
    if (seen.has(identity))
      throw new Error(
        'Native review contains duplicate or contradictory findings.',
      );
    seen.add(identity);
    findings.push({
      severity: finding.severity,
      summary: finding.summary,
      evidence: finding.evidence,
      suggestion: finding.suggestion,
    });
  }
  const report: NativeReviewReport = {
    schemaVersion: 1,
    reviewedCommit: expectedCommit,
    findings,
  };
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_REVIEW_BYTES)
    throw new Error('Native review report exceeds the size limit.');
  return report;
}

function hasExactFields(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validReviewText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_FIELD_LENGTH &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return (
        code !== 127 && (code >= 32 || code === 9 || code === 10 || code === 13)
      );
    })
  );
}
