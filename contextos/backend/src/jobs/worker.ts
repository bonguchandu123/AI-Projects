/**
 * Postgres-backed job worker (no Redis). Claims one job at a time with
 * FOR UPDATE SKIP LOCKED, so several workers could run safely. Failed jobs are
 * retried with backoff up to MAX_ATTEMPTS.
 */
import type { ServiceContext } from "../services/context.js";
import { processConversation } from "../services/ingest.js";

const MAX_ATTEMPTS = 3;

interface JobRow {
  id: string;
  kind: "process_conversation";
  payload: { conversationId: string; webhookEventId?: string };
  attempts: number;
}

export async function runOneJob(ctx: ServiceContext): Promise<boolean> {
  const claimed = await ctx.pool.query<JobRow>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, payload, attempts`,
  );
  const job = claimed.rows[0];
  if (!job) return false;
  try {
    await processConversation(ctx, job.payload.conversationId);
    await ctx.pool.query("UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1", [job.id]);
    if (job.payload.webhookEventId) {
      await ctx.pool.query("UPDATE webhook_events SET status = 'processed', error = NULL WHERE id = $1", [job.payload.webhookEventId]);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < MAX_ATTEMPTS;
    await ctx.pool.query(
      `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
      [job.id, retry ? "queued" : "failed", msg, String(10 * job.attempts)],
    );
    if (!retry && job.payload.webhookEventId) {
      await ctx.pool.query("UPDATE webhook_events SET status = 'failed', error = $2 WHERE id = $1", [job.payload.webhookEventId, msg]);
    }
    ctx.log.error({ jobId: job.id, err: msg, retry }, "job failed");
  }
  return true;
}

export function startWorker(ctx: ServiceContext, intervalMs = 1000): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    while (!stopped && (await runOneJob(ctx))) {
      /* drain the queue */
    }
  };
  const timer = setInterval(() => {
    running = running.then(tick).catch((err: unknown) => ctx.log.error({ err: String(err) }, "worker tick failed"));
  }, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
