/**
 * Memory intelligence query engine.
 *
 *   question → deterministic interpretation (project, subjects, intents, dates)
 *            → authoritative structured state from the projection tables
 *            → evidence-numbered answer packet (E1..En, each a stored excerpt)
 *            → optional Gemini narrative, restricted to that packet; citations validated.
 *
 * The direct answer is composed deterministically from stored state, so it is
 * identical with or without Gemini and cannot contain invented facts.
 */
import type pg from "pg";
import type { GeminiClient } from "../ai/gemini.js";
import { SUBJECT_LABELS, SUBJECT_SYNONYMS, catalogByName, findTechMentions } from "../extraction/catalog.js";
import {
  getCurrentState, getTimeline, listDecisions, listProjects, listReviews, searchMemories,
  type CommitmentView, type DecisionView, type EvidenceRef, type LifecycleEventView, type ReviewSummary,
  type SearchHit, type SubjectState,
} from "./read.js";

export type Intent =
  | "current" | "why" | "history" | "original" | "changes" | "not_implemented" | "unverified" | "rejected"
  | "cancelled" | "commitments" | "conflicts" | "evidence" | "search";

const INTENT_RULES: [Intent, RegExp][] = [
  ["why", /\bwhy\b|\breason|\bmotivat|\bjustif/i],
  ["original", /\boriginal(ly)?\b|\binitial(ly)?\b|\bfirst\b|\bat the start\b|\bbefore\b/i],
  ["changes", /\bchang(e|ed|es)\b|\bbetween\b|\bevolv|\bsince\b/i],
  ["history", /\bhistory\b|\btimeline\b|\bhow did\b|\bover time\b/i],
  ["not_implemented", /\bnot (been |yet )?implemented\b|\bpending\b|\bnot started\b|\bhaven'?t (been )?(implemented|built)\b|\bawaiting implementation\b/i],
  ["unverified", /\bunverified\b|\bnot (been |yet )?verified\b|\bwithout verification\b|\bclaims?\b/i],
  ["rejected", /\breject/i],
  ["cancelled", /\bcancel/i],
  ["commitments", /\bcommitment|\boverdue\b|\bunresolved\b|\baction items?\b|\btodo\b|\btasks?\b|\bdeadline/i],
  ["conflicts", /\bcontradict|\bconflict|\binconsisten|\bdisputed?\b/i],
  ["evidence", /\bevidence\b|\bproof\b|\bsources?\b|\bsupports?\b|\bbacks? up\b/i],
  ["current", /\bcurrent(ly)?\b|\bnow\b|\btoday\b|\bstill\b|\b(do|does|are|is) .*\b(use|using|run|running|on)\b|\bin production\b/i],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export interface Interpretation {
  projectId: string | null;
  projectName: string | null;
  intents: Intent[];
  subjects: string[];
  options: string[];
  dateRange: { from: string; to: string } | null;
  method: "rules";
}

export interface AnswerSection {
  title: string;
  items: { label: string; status?: string; detail?: string; date?: string | null; decisionId?: string | null; evidenceIds: string[] }[];
}

export interface QueryAnswer {
  question: string;
  interpretation: Interpretation;
  directAnswer: string;
  confidence: "high" | "medium" | "low";
  currentState: SubjectState[];
  reasoning: { option: string; subject: string; reason: string; decidedAt: string | null; evidenceIds: string[] }[];
  history: { date: string; subject: string | null; option: string | null; type: string; applied: boolean; note: string | null; evidenceIds: string[] }[];
  sections: AnswerSection[];
  reviewNotes: string[];
  evidence: (EvidenceRef & { ref: string })[];
  related: SearchHit[];
  narrative: { text: string; citations: string[]; model: string } | null;
  generatedBy: string;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "unknown date";

const STATUS_WORD: Record<string, string> = {
  PROPOSED: "proposed", DECIDED: "decided", REJECTED: "rejected", CANCELLED: "cancelled", REVERSED: "reversed",
  SUPERSEDED: "superseded", IMPLEMENTATION_CLAIMED: "claimed implemented (unverified)", VERIFIED: "verified",
  RETIRED: "retired", CONFLICT_FLAGGED: "conflicting claim flagged (held for review)", HELD_FOR_REVIEW: "held for review",
  COMMITMENT_OPENED: "commitment opened", COMMITMENT_DONE: "commitment completed", COMMITMENT_CANCELLED: "commitment cancelled",
};

export async function interpret(pool: pg.Pool, question: string, projectId?: string): Promise<Interpretation> {
  const projects = await listProjects(pool);
  let project = projectId ? projects.find((p) => p.id === projectId) : undefined;
  project ??= projects.find((p) => new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question));
  if (!project && projects.length === 1) project = projects[0];
  if (!project) project = projects.find((p) => p.isDemo) ?? undefined;

  const intents = INTENT_RULES.filter(([, rx]) => rx.test(question)).map(([i]) => i);
  const options = findTechMentions(question).filter((t) => t.entry.subject).map((t) => t.entry.name);
  const subjects = new Set<string>();
  for (const [key, rx] of Object.entries(SUBJECT_SYNONYMS)) if (rx.test(question)) subjects.add(key);
  for (const o of options) {
    const s = catalogByName(o)?.subject;
    if (s) subjects.add(s);
  }

  // "between January and May" / "since March"
  let dateRange: Interpretation["dateRange"] = null;
  const monthHits = [...question.toLowerCase().matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)].map((m) => MONTHS.indexOf(m[1]!));
  if (monthHits.length > 0 && (intents.includes("changes") || intents.includes("history") || monthHits.length >= 2)) {
    const year = new Date().getUTCFullYear();
    const from = Math.min(...monthHits);
    const to = monthHits.length > 1 ? Math.max(...monthHits) : 11;
    dateRange = { from: new Date(Date.UTC(year, from, 1)).toISOString(), to: new Date(Date.UTC(year, to + 1, 0, 23, 59, 59)).toISOString() };
    if (!intents.includes("changes")) intents.push("changes");
  }
  if (intents.length === 0) intents.push(subjects.size > 0 ? "current" : "search");
  if (intents.includes("why") && !intents.includes("current") && subjects.size > 0) intents.push("current");

  return {
    projectId: project?.id ?? null, projectName: project?.name ?? null, intents, subjects: [...subjects], options, dateRange, method: "rules",
  };
}

export async function answerQuestion(
  pool: pg.Pool,
  gemini: GeminiClient | null,
  question: string,
  projectId?: string,
): Promise<QueryAnswer> {
  const it = await interpret(pool, question, projectId);
  const evidence: (EvidenceRef & { ref: string })[] = [];
  const cite = (e: EvidenceRef | null | undefined): string[] => {
    if (!e) return [];
    const existing = evidence.find((x) => x.memoryId === e.memoryId);
    if (existing) return [existing.ref];
    const ref = `E${evidence.length + 1}`;
    evidence.push({ ...e, ref });
    return [ref];
  };

  const answer: QueryAnswer = {
    question, interpretation: it, directAnswer: "", confidence: "medium", currentState: [], reasoning: [], history: [],
    sections: [], reviewNotes: [], evidence, related: [], narrative: null, generatedBy: "deterministic (structured state)",
  };

  if (!it.projectId) {
    answer.directAnswer = "No project matches this question yet. Create a project or import the StudyMate demo dataset first.";
    answer.confidence = "low";
    return answer;
  }

  const state = await getCurrentState(pool, it.projectId);
  const projectName = state.project.name;
  const relevant = it.subjects.length ? state.subjects.filter((s) => it.subjects.includes(s.subjectKey)) : state.subjects;
  const lines: string[] = [];

  // Current state + why
  if (it.intents.includes("current") || it.intents.includes("why") || it.intents.includes("evidence")) {
    answer.currentState = relevant;
    for (const s of relevant) {
      const cur = s.current;
      if (cur.length) {
        for (const c of cur) {
          const d = c.decision;
          const verified = d.implementationStatus === "VERIFIED";
          const ev = cite(verified ? c.evidence.verified : c.evidence.implemented);
          lines.push(
            `${projectName} currently uses ${d.option} as its ${s.label.toLowerCase()} — ` +
              (verified
                ? `VERIFIED on ${fmt(d.verifiedAt)} ${ev.map((x) => `[${x}]`).join("")}.`
                : `claimed implemented on ${fmt(d.implementedAt)} but NOT yet verified ${ev.map((x) => `[${x}]`).join("")}.`),
          );
          if (d.reason) {
            const dEv = cite(c.evidence.decided);
            const replaced = s.previous.find((p) => p.decision.supersededBy?.id === d.id);
            lines.push(
              `Reason: on ${fmt(d.decidedAt)} the team decided ${replaced ? `to migrate from ${replaced.decision.option} to ${d.option}` : `on ${d.option}`} — stated reason: "${d.reason}" ${dEv.map((x) => `[${x}]`).join("")}.`,
            );
            answer.reasoning.push({ option: d.option, subject: s.label, reason: d.reason, decidedAt: d.decidedAt, evidenceIds: dEv });
          } else if (it.intents.includes("why")) {
            lines.push(`No reason for choosing ${d.option} was stated in the recorded conversations.`);
          }
        }
      } else if (s.pending.length) {
        for (const p of s.pending) {
          const ev = cite(p.evidence.decided);
          lines.push(`${p.decision.option} was decided for ${s.label.toLowerCase()} on ${fmt(p.decision.decidedAt)} but has not been implemented yet ${ev.map((x) => `[${x}]`).join("")}.`);
          if (p.decision.reason) answer.reasoning.push({ option: p.decision.option, subject: s.label, reason: p.decision.reason, decidedAt: p.decision.decidedAt, evidenceIds: ev });
        }
      } else if (s.proposed.length) {
        lines.push(`No decision has been made for ${s.label.toLowerCase()}; open proposals: ${s.proposed.map((p) => p.decision.option).join(", ")}.`);
      } else if (s.rejected.length && it.subjects.length) {
        lines.push(`${s.rejected.map((r) => r.decision.option).join(", ")} was rejected for ${s.label.toLowerCase()}; nothing else is recorded.`);
      }
      if (s.previous.length && it.subjects.length) {
        lines.push(
          `Historical: ${s.previous
            .map((p) => `${p.decision.option} (${p.decision.implementationStatus === "RETIRED" ? `retired ${fmt(p.decision.retiredAt)}` : `${p.decision.commitmentStatus.toLowerCase()} ${fmt(p.decision.closedAt)}`})`)
            .join(", ")}.`,
        );
      }
      for (const conflict of s.openConflicts) {
        const ev = cite(conflict.evidence);
        answer.reviewNotes.push(`${conflict.title} — "${conflict.evidence.excerpt}" (${fmt(conflict.evidence.occurredAt)}) ${ev.map((x) => `[${x}]`).join("")} is held for human review and does not change the current state.`);
      }
    }
  }

  // History for the relevant subjects (or the date range)
  const wantsHistory = it.intents.some((i) => ["history", "original", "changes", "why", "current", "evidence"].includes(i));
  if (wantsHistory) {
    const decisionIds = new Set(relevant.flatMap((s) => [...s.current, ...s.pending, ...s.proposed, ...s.previous, ...s.rejected, ...s.cancelled].map((o) => o.decision.id)));
    const events = await getTimeline(pool, {
      projectId: it.projectId,
      from: it.dateRange ? new Date(it.dateRange.from) : undefined,
      to: it.dateRange ? new Date(it.dateRange.to) : undefined,
    });
    const scoped = events.filter((e) =>
      it.dateRange && !it.subjects.length ? true : e.decisionId !== null && decisionIds.has(e.decisionId),
    );
    answer.history = scoped.map((e: LifecycleEventView) => ({
      date: e.occurredAt, subject: e.subjectLabel, option: e.option ?? e.commitmentTitle, type: e.type, applied: e.applied,
      note: e.note, evidenceIds: cite(e.evidence),
    }));
    if (it.intents.includes("original")) {
      const first = scoped.find((e) => e.decisionId);
      if (first) lines.unshift(`Originally (${fmt(first.occurredAt)}), ${first.option} was ${STATUS_WORD[first.type] ?? first.type.toLowerCase()} for ${first.subjectLabel?.toLowerCase()} [${cite(first.evidence)[0]}].`);
    }
    if (it.intents.includes("changes") && it.dateRange) {
      const applied = scoped.filter((e) => e.applied);
      lines.push(
        applied.length
          ? `${applied.length} lifecycle changes between ${fmt(it.dateRange.from)} and ${fmt(it.dateRange.to)}: ` +
              applied.slice(0, 8).map((e) => `${fmt(e.occurredAt)} ${e.option ?? e.commitmentTitle} ${STATUS_WORD[e.type] ?? e.type.toLowerCase()}`).join("; ") + (applied.length > 8 ? "; …" : "") + "."
          : `No recorded changes between ${fmt(it.dateRange.from)} and ${fmt(it.dateRange.to)}.`,
      );
    }
  }

  const decisions = await listDecisions(pool, { projectId: it.projectId });
  const listSection = async (title: string, ds: DecisionView[], statusOf: (d: DecisionView) => string, evOf: (d: DecisionView) => Promise<EvidenceRef | null>) => {
    const items: AnswerSection["items"] = [];
    for (const d of ds) {
      const ev = cite(await evOf(d));
      items.push({ label: `${d.option} (${d.subjectLabel})`, status: statusOf(d), date: d.decidedAt ?? d.firstSeenAt, decisionId: d.id, evidenceIds: ev, ...(d.reason ? { detail: d.reason } : {}) });
    }
    answer.sections.push({ title, items });
  };

  const lastEvidence = async (d: DecisionView, type: string) => {
    const ev = await getTimeline(pool, { projectId: it.projectId!, types: [type] });
    return ev.filter((e) => e.decisionId === d.id).at(-1)?.evidence ?? null;
  };

  if (it.intents.includes("not_implemented")) {
    const pending = decisions.filter((d) => d.commitmentStatus === "DECIDED" && d.implementationStatus === "NOT_STARTED");
    await listSection("Decided but not implemented", pending, () => "DECIDED · NOT_STARTED", (d) => lastEvidence(d, "DECIDED"));
    lines.push(pending.length ? `${pending.length} decision(s) are not implemented yet: ${pending.map((d) => d.option).join(", ")}.` : "Every decided option has at least an implementation claim.");
  }
  if (it.intents.includes("unverified")) {
    const claims = decisions.filter((d) => d.implementationStatus === "CLAIMED_IMPLEMENTED");
    await listSection("Unverified implementation claims", claims, () => "CLAIMED_IMPLEMENTED", (d) => lastEvidence(d, "IMPLEMENTATION_CLAIMED"));
    lines.push(claims.length ? `${claims.length} implementation claim(s) have no verification evidence: ${claims.map((d) => `${d.option} (claimed ${fmt(d.implementedAt)})`).join(", ")}.` : "All implementation claims are verified.");
  }
  if (it.intents.includes("rejected")) {
    const rej = decisions.filter((d) => d.commitmentStatus === "REJECTED");
    await listSection("Rejected options", rej, () => "REJECTED", (d) => lastEvidence(d, "REJECTED"));
    lines.push(rej.length ? `Rejected: ${rej.map((d) => `${d.option}${d.reason ? ` (because ${d.reason})` : ""}`).join("; ")}.` : "No options were rejected.");
  }
  if (it.intents.includes("cancelled")) {
    const can = decisions.filter((d) => d.commitmentStatus === "CANCELLED");
    const cms = state.commitments.filter((c) => c.status === "CANCELLED");
    await listSection("Cancelled decisions", can, () => "CANCELLED", (d) => lastEvidence(d, "CANCELLED"));
    answer.sections.push({ title: "Cancelled commitments", items: cms.map((c) => ({ label: c.title, status: "CANCELLED", date: c.closedAt, evidenceIds: c.evidence.flatMap((e) => cite(e)) })) });
    lines.push(`${can.length} cancelled decision(s) and ${cms.length} cancelled commitment(s)${cms.length ? `: ${cms.map((c) => c.title).join(", ")}` : ""}.`);
  }
  if (it.intents.includes("commitments")) {
    const open = state.commitments.filter((c: CommitmentView) => c.status === "OPEN");
    const overdue = open.filter((c) => c.overdue);
    answer.sections.push({
      title: "Open commitments",
      items: open.map((c) => ({ label: c.title, status: c.overdue ? "OVERDUE" : "OPEN", detail: `${c.owner ? `Owner: ${c.owner}. ` : ""}${c.dueAt ? `Due ${fmt(c.dueAt)}.` : "No due date."}`, date: c.dueAt, evidenceIds: c.evidence.flatMap((e) => cite(e)) })),
    });
    lines.push(open.length ? `${open.length} unresolved commitment(s), ${overdue.length} overdue: ${open.map((c) => `${c.title}${c.overdue ? ` (overdue since ${fmt(c.dueAt)})` : ""}`).join("; ")}.` : "There are no unresolved commitments.");
  }
  if (it.intents.includes("conflicts")) {
    const reviews: ReviewSummary[] = await listReviews(pool, { projectId: it.projectId, status: "open" });
    const conflicts = reviews.filter((r) => r.kind === "conflict" || r.kind === "reopened");
    answer.sections.push({ title: "Contradictions awaiting review", items: conflicts.map((r) => ({ label: r.title, status: "OPEN", detail: r.detail, date: r.evidence.occurredAt, decisionId: r.decisionId, evidenceIds: cite(r.evidence) })) });
    lines.push(conflicts.length ? `${conflicts.length} contradictory statement(s) are flagged and held for review; they have not changed the recorded state.` : "No contradictions are currently flagged.");
  }

  // Related memories (search) — always, to surface supporting text.
  const search = await searchMemories(pool, gemini, question, { projectId: it.projectId, limit: 6 });
  answer.related = search.hits;
  if (lines.length === 0) {
    if (search.hits.length) {
      lines.push(`No structured state matches this question directly. Most relevant memories: ${search.hits.slice(0, 3).map((h) => `"${h.evidence.summary}" [${cite(h.evidence)[0]}]`).join("; ")}.`);
      answer.confidence = "low";
    } else {
      lines.push("Nothing in the recorded conversations answers this question.");
      answer.confidence = "low";
    }
  } else {
    const disputed = relevant.some((s) => s.status === "DISPUTED");
    const unverified = relevant.some((s) => s.status === "UNVERIFIED");
    answer.confidence = disputed || unverified ? "medium" : "high";
  }
  answer.directAnswer = lines.join(" ");

  // Optional Gemini narrative over the packet (never adds facts; citations validated).
  if (gemini && evidence.length) {
    try {
      const facts = [
        answer.directAnswer,
        ...answer.reviewNotes,
        ...evidence.map((e) => `[${e.ref}] ${fmt(e.occurredAt)} "${e.excerpt}" (${e.conversationTitle})`),
      ].join("\n");
      const n = await gemini.narrate(question, facts, evidence.map((e) => e.ref));
      if (n) {
        answer.narrative = { ...n, model: gemini.model };
        answer.generatedBy = "deterministic (structured state) + Gemini narrative";
      }
    } catch {
      // The deterministic answer stands on its own.
    }
  }
  return answer;
}

export { SUBJECT_LABELS };
