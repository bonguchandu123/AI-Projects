/**
 * Minimal forward-only SQL migration runner (no ORM, no third-party migrator).
 *
 * - Files: database/migrations/NNNN_snake_case_name.sql, applied in version order.
 * - Each file runs in its own transaction together with its bookkeeping row,
 *   so a failed migration leaves no partial state.
 * - A Postgres advisory lock serialises concurrent runners.
 * - Applied files are checksummed; editing an applied migration is an error
 *   (write a new migration instead). Line endings are normalised first so a
 *   Windows CRLF checkout does not look like an edit.
 * - Limitation: statements that cannot run inside a transaction
 *   (e.g. CREATE INDEX CONCURRENTLY) are not supported.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../database/migrations/", import.meta.url),
);

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Arbitrary constant identifying "ContextOS migrations" in pg_advisory_lock.
const ADVISORY_LOCK_KEY = 726_504_001;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  /** Applied versions whose file changed or disappeared. Any entry here is an error. */
  problems: string[];
}

export async function readMigrationFiles(dir = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const filename of entries) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Invalid migration filename "${filename}" (expected NNNN_snake_case.sql)`);
    }
    const version = match[1];
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = (await readFile(join(dir, filename), "utf8")).replace(/\r\n/g, "\n");
    files.push({
      version,
      name: match[2],
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return files;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text        PRIMARY KEY,
    name       text        NOT NULL,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

async function readApplied(db: pg.Pool | pg.PoolClient): Promise<AppliedMigration[]> {
  const exists = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (!exists.rows[0]?.present) return [];
  const res = await db.query<{ version: string; name: string; checksum: string; applied_at: Date }>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  );
  return res.rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

function compare(files: MigrationFile[], applied: AppliedMigration[]): MigrationStatus {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const appliedVersions = new Set(applied.map((a) => a.version));
  const problems: string[] = [];
  for (const a of applied) {
    const file = byVersion.get(a.version);
    if (!file) problems.push(`Applied migration ${a.version}_${a.name} has no file on disk`);
    else if (file.checksum !== a.checksum) {
      problems.push(`Migration ${file.filename} was modified after being applied`);
    }
  }
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  const lastApplied = applied.at(-1)?.version;
  for (const p of pending) {
    if (lastApplied && p.version < lastApplied) {
      problems.push(`Migration ${p.filename} is older than already-applied ${lastApplied}`);
    }
  }
  return { applied, pending, problems };
}

export async function getMigrationStatus(
  pool: pg.Pool,
  dir = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationStatus> {
  const [files, applied] = await Promise.all([readMigrationFiles(dir), readApplied(pool)]);
  return compare(files, applied);
}

export async function migrateUp(
  pool: pg.Pool,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const files = await readMigrationFiles(opts.dir);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(CREATE_TABLE_SQL);
      const status = compare(files, await readApplied(client));
      if (status.problems.length > 0) {
        throw new Error(`Refusing to migrate:\n- ${status.problems.join("\n- ")}`);
      }
      const done: string[] = [];
      for (const m of status.pending) {
        log(`applying ${m.filename}`);
        await client.query("BEGIN");
        try {
          await client.query(m.sql);
          await client.query(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
            [m.version, m.name, m.checksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Migration ${m.filename} failed and was rolled back: ${reason}`, {
            cause: err,
          });
        }
        done.push(m.filename);
      }
      return done;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
