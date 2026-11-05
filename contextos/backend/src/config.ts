import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as z from "zod";

const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "DATABASE_URL must be a postgres:// URL" }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Host-header allowlist for /mcp (DNS-rebinding protection, mirrors the MCP SDK's
  // hostHeaderValidation). host.docker.internal lets a Dockerised Odysseus reach us.
  MCP_ALLOWED_HOSTS: z
    .string()
    .default("localhost,127.0.0.1,[::1],host.docker.internal")
    .transform((s) => s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
  // Gemini is optional: without a key, extraction uses the labelled deterministic fallback.
  GEMINI_API_KEY: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.1-flash-lite"),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-001"),
  // Shared secret configured on the Odysseus webhook (HMAC-SHA256 of the raw body).
  ODYSSEUS_WEBHOOK_SECRET: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  ODYSSEUS_DEFAULT_PROJECT: z.string().min(1).default("Odysseus Inbox"),
  JOB_WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Parse and validate configuration. Fails fast with every problem listed, so a
 * misconfigured service never starts half-working.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid backend configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Load backend/.env into process.env if present (real env vars take precedence). */
export function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}
