"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, MessageSquarePlus, ShieldAlert, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DemoBadge, EmptyState, ErrorState, LoadingRows, MethodBadge, PageHeader, Section, StatusPill, selectClass } from "@/components/cos";
import { DemoImportButton } from "@/components/demo-import-button";
import { useProjects } from "@/components/app-shell";
import { api, useApi, type ConversationDetail, type ConversationSummary, type ProcessResult } from "@/lib/api";
import { fmtDate } from "@/lib/status";

const SAMPLE = `Asha: We are considering Supabase for authentication because it bundles Postgres auth.
Ravi: We decided to use Clerk for authentication instead of Supabase because it has better React components.
Ravi: Ravi will set up the Clerk webhook sync by July 10.`;

export default function IngestPage() {
  const { projects, projectId, setProjectId } = useProjects();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ conversation: ConversationDetail; result: ProcessResult } | null>(null);
  const history = useApi<ConversationSummary[]>(projectId ? `/conversations?projectId=${projectId}` : "/conversations");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ conversation: ConversationDetail; result: ProcessResult }>("/conversations", {
        method: "POST",
        body: { projectId, title: title.trim() || "Untitled conversation", occurredAt: date, text, source: "paste" },
      });
      setResult(r);
      setText("");
      setTitle("");
      void history.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={MessageSquarePlus}
        title="Ingest conversations"
        description="Paste a conversation. ContextOS stores the original text, extracts structured memories (Gemini, or the labelled fallback), verifies every excerpt against the source, then updates lifecycle state deterministically."
        actions={<DemoImportButton variant="outline" size="sm" onDone={() => void history.reload()} />}
      />

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Section title="New conversation" description='Format: one message per line as "Name: text". Plain text also works.'>
          {projects.length === 0 ? (
            <EmptyState title="Create a project first" description="Conversations belong to a project." action={<Link href="/projects"><Button>Go to projects</Button></Link>} />
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <div className="space-y-1.5">
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Auth provider discussion" maxLength={160} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="date">Conversation date</Label>
                  <Input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project">Project</Label>
                <select id="project" className={`${selectClass} w-full`} value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.isDemo ? " (demo data)" : ""}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="text">Conversation</Label>
                  <button type="button" onClick={() => setText(SAMPLE)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <Wand2 className="size-3" /> Insert sample
                  </button>
                </div>
                <Textarea id="text" value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder={"Asha: We decided to migrate to PostgreSQL because…\nRavi: The migration has been implemented."} className="font-mono text-sm" required minLength={3} />
              </div>
              {error ? <ErrorState message={error} /> : null}
              <Button type="submit" disabled={busy || text.trim().length < 3}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                {busy ? "Extracting & applying lifecycle rules…" : "Process conversation"}
              </Button>
            </form>
          )}
        </Section>

        <Section title="Extraction result" description="What was understood — and what the lifecycle engine did with it.">
          {!result ? (
            <p className="text-sm text-muted-foreground">Process a conversation to see extracted memories, verified excerpts and lifecycle transitions here.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <MethodBadge method={result.result.method} />
                <span className="text-muted-foreground">{result.result.memories} memories · {result.result.embedded} embedded · {result.result.projection.events} lifecycle events in project</span>
              </div>
              {result.result.geminiError ? (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">Gemini failed, deterministic fallback used: {result.result.geminiError}</p>
              ) : null}
              {result.result.unverifiedExcerpts > 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-rose-300"><ShieldAlert className="size-3.5" /> {result.result.unverifiedExcerpts} excerpt(s) not found in the source → held for review</p>
              ) : null}
              <ul className="space-y-2">
                {result.conversation.memories.length === 0 ? <li className="text-sm text-muted-foreground">No decisions, commitments or durable facts found.</li> : null}
                {result.conversation.memories.map((m) => (
                  <li key={m.id} className="rounded-lg border border-border/70 p-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">{m.kind.replace(/_/g, " ")}</span>
                      {m.option ? <span className="text-sm font-medium">{m.option}</span> : null}
                      {m.subjectLabel ? <span className="text-xs text-muted-foreground">· {m.subjectLabel}</span> : null}
                      <span className="ml-auto text-[11px] text-muted-foreground">conf {m.confidence.toFixed(2)}{m.hedged ? " · hedged" : ""}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">“{m.excerpt}” {m.excerptVerified ? <span className="text-emerald-400">✓ in source</span> : <span className="text-rose-300">✗ not in source</span>}</p>
                    {m.reason ? <p className="mt-0.5 text-xs"><span className="text-muted-foreground">Reason:</span> {m.reason}</p> : null}
                  </li>
                ))}
              </ul>
              {result.conversation.events.length ? (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">Lifecycle transitions caused by this conversation</div>
                  <div className="flex flex-wrap gap-1.5">
                    {result.conversation.events.map((e) => (
                      <span key={e.id} className="inline-flex items-center gap-1 text-xs">
                        <StatusPill status={e.type} /> {e.option ?? e.commitmentTitle}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              <Link href={`/conversations/${result.conversation.id}`} className="text-xs text-primary hover:underline">Open conversation →</Link>
            </div>
          )}
        </Section>
      </div>

      <Section title="Source conversations" description="Original evidence. Never discarded after extraction.">
        {history.error ? <ErrorState message={history.error} onRetry={() => void history.reload()} /> : null}
        {history.loading && !history.data ? <LoadingRows rows={2} /> : null}
        {history.data && history.data.length === 0 ? <p className="text-sm text-muted-foreground">No conversations yet.</p> : null}
        <ul className="divide-y divide-border/60">
          {history.data?.map((c) => (
            <li key={c.id}>
              <Link href={`/conversations/${c.id}`} className="flex flex-wrap items-center gap-2 py-2.5 text-sm hover:text-primary">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">{fmtDate(c.occurredAt)}</span>
                <span className="font-medium">{c.title}</span>
                <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{c.source.replace(/_/g, " ")}</span>
                {c.isDemo ? <DemoBadge /> : null}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  {c.memoryCount} memories
                  <MethodBadge method={c.extractionMethod} />
                  {c.status !== "processed" ? <StatusPill status={c.status === "failed" ? "REJECTED" : "HELD_FOR_REVIEW"} label={c.status} /> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
