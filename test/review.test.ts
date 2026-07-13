import assert from "node:assert/strict";
import test from "node:test";
import { hasBlockingFindings, parseReviewFindings } from "../src/review.js";

test("parses the required reviewer finding envelope", () => {
  const findings = parseReviewFindings(`
FINDING: MAJOR | Validation is skipped on empty input
Evidence: src/input.ts:17 accepts an empty string and later throws.
Fix: Reject empty input at the boundary.
`);
  assert.deepEqual(findings, [
    {
      id: "major-1",
      severity: "MAJOR",
      summary: "Validation is skipped on empty input",
      evidence: "src/input.ts:17 accepts an empty string and later throws.",
      suggestion: "Reject empty input at the boundary.",
    },
  ]);
  assert.equal(hasBlockingFindings(findings), true);
});

test("requires NO_FINDINGS or a structured finding", () => {
  assert.deepEqual(parseReviewFindings("NO_FINDINGS"), []);
  assert.throws(() => parseReviewFindings("Looks okay."), /structured FINDING/);
});
