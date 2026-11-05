"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, FolderKanban, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DemoBadge, EmptyState, ErrorState, PageHeader, Section } from "@/components/cos";
import { DemoImportButton } from "@/components/demo-import-button";
import { useProjects } from "@/components/app-shell";
import { api, type Project } from "@/lib/api";
import { fmtDate } from "@/lib/status";

export default function ProjectsPage() {
  const { projects, reloadProjects, setProjectId, loading } = useProjects();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<Project>("/projects", { method: "POST", body: { name, description } });
      setName("");
      setDescription("");
      await reloadProjects();
      setProjectId(p.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={FolderKanban} title="Projects" description="Each project has its own conversations, decision areas, lifecycle history and commitments." actions={<DemoImportButton variant="outline" size="sm" />} />
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {!loading && projects.length === 0 ? <EmptyState icon={FolderKanban} title="No projects yet" description="Create one, or import the StudyMate demo dataset." action={<DemoImportButton />} /> : null}
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} onClick={() => setProjectId(p.id)} className="group block rounded-xl border border-border/70 bg-card/60 p-4 transition-colors hover:border-primary/40">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold">{p.name}</span>
                    {p.isDemo ? <DemoBadge /> : null}
                  </div>
                  {p.description ? <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{p.description}</p> : null}
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
                {[
                  ["Conversations", p.counts.conversations, ""],
                  ["Options", p.counts.decisions, ""],
                  ["Verified", p.counts.verified, "text-emerald-300"],
                  ["Unverified", p.counts.unverified, "text-amber-300"],
                  ["Open commitments", p.counts.openCommitments, "text-sky-300"],
                  ["To review", p.counts.openReviews, "text-rose-300"],
                ].map(([k, v, c]) => (
                  <div key={k as string} className="rounded-md border border-border/60 px-1 py-1.5">
                    <div className={`text-base font-semibold tabular-nums ${c as string}`}>{v as number}</div>
                    <div className="text-[10px] text-muted-foreground">{k as string}</div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">Created {fmtDate(p.createdAt)}</p>
            </Link>
          ))}
        </div>
        <Section title="New project">
          <form onSubmit={create} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pname">Name</Label>
              <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Orbit" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pdesc">Description</Label>
              <Textarea id="pdesc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1000} />
            </div>
            {error ? <ErrorState message={error} /> : null}
            <Button type="submit" disabled={busy || !name.trim()} className="w-full">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create project
            </Button>
          </form>
        </Section>
      </div>
    </div>
  );
}
