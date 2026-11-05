"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types (mirror backend read models) ──────────────────────────────────────

export interface Evidence {
  memoryId: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string | null;
  speaker: string | null;
  occurredAt: string;
  kind: string;
  summary: string;
  excerpt: string;
  excerptVerified: boolean;
  extractionMethod: "gemini" | "fallback";
  isDemo: boolean;
  ref?: string;
}

export interface ProjectCounts {
  conversations: number;
  decisions: number;
  verified: number;
  unverified: number;
  openCommitments: number;
  openReviews: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  counts: ProjectCounts;
}

export interface Decision {
  id: string;
  projectId: string;
  projectName: string;
  subjectKey: string;
  subjectLabel: string;
  option: string;
  title: string;
  reason: string | null;
  commitmentStatus: string;
  implementationStatus: string;
  disputed: boolean;
  supersededBy: { id: string; option: string } | null;
  firstSeenAt: string;
  proposedAt: string | null;
  decidedAt: string | null;
  implementedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  retiredAt: string | null;
  updatedAt: string;
  evidenceCount: number;
  isDemo: boolean;
}

export interface LifecycleEvent {
  id: string;
  seq: number;
  type: string;
  applied: boolean;
  actor: string;
  note: string | null;
  occurredAt: string;
  fromCommitment: string | null;
  toCommitment: string | null;
  fromImplementation: string | null;
  toImplementation: string | null;
  decisionId: string | null;
  option: string | null;
  subjectKey: string | null;
  subjectLabel: string | null;
  commitmentId: string | null;
  commitmentTitle: string | null;
  evidence: Evidence;
  projectName?: string;
}

export interface OptionState {
  decision: Decision;
  evidence: { proposed: Evidence | null; decided: Evidence | null; implemented: Evidence | null; verified: Evidence | null };
}

export interface ReviewItem {
  id: string;
  kind: string;
  title: string;
  detail: string;
  blocking: boolean;
  status: string;
  createdAt: string;
  decisionId: string | null;
  evidence: Evidence;
}

export interface SubjectState {
  subjectKey: string;
  label: string;
  cardinality: string;
  status: "VERIFIED" | "UNVERIFIED" | "DECIDED_NOT_IMPLEMENTED" | "UNDECIDED" | "DISPUTED";
  current: OptionState[];
  pending: OptionState[];
  proposed: OptionState[];
  previous: OptionState[];
  rejected: OptionState[];
  cancelled: OptionState[];
  openConflicts: ReviewItem[];
  lastUpdated: string | null;
}

export interface Commitment {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  owner: string | null;
  dueAt: string | null;
  status: string;
  overdue: boolean;
  openedAt: string;
  closedAt: string | null;
  evidence: Evidence[];
}

export interface CurrentState {
  project: Project;
  subjects: SubjectState[];
  commitments: Commitment[];
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  source: string;
  externalRef: string | null;
  occurredAt: string;
  recordedAt: string;
  isDemo: boolean;
  status: string;
  extractionMethod: string | null;
  extractionModel: string | null;
  extractionError: string | null;
  processedAt: string | null;
  messageCount: number;
  memoryCount: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: { id: string; seq: number; role: string; speaker: string | null; content: string }[];
  memories: {
    id: string; messageId: string | null; kind: string; summary: string; excerpt: string; excerptVerified: boolean;
    option: string | null; subjectLabel: string | null; reason: string | null; confidence: number; hedged: boolean;
    extractionMethod: string; decisionId: string | null; commitmentId: string | null;
  }[];
  events: LifecycleEvent[];
}

export interface ProcessResult {
  conversationId: string;
  method: "gemini" | "fallback";
  model: string | null;
  geminiError: string | null;
  memories: number;
  unverifiedExcerpts: number;
  embedded: number;
  projection: { decisions: number; events: number; reviews: number };
}

export interface SearchHit {
  evidence: Evidence;
  projectId: string;
  projectName: string;
  decisionId: string | null;
  score: number;
  matchedBy: string[];
}

export interface QueryAnswer {
  question: string;
  interpretation: { projectId: string | null; projectName: string | null; intents: string[]; subjects: string[]; options: string[]; dateRange: { from: string; to: string } | null; method: string };
  directAnswer: string;
  confidence: "high" | "medium" | "low";
  currentState: SubjectState[];
  reasoning: { option: string; subject: string; reason: string; decidedAt: string | null; evidenceIds: string[] }[];
  history: { date: string; subject: string | null; option: string | null; type: string; applied: boolean; note: string | null; evidenceIds: string[] }[];
  sections: { title: string; items: { label: string; status?: string; detail?: string; date?: string | null; decisionId?: string | null; evidenceIds: string[] }[] }[];
  reviewNotes: string[];
  evidence: (Evidence & { ref: string })[];
  related: SearchHit[];
  narrative: { text: string; citations: string[]; model: string } | null;
  generatedBy: string;
}

export interface GraphData {
  nodes: { id: string; type: string; label: string; status?: string; sublabel?: string; data: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; label: string; kind: string }[];
}

export interface Overview {
  stats: {
    projects: number; conversations: number; conversationsProcessed: number; memories: number; decisions: number;
    activeDecisions: number; verified: number; unverifiedClaims: number; pendingCommitments: number; openReviews: number; conflicts: number;
  };
  commitmentDistribution: { status: string; n: number }[];
  implementationDistribution: { status: string; n: number }[];
  recentActivity: LifecycleEvent[];
  projects: Project[];
}

// ── Fetching ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: "GET" | "POST" | "PATCH"; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/cos${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

/**
 * Minimal stale-while-revalidate fetch hook. `loading` is derived (the last
 * settled request was for a different path), so effects never set state synchronously.
 */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const latest = useRef<string | null>(path);

  useEffect(() => {
    latest.current = path;
    if (path === null) return;
    let cancelled = false;
    api<T>(path).then(
      (d) => {
        if (!cancelled) setState({ key: path, data: d, error: null });
      },
      (e: unknown) => {
        if (!cancelled) setState((s) => ({ key: path, data: s.data, error: e instanceof Error ? e.message : String(e) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const reload = useCallback(async () => {
    if (path === null) return;
    try {
      const d = await api<T>(path);
      if (latest.current === path) setState({ key: path, data: d, error: null });
    } catch (e) {
      if (latest.current === path) setState((s) => ({ ...s, key: path, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [path]);

  return {
    data: path === null ? null : state.data,
    error: state.key === path ? state.error : null,
    loading: path !== null && state.key !== path,
    reload,
  };
}
