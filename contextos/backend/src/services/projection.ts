/**
 * Rebuilds a project's decision projection from its memories by replaying them
 * through the deterministic lifecycle engine. Runs in one transaction under a
 * row lock on the project, so concurrent rebuilds serialise and readers never
 * see a half-built state. Decision/commitment ids are stable across rebuilds
 * (upsert by natural key), and reviewer resolutions are re-applied.
 */
import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import { runLifecycle, type Observation, type Resolution, type ReviewKind } from "../domain/lifecycle.js";
import type { MemoryKind } from "../domain/types.js";
import { SUBJECT_LABELS } from "../extraction/catalog.js";

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  occurred_at: Date;
  summary: string;
  subject_key: string | null;
  subject_label: string | null;
  option_name: string | null;
  previous_option: string | null;
  replaces_previous: boolean;
  reason: string | null;
  commitment_title: string | null;
  commitment_owner: string | null;
  commitment_due_at: Date | null;
  speaker_role: string;
  hedged: boolean;
  confidence: number;
  excerpt_verified: boolean;
}

export async function rebuildProjection(pool: pg.Pool, projectId: string): Promise<{ decisions: number; events: number; reviews: number }> {
  return withTransaction(pool, async (db) => {
    await db.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);

    const memories = await db.query<MemoryRow>(
      `SELECT m.id, m.kind, m.occurred_at, m.summary, m.subject_key, m.subject_label, m.option_name, m.previous_option,
              m.replaces_previous, m.reason, m.commitment_title, m.commitment_owner, m.commitment_due_at,
              m.speaker_role, m.hedged, m.confidence, m.excerpt_verified
         FROM memories m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.project_id = $1
        ORDER BY m.occurred_at, c.recorded_at, c.id, m.item_index`,
      [projectId],
    );
    const observations: Observation[] = memories.rows.map((m) => ({
      memoryId: m.id, kind: m.kind, occurredAt: m.occurred_at, summary: m.summary, subjectKey: m.subject_key,
      subjectLabel: m.subject_label, option: m.option_name, previousOption: m.previous_option,
      replacesPrevious: m.replaces_previous, reason: m.reason, commitmentTitle: m.commitment_title,
      commitmentOwner: m.commitment_owner, commitmentDueAt: m.commitment_due_at, speakerRole: m.speaker_role,
      hedged: m.hedged, confidence: m.confidence, excerptVerified: m.excerpt_verified,
    }));

    const resolved = await db.query<{ memory_id: string; kind: ReviewKind; status: Resolution }>(
      "SELECT memory_id, kind, status FROM review_items WHERE project_id = $1 AND status <> 'open'",
      [projectId],
    );
    const resolutions = new Map(resolved.rows.map((r) => [`${r.memory_id}:${r.kind}`, r.status] as const));
    const cardRows = await db.query<{ key: string; cardinality: "exclusive" | "multi" }>(
      "SELECT key, cardinality FROM subjects WHERE project_id = $1",
      [projectId],
    );
    const cardinalities = new Map(cardRows.rows.map((r) => [r.key, r.cardinality]));

    const result = runLifecycle(observations, {
      cardinality: (k) => cardinalities.get(k) ?? "exclusive",
      resolutions,
    });

    // Subjects
    const subjectIds = new Map<string, string>();
    for (const d of result.decisions.values()) {
      if (subjectIds.has(d.subjectKey)) continue;
      const r = await db.query<{ id: string }>(
        `INSERT INTO subjects (project_id, key, label) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, key) DO UPDATE SET label = subjects.label
         RETURNING id`,
        [projectId, d.subjectKey, SUBJECT_LABELS[d.subjectKey] ?? d.subjectLabel],
      );
      subjectIds.set(d.subjectKey, r.rows[0]!.id);
    }

    // Decisions (stable ids via natural key)
    await db.query("UPDATE decisions SET is_active = false, superseded_by = NULL WHERE project_id = $1", [projectId]);
    const decisionIds = new Map<string, string>();
    for (const d of result.decisions.values()) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO decisions (project_id, subject_id, entity_id, option_key, option_name, title, reason,
                                commitment_status, implementation_status, is_disputed, first_seen_at, proposed_at,
                                decided_at, implemented_at, verified_at, closed_at, retired_at, is_active, updated_at)
         VALUES ($1, $2, (SELECT id FROM entities WHERE project_id = $1 AND lower(name) = lower($4) LIMIT 1),
                 $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true, now())
         ON CONFLICT (subject_id, option_key) DO UPDATE SET
           entity_id = EXCLUDED.entity_id, option_name = EXCLUDED.option_name, title = EXCLUDED.title,
           reason = EXCLUDED.reason, commitment_status = EXCLUDED.commitment_status,
           implementation_status = EXCLUDED.implementation_status, is_disputed = EXCLUDED.is_disputed,
           first_seen_at = EXCLUDED.first_seen_at, proposed_at = EXCLUDED.proposed_at, decided_at = EXCLUDED.decided_at,
           implemented_at = EXCLUDED.implemented_at, verified_at = EXCLUDED.verified_at, closed_at = EXCLUDED.closed_at,
           retired_at = EXCLUDED.retired_at, is_active = true, updated_at = now()
         RETURNING id`,
        [
          projectId, subjectIds.get(d.subjectKey), d.optionKey, d.optionName, `${d.optionName} as ${d.subjectLabel.toLowerCase()}`,
          d.reason, d.commitment, d.implementation, d.disputed, d.firstSeenAt, d.proposedAt, d.decidedAt,
          d.implementedAt, d.verifiedAt, d.closedAt, d.retiredAt,
        ],
      );
      decisionIds.set(d.key, r.rows[0]!.id);
    }
    for (const d of result.decisions.values()) {
      if (d.supersededByKey) {
        await db.query("UPDATE decisions SET superseded_by = $2 WHERE id = $1", [
          decisionIds.get(d.key), decisionIds.get(d.supersededByKey),
        ]);
      }
    }

    // Commitments
    await db.query("UPDATE commitments SET is_active = false WHERE project_id = $1", [projectId]);
    const commitmentIds = new Map<string, string>();
    for (const c of result.commitments.values()) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO commitments (project_id, title_key, title, owner, due_at, status, opened_at, closed_at, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now())
         ON CONFLICT (project_id, title_key) DO UPDATE SET
           title = EXCLUDED.title, owner = EXCLUDED.owner, due_at = EXCLUDED.due_at, status = EXCLUDED.status,
           opened_at = EXCLUDED.opened_at, closed_at = EXCLUDED.closed_at, is_active = true, updated_at = now()
         RETURNING id`,
        [projectId, c.key, c.title, c.owner, c.dueAt, c.status, c.openedAt, c.closedAt],
      );
      commitmentIds.set(c.key, r.rows[0]!.id);
    }

    // Memory → decision/commitment links
    await db.query("UPDATE memories SET decision_id = NULL, commitment_id = NULL WHERE project_id = $1", [projectId]);
    for (const [memoryId, link] of result.memoryLinks) {
      await db.query("UPDATE memories SET decision_id = $2, commitment_id = $3 WHERE id = $1", [
        memoryId,
        link.decisionKey ? decisionIds.get(link.decisionKey) ?? null : null,
        link.commitmentKey ? commitmentIds.get(link.commitmentKey) ?? null : null,
      ]);
    }

    // Lifecycle events (fully derived → replaced)
    await db.query("DELETE FROM lifecycle_events WHERE project_id = $1", [projectId]);
    for (const e of result.events) {
      await db.query(
        `INSERT INTO lifecycle_events (project_id, decision_id, commitment_id, seq, event_type, applied, from_commitment,
                                       to_commitment, from_implementation, to_implementation, memory_id, occurred_at, actor, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          projectId,
          e.decisionKey ? decisionIds.get(e.decisionKey) : null,
          e.commitmentKey ? commitmentIds.get(e.commitmentKey) : null,
          e.seq, e.type, e.applied, e.fromCommitment, e.toCommitment, e.fromImplementation, e.toImplementation,
          e.memoryId, e.occurredAt, e.actor, e.note,
        ],
      );
    }

    // Review items: keep reviewer resolutions, refresh everything else
    await db.query("UPDATE review_items SET is_active = false WHERE project_id = $1", [projectId]);
    for (const r of result.reviews) {
      await db.query(
        `INSERT INTO review_items (project_id, memory_id, decision_id, commitment_id, kind, blocking, title, detail, proposed, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (memory_id, kind) DO UPDATE SET
           decision_id = EXCLUDED.decision_id, commitment_id = EXCLUDED.commitment_id, blocking = EXCLUDED.blocking,
           title = EXCLUDED.title, detail = EXCLUDED.detail, proposed = EXCLUDED.proposed, is_active = true`,
        [
          projectId, r.memoryId, r.decisionKey ? decisionIds.get(r.decisionKey) : null,
          r.commitmentKey ? commitmentIds.get(r.commitmentKey) : null, r.kind, r.blocking, r.title, r.detail,
          r.proposed ? JSON.stringify(r.proposed) : null,
        ],
      );
    }

    return { decisions: result.decisions.size, events: result.events.length, reviews: result.reviews.length };
  });
}
