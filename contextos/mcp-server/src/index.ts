/**
 * ContextOS MCP tool definitions.
 *
 * This package owns the MCP *contract* (tool names, schemas, descriptions) and
 * nothing else. It never touches the database: the backend injects the
 * capabilities it needs through `ContextosMcpDeps`, and mounts the resulting
 * server on its Streamable HTTP endpoint. That keeps one process (modular
 * monolith) while keeping MCP concerns out of the domain code.
 *
 * Every tool returns a structured "context packet" (JSON) built from the
 * deterministic decision projection — not a generated answer — so the calling
 * agent (e.g. Odysseus) writes the reply and can cite the evidence.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

export const MCP_SERVER_NAME = "contextos";
export const MCP_SERVER_VERSION = "0.2.0";

export const contextosStatusSchema = z.object({
  service: z.literal("contextos"),
  version: z.string(),
  ready: z.boolean(),
  database: z.object({
    reachable: z.boolean(),
    pgvectorVersion: z.string().nullable(),
    pendingMigrations: z.number().int().nullable(),
    error: z.string().optional(),
  }),
  checkedAt: z.string(),
});

export type ContextosStatus = z.infer<typeof contextosStatusSchema>;

const project = z.string().trim().min(1).max(120).describe("Project name (e.g. 'StudyMate') or project id.");
const optionalProject = project.optional().describe("Project name or id. Omit for all projects.");
const subject = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .optional()
  .describe("Decision area, e.g. 'database', 'hosting', 'payments', 'cache'. Omit for all areas.");

export const toolInputs = {
  search_memory: z.object({
    query: z.string().trim().min(2).max(300).describe("What to look for in project memory."),
    project: optionalProject,
    limit: z.number().int().min(1).max(20).default(8),
  }),
  get_current_state: z.object({ project, subject }),
  get_decision_history: z.object({
    project,
    subject,
    option: z.string().trim().min(1).max(80).optional().describe("A specific option, e.g. 'PostgreSQL'."),
  }),
  get_decision_evidence: z
    .object({
      project: project.optional(),
      option: z.string().trim().min(1).max(80).optional().describe("Option name, e.g. 'PostgreSQL' (needs project)."),
      decision_id: z.uuid().optional(),
    })
    .refine((v) => v.decision_id || (v.project && v.option), "Provide decision_id, or project and option."),
  get_pending_commitments: z.object({ project: optionalProject }),
  get_unverified_claims: z.object({ project: optionalProject }),
  get_project_summary: z.object({ project }),
} as const;

export type ToolInput<K extends keyof typeof toolInputs> = z.infer<(typeof toolInputs)[K]>;

/** Capabilities the backend provides to the MCP layer. */
export interface ContextosMcpDeps {
  getStatus: () => Promise<ContextosStatus>;
  searchMemory: (input: ToolInput<"search_memory">) => Promise<unknown>;
  getCurrentState: (input: ToolInput<"get_current_state">) => Promise<unknown>;
  getDecisionHistory: (input: ToolInput<"get_decision_history">) => Promise<unknown>;
  getDecisionEvidence: (input: ToolInput<"get_decision_evidence">) => Promise<unknown>;
  getPendingCommitments: (input: ToolInput<"get_pending_commitments">) => Promise<unknown>;
  getUnverifiedClaims: (input: ToolInput<"get_unverified_claims">) => Promise<unknown>;
  getProjectSummary: (input: ToolInput<"get_project_summary">) => Promise<unknown>;
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

function packet(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function guarded(fn: () => Promise<unknown>) {
  try {
    return packet(await fn());
  } catch (err) {
    // Expected errors (unknown project, etc.) are reported to the agent, not thrown.
    return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
  }
}

/**
 * Build a fresh MCP server instance. Stateless Streamable HTTP creates one per
 * request (SDK-recommended pattern), so this must stay cheap: no I/O here.
 */
export function createContextosMcpServer(deps: ContextosMcpDeps): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    "contextos_status",
    {
      title: "ContextOS status",
      description:
        "Report whether the ContextOS memory service and its database are reachable and ready. " +
        "Use this to check the connection before relying on other ContextOS tools.",
      outputSchema: contextosStatusSchema,
      annotations: READ_ONLY,
    },
    async () => {
      const status = await deps.getStatus();
      return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
    },
  );

  server.registerTool(
    "get_current_state",
    {
      title: "Current project state",
      description:
        "Authoritative CURRENT state of a project's decisions (e.g. which database is in use now), computed from the " +
        "decision lifecycle — not from text similarity. Distinguishes verified vs merely claimed implementations, " +
        "pending decisions, open proposals, superseded history, and open conflicts. Includes evidence excerpts and dates. " +
        "Call this before answering any question about what a project currently uses or has decided.",
      inputSchema: toolInputs.get_current_state,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.getCurrentState(input)),
  );

  server.registerTool(
    "get_decision_history",
    {
      title: "Decision history",
      description:
        "Chronological lifecycle of decisions for a project (proposed → decided → implemented → verified, plus " +
        "rejected / cancelled / superseded / conflicts), each step with the conversation excerpt that caused it. " +
        "Use for 'why', 'what changed', 'what was the original decision' questions.",
      inputSchema: toolInputs.get_decision_history,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.getDecisionHistory(input)),
  );

  server.registerTool(
    "get_decision_evidence",
    {
      title: "Decision evidence",
      description:
        "All stored evidence (verbatim excerpts, source conversation, date, extraction method) behind one decision option.",
      inputSchema: toolInputs.get_decision_evidence,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.getDecisionEvidence(input)),
  );

  server.registerTool(
    "get_pending_commitments",
    {
      title: "Pending commitments",
      description: "Open (unresolved) commitments/action items with owner, due date and whether they are overdue.",
      inputSchema: toolInputs.get_pending_commitments,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.getPendingCommitments(input)),
  );

  server.registerTool(
    "get_unverified_claims",
    {
      title: "Unverified implementation claims",
      description:
        "Options someone claimed were implemented but that have no verification evidence yet. Treat these as unconfirmed.",
      inputSchema: toolInputs.get_unverified_claims,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.getUnverifiedClaims(input)),
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search project memory",
      description:
        "Hybrid search (full-text, plus semantic when embeddings exist) over extracted project memories. Each hit includes " +
        "its lifecycle kind and source excerpt. For current-state questions prefer get_current_state.",
      inputSchema: toolInputs.search_memory,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.searchMemory(input)),
  );

  server.registerTool(
    "get_project_summary",
    {
      title: "Project memory summary",
      description:
        "Compact summary of a project: current state per decision area, counts, unverified claims, open commitments and open conflicts.",
      inputSchema: toolInputs.get_project_summary,
      annotations: READ_ONLY,
    },
    (input) => guarded(() => deps.getProjectSummary(input)),
  );

  return server;
}
