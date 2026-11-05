"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FolderKanban, Loader2, Pencil, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DemoBadge, ErrorState, EvidenceCard, LoadingRows, MethodBadge, PageHeader, Section, StatusPill } from "@/components/cos";
import { SubjectStateCard } from "@/components/state-card";
import { useProjects } from "@/components/app-shell";
import { api, useApi, type ConversationSummary, type CurrentState, type Project } from "@/lib/api";
import { fmtDate } from "@/lib/status";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { setProjectId, reloadProjects } = useProjects();
  const { data, error, loading, reload } = useApi<Project & { state: CurrentState }>(`/projects/${id}`);
  const convs = useApi<ConversationSummary[]>(`/conversations?projectId=${id}`);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => setProjectId(id), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      await api(`/projects/${id}`, { method: "PATCH", body: { name, description } });
      setEditing(false);
      await reload();
      await reloadProjects();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (loading && !data) return <LoadingRows rows={4} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <Link href="/projects" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" /> Projects
      </Link>
      {editing ? (
        <div className="space-y-2 rounded-xl border border-border/70 bg-card/60 p-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Project name" />
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} aria-label="Description" />
          {saveError ? <ErrorState message={saveError} /> : null}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <PageHeader
          icon={FolderKanban}
          title={data.name}
          description={data.description || "No description"}
          actions={
            <>
              {data.isDemo ? <DemoBadge /> : null}
              <Button size="sm" variant="outline" onClick={() => { setName(data.name); setDescription(data.description); setEditing(true); }}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            </>
          }
        />
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold">Current project state</h2>
        {data.state.subjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions extracted yet.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.state.subjects.map((s) => (
              <SubjectStateCard key={s.subjectKey} s={s} />
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Commitments" description="Action items and their lifecycle.">
          {data.state.commitments.length === 0 ? <p className="text-sm text-muted-foreground">None recorded.</p> : null}
          <ul className="space-y-3">
            {data.state.commitments.map((c) => (
              <li key={c.id} className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusPill status={c.overdue ? "OVERDUE" : c.status} />
                  <span className="font-medium">{c.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.owner ? `${c.owner} · ` : ""}
                    {c.dueAt ? `due ${fmtDate(c.dueAt)}` : "no due date"}
                  </span>
                </div>
                {c.evidence[0] ? <EvidenceCard e={c.evidence[0]} compact /> : null}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Conversations" actions={<Link href="/ingest" className="text-xs text-primary hover:underline">Ingest →</Link>}>
          {convs.data?.length === 0 ? <p className="text-sm text-muted-foreground">No conversations yet.</p> : null}
          <ul className="divide-y divide-border/60">
            {convs.data?.map((c) => (
              <li key={c.id}>
                <Link href={`/conversations/${c.id}`} className="flex flex-wrap items-center gap-2 py-2 text-sm hover:text-primary">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{fmtDate(c.occurredAt)}</span>
                  <span className="font-medium">{c.title}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {c.memoryCount} memories <MethodBadge method={c.extractionMethod} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
