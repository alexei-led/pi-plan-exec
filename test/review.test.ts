import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  hasBlockingFindings,
  NATIVE_REVIEW_SCHEMA,
  parseNativeReviewReport,
  parseReviewFindings,
} from '../src/review.js';

test('parses the required reviewer finding envelope', () => {
  const findings = parseReviewFindings(`
FINDING: MAJOR | Validation is skipped on empty input
Evidence: src/input.ts:17 accepts an empty string and later throws.
Fix: Reject empty input at the boundary.
`);
  assert.deepEqual(findings, [
    {
      id: 'major-1',
      severity: 'MAJOR',
      summary: 'Validation is skipped on empty input',
      evidence: 'src/input.ts:17 accepts an empty string and later throws.',
      suggestion: 'Reject empty input at the boundary.',
    },
  ]);
  assert.equal(hasBlockingFindings(findings), true);
});

test('requires NO_FINDINGS or a structured finding', () => {
  assert.deepEqual(parseReviewFindings('NO_FINDINGS'), []);
  assert.throws(() => parseReviewFindings('Looks okay.'), /structured FINDING/);
});

test('contradictory and incomplete review envelopes never mean clean', () => {
  for (const output of [
    'NO_FINDINGS\nFINDING: MAJOR | Defect\nEvidence: src/a.ts:1\nFix: repair',
    'NO_FINDINGS\nReview failed before completion',
    'FINDING: UNKNOWN | Defect',
    'FINDING: MAJOR | Defect\nFINDING: MINOR | Other\nEvidence: src/a.ts:1\nFix: repair',
    'FINDING: MAJOR | Defect\nEvidence: src/a.ts:1',
    'FINDING: MAJOR | Defect\nEvidence:\nFix: repair',
  ])
    assert.throws(() => parseReviewFindings(output));
});

test('a finding may discuss the NO_FINDINGS sentinel without claiming a clean review', () => {
  const findings = parseReviewFindings(
    'FINDING: MAJOR | Mixed NO_FINDINGS output bypasses review\nEvidence: src/review.ts accepts NO_FINDINGS mixed with defects.\nFix: Validate the whole envelope.',
  );
  assert.equal(findings.length, 1);
  assert.equal(hasBlockingFindings(findings), true);
});

const reviewedCommit = 'a'.repeat(40);
const nativeFinding = {
  severity: 'MAJOR',
  summary: 'Empty input is accepted',
  evidence: 'src/input.ts:17 accepts an empty string and throws.',
  suggestion: 'Reject empty input at the boundary.',
};

// Wire reports have no verdict; acceptance also requires independent runtime proof.
test('native reports bind clean, blocking and minor findings to the candidate commit', () => {
  for (const severity of ['CRITICAL', 'MAJOR', 'MINOR']) {
    const report = {
      schemaVersion: 1,
      reviewedCommit,
      findings: [{ ...nativeFinding, severity }],
    };
    const parsed = parseNativeReviewReport(
      JSON.stringify(report),
      reviewedCommit,
    );
    assert.deepEqual(parsed, report);
    assert.equal(hasBlockingFindings(parsed.findings), severity !== 'MINOR');
  }
  assert.deepEqual(
    parseNativeReviewReport(
      { schemaVersion: 1, reviewedCommit, findings: [] },
      reviewedCommit,
    ).findings,
    [],
  );
  const sha256 = 'b'.repeat(64);
  assert.equal(
    parseNativeReviewReport(
      { schemaVersion: 1, reviewedCommit: sha256, findings: [] },
      sha256,
    ).reviewedCommit,
    sha256,
  );
  assert.equal(NATIVE_REVIEW_SCHEMA.additionalProperties, false);
});

test('native reports reject wrong commits, malformed findings and contradictory fields', () => {
  const report = {
    schemaVersion: 1,
    reviewedCommit,
    findings: [nativeFinding],
  };
  for (const invalid of [
    { ...report, reviewedCommit: 'b'.repeat(40) },
    { ...report, reviewedCommit: 'aaaaaaa' },
    { ...report, schemaVersion: 2 },
    { ...report, verdict: 'clean' },
    { ...report, findings: undefined },
    { ...report, findings: {} },
    ...['UNKNOWN', 'major', ''].map((severity) => ({
      ...report,
      findings: [{ ...nativeFinding, severity }],
    })),
    ...['summary', 'evidence', 'suggestion'].flatMap((key) =>
      [undefined, '', ' \n ', '\u0000', 17, {}, []].map((value) => ({
        ...report,
        findings: [{ ...nativeFinding, [key]: value }],
      })),
    ),
    { ...report, findings: [{ ...nativeFinding, verdict: 'clean' }] },
    {
      ...report,
      findings: [nativeFinding, { ...nativeFinding, severity: 'MINOR' }],
    },
    { ...report, findings: [nativeFinding, nativeFinding] },
    'NO_FINDINGS',
    `Report: ${JSON.stringify(report)}`,
    JSON.stringify(report).slice(0, -1),
    { details: { runId: 'launch-receipt' }, output: JSON.stringify(report) },
  ])
    assert.throws(() => parseNativeReviewReport(invalid, reviewedCommit));
  assert.throws(() => parseNativeReviewReport(report, 'aaaaaaa'));
  assert.throws(() =>
    parseNativeReviewReport(
      { ...report, reviewedCommit: `${reviewedCommit}\n` },
      `${reviewedCommit}\n`,
    ),
  );
});

test('native reports bound findings, fields and serialized data', () => {
  const report = {
    schemaVersion: 1,
    reviewedCommit,
    findings: [nativeFinding],
  };
  for (const invalid of [
    {
      ...report,
      findings: Array.from({ length: 101 }, (_, i) => ({
        ...nativeFinding,
        summary: `Defect ${i}`,
      })),
    },
    { ...report, findings: [{ ...nativeFinding, evidence: 'x'.repeat(8193) }] },
    ' '.repeat(262145),
    {
      ...report,
      findings: Array.from({ length: 100 }, (_, i) => ({
        ...nativeFinding,
        summary: `Defect ${i}`,
        evidence: 'x'.repeat(8192),
      })),
    },
  ])
    assert.throws(() => parseNativeReviewReport(invalid, reviewedCommit));
});
