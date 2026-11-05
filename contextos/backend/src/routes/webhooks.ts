/**
 * Odysseus outbound webhook receiver.
 *
 * Mirrors Odysseus's delivery format (src/webhook_manager.py `_deliver`, verified in source):
 *   body = {"event", "timestamp" (naive UTC ISO), "data"}
 *   X-Odysseus-Signature = hex(HMAC-SHA256(secret, raw_body))
 * chat.completed data = {session_id, model, user_message (full), response (first 2000 chars)}.
 *
 * Odysseus makes ONE delivery attempt with a 10s timeout, so we only verify,
 * dedupe, store and enqueue here (fast 202), and process in the job worker.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import { withTransaction } from "../db/pool.js";
import type { ServiceContext } from "../services/context.js";
import { createConversation } from "../services/ingest.js";

const envelopeSchema = z.object({
  event: z.string().min(1).max(64),
  timestamp: z.string().min(10).max(40),
  data: z.record(z.string(), z.unknown()),
});
const chatCompletedSchema = z.object({
  session_id: z.string().min(1).max(200),
  model: z.string().max(200).nullish(),
  user_message: z.string().max(100_000),
  response: z.string().max(100_000),
});

export const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
  const got = Buffer.from(header.trim().toLowerCase(), "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Odysseus sends naive UTC timestamps (no 'Z'); treat them as UTC. */
export function parseOdysseusTimestamp(ts: string): Date | null {
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : `${ts}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: { ctx: ServiceContext; secret: string | undefined; defaultProject: string; now?: () => number },
) {
  const { pool } = deps.ctx;
  const now = deps.now ?? Date.now;

  void app.register((scoped, _opts, done) => {
    // Keep the exact raw bytes: the HMAC covers them, not a re-serialisation.
    scoped.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1_048_576 }, (_req, body, done) => done(null, body));

    scoped.post("/api/webhooks/odysseus", async (req, reply) => {
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw)) return reply.code(415).send({ error: "Expected application/json", statusCode: 415 });

      let signatureStatus: "valid" | "not_configured" = "not_configured";
      if (deps.secret) {
        if (!verifySignature(deps.secret, raw, req.headers["x-odysseus-signature"] as string | undefined)) {
          req.log.warn("rejected Odysseus webhook: bad or missing signature");
          return reply.code(401).send({ error: "Invalid signature", statusCode: 401 }); // nothing stored
        }
        signatureStatus = "valid";
      }

      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "Body is not valid JSON", statusCode: 400 });
      }
      const env = envelopeSchema.safeParse(json);
      if (!env.success) return reply.code(400).send({ error: z.prettifyError(env.error), statusCode: 400 });
      const sentAt = parseOdysseusTimestamp(env.data.timestamp);
      if (!sentAt || Math.abs(now() - sentAt.getTime()) > MAX_CLOCK_SKEW_MS) {
        return reply.code(400).send({ error: "Stale or invalid timestamp", statusCode: 400 });
      }

      // Dedupe on event + data (not the delivery timestamp), so a resend of the same exchange is ignored.
      const dedupeKey = createHash("sha256").update(`${env.data.event}\n${JSON.stringify(env.data.data)}`).digest("hex");
      const isChat = env.data.event === "chat.completed";
      const chat = isChat ? chatCompletedSchema.safeParse(env.data.data) : null;
      if (chat && !chat.success) return reply.code(400).send({ error: z.prettifyError(chat.error), statusCode: 400 });

      const outcome = await withTransaction(pool, async (db) => {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO webhook_events (event_type, dedupe_key, signature_status, payload, status)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
          [env.data.event, dedupeKey, signatureStatus, json, chat?.success ? "accepted" : "ignored"],
        );
        const eventId = ins.rows[0]?.id;
        if (!eventId) return { duplicate: true as const };
        if (!chat?.success) return { duplicate: false as const, eventId, conversationId: null };

        const d = chat.data;
        // Route to a project whose name is mentioned in the user's message; else the inbox project.
        const all = await db.query<{ id: string; name: string }>("SELECT id, name FROM projects ORDER BY length(name) DESC");
        const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hit = all.rows.find((p) => new RegExp(`(^|[^A-Za-z0-9])${escape(p.name)}([^A-Za-z0-9]|$)`, "i").test(d.user_message));
        const project = hit
          ? { rows: [{ id: hit.id }] }
          : await db.query<{ id: string }>(
              `INSERT INTO projects (name, description) VALUES ($1, 'Conversations captured automatically from Odysseus webhooks.')
               ON CONFLICT (lower(name)) DO UPDATE SET updated_at = projects.updated_at RETURNING id`,
              [deps.defaultProject],
            );
        const firstLine = d.user_message.split("\n")[0] ?? "";
        const conversationId = await createConversation(db, {
          projectId: project.rows[0]!.id,
          title: `Odysseus: ${firstLine.slice(0, 70) || "chat"}`,
          occurredAt: sentAt,
          source: "odysseus_webhook",
          externalRef: d.session_id,
          messages: [
            { seq: 0, role: "user", speaker: null, content: d.user_message },
            { seq: 1, role: "assistant", speaker: d.model ?? "Odysseus", content: d.response },
          ],
        });
        await db.query("UPDATE webhook_events SET conversation_id = $2 WHERE id = $1", [eventId, conversationId]);
        await db.query("INSERT INTO jobs (kind, payload) VALUES ('process_conversation', $1)", [
          JSON.stringify({ conversationId, webhookEventId: eventId }),
        ]);
        return { duplicate: false as const, eventId, conversationId };
      });

      if (outcome.duplicate) return reply.code(200).send({ received: true, duplicate: true });
      return reply.code(202).send({ received: true, duplicate: false, eventId: outcome.eventId, conversationId: outcome.conversationId });
    });
    done();
  });
}
