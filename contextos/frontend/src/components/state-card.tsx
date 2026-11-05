"use client";

import Link from "next/link";
import { ArrowRight, GitBranch, ShieldAlert } from "lucide-react";
import { EvidenceCard, StatusPill } from "@/components/cos";
import type { OptionState, SubjectState } from "@/lib/api";
import { fmtDate } from "@/lib/status";

function OptionLine({ o, muted }: { o: OptionState; muted?: boolean }) {
  const d = o.decision;
  return (
    <Link href={`/decisions/${d.id}`} className="flex flex-wrap items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-accent/40">
      <span className={muted ? "text-muted-foreground line-through decoration-muted-foreground/50" : "font-medium"}>{d.option}</span>
      <StatusPill status={d.commitmentStatus} />
      {d.implementationStatus !== "NOT_STARTED" ? <StatusPill status={d.implementationStatus} /> : null}
      {d.supersededBy ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <GitBranch className="size-3" /> by {d.supersededBy.option}
        </span>
      ) : null}
    </Link>
  );
}

export function SubjectStateCard({ s, showEvidence = true }: { s: SubjectState; showEvidence?: boolean }) {
  const cur = s.current[0] ?? s.pending[0];
  return (
    <div className="rounded-xl border border-border/70 bg-card/60">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</span>
        <StatusPill status={s.status} />
      </div>
      <div className="space-y-3 p-4">
        {cur ? (
          <div>
            <div className="text-[11px] text-muted-foreground">{s.current.length ? "Current" : "Decided, not yet implemented"}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <Link href={`/decisions/${cur.decision.id}`} className="text-2xl font-semibold tracking-tight hover:text-primary">
                {cur.decision.option}
              </Link>
              <StatusPill status={cur.decision.implementationStatus === "NOT_STARTED" ? cur.decision.commitmentStatus : cur.decision.implementationStatus} />
            </div>
            {cur.decision.reason ? (
              <p className="mt-1.5 text-sm text-muted-foreground">
                <span className="text-foreground/80">Why:</span> {cur.decision.reason}
              </p>
            ) : null}
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              {[
                ["Decided", cur.decision.decidedAt],
                ["Implemented", cur.decision.implementedAt],
                ["Verified", cur.decision.verifiedAt],
              ].map(([k, v]) => (
                <div key={k} className="rounded-md border border-border/60 px-2 py-1.5">
                  <div className="text-muted-foreground">{k}</div>
                  <div className={v ? "font-medium" : "text-muted-foreground"}>{fmtDate(v)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : s.proposed.length ? (
          <p className="text-sm text-muted-foreground">No decision yet. Open proposals: {s.proposed.map((p) => p.decision.option).join(", ")}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing in effect.</p>
        )}

        {s.openConflicts.map((c) => (
          <div key={c.id} className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-rose-300">
              <ShieldAlert className="size-3.5" /> {c.title}
            </div>
            <p className="mt-1 text-muted-foreground">“{c.evidence.excerpt}” — held for review, not applied.</p>
            <Link href="/review" className="mt-1 inline-flex items-center gap-1 text-rose-300 hover:underline">
              Review <ArrowRight className="size-3" />
            </Link>
          </div>
        ))}

        {s.previous.length || s.rejected.length || s.cancelled.length || (s.current.length && s.proposed.length) ? (
          <div className="space-y-0.5 border-t border-border/60 pt-2">
            <div className="text-[11px] text-muted-foreground">History</div>
            {[...s.previous, ...s.rejected, ...s.cancelled].map((o) => (
              <OptionLine key={o.decision.id} o={o} muted />
            ))}
            {s.current.length ? s.proposed.map((o) => <OptionLine key={o.decision.id} o={o} />) : null}
          </div>
        ) : null}

        {showEvidence && cur ? (
          <div className="space-y-2 border-t border-border/60 pt-3">
            <div className="text-[11px] text-muted-foreground">Supporting evidence</div>
            {[cur.evidence.decided, cur.evidence.implemented, cur.evidence.verified].filter(Boolean).map((e) => (
              <EvidenceCard key={e!.memoryId} e={e!} compact />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
