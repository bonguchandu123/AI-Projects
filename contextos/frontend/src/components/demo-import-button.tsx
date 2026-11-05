"use client";

import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type ProcessResult } from "@/lib/api";
import { useProjects } from "@/components/app-shell";

export function DemoImportButton({ onDone, size = "default", variant = "default" }: { onDone?: () => void; size?: "default" | "sm" | "lg"; variant?: "default" | "outline" }) {
  const { reloadProjects, setProjectId } = useProjects();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ projectId: string; conversations: ProcessResult[] }>("/demo/import", { method: "POST" });
      const methods = new Set(r.conversations.map((c) => c.method));
      setMsg(`Imported ${r.conversations.length} demo conversations · extraction: ${[...methods].join(" + ")}`);
      await reloadProjects();
      setProjectId(r.projectId);
      onDone?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button onClick={run} disabled={busy} size={size} variant={variant}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
        {busy ? "Importing & processing…" : "Import StudyMate demo"}
      </Button>
      {msg ? <p className="text-xs text-muted-foreground">{msg}</p> : null}
    </div>
  );
}
