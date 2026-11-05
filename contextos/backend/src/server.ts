import { buildApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { createPool } from "./db/pool.js";
import { startWorker } from "./jobs/worker.js";
import { getSystemStatus } from "./status.js";

loadEnvFile();
const config = loadConfig();

const pool = createPool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });
const app = buildApp({ config, pool });
pool.on("error", (err) => app.log.error({ err }, "idle database client error"));
const stopWorker = config.JOB_WORKER_ENABLED ? startWorker(app.services) : () => Promise.resolve();
app.log.info(
  { gemini: app.services.gemini ? config.GEMINI_MODEL : "not configured (deterministic fallback)", webhookSecret: Boolean(config.ODYSSEUS_WEBHOOK_SECRET) },
  "extraction mode",
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await stopWorker();
    await app.close();
    await pool.end();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });

// Start even if the database is not ready, but say so loudly: /health/ready reports it too.
const status = await getSystemStatus(pool);
if (status.ready) {
  app.log.info({ pgvector: status.database.pgvectorVersion }, "database ready");
} else {
  app.log.warn({ database: status.database }, "database NOT ready — run `npm run db:up` and `npm run db:migrate`");
}
