"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Bot, FileText, Loader2, RefreshCw, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DemoBadge, ErrorState, LoadingRows, MethodBadge, PageHeader, Section, StatusPill } from "@/components/cos";
import { api, useApi, type ConversationDetail } from "@/lib/api";
import { fmtDate } from "@/lib/status";
import { cn } from "@/lib/utils";

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<ConversationDetail>(`/conversations/${id}`);
  const [hash] = useState<string>(() => (typeof window === "undefined" ? "" : window.location.hash.replace("#", "")));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (hash && data) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }, [hash, data]);

  const reprocess = async () => {
    setBusy(true);
    try {
      await api(`/conversations/${id}/process`, { method: "POST" });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <LoadingRows rows={4} />;
  if (!data) return null;

  const memoriesByMessage = (messageId: string) => data.memories.filter((m) => m.messageId === messageId);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        title={data.title}
        description={`${data.projectName} · ${fmtDate(data.occurredAt)} · source: ${data.source.replace(/_/g, " ")}${data.externalRef ? ` (${data.externalRef})` : ""} · stored ${fmtDate(data.recordedAt)}`}
        actions={
          <>
            {data.isDemo ? <DemoBadge /> : null}
            <MethodBadge method={data.extractionMethod} />
            <Button size="sm" variant="outline" onClick={() => void reprocess()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Re-extract
            </Button>
          </>
        }
      />
      {data.extractionError ? <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">Last Gemini error (fallback used): {data.extractionError}</p> : null}

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <Section title="Original conversation" description="Stored verbatim. Highlighted lines are cited as evidence.">
          <ol className="space-y-3">
            {data.messages.map((m) => {
              const mems = memoriesByMessage(m.id);
              const target = hash === `m-${m.id}`;
              return (
                <li key={m.id} id={`m-${m.id}`} className={cn("rounded-lg border p-3 transition-colors", target ? "border-primary/60 bg-primary/10" : mems.length ? "border-border/70 bg-background/40" : "border-transparent")}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {m.role === "assistant" ? <Bot className="size-3.5" /> : <User className="size-3.5" />}
                    <span className="font-medium text-foreground/80">{m.speaker ?? m.role}</span>
                    <span>#{m.seq}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{m.content}</p>
                  {mems.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {mems.map((x) => (
                        <span key={x.id} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {x.kind.replace(/_/g, " ")}{x.option ? `: ${x.option}` : ""}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </Section>
        <div className="space-y-5">
          <Section title={`Extracted memories (${data.memories.length})`}>
            <ul className="space-y-2">
              {data.memories.map((m) => (
                <li key={m.id} className="rounded-lg border border-border/70 p-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">{m.kind.replace(/_/g, " ")}</span>
                    {m.decisionId ? <Link href={`/decisions/${m.decisionId}`} className="font-medium hover:text-primary">{m.option}</Link> : <span className="font-medium">{m.option}</span>}
                    <span className="ml-auto text-[11px] text-muted-foreground">conf {m.confidence.toFixed(2)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{m.summary}</p>
                  {m.reason ? <p className="mt-0.5 text-xs">Reason: {m.reason}</p> : null}
                  {!m.excerptVerified ? <p className="mt-0.5 text-xs text-rose-300">Excerpt not found verbatim in source</p> : null}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Lifecycle transitions from this conversation">
            {data.events.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
            <ul className="space-y-1.5">
              {data.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusPill status={e.type} />
                  {e.decisionId ? <Link href={`/decisions/${e.decisionId}`} className="hover:text-primary">{e.option}</Link> : <span>{e.commitmentTitle}</span>}
                  {e.note ? <span className="text-xs text-muted-foreground">— {e.note}</span> : null}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
