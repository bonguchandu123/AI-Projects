import { withTransaction } from "../db/pool.js";
import { DEMO_CONVERSATIONS, DEMO_PROJECT } from "../demo/studymate.js";
import { ConflictError, type ServiceContext } from "./context.js";
import { createConversation, processConversation, type ProcessResult } from "./ingest.js";

/**
 * (Re)import the synthetic StudyMate dataset. Repeatable: an existing demo project
 * is deleted and rebuilt. A non-demo project with the same name is never touched.
 */
export async function importDemo(ctx: ServiceContext): Promise<{ projectId: string; results: ProcessResult[] }> {
  const projectId = await withTransaction(ctx.pool, async (db) => {
    const existing = await db.query<{ id: string; is_demo: boolean }>(
      "SELECT id, is_demo FROM projects WHERE lower(name) = lower($1)",
      [DEMO_PROJECT.name],
    );
    if (existing.rows[0] && !existing.rows[0].is_demo) {
      throw new ConflictError(`A non-demo project named "${DEMO_PROJECT.name}" exists; refusing to overwrite it.`);
    }
    if (existing.rows[0]) await db.query("DELETE FROM projects WHERE id = $1", [existing.rows[0].id]);
    const p = await db.query<{ id: string }>(
      "INSERT INTO projects (name, description, is_demo) VALUES ($1, $2, true) RETURNING id",
      [DEMO_PROJECT.name, DEMO_PROJECT.description],
    );
    const id = p.rows[0]!.id;
    for (const c of DEMO_CONVERSATIONS) {
      await createConversation(db, {
        projectId: id, title: c.title, occurredAt: new Date(c.occurredAt), source: "demo", text: c.text, isDemo: true,
      });
    }
    return id;
  });

  const convs = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE project_id = $1 ORDER BY occurred_at",
    [projectId],
  );
  const results: ProcessResult[] = [];
  for (const c of convs.rows) results.push(await processConversation(ctx, c.id));
  return { projectId, results };
}
