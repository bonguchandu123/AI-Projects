import { loadConfig, loadEnvFile } from "../config.js";
import { getMigrationStatus, migrateUp } from "./migrate.js";
import { createPool } from "./pool.js";

const command = process.argv[2];
if (command !== "up" && command !== "status") {
  console.error("usage: migrate-cli <up|status>");
  process.exit(2);
}

loadEnvFile();
const config = loadConfig();
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: 1,
  statementTimeoutMs: 0,
  applicationName: "contextos-migrate",
});

try {
  if (command === "up") {
    const applied = await migrateUp(pool, { log: (m) => console.log(m) });
    console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
  } else {
    const status = await getMigrationStatus(pool);
    for (const a of status.applied) {
      console.log(`applied  ${a.version}_${a.name}  (${a.appliedAt.toISOString()})`);
    }
    for (const p of status.pending) console.log(`pending  ${p.filename}`);
    for (const problem of status.problems) console.log(`PROBLEM  ${problem}`);
    if (status.problems.length) process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
