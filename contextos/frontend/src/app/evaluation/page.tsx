"use client";

import { useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, CheckCircle2, ChevronDown, ExternalLink, Info, ScanSearch, XCircle } from "lucide-react";
import { EmptyState, ErrorState, LoadingRows, PageHeader, Section } from "@/components/cos";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Grade { pass: boolean; recall: number; missing: string[]; violations: string[] }
interface CaseResult {
  id: string; category: string; question: string; answer: string; grade: Grade; inputTokens: number; outputTokens: number;
  rounds: number; toolCalls: string[]; contextosToolCalls: number; latencyMs: number; sessionId: string | null; error: string | null;
}
interface Phase { phase: "A" | "B" | "C"; label: string; model: string; notes: string[]; startedAt: string; cases: CaseResult[] }
interface Summary {
  phase: "A" | "B" | "C"; label: string; model: string; questions: number; passed: number; accuracy: number; factRecall: number;
  wrongClaims: number; questionsWithWrongClaims: number; errors: number; totalInputTokens: number; totalOutputTokens: number;
  avgTokensPerQuestion: number; tokensPerCorrectAnswer: number | null; avgLatencyMs: number; avgToolCalls: number; contextosToolUseRate: number;
}
interface EvalData {
  generatedAt: string; odysseusUrl: string;
  testCases: { id: string; category: string; question: string; truth: string; must: string[]; mustNot: string[] }[];
  summaries: Summary[]; phases: Phase[];
}

const PHASE_STYLE: Record<string, { name: string; color: string; tone: string }> = {
  A: { name: "Odysseus alone", color: "#94a3b8", tone: "border-slate-500/30 bg-slate-500/10 text-slate-200" },
  B: { name: "Odysseus + ContextOS", color: "#a78bfa", tone: "border-violet-500/30 bg-violet-500/10 text-violet-200" },
  C: { name: "ContextOS direct", color: "#34d399", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" },
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

function Verdict({ c }: { c: CaseResult | undefined }) {
  if (!c) return <span className="text-xs text-muted-foreground">not run yet</span>;
  if (c.error) return <span className="text-xs text-rose-300">error</span>;
  return c.grade.pass ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300"><CheckCircle2 className="size-3.5" /> Correct</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-300"><XCircle className="size-3.5" /> Wrong / incomplete</span>
  );
}

function CaseRow({ tc, phases, odysseusUrl }: { tc: EvalData["testCases"][number]; phases: Phase[]; odysseusUrl: string }) {
  const [open, setOpen] = useState(false);
  const results = phases.map((p) => ({ p, c: p.cases.find((x) => x.id === tc.id) }));
  return (
    <div className="rounded-xl border border-border/70 bg-card/60">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 p-4 text-left">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{tc.category}</div>
          <div className="mt-0.5 font-medium">{tc.question}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-3">
          {results.map(({ p, c }) => (
            <div key={p.phase} className="text-right">
              <div className="text-[10px] text-muted-foreground">{PHASE_STYLE[p.phase]?.name}</div>
              <Verdict c={c} />
            </div>
          ))}
        </div>
        <ChevronDown className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border/60 p-4">
          <div className="rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
            <div className="text-[11px] font-medium text-muted-foreground">Correct answer (from the source conversations)</div>
            <p className="mt-1">{tc.truth}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Must mention: {tc.must.join(" · ")}
              {tc.mustNot.length ? <> — Must NOT claim: {tc.mustNot.join(" · ")}</> : null}
            </p>
          </div>
          <div className={cn("grid gap-3", results.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
            {results.map(({ p, c }) => (
              <div key={p.phase} className={cn("rounded-lg border p-3", PHASE_STYLE[p.phase]?.tone)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{p.phase}. {PHASE_STYLE[p.phase]?.name}</span>
                  <Verdict c={c} />
                </div>
                {c ? (
                  <>
                    <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{c.error ? `ERROR: ${c.error}` : c.answer || "(empty answer)"}</p>
                    {c.grade.missing.length ? <p className="mt-2 text-[11px] text-amber-300">Missing: {c.grade.missing.join("; ")}</p> : null}
                    {c.grade.violations.length ? <p className="mt-1 text-[11px] text-rose-300">Wrong claim: {c.grade.violations.join("; ")}</p> : null}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span>tokens {c.inputTokens.toLocaleString()} in / {c.outputTokens.toLocaleString()} out</span>
                      <span>{(c.latencyMs / 1000).toFixed(1)} s</span>
                      {c.toolCalls.length ? <span>tools: {c.toolCalls.map((t) => t.replace(/^mcp__[^_]+__/, "")).join(", ")}</span> : null}
                    </div>
                    {c.sessionId ? (
                      <a href={`${odysseusUrl}/#${c.sessionId}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                        Open this chat in Odysseus <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    {p.phase === "C" ? (
                      <Link href={`/ask?q=${encodeURIComponent(tc.question)}`} className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                        <ScanSearch className="size-3" /> Re-run in Ask ContextOS
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Not run yet.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function EvaluationPage() {
  const { data, error, loading, reload } = useApi<EvalData>("/evaluation");
  const order = ["A", "B", "C"] as const;
  const summaries = (data?.summaries ?? []).slice().sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
  const phases = (data?.phases ?? []).slice().sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase));
  const chart = summaries.map((s) => ({ name: PHASE_STYLE[s.phase]?.name ?? s.phase, accuracy: Math.round(s.accuracy * 100), tokens: s.avgTokensPerQuestion, color: PHASE_STYLE[s.phase]?.color }));
  const hasB = summaries.some((s) => s.phase === "B");

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        title="Evaluation: Odysseus vs Odysseus + ContextOS"
        description="The same 10 questions about the StudyMate history, asked to the same Odysseus model. Answers are graded by fixed rules; tokens are Odysseus's own measurements."
      />
      {error ? (error.includes("No evaluation") ? <EmptyState icon={BarChart3} title="No evaluation results yet" description={error} /> : <ErrorState message={error} onRetry={() => void reload()} />) : null}
      {loading && !data ? <LoadingRows rows={3} /> : null}

      {data ? (
        <>
          {!hasB ? (
            <div className="flex items-start gap-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-violet-300" />
              <span>Phase B (Odysseus + ContextOS via MCP) has not been run yet. Connect ContextOS in Odysseus (Settings → Integrations → MCP), then run <code className="rounded bg-muted px-1">npx tsx evaluation/run.ts --phase B</code>.</span>
            </div>
          ) : null}

          <div className={cn("grid gap-3", summaries.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
            {summaries.map((s) => (
              <div key={s.phase} className={cn("rounded-xl border p-4", PHASE_STYLE[s.phase]?.tone)}>
                <div className="text-xs font-semibold">{s.phase}. {PHASE_STYLE[s.phase]?.name}</div>
                <div className="text-[11px] text-muted-foreground">{s.label} · {s.model}</div>
                <div className="mt-3 text-3xl font-semibold tabular-nums">{s.passed}/{s.questions}</div>
                <div className="text-xs text-muted-foreground">correct answers ({pct(s.accuracy)})</div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">Facts found</dt><dd className="text-right tabular-nums">{pct(s.factRecall)}</dd>
                  <dt className="text-muted-foreground">Wrong claims</dt><dd className="text-right tabular-nums">{s.wrongClaims}</dd>
                  <dt className="text-muted-foreground">Avg tokens / question</dt><dd className="text-right tabular-nums">{s.avgTokensPerQuestion.toLocaleString()}</dd>
                  <dt className="text-muted-foreground">Tokens / correct answer</dt><dd className="text-right tabular-nums">{s.tokensPerCorrectAnswer?.toLocaleString() ?? "—"}</dd>
                  <dt className="text-muted-foreground">Total tokens in / out</dt><dd className="text-right tabular-nums">{s.totalInputTokens.toLocaleString()} / {s.totalOutputTokens.toLocaleString()}</dd>
                  <dt className="text-muted-foreground">Avg time</dt><dd className="text-right tabular-nums">{(s.avgLatencyMs / 1000).toFixed(1)} s</dd>
                  {s.phase === "B" ? (<><dt className="text-muted-foreground">Used ContextOS tool</dt><dd className="text-right tabular-nums">{pct(s.contextosToolUseRate)}</dd></>) : null}
                  {s.errors ? (<><dt className="text-rose-300">Errors</dt><dd className="text-right tabular-nums text-rose-300">{s.errors}</dd></>) : null}
                </dl>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Correct answers (%)">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chart} margin={{ left: -10, right: 10 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={{ background: "#151823", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="accuracy" name="Correct %" radius={[4, 4, 0, 0]} isAnimationActive={false} label={{ position: "top", fill: "#e4e4e7", fontSize: 12 }}>{chart.map((d) => <Cell key={d.name} fill={d.color} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </Section>
            <Section title="Average tokens per question" description="Odysseus-measured LLM tokens (input + output). ContextOS direct uses no LLM to answer.">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chart} margin={{ left: 0, right: 10 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={{ background: "#151823", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="tokens" name="Avg tokens" radius={[4, 4, 0, 0]} isAnimationActive={false} label={{ position: "top", fill: "#e4e4e7", fontSize: 12 }}>{chart.map((d) => <Cell key={d.name} fill={d.color} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </Section>
          </div>

          <Section title="How each setup was run">
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {phases.map((p) => (
                <li key={p.phase}>
                  <span className="font-medium text-foreground/80">{p.phase}. {p.label}</span> — {p.notes.join(" ")}
                </li>
              ))}
              <li>Grading ignores Markdown/hyphen formatting and treats quoted text as cited evidence (same rules for every setup).</li>
            </ul>
          </Section>

          <div>
            <h2 className="mb-3 text-sm font-semibold">Test cases ({data.testCases.length}) — click a question to compare the answers</h2>
            <div className="space-y-2">
              {data.testCases.map((tc) => (
                <CaseRow key={tc.id} tc={tc} phases={phases} odysseusUrl={data.odysseusUrl} />
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">Results generated {new Date(data.generatedAt).toLocaleString()} · source: evaluation/results/summary.json</p>
        </>
      ) : null}
    </div>
  );
}
