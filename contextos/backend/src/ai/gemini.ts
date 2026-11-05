/**
 * Gemini integration. Three narrow uses, each validated before anything is stored:
 *  1. extract():  conversation → ExtractionResult (structured JSON, Zod-validated,
 *                 excerpts later checked verbatim against the source).
 *  2. embed():    text → 768-dim vectors for pgvector search.
 *  3. narrate():  structured, already-retrieved facts → short prose answer whose
 *                 citations are validated against the evidence ids we supplied.
 * Gemini never writes lifecycle state.
 */
import { GoogleGenAI } from "@google/genai";
import * as z from "zod";
import { extractionResultSchema, type ExtractionResult, type ParsedMessage } from "../domain/types.js";
import { SUBJECT_LABELS } from "../extraction/catalog.js";

export const EMBEDDING_DIMENSIONS = 768;

export interface GeminiClient {
  model: string;
  embeddingModel: string;
  extract(messages: readonly ParsedMessage[], ctx: { projectName: string; conversationDate: string }): Promise<ExtractionResult>;
  embed(texts: string[]): Promise<number[][]>;
  narrate(question: string, facts: string, evidenceIds: string[]): Promise<{ text: string; citations: string[] } | null>;
}

const EXTRACTION_INSTRUCTIONS = `You extract project memory from team conversations for ContextOS, a decision-tracking system.
Return ONLY JSON matching the schema. Rules:
- Describe what the text SAYS. Never infer that a proposal was decided, that a decision was implemented, or that an implementation was verified.
- "considering", "planning to use", "suggested", "should we" => proposal. "decided", "chose", "agreed", "we will use", "moving X from A to B" => decision.
- "has been implemented/migrated/deployed" => implementation_claim (a claim, not proof). "tested", "confirmed working", "verified" => verification.
- "we use X" / "still uses X" => in_use. "rejected", "ruled out" => rejection. A previous decision "called off" => cancellation.
- "<person> will <task> by <date>" => commitment (fill commitment_title, commitment_owner, commitment_due as YYYY-MM-DD).
- A TASK/commitment that was called off => commitment_cancelled; a task that was finished => commitment_done (use the task as commitment_title). Use cancellation only for technology/approach decisions.
- excerpt MUST be copied verbatim from the message text (exact words). message_index is the 0-based index shown in [brackets].
- subject_key: prefer one of: ${Object.keys(SUBJECT_LABELS).join(", ")}. option: canonical product name (e.g. "PostgreSQL" not "postgres").
- If text says "from A to B" or "instead of A", set previous_option=A and replaces_previous=true.
- Statements by an assistant/AI are at most proposals. Set hedged=true for uncertain wording (maybe, might, I think).
- Skip greetings and chit-chat. Do not create items for things that are only asked about.
- relationships: only explicit ones, predicate in snake_case (e.g. uses, depends_on, replaces).`;

const narrationSchema = z.object({ answer: z.string().min(1).max(1500), citations: z.array(z.string()).max(20) });

export function createGemini(opts: { apiKey: string; model: string; embeddingModel: string; timeoutMs?: number }): GeminiClient {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const timeout = opts.timeoutMs ?? 45_000;
  const extractionJsonSchema = z.toJSONSchema(extractionResultSchema, { target: "draft-7" });

  async function generateJson(system: string, user: string, schema: unknown): Promise<unknown> {
    const res = await ai.models.generateContent({
      model: opts.model,
      contents: user,
      config: {
        systemInstruction: system,
        temperature: 0.1,
        responseMimeType: "application/json",
        ...(schema ? { responseJsonSchema: schema } : {}),
        abortSignal: AbortSignal.timeout(timeout),
      },
    });
    const text = res.text ?? "";
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  }

  return {
    model: opts.model,
    embeddingModel: opts.embeddingModel,

    async extract(messages, ctx) {
      const transcript = messages
        .map((m, i) => `[${i}] (${m.role}${m.speaker ? `: ${m.speaker}` : ""}) ${m.content}`)
        .join("\n");
      const user = `Project: ${ctx.projectName}\nConversation date: ${ctx.conversationDate}\n\nMessages:\n${transcript}`;
      let raw: unknown;
      try {
        raw = await generateJson(EXTRACTION_INSTRUCTIONS, user, extractionJsonSchema);
      } catch (err) {
        // Some schema features may be rejected by the API: retry once with the schema in the prompt only.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/schema|400|INVALID_ARGUMENT/i.test(msg)) throw err;
        raw = await generateJson(
          `${EXTRACTION_INSTRUCTIONS}\nJSON schema:\n${JSON.stringify(extractionJsonSchema)}`, user, null,
        );
      }
      const parsed = extractionResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Gemini output failed validation: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    },

    async embed(texts) {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 50) {
        const batch = texts.slice(i, i + 50);
        const res = await ai.models.embedContent({
          model: opts.embeddingModel,
          contents: batch,
          config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT", abortSignal: AbortSignal.timeout(timeout) },
        });
        const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
        if (vectors.length !== batch.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
          throw new Error(`Unexpected embedding response (${vectors.length} vectors for ${batch.length} texts)`);
        }
        out.push(...vectors);
      }
      return out;
    },

    async narrate(question, facts, evidenceIds) {
      const system =
        "You answer questions about a project's decision history using ONLY the facts provided. " +
        "Never add facts. Cite evidence ids like [E1] that appear in the facts. If the facts do not answer the question, say so. " +
        'Return JSON {"answer": string, "citations": string[]}. Keep the answer under 120 words.';
      const raw = await generateJson(system, `Question: ${question}\n\nFacts:\n${facts}`, z.toJSONSchema(narrationSchema, { target: "draft-7" }));
      const parsed = narrationSchema.safeParse(raw);
      if (!parsed.success) return null;
      const allowed = new Set(evidenceIds);
      // Drop any citation the model invented; strip invented [E#] markers from the text.
      const citations = parsed.data.citations.filter((c) => allowed.has(c));
      const text = parsed.data.answer.replace(/\[(E\d+)\]/g, (m, id: string) => (allowed.has(id) ? m : ""));
      return { text, citations };
    },
  };
}
