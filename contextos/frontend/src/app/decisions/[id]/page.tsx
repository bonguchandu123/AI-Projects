"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Gavel, GitBranch, ShieldAlert } from "lucide-react";
import { DemoBadge, ErrorState, EvidenceCard, LoadingRows, PageHeader, Section, StatusPill } from "@/components/cos";
import { useApi, type Decision, type Evidence, type LifecycleEvent } from "@/lib/api";
import { fmtDate, statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

const COMMIT_STEPS = ["PROPOSED", "DECIDED"];
const IMPL_STEPS = ["CLAIMED_IMPLEMENTED", "VERIFIED"];

function Axis({ title, steps, current, closed }: { title: string; steps: string[]; current: string; closed?: string | null }) {
  const reached = steps.indexOf(current);
  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="mt-3 flex items-center gap-2">
        {steps.map((s, i) => {
          const on = reached >= i;
          const m = statusMeta(s);
          return (
            <div key={s} className="flex flex-1 items-center gap-2">
              <div className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", on ? m.tone : "border-border/60 text-muted-foreground/60")}>
                <m.icon className="size-3.5" /> {m.label}
              </div>
              {i < steps.length - 1 ? <div className={cn("h-px flex-1", reached > i ? "bg-primary/50" : "bg-border")} /> : null}
            </div>
          );
        })}
      </div>
      {closed ? <div className="mt-3"><StatusPill status={closed} /></div> : null}
    </div>
  );
}

export default function DecisionPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi<Decision & { history: LifecycleEvent[]; evidence: Evidence[] }>(`/decisions/${id}`);

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <LoadingRows rows={4} />;
  if (!data) return null;
  const closedCommit = ["REJECTED", "CANCELLED", "REVERSED", "SUPERSEDED"].includes(data.commitmentStatus) ? data.commitmentStatus : null;

  return (
    <div className="space-y-6">
      <Link href="/decisions" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" /> Decisions
      </Link>
      <PageHeader
        icon={Gavel}
        title={`${data.option}`}
        description={`${data.subjectLabel} · ${data.projectName}${data.reason ? ` · Why: ${data.reason}` : ""}`}
        actions={
          <>
            {data.isDemo ? <DemoBadge /> : null}
            <StatusPill status={data.commitmentStatus} />
            <StatusPill status={data.implementationStatus} />
          </>
        }
      />
      {data.disputed ? (
        <Link href="/review" className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200 hover:bg-rose-500/10">
          <ShieldAlert className="size-4" /> A conflicting statement about this area is held for review and has not changed the recorded state. Open the review queue →
        </Link>
      ) : null}
      {data.supersededBy ? (
        <Link href={`/decisions/${data.supersededBy.id}`} className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/50 p-3 text-sm hover:border-primary/40">
          <GitBranch className="size-4 text-muted-foreground" /> Superseded by <span className="font-medium">{data.supersededBy.option}</span> on {fmtDate(data.closedAt)} — kept as history.
        </Link>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Axis title="Commitment lifecycle" steps={COMMIT_STEPS} current={data.commitmentStatus === "SUPERSEDED" && data.decidedAt ? "DECIDED" : data.commitmentStatus} closed={closedCommit} />
        <Axis title="Implementation lifecycle" steps={IMPL_STEPS} current={data.implementationStatus} closed={data.implementationStatus === "RETIRED" ? "RETIRED" : null} />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Section title="Lifecycle history" description="Append-only. Each step references the memory that caused it.">
          <ol className="relative space-y-4 border-l border-border/70 pl-5">
            {data.history.map((e) => {
              const m = statusMeta(e.type);
              return (
                <li key={e.id} className="relative">
                  <span className={cn("absolute -left-[26px] top-1 size-2.5 rounded-full ring-4 ring-background", m.dot)} />
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={e.type} />
                    <span className="text-xs text-muted-foreground">{fmtDate(e.occurredAt)}</span>
                    <span className="text-[11px] text-muted-foreground">by {e.actor}{e.applied ? "" : " · not applied"}</span>
                  </div>
                  {e.fromCommitment && e.toCommitment && e.fromCommitment !== e.toCommitment ? (
                    <p className="mt-1 text-xs text-muted-foreground">Commitment: {statusMeta(e.fromCommitment).label} → {statusMeta(e.toCommitment).label}</p>
                  ) : null}
                  {e.fromImplementation && e.toImplementation && e.fromImplementation !== e.toImplementation ? (
                    <p className="mt-1 text-xs text-muted-foreground">Implementation: {statusMeta(e.fromImplementation).label} → {statusMeta(e.toImplementation).label}</p>
                  ) : null}
                  {e.note ? <p className="mt-0.5 text-xs text-foreground/70">{e.note}</p> : null}
                  <div className="mt-2"><EvidenceCard e={e.evidence} compact /></div>
                </li>
              );
            })}
          </ol>
        </Section>
        <Section title={`All evidence (${data.evidence.length})`} description="Every stored memory linked to this option.">
          <div className="space-y-2">
            {data.evidence.map((e) => (
              <EvidenceCard key={e.memoryId} e={e} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
