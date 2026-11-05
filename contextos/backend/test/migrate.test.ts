import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getMigrationStatus, migrateUp, readMigrationFiles } from "../src/db/migrate.js";
import { createTempDb, type TempDb } from "./helpers/temp-db.js";

describe("migration runner (real Postgres)", () => {
  let db: TempDb;
  beforeAll(async () => {
    db = await createTempDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("applies the real repository migrations and enables pgvector", async () => {
    const files = await readMigrationFiles();
    expect(files.map((f) => f.filename)).toContain("0001_enable_pgvector.sql");

    expect((await getMigrationStatus(db.pool)).pending.length).toBe(files.length);
    expect(await migrateUp(db.pool)).toEqual(files.map((f) => f.filename));

    const ext = await db.pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);

    // pgvector actually works, not just installed.
    const dist = await db.pool.query<{ d: number }>("SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector AS d");
    expect(dist.rows[0]?.d).toBeCloseTo(Math.SQRT2, 5);
  });

  it("is idempotent", async () => {
    expect(await migrateUp(db.pool)).toEqual([]);
    const status = await getMigrationStatus(db.pool);
    expect(status.pending).toEqual([]);
    expect(status.problems).toEqual([]);
  });
});

describe("migration runner safety (real Postgres, temp migration dirs)", () => {
  let db: TempDb;
  let dir: string;
  beforeEach(async () => {
    db = await createTempDb();
    dir = await mkdtemp(join(tmpdir(), "contextos-mig-"));
  });
  afterEach(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("rolls back a failing migration completely", async () => {
    await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE a (id int);");
    await writeFile(join(dir, "0002_broken.sql"), "CREATE TABLE b (id int);\nSELECT * FROM does_not_exist;");

    await expect(migrateUp(db.pool, { dir })).rejects.toThrow(/0002_broken\.sql failed and was rolled back/);

    const tables = await db.pool.query<{ t: string | null }>(
      "SELECT to_regclass('public.a')::text AS t UNION ALL SELECT to_regclass('public.b')::text",
    );
    expect(tables.rows.map((r) => r.t)).toEqual(["a", null]); // 0001 kept, 0002 fully undone
    const status = await getMigrationStatus(db.pool, dir);
    expect(status.applied.map((a) => a.version)).toEqual(["0001"]);
    expect(status.pending.map((p) => p.filename)).toEqual(["0002_broken.sql"]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    await writeFile(join(dir, "0001_init.sql"), "CREATE TABLE a (id int);");
    await migrateUp(db.pool, { dir });
    await writeFile(join(dir, "0001_init.sql"), "CREATE TABLE a (id bigint);");

    expect((await getMigrationStatus(db.pool, dir)).problems).toEqual([
      "Migration 0001_init.sql was modified after being applied",
    ]);
    await expect(migrateUp(db.pool, { dir })).rejects.toThrow(/Refusing to migrate/);
  });

  it("treats CRLF and LF versions of a file as identical", async () => {
    await writeFile(join(dir, "0001_init.sql"), "CREATE TABLE a (id int);\n");
    await migrateUp(db.pool, { dir });
    await writeFile(join(dir, "0001_init.sql"), "CREATE TABLE a (id int);\r\n");
    expect((await getMigrationStatus(db.pool, dir)).problems).toEqual([]);
  });

  it("rejects badly named migration files", async () => {
    await writeFile(join(dir, "init.sql"), "SELECT 1;");
    await expect(readMigrationFiles(dir)).rejects.toThrow(/Invalid migration filename/);
  });
});
