import type { TestCase } from "./test-cases.js";

export interface Grade {
  pass: boolean;
  requiredHit: number;
  requiredTotal: number;
  recall: number;
  missing: string[];
  violations: string[];
}

/**
 * Normalise model output before matching, so formatting never decides a grade:
 * strip Markdown emphasis/code/table markup, unify Unicode hyphens/dashes/quotes,
 * treat hyphens as spaces, collapse whitespace.
 */
export function normalize(answer: string): string {
  return answer
    .replace(/[*_`#>|]/g, " ")
    .replace(/[‐-―−­]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\w)-(\w)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deterministic rule-based grading (no LLM judge). */
export function grade(tc: TestCase, answer: string): Grade {
  const text = normalize(answer);
  // Quoted text is cited evidence, not an assertion: a correct answer may quote a
  // flagged claim ("…still stores user data in MongoDB.") precisely to warn about it.
  // Applied identically to every phase.
  const asserted = text.replace(/"[^"]{0,400}"/g, " ");
  const missing = tc.must.filter((m) => !m.re.test(text)).map((m) => m.label);
  const violations = tc.mustNot.filter((m) => m.re.test(asserted)).map((m) => m.label);
  const hit = tc.must.length - missing.length;
  return {
    pass: text.length > 0 && missing.length === 0 && violations.length === 0,
    requiredHit: hit,
    requiredTotal: tc.must.length,
    recall: tc.must.length ? hit / tc.must.length : 1,
    missing,
    violations,
  };
}
