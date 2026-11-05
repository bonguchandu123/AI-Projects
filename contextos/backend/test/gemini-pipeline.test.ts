/**
 * Tests the Gemini *pipeline safeguards* with a STUB client (no network, no API key).
 * This does not test Gemini's own extraction quality — that needs a real key.
 * It proves: invalid model output is rejected by Zod; fabricated excerpts are caught
 * and held for review; Gemini failures fall back to the labelled extractor; the
 * stored method/model labels never claim Gemini processed something it did not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GeminiClient } from "../src/ai/gemini.js";
import { migrateUp } from "../src/db/migrate.js";
import { extractionResultSchema, type ExtractionResult } from "../src/domain/types.js";
import type { ServiceContext } from "../src/services/context.js";
import { createConversation, processConversation } from "../src/services/ingest.js";
import { listDecisions, listReviews } from "../src/services/read.js";
import { createTempDb, type TempDb } from "./helpers/temp-db.js";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function stub(extract: GeminiClient["extract"]): GeminiClient {
  return {
    model: "stub-model",
    embeddingModel: "stub-embed",
    extract,
    embed: async (texts) => texts.map(() => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))),
    narrate: async () => null,
  };
}

const item = (over: Partial<ExtractionResult["items"][number]>): ExtractionResult["items"][number] => ({
  kind: "decision", summary: "PostgreSQL decided", excerpt: "We decided to use PostgreSQL", message_index: 0,
  subject_key: "database", subject_label: "Primary database", option: "PostgreSQL", previous_option: null,
  replaces_previous: false, reason: "relational data", commitment_title: null, commitment_owner: null, commitment_due: null,
  speaker_role: "user", hedged: false, confidence: 0.9, ...over,
});

describe("Gemini extraction pipeline safeguards (stub client)", () => {
  let db: TempDb;
  let projectId: string;
  beforeAll(async () => {
    db = await createTempDb();
    await migrateUp(db.pool);
    projectId = (await db.pool.query<{ id: string }>("INSERT INTO projects (name) VALUES ('Gemini Test') RETURNING id")).rows[0]!.id;
  });
  afterAll(async () => db.drop());

  it("Zod rejects malformed model output", () => {
    expect(extractionResultSchema.safeParse({ items: [{ kind: "decided" }], entities: [], relationships: [] }).success).toBe(false);
    expect(extractionResultSchema.safeParse({ items: [item({ confidence: 1.5 })], entities: [], relationships: [] }).success).toBe(false);
    expect(extractionResultSchema.safeParse({ items: [item({ subject_key: "Primary Database!" })], entities: [], relationships: [] }).success).toBe(false);
    expect(extractionResultSchema.safeParse({ items: [item({})], entities: [], relationships: [] }).success).toBe(true);
  });

  it("stores Gemini extractions with method=gemini, and holds fabricated excerpts for review", async () => {
    const ctx: ServiceContext = {
      pool: db.pool, log: silent,
      gemini: stub(async () => ({
        items: [
          item({}),
          item({ kind: "verification", option: "PostgreSQL", excerpt: "PostgreSQL passed all production checks", summary: "fabricated" }),
        ],
        entities: [{ name: "PostgreSQL", kind: "technology" }],
        relationships: [],
      })),
    };
    const id = await createConversation(db.pool, { projectId, title: "g1", occurredAt: new Date("2026-03-01"), source: "paste", text: "A: We decided to use PostgreSQL because of relational data." });
    const r = await processConversation(ctx, id);
    expect(r).toMatchObject({ method: "gemini", model: "stub-model", memories: 2, unverifiedExcerpts: 1, embedded: 2 });
    const d = (await listDecisions(db.pool, { projectId }))[0]!;
    expect(d).toMatchObject({ option: "PostgreSQL", commitmentStatus: "DECIDED", implementationStatus: "NOT_STARTED" }); // fabricated verification NOT applied
    const reviews = await listReviews(db.pool, { projectId, status: "open" });
    expect(reviews.map((x) => x.kind)).toEqual(["unverified_excerpt"]);
    const stored = await db.pool.query("SELECT extraction_method, extraction_model FROM conversations WHERE id = $1", [id]);
    expect(stored.rows[0]).toEqual({ extraction_method: "gemini", extraction_model: "stub-model" });
  });

  it("falls back to the labelled deterministic extractor when Gemini fails, recording the error", async () => {
    const ctx: ServiceContext = { pool: db.pool, log: silent, gemini: stub(async () => { throw new Error("quota exceeded"); }) };
    const id = await createConversation(db.pool, { projectId, title: "g2", occurredAt: new Date("2026-04-01"), source: "paste", text: "A: The PostgreSQL migration has been implemented." });
    const r = await processConversation(ctx, id);
    expect(r).toMatchObject({ method: "fallback", model: null, geminiError: "quota exceeded" });
    const stored = await db.pool.query("SELECT extraction_method, extraction_error FROM conversations WHERE id = $1", [id]);
    expect(stored.rows[0]).toEqual({ extraction_method: "fallback", extraction_error: "quota exceeded" });
    expect((await listDecisions(db.pool, { projectId }))[0]!.implementationStatus).toBe("CLAIMED_IMPLEMENTED");
  });
});
