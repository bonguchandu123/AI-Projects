"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, Bot, FileText, FlaskConical, Inbox, Quote, Sparkles, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Evidence } from "@/lib/api";
import { fmtDate, statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions, icon: Icon }: { title: string; description?: string; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col gap-4 border-b border-border/60 pb-5 md:flex-row md:items-end md:justify-between">
      <div className="flex items-start gap-3">
        {Icon ? (
          <div className="mt-0.5 flex size-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <Icon className="size-4.5" />
          </div>
        ) : null}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatusPill({ status, className, label }: { status: string; className?: string; label?: string }) {
  const m = statusMeta(status);
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium", m.tone, className)}>
      <Icon className="size-3" aria-hidden />
      {label ?? m.label}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span title="Synthetic demonstration data" className="inline-flex items-center gap-1 rounded-md border border-fuchsia-500/25 bg-fuchsia-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fuchsia-300">
      <FlaskConical className="size-3" aria-hidden /> Demo data
    </span>
  );
}

export function MethodBadge({ method }: { method: string | null }) {
  if (!method) return null;
  const gemini = method === "gemini";
  return (
    <span
      title={gemini ? "Extracted by Gemini (structured output, validated)" : "Extracted by the deterministic rule-based fallback (Gemini not used)"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        gemini ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-300" : "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
      )}
    >
      {gemini ? <Sparkles className="size-3" aria-hidden /> : <Bot className="size-3" aria-hidden />}
      {gemini ? "Gemini" : "Fallback extractor"}
    </span>
  );
}

export function EvidenceCard({ e, compact, refId }: { e: Evidence; compact?: boolean; refId?: string }) {
  return (
    <Link
      href={`/conversations/${e.conversationId}${e.messageId ? `#m-${e.messageId}` : ""}`}
      className="group block rounded-lg border border-border/70 bg-background/40 p-3 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="flex items-start gap-2">
        {refId ? (
          <span className="mt-0.5 shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">{refId}</span>
        ) : (
          <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <p className={cn("text-sm leading-snug text-foreground/90", compact && "line-clamp-2")}>“{e.excerpt}”</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground/70 group-hover:text-primary">
          <FileText className="size-3" aria-hidden />
          {e.conversationTitle}
        </span>
        <span>·</span>
        <span>{fmtDate(e.occurredAt)}</span>
        {e.speaker ? (
          <>
            <span>·</span>
            <span>{e.speaker}</span>
          </>
        ) : null}
        {!e.excerptVerified ? <span className="text-rose-300">· excerpt not found in source</span> : null}
        {!compact ? <MethodBadge method={e.extractionMethod} /> : null}
        {e.isDemo && !compact ? <DemoBadge /> : null}
      </div>
    </Link>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="mt-4 font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="flex-1">
        <p className="font-medium text-destructive">Something went wrong</p>
        <p className="mt-0.5 text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function StatCard({ label, value, icon: Icon, tone = "text-primary", hint, href }: { label: string; value: number | string; icon: LucideIcon; tone?: string; hint?: string; href?: string }) {
  const body = (
    <div className="group h-full rounded-xl border border-border/70 bg-card/60 p-4 transition-colors hover:border-border">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className={cn("size-4", tone)} aria-hidden />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function Section({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/50">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&>option]:bg-popover";
