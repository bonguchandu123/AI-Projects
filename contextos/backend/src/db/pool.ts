import pg from "pg";
import type { PoolClient } from "pg";

export interface PoolOptions {
  connectionString: string;
  max?: number;
  /** Per-statement timeout in ms; 0 disables it (used by migrations). */
  statementTimeoutMs?: number;
  applicationName?: string;
  onIdleError?: (err: Error) => void;
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: opts.applicationName ?? "contextos-backend",
  });
  // An idle client can error (e.g. Postgres restarts). Without a listener the
  // 'error' event crashes the process.
  pool.on("error", (err) => opts.onIdleError?.(err));
  return pool;
}

/**
 * Run `fn` inside a transaction on a dedicated client. Commits on success,
 * rolls back on any error and rethrows it. The client is always released.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection is already broken; the original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}
