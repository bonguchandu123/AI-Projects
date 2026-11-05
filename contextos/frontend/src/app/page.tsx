"use client";

import Link from "next/link";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Activity, CheckCircle2, FolderKanban, Gavel, Hammer, LayoutDashboard, ListChecks, MessagesSquare, ShieldAlert, ArrowRight,
} from "lucide-react";
import { DemoBadge, EmptyState, ErrorState, LoadingRows, PageHeader, Section, StatCard, StatusPill } from "@/components/cos";
import { DemoImportButton } from "@/components/demo-import-button";
import { useApi, type Overview } from "@/lib/api";
import { fmtDate, statusMeta } from "@/lib/status";

const BAR_COLORS: Record<string, string> = {
  PROPOSED: "#38bdf8", DECIDED: "#a78bfa", REJECTED: "#fb7185", CANCELLED: "#71717a", REVERSED: "#fb923c", SUPERSEDED: "#94a3b8", NONE: "#52525b",
  NOT_STARTED: "#52525b", CLAIMED_IMPLEMENTED: "#fbbf24", VERIFIED: "#34d399", RETIRED: "#94a3b8",
};

function Distribution({ data }: { data: { status: string; n: number }[] }) {
  if (data.length === 0) return <p className="text-sm text-muted-foreground">No decisions yet.</p>;
  const rows = data.map((d) => ({ ...d, label: statusMeta(d.status).label }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 34)}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={130} tick={{ fill: "#a1a1aa", fontSize: 12 }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={{ background: "#151823", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
        <Bar dataKey="n" name="Options" radius={[0, 4, 4, 0]} barSize={16}>
          {rows.map((r) => (
            <Cell key={r.status} fill={BAR_COLORS[r.status] ?? "#a78bfa"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function OverviewPage() {
  const { data, error, loading, reload } = useApi<Overview>("/overview");

  return (
    <div className="space-y-6">
      <PageHeader
        icon={LayoutDashboard}
        title="Overview"
        description="What your team proposed, decided, shipped and verified — computed from conversation evidence by a deterministic lifecycle engine."
        actions={<DemoImportButton variant="outline" size="sm" onDone={() => void reload()} />}
      />
      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows rows={4} /> : null}
      {data && data.stats.projects === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No project memory yet"
          description="Import the StudyMate demo dataset (synthetic, clearly labelled) or ingest your own conversations."
          action={<DemoImportButton onDone={() => void reload()} />}
        />
      ) : null}
      {data && data.stats.projects > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Projects" value={data.stats.projects} icon={FolderKanban} href="/projects" />
            <StatCard label="Conversations processed" value={`${data.stats.conversationsProcessed}/${data.stats.conversations}`} icon={MessagesSquare} hint={`${data.stats.memories} memories extracted`} href="/ingest" />
            <StatCard label="Decisions tracked" value={data.stats.decisions} icon={Gavel} hint={`${data.stats.activeDecisions} active (decided)`} href="/decisions" />
            <StatCard label="Verified implementations" value={data.stats.verified} icon={CheckCircle2} tone="text-emerald-400" href="/decisions" />
            <StatCard label="Unverified claims" value={data.stats.unverifiedClaims} icon={Hammer} tone="text-amber-400" hint="Claimed, never verified" href="/review" />
            <StatCard label="Pending commitments" value={data.stats.pendingCommitments} icon={ListChecks} tone="text-sky-400" href="/projects" />
            <StatCard label="Conflicts to review" value={data.stats.conflicts} icon={ShieldAlert} tone="text-rose-400" hint={`${data.stats.openReviews} open review items`} href="/review" />
            <StatCard label="Active decisions" value={data.stats.activeDecisions} icon={Activity} tone="text-violet-400" href="/decisions" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Commitment lifecycle" description="Where each option stands: proposed, decided, rejected, superseded…">
              <Distribution data={data.commitmentDistribution} />
            </Section>
            <Section title="Implementation lifecycle" description="Claims are not verification — they are counted separately.">
              <Distribution data={data.implementationDistribution} />
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <Section title="Recent lifecycle activity" description="Latest transitions, each backed by a conversation excerpt." actions={<Link href="/timeline" className="text-xs text-primary hover:underline">Timeline →</Link>}>
                <ul className="divide-y divide-border/60">
                  {data.recentActivity.map((e) => (
                    <li key={e.id} className="flex items-start gap-3 py-2.5">
                      <StatusPill status={e.type} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          <span className="font-medium">{e.option ?? e.commitmentTitle}</span>
                          {e.subjectLabel ? <span className="text-muted-foreground"> · {e.subjectLabel}</span> : null}
                        </p>
                        <Link href={`/conversations/${e.evidence.conversationId}`} className="line-clamp-1 text-xs text-muted-foreground hover:text-primary">
                          “{e.evidence.excerpt}”
                        </Link>
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                        <div>{fmtDate(e.occurredAt)}</div>
                        <div>{e.projectName}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
            <div className="lg:col-span-2">
              <Section title="Projects">
                <div className="space-y-2.5">
                  {data.projects.map((p) => (
                    <Link key={p.id} href={`/projects/${p.id}`} className="group block rounded-lg border border-border/70 p-3 transition-colors hover:border-primary/40">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{p.name}</span>
                        <div className="flex items-center gap-1.5">
                          {p.isDemo ? <DemoBadge /> : null}
                          <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{p.counts.conversations} conversations</span>
                        <span>{p.counts.decisions} options</span>
                        <span className="text-emerald-300">{p.counts.verified} verified</span>
                        {p.counts.unverified ? <span className="text-amber-300">{p.counts.unverified} unverified</span> : null}
                        {p.counts.openReviews ? <span className="text-rose-300">{p.counts.openReviews} to review</span> : null}
                      </div>
                    </Link>
                  ))}
                </div>
              </Section>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
