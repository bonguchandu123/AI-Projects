import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { createGemini, type GeminiClient } from "./ai/gemini.js";
import type { AppConfig } from "./config.js";
import { createMcpDeps } from "./mcp/adapters.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { ServiceContext } from "./services/context.js";
import { getSystemStatus } from "./status.js";

type OptionalKeys =
  | "GEMINI_API_KEY" | "GEMINI_MODEL" | "GEMINI_EMBEDDING_MODEL" | "ODYSSEUS_WEBHOOK_SECRET"
  | "ODYSSEUS_DEFAULT_PROJECT" | "JOB_WORKER_ENABLED";

export interface AppDeps {
  config: Pick<AppConfig, "LOG_LEVEL" | "MCP_ALLOWED_HOSTS"> & Partial<Pick<AppConfig, OptionalKeys>>;
  pool: pg.Pool;
  migrationsDir?: string;
  /** Override for tests; by default created from GEMINI_API_KEY. */
  gemini?: GeminiClient | null;
  now?: () => number;
}

/** Build the Fastify app without listening, so tests can use app.inject(). */
export function buildApp(deps: AppDeps): FastifyInstance & { services: ServiceContext } {
  const app = Fastify({
    logger: { level: deps.config.LOG_LEVEL },
    bodyLimit: 1_048_576,
  });
  const c = deps.config;

  const gemini =
    deps.gemini !== undefined
      ? deps.gemini
      : c.GEMINI_API_KEY
        ? createGemini({
            apiKey: c.GEMINI_API_KEY,
            model: c.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
            embeddingModel: c.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001",
          })
        : null;
  const services: ServiceContext = {
    pool: deps.pool,
    gemini,
    log: {
      info: (o, m) => app.log.info(o, m),
      warn: (o, m) => app.log.warn(o, m),
      error: (o, m) => app.log.error(o, m),
    },
  };

  // Safe errors: client errors keep their message, server errors never leak internals.
  app.setErrorHandler((err: { statusCode?: number; message?: string }, request, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err }, "unhandled error");
    return reply.code(status).send({
      error: status >= 500 ? "Internal Server Error" : (err.message ?? "Bad Request"),
      statusCode: status,
    });
  });

  const healthDeps = deps.migrationsDir
    ? { pool: deps.pool, migrationsDir: deps.migrationsDir }
    : { pool: deps.pool };
  registerHealthRoutes(app, healthDeps);
  registerMcpRoutes(app, {
    allowedHosts: c.MCP_ALLOWED_HOSTS,
    mcp: { ...createMcpDeps(services), getStatus: () => getSystemStatus(deps.pool, deps.migrationsDir) },
  });
  registerApiRoutes(app, {
    ctx: services,
    info: {
      geminiModel: c.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
      geminiEmbeddingModel: c.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001",
      webhookSecretConfigured: Boolean(c.ODYSSEUS_WEBHOOK_SECRET),
      workerEnabled: c.JOB_WORKER_ENABLED ?? false,
      mcpAllowedHosts: c.MCP_ALLOWED_HOSTS,
    },
  });
  registerWebhookRoutes(app, {
    ctx: services,
    secret: c.ODYSSEUS_WEBHOOK_SECRET,
    defaultProject: c.ODYSSEUS_DEFAULT_PROJECT ?? "Odysseus Inbox",
    ...(deps.now ? { now: deps.now } : {}),
  });

  return Object.assign(app, { services });
}
