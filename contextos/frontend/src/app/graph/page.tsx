"use client";

import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { FileText, FolderKanban, Gavel, Layers, ListChecks, Network, Tag, X, Zap } from "lucide-react";
import { EmptyState, ErrorState, LoadingRows, PageHeader, StatusPill } from "@/components/cos";
import { DemoImportButton } from "@/components/demo-import-button";
import { useProjects } from "@/components/app-shell";
import { useApi, type GraphData } from "@/lib/api";
import { fmtDate, statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

type GNode = GraphData["nodes"][number];
const TYPE_META: Record<string, { label: string; icon: typeof Gavel; cls: string }> = {
  project: { label: "Project", icon: FolderKanban, cls: "border-indigo-400/60 bg-indigo-500/15" },
  subject: { label: "Decision area", icon: Layers, cls: "border-slate-400/40 bg-slate-500/10" },
  decision: { label: "Option", icon: Gavel, cls: "border-violet-400/50 bg-violet-500/10" },
  event: { label: "Lifecycle event", icon: Zap, cls: "border-border bg-card" },
  conversation: { label: "Evidence (conversation)", icon: FileText, cls: "border-teal-400/40 bg-teal-500/10" },
  commitment: { label: "Commitment", icon: ListChecks, cls: "border-sky-400/40 bg-sky-500/10" },
  entity: { label: "Entity", icon: Tag, cls: "border-zinc-400/40 bg-zinc-500/10" },
};

function CosNode({ data, selected }: NodeProps<Node<{ g: GNode }>>) {
  const g = data.g;
  const meta = TYPE_META[g.type] ?? TYPE_META.entity!;
  const Icon = meta.icon;
  const eventType = g.type === "event" ? String((g.data as { type?: string }).type ?? "") : "";
  const evMeta = eventType ? statusMeta(eventType) : null;
  return (
    <div className={cn("min-w-36 max-w-52 rounded-lg border px-2.5 py-1.5 text-left shadow-sm", evMeta ? evMeta.tone : meta.cls, selected && "ring-2 ring-primary")}>
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-muted-foreground/60" />
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" /> {evMeta ? "event" : meta.label}
      </div>
      <div className={cn("truncate text-xs font-semibold text-foreground", g.type === "project" && "text-sm")}>{evMeta ? evMeta.label : g.label}</div>
      {g.sublabel ? <div className="truncate text-[10px] text-muted-foreground">{g.sublabel}</div> : null}
      {g.type === "decision" && g.status ? <div className="mt-0.5 truncate text-[10px] text-violet-200/80">{g.status.replace(/_/g, " ").toLowerCase()}</div> : null}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-muted-foreground/60" />
    </div>
  );
}
const nodeTypes = { cos: CosNode };

function layout(g: GraphData, hidden: Set<string>): { nodes: Node<{ g: GNode }>[]; edges: Edge[] } {
  const visible = g.nodes.filter((n) => !hidden.has(n.type));
  const ids = new Set(visible.map((n) => n.id));
  const pos = new Map<string, { x: number; y: number }>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const childrenOf = (id: string) => g.edges.filter((e) => e.source === id && e.kind === "structure").map((e) => e.target);

  let y = 0;
  const ROW = 96;
  const project = g.nodes.find((n) => n.type === "project");
  const subjects = project ? childrenOf(project.id).filter((id) => byId.get(id)?.type === "subject") : [];
  for (const sid of subjects) {
    const decisions = childrenOf(sid);
    const startY = y;
    for (const did of decisions) {
      pos.set(did, { x: 470, y });
      const events = g.edges.filter((e) => e.source === did && (e.kind === "lifecycle" || e.kind === "conflict")).map((e) => e.target);
      events
        .sort((a, b) => String((byId.get(a)?.data as { occurredAt?: string }).occurredAt).localeCompare(String((byId.get(b)?.data as { occurredAt?: string }).occurredAt)))
        .forEach((eid, i) => pos.set(eid, { x: 720 + i * 200, y }));
      y += ROW;
    }
    pos.set(sid, { x: 240, y: (startY + y - ROW) / 2 });
    y += 24;
  }
  const commitments = g.nodes.filter((n) => n.type === "commitment");
  for (const c of commitments) {
    pos.set(c.id, { x: 240, y });
    g.edges.filter((e) => e.source === c.id && e.kind === "lifecycle").forEach((e, i) => pos.set(e.target, { x: 470 + i * 200, y }));
    y += ROW;
  }
  if (project) pos.set(project.id, { x: 0, y: Math.max(0, (y - ROW) / 2) });
  const convs = g.nodes.filter((n) => n.type === "conversation").sort((a, b) => String(a.sublabel).localeCompare(String(b.sublabel)));
  const maxX = Math.max(1700, ...[...pos.values()].map((p) => p.x + 230));
  const step = convs.length > 1 ? Math.max(ROW, (y - ROW) / (convs.length - 1)) : 0;
  convs.forEach((c, i) => pos.set(c.id, { x: maxX, y: i * step }));
  g.nodes.filter((n) => n.type === "entity").forEach((n, i) => pos.set(n.id, { x: 0, y: y + 60 + i * 60 }));

  const nodes: Node<{ g: GNode }>[] = visible.map((n) => ({
    id: n.id, type: "cos", position: pos.get(n.id) ?? { x: 0, y: 0 }, data: { g: n },
  }));
  const edges: Edge[] = g.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: e.id, source: e.source, target: e.target,
      label: e.kind === "supersedes" || e.kind === "conflict" || e.kind === "relationship" ? e.label : undefined,
      animated: e.kind === "conflict",
      style: {
        stroke: e.kind === "evidence" ? "rgba(45,212,191,0.25)" : e.kind === "supersedes" ? "rgba(148,163,184,0.8)" : e.kind === "conflict" ? "rgba(251,113,133,0.9)" : "rgba(167,139,250,0.45)",
        strokeDasharray: e.kind === "evidence" || e.kind === "supersedes" ? "4 4" : undefined,
      },
      labelStyle: { fill: "#cbd5e1", fontSize: 10 },
      labelBgStyle: { fill: "#151823" },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "rgba(167,139,250,0.6)" },
    }));
  return { nodes, edges };
}

interface DetailData {
  id?: string; type?: string; description?: string; commitmentStatus?: string; implementationStatus?: string; reason?: string | null;
  decidedAt?: string | null; verifiedAt?: string | null; occurredAt?: string; applied?: boolean; actor?: string; note?: string | null;
  evidence?: { excerpt: string; conversationId: string; conversationTitle: string }; conversationId?: string; status?: string;
  overdue?: boolean; owner?: string | null; dueAt?: string | null;
}

function Details({ n, onClose }: { n: GNode; onClose: () => void }) {
  const d = n.data as DetailData;
  return (
    <div className="absolute right-3 top-3 z-10 w-80 rounded-xl border border-border/80 bg-card/95 p-4 text-sm shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{TYPE_META[n.type]?.label}</div>
          <div className="font-semibold">{n.type === "event" ? statusMeta(String(d.type)).label : n.label}</div>
        </div>
        <button onClick={onClose} aria-label="Close details" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>
      <div className="mt-3 space-y-2 text-xs">
        {n.type === "decision" ? (
          <>
            <div className="flex flex-wrap gap-1.5"><StatusPill status={d.commitmentStatus ?? "NONE"} /><StatusPill status={d.implementationStatus ?? "NOT_STARTED"} /></div>
            {d.reason ? <p><span className="text-muted-foreground">Why:</span> {d.reason}</p> : null}
            <p className="text-muted-foreground">Decided {fmtDate(d.decidedAt)} · Verified {fmtDate(d.verifiedAt)}</p>
            <Link href={`/decisions/${d.id}`} className="text-primary hover:underline">Open decision →</Link>
          </>
        ) : null}
        {n.type === "event" ? (
          <>
            <p className="text-muted-foreground">{fmtDate(d.occurredAt)} · {d.applied ? "applied" : "held for review"} · by {d.actor}</p>
            {d.note ? <p>{d.note}</p> : null}
            <p className="rounded-md border border-border/60 p-2 italic">“{d.evidence?.excerpt}”</p>
            <Link href={`/conversations/${d.evidence?.conversationId}`} className="text-primary hover:underline">{d.evidence?.conversationTitle} →</Link>
          </>
        ) : null}
        {n.type === "conversation" ? <Link href={`/conversations/${d.conversationId}`} className="text-primary hover:underline">Open source conversation →</Link> : null}
        {n.type === "commitment" ? (
          <>
            <StatusPill status={d.overdue ? "OVERDUE" : (d.status ?? "OPEN")} />
            <p className="text-muted-foreground">{d.owner ? `Owner ${d.owner} · ` : ""}{d.dueAt ? `due ${fmtDate(d.dueAt)}` : "no due date"}</p>
          </>
        ) : null}
        {n.type === "project" ? <p className="text-muted-foreground">{d.description}</p> : null}
      </div>
    </div>
  );
}

export default function GraphPage() {
  const { projectId, project } = useProjects();
  const { data, error, loading, reload } = useApi<GraphData>(projectId ? `/memory/graph/${projectId}` : null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<GNode | null>(null);
  const flow = useMemo(() => (data ? layout(data, hidden) : null), [data, hidden]);
  const toggle = (t: string) => setHidden((h) => { const n = new Set(h); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  return (
    <div className="space-y-5">
      <PageHeader icon={Network} title="Memory graph" description={`${project?.name ?? "Project"} → decision areas → options → lifecycle events → source conversations. Built from real database records.`} />
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(TYPE_META).filter(([t]) => t !== "project").map(([t, m]) => {
          const count = data?.nodes.filter((n) => n.type === t).length ?? 0;
          return (
            <button key={t} onClick={() => toggle(t)} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors", hidden.has(t) ? "border-border/50 text-muted-foreground/50 line-through" : "border-border text-foreground")}>
              <m.icon className="size-3" /> {m.label} <span className="text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>
      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
      {!projectId ? <EmptyState icon={Network} title="No project selected" action={<DemoImportButton />} /> : null}
      {loading && !data ? <LoadingRows rows={1} className="[&>*]:h-[560px]" /> : null}
      {data && data.nodes.length <= 1 ? <EmptyState icon={Network} title="Nothing to graph yet" description="Ingest conversations to build this project's memory graph." /> : null}
      {flow && data && data.nodes.length > 1 ? (
        <div className="relative h-[620px] overflow-hidden rounded-xl border border-border/70 bg-card/30">
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            colorMode="dark"
            nodesConnectable={false}
            onNodeClick={(_, n) => setSelected((n.data as { g: GNode }).g)}
            onPaneClick={() => setSelected(null)}
          >
            <Background gap={22} size={1} color="rgba(255,255,255,0.06)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(10,12,20,0.7)" nodeColor={() => "rgba(167,139,250,0.5)"} style={{ background: "#151823" }} />
          </ReactFlow>
          {selected ? <Details n={selected} onClose={() => setSelected(null)} /> : null}
        </div>
      ) : null}
    </div>
  );
}
