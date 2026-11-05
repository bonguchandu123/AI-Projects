# ContextOS × Odysseus — evaluation report

Generated 2026-11-05T21:14:39.154Z. Synthetic StudyMate demo history. Grading: deterministic rules (evaluation/test-cases.ts).
Tokens: Odysseus's own measurements (Groq usage per agent round), cross-checked with Odysseus per-session counters.

| Metric | A. Odysseus alone (native memory, chat mode) | C. ContextOS direct (deterministic, no LLM for state) |
|---|---|---|
| Model | openai/gpt-oss-120b | none (deterministic) |
| Correct answers | 6/10 (60%) | 10/10 (100%) |
| Required-fact recall | 68% | 100% |
| Wrong/outdated claims | 1 (in 1 answers) | 0 (in 0 answers) |
| Input tokens (total) | 6,263 | 0 |
| Output tokens (total) | 3,830 | 0 |
| Avg tokens / question | 1,009 | 0 |
| Tokens / correct answer | 1,682 | 0 |
| Avg latency | 3.2 s | 1.7 s |
| Avg tool calls | 0 | 0 |
| ContextOS tool used | 0% | 0% |
| Errors | 0 | 0 |

## A. Odysseus alone (native memory, chat mode)

- Loaded 17 StudyMate statements into Odysseus native memory (vector index: true), labelled source=contextos_eval.
- Odysseus native memory injection ON, chat mode (its memory path). ContextOS MCP not registered/disabled.

| Case | Result | Missing | Wrong claims | Tokens in/out | Tools | Answer (excerpt) |
|---|---|---|---|---|---|---|
| current_db | ❌ | names PostgreSQL; gives the relational-data reason | claims MongoDB is current | 631/305 | — | The StudyMate project is still using **MongoDB** for its data storage. It was originally selected because **MongoDB integrates very easily with a Node.js backen |
| original_db | ✅ | — | — | 618/200 | — | StudyMate was originally planned to use MongoDB as its database. |
| db_evolution | ❌ | distinguishes proposal/consideration | — | 614/670 | — | Between the start of 2026 and May 2026, StudyMate’s approach to its primary data store shifted from continuing to rely on MongoDB to fully migrating to PostgreS |
| unverified_claims | ✅ | — | — | 616/523 | — | Based on the saved memory entries, the following StudyMate implementation claims have **not** been confirmed as verified: \| Claim \| Why it’s still unverified  |
| not_implemented | ❌ | names Render | — | 612/490 | — | Based on the saved memory you provided, every decision that’s been recorded has already been acted on (or is a final rejection/cancellation): - **Stripe payment |
| rejected | ✅ | — | — | 616/302 | — | The StudyMate team rejected **Redis** as a technology choice. They decided against it because their traffic levels are low, and adding Redis would introduce unn |
| open_commitments | ✅ | — | — | 608/510 | — | Based on the stored notes, the only outstanding / overdue commitment is: \| Commitment \| Owner \| Due date \| Status as of Nov 5 2026 \| \|------------\|------ |
| contradiction_trap | ✅ | — | — | 634/204 | — | No—StudyMate has migrated from MongoDB to PostgreSQL. The migration decision was made in March 2026, and by May 2026 PostgreSQL was confirmed running successful |
| hosting_now | ❌ | names Render | — | 689/144 | — | I’m not aware of the latest decision about where the StudyMate backend is hosted. Could you provide the relevant details or point me to the source where that de |
| evidence | ✅ | — | — | 625/482 | — | The records from StudyMate’s internal notes provide several concrete points that demonstrate the PostgreSQL migration is functional: 1. **Implementation Complet |

## C. ContextOS direct (deterministic, no LLM for state)

- Answers composed from the lifecycle projection; 0 LLM tokens to answer (Gemini was used earlier, once, for extraction).

| Case | Result | Missing | Wrong claims | Tokens in/out | Tools | Answer (excerpt) |
|---|---|---|---|---|---|---|
| current_db | ✅ | — | — | 0/0 | — | StudyMate currently uses PostgreSQL as its primary database — VERIFIED on 20 May 2026 [E1]. Reason: on 3 Mar 2026 the team decided to migrate from MongoDB to Po |
| original_db | ✅ | — | — | 0/0 | — | Originally (12 Jan 2026), MongoDB was proposed for primary database [E1]. [E1] 2026-01-12 "Initially, we are planning to use MongoDB because it is easy to integ |
| db_evolution | ✅ | — | — | 0/0 | — | 6 lifecycle changes between 1 Jan 2026 and 31 Dec 2026: 12 Jan 2026 MongoDB proposed; 9 Feb 2026 PostgreSQL proposed; 3 Mar 2026 PostgreSQL decided; 3 Mar 2026  |
| unverified_claims | ✅ | — | — | 0/0 | — | 1 implementation claim(s) have no verification evidence: Stripe (claimed 14 Apr 2026). Stripe (Payments provider) — it supports student discounts |
| not_implemented | ✅ | — | — | 0/0 | — | 1 decision(s) are not implemented yet: Render. Render (Hosting platform) — Render's pricing is predictable for our usage. |
| rejected | ✅ | — | — | 0/0 | — | StudyMate currently uses PostgreSQL as its primary database — VERIFIED on 20 May 2026 [E1]. Reason: on 3 Mar 2026 the team decided to migrate from MongoDB to Po |
| open_commitments | ✅ | — | — | 0/0 | — | StudyMate currently uses PostgreSQL as its primary database — VERIFIED on 20 May 2026 [E1]. Reason: on 3 Mar 2026 the team decided to migrate from MongoDB to Po |
| contradiction_trap | ✅ | — | — | 0/0 | — | StudyMate currently uses PostgreSQL as its primary database — VERIFIED on 20 May 2026 [E1]. Reason: on 3 Mar 2026 the team decided to migrate from MongoDB to Po |
| hosting_now | ✅ | — | — | 0/0 | — | Render was decided for hosting platform on 18 Mar 2026 but has not been implemented yet [E1]. Historical: Heroku (superseded 18 Mar 2026). [E1] 2026-03-18 "We a |
| evidence | ✅ | — | — | 0/0 | — | StudyMate currently uses PostgreSQL as its primary database — VERIFIED on 20 May 2026 [E1]. Reason: on 3 Mar 2026 the team decided to migrate from MongoDB to Po |
