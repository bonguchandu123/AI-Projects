import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { migrateUp } from "../src/db/migrate.js";
import { runOneJob } from "../src/jobs/worker.js";
import { createTempDb, type TempDb } from "./helpers/temp-db.js";

const SECRET = "test-webhook-secret";
const config = { LOG_LEVEL: "silent" as const, MCP_ALLOWED_HOSTS: ["127.0.0.1", "localhost"], ODYSSEUS_WEBHOOK_SECRET: SECRET };

describe("REST API, webhook and MCP tools (real Postgres, real HTTP)", () => {
  let db: TempDb;
  let app: ReturnType<typeof buildApp>;
  let base: string;
  let studymateId: string;

  beforeAll(async () => {
    db = await createTempDb();
    await migrateUp(db.pool);
    app = buildApp({ config, pool: db.pool, gemini: null });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it("creates projects with validation and duplicate protection", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Orbit", description: "test" } });
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { name: "orbit" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { name: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/not-a-uuid" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("ingests pasted conversation text and processes it (labelled fallback)", async () => {
    const orbit = (await app.inject({ method: "GET", url: "/api/projects" })).json<{ id: string; name: string }[]>().find((p) => p.name === "Orbit")!;
    const res = await app.inject({
      method: "POST", url: "/api/conversations",
      payload: { projectId: orbit.id, title: "Arch chat", occurredAt: "2026-04-01", text: "Mei: We decided to use SQLite because it is embedded.\nMei: SQLite has been implemented." },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ result: { method: string; memories: number }; conversation: { messages: unknown[]; memories: { kind: string }[] } }>();
    expect(body.result).toMatchObject({ method: "fallback", memories: 2 });
    expect(body.conversation.messages).toHaveLength(2);
    expect(body.conversation.memories.map((m) => m.kind)).toEqual(["decision", "implementation_claim"]);
  });

  it("imports the demo dataset and answers the acceptance question", async () => {
    const imp = await app.inject({ method: "POST", url: "/api/demo/import" });
    expect(imp.statusCode).toBe(201);
    studymateId = imp.json<{ projectId: string }>().projectId;
    // repeatable
    expect((await app.inject({ method: "POST", url: "/api/demo/import" })).statusCode).toBe(201);
    studymateId = (await app.inject({ method: "GET", url: "/api/projects" })).json<{ id: string; name: string }[]>().find((p) => p.name === "StudyMate")!.id;

    const q = await app.inject({ method: "POST", url: "/api/memory/query", payload: { question: "What database does StudyMate currently use and why?" } });
    expect(q.statusCode).toBe(200);
    expect(q.json<{ directAnswer: string }>().directAnswer).toMatch(/currently uses PostgreSQL.*VERIFIED/);
    for (const url of [
      `/api/memory/current-state/${studymateId}`, `/api/memory/timeline/${studymateId}`, `/api/memory/graph/${studymateId}`,
      "/api/overview", "/api/decisions", "/api/reviews", "/api/commitments", "/api/settings/status", "/api/memory/search?q=relational",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    const settings = (await app.inject({ method: "GET", url: "/api/settings/status" })).json<Record<string, unknown>>();
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });

  it("confirming a conflict review applies it deterministically", async () => {
    const reviews = (await app.inject({ method: "GET", url: `/api/reviews?projectId=${studymateId}&status=open` })).json<{ items: { id: string; kind: string }[] }>();
    const conflict = reviews.items.find((r) => r.kind === "conflict")!;
    const res = await app.inject({ method: "POST", url: `/api/reviews/${conflict.id}/resolve`, payload: { action: "confirm", note: "Support confirmed" } });
    expect(res.statusCode).toBe(200);
    const decisions = (await app.inject({ method: "GET", url: `/api/decisions?projectId=${studymateId}` })).json<{ option: string; implementationStatus: string }[]>();
    expect(decisions.find((d) => d.option === "MongoDB")?.implementationStatus).toBe("CLAIMED_IMPLEMENTED");
    expect(decisions.find((d) => d.option === "PostgreSQL")?.implementationStatus).toBe("RETIRED");
    expect((await app.inject({ method: "POST", url: `/api/reviews/${conflict.id}/resolve`, payload: { action: "dismiss" } })).statusCode).toBe(400);
    // restore the demo for later tests
    await app.inject({ method: "POST", url: "/api/demo/import" });
  });

  describe("Odysseus webhook", () => {
    const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");
    const delivery = (data: Record<string, unknown>, event = "chat.completed", ts = new Date().toISOString().replace("Z", "")) =>
      JSON.stringify({ event, timestamp: ts, data });
    const post = (body: string, signature?: string) =>
      app.inject({ method: "POST", url: "/api/webhooks/odysseus", headers: { "content-type": "application/json", ...(signature ? { "x-odysseus-signature": signature } : {}) }, payload: body });
    const chat = { session_id: "sess-1", model: "qwen3", user_message: "For Orbit we decided to use Redis because sessions need fast access.", response: "Noted." };

    it("rejects missing or invalid signatures without storing anything", async () => {
      const body = delivery(chat);
      expect((await post(body)).statusCode).toBe(401);
      expect((await post(body, "deadbeef")).statusCode).toBe(401);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM webhook_events")).rows[0].n).toBe(0);
    });

    it("accepts a valid signed chat.completed, dedupes resends, and processes via the job worker", async () => {
      const body = delivery(chat);
      const first = await post(body, sign(body));
      expect(first.statusCode).toBe(202);
      const resend = delivery(chat, "chat.completed", new Date(Date.now() + 1000).toISOString().replace("Z", ""));
      const dup = await post(resend, sign(resend));
      expect(dup.statusCode).toBe(200);
      expect(dup.json()).toMatchObject({ duplicate: true });

      expect(await runOneJob(app.services)).toBe(true);
      const { conversationId } = first.json<{ conversationId: string }>();
      const conv = (await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` })).json<{ source: string; status: string; externalRef: string; projectName: string; memories: { kind: string; option: string }[] }>();
      expect(conv).toMatchObject({ source: "odysseus_webhook", status: "processed", externalRef: "sess-1", projectName: "Orbit" });
      expect(conv.memories[0]).toMatchObject({ kind: "decision", option: "Redis" });

      // A message that names an existing project is routed to it.
      const routed = delivery({ ...chat, session_id: "sess-2", user_message: "In StudyMate we decided to use Algolia for search." });
      const r2 = await post(routed, sign(routed));
      expect(r2.statusCode).toBe(202);
      const conv2 = (await app.inject({ method: "GET", url: `/api/conversations/${r2.json<{ conversationId: string }>().conversationId}` })).json<{ projectName: string }>();
      expect(conv2.projectName).toBe("StudyMate");
      // No project named → default inbox project.
      const inbox = delivery({ ...chat, session_id: "sess-3", user_message: "We decided to use Vercel for hosting." });
      const r3 = await post(inbox, sign(inbox));
      const conv3 = (await app.inject({ method: "GET", url: `/api/conversations/${r3.json<{ conversationId: string }>().conversationId}` })).json<{ projectName: string }>();
      expect(conv3.projectName).toBe("Odysseus Inbox");
      const ev = await db.pool.query("SELECT status, signature_status FROM webhook_events WHERE conversation_id = $1", [conversationId]);
      expect(ev.rows).toEqual([{ status: "processed", signature_status: "valid" }]);
    });

    it("rejects stale timestamps and malformed payloads; ignores non-chat events", async () => {
      const stale = delivery(chat, "chat.completed", "2020-01-01T00:00:00");
      expect((await post(stale, sign(stale))).statusCode).toBe(400);
      const bad = delivery({ session_id: "x" });
      expect((await post(bad, sign(bad))).statusCode).toBe(400);
      const ping = delivery({ message: "Test ping from Odysseus" }, "webhook.test");
      const r = await post(ping, sign(ping));
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ conversationId: null });
    });
  });

  describe("MCP tools over Streamable HTTP", () => {
    let client: Client;
    beforeAll(async () => {
      client = new Client({ name: "contextos-test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    });
    afterAll(async () => client.close());
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return { isError: Boolean(r.isError), text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
    };

    it("discovers all 8 read-only tools", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "contextos_status", "get_current_state", "get_decision_evidence", "get_decision_history",
        "get_pending_commitments", "get_project_summary", "get_unverified_claims", "search_memory",
      ]);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    });

    it("get_current_state returns the authoritative, evidence-backed state", async () => {
      const r = await call("get_current_state", { project: "studymate", subject: "database" });
      expect(r.isError).toBe(false);
      const area = r.json!.subjects[0];
      expect(area.current[0]).toMatchObject({ option: "PostgreSQL", implementation: "VERIFIED", reason: "relational data requirements" });
      expect(area.historical[0]).toMatchObject({ option: "MongoDB", superseded_by: "PostgreSQL" });
      expect(area.open_conflicts).toHaveLength(1);
      expect(area.current[0].evidence[0].excerpt).toMatch(/decided to migrate StudyMate from MongoDB to PostgreSQL/);
    });

    it("other tools return packets; unknown projects are reported as tool errors", async () => {
      expect((await call("get_decision_history", { project: "StudyMate", option: "PostgreSQL" })).json!.events.map((e: { event: string }) => e.event))
        .toEqual(["PROPOSED", "DECIDED", "IMPLEMENTATION_CLAIMED", "VERIFIED"]);
      expect((await call("get_decision_evidence", { project: "StudyMate", option: "PostgreSQL" })).json!.evidence).toHaveLength(4);
      expect((await call("get_unverified_claims", { project: "StudyMate" })).json!.claims.map((c: { option: string }) => c.option)).toEqual(["Stripe"]);
      expect((await call("get_pending_commitments", { project: "StudyMate" })).json!.commitments[0]).toMatchObject({ title: "Add payment failure alerts", overdue: true });
      expect((await call("search_memory", { query: "relational data", project: "StudyMate" })).json!.hits.length).toBeGreaterThan(0);
      expect((await call("get_project_summary", { project: "StudyMate" })).json!.areas.length).toBeGreaterThan(2);
      const unknown = await call("get_current_state", { project: "Nope" });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toMatch(/Unknown project "Nope"/);
      const invalid = await client.callTool({ name: "get_decision_evidence", arguments: { option: "PostgreSQL" } });
      expect(invalid.isError).toBe(true);
    });
  });
});
