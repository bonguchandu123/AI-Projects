/**
 * Read models. All authoritative answers come from the projection tables
 * (decisions, lifecycle_events, commitments, review_items), never from vector
 * similarity. Search is used only to find related memories.
 */
import type pg from "pg";
import type { GeminiClient } from "../ai/gemini.js";
import { NotFoundError } from "./context.js";

// ── Shared shapes ──────────────────────────────────────────────────────────

export interface EvidenceRef {
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
}

const EVIDENCE_SELECT = `
  m.id AS memory_id, m.conversation_id, c.title AS conversation_title, m.message_id, msg.speaker,
  m.occurred_at, m.kind, m.summary, m.excerpt, m.excerpt_verified, m.extraction_method, m.is_demo`;
const EVIDENCE_JOIN = `
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN messages msg ON msg.id = m.message_id`;

interface EvidenceRow {
  memory_id: string;
  conversation_id: string;
  conversation_title: string;
  message_id: string | null;
  speaker: string | null;
  occurred_at: Date;
  kind: string;
  summary: string;
  excerpt: string;
  excerpt_verified: boolean;
  extraction_method: "gemini" | "fallback";
  is_demo: boolean;
}

function toEvidence(r: EvidenceRow): EvidenceRef {
  return {
    memoryId: r.memory_id, conversationId: r.conversation_id, conversationTitle: r.conversation_title,
    messageId: r.message_id, speaker: r.speaker, occurredAt: r.occurred_at.toISOString(), kind: r.kind,
    summary: r.summary, excerpt: r.excerpt, excerptVerified: r.excerpt_verified,
    extractionMethod: r.extraction_method, isDemo: r.is_demo,
  };
}

export interface LifecycleEventView {
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
  evidence: EvidenceRef;
}

interface EventRow extends EvidenceRow {
  id: string;
  seq: number;
  event_type: string;
  applied: boolean;
  actor: string;
  note: string | null;
  event_occurred_at: Date;
  from_commitment: string | null;
  to_commitment: string | null;
  from_implementation: string | null;
  to_implementation: string | null;
  decision_id: string | null;
  option_name: string | null;
  subject_key: string | null;
  subject_label: string | null;
  commitment_id: string | null;
  commitment_title: string | null;
}

const EVENT_SQL = `
  SELECT e.id, e.seq, e.event_type, e.applied, e.actor, e.note, e.occurred_at AS event_occurred_at,
         e.from_commitment, e.to_commitment, e.from_implementation, e.to_implementation,
         e.decision_id, d.option_name, s.key AS subject_key, s.label AS subject_label,
         e.commitment_id, cm.title AS commitment_title, ${EVIDENCE_SELECT}
    FROM lifecycle_events e
    JOIN memories m ON m.id = e.memory_id ${EVIDENCE_JOIN}
    LEFT JOIN decisions d ON d.id = e.decision_id
    LEFT JOIN subjects s ON s.id = d.subject_id
    LEFT JOIN commitments cm ON cm.id = e.commitment_id`;

function toEvent(r: EventRow): LifecycleEventView {
  return {
    id: r.id, seq: r.seq, type: r.event_type, applied: r.applied, actor: r.actor, note: r.note,
    occurredAt: r.event_occurred_at.toISOString(), fromCommitment: r.from_commitment, toCommitment: r.to_commitment,
    fromImplementation: r.from_implementation, toImplementation: r.to_implementation, decisionId: r.decision_id,
    option: r.option_name, subjectKey: r.subject_key, subjectLabel: r.subject_label, commitmentId: r.commitment_id,
    commitmentTitle: r.commitment_title, evidence: toEvidence(r),
  };
}

// ── Projects & conversations ───────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  counts: { conversations: number; decisions: number; verified: number; unverified: number; openCommitments: number; openReviews: number };
}

export async function listProjects(pool: pg.Pool): Promise<ProjectSummary[]> {
  const r = await pool.query<{
    id: string; name: string; description: string; is_demo: boolean; created_at: Date; updated_at: Date;
    conversations: number; decisions: number; verified: number; unverified: number; open_commitments: number; open_reviews: number;
  }>(`
    SELECT p.id, p.name, p.description, p.is_demo, p.created_at, p.updated_at,
      (SELECT count(*)::int FROM conversations c WHERE c.project_id = p.id) AS conversations,
      (SELECT count(*)::int FROM decisions d WHERE d.project_id = p.id AND d.is_active) AS decisions,
      (SELECT count(*)::int FROM decisions d WHERE d.project_id = p.id AND d.is_active AND d.implementation_status = 'VERIFIED') AS verified,
      (SELECT count(*)::int FROM decisions d WHERE d.project_id = p.id AND d.is_active AND d.implementation_status = 'CLAIMED_IMPLEMENTED') AS unverified,
      (SELECT count(*)::int FROM commitments cm WHERE cm.project_id = p.id AND cm.is_active AND cm.status = 'OPEN') AS open_commitments,
      (SELECT count(*)::int FROM review_items ri WHERE ri.project_id = p.id AND ri.is_active AND ri.status = 'open') AS open_reviews
    FROM projects p ORDER BY p.created_at`);
  return r.rows.map((p) => ({
    id: p.id, name: p.name, description: p.description, isDemo: p.is_demo, createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
    counts: {
      conversations: p.conversations, decisions: p.decisions, verified: p.verified, unverified: p.unverified,
      openCommitments: p.open_commitments, openReviews: p.open_reviews,
    },
  }));
}

export async function getProject(pool: pg.Pool, id: string): Promise<ProjectSummary> {
  const p = (await listProjects(pool)).find((x) => x.id === id);
  if (!p) throw new NotFoundError("Project not found");
  return p;
}

/** Resolve a project by id or (case-insensitive) name. Used by MCP tools and queries. */
export async function resolveProject(pool: pg.Pool, ref: string): Promise<{ id: string; name: string } | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  const r = await pool.query<{ id: string; name: string }>(
    isUuid ? "SELECT id, name FROM projects WHERE id = $1" : "SELECT id, name FROM projects WHERE lower(name) = lower($1)",
    [ref],
  );
  return r.rows[0] ?? null;
}

export async function listConversations(pool: pg.Pool, projectId?: string) {
  const r = await pool.query<{
    id: string; project_id: string; project_name: string; title: string; source: string; external_ref: string | null;
    occurred_at: Date; recorded_at: Date; is_demo: boolean; status: string; extraction_method: string | null;
    extraction_model: string | null; extraction_error: string | null; processed_at: Date | null; messages: number; memories: number;
  }>(
    `SELECT c.id, c.project_id, p.name AS project_name, c.title, c.source, c.external_ref, c.occurred_at, c.recorded_at,
            c.is_demo, c.status, c.extraction_method, c.extraction_model, c.extraction_error, c.processed_at,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS messages,
            (SELECT count(*)::int FROM memories m WHERE m.conversation_id = c.id) AS memories
       FROM conversations c JOIN projects p ON p.id = c.project_id
      WHERE ($1::uuid IS NULL OR c.project_id = $1)
      ORDER BY c.occurred_at DESC`,
    [projectId ?? null],
  );
  return r.rows.map((c) => ({
    id: c.id, projectId: c.project_id, projectName: c.project_name, title: c.title, source: c.source,
    externalRef: c.external_ref, occurredAt: c.occurred_at.toISOString(), recordedAt: c.recorded_at.toISOString(),
    isDemo: c.is_demo, status: c.status, extractionMethod: c.extraction_method, extractionModel: c.extraction_model,
    extractionError: c.extraction_error, processedAt: c.processed_at?.toISOString() ?? null, messageCount: c.messages,
    memoryCount: c.memories,
  }));
}

export async function getConversation(pool: pg.Pool, id: string) {
  const list = await pool.query<{ project_id: string }>("SELECT project_id FROM conversations WHERE id = $1", [id]);
  if (!list.rows[0]) throw new NotFoundError("Conversation not found");
  const conv = (await listConversations(pool, list.rows[0].project_id)).find((c) => c.id === id)!;
  const messages = await pool.query<{ id: string; seq: number; role: string; speaker: string | null; content: string }>(
    "SELECT id, seq, role, speaker, content FROM messages WHERE conversation_id = $1 ORDER BY seq",
    [id],
  );
  const memories = await pool.query<{
    id: string; message_id: string | null; kind: string; summary: string; excerpt: string; excerpt_verified: boolean;
    option_name: string | null; subject_label: string | null; reason: string | null; confidence: number; hedged: boolean;
    extraction_method: string; decision_id: string | null; commitment_id: string | null;
  }>(
    `SELECT id, message_id, kind, summary, excerpt, excerpt_verified, option_name, subject_label, reason, confidence, hedged,
            extraction_method, decision_id, commitment_id
       FROM memories WHERE conversation_id = $1 ORDER BY item_index`,
    [id],
  );
  const events = await pool.query<EventRow>(`${EVENT_SQL} WHERE m.conversation_id = $1 ORDER BY e.seq`, [id]);
  return {
    ...conv,
    messages: messages.rows,
    memories: memories.rows.map((m) => ({
      id: m.id, messageId: m.message_id, kind: m.kind, summary: m.summary, excerpt: m.excerpt,
      excerptVerified: m.excerpt_verified, option: m.option_name, subjectLabel: m.subject_label, reason: m.reason,
      confidence: m.confidence, hedged: m.hedged, extractionMethod: m.extraction_method, decisionId: m.decision_id,
      commitmentId: m.commitment_id,
    })),
    events: events.rows.map(toEvent),
  };
}

// ── Decisions ──────────────────────────────────────────────────────────────

export interface DecisionView {
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

const DECISION_SQL = `
  SELECT d.*, p.name AS project_name, p.is_demo, s.key AS subject_key, s.label AS subject_label,
         sup.option_name AS superseded_by_option,
         (SELECT count(*)::int FROM memories m WHERE m.decision_id = d.id) AS evidence_count
    FROM decisions d
    JOIN projects p ON p.id = d.project_id
    JOIN subjects s ON s.id = d.subject_id
    LEFT JOIN decisions sup ON sup.id = d.superseded_by
   WHERE d.is_active`;

type DecisionRow = {
  id: string; project_id: string; project_name: string; is_demo: boolean; subject_key: string; subject_label: string;
  option_name: string; title: string; reason: string | null; commitment_status: string; implementation_status: string;
  is_disputed: boolean; superseded_by: string | null; superseded_by_option: string | null; first_seen_at: Date;
  proposed_at: Date | null; decided_at: Date | null; implemented_at: Date | null; verified_at: Date | null;
  closed_at: Date | null; retired_at: Date | null; updated_at: Date; evidence_count: number;
};
const iso = (d: Date | null) => d?.toISOString() ?? null;

function toDecision(d: DecisionRow): DecisionView {
  return {
    id: d.id, projectId: d.project_id, projectName: d.project_name, subjectKey: d.subject_key, subjectLabel: d.subject_label,
    option: d.option_name, title: d.title, reason: d.reason, commitmentStatus: d.commitment_status,
    implementationStatus: d.implementation_status, disputed: d.is_disputed,
    supersededBy: d.superseded_by && d.superseded_by_option ? { id: d.superseded_by, option: d.superseded_by_option } : null,
    firstSeenAt: d.first_seen_at.toISOString(), proposedAt: iso(d.proposed_at), decidedAt: iso(d.decided_at),
    implementedAt: iso(d.implemented_at), verifiedAt: iso(d.verified_at), closedAt: iso(d.closed_at),
    retiredAt: iso(d.retired_at), updatedAt: d.updated_at.toISOString(), evidenceCount: d.evidence_count, isDemo: d.is_demo,
  };
}

export async function listDecisions(
  pool: pg.Pool,
  f: { projectId?: string | undefined; commitment?: string | undefined; implementation?: string | undefined } = {},
): Promise<DecisionView[]> {
  const r = await pool.query<DecisionRow>(
    `${DECISION_SQL}
       AND ($1::uuid IS NULL OR d.project_id = $1)
       AND ($2::text IS NULL OR d.commitment_status = $2)
       AND ($3::text IS NULL OR d.implementation_status = $3)
     ORDER BY s.key, coalesce(d.decided_at, d.proposed_at, d.first_seen_at)`,
    [f.projectId ?? null, f.commitment ?? null, f.implementation ?? null],
  );
  return r.rows.map(toDecision);
}

export async function getDecision(pool: pg.Pool, id: string) {
  const r = await pool.query<DecisionRow>(`${DECISION_SQL} AND d.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new NotFoundError("Decision not found");
  return { ...toDecision(row), history: await getDecisionHistory(pool, id), evidence: await getDecisionEvidence(pool, id) };
}

export async function getDecisionHistory(pool: pg.Pool, decisionId: string): Promise<LifecycleEventView[]> {
  const r = await pool.query<EventRow>(`${EVENT_SQL} WHERE e.decision_id = $1 ORDER BY e.seq`, [decisionId]);
  return r.rows.map(toEvent);
}

export async function getDecisionEvidence(pool: pg.Pool, decisionId: string): Promise<EvidenceRef[]> {
  const r = await pool.query<EvidenceRow>(
    `SELECT ${EVIDENCE_SELECT} FROM memories m ${EVIDENCE_JOIN} WHERE m.decision_id = $1 ORDER BY m.occurred_at, m.item_index`,
    [decisionId],
  );
  return r.rows.map(toEvidence);
}

// ── Current state ──────────────────────────────────────────────────────────

export interface OptionState {
  decision: DecisionView;
  evidence: { proposed: EvidenceRef | null; decided: EvidenceRef | null; implemented: EvidenceRef | null; verified: EvidenceRef | null };
}

export interface ReviewSummary {
  id: string;
  kind: string;
  title: string;
  detail: string;
  blocking: boolean;
  status: string;
  createdAt: string;
  decisionId: string | null;
  evidence: EvidenceRef;
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
  openConflicts: ReviewSummary[];
  lastUpdated: string | null;
}

export async function getCurrentState(pool: pg.Pool, projectId: string): Promise<{ project: ProjectSummary; subjects: SubjectState[]; commitments: CommitmentView[] }> {
  const project = await getProject(pool, projectId);
  const decisions = await listDecisions(pool, { projectId });
  const events = await pool.query<EventRow>(`${EVENT_SQL} WHERE e.project_id = $1 AND e.applied ORDER BY e.seq`, [projectId]);
  const reviews = await listReviews(pool, { projectId, status: "open" });
  const subjects = await pool.query<{ key: string; label: string; cardinality: string }>(
    "SELECT key, label, cardinality FROM subjects WHERE project_id = $1 ORDER BY key",
    [projectId],
  );

  const evidenceFor = (decisionId: string, type: string): EvidenceRef | null => {
    const e = [...events.rows].reverse().find((x) => x.decision_id === decisionId && x.event_type === type);
    return e ? toEvidence(e) : null;
  };
  const optionState = (d: DecisionView): OptionState => ({
    decision: d,
    evidence: {
      proposed: evidenceFor(d.id, "PROPOSED"),
      decided: evidenceFor(d.id, "DECIDED"),
      implemented: evidenceFor(d.id, "IMPLEMENTATION_CLAIMED"),
      verified: evidenceFor(d.id, "VERIFIED"),
    },
  });

  const out: SubjectState[] = [];
  for (const s of subjects.rows) {
    const ds = decisions.filter((d) => d.subjectKey === s.key);
    if (ds.length === 0) continue;
    const current = ds.filter((d) => d.implementationStatus === "CLAIMED_IMPLEMENTED" || d.implementationStatus === "VERIFIED");
    const pending = ds.filter((d) => d.commitmentStatus === "DECIDED" && d.implementationStatus === "NOT_STARTED");
    const proposed = ds.filter((d) => d.commitmentStatus === "PROPOSED" && d.implementationStatus === "NOT_STARTED");
    const previous = ds.filter(
      (d) => d.implementationStatus === "RETIRED" || ((d.commitmentStatus === "SUPERSEDED" || d.commitmentStatus === "REVERSED") && !current.includes(d)),
    );
    const rejected = ds.filter((d) => d.commitmentStatus === "REJECTED");
    const cancelled = ds.filter((d) => d.commitmentStatus === "CANCELLED");
    const conflicts = reviews.filter((r) => r.kind === "conflict" && r.blocking && ds.some((d) => d.id === r.decisionId));
    const subjectEvents = events.rows.filter((e) => ds.some((d) => d.id === e.decision_id));
    const status: SubjectState["status"] =
      conflicts.length > 0 || ds.some((d) => d.disputed)
        ? "DISPUTED"
        : current.some((d) => d.implementationStatus === "VERIFIED")
          ? "VERIFIED"
          : current.length > 0
            ? "UNVERIFIED"
            : pending.length > 0
              ? "DECIDED_NOT_IMPLEMENTED"
              : "UNDECIDED";
    out.push({
      subjectKey: s.key, label: s.label, cardinality: s.cardinality, status,
      current: current.map(optionState), pending: pending.map(optionState), proposed: proposed.map(optionState),
      previous: previous.map(optionState), rejected: rejected.map(optionState), cancelled: cancelled.map(optionState),
      openConflicts: conflicts,
      lastUpdated: subjectEvents.at(-1)?.event_occurred_at.toISOString() ?? null,
    });
  }
  return { project, subjects: out, commitments: await listCommitments(pool, projectId) };
}

// ── Commitments ────────────────────────────────────────────────────────────

export interface CommitmentView {
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
  evidence: EvidenceRef[];
}

export async function listCommitments(pool: pg.Pool, projectId?: string, status?: string): Promise<CommitmentView[]> {
  const r = await pool.query<{
    id: string; project_id: string; project_name: string; title: string; owner: string | null; due_at: Date | null;
    status: string; opened_at: Date; closed_at: Date | null;
  }>(
    `SELECT cm.id, cm.project_id, p.name AS project_name, cm.title, cm.owner, cm.due_at, cm.status, cm.opened_at, cm.closed_at
       FROM commitments cm JOIN projects p ON p.id = cm.project_id
      WHERE cm.is_active AND ($1::uuid IS NULL OR cm.project_id = $1) AND ($2::text IS NULL OR cm.status = $2)
      ORDER BY cm.opened_at`,
    [projectId ?? null, status ?? null],
  );
  const ev = await pool.query<EvidenceRow & { commitment_id: string }>(
    `SELECT m.commitment_id, ${EVIDENCE_SELECT} FROM memories m ${EVIDENCE_JOIN}
      WHERE m.commitment_id = ANY($1::uuid[]) ORDER BY m.occurred_at`,
    [r.rows.map((x) => x.id)],
  );
  const now = Date.now();
  return r.rows.map((c) => ({
    id: c.id, projectId: c.project_id, projectName: c.project_name, title: c.title, owner: c.owner,
    dueAt: iso(c.due_at), status: c.status, overdue: c.status === "OPEN" && !!c.due_at && c.due_at.getTime() < now,
    openedAt: c.opened_at.toISOString(), closedAt: iso(c.closed_at),
    evidence: ev.rows.filter((e) => e.commitment_id === c.id).map(toEvidence),
  }));
}

// ── Reviews ────────────────────────────────────────────────────────────────

export async function listReviews(pool: pg.Pool, f: { projectId?: string | undefined; status?: string | undefined } = {}): Promise<ReviewSummary[]> {
  const r = await pool.query<EvidenceRow & {
    review_id: string; review_kind: string; title: string; detail: string; blocking: boolean; status: string; created_at: Date; decision_id: string | null;
  }>(
    `SELECT ri.id AS review_id, ri.kind AS review_kind, ri.title, ri.detail, ri.blocking, ri.status, ri.created_at, ri.decision_id, ${EVIDENCE_SELECT}
       FROM review_items ri JOIN memories m ON m.id = ri.memory_id ${EVIDENCE_JOIN}
      WHERE ri.is_active AND ($1::uuid IS NULL OR ri.project_id = $1) AND ($2::text IS NULL OR ri.status = $2)
      ORDER BY ri.blocking DESC, m.occurred_at DESC`,
    [f.projectId ?? null, f.status ?? null],
  );
  return r.rows.map((x) => ({
    id: x.review_id, kind: x.review_kind, title: x.title, detail: x.detail, blocking: x.blocking, status: x.status,
    createdAt: x.created_at.toISOString(), decisionId: x.decision_id, evidence: toEvidence(x),
  }));
}

// ── Timeline ───────────────────────────────────────────────────────────────

export async function getTimeline(
  pool: pg.Pool,
  f: { projectId?: string | undefined; types?: string[] | undefined; from?: Date | undefined; to?: Date | undefined; includeCorroborations?: boolean | undefined },
): Promise<LifecycleEventView[]> {
  const r = await pool.query<EventRow>(
    `${EVENT_SQL}
     WHERE ($1::uuid IS NULL OR e.project_id = $1)
       AND ($2::text[] IS NULL OR e.event_type = ANY($2))
       AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
       AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)
       AND ($5::boolean OR e.event_type <> 'CORROBORATED')
     ORDER BY e.occurred_at, e.project_id, e.seq`,
    [f.projectId ?? null, f.types?.length ? f.types : null, f.from ?? null, f.to ?? null, f.includeCorroborations ?? false],
  );
  return r.rows.map(toEvent);
}

// ── Graph ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: "project" | "subject" | "decision" | "event" | "conversation" | "commitment" | "entity";
  label: string;
  status?: string;
  sublabel?: string;
  data: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
}

export async function getGraph(pool: pg.Pool, projectId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const project = await getProject(pool, projectId);
  const decisions = await listDecisions(pool, { projectId });
  const events = await getTimeline(pool, { projectId });
  const commitments = await listCommitments(pool, projectId);
  const rels = await pool.query<{ id: string; predicate: string; s_id: string; s_name: string; t_id: string; t_name: string }>(
    `SELECT r.id, r.predicate, se.id AS s_id, se.name AS s_name, te.id AS t_id, te.name AS t_name
       FROM relationships r JOIN entities se ON se.id = r.source_entity_id JOIN entities te ON te.id = r.target_entity_id
      WHERE r.project_id = $1`,
    [projectId],
  );

  const nodes: GraphNode[] = [{ id: `p:${project.id}`, type: "project", label: project.name, data: { ...project } }];
  const edges: GraphEdge[] = [];
  const subjectsSeen = new Set<string>();
  for (const d of decisions) {
    const sid = `s:${d.subjectKey}`;
    if (!subjectsSeen.has(sid)) {
      subjectsSeen.add(sid);
      nodes.push({ id: sid, type: "subject", label: d.subjectLabel, data: { subjectKey: d.subjectKey } });
      edges.push({ id: `e:${project.id}:${sid}`, source: `p:${project.id}`, target: sid, label: "has decision area", kind: "structure" });
    }
    nodes.push({
      id: `d:${d.id}`, type: "decision", label: d.option, status: `${d.commitmentStatus} · ${d.implementationStatus}`,
      sublabel: d.reason ?? undefined, data: { ...d },
    } as GraphNode);
    edges.push({ id: `e:${sid}:${d.id}`, source: sid, target: `d:${d.id}`, label: "option", kind: "structure" });
    if (d.supersededBy) {
      edges.push({ id: `sup:${d.id}`, source: `d:${d.supersededBy.id}`, target: `d:${d.id}`, label: "supersedes", kind: "supersedes" });
    }
  }
  const convSeen = new Set<string>();
  for (const e of events) {
    if (e.type === "CORROBORATED") continue;
    const owner = e.decisionId ? `d:${e.decisionId}` : e.commitmentId ? `c:${e.commitmentId}` : null;
    if (!owner) continue;
    nodes.push({
      id: `ev:${e.id}`, type: "event", label: e.type.replace(/_/g, " ").toLowerCase(), status: e.applied ? "applied" : "held",
      sublabel: e.occurredAt.slice(0, 10), data: { ...e },
    });
    edges.push({ id: `e:${owner}:${e.id}`, source: owner, target: `ev:${e.id}`, label: e.applied ? "lifecycle" : "held for review", kind: e.applied ? "lifecycle" : "conflict" });
    const cid = `cv:${e.evidence.conversationId}`;
    if (!convSeen.has(cid)) {
      convSeen.add(cid);
      nodes.push({
        id: cid, type: "conversation", label: e.evidence.conversationTitle, sublabel: e.evidence.occurredAt.slice(0, 10),
        data: { conversationId: e.evidence.conversationId },
      });
    }
    edges.push({ id: `e:${e.id}:${cid}`, source: `ev:${e.id}`, target: cid, label: "evidence", kind: "evidence" });
  }
  for (const c of commitments) {
    nodes.push({ id: `c:${c.id}`, type: "commitment", label: c.title, status: c.status, sublabel: c.owner ?? undefined, data: { ...c } } as GraphNode);
    edges.push({ id: `e:p:${c.id}`, source: `p:${project.id}`, target: `c:${c.id}`, label: "commitment", kind: "structure" });
  }
  for (const r of rels.rows) {
    for (const [id, name] of [[r.s_id, r.s_name], [r.t_id, r.t_name]] as const) {
      if (!nodes.some((n) => n.id === `en:${id}`)) nodes.push({ id: `en:${id}`, type: "entity", label: name, data: { entityId: id } });
    }
    edges.push({ id: `r:${r.id}`, source: `en:${r.s_id}`, target: `en:${r.t_id}`, label: r.predicate.replace(/_/g, " "), kind: "relationship" });
  }
  return { nodes, edges };
}

// ── Overview ───────────────────────────────────────────────────────────────

export async function getOverview(pool: pg.Pool) {
  const s = await pool.query<{
    projects: number; conversations: number; processed: number; decisions: number; active: number; verified: number;
    unverified: number; open_commitments: number; open_reviews: number; conflicts: number; memories: number;
  }>(`SELECT
      (SELECT count(*)::int FROM projects) AS projects,
      (SELECT count(*)::int FROM conversations) AS conversations,
      (SELECT count(*)::int FROM conversations WHERE status = 'processed') AS processed,
      (SELECT count(*)::int FROM decisions WHERE is_active AND commitment_status <> 'NONE') AS decisions,
      (SELECT count(*)::int FROM decisions WHERE is_active AND commitment_status = 'DECIDED') AS active,
      (SELECT count(*)::int FROM decisions WHERE is_active AND implementation_status = 'VERIFIED') AS verified,
      (SELECT count(*)::int FROM decisions WHERE is_active AND implementation_status = 'CLAIMED_IMPLEMENTED') AS unverified,
      (SELECT count(*)::int FROM commitments WHERE is_active AND status = 'OPEN') AS open_commitments,
      (SELECT count(*)::int FROM review_items WHERE is_active AND status = 'open') AS open_reviews,
      (SELECT count(*)::int FROM review_items WHERE is_active AND status = 'open' AND kind = 'conflict') AS conflicts,
      (SELECT count(*)::int FROM memories) AS memories`);
  const byCommitment = await pool.query<{ status: string; n: number }>(
    "SELECT commitment_status AS status, count(*)::int AS n FROM decisions WHERE is_active GROUP BY 1 ORDER BY 1",
  );
  const byImplementation = await pool.query<{ status: string; n: number }>(
    "SELECT implementation_status AS status, count(*)::int AS n FROM decisions WHERE is_active GROUP BY 1 ORDER BY 1",
  );
  const recent = await pool.query<EventRow & { project_name: string }>(
    `SELECT * FROM (${EVENT_SQL.replace("SELECT e.id,", "SELECT pr.name AS project_name, e.id,").replace(
      "FROM lifecycle_events e",
      "FROM lifecycle_events e JOIN projects pr ON pr.id = e.project_id",
    )} WHERE e.event_type <> 'CORROBORATED' ORDER BY e.occurred_at DESC, e.seq DESC LIMIT 12) x`,
  );
  const stats = s.rows[0]!;
  return {
    stats: {
      projects: stats.projects, conversations: stats.conversations, conversationsProcessed: stats.processed,
      memories: stats.memories, decisions: stats.decisions, activeDecisions: stats.active, verified: stats.verified,
      unverifiedClaims: stats.unverified, pendingCommitments: stats.open_commitments, openReviews: stats.open_reviews,
      conflicts: stats.conflicts,
    },
    commitmentDistribution: byCommitment.rows,
    implementationDistribution: byImplementation.rows,
    recentActivity: recent.rows.map((r) => ({ ...toEvent(r), projectName: r.project_name })),
    projects: await listProjects(pool),
  };
}

// ── Search (hybrid: full-text + pgvector) ──────────────────────────────────

export interface SearchHit {
  evidence: EvidenceRef;
  projectId: string;
  projectName: string;
  decisionId: string | null;
  score: number;
  matchedBy: string[];
}

export async function searchMemories(
  pool: pg.Pool,
  gemini: GeminiClient | null,
  q: string,
  opts: { projectId?: string | undefined; limit?: number | undefined } = {},
): Promise<{ hits: SearchHit[]; modes: string[] }> {
  const limit = opts.limit ?? 10;
  const k = 60; // reciprocal rank fusion constant
  const scores = new Map<string, { score: number; by: Set<string> }>();
  const add = (ids: string[], mode: string) =>
    ids.forEach((id, rank) => {
      const cur = scores.get(id) ?? { score: 0, by: new Set<string>() };
      cur.score += 1 / (k + rank + 1);
      cur.by.add(mode);
      scores.set(id, cur);
    });
  const modes: string[] = [];

  const fts = await pool.query<{ id: string }>(
    `SELECT id FROM memories
      WHERE ($2::uuid IS NULL OR project_id = $2) AND search_tsv @@ websearch_to_tsquery('english', $1)
      ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', $1)) DESC LIMIT 30`,
    [q, opts.projectId ?? null],
  );
  add(fts.rows.map((r) => r.id), "full-text");
  modes.push("full-text");

  if (fts.rows.length === 0) {
    // Lenient keyword fallback: any significant word.
    const words = q.toLowerCase().match(/[a-z0-9.]{4,}/g) ?? [];
    if (words.length) {
      const kw = await pool.query<{ id: string }>(
        `SELECT id FROM memories
          WHERE ($2::uuid IS NULL OR project_id = $2) AND search_tsv @@ to_tsquery('english', $1) LIMIT 30`,
        [words.map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join(" | "), opts.projectId ?? null],
      );
      add(kw.rows.map((r) => r.id), "keyword");
      modes.push("keyword");
    }
  }

  if (gemini) {
    try {
      const [vec] = await gemini.embed([q]);
      const v = await pool.query<{ id: string }>(
        `SELECT id FROM memories
          WHERE embedding IS NOT NULL AND ($2::uuid IS NULL OR project_id = $2)
          ORDER BY embedding <=> $1::vector LIMIT 30`,
        [JSON.stringify(vec), opts.projectId ?? null],
      );
      add(v.rows.map((r) => r.id), "semantic");
      modes.push("semantic (pgvector)");
    } catch {
      // Semantic search is optional; full-text results stand on their own.
    }
  }

  const top = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  if (top.length === 0) return { hits: [], modes };
  const rows = await pool.query<EvidenceRow & { project_id: string; project_name: string; decision_id: string | null }>(
    `SELECT m.project_id, p.name AS project_name, m.decision_id, ${EVIDENCE_SELECT}
       FROM memories m ${EVIDENCE_JOIN} JOIN projects p ON p.id = m.project_id WHERE m.id = ANY($1::uuid[])`,
    [top.map(([id]) => id)],
  );
  const byId = new Map(rows.rows.map((r) => [r.memory_id, r]));
  return {
    hits: top.flatMap(([id, s]) => {
      const r = byId.get(id);
      return r
        ? [{ evidence: toEvidence(r), projectId: r.project_id, projectName: r.project_name, decisionId: r.decision_id, score: Number(s.score.toFixed(4)), matchedBy: [...s.by] }]
        : [];
    }),
    modes,
  };
}
