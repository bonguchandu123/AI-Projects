/**
 * Turns read models into compact MCP context packets. Compact on purpose:
 * Odysseus's roadmap flags tool output/context bloat for smaller local models.
 */
import type { ContextosMcpDeps } from "@contextos/mcp-server";
import { SUBJECT_SYNONYMS } from "../extraction/catalog.js";
import { NotFoundError, type ServiceContext } from "../services/context.js";
import {
  getCurrentState, getDecisionEvidence, getTimeline, listCommitments, listDecisions, resolveProject, searchMemories,
  type EvidenceRef, type OptionState, type SubjectState,
} from "../services/read.js";
import { getSystemStatus } from "../status.js";

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const ev = (e: EvidenceRef | null) =>
  e ? { date: day(e.occurredAt), conversation: e.conversationTitle, speaker: e.speaker, excerpt: e.excerpt, extraction: e.extractionMethod, demo_data: e.isDemo || undefined } : null;

function option(o: OptionState) {
  const d = o.decision;
  return {
    option: d.option,
    commitment: d.commitmentStatus,
    implementation: d.implementationStatus,
    reason: d.reason,
    decided: day(d.decidedAt),
    implemented: day(d.implementedAt),
    verified: day(d.verifiedAt),
    superseded_by: d.supersededBy?.option ?? null,
    evidence: [o.evidence.decided, o.evidence.implemented, o.evidence.verified].filter(Boolean).map((e) => ev(e)),
  };
}

function matchSubject(states: SubjectState[], subject?: string): SubjectState[] {
  if (!subject) return states;
  const s = subject.toLowerCase();
  return states.filter(
    (x) => x.subjectKey === s || x.label.toLowerCase().includes(s) || (SUBJECT_SYNONYMS[x.subjectKey]?.test(subject) ?? false),
  );
}

async function projectOrThrow(ctx: ServiceContext, ref: string) {
  const p = await resolveProject(ctx.pool, ref);
  if (!p) {
    const names = await ctx.pool.query<{ name: string }>("SELECT name FROM projects ORDER BY name");
    throw new NotFoundError(`Unknown project "${ref}". Known projects: ${names.rows.map((r) => r.name).join(", ") || "(none)"}`);
  }
  return p;
}
async function optionalProject(ctx: ServiceContext, ref?: string) {
  return ref ? (await projectOrThrow(ctx, ref)).id : undefined;
}

export function createMcpDeps(ctx: ServiceContext): ContextosMcpDeps {
  const { pool } = ctx;
  return {
    getStatus: () => getSystemStatus(pool),

    async getCurrentState({ project, subject }) {
      const p = await projectOrThrow(ctx, project);
      const state = await getCurrentState(pool, p.id);
      const subjects = matchSubject(state.subjects, subject);
      return {
        project: p.name,
        source: "ContextOS deterministic decision lifecycle (authoritative; not similarity search)",
        subjects: subjects.map((s) => ({
          area: s.label,
          status: s.status,
          current: s.current.map(option),
          decided_not_implemented: s.pending.map(option),
          open_proposals: s.proposed.map((o) => o.decision.option),
          historical: s.previous.map((o) => ({ option: o.decision.option, status: `${o.decision.commitmentStatus}/${o.decision.implementationStatus}`, superseded_by: o.decision.supersededBy?.option ?? null, closed: day(o.decision.closedAt ?? o.decision.retiredAt) })),
          rejected: s.rejected.map((o) => ({ option: o.decision.option, reason: o.decision.reason })),
          cancelled: s.cancelled.map((o) => o.decision.option),
          open_conflicts: s.openConflicts.map((c) => ({ issue: c.title, held_claim: ev(c.evidence), note: "Held for human review; NOT applied to current state." })),
          last_updated: day(s.lastUpdated),
        })),
      };
    },

    async getDecisionHistory({ project, subject, option: opt }) {
      const p = await projectOrThrow(ctx, project);
      const events = await getTimeline(pool, { projectId: p.id });
      const filtered = events.filter((e) => {
        if (!e.decisionId) return !subject && !opt;
        if (opt && e.option?.toLowerCase() !== opt.toLowerCase()) return false;
        if (subject && !(e.subjectKey === subject.toLowerCase() || e.subjectLabel?.toLowerCase().includes(subject.toLowerCase()) || (SUBJECT_SYNONYMS[e.subjectKey ?? ""]?.test(subject) ?? false))) return false;
        return true;
      });
      return {
        project: p.name,
        events: filtered.map((e) => ({
          date: day(e.occurredAt),
          area: e.subjectLabel,
          option: e.option ?? e.commitmentTitle,
          event: e.type,
          applied: e.applied,
          note: e.note,
          evidence: ev(e.evidence),
        })),
      };
    },

    async getDecisionEvidence({ project, option: opt, decision_id }) {
      let decisionId = decision_id;
      if (!decisionId) {
        const p = await projectOrThrow(ctx, project!);
        const d = (await listDecisions(pool, { projectId: p.id })).filter((x) => x.option.toLowerCase() === opt!.toLowerCase());
        if (d.length === 0) throw new NotFoundError(`No decision for "${opt}" in ${p.name}`);
        decisionId = d[0]!.id;
      }
      const decision = (await listDecisions(pool)).find((d) => d.id === decisionId);
      if (!decision) throw new NotFoundError("Decision not found");
      return {
        project: decision.projectName,
        option: decision.option,
        area: decision.subjectLabel,
        commitment: decision.commitmentStatus,
        implementation: decision.implementationStatus,
        reason: decision.reason,
        evidence: (await getDecisionEvidence(pool, decisionId)).map((e) => ({ ...ev(e), kind: e.kind, verified_excerpt: e.excerptVerified })),
      };
    },

    async getPendingCommitments({ project }) {
      const list = await listCommitments(pool, await optionalProject(ctx, project), "OPEN");
      return {
        commitments: list.map((c) => ({ project: c.projectName, title: c.title, owner: c.owner, due: day(c.dueAt), overdue: c.overdue, evidence: ev(c.evidence[0] ?? null) })),
      };
    },

    async getUnverifiedClaims({ project }) {
      const projectId = await optionalProject(ctx, project);
      const list = await listDecisions(pool, { projectId, implementation: "CLAIMED_IMPLEMENTED" });
      const events = await getTimeline(pool, { projectId, types: ["IMPLEMENTATION_CLAIMED"] });
      return {
        note: "Claimed implemented but never verified. Treat as unconfirmed.",
        claims: list.map((d) => ({
          project: d.projectName, area: d.subjectLabel, option: d.option, claimed: day(d.implementedAt),
          evidence: ev(events.filter((e) => e.decisionId === d.id).at(-1)?.evidence ?? null),
        })),
      };
    },

    async searchMemory({ query, project, limit }) {
      const projectId = await optionalProject(ctx, project);
      const r = await searchMemories(pool, ctx.gemini, query, { projectId, limit });
      return {
        modes: r.modes,
        hits: r.hits.map((h) => ({ project: h.projectName, kind: h.evidence.kind, summary: h.evidence.summary, ...ev(h.evidence), score: h.score })),
      };
    },

    async getProjectSummary({ project }) {
      const p = await projectOrThrow(ctx, project);
      const state = await getCurrentState(pool, p.id);
      return {
        project: p.name,
        description: state.project.description,
        demo_data: state.project.isDemo || undefined,
        counts: state.project.counts,
        areas: state.subjects.map((s) => ({
          area: s.label,
          status: s.status,
          current: s.current.map((o) => `${o.decision.option} (${o.decision.implementationStatus})`),
          pending: s.pending.map((o) => o.decision.option),
          open_conflicts: s.openConflicts.length,
        })),
        open_commitments: state.commitments.filter((c) => c.status === "OPEN").map((c) => ({ title: c.title, due: day(c.dueAt), overdue: c.overdue })),
      };
    },
  };
}
