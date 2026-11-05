"use client";

import Link from "next/link";
import { GitBranch, ShieldAlert } from "lucide-react";
import { DemoBadge, StatusPill } from "@/components/cos";
import type { Decision } from "@/lib/api";
import { fmtDate } from "@/lib/status";
import { cn } from "@/lib/utils";

export function DecisionCard({ d }: { d: Decision }) {
  const closed = ["REJECTED", "SUPERSEDED", "CANCELLED", "REVERSED"].includes(d.commitmentStatus);
  return (
    <Link href={`/decisions/${d.id}`} className={cn("group flex h-full flex-col rounded-xl border bg-card/60 p-4 transition-colors hover:border-primary/40", d.disputed ? "border-rose-500/40" : "border-border/70")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{d.subjectLabel}</div>
          <div className={cn("mt-0.5 text-lg font-semibold tracking-tight", closed && "text-muted-foreground")}>{d.option}</div>
        </div>
        {d.disputed ? <ShieldAlert className="size-4 text-rose-400" aria-label="Disputed" /> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <StatusPill status={d.commitmentStatus} />
        <StatusPill status={d.implementationStatus} />
      </div>
      {d.reason ? <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">Why: {d.reason}</p> : <p className="mt-3 text-sm text-muted-foreground/60">No reason recorded</p>}
      {d.supersededBy ? (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="size-3" /> Superseded by {d.supersededBy.option}
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-[11px] text-muted-foreground">
        <span>{d.decidedAt ? `Decided ${fmtDate(d.decidedAt)}` : `Proposed ${fmtDate(d.proposedAt ?? d.firstSeenAt)}`}</span>
        {d.verifiedAt ? <span className="text-emerald-300">Verified {fmtDate(d.verifiedAt)}</span> : d.implementedAt ? <span className="text-amber-300">Claimed {fmtDate(d.implementedAt)}</span> : null}
        <span className="ml-auto">{d.evidenceCount} evidence</span>
        {d.isDemo ? <DemoBadge /> : null}
      </div>
    </Link>
  );
}

