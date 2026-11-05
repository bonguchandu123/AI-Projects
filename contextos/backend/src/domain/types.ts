import * as z from "zod";

export const COMMITMENT_STATUSES = [
  "NONE", "PROPOSED", "DECIDED", "REJECTED", "CANCELLED", "REVERSED", "SUPERSEDED",
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export const IMPLEMENTATION_STATUSES = ["NOT_STARTED", "CLAIMED_IMPLEMENTED", "VERIFIED", "RETIRED"] as const;
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];

export const MEMORY_KINDS = [
  "fact", "proposal", "decision", "rejection", "cancellation", "reversal",
  "in_use", "implementation_claim", "verification",
  "commitment", "commitment_done", "commitment_cancelled",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Kinds that act on a decision option (subject + option required). */
export const DECISION_KINDS: ReadonlySet<MemoryKind> = new Set([
  "proposal", "decision", "rejection", "cancellation", "reversal", "in_use", "implementation_claim", "verification",
]);
export const COMMITMENT_KINDS: ReadonlySet<MemoryKind> = new Set(["commitment", "commitment_done", "commitment_cancelled"]);

export const ENTITY_KINDS = ["technology", "component", "person", "organization", "concept", "other"] as const;

/**
 * Contract every extractor (Gemini or deterministic fallback) must satisfy.
 * The extractor only DESCRIBES what the text says; it never decides state.
 */
export const extractionItemSchema = z.object({
  kind: z.enum(MEMORY_KINDS).describe(
    "proposal = suggested/considered/planned, NOT decided. decision = explicitly decided/chosen/agreed. " +
      "rejection = explicitly rejected/ruled out. cancellation = a previous decision called off before implementation. " +
      "reversal = a decision undone after implementation. in_use = statement that something is currently used. " +
      "implementation_claim = someone says it was implemented/migrated/deployed (NOT proof). " +
      "verification = tested/confirmed/observed working (proof). commitment = someone will do a task. " +
      "commitment_done / commitment_cancelled = a task finished / called off. fact = other durable project fact.",
  ),
  summary: z.string().min(3).max(300).describe("One neutral sentence describing the item."),
  excerpt: z.string().min(3).max(600).describe("VERBATIM quote copied from the message text. Never paraphrase."),
  message_index: z.number().int().min(0).describe("0-based index of the message the excerpt comes from."),
  subject_key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(40)
    .nullable()
    .describe("Decision slot in snake_case, e.g. database, cache, hosting, payments, api_style. Null for commitments/facts."),
  subject_label: z.string().max(60).nullable().describe("Human label for the slot, e.g. 'Primary database'."),
  option: z.string().max(80).nullable().describe("Canonical product/approach name, e.g. 'PostgreSQL'."),
  previous_option: z.string().max(80).nullable().describe("Option being replaced, if the text says so (e.g. 'from MongoDB')."),
  replaces_previous: z.boolean().describe("True only if the text explicitly replaces/migrates away from previous_option."),
  reason: z.string().max(300).nullable().describe("Why, if the text states a reason. Null otherwise."),
  commitment_title: z.string().max(160).nullable(),
  commitment_owner: z.string().max(80).nullable(),
  commitment_due: z.string().max(40).nullable().describe("ISO date (YYYY-MM-DD) if a due date is stated."),
  speaker_role: z.enum(["user", "assistant", "system", "unknown"]),
  hedged: z.boolean().describe("True if the statement is uncertain (maybe, might, I think, probably)."),
  confidence: z.number().min(0).max(1),
});
export type ExtractionItem = z.infer<typeof extractionItemSchema>;

export const extractionResultSchema = z.object({
  items: z.array(extractionItemSchema).max(60),
  entities: z
    .array(z.object({ name: z.string().min(1).max(80), kind: z.enum(ENTITY_KINDS) }))
    .max(60),
  relationships: z
    .array(
      z.object({
        source: z.string().min(1).max(80),
        predicate: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
        target: z.string().min(1).max(80),
        message_index: z.number().int().min(0),
        excerpt: z.string().min(3).max(600),
      }),
    )
    .max(60),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export type ExtractionMethod = "gemini" | "fallback";

export interface ParsedMessage {
  seq: number;
  role: "user" | "assistant" | "system" | "unknown";
  speaker: string | null;
  content: string;
}
