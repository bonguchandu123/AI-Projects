"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, EvidenceCard, LoadingRows, PageHeader, StatusPill, selectClass } from "@/components/cos";
import { useProjects } from "@/components/app-shell";
import { useApi, type LifecycleEvent } from "@/lib/api";
import { fmtMonth, fmtShort, statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

const TYPE_GROUPS: { key: string; label: string; types: string[] }[] = [
  { key: "", label: "All events", types: [] },
  { key: "PROPOSED", label: "Proposed", types: ["PROPOSED"] },
  { key: "DECIDED", label: "Decided", types: ["DECIDED"] },
  { key: "REJECTED", label: "Rejected", types: ["REJECTED"] },
  { key: "CANCELLED", label: "Cancelled", types: ["CANCELLED", "COMMITMENT_CANCELLED"] },
  { key: "IMPLEMENTATION_CLAIMED", label: "Implemented (claimed)", types: ["IMPLEMENTATION_CLAIMED"] },
  { key: "VERIFIED", label: "Verified", types: ["VERIFIED"] },
  { key: "SUPERSEDED", label: "Superseded / retired", types: ["SUPERSEDED", "RETIRED"] },
  { key: "CONFLICT", label: "Conflicts & held", types: ["CONFLICT_FLAGGED", "HELD_FOR_REVIEW"] },
  { key: "COMMITMENT", label: "Commitments", types: ["COMMITMENT_OPENED", "COMMITMENT_DONE", "COMMITMENT_CANCELLED"] },
];

export default function TimelinePage() {
  const { projectId, project } = useProjects();
  const [group, setGroup] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [area, setArea] = useState("");

  const types = TYPE_GROUPS.find((g) => g.key === group)?.types ?? [];
  const qs = new URLSearchParams();
  if (projectId) qs.set("projectId", projectId);
  if (types.length) qs.set("types", types.join(","));
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const { data, error, loading, reload } = useApi<LifecycleEvent[]>(`/memory/timeline?${qs.toString()}`);

  const areas = useMemo(() => [...new Set((data ?? []).map((e) => e.subjectLabel ?? "Commitments"))], [data]);
  const events = (data ?? []).filter((e) => !area || (e.subjectLabel ?? "Commitments") === area);
  const byMonth = useMemo(() => {
    const m = new Map<string, LifecycleEvent[]>();
    for (const e of events) {
      const k = fmtMonth(e.occurredAt);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()];
  }, [events]);

  return (
    <div className="space-y-6">
      <PageHeader icon={CalendarRange} title="Decision timeline" description={`How ${project?.name ?? "the project"}'s decisions evolved, in event-time order. Superseded and rejected options stay visible as history.`} />

      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Event type" className={selectClass} value={group} onChange={(e) => setGroup(e.target.value)}>
          {TYPE_GROUPS.map((g) => (
            <option key={g.key} value={g.key}>{g.label}</option>
          ))}
        </select>
        <select aria-label="Decision area" className={selectClass} value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">All areas</option>
          {areas.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" />
        </label>
        {group || from || to || area ? (
          <button className="text-xs text-primary hover:underline" onClick={() => { setGroup(""); setFrom(""); setTo(""); setArea(""); }}>
            Clear filters
          </button>
        ) : null}
      </div>

      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows rows={4} /> : null}
      {data && events.length === 0 ? <EmptyState icon={CalendarRange} title="No lifecycle events match" description="Adjust the filters or ingest conversations." /> : null}

      <div className="space-y-8">
        {byMonth.map(([month, list]) => (
          <section key={month}>
            <h2 className="sticky top-14 z-10 mb-3 bg-background/80 py-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground backdrop-blur">{month}</h2>
            <ol className="relative space-y-4 border-l border-border/70 pl-6">
              {list.map((e) => {
                const m = statusMeta(e.type);
                const Icon = m.icon;
                return (
                  <li key={e.id} className="relative">
                    <span className={cn("absolute -left-[33px] top-0.5 flex size-5 items-center justify-center rounded-full border ring-4 ring-background", m.tone)}>
                      <Icon className="size-3" />
                    </span>
                    <div className="rounded-xl border border-border/70 bg-card/60 p-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">{fmtShort(e.occurredAt)}</span>
                        <StatusPill status={e.type} />
                        {e.decisionId ? (
                          <Link href={`/decisions/${e.decisionId}`} className="font-medium hover:text-primary">{e.option}</Link>
                        ) : (
                          <span className="font-medium">{e.commitmentTitle}</span>
                        )}
                        {e.subjectLabel ? <span className="text-xs text-muted-foreground">{e.subjectLabel}</span> : null}
                        {!e.applied ? <span className="rounded border border-rose-500/30 px-1 text-[10px] text-rose-300">not applied · awaiting review</span> : null}
                        {e.actor === "engine" ? <span className="text-[10px] text-muted-foreground">derived by lifecycle engine</span> : null}
                      </div>
                      {e.note ? <p className="mt-1 text-xs text-muted-foreground">{e.note}</p> : null}
                      <div className="mt-2"><EvidenceCard e={e.evidence} compact /></div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
