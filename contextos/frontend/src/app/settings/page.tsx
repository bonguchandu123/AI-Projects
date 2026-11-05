"use client";

import { CheckCircle2, CircleAlert, Copy, Database, Plug, Server, Sparkles, Webhook, Workflow } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ErrorState, LoadingRows, PageHeader, Section } from "@/components/cos";
import { useApi } from "@/lib/api";
import { fmtDate } from "@/lib/status";

interface SettingsStatus {
  system: { ready: boolean; version: string; database: { reachable: boolean; pgvectorVersion: string | null; pendingMigrations: number | null; error?: string } };
  gemini: { configured: boolean; model: string | null; embeddingModel: string | null; extractionMode: string };
  webhook: { endpoint: string; secretConfigured: boolean; counts: Record<string, number>; recent: { event: string; status: string; receivedAt: string; signature: string; error: string | null }[] };
  mcp: { endpoint: string; transport: string; allowedHosts: string[] };
  worker: { enabled: boolean; jobs: Record<string, number> };
}

function Row({ label, ok, value }: { label: string; ok: boolean | null; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 text-right font-mono text-xs">
        {ok === null ? null : ok ? <CheckCircle2 className="size-4 text-emerald-400" /> : <CircleAlert className="size-4 text-amber-400" />}
        {value}
      </span>
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
      className="flex w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-background/50 px-2.5 py-1.5 text-left font-mono text-xs hover:border-primary/40"
    >
      <span className="truncate">{text}</span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground"><Copy className="size-3" />{copied ? "copied" : ""}</span>
    </button>
  );
}

export default function SettingsPage() {
  const { data, error, loading, reload } = useApi<SettingsStatus>("/settings/status");
  return (
    <div className="space-y-6">
      <PageHeader icon={Plug} title="Integrations & status" description="Live status of every component. Secrets are never displayed." />
      {error ? <ErrorState message={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows rows={3} /> : null}
      {data ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="Backend & database" actions={<Server className="size-4 text-muted-foreground" />}>
            <div className="divide-y divide-border/60">
              <Row label="Backend API" ok value={`v${data.system.version}`} />
              <Row label="PostgreSQL" ok={data.system.database.reachable} value={data.system.database.reachable ? "reachable" : "unreachable"} />
              <Row label="pgvector" ok={data.system.database.pgvectorVersion !== null} value={data.system.database.pgvectorVersion ?? "missing"} />
              <Row label="Pending migrations" ok={data.system.database.pendingMigrations === 0} value={String(data.system.database.pendingMigrations ?? "?")} />
              <Row label="Overall" ok={data.system.ready} value={data.system.ready ? "ready" : "not ready"} />
            </div>
          </Section>

          <Section title="Gemini" actions={<Sparkles className="size-4 text-muted-foreground" />}>
            <div className="divide-y divide-border/60">
              <Row label="API key" ok={data.gemini.configured} value={data.gemini.configured ? "configured (hidden)" : "not configured"} />
              <Row label="Extraction" ok={null} value={data.gemini.extractionMode} />
              <Row label="Model" ok={null} value={data.gemini.model ?? "—"} />
              <Row label="Embeddings" ok={null} value={data.gemini.embeddingModel ?? "— (full-text search only)"} />
            </div>
            {!data.gemini.configured ? (
              <p className="mt-3 text-xs text-muted-foreground">Set <code className="rounded bg-muted px-1">GEMINI_API_KEY</code> in <code className="rounded bg-muted px-1">backend/.env</code> and restart the backend. Until then every extraction is labelled “Fallback extractor”.</p>
            ) : null}
          </Section>

          <Section title="Odysseus → ContextOS (automatic capture)" description="Odysseus outbound webhook: chat.completed" actions={<Webhook className="size-4 text-muted-foreground" />}>
            <div className="divide-y divide-border/60">
              <Row label="Endpoint" ok={null} value={data.webhook.endpoint} />
              <Row label="HMAC secret" ok={data.webhook.secretConfigured} value={data.webhook.secretConfigured ? "configured (hidden)" : "not set — unsigned deliveries accepted"} />
              <Row label="Deliveries" ok={null} value={Object.entries(data.webhook.counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "none yet"} />
            </div>
            {data.webhook.recent.length ? (
              <ul className="mt-3 space-y-1 text-xs">
                {data.webhook.recent.map((r, i) => (
                  <li key={i} className="flex justify-between gap-2 text-muted-foreground">
                    <span>{r.event} · {r.status} · signature {r.signature}</span>
                    <span>{fmtDate(r.receivedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 text-xs text-amber-200/90">
              Odysseus blocks webhook URLs on private/loopback addresses (SSRF protection). Live chat-triggered delivery needs a publicly reachable ContextOS URL. Locally, delivery was verified by running Odysseus’s own delivery code in its container (see docs/integration-results.md). Manual ingestion is the local fallback.
            </div>
          </Section>

          <Section title="ContextOS → Odysseus (MCP tools)" description={data.mcp.transport} actions={<Workflow className="size-4 text-muted-foreground" />}>
            <div className="space-y-2 text-xs">
              <p className="text-muted-foreground">Add an MCP server in Odysseus (Admin → MCP) with transport <b>http</b> and URL:</p>
              <CopyLine text="http://host.docker.internal:4000/mcp" />
              <p className="text-muted-foreground">From the host machine:</p>
              <CopyLine text="http://127.0.0.1:4000/mcp" />
              <p className="pt-1 text-muted-foreground">Allowed Host headers (DNS-rebinding protection): {data.mcp.allowedHosts.join(", ")}</p>
              <p className="text-muted-foreground">Tools: contextos_status, get_current_state, get_decision_history, get_decision_evidence, get_pending_commitments, get_unverified_claims, search_memory, get_project_summary (all read-only).</p>
            </div>
          </Section>

          <Section title="Background worker" actions={<Database className="size-4 text-muted-foreground" />}>
            <div className="divide-y divide-border/60">
              <Row label="Postgres job worker" ok={data.worker.enabled} value={data.worker.enabled ? "running" : "disabled"} />
              <Row label="Jobs" ok={null} value={Object.entries(data.worker.jobs).map(([k, v]) => `${k}: ${v}`).join(" · ") || "none"} />
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  );
}
