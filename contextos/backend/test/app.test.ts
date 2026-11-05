import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_SERVER_VERSION, contextosStatusSchema } from "@contextos/mcp-server";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { migrateUp, readMigrationFiles } from "../src/db/migrate.js";
import { createTempDb, type TempDb } from "./helpers/temp-db.js";

const config = { LOG_LEVEL: "silent" as const, MCP_ALLOWED_HOSTS: ["127.0.0.1", "localhost"] };

describe("health endpoints (real Postgres)", () => {
  let db: TempDb;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = await createTempDb(); // deliberately NOT migrated yet
    app = buildApp({ config, pool: db.pool });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it("GET /health is 200 without touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "contextos-backend" });
  });

  it("GET /health/ready is 503 before migrations", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ready: false,
      database: { reachable: true, pgvectorVersion: null, pendingMigrations: (await readMigrationFiles()).length },
    });
  });

  it("GET /health/ready is 200 after migrations", async () => {
    await migrateUp(db.pool);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, database: { reachable: true, pendingMigrations: 0 } });
  });

  it("GET /health/ready is 503 with reachable=false when the database is down", async () => {
    const broken = buildApp({
      config,
      pool: (await import("../src/db/pool.js")).createPool({
        connectionString: "postgres://contextos:wrong@127.0.0.1:1/none",
      }),
    });
    const res = await broken.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ready: false, database: { reachable: false } });
    await broken.close();
  });
});

describe("MCP endpoint over real Streamable HTTP", () => {
  let db: TempDb;
  let app: FastifyInstance;
  let baseUrl: string;
  beforeAll(async () => {
    db = await createTempDb();
    await migrateUp(db.pool);
    app = buildApp({ config, pool: db.pool });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it("an MCP SDK client can initialize, list and call contextos_status", async () => {
    const client = new Client({ name: "contextos-test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "contextos", version: MCP_SERVER_VERSION });

      const { tools } = await client.listTools();
      const status = tools.find((t) => t.name === "contextos_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);

      const result = await client.callTool({ name: "contextos_status", arguments: {} });
      expect(result.isError).toBeFalsy();
      const parsed = contextosStatusSchema.parse(result.structuredContent);
      expect(parsed).toMatchObject({ ready: true, database: { reachable: true, pendingMigrations: 0 } });
    } finally {
      await client.close();
    }
  });

  it("rejects disallowed Host headers with 403 before reading the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { host: "attacker.example", "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 405 for GET /mcp (stateless server)", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp", headers: { host: "127.0.0.1" } });
    expect(res.statusCode).toBe(405);
  });
});
