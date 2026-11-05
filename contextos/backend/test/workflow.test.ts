import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../src/db/migrate.js";
import type { ServiceContext } from "../src/services/context.js";
import { importDemo } from "../src/services/demo.js";
import { createConversation, processConversation } from "../src/services/ingest.js";
import { rebuildProjection } from "../src/services/projection.js";
import { answerQuestion } from "../src/services/query.js";
import {
  getCurrentState, getDecision, getGraph, getOverview, getTimeline, listDecisions, listReviews, searchMemories,
} from "../src/services/read.js";
import { createTempDb, type TempDb } from "./helpers/temp-db.js";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("end-to-end StudyMate workflow (real Postgres, fallback extractor)", () => {
  let db: TempDb;
  let ctx: ServiceContext;
  let projectId: string;

  beforeAll(async () => {
    db = await createTempDb();
    await migrateUp(db.pool);
    ctx = { pool: db.pool, gemini: null, log: silent };
    const res = await importDemo(ctx);
    projectId = res.projectId;
    expect(res.results).toHaveLength(7);
    for (const r of res.results) {
      expect(r.method).toBe("fallback"); // never claims Gemini without a key
      expect(r.unverifiedExcerpts).toBe(0);
    }
  });
  afterAll(async () => {
    await db.drop();
  });

  const byOption = async (option: string) => (await listDecisions(db.pool, { projectId })).find((d) => d.option === option)!;

  it("derives the expected lifecycle state for every option", async () => {
    expect(await byOption("PostgreSQL")).toMatchObject({ commitmentStatus: "DECIDED", implementationStatus: "VERIFIED", reason: "relational data requirements", disputed: true });
    expect(await byOption("MongoDB")).toMatchObject({ commitmentStatus: "SUPERSEDED", implementationStatus: "NOT_STARTED" });
    expect((await byOption("MongoDB")).supersededBy?.option).toBe("PostgreSQL");
    expect(await byOption("Redis")).toMatchObject({ commitmentStatus: "REJECTED" });
    expect(await byOption("Heroku")).toMatchObject({ commitmentStatus: "SUPERSEDED" });
    expect(await byOption("Render")).toMatchObject({ commitmentStatus: "DECIDED", implementationStatus: "NOT_STARTED" });
    expect(await byOption("Stripe")).toMatchObject({ commitmentStatus: "DECIDED", implementationStatus: "CLAIMED_IMPLEMENTED" });
  });

  it("current state: PostgreSQL verified, MongoDB historical, the contradiction held for review", async () => {
    const state = await getCurrentState(db.pool, projectId);
    const database = state.subjects.find((s) => s.subjectKey === "database")!;
    expect(database.status).toBe("DISPUTED");
    expect(database.current.map((c) => c.decision.option)).toEqual(["PostgreSQL"]);
    expect(database.previous.map((c) => c.decision.option)).toEqual(["MongoDB"]);
    expect(database.openConflicts).toHaveLength(1);
    expect(database.openConflicts[0]!.evidence.excerpt).toBe("StudyMate still stores user data in MongoDB.");
    const pg = database.current[0]!;
    expect(pg.evidence.decided?.conversationTitle).toBe("Database decision meeting");
    expect(pg.evidence.verified?.conversationTitle).toBe("Production readiness review");

    expect(state.subjects.find((s) => s.subjectKey === "payments")!.status).toBe("UNVERIFIED");
    const commitments = Object.fromEntries(state.commitments.map((c) => [c.title, c.status]));
    expect(commitments).toMatchObject({
      "Build the public API documentation portal": "CANCELLED",
      "Write the data migration runbook": "DONE",
      "Add payment failure alerts": "OPEN",
    });
  });

  it("answers 'What database does StudyMate currently use and why?' with evidence", async () => {
    const a = await answerQuestion(db.pool, null, "What database does StudyMate currently use and why?");
    expect(a.interpretation).toMatchObject({ projectName: "StudyMate", subjects: ["database"] });
    expect(a.directAnswer).toMatch(/StudyMate currently uses PostgreSQL as its primary database — VERIFIED on 20 May 2026/);
    expect(a.directAnswer).toMatch(/decided to migrate from MongoDB to PostgreSQL — stated reason: "relational data requirements"/);
    expect(a.directAnswer).toMatch(/Historical: MongoDB \(superseded 3 Mar 2026\)/);
    expect(a.reviewNotes[0]).toMatch(/held for human review/);
    expect(a.history.filter((h) => h.applied && h.option !== null).map((h) => `${h.date.slice(0, 7)} ${h.option} ${h.type}`)).toEqual([
      "2026-01 MongoDB PROPOSED",
      "2026-02 PostgreSQL PROPOSED",
      "2026-03 PostgreSQL DECIDED",
      "2026-03 MongoDB SUPERSEDED",
      "2026-04 PostgreSQL IMPLEMENTATION_CLAIMED",
      "2026-05 PostgreSQL VERIFIED",
    ]);
    // Every cited evidence id resolves to a stored excerpt from a demo conversation.
    const refs = a.directAnswer.match(/\[E\d+\]/g)!.map((r) => r.slice(1, -1));
    for (const ref of refs) {
      const ev = a.evidence.find((e) => e.ref === ref)!;
      expect(ev.isDemo).toBe(true);
      expect(ev.excerptVerified).toBe(true);
    }
    expect(a.narrative).toBeNull();
    expect(a.generatedBy).toBe("deterministic (structured state)");
  });

  it("answers list questions: unverified claims, rejected, pending, commitments, conflicts", async () => {
    const unverified = await answerQuestion(db.pool, null, "Which implementation claims are unverified?", projectId);
    expect(unverified.directAnswer).toMatch(/Stripe/);
    const rejected = await answerQuestion(db.pool, null, "What decisions were rejected?", projectId);
    expect(rejected.directAnswer).toMatch(/Redis \(because our traffic is low and it adds operational overhead\)/);
    const pending = await answerQuestion(db.pool, null, "Which decisions have not been implemented?", projectId);
    expect(pending.directAnswer).toMatch(/Render/);
    const commitments = await answerQuestion(db.pool, null, "Which project commitments are overdue or unresolved?", projectId);
    expect(commitments.directAnswer).toMatch(/Add payment failure alerts \(overdue since 15 Jun 2026\)/);
    const conflicts = await answerQuestion(db.pool, null, "Are there contradictory statements?", projectId);
    expect(conflicts.sections.find((s) => s.title.startsWith("Contradictions"))!.items).toHaveLength(1);
    const original = await answerQuestion(db.pool, null, "What was the original database decision?", projectId);
    expect(original.directAnswer).toMatch(/^Originally \(12 Jan 2026\), MongoDB was proposed/);
    const changes = await answerQuestion(db.pool, null, "What changed between January and May?", projectId);
    expect(changes.directAnswer).toMatch(/lifecycle changes between 1 Jan 2026 and 31 May 2026/);
  });

  it("decision detail exposes history and evidence back to the source conversation", async () => {
    const d = await getDecision(db.pool, (await byOption("PostgreSQL")).id);
    expect(d.history.map((h) => h.type)).toEqual(["PROPOSED", "DECIDED", "IMPLEMENTATION_CLAIMED", "VERIFIED"]);
    expect(d.evidence.map((e) => e.conversationTitle)).toEqual([
      "Data model review", "Database decision meeting", "Sprint 8 status", "Production readiness review",
    ]);
  });

  it("resolving the conflict review is applied deterministically and survives rebuilds", async () => {
    const [conflict] = await listReviews(db.pool, { projectId, status: "open" }).then((r) => r.filter((x) => x.kind === "conflict"));
    await db.pool.query("UPDATE review_items SET status = 'dismissed', resolved_at = now() WHERE id = $1", [conflict!.id]);
    await rebuildProjection(db.pool, projectId);
    expect(await byOption("PostgreSQL")).toMatchObject({ implementationStatus: "VERIFIED", disputed: false });
    const state = await getCurrentState(db.pool, projectId);
    expect(state.subjects.find((s) => s.subjectKey === "database")!.status).toBe("VERIFIED");
    await rebuildProjection(db.pool, projectId); // idempotent
    expect((await listReviews(db.pool, { projectId })).find((r) => r.id === conflict!.id)?.status).toBe("dismissed");
  });

  it("decision ids are stable across rebuilds", async () => {
    const before = (await byOption("PostgreSQL")).id;
    await rebuildProjection(db.pool, projectId);
    expect((await byOption("PostgreSQL")).id).toBe(before);
  });

  it("a late-arriving older conversation is replayed in event-time order", async () => {
    const p = await db.pool.query<{ id: string }>("INSERT INTO projects (name) VALUES ('Late Order') RETURNING id");
    const pid = p.rows[0]!.id;
    const later = await createConversation(db.pool, { projectId: pid, title: "Verified", occurredAt: new Date("2026-05-01"), source: "manual", text: "A: We confirmed that MySQL is running successfully in production." });
    const earlier = await createConversation(db.pool, { projectId: pid, title: "Decided", occurredAt: new Date("2026-03-01"), source: "manual", text: "A: We decided to use MySQL because the team knows it." });
    await processConversation(ctx, later);
    await processConversation(ctx, earlier);
    const d = (await listDecisions(db.pool, { projectId: pid }))[0]!;
    expect(d).toMatchObject({ option: "MySQL", commitmentStatus: "DECIDED", implementationStatus: "VERIFIED" });
    expect((await getDecision(db.pool, d.id)).history.map((h) => h.type)).toEqual(["DECIDED", "VERIFIED"]);
  });

  it("timeline, graph, overview and search return real records", async () => {
    const tl = await getTimeline(db.pool, { projectId });
    expect(tl.length).toBeGreaterThan(10);
    expect(tl.every((e) => e.evidence.conversationId)).toBe(true);
    const g = await getGraph(db.pool, projectId);
    expect(g.nodes.filter((n) => n.type === "decision").map((n) => n.label).sort()).toEqual(["Heroku", "MongoDB", "PostgreSQL", "Redis", "Render", "Stripe"]);
    expect(g.edges.some((e) => e.kind === "supersedes")).toBe(true);
    for (const e of g.edges) {
      expect(g.nodes.some((n) => n.id === e.source)).toBe(true);
      expect(g.nodes.some((n) => n.id === e.target)).toBe(true);
    }
    const o = await getOverview(db.pool);
    expect(o.stats).toMatchObject({ projects: 2, verified: 2, unverifiedClaims: 1 });
    expect(o.recentActivity.length).toBeGreaterThan(0);
    const s = await searchMemories(db.pool, null, "relational data", { projectId });
    expect(s.hits[0]?.evidence.excerpt).toMatch(/relational data/);
  });
});
