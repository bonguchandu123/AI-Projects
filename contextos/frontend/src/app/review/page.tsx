"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Hammer, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, EvidenceCard, LoadingRows, PageHeader, Section, StatusPill } from "@/components/cos";
import { useProjects } from "@/components/app-shell";
import { api, useApi, type Decision, type ReviewItem } from "@/lib/api";
import { fmtDate } from "@/lib/status";
import { cn } from "@/lib/utils";

function ReviewCard({ r, onResolved }: { r: ReviewItem; onResolved: () => void }) {
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (action: "confirm" | "dismiss") => {
    setBusy(action);
    setError(null);
    try {
      await api(`/reviews/${r.id}/resolve`, { method: "POST", body: { action } });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const open = r.status === "open";
  return (
    <div className={cn("rounded-xl border bg-card/60 p-4", r.blocking && open ? "border-rose-500/30" : "border-border/70")}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={r.kind} />
        <span className="font-medium">{r.title}</span>
        {!r.blocking ? <span className="text-[11px] text-muted-foreground">informational · already applied</span> : null}
        <span className="ml-auto"><StatusPill status={r.status} /></span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{r.detail}</p>
      <div className="mt-3"><EvidenceCard e={r.evidence} /></div>
      {error ? <div className="mt-2"><ErrorState message={error} /></div> : null}
      {open && r.blocking ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void resolve("confirm")} disabled={busy !== null}>
            {busy === "confirm" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Confirm &amp; apply
          </Button>
          <Button size="sm" variant="outline" onClick={() => void resolve("dismiss")} disabled={busy !== null}>
            {busy === "dismiss" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} Dismiss (keep recorded state)
          </Button>
          <span className="text-[11px] text-muted-foreground">Your choice is fed back into the deterministic engine and survives re-processing.</span>
        </div>
      ) : null}
      {open && !r.blocking ? (
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={() => void resolve("dismiss")} disabled={busy !== null}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Acknowledge
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function ReviewPage() {
  const { projectId, project, reloadProjects } = useProjects();
  const [showResolved, setShowResolved] = useState(false);
  const { data, error, loading, reload } = useApi<{ items: ReviewItem[]; unverifiedClaims: Decision[] }>(
    projectId ? `/reviews?projectId=${projectId}` : "/reviews",
  );
  const items = (data?.items ?? []).filter((r) => (showResolved ? true : r.status === "open"));
  const blocking = items.filter((r) => r.blocking);
  const info = items.filter((r) => !r.blocking);
  const refresh = () => {
    void reload();
    void reloadProjects();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldAlert}
        title="Review queue"
        description={`Anything the lifecycle engine refused to apply automatically${project ? ` in ${project.name}` : ""}: contradictions, ambiguous statements and unverifiable evidence — plus implementation claims nobody has verified.`}
        actions={
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} className="accent-primary" /> Show resolved
          </label>
        }
      />
      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows rows={3} /> : null}

      {data ? (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <h2 className="text-sm font-semibold">Needs a human decision ({blocking.length})</h2>
            {blocking.length === 0 ? <EmptyState icon={ShieldCheck} title="Nothing is blocked" description="No contradictions or ambiguous transitions are waiting." /> : null}
            {blocking.map((r) => (
              <ReviewCard key={r.id} r={r} onResolved={refresh} />
            ))}
            {info.length ? <h2 className="pt-2 text-sm font-semibold">Missing evidence &amp; notes ({info.length})</h2> : null}
            {info.map((r) => (
              <ReviewCard key={r.id} r={r} onResolved={refresh} />
            ))}
          </div>
          <Section title={`Unverified implementation claims (${data.unverifiedClaims.length})`} description="Someone said it was implemented. No one has verified it.">
            {data.unverifiedClaims.length === 0 ? <p className="text-sm text-muted-foreground">All implementation claims are verified.</p> : null}
            <ul className="space-y-2">
              {data.unverifiedClaims.map((d) => (
                <li key={d.id}>
                  <Link href={`/decisions/${d.id}`} className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm hover:border-amber-500/50">
                    <Hammer className="size-4 text-amber-300" />
                    <div className="flex-1">
                      <div className="font-medium">{d.option} <span className="font-normal text-muted-foreground">· {d.subjectLabel}</span></div>
                      <div className="text-xs text-muted-foreground">Claimed {fmtDate(d.implementedAt)} · {d.projectName}</div>
                    </div>
                    <StatusPill status="CLAIMED_IMPLEMENTED" />
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}
    </div>
  );
}
