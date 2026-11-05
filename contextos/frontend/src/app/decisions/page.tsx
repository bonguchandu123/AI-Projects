"use client";

import { useMemo, useState } from "react";
import { Gavel } from "lucide-react";
import { DecisionCard } from "@/components/decision-card";
import { EmptyState, ErrorState, LoadingRows, PageHeader, selectClass } from "@/components/cos";
import { DemoImportButton } from "@/components/demo-import-button";
import { useProjects } from "@/components/app-shell";
import { useApi, type Decision } from "@/lib/api";
import { cn } from "@/lib/utils";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "current", label: "In effect" },
  { key: "unverified", label: "Unverified claims" },
  { key: "pending", label: "Decided · not implemented" },
  { key: "proposed", label: "Proposed" },
  { key: "closed", label: "Rejected / superseded / cancelled" },
] as const;

function matches(d: Decision, f: string) {
  switch (f) {
    case "current": return d.implementationStatus === "VERIFIED" || d.implementationStatus === "CLAIMED_IMPLEMENTED";
    case "unverified": return d.implementationStatus === "CLAIMED_IMPLEMENTED";
    case "pending": return d.commitmentStatus === "DECIDED" && d.implementationStatus === "NOT_STARTED";
    case "proposed": return d.commitmentStatus === "PROPOSED";
    case "closed": return ["REJECTED", "SUPERSEDED", "CANCELLED", "REVERSED"].includes(d.commitmentStatus) || d.implementationStatus === "RETIRED";
    default: return true;
  }
}

export default function DecisionsPage() {
  const { projectId, project } = useProjects();
  const [filter, setFilter] = useState<string>("all");
  const [area, setArea] = useState<string>("");
  const { data, error, loading, reload } = useApi<Decision[]>(projectId ? `/decisions?projectId=${projectId}` : null);
  const areas = useMemo(() => [...new Set((data ?? []).map((d) => d.subjectLabel))], [data]);
  const shown = (data ?? []).filter((d) => matches(d, filter) && (!area || d.subjectLabel === area));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Gavel}
        title="Decision intelligence"
        description={`Every option ${project ? `in ${project.name} ` : ""}on two independent axes: commitment (proposed → decided…) and implementation (claimed → verified). Click a card for its full history and evidence.`}
      />
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", filter === f.key ? "border-primary/50 bg-primary/15 text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground")}>
            {f.label}
            {data ? <span className="ml-1.5 text-muted-foreground">{data.filter((d) => matches(d, f.key)).length}</span> : null}
          </button>
        ))}
        <select aria-label="Decision area" className={cn(selectClass, "ml-auto")} value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">All areas</option>
          {areas.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>
      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows rows={3} /> : null}
      {!projectId ? <EmptyState icon={Gavel} title="No project selected" action={<DemoImportButton />} /> : null}
      {data && data.length === 0 ? <EmptyState icon={Gavel} title="No decisions extracted yet" description="Ingest a conversation that proposes or decides something." /> : null}
      {data && data.length > 0 && shown.length === 0 ? <p className="text-sm text-muted-foreground">No decisions match this filter.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((d) => (
          <DecisionCard key={d.id} d={d} />
        ))}
      </div>
    </div>
  );
}
