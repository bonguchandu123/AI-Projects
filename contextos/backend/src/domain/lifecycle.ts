/**
 * Deterministic decision lifecycle engine (pure: no I/O, no AI).
 *
 * Input: memories (extracted observations) in event-time order.
 * Output: the projected state of every decision option and commitment, the
 * lifecycle events that produced it, and review items for anything the engine
 * refused to apply automatically.
 *
 * Two independent axes per option:
 *   commitment:      NONE → PROPOSED → DECIDED → REJECTED / CANCELLED / REVERSED / SUPERSEDED
 *   implementation:  NOT_STARTED → CLAIMED_IMPLEMENTED → VERIFIED → RETIRED
 *
 * Core rules (each one is tested):
 *  1. A proposal never becomes a decision on its own.
 *  2. A decision never implies implementation.
 *  3. An implementation claim is not verification.
 *  4. An unverified claim never overrides a verified state → conflict, held for review.
 *  5. A new decision in an exclusive subject supersedes competing earlier options.
 *  6. Nothing is deleted: rejected/cancelled/superseded options keep their history.
 *  7. Low-confidence, hedged, or unverifiable-excerpt observations are held for review.
 *  8. Every event references the memory (evidence) that caused it.
 */
import type { CommitmentStatus, ImplementationStatus, MemoryKind } from "./types.js";

export interface Observation {
  memoryId: string;
  kind: MemoryKind;
  occurredAt: Date;
  summary: string;
  subjectKey: string | null;
  subjectLabel: string | null;
  option: string | null;
  previousOption: string | null;
  replacesPrevious: boolean;
  reason: string | null;
  commitmentTitle: string | null;
  commitmentOwner: string | null;
  commitmentDueAt: Date | null;
  speakerRole: string;
  hedged: boolean;
  confidence: number;
  excerptVerified: boolean;
}

export type ReviewKind = "conflict" | "ambiguous" | "missing_decision" | "unverified_excerpt" | "reopened";
export type Resolution = "confirmed" | "dismissed";

export interface DecisionState {
  key: string; // `${subjectKey}::${optionKey}`
  subjectKey: string;
  subjectLabel: string;
  optionKey: string;
  optionName: string;
  commitment: CommitmentStatus;
  implementation: ImplementationStatus;
  reason: string | null;
  disputed: boolean;
  supersededByKey: string | null;
  firstSeenAt: Date;
  proposedAt: Date | null;
  decidedAt: Date | null;
  implementedAt: Date | null;
  verifiedAt: Date | null;
  closedAt: Date | null;
  retiredAt: Date | null;
}

export interface CommitmentState {
  key: string;
  title: string;
  owner: string | null;
  dueAt: Date | null;
  status: "OPEN" | "DONE" | "CANCELLED";
  openedAt: Date;
  closedAt: Date | null;
}

export type EventType =
  | "PROPOSED" | "DECIDED" | "REJECTED" | "CANCELLED" | "REVERSED" | "SUPERSEDED"
  | "IMPLEMENTATION_CLAIMED" | "VERIFIED" | "RETIRED"
  | "CORROBORATED" | "CONFLICT_FLAGGED" | "HELD_FOR_REVIEW"
  | "COMMITMENT_OPENED" | "COMMITMENT_DONE" | "COMMITMENT_CANCELLED";

export interface EngineEvent {
  seq: number;
  decisionKey: string | null;
  commitmentKey: string | null;
  type: EventType;
  applied: boolean;
  fromCommitment: CommitmentStatus | null;
  toCommitment: CommitmentStatus | null;
  fromImplementation: ImplementationStatus | null;
  toImplementation: ImplementationStatus | null;
  memoryId: string;
  occurredAt: Date;
  actor: "extraction" | "engine" | "reviewer";
  note: string | null;
}

export interface EngineReview {
  memoryId: string;
  kind: ReviewKind;
  decisionKey: string | null;
  commitmentKey: string | null;
  blocking: boolean;
  title: string;
  detail: string;
  proposed: Record<string, unknown> | null;
}

export interface EngineResult {
  decisions: Map<string, DecisionState>;
  commitments: Map<string, CommitmentState>;
  events: EngineEvent[];
  reviews: EngineReview[];
  /** memoryId → decision/commitment key it was attached to */
  memoryLinks: Map<string, { decisionKey: string | null; commitmentKey: string | null }>;
}

export interface EngineOptions {
  cardinality: (subjectKey: string) => "exclusive" | "multi";
  /** Prior reviewer decisions, keyed `${memoryId}:${kind}`. */
  resolutions: ReadonlyMap<string, Resolution>;
  minConfidence?: number;
}

export const DEFAULT_MIN_CONFIDENCE = 0.6;

export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const IMPLEMENTED: ReadonlySet<ImplementationStatus> = new Set(["CLAIMED_IMPLEMENTED", "VERIFIED"]);
const CLOSED: ReadonlySet<CommitmentStatus> = new Set(["REJECTED", "CANCELLED", "REVERSED", "SUPERSEDED"]);

function tokens(s: string): Set<string> {
  return new Set(normalizeKey(s).split(" ").filter((t) => t.length > 2));
}
function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function runLifecycle(observations: readonly Observation[], opts: EngineOptions): EngineResult {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const decisions = new Map<string, DecisionState>();
  const commitments = new Map<string, CommitmentState>();
  const events: EngineEvent[] = [];
  const reviews: EngineReview[] = [];
  const memoryLinks = new Map<string, { decisionKey: string | null; commitmentKey: string | null }>();
  let seq = 0;

  const ordered = [...observations].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (const raw of ordered) {
    if (raw.kind === "fact") continue;
    // Normalise: a decision-level cancellation/completion that names a commitment and
    // no option is really about the commitment (extractors sometimes mix the two).
    const obs: Observation =
      !raw.option && raw.commitmentTitle && (raw.kind === "cancellation" || raw.kind === "implementation_claim" || raw.kind === "verification")
        ? { ...raw, kind: raw.kind === "cancellation" ? "commitment_cancelled" : "commitment_done" }
        : raw;
    if (obs.kind === "commitment" || obs.kind === "commitment_done" || obs.kind === "commitment_cancelled") {
      handleCommitment(obs);
      continue;
    }
    if (!obs.subjectKey || !obs.option) continue; // not actionable; memory stays searchable
    handleDecision(obs);
  }

  return { decisions, commitments, events, reviews, memoryLinks };

  // ── helpers ──────────────────────────────────────────────────────────────

  function resolution(memoryId: string, kind: ReviewKind): Resolution | undefined {
    return opts.resolutions.get(`${memoryId}:${kind}`);
  }

  function emit(e: Omit<EngineEvent, "seq">): void {
    events.push({ ...e, seq: seq++ });
  }

  function getDecision(subjectKey: string, subjectLabel: string | null, optionName: string, at: Date): DecisionState {
    const optionKey = normalizeKey(optionName);
    const key = `${subjectKey}::${optionKey}`;
    let d = decisions.get(key);
    if (!d) {
      d = {
        key, subjectKey, subjectLabel: subjectLabel ?? subjectKey.replace(/_/g, " "), optionKey, optionName,
        commitment: "NONE", implementation: "NOT_STARTED", reason: null, disputed: false, supersededByKey: null,
        firstSeenAt: at, proposedAt: null, decidedAt: null, implementedAt: null, verifiedAt: null,
        closedAt: null, retiredAt: null,
      };
      decisions.set(key, d);
    } else if (subjectLabel && d.subjectLabel === subjectKey.replace(/_/g, " ")) {
      d.subjectLabel = subjectLabel;
    }
    return d;
  }

  function siblings(d: DecisionState): DecisionState[] {
    return [...decisions.values()].filter((o) => o.subjectKey === d.subjectKey && o.key !== d.key);
  }

  /**
   * Gate a transition through review. Returns true if it may be applied.
   * A confirmed resolution forces it through; a dismissed one blocks it.
   */
  function gate(obs: Observation, d: DecisionState | null, kind: ReviewKind, title: string, detail: string,
    proposed: Record<string, unknown>): boolean {
    const res = resolution(obs.memoryId, kind);
    reviews.push({
      memoryId: obs.memoryId, kind, decisionKey: d?.key ?? null, commitmentKey: null, blocking: true,
      title, detail, proposed,
    });
    if (res === "confirmed") return true;
    emit({
      decisionKey: d?.key ?? null, commitmentKey: null,
      type: kind === "conflict" ? "CONFLICT_FLAGGED" : "HELD_FOR_REVIEW", applied: false,
      fromCommitment: d?.commitment ?? null, toCommitment: null,
      fromImplementation: d?.implementation ?? null, toImplementation: null,
      memoryId: obs.memoryId, occurredAt: obs.occurredAt, actor: "engine",
      note: res === "dismissed" ? `${title} (dismissed by reviewer)` : title,
    });
    if (kind === "conflict" && d && res !== "dismissed") {
      d.disputed = true;
      for (const s of siblings(d)) if (IMPLEMENTED.has(s.implementation)) s.disputed = true;
    }
    return false;
  }

  function setCommitment(d: DecisionState, to: CommitmentStatus, obs: Observation, type: EventType,
    actor: EngineEvent["actor"], note: string | null): void {
    const from = d.commitment;
    d.commitment = to;
    if (to === "PROPOSED") d.proposedAt ??= obs.occurredAt;
    if (to === "DECIDED") d.decidedAt = obs.occurredAt;
    if (CLOSED.has(to)) d.closedAt = obs.occurredAt;
    else d.closedAt = null;
    emit({
      decisionKey: d.key, commitmentKey: null, type, applied: true, fromCommitment: from, toCommitment: to,
      fromImplementation: null, toImplementation: null, memoryId: obs.memoryId, occurredAt: obs.occurredAt,
      actor, note,
    });
  }

  function setImplementation(d: DecisionState, to: ImplementationStatus, obs: Observation, type: EventType,
    actor: EngineEvent["actor"], note: string | null): void {
    const from = d.implementation;
    d.implementation = to;
    if (to === "CLAIMED_IMPLEMENTED") d.implementedAt ??= obs.occurredAt;
    if (to === "VERIFIED") {
      d.implementedAt ??= obs.occurredAt;
      d.verifiedAt = obs.occurredAt;
    }
    if (to === "RETIRED") d.retiredAt = obs.occurredAt;
    emit({
      decisionKey: d.key, commitmentKey: null, type, applied: true, fromCommitment: null, toCommitment: null,
      fromImplementation: from, toImplementation: to, memoryId: obs.memoryId, occurredAt: obs.occurredAt,
      actor, note,
    });
  }

  function corroborate(d: DecisionState, obs: Observation, note: string): void {
    emit({
      decisionKey: d.key, commitmentKey: null, type: "CORROBORATED", applied: true,
      fromCommitment: d.commitment, toCommitment: d.commitment,
      fromImplementation: d.implementation, toImplementation: d.implementation,
      memoryId: obs.memoryId, occurredAt: obs.occurredAt, actor: "extraction", note,
    });
  }

  /** After `winner` is decided in an exclusive subject, competing open options are superseded. */
  function supersedeCompetitors(winner: DecisionState, obs: Observation): void {
    if (opts.cardinality(winner.subjectKey) !== "exclusive") {
      // In multi-valued subjects only an explicitly named previous option is replaced.
      if (!obs.replacesPrevious || !obs.previousOption) return;
    }
    const prevKey = obs.previousOption ? normalizeKey(obs.previousOption) : null;
    for (const s of siblings(winner)) {
      const named = prevKey !== null && s.optionKey === prevKey;
      const isExclusive = opts.cardinality(winner.subjectKey) === "exclusive";
      if (!named && !isExclusive) continue;
      if (s.commitment === "PROPOSED" || s.commitment === "DECIDED" || (s.commitment === "NONE" && IMPLEMENTED.has(s.implementation))) {
        s.supersededByKey = winner.key;
        setCommitment(s, "SUPERSEDED", obs, "SUPERSEDED", "engine", `Superseded by decision for ${winner.optionName}`);
      }
    }
  }

  /**
   * When `d` becomes implemented in an exclusive subject, other implemented options
   * are retired — but only if they were already superseded/reversed/cancelled (a planned
   * replacement), or `d` is verified and they are merely claimed. Otherwise it is a conflict.
   * Returns false if the transition must be held.
   */
  function resolveImplementedSiblings(d: DecisionState, obs: Observation, verifying: boolean): boolean {
    if (opts.cardinality(d.subjectKey) !== "exclusive") return true;
    const live = siblings(d).filter((s) => IMPLEMENTED.has(s.implementation));
    const blockers = live.filter((s) => {
      const replaced = s.commitment === "SUPERSEDED" || s.commitment === "REVERSED" || s.commitment === "CANCELLED";
      if (replaced) return false;
      if (verifying && s.implementation === "CLAIMED_IMPLEMENTED") return false;
      return true;
    });
    if (blockers.length > 0) {
      const b = blockers[0]!;
      const allowed = gate(
        obs, d, "conflict",
        `Conflicting ${d.subjectLabel}: ${d.optionName} vs ${b.optionName}`,
        `"${obs.summary}" contradicts the recorded state: ${b.optionName} is ${b.implementation === "VERIFIED" ? "VERIFIED" : "claimed implemented"} ` +
          `and was never superseded. ${obs.kind === "verification" ? "" : "An unverified claim cannot override it. "}` +
          `Confirm to accept ${d.optionName} as the current ${d.subjectLabel}; dismiss to keep ${b.optionName}.`,
        { option: d.optionName, kind: obs.kind, conflictsWith: b.optionName, currentStatus: b.implementation },
      );
      if (!allowed) return false;
    }
    for (const s of live) {
      if (s.commitment === "DECIDED" || s.commitment === "NONE" || s.commitment === "PROPOSED") {
        s.supersededByKey = d.key;
        setCommitment(s, "SUPERSEDED", obs, "SUPERSEDED", "engine", `Replaced by ${d.optionName}`);
      }
      setImplementation(s, "RETIRED", obs, "RETIRED", "engine", `Retired: ${d.optionName} is now in place`);
      s.disputed = false;
    }
    d.disputed = false;
    return true;
  }

  function handleDecision(obs: Observation): void {
    const d = getDecision(obs.subjectKey!, obs.subjectLabel, obs.option!, obs.occurredAt);
    memoryLinks.set(obs.memoryId, { decisionKey: d.key, commitmentKey: null });
    if (obs.reason && (!d.reason || obs.kind === "decision")) d.reason = obs.reason;

    // Gate 1: evidence must be verifiable in the source.
    if (!obs.excerptVerified) {
      const ok = gate(obs, d, "unverified_excerpt", `Excerpt not found in source: ${obs.option}`,
        `The extractor quoted text that does not appear in the stored conversation, so this ${obs.kind} cannot be trusted automatically.`,
        { option: obs.option, kind: obs.kind });
      if (!ok) return;
    }
    // Gate 2: uncertain statements.
    if (obs.hedged || obs.confidence < minConfidence) {
      const ok = gate(obs, d, "ambiguous", `Uncertain ${obs.kind.replace(/_/g, " ")}: ${obs.option}`,
        `"${obs.summary}" is ${obs.hedged ? "hedged" : "low-confidence"} (confidence ${obs.confidence.toFixed(2)}). Confirm to apply it.`,
        { option: obs.option, kind: obs.kind, confidence: obs.confidence });
      if (!ok) return;
    }

    // Assistant suggestions are proposals at most.
    const kind: MemoryKind = obs.speakerRole === "assistant" && obs.kind === "decision" ? "proposal" : obs.kind;

    switch (kind) {
      case "proposal": {
        if (d.commitment === "NONE") return setCommitment(d, "PROPOSED", obs, "PROPOSED", "extraction", null);
        if (d.commitment === "PROPOSED" || d.commitment === "DECIDED") return corroborate(d, obs, "Mentioned again as a proposal");
        // Re-proposing a closed option is allowed and recorded.
        return setCommitment(d, "PROPOSED", obs, "PROPOSED", "extraction", `Re-proposed after being ${d.commitment.toLowerCase()}`);
      }
      case "decision": {
        if (d.commitment === "DECIDED") return corroborate(d, obs, "Decision restated");
        if (d.commitment === "REJECTED") {
          const ok = gate(obs, d, "reopened", `Previously rejected option decided: ${d.optionName}`,
            `${d.optionName} was rejected earlier; "${obs.summary}" now decides it. Confirm the change of mind.`,
            { option: d.optionName, kind: "decision", previous: "REJECTED" });
          if (!ok) return;
        }
        setCommitment(d, "DECIDED", obs, "DECIDED", "extraction",
          d.commitment === "PROPOSED" ? "Proposal became a decision" : null);
        return supersedeCompetitors(d, obs);
      }
      case "rejection": {
        if (d.commitment === "REJECTED") return corroborate(d, obs, "Rejection restated");
        if (d.commitment === "DECIDED") {
          const ok = gate(obs, d, "conflict", `Decided option now rejected: ${d.optionName}`,
            `${d.optionName} was decided earlier; "${obs.summary}" rejects it. Confirm to record the rejection.`,
            { option: d.optionName, kind: "rejection" });
          if (!ok) return;
        }
        return setCommitment(d, "REJECTED", obs, "REJECTED", "extraction", null);
      }
      case "cancellation": {
        if (d.commitment === "CANCELLED") return corroborate(d, obs, "Cancellation restated");
        if (d.commitment === "NONE" || IMPLEMENTED.has(d.implementation)) {
          const ok = gate(obs, d, "ambiguous", `Unclear cancellation: ${d.optionName}`,
            d.commitment === "NONE"
              ? `"${obs.summary}" cancels something that was never proposed or decided.`
              : `${d.optionName} is already implemented; cancelling it is really a reversal. Confirm to record it as cancelled.`,
            { option: d.optionName, kind: "cancellation" });
          if (!ok) return;
        }
        return setCommitment(d, "CANCELLED", obs, "CANCELLED", "extraction", null);
      }
      case "reversal": {
        if (d.commitment === "REVERSED") return corroborate(d, obs, "Reversal restated");
        return setCommitment(d, "REVERSED", obs, "REVERSED", "extraction", null);
      }
      case "in_use":
      case "implementation_claim": {
        if (d.implementation === "VERIFIED") return corroborate(d, obs, "Implementation mentioned again (already verified)");
        if (d.implementation === "CLAIMED_IMPLEMENTED") return corroborate(d, obs, "Implementation claim restated (still unverified)");
        if (d.implementation === "RETIRED" || CLOSED.has(d.commitment)) {
          const ok = gate(obs, d, "conflict", `${d.optionName} claimed in use after being ${d.implementation === "RETIRED" ? "retired" : d.commitment.toLowerCase()}`,
            `"${obs.summary}" says ${d.optionName} is in place, but the record shows it was ${d.implementation === "RETIRED" ? "retired" : d.commitment.toLowerCase()}. ` +
              `This unverified claim is not applied unless you confirm it.`,
            { option: d.optionName, kind: kind, current: d.implementation });
          if (!ok) return;
        }
        if (!resolveImplementedSiblings(d, obs, false)) return;
        if (d.commitment === "NONE" || d.commitment === "PROPOSED") {
          reviews.push({
            memoryId: obs.memoryId, kind: "missing_decision", decisionKey: d.key, commitmentKey: null, blocking: false,
            title: `Implemented without a recorded decision: ${d.optionName}`,
            detail: `"${obs.summary}" claims ${d.optionName} is in place, but no explicit decision was recorded.`,
            proposed: null,
          });
        }
        return setImplementation(d, "CLAIMED_IMPLEMENTED", obs, "IMPLEMENTATION_CLAIMED", "extraction",
          kind === "in_use" ? "Stated as currently in use (unverified)" : "Claimed implemented (unverified)");
      }
      case "verification": {
        if (d.implementation === "VERIFIED") return corroborate(d, obs, "Verified again");
        if (d.implementation === "RETIRED") {
          const ok = gate(obs, d, "conflict", `Retired option verified: ${d.optionName}`,
            `"${obs.summary}" verifies ${d.optionName}, which the record shows as retired.`,
            { option: d.optionName, kind: "verification" });
          if (!ok) return;
        }
        if (!resolveImplementedSiblings(d, obs, true)) return;
        if (d.commitment === "NONE" || d.commitment === "PROPOSED") {
          reviews.push({
            memoryId: obs.memoryId, kind: "missing_decision", decisionKey: d.key, commitmentKey: null, blocking: false,
            title: `Verified without a recorded decision: ${d.optionName}`,
            detail: `"${obs.summary}" verifies ${d.optionName}, but no explicit decision was recorded.`,
            proposed: null,
          });
        }
        return setImplementation(d, "VERIFIED", obs, "VERIFIED", "extraction",
          d.implementation === "NOT_STARTED" ? "Verified directly (implementation implied by verification)" : null);
      }
      default:
        return;
    }
  }

  function findCommitment(title: string): CommitmentState | undefined {
    const key = normalizeKey(title);
    const exact = commitments.get(key);
    if (exact) return exact;
    let best: CommitmentState | undefined;
    let bestScore = 0.3;
    for (const c of commitments.values()) {
      const score = jaccard(c.title, title);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  function handleCommitment(obs: Observation): void {
    const title = obs.commitmentTitle ?? obs.summary;
    const existing = findCommitment(title);
    const emitC = (c: CommitmentState, type: EventType, note: string | null) =>
      emit({
        decisionKey: null, commitmentKey: c.key, type, applied: true, fromCommitment: null, toCommitment: null,
        fromImplementation: null, toImplementation: null, memoryId: obs.memoryId, occurredAt: obs.occurredAt,
        actor: "extraction", note,
      });

    if (obs.kind === "commitment") {
      if (existing && existing.status === "OPEN") {
        memoryLinks.set(obs.memoryId, { decisionKey: null, commitmentKey: existing.key });
        if (obs.commitmentDueAt) existing.dueAt = obs.commitmentDueAt;
        return emitC(existing, "CORROBORATED", "Commitment restated");
      }
      const c: CommitmentState = {
        key: normalizeKey(title), title, owner: obs.commitmentOwner, dueAt: obs.commitmentDueAt,
        status: "OPEN", openedAt: obs.occurredAt, closedAt: null,
      };
      commitments.set(c.key, c);
      memoryLinks.set(obs.memoryId, { decisionKey: null, commitmentKey: c.key });
      return emitC(c, "COMMITMENT_OPENED", null);
    }

    if (!existing) {
      reviews.push({
        memoryId: obs.memoryId, kind: "ambiguous", decisionKey: null, commitmentKey: null, blocking: true,
        title: `Unknown commitment ${obs.kind === "commitment_done" ? "completed" : "cancelled"}`,
        detail: `"${obs.summary}" refers to a commitment that was never recorded.`,
        proposed: { kind: obs.kind, title },
      });
      return;
    }
    memoryLinks.set(obs.memoryId, { decisionKey: null, commitmentKey: existing.key });
    if (existing.status !== "OPEN") return emitC(existing, "CORROBORATED", `Already ${existing.status.toLowerCase()}`);
    existing.status = obs.kind === "commitment_done" ? "DONE" : "CANCELLED";
    existing.closedAt = obs.occurredAt;
    return emitC(existing, obs.kind === "commitment_done" ? "COMMITMENT_DONE" : "COMMITMENT_CANCELLED", null);
  }
}
