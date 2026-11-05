import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import { getSystemStatus } from "../status.js";
import { BadRequestError, NotFoundError, type ServiceContext } from "../services/context.js";
import { importDemo } from "../services/demo.js";
import { createConversation, processConversation } from "../services/ingest.js";
import { rebuildProjection } from "../services/projection.js";
import { answerQuestion } from "../services/query.js";
import {
  getConversation, getCurrentState, getDecision, getDecisionEvidence, getDecisionHistory, getGraph, getOverview,
  getProject, getTimeline, listCommitments, listConversations, listDecisions, listProjects, listReviews, searchMemories,
} from "../services/read.js";

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestError(z.prettifyError(r.error));
  return r.data;
}

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const projectParams = z.object({ projectId: uuid });
const COMMITMENT = ["NONE", "PROPOSED", "DECIDED", "REJECTED", "CANCELLED", "REVERSED", "SUPERSEDED"] as const;
const IMPLEMENTATION = ["NOT_STARTED", "CLAIMED_IMPLEMENTED", "VERIFIED", "RETIRED"] as const;

export interface ApiDeps {
  ctx: ServiceContext;
  info: { geminiModel: string; geminiEmbeddingModel: string; webhookSecretConfigured: boolean; workerEnabled: boolean; mcpAllowedHosts: string[] };
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { ctx } = deps;
  const pool = ctx.pool;

  app.get("/api/overview", () => getOverview(pool));

  // ── Projects ──
  app.get("/api/projects", () => listProjects(pool));
  app.post("/api/projects", async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(1000).default("") }), req.body);
    const exists = await pool.query("SELECT 1 FROM projects WHERE lower(name) = lower($1)", [body.name]);
    if (exists.rowCount) return reply.code(409).send({ error: `A project named "${body.name}" already exists`, statusCode: 409 });
    const r = await pool.query<{ id: string }>("INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id", [body.name, body.description]);
    return reply.code(201).send(await getProject(pool, r.rows[0]!.id));
  });
  app.get("/api/projects/:id", async (req) => {
    const { id } = parse(idParams, req.params);
    return { ...(await getProject(pool, id)), state: await getCurrentState(pool, id) };
  });
  app.patch("/api/projects/:id", async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(1000).optional() }), req.body);
    const r = await pool.query(
      `UPDATE projects SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now() WHERE id = $1`,
      [id, body.name ?? null, body.description ?? null],
    );
    if (!r.rowCount) throw new NotFoundError("Project not found");
    return getProject(pool, id);
  });

  // ── Conversations ──
  app.get("/api/conversations", async (req) => {
    const q = parse(z.object({ projectId: uuid.optional() }), req.query);
    return listConversations(pool, q.projectId);
  });
  app.post("/api/conversations", async (req, reply) => {
    const body = parse(
      z.object({
        projectId: uuid,
        title: z.string().trim().min(1).max(160),
        occurredAt: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
        text: z.string().trim().min(3).max(50_000),
        source: z.enum(["manual", "paste"]).default("paste"),
        process: z.boolean().default(true),
      }),
      req.body,
    );
    await getProject(pool, body.projectId);
    const id = await createConversation(pool, {
      projectId: body.projectId, title: body.title, source: body.source, text: body.text,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
    });
    const result = body.process ? await processConversation(ctx, id) : null;
    return reply.code(201).send({ conversation: await getConversation(pool, id), result });
  });
  app.get("/api/conversations/:id", async (req) => getConversation(pool, parse(idParams, req.params).id));
  app.post("/api/conversations/:id/process", async (req) => {
    const { id } = parse(idParams, req.params);
    const result = await processConversation(ctx, id);
    return { conversation: await getConversation(pool, id), result };
  });

  app.post("/api/demo/import", async (_req, reply) => {
    const r = await importDemo(ctx);
    return reply.code(201).send({ projectId: r.projectId, conversations: r.results });
  });

  // ── Decisions & commitments ──
  app.get("/api/decisions", async (req) => {
    const q = parse(
      z.object({ projectId: uuid.optional(), commitment: z.enum(COMMITMENT).optional(), implementation: z.enum(IMPLEMENTATION).optional() }),
      req.query,
    );
    return listDecisions(pool, q);
  });
  app.get("/api/decisions/:id", async (req) => getDecision(pool, parse(idParams, req.params).id));
  app.get("/api/decisions/:id/history", async (req) => {
    const { id } = parse(idParams, req.params);
    await getDecision(pool, id);
    return getDecisionHistory(pool, id);
  });
  app.get("/api/decisions/:id/evidence", async (req) => {
    const { id } = parse(idParams, req.params);
    await getDecision(pool, id);
    return getDecisionEvidence(pool, id);
  });
  app.get("/api/commitments", async (req) => {
    const q = parse(z.object({ projectId: uuid.optional(), status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional() }), req.query);
    return listCommitments(pool, q.projectId, q.status);
  });

  // ── Memory intelligence ──
  app.post("/api/memory/query", async (req) => {
    const body = parse(z.object({ question: z.string().trim().min(3).max(500), projectId: uuid.optional() }), req.body);
    return answerQuestion(pool, ctx.gemini, body.question, body.projectId);
  });
  app.get("/api/memory/search", async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(300), projectId: uuid.optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
    return searchMemories(pool, ctx.gemini, q.q, { projectId: q.projectId, limit: q.limit });
  });
  app.get("/api/memory/current-state/:projectId", async (req) => getCurrentState(pool, parse(projectParams, req.params).projectId));
  const timelineQuery = z.object({
    projectId: uuid.optional(),
    types: z.string().optional().transform((s) => (s ? s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined)),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    corroborations: z.enum(["true", "false"]).default("false"),
  });
  const timeline = (projectId: string | undefined, q: z.infer<typeof timelineQuery>) =>
    getTimeline(pool, {
      projectId, types: q.types, from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(`${q.to}T23:59:59Z`) : undefined, includeCorroborations: q.corroborations === "true",
    });
  app.get("/api/memory/timeline", async (req) => {
    const q = parse(timelineQuery, req.query);
    return timeline(q.projectId, q);
  });
  app.get("/api/memory/timeline/:projectId", async (req) => timeline(parse(projectParams, req.params).projectId, parse(timelineQuery, req.query)));
  app.get("/api/memory/graph/:projectId", async (req) => getGraph(pool, parse(projectParams, req.params).projectId));

  // ── Review queue ──
  app.get("/api/reviews", async (req) => {
    const q = parse(z.object({ projectId: uuid.optional(), status: z.enum(["open", "confirmed", "dismissed"]).optional() }), req.query);
    const items = await listReviews(pool, q);
    const unverified = await listDecisions(pool, { projectId: q.projectId, implementation: "CLAIMED_IMPLEMENTED" });
    return { items, unverifiedClaims: unverified };
  });
  app.post("/api/reviews/:id/resolve", async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ action: z.enum(["confirm", "dismiss"]), note: z.string().max(500).optional() }), req.body);
    const r = await pool.query<{ project_id: string }>(
      `UPDATE review_items SET status = $2, resolved_at = now(), resolution_note = $3
        WHERE id = $1 AND status = 'open' RETURNING project_id`,
      [id, body.action === "confirm" ? "confirmed" : "dismissed", body.note ?? null],
    );
    if (!r.rows[0]) {
      const exists = await pool.query("SELECT 1 FROM review_items WHERE id = $1", [id]);
      if (!exists.rowCount) throw new NotFoundError("Review item not found");
      throw new BadRequestError("Review item is already resolved");
    }
    // The resolution is an input to the deterministic engine: replay the project.
    const projection = await rebuildProjection(pool, r.rows[0].project_id);
    return { resolved: (await listReviews(pool, { projectId: r.rows[0].project_id })).find((x) => x.id === id), projection };
  });

  // ── Evaluation results (produced by evaluation/run.ts; read-only) ──
  app.get("/api/evaluation", async (_req, reply) => {
    const file = fileURLToPath(new URL("../../../evaluation/results/summary.json", import.meta.url));
    try {
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch {
      return reply.code(404).send({
        error: "No evaluation results yet. Run: npx tsx evaluation/run.ts --phase A (then B, C).",
        statusCode: 404,
      });
    }
  });

  // ── Settings / integration status (never returns secrets) ──
  app.get("/api/settings/status", async () => {
    const system = await getSystemStatus(pool);
    const wh = await pool.query<{ status: string; n: number; last: Date | null }>(
      "SELECT status, count(*)::int AS n, max(received_at) AS last FROM webhook_events GROUP BY status",
    );
    const lastEvent = await pool.query<{ event_type: string; status: string; received_at: Date; signature_status: string; error: string | null }>(
      "SELECT event_type, status, received_at, signature_status, error FROM webhook_events ORDER BY received_at DESC LIMIT 5",
    );
    const jobs = await pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM jobs GROUP BY status");
    return {
      system,
      gemini: {
        configured: ctx.gemini !== null,
        model: ctx.gemini ? deps.info.geminiModel : null,
        embeddingModel: ctx.gemini ? deps.info.geminiEmbeddingModel : null,
        extractionMode: ctx.gemini ? "gemini (fallback on error)" : "deterministic fallback (no GEMINI_API_KEY)",
      },
      webhook: {
        endpoint: "/api/webhooks/odysseus",
        secretConfigured: deps.info.webhookSecretConfigured,
        counts: Object.fromEntries(wh.rows.map((r) => [r.status, r.n])),
        recent: lastEvent.rows.map((e) => ({ event: e.event_type, status: e.status, receivedAt: e.received_at.toISOString(), signature: e.signature_status, error: e.error })),
      },
      mcp: { endpoint: "/mcp", transport: "Streamable HTTP (stateless)", allowedHosts: deps.info.mcpAllowedHosts },
      worker: { enabled: deps.info.workerEnabled, jobs: Object.fromEntries(jobs.rows.map((r) => [r.status, r.n])) },
    };
  });
}
