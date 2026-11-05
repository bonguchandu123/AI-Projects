/**
 * Conversation ingestion and processing:
 *   store original text (never discarded) → extract (Gemini, else labelled fallback)
 *   → verify every excerpt against the stored source → store memories with provenance
 *   → embed (best effort) → rebuild the deterministic projection.
 */
import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import type { ExtractionMethod, ExtractionResult, ParsedMessage } from "../domain/types.js";
import { fallbackExtract } from "../extraction/fallback.js";
import { locateExcerpt, parseConversationText } from "../extraction/parse.js";
import { NotFoundError, type ServiceContext } from "./context.js";
import { rebuildProjection } from "./projection.js";

export type ConversationSource = "manual" | "paste" | "demo" | "odysseus_webhook" | "mcp";

export interface NewConversation {
  projectId: string;
  title: string;
  occurredAt: Date;
  source: ConversationSource;
  text?: string;
  messages?: ParsedMessage[];
  externalRef?: string | null;
  isDemo?: boolean;
}

export async function createConversation(pool: pg.Pool | pg.PoolClient, input: NewConversation): Promise<string> {
  const messages = input.messages ?? parseConversationText(input.text ?? "");
  if (messages.length === 0) throw new Error("Conversation has no content");
  const run = async (db: pg.Pool | pg.PoolClient) => {
    const c = await db.query<{ id: string }>(
      `INSERT INTO conversations (project_id, title, source, external_ref, occurred_at, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.projectId, input.title, input.source, input.externalRef ?? null, input.occurredAt, input.isDemo ?? false],
    );
    const id = c.rows[0]!.id;
    for (const m of messages) {
      await db.query("INSERT INTO messages (conversation_id, seq, role, speaker, content) VALUES ($1, $2, $3, $4, $5)", [
        id, m.seq, m.role, m.speaker, m.content,
      ]);
    }
    return id;
  };
  // Use a transaction when given a pool; join the caller's transaction when given a client.
  return "release" in pool ? run(pool) : withTransaction(pool, run);
}

export interface ProcessResult {
  conversationId: string;
  method: ExtractionMethod;
  model: string | null;
  geminiError: string | null;
  memories: number;
  unverifiedExcerpts: number;
  embedded: number;
  projection: { decisions: number; events: number; reviews: number };
}

export async function processConversation(ctx: ServiceContext, conversationId: string): Promise<ProcessResult> {
  const conv = await ctx.pool.query<{ project_id: string; project_name: string; occurred_at: Date; is_demo: boolean }>(
    `SELECT c.project_id, p.name AS project_name, c.occurred_at, c.is_demo
       FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
    [conversationId],
  );
  const row = conv.rows[0];
  if (!row) throw new NotFoundError("Conversation not found");
  const msgRows = await ctx.pool.query<{ id: string; seq: number; role: ParsedMessage["role"]; speaker: string | null; content: string }>(
    "SELECT id, seq, role, speaker, content FROM messages WHERE conversation_id = $1 ORDER BY seq",
    [conversationId],
  );
  const messages: ParsedMessage[] = msgRows.rows.map((m) => ({ seq: m.seq, role: m.role, speaker: m.speaker, content: m.content }));
  await ctx.pool.query("UPDATE conversations SET status = 'processing', extraction_error = NULL WHERE id = $1", [conversationId]);

  // 1. Extract — Gemini if configured, otherwise (or on failure) the labelled fallback.
  let method: ExtractionMethod = "fallback";
  let model: string | null = null;
  let geminiError: string | null = null;
  let extraction: ExtractionResult;
  if (ctx.gemini) {
    try {
      extraction = await ctx.gemini.extract(messages, {
        projectName: row.project_name,
        conversationDate: row.occurred_at.toISOString().slice(0, 10),
      });
      method = "gemini";
      model = ctx.gemini.model;
    } catch (err) {
      geminiError = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ conversationId, err: geminiError }, "Gemini extraction failed; using deterministic fallback");
      extraction = fallbackExtract(messages, row.occurred_at);
    }
  } else {
    extraction = fallbackExtract(messages, row.occurred_at);
  }

  // 2. Store memories with provenance; verify each excerpt against the source.
  let unverified = 0;
  const memoryIds: { id: string; text: string }[] = [];
  try {
    await withTransaction(ctx.pool, async (db) => {
      // Reprocessing replaces this conversation's memories (relationships/events cascade);
      // the original messages are untouched.
      await db.query("DELETE FROM memories WHERE conversation_id = $1", [conversationId]);

      for (const e of extraction.entities) {
        await db.query(
          `INSERT INTO entities (project_id, name, kind) VALUES ($1, $2, $3)
           ON CONFLICT (project_id, lower(name)) DO NOTHING`,
          [row.project_id, e.name, e.kind],
        );
      }

      for (const [i, item] of extraction.items.entries()) {
        const located = locateExcerpt(item.excerpt, messages, item.message_index);
        if (located === null) unverified++;
        const msgIndex = located ?? item.message_index;
        const messageId = msgRows.rows[msgIndex]?.id ?? null;
        if (item.option) {
          await db.query(
            `INSERT INTO entities (project_id, name, kind) VALUES ($1, $2, 'technology')
             ON CONFLICT (project_id, lower(name)) DO NOTHING`,
            [row.project_id, item.option],
          );
        }
        const due = item.commitment_due && !Number.isNaN(Date.parse(item.commitment_due)) ? new Date(item.commitment_due) : null;
        const m = await db.query<{ id: string }>(
          `INSERT INTO memories (project_id, conversation_id, message_id, item_index, kind, summary, excerpt, excerpt_verified,
                                 subject_key, subject_label, option_name, previous_option, replaces_previous, reason,
                                 commitment_title, commitment_owner, commitment_due_at, speaker_role, hedged, confidence,
                                 occurred_at, extraction_method, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           RETURNING id`,
          [
            row.project_id, conversationId, messageId, i, item.kind, item.summary, item.excerpt, located !== null,
            item.subject_key, item.subject_label, item.option, item.previous_option, item.replaces_previous, item.reason,
            item.commitment_title, item.commitment_owner, due, item.speaker_role, item.hedged, item.confidence,
            row.occurred_at, method, row.is_demo,
          ],
        );
        memoryIds.push({ id: m.rows[0]!.id, text: `${item.summary}. ${item.excerpt}${item.reason ? `. Reason: ${item.reason}` : ""}` });
      }

      for (const [j, rel] of extraction.relationships.entries()) {
        const located = locateExcerpt(rel.excerpt, messages, rel.message_index);
        if (located === null) continue; // a relationship without verifiable evidence is dropped
        if (rel.source.toLowerCase() === rel.target.toLowerCase()) continue;
        const ids = await db.query<{ id: string; name: string }>(
          `INSERT INTO entities (project_id, name, kind) VALUES ($1, $2, 'other'), ($1, $3, 'other')
           ON CONFLICT (project_id, lower(name)) DO UPDATE SET name = entities.name RETURNING id, name`,
          [row.project_id, rel.source, rel.target],
        );
        const src = ids.rows.find((r) => r.name.toLowerCase() === rel.source.toLowerCase());
        const tgt = ids.rows.find((r) => r.name.toLowerCase() === rel.target.toLowerCase());
        if (!src || !tgt) continue;
        // The relationship's own excerpt becomes its evidence memory.
        const ev = await db.query<{ id: string }>(
          `INSERT INTO memories (project_id, conversation_id, message_id, item_index, kind, summary, excerpt, excerpt_verified,
                                 speaker_role, confidence, occurred_at, extraction_method, is_demo)
           VALUES ($1, $2, $3, $4, 'fact', $5, $6, true, $7, 0.8, $8, $9, $10) RETURNING id`,
          [
            row.project_id, conversationId, msgRows.rows[located]?.id ?? null, extraction.items.length + j,
            `${src.name} ${rel.predicate.replace(/_/g, " ")} ${tgt.name}`, rel.excerpt, messages[located]?.role ?? "unknown",
            row.occurred_at, method, row.is_demo,
          ],
        );
        await db.query(
          `INSERT INTO relationships (project_id, source_entity_id, target_entity_id, predicate, memory_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [row.project_id, src.id, tgt.id, rel.predicate, ev.rows[0]!.id],
        );
      }

      await db.query(
        `UPDATE conversations SET status = 'processed', extraction_method = $2, extraction_model = $3,
                extraction_raw = $4, extraction_error = $5, processed_at = now() WHERE id = $1`,
        [conversationId, method, model, JSON.stringify(extraction), geminiError],
      );
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.pool.query("UPDATE conversations SET status = 'failed', extraction_error = $2 WHERE id = $1", [conversationId, msg]);
    throw err;
  }

  // 3. Embeddings (best effort; search falls back to full-text when absent).
  let embedded = 0;
  if (ctx.gemini && memoryIds.length > 0) {
    try {
      const vectors = await ctx.gemini.embed(memoryIds.map((m) => m.text));
      for (const [i, m] of memoryIds.entries()) {
        await ctx.pool.query("UPDATE memories SET embedding = $2::vector WHERE id = $1", [m.id, JSON.stringify(vectors[i])]);
        embedded++;
      }
    } catch (err) {
      ctx.log.warn({ conversationId, err: err instanceof Error ? err.message : String(err) }, "embedding failed; full-text search only");
    }
  }

  // 4. Deterministic state update.
  const projection = await rebuildProjection(ctx.pool, row.project_id);
  return {
    conversationId, method, model, geminiError, memories: memoryIds.length, unverifiedExcerpts: unverified, embedded, projection,
  };
}
