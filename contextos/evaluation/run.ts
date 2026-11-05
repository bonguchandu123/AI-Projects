/**
 * ContextOS × Odysseus evaluation runner.
 *
 *   npx tsx evaluation/run.ts --phase A     Odysseus alone (native memory loaded with the StudyMate history)
 *   npx tsx evaluation/run.ts --phase B     Odysseus + ContextOS MCP (native memory off)
 *   npx tsx evaluation/run.ts --phase C     ContextOS direct (/api/memory/query, deterministic reference)
 *   npx tsx evaluation/run.ts --report      Combine results/*.json into results/REPORT.md + summary.json
 *   npx tsx evaluation/run.ts --cleanup     Remove the labelled baseline memories from Odysseus
 *
 * Same questions, same Odysseus agent, same model (ODYSSEUS_MODEL) for A and B.
 * Tokens are Odysseus's own measurements (stream `metrics.usage_buckets`, cross-checked
 * against its per-session counters). Grading is deterministic (grader.ts).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grade, type Grade } from "./grader.js";
import { TEST_CASES, type TestCase } from "./test-cases.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
if (existsSync(join(HERE, ".env"))) process.loadEnvFile(join(HERE, ".env"));
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (!v) throw new Error(`Missing ${k} in evaluation/.env`);
  return v;
};
const ODY = env("ODYSSEUS_URL", "http://127.0.0.1:7011");
const TOKEN = env("ODYSSEUS_API_TOKEN");
// Odysseus hides ALL MCP tools from agent runs authenticated by an API token (delegated credential,
// src/tool_security.py). A browser session cookie runs as the real admin user, like the UI does.
const SESSION_COOKIE = (process.env.ODYSSEUS_SESSION_COOKIE ?? "").trim();
const AUTH_HEADERS: Record<string, string> = SESSION_COOKIE ? { Cookie: `odysseus_session=${SESSION_COOKIE}` } : { Authorization: `Bearer ${TOKEN}` };
const AUTH_MODE = SESSION_COOKIE ? "browser session" : "API token (MCP tools blocked by Odysseus)";
const ENDPOINT_ID = env("ODYSSEUS_ENDPOINT_ID");
const MODEL = env("ODYSSEUS_MODEL");
const OWNER = env("ODYSSEUS_OWNER", "admin");
const CONTAINER = env("ODYSSEUS_CONTAINER", "odysseus-odysseus-1");
const COS = env("CONTEXTOS_URL", "http://127.0.0.1:4000");
const QUESTION_TIMEOUT_MS = 240_000;

// Questions are sent exactly as written (no extra instructions) in both phases.
const PREFIX = "";
// B: the agent only reliably routes to an MCP integration when the request names it
// (Odysseus tool routing). A needs no instruction: chat mode injects native memory automatically.
const B_PREFIX = "";
// A uses chat mode: Odysseus injects saved memories there (in this build agent mode does not).
// B uses agent mode: required for MCP tool calls.
const MODE: Record<"A" | "B", "chat" | "agent"> = { A: "chat", B: "agent" };

/** Baseline memories for phase A: every StudyMate statement, dated (a generous best case for Odysseus). */
const BASELINE_MEMORIES = [
  "[12 Jan 2026] StudyMate: Initially, we are planning to use MongoDB because it is easy to integrate with our Node.js backend.",
  "[12 Jan 2026] StudyMate: We decided to deploy the backend on Heroku because the free tier is enough for the beta.",
  "[12 Jan 2026] StudyMate: Arjun will build the public API documentation portal by the end of February.",
  "[9 Feb 2026] StudyMate: We are considering PostgreSQL because we need relational data and stronger consistency.",
  "[9 Feb 2026] StudyMate: Someone suggested adding Redis as a cache for session data.",
  "[9 Feb 2026] StudyMate: We rejected Redis because our traffic is low and it adds operational overhead.",
  "[3 Mar 2026] StudyMate: After comparing both databases, we have decided to migrate StudyMate from MongoDB to PostgreSQL because of relational data requirements.",
  "[3 Mar 2026] StudyMate: Priya will write the data migration runbook by March 20.",
  "[3 Mar 2026] StudyMate: We decided to use Stripe for subscription payments because it supports student discounts.",
  "[18 Mar 2026] StudyMate: We are moving hosting from Heroku to Render because Render's pricing is predictable for our usage.",
  "[18 Mar 2026] StudyMate: We cancelled the API documentation portal task because the public beta was postponed.",
  "[14 Apr 2026] StudyMate: The PostgreSQL migration has been implemented.",
  "[14 Apr 2026] StudyMate: The Stripe payment integration has been implemented.",
  "[20 May 2026] StudyMate: We tested the application and confirmed that PostgreSQL is running successfully in production.",
  "[20 May 2026] StudyMate: Priya finished the data migration runbook.",
  "[20 May 2026] StudyMate: Ravi will add payment failure alerts by June 15.",
  "[2 Jun 2026] StudyMate: StudyMate still stores user data in MongoDB.",
];

interface CaseResult {
  id: string;
  category: string;
  question: string;
  answer: string;
  grade: Grade;
  inputTokens: number;
  outputTokens: number;
  sessionInputTokens: number | null;
  sessionOutputTokens: number | null;
  rounds: number;
  toolCalls: string[];
  contextosToolCalls: number;
  approvals?: number;
  latencyMs: number;
  sessionId: string | null;
  error: string | null;
}

interface PhaseResult {
  phase: "A" | "B" | "C";
  label: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  notes: string[];
  cases: CaseResult[];
}

// ── Odysseus helpers ────────────────────────────────────────────────────────

function admin(...args: string[]): Record<string, unknown> {
  const script = readFileSync(join(HERE, "odysseus_admin.py"));
  const out = execFileSync("docker", ["exec", "-i", "-w", "/app", CONTAINER, "python", "-", ...args], {
    input: script,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  if (!line) throw new Error(`odysseus_admin ${args[0]} returned no JSON: ${out.slice(0, 300)}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function ody(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${ODY}${path}`, { ...init, headers: { ...AUTH_HEADERS, ...(init.headers ?? {}) } });
}

async function createSession(name: string): Promise<string> {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("endpoint_id", ENDPOINT_ID);
  fd.append("model", MODEL);
  const r = await ody("/api/session", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`create session failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

async function setMemoryInjection(sessionId: string, enabled: boolean): Promise<void> {
  const r = await ody(`/api/session/${sessionId}/memory-injection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`memory-injection failed: ${r.status} ${await r.text()}`);
}

interface StreamOutcome {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  rounds: number;
  toolCalls: string[];
  offeredTools: string[];
  approvals: number;
}

interface ParsedStream extends Omit<StreamOutcome, "approvals"> {
  approval: { id: string; decision: string } | null;
}

function parseStream(text: string): ParsedStream {
  const deltas = new Map<number, string>();
  let finalResponse: string | null = null;
  let metrics: Record<string, unknown> | null = null;
  const toolCalls: string[] = [];
  let offeredTools: string[] = [];
  let approval: ParsedStream["approval"] = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof ev.delta === "string") {
      const round = typeof ev.round === "number" ? ev.round : 0;
      deltas.set(round, (deltas.get(round) ?? "") + ev.delta);
    }
    const choice = (ev.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content;
    if (typeof choice === "string") deltas.set(0, (deltas.get(0) ?? "") + choice);
    if (ev.type === "final_response" && typeof ev.content === "string") finalResponse = ev.content;
    if (ev.type === "tool_start" && typeof ev.tool === "string") toolCalls.push(ev.tool);
    if (ev.type === "metrics" && ev.data && typeof ev.data === "object") metrics = ev.data as Record<string, unknown>;
    if (ev.type === "turn_contract" && Array.isArray(ev.executable)) offeredTools = ev.executable as string[];
    if (ev.type === "ask_user" && ev.data && typeof ev.data === "object") {
      const d = ev.data as { kind?: string; approval_id?: string; options?: { value?: string }[] };
      const decision = d.options?.[0]?.value;
      if (d.kind === "tool_approval" && d.approval_id && decision) approval = { id: d.approval_id, decision };
    }
  }
  const roundTexts = Array.isArray(metrics?.round_texts) ? (metrics.round_texts as string[]) : [];
  const lastRound = [...deltas.keys()].sort((a, b) => b - a)[0];
  const answer =
    finalResponse ?? [...roundTexts].reverse().find((t) => t && t.trim()) ?? (lastRound !== undefined ? deltas.get(lastRound) ?? "" : "");
  const buckets = Array.isArray(metrics?.usage_buckets) ? (metrics.usage_buckets as { input_tokens?: number; output_tokens?: number }[]) : [];
  const inputTokens = buckets.length ? buckets.reduce((a, b) => a + (b.input_tokens ?? 0), 0) : Number(metrics?.input_tokens ?? 0);
  const outputTokens = buckets.length ? buckets.reduce((a, b) => a + (b.output_tokens ?? 0), 0) : Number(metrics?.output_tokens ?? 0);
  return { answer: answer.trim(), inputTokens, outputTokens, rounds: Math.max(buckets.length, roundTexts.length, 1), toolCalls, offeredTools, approval };
}

/**
 * Ask Odysseus. If it pauses with its tool-approval card ("Allow this task to continue?"),
 * answer it exactly like the UI's "Allow for this task" button (empty message + tool_approval_id/decision),
 * at most 3 times. Tokens, rounds and tool calls are summed across the continuation.
 */
async function askAgent(sessionId: string, message: string, mode: "chat" | "agent"): Promise<StreamOutcome> {
  const total: StreamOutcome = { answer: "", inputTokens: 0, outputTokens: 0, rounds: 0, toolCalls: [], offeredTools: [], approvals: 0 };
  let approval: ParsedStream["approval"] = null;
  for (let step = 0; step < 4; step++) {
    const fd = new FormData();
    fd.append("message", approval ? "" : message);
    fd.append("session", sessionId);
    fd.append("mode", mode);
    if (approval) {
      fd.append("tool_approval_id", approval.id);
      fd.append("tool_approval_decision", approval.decision);
    }
    const r = await ody("/api/chat_stream", { method: "POST", body: fd, signal: AbortSignal.timeout(QUESTION_TIMEOUT_MS) });
    if (!r.ok || !r.body) throw new Error(`chat_stream failed: ${r.status} ${await r.text()}`);
    const p = parseStream(await r.text());
    total.inputTokens += p.inputTokens;
    total.outputTokens += p.outputTokens;
    total.rounds += p.rounds;
    total.toolCalls.push(...p.toolCalls);
    if (p.offeredTools.length) total.offeredTools = p.offeredTools;
    total.answer = p.answer;
    if (!p.approval || step === 3) break;
    approval = p.approval;
    total.approvals++;
  }
  return total;
}

// ── Phases ──────────────────────────────────────────────────────────────────

async function runOdysseusPhase(phase: "A" | "B", cases: TestCase[]): Promise<PhaseResult> {
  const notes: string[] = [];
  const startedAt = new Date().toISOString();
  // Find a ContextOS MCP server registered in Odysseus (if any) and switch its tools per phase.
  const servers = (admin("mcp-list").servers ?? []) as { id: string; name: string; url: string | null; enabled: boolean }[];
  const contextosServers = servers.filter((s) => (s.url ?? "").includes(":4000/mcp"));
  for (const s of contextosServers) admin("mcp-tools", s.id, phase === "A" ? "off" : "on");
  notes.push(`Odysseus auth: ${AUTH_MODE}.`);
  if (phase === "B" && !SESSION_COOKIE) {
    throw new Error("Phase B needs ODYSSEUS_SESSION_COOKIE in evaluation/.env: Odysseus blocks MCP tools for API-token requests.");
  }
  if (phase === "B" && contextosServers.length === 0) {
    throw new Error("ContextOS MCP server is not registered in Odysseus. Add it: Settings → Integrations → Add → MCP (Streamable HTTP, http://host.docker.internal:4000/mcp).");
  }
  if (contextosServers.length) notes.push(`ContextOS MCP server ${contextosServers.map((s) => s.id).join(",")} tools ${phase === "A" ? "DISABLED" : "ENABLED"} for this phase.`);
  if (phase === "A") {
    admin("mem-cleanup", OWNER);
    const added = admin("mem-add", OWNER, Buffer.from(JSON.stringify(BASELINE_MEMORIES)).toString("base64"));
    notes.push(`Loaded ${String(added.added)} StudyMate statements into Odysseus native memory (vector index: ${String(added.vector_index)}), labelled source=contextos_eval.`);
    notes.push("Odysseus native memory injection ON, chat mode (its memory path). ContextOS MCP not registered/disabled.");
  } else {
    const removed = admin("mem-cleanup", OWNER);
    notes.push(`Removed ${String(removed.deleted)} baseline memories; per-session memory injection OFF. ContextOS MCP is the only project memory. Questions sent exactly as in phase A (no extra instruction); Odysseus decides per turn whether to route to the ContextOS tools; Odysseus tool-approval cards answered "Allow for this task" as a user would.`);
  }

  const results: CaseResult[] = [];
  for (const tc of cases) {
    const t0 = Date.now();
    let sessionId: string | null = null;
    try {
      sessionId = await createSession(`contextos-eval ${phase} ${tc.id}`);
      await setMemoryInjection(sessionId, phase === "A");
      const out = await askAgent(sessionId, (phase === "B" ? B_PREFIX : PREFIX) + tc.question, MODE[phase]);
      const contextosCalls = out.toolCalls.filter((t) => /get_current_state|get_decision|get_pending|get_unverified|search_memory|get_project_summary|contextos_status/.test(t) && t.startsWith("mcp__")).length;
      if (phase === "B" && !out.offeredTools.some((t) => t.includes("get_current_state"))) {
        notes.push(`${tc.id}: ContextOS tools were NOT offered to the agent (is the MCP server connected?).`);
      }
      results.push({
        id: tc.id, category: tc.category, question: tc.question, answer: out.answer, grade: grade(tc, out.answer),
        inputTokens: out.inputTokens, outputTokens: out.outputTokens, sessionInputTokens: null, sessionOutputTokens: null,
        rounds: out.rounds, toolCalls: out.toolCalls, contextosToolCalls: contextosCalls, approvals: out.approvals, latencyMs: Date.now() - t0,
        sessionId, error: null,
      });
      console.log(`  ${phase} ${tc.id.padEnd(20)} ${results.at(-1)!.grade.pass ? "PASS" : "FAIL"}  in=${out.inputTokens} out=${out.outputTokens} approvals=${out.approvals} tools=[${out.toolCalls.join(",")}]`);
    } catch (err) {
      results.push({
        id: tc.id, category: tc.category, question: tc.question, answer: "", grade: grade(tc, ""), inputTokens: 0, outputTokens: 0,
        sessionInputTokens: null, sessionOutputTokens: null, rounds: 0, toolCalls: [], contextosToolCalls: 0,
        latencyMs: Date.now() - t0, sessionId, error: err instanceof Error ? err.message : String(err),
      });
      console.log(`  ${phase} ${tc.id.padEnd(20)} ERROR ${results.at(-1)!.error}`);
    }
  }

  // Cross-check with Odysseus's own per-session counters.
  const ids = results.map((r) => r.sessionId).filter((x): x is string => !!x);
  if (ids.length) {
    const counters = admin("session-tokens", ...ids) as Record<string, { input: number; output: number }>;
    for (const r of results) {
      const c = r.sessionId ? counters[r.sessionId] : undefined;
      if (c) {
        r.sessionInputTokens = c.input;
        r.sessionOutputTokens = c.output;
      }
    }
  }
  return {
    phase, label: phase === "A" ? "Odysseus alone (native memory, chat mode)" : "Odysseus + ContextOS (MCP, agent mode)", model: MODEL,
    startedAt, finishedAt: new Date().toISOString(), notes, cases: results,
  };
}

async function runContextosPhase(cases: TestCase[]): Promise<PhaseResult> {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  for (const tc of cases) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${COS}/api/memory/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: tc.question }),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const a = (await r.json()) as { directAnswer: string; reviewNotes: string[]; sections: { title: string; items: { label: string; detail?: string }[] }[]; evidence: { ref: string; excerpt: string; occurredAt: string }[] };
      // Deterministic answer only (the optional Gemini narrative is excluded from grading and tokens).
      // Include the evidence the user sees next to the answer (E1..En excerpts that the answer cites).
      const cited = new Set((a.directAnswer.match(/\[E\d+\]/g) ?? []).map((x) => x.slice(1, -1)));
      const evidence = a.evidence.filter((e) => cited.has(e.ref)).map((e) => `[${e.ref}] ${e.occurredAt.slice(0, 10)} "${e.excerpt}"`);
      const answer = [a.directAnswer, ...a.reviewNotes, ...a.sections.flatMap((s) => s.items.map((i) => `${i.label}${i.detail ? ` — ${i.detail}` : ""}`)), ...evidence].join(" ");
      results.push({
        id: tc.id, category: tc.category, question: tc.question, answer, grade: grade(tc, answer), inputTokens: 0, outputTokens: 0,
        sessionInputTokens: null, sessionOutputTokens: null, rounds: 0, toolCalls: [], contextosToolCalls: 0,
        latencyMs: Date.now() - t0, sessionId: null, error: null,
      });
      console.log(`  C ${tc.id.padEnd(20)} ${results.at(-1)!.grade.pass ? "PASS" : "FAIL"}`);
    } catch (err) {
      results.push({
        id: tc.id, category: tc.category, question: tc.question, answer: "", grade: grade(tc, ""), inputTokens: 0, outputTokens: 0,
        sessionInputTokens: null, sessionOutputTokens: null, rounds: 0, toolCalls: [], contextosToolCalls: 0,
        latencyMs: Date.now() - t0, sessionId: null, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    phase: "C", label: "ContextOS direct (deterministic, no LLM for state)", model: "none (deterministic)",
    startedAt, finishedAt: new Date().toISOString(),
    notes: ["Answers composed from the lifecycle projection; 0 LLM tokens to answer (Gemini was used earlier, once, for extraction)."],
    cases: results,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

function summarize(p: PhaseResult) {
  const n = p.cases.length || 1;
  const sum = (f: (c: CaseResult) => number) => p.cases.reduce((s, c) => s + f(c), 0);
  return {
    phase: p.phase,
    label: p.label,
    model: p.model,
    questions: p.cases.length,
    passed: p.cases.filter((c) => c.grade.pass).length,
    accuracy: Number((p.cases.filter((c) => c.grade.pass).length / n).toFixed(3)),
    factRecall: Number((sum((c) => c.grade.recall) / n).toFixed(3)),
    wrongClaims: sum((c) => c.grade.violations.length),
    questionsWithWrongClaims: p.cases.filter((c) => c.grade.violations.length > 0).length,
    errors: p.cases.filter((c) => c.error).length,
    totalInputTokens: sum((c) => c.inputTokens),
    totalOutputTokens: sum((c) => c.outputTokens),
    avgTokensPerQuestion: Math.round(sum((c) => c.inputTokens + c.outputTokens) / n),
    tokensPerCorrectAnswer: p.cases.some((c) => c.grade.pass) ? Math.round(sum((c) => c.inputTokens + c.outputTokens) / p.cases.filter((c) => c.grade.pass).length) : null,
    avgLatencyMs: Math.round(sum((c) => c.latencyMs) / n),
    avgToolCalls: Number((sum((c) => c.toolCalls.length) / n).toFixed(2)),
    contextosToolUseRate: Number((p.cases.filter((c) => c.contextosToolCalls > 0).length / n).toFixed(3)),
  };
}

function report() {
  const phases = (["A", "B", "C"] as const)
    .map((p) => join(RESULTS, `phase-${p}.json`))
    .filter(existsSync)
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as PhaseResult);
  if (!phases.length) throw new Error("No results yet. Run --phase A/B/C first.");
  const summaries = phases.map(summarize);
  writeFileSync(join(RESULTS, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), odysseusUrl: ODY, testCases: TEST_CASES.map((t) => ({ id: t.id, category: t.category, question: t.question, truth: t.truth, must: t.must.map((m) => m.label), mustNot: t.mustNot.map((m) => m.label) })), summaries, phases }, null, 2));

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines: string[] = [
    "# ContextOS × Odysseus — evaluation report",
    "",
    `Generated ${new Date().toISOString()}. Synthetic StudyMate demo history. Grading: deterministic rules (evaluation/test-cases.ts).`,
    "Tokens: Odysseus's own measurements (Groq usage per agent round), cross-checked with Odysseus per-session counters.",
    "",
    "| Metric | " + summaries.map((s) => `${s.phase}. ${s.label}`).join(" | ") + " |",
    "|---|" + summaries.map(() => "---").join("|") + "|",
    `| Model | ${summaries.map((s) => s.model).join(" | ")} |`,
    `| Correct answers | ${summaries.map((s) => `${s.passed}/${s.questions} (${pct(s.accuracy)})`).join(" | ")} |`,
    `| Required-fact recall | ${summaries.map((s) => pct(s.factRecall)).join(" | ")} |`,
    `| Wrong/outdated claims | ${summaries.map((s) => `${s.wrongClaims} (in ${s.questionsWithWrongClaims} answers)`).join(" | ")} |`,
    `| Input tokens (total) | ${summaries.map((s) => s.totalInputTokens.toLocaleString()).join(" | ")} |`,
    `| Output tokens (total) | ${summaries.map((s) => s.totalOutputTokens.toLocaleString()).join(" | ")} |`,
    `| Avg tokens / question | ${summaries.map((s) => s.avgTokensPerQuestion.toLocaleString()).join(" | ")} |`,
    `| Tokens / correct answer | ${summaries.map((s) => (s.tokensPerCorrectAnswer === null ? "—" : s.tokensPerCorrectAnswer.toLocaleString())).join(" | ")} |`,
    `| Avg latency | ${summaries.map((s) => `${(s.avgLatencyMs / 1000).toFixed(1)} s`).join(" | ")} |`,
    `| Avg tool calls | ${summaries.map((s) => s.avgToolCalls).join(" | ")} |`,
    `| ContextOS tool used | ${summaries.map((s) => pct(s.contextosToolUseRate)).join(" | ")} |`,
    `| Errors | ${summaries.map((s) => s.errors).join(" | ")} |`,
    "",
  ];
  for (const p of phases) {
    lines.push(`## ${p.phase}. ${p.label}`, "", ...p.notes.map((n) => `- ${n}`), "");
    lines.push("| Case | Result | Missing | Wrong claims | Tokens in/out | Tools | Answer (excerpt) |", "|---|---|---|---|---|---|---|");
    for (const c of p.cases) {
      const excerpt = (c.error ? `ERROR: ${c.error}` : c.answer).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 160);
      lines.push(`| ${c.id} | ${c.grade.pass ? "✅" : "❌"} | ${c.grade.missing.join("; ") || "—"} | ${c.grade.violations.join("; ") || "—"} | ${c.inputTokens}/${c.outputTokens} | ${c.toolCalls.join(", ") || "—"} | ${excerpt} |`);
    }
    lines.push("");
  }
  writeFileSync(join(RESULTS, "REPORT.md"), lines.join("\n"));
  console.log(lines.slice(0, 22).join("\n"));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
mkdirSync(RESULTS, { recursive: true });
const only = flag("--cases")?.split(",");
const cases = only ? TEST_CASES.filter((t) => only.includes(t.id)) : TEST_CASES;

if (argv.includes("--report")) {
  report();
} else if (argv.includes("--regrade")) {
  // Re-score saved answers with the current grader (no model calls).
  for (const p of ["A", "B", "C"]) {
    const file = join(RESULTS, `phase-${p}.json`);
    if (!existsSync(file)) continue;
    const res = JSON.parse(readFileSync(file, "utf8")) as PhaseResult;
    for (const c of res.cases) {
      const tc = TEST_CASES.find((t) => t.id === c.id);
      if (tc) c.grade = grade(tc, c.answer);
    }
    writeFileSync(file, JSON.stringify(res, null, 2));
    console.log(`phase ${p}: ${res.cases.filter((c) => c.grade.pass).length}/${res.cases.length} pass`);
  }
  report();
} else if (argv.includes("--cleanup")) {
  console.log(admin("mem-cleanup", OWNER));
} else {
  const phase = flag("--phase") as "A" | "B" | "C" | undefined;
  if (!phase || !["A", "B", "C"].includes(phase)) {
    console.error("usage: run.ts --phase A|B|C [--cases id1,id2] | --report | --cleanup");
    process.exit(2);
  }
  const ready = (await fetch(`${COS}/health/ready`).then((r) => r.json()).catch(() => null)) as { ready?: boolean } | null;
  if (!ready?.ready) throw new Error(`ContextOS is not ready at ${COS} (start it with npm run start:backend)`);
  console.log(`Phase ${phase}: ${cases.length} questions${phase === "C" ? "" : ` · Odysseus model ${MODEL}`}`);
  const result = phase === "C" ? await runContextosPhase(cases) : await runOdysseusPhase(phase, cases);
  writeFileSync(join(RESULTS, `phase-${phase}.json`), JSON.stringify(result, null, 2));
  console.log(`Saved evaluation/results/phase-${phase}.json`);
  report(); // keep summary.json / REPORT.md (shown in the dashboard) up to date
}
