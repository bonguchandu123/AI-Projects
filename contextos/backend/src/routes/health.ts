import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { SERVICE_VERSION, getSystemStatus } from "../status.js";

export function registerHealthRoutes(app: FastifyInstance, deps: { pool: pg.Pool; migrationsDir?: string }) {
  // Liveness: the process is up. Never touches the database.
  app.get("/health", () => ({
    status: "ok",
    service: "contextos-backend",
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  // Readiness: database reachable, pgvector installed, no pending migrations.
  app.get("/health/ready", async (_request, reply) => {
    const status = await getSystemStatus(deps.pool, deps.migrationsDir);
    return reply.code(status.ready ? 200 : 503).send(status);
  });
}
