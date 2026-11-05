/**
 * Re-seed the synthetic StudyMate demo directly into the database (no server needed).
 * Uses Gemini if GEMINI_API_KEY is set, otherwise the labelled fallback extractor.
 *   npm run demo:seed
 */
import { createGemini } from "../ai/gemini.js";
import { loadConfig, loadEnvFile } from "../config.js";
import { createPool } from "../db/pool.js";
import { importDemo } from "../services/demo.js";

loadEnvFile();
const config = loadConfig();
const pool = createPool({ connectionString: config.DATABASE_URL, max: 2 });
const gemini = config.GEMINI_API_KEY
  ? createGemini({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL, embeddingModel: config.GEMINI_EMBEDDING_MODEL })
  : null;
const log = { info: () => undefined, warn: (o: object, m?: string) => console.warn(m ?? "", o), error: (o: object, m?: string) => console.error(m ?? "", o) };

try {
  const r = await importDemo({ pool, gemini, log });
  console.log(`StudyMate demo seeded (project ${r.projectId}) — SYNTHETIC DEMONSTRATION DATA`);
  for (const c of r.results) {
    console.log(`  ${c.method.padEnd(8)} ${String(c.memories).padStart(2)} memories${c.geminiError ? `  (Gemini error → fallback: ${c.geminiError})` : ""}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
