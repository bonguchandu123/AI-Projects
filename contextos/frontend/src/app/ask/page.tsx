"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowUp, Brain, Loader2, ScanSearch, Sparkles, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EvidenceCard, ErrorState, PageHeader, Section, StatusPill } from "@/components/cos";
import { SubjectStateCard } from "@/components/state-card";
import { useProjects } from "@/components/app-shell";
import { api, type QueryAnswer } from "@/lib/api";
import { fmtDate, statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "What database does StudyMate currently use and why?",
  "What was the original database decision?",
  "Which implementation claims are unverified?",
  "Which decisions have not been implemented?",
  "What decisions were rejected?",
  "What changed between January and May?",
  "Which project commitments are overdue or unresolved?",
  "Are there contradictory statements?",
];

function withRefs(text: string, onRef: (id: string) => void): ReactNode[] {
  return text.split(/(\[E\d+\])/g).map((part, i) => {
    const m = /^\[(E\d+)\]$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <button
        key={i}
        type="button"
        onClick={() => onRef(m[1]!)}
        className="mx-0.5 inline-flex items-center rounded bg-primary/15 px-1 py-px align-baseline font-mono text-[10px] font-semibold text-primary hover:bg-primary/30"
      >
        {m[1]}
      </button>
    );
  });
}

const CONFIDENCE = {
  high: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  low: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
};

export default function AskPage() {
  const { projectId, project } = useProjects();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<QueryAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q");

  const ask = async (q: string) => {
    if (q.trim().length < 3) return;
    setQuestion(q);
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api<QueryAnswer>("/memory/query", { method: "POST", body: { question: q, ...(projectId ? { projectId } : {}) } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // /ask?q=... runs the question once on load (deep links for demos).
  useEffect(() => {
    if (!initialQ) return;
    const t = setTimeout(() => void ask(initialQ), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ, projectId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };
  const jump = (ref: string) => {
    setHighlight(ref);
    document.getElementById(`ev-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setHighlight(null), 1600);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ScanSearch}
        title="Ask ContextOS"
        description="Answers are composed from the authoritative decision state — not from similarity search — and every claim links to the conversation it came from."
      />

      <form onSubmit={submit} className="rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/[0.07] to-transparent p-2 shadow-[0_0_60px_-30px] shadow-primary/40">
        <div className="flex items-center gap-2 rounded-xl bg-background/60 px-3 py-2">
          <Brain className="size-5 shrink-0 text-primary" aria-hidden />
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Ask about ${project?.name ?? "your project"}'s decisions, state, history or evidence…`}
            className="h-10 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            aria-label="Question"
          />
          <Button type="submit" disabled={busy || question.trim().length < 3} size="icon" aria-label="Ask">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-1 pb-1 pt-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => void ask(s)} disabled={busy} className="rounded-full border border-border/70 bg-background/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
      </form>

      {error ? <ErrorState message={error} /> : null}

      {busy && !answer ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Resolving current state from lifecycle events…
        </div>
      ) : null}

      {answer ? (
        <div className={cn("grid gap-5 lg:grid-cols-[1fr_380px]", busy && "opacity-60")}>
          <div className="space-y-5">
            {/* Direct answer */}
            <div className="rounded-xl border border-border/70 bg-card/70 p-5">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Target className="size-3.5 text-primary" />
                <span>Interpreted:</span>
                {answer.interpretation.projectName ? <span className="rounded bg-muted px-1.5 py-0.5 text-foreground/80">{answer.interpretation.projectName}</span> : null}
                {answer.interpretation.subjects.map((s) => (
                  <span key={s} className="rounded bg-muted px-1.5 py-0.5">{s}</span>
                ))}
                {answer.interpretation.intents.map((s) => (
                  <span key={s} className="rounded border border-border/70 px-1.5 py-0.5">{s.replace(/_/g, " ")}</span>
                ))}
                <span className={cn("ml-auto rounded-md border px-1.5 py-0.5 font-medium", CONFIDENCE[answer.confidence])}>{answer.confidence} confidence</span>
              </div>
              <p className="mt-3 text-[15px] leading-relaxed">{withRefs(answer.directAnswer, jump)}</p>
              {answer.reviewNotes.length ? (
                <div className="mt-4 space-y-2">
                  {answer.reviewNotes.map((n, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-sm">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-300" />
                      <span className="text-foreground/85">{withRefs(n, jump)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {answer.narrative ? (
                <div className="mt-4 rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-3 text-sm">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-indigo-300">
                    <Sparkles className="size-3.5" /> Gemini summary ({answer.narrative.model}) — restricted to the evidence below
                  </div>
                  {withRefs(answer.narrative.text, jump)}
                </div>
              ) : null}
              <p className="mt-4 text-[11px] text-muted-foreground">Generated by: {answer.generatedBy}</p>
            </div>

            {answer.currentState.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {answer.currentState.map((s) => (
                  <SubjectStateCard key={s.subjectKey} s={s} showEvidence={false} />
                ))}
              </div>
            ) : null}

            {answer.history.length ? (
              <Section title="Lifecycle history" description="Every transition, in event-time order, with its evidence.">
                <ol className="relative space-y-3 border-l border-border/70 pl-5">
                  {answer.history.map((h, i) => {
                    const m = statusMeta(h.type);
                    return (
                      <li key={i} className="relative">
                        <span className={cn("absolute -left-[26px] top-1.5 size-2.5 rounded-full ring-4 ring-background", m.dot)} />
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="w-24 shrink-0 text-xs text-muted-foreground">{fmtDate(h.date)}</span>
                          <span className="font-medium">{h.option}</span>
                          <StatusPill status={h.type} />
                          {!h.applied ? <span className="text-[11px] text-rose-300">not applied</span> : null}
                          {h.evidenceIds.map((r) => (
                            <button key={r} onClick={() => jump(r)} className="rounded bg-primary/15 px-1 font-mono text-[10px] font-semibold text-primary hover:bg-primary/30">{r}</button>
                          ))}
                        </div>
                        {h.note ? <p className="mt-0.5 text-xs text-muted-foreground sm:pl-26">{h.note}</p> : null}
                      </li>
                    );
                  })}
                </ol>
              </Section>
            ) : null}

            {answer.sections.map((sec) => (
              <Section key={sec.title} title={sec.title}>
                {sec.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {sec.items.map((it, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                        {it.decisionId ? <Link href={`/decisions/${it.decisionId}`} className="font-medium hover:text-primary">{it.label}</Link> : <span className="font-medium">{it.label}</span>}
                        {it.status ? <StatusPill status={it.status} /> : null}
                        {it.date ? <span className="text-xs text-muted-foreground">{fmtDate(it.date)}</span> : null}
                        {it.evidenceIds.map((r) => (
                          <button key={r} onClick={() => jump(r)} className="rounded bg-primary/15 px-1 font-mono text-[10px] font-semibold text-primary hover:bg-primary/30">{r}</button>
                        ))}
                        {it.detail ? <p className="w-full text-xs text-muted-foreground">{it.detail}</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            ))}
          </div>

          <aside className="space-y-4">
            <Section title={`Evidence (${answer.evidence.length})`} description="Verbatim excerpts. Click to open the source conversation.">
              <div className="space-y-2">
                {answer.evidence.length === 0 ? <p className="text-sm text-muted-foreground">No evidence cited.</p> : null}
                {answer.evidence.map((e) => (
                  <div key={e.ref} id={`ev-${e.ref}`} className={cn("rounded-lg transition-shadow", highlight === e.ref && "ring-2 ring-primary")}>
                    <EvidenceCard e={e} refId={e.ref} />
                  </div>
                ))}
              </div>
            </Section>
            {answer.related.length ? (
              <Section title="Related memories" description="Hybrid search (full-text + pgvector when embeddings exist). Context only — not used to decide state.">
                <div className="space-y-2">
                  {answer.related.slice(0, 5).map((h) => (
                    <EvidenceCard key={h.evidence.memoryId} e={h.evidence} compact />
                  ))}
                </div>
              </Section>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
