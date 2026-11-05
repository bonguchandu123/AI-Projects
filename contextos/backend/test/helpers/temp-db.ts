/**
 * Real-Postgres test isolation: each test file gets its own throwaway database
 * on the local Docker instance, dropped afterwards. No mocks.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadConfig, loadEnvFile } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";

export interface TempDb {
  url: string;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

export async function createTempDb(): Promise<TempDb> {
  loadEnvFile();
  const baseUrl = loadConfig().DATABASE_URL;
  const name = `contextos_test_${randomBytes(4).toString("hex")}`;

  const admin = new pg.Client({ connectionString: baseUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres at ${baseUrl}. Start it with \`npm run db:up\`. (${String(err)})`,
    );
  }
  // Identifier is generated above from hex only, so interpolation is safe here.
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = createPool({ connectionString: url.toString(), max: 4, applicationName: "contextos-test" });

  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
