/**
 * Evaluation test cases over the synthetic StudyMate demo history.
 * Grading is rule-based and deterministic:
 *   - `must`:    every pattern must appear in the answer (required facts)
 *   - `mustNot`: none may appear (wrong / outdated / hallucinated claims)
 * Ground truth comes from the demo conversations (backend/src/demo/studymate.ts).
 */
export interface TestCase {
  id: string;
  category: string;
  question: string;
  truth: string;
  must: { label: string; re: RegExp }[];
  mustNot: { label: string; re: RegExp }[];
}

export const TEST_CASES: TestCase[] = [
  {
    id: "current_db",
    category: "Current-state retrieval",
    question: "What database does the StudyMate project currently use, and why was it chosen?",
    truth: "PostgreSQL, verified in production on 20 May 2026; chosen in March for relational data requirements (replacing MongoDB).",
    must: [
      { label: "names PostgreSQL", re: /postgres/i },
      { label: "gives the relational-data reason", re: /relational/i },
    ],
    mustNot: [{ label: "claims MongoDB is current", re: /(currently|now|still)\s+(uses?|using|runs? on|stores?[^.]{0,30}in)\s+mongo/i }],
  },
  {
    id: "original_db",
    category: "Historical retrieval",
    question: "What was StudyMate's original database plan at the start of the project?",
    truth: "MongoDB (planned in January because it integrates easily with Node.js).",
    must: [{ label: "names MongoDB", re: /mongo/i }],
    mustNot: [{ label: "says PostgreSQL was the original plan", re: /original(ly)?[^.]{0,60}postgres/i }],
  },
  {
    id: "db_evolution",
    category: "Temporal correctness",
    question: "How did StudyMate's database decision evolve between January and May 2026?",
    truth: "Jan MongoDB planned → Feb PostgreSQL considered → Mar decided to migrate → Apr migration claimed implemented → May verified in production.",
    must: [
      { label: "mentions MongoDB", re: /mongo/i },
      { label: "mentions PostgreSQL", re: /postgres/i },
      { label: "distinguishes proposal/consideration", re: /(consider|propos|evaluat)/i },
      { label: "mentions the decision", re: /decid|decision/i },
      { label: "mentions verification/confirmation", re: /verif|confirm|tested/i },
    ],
    mustNot: [],
  },
  {
    id: "unverified_claims",
    category: "Implementation vs verification",
    question: "Which StudyMate implementation claims have not been verified yet?",
    truth: "Stripe payment integration (claimed implemented 14 Apr 2026, never verified).",
    must: [{ label: "names Stripe", re: /stripe/i }],
    mustNot: [{ label: "says PostgreSQL is unverified", re: /postgres\w*[^.]{0,40}(not (been )?verified|unverified)/i }],
  },
  {
    id: "not_implemented",
    category: "Decision vs implementation",
    question: "Which StudyMate decisions have been made but not implemented yet?",
    truth: "Moving hosting from Heroku to Render (decided 18 Mar 2026, no implementation claim).",
    must: [{ label: "names Render", re: /render/i }],
    mustNot: [{ label: "says Render is already deployed", re: /(deployed|running|hosted)\s+on\s+render/i }],
  },
  {
    id: "rejected",
    category: "Rejected decisions",
    question: "Which technology options did the StudyMate team reject, and why?",
    truth: "Redis (caching) — rejected because traffic is low and it adds operational overhead.",
    must: [
      { label: "names Redis", re: /redis/i },
      { label: "gives the reason", re: /traffic|overhead/i },
    ],
    mustNot: [],
  },
  {
    id: "open_commitments",
    category: "Commitments",
    question: "Which StudyMate commitments are still open or overdue?",
    truth: "Add payment failure alerts (Ravi, due 15 Jun 2026, overdue). Runbook is done; doc portal was cancelled.",
    must: [{ label: "names payment failure alerts", re: /payment failure alert/i }],
    mustNot: [
      { label: "lists the finished runbook as open", re: /runbook[^.]{0,50}(open|pending|overdue|not (yet )?(done|finished|complete))/i },
      { label: "lists the cancelled doc portal as open", re: /documentation portal[^.]{0,50}(open|pending|overdue|in progress)/i },
    ],
  },
  {
    id: "contradiction_trap",
    category: "Conflict detection",
    question: "Does StudyMate still use MongoDB?",
    truth: "No: PostgreSQL is verified. A June statement claims MongoDB is still used; it contradicts the verified state and is flagged for review.",
    must: [{ label: "points to PostgreSQL", re: /postgres/i }],
    mustNot: [{ label: "answers yes", re: /^\W*(yes|yeah|yep)\b/i }],
  },
  {
    id: "hosting_now",
    category: "Supersession",
    question: "Where is the StudyMate backend hosted, according to the latest decision?",
    truth: "Render was decided (18 Mar 2026) replacing Heroku; the move has not been confirmed as implemented.",
    must: [{ label: "names Render", re: /render/i }],
    mustNot: [{ label: "says Heroku is the current host", re: /(currently|now|still)[^.]{0,30}heroku/i }],
  },
  {
    id: "evidence",
    category: "Evidence attribution",
    question: "What evidence shows that StudyMate's PostgreSQL migration actually works?",
    truth: "20 May 2026 production readiness review: 'We tested the application and confirmed that PostgreSQL is running successfully in production.'",
    must: [
      { label: "cites the production test/confirmation", re: /(tested|confirm|running successfully|production)/i },
      { label: "dates it (May 2026)", re: /may|2026-05|05\/2026/i },
    ],
    mustNot: [],
  },
];
