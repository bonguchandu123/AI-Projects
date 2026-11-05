import type pg from "pg";
import { MCP_SERVER_VERSION, type ContextosStatus } from "@contextos/mcp-server";
import { getMigrationStatus } from "./db/migrate.js";

export const SERVICE_VERSION = MCP_SERVER_VERSION;

/**
 * Single source of truth for "is ContextOS ready?" — used by GET /health/ready
 * and by the MCP `contextos_status` tool. Never throws: failures are reported.
 */
export async function getSystemStatus(pool: pg.Pool, migrationsDir?: string): Promise<ContextosStatus> {
  const checkedAt = new Date().toISOString();
  try {
    await pool.query("SELECT 1");
    const ext = await pool.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const migrations = await getMigrationStatus(pool, migrationsDir);
    const pgvectorVersion = ext.rows[0]?.extversion ?? null;
    const pendingMigrations = migrations.pending.length;
    const problems = migrations.problems;
    return {
      service: "contextos",
      version: SERVICE_VERSION,
      ready: pgvectorVersion !== null && pendingMigrations === 0 && problems.length === 0,
      database: {
        reachable: true,
        pgvectorVersion,
        pendingMigrations,
        ...(problems.length ? { error: problems.join("; ") } : {}),
      },
      checkedAt,
    };
  } catch (err) {
    return {
      service: "contextos",
      version: SERVICE_VERSION,
      ready: false,
      database: {
        reachable: false,
        pgvectorVersion: null,
        pendingMigrations: null,
        error: err instanceof Error ? err.message : String(err),
      },
      checkedAt,
    };
  }
}
