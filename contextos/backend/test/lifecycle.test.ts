import { describe, expect, it } from "vitest";
import { runLifecycle, type Observation, type Resolution } from "../src/domain/lifecycle.js";

let n = 0;
function obs(partial: Partial<Observation> & Pick<Observation, "kind">, month = 1): Observation {
  n++;
  return {
    memoryId: `m${n}`,
    occurredAt: new Date(Date.UTC(2026, month - 1, 10, 0, n)),
    summary: partial.summary ?? `${partial.kind} ${partial.option ?? ""}`,
    subjectKey: "database",
    subjectLabel: "Primary database",
    option: null,
    previousOption: null,
    replacesPrevious: false,
    reason: null,
    commitmentTitle: null,
    commitmentOwner: null,
    commitmentDueAt: null,
    speakerRole: "user",
    hedged: false,
    confidence: 0.9,
    excerptVerified: true,
    ...partial,
  };
}
const exclusive = () => "exclusive" as const;
const run = (list: Observation[], resolutions = new Map<string, Resolution>()) =>
  runLifecycle(list, { cardinality: exclusive, resolutions });
const state = (r: ReturnType<typeof run>, option: string) => r.decisions.get(`database::${option.toLowerCase()}`)!;

describe("lifecycle engine", () => {
  it("rule 1: a proposal is not a decision", () => {
    const r = run([obs({ kind: "proposal", option: "PostgreSQL" })]);
    expect(state(r, "PostgreSQL")).toMatchObject({ commitment: "PROPOSED", implementation: "NOT_STARTED" });
  });

  it("rule 2: a decision does not imply implementation", () => {
    const r = run([obs({ kind: "decision", option: "PostgreSQL" })]);
    expect(state(r, "PostgreSQL")).toMatchObject({ commitment: "DECIDED", implementation: "NOT_STARTED" });
  });

  it("rule 3: an implementation claim is not verification", () => {
    const r = run([obs({ kind: "decision", option: "PostgreSQL" }), obs({ kind: "implementation_claim", option: "PostgreSQL" }, 2)]);
    expect(state(r, "PostgreSQL").implementation).toBe("CLAIMED_IMPLEMENTED");
    expect(state(r, "PostgreSQL").verifiedAt).toBeNull();
  });

  it("full StudyMate path: Mongo proposed → Postgres considered → decided → claimed → verified", () => {
    const r = run([
      obs({ kind: "proposal", option: "MongoDB" }, 1),
      obs({ kind: "proposal", option: "PostgreSQL" }, 2),
      obs({ kind: "decision", option: "PostgreSQL", previousOption: "MongoDB", replacesPrevious: true, reason: "relational data" }, 3),
      obs({ kind: "implementation_claim", option: "PostgreSQL" }, 4),
      obs({ kind: "verification", option: "PostgreSQL" }, 5),
    ]);
    expect(state(r, "PostgreSQL")).toMatchObject({ commitment: "DECIDED", implementation: "VERIFIED", reason: "relational data" });
    expect(state(r, "MongoDB")).toMatchObject({ commitment: "SUPERSEDED", supersededByKey: "database::postgresql" });
    expect(r.events.filter((e) => e.decisionKey === "database::postgresql").map((e) => e.type)).toEqual([
      "PROPOSED", "DECIDED", "IMPLEMENTATION_CLAIMED", "VERIFIED",
    ]);
    expect(r.reviews).toEqual([]);
  });

  it("rule 4: an unverified claim never overrides a verified state", () => {
    const r = run([
      obs({ kind: "decision", option: "PostgreSQL" }, 3),
      obs({ kind: "verification", option: "PostgreSQL" }, 5),
      obs({ kind: "in_use", option: "MongoDB", summary: "We still use MongoDB" }, 6),
    ]);
    expect(state(r, "PostgreSQL")).toMatchObject({ implementation: "VERIFIED", disputed: true });
    expect(state(r, "MongoDB").implementation).toBe("NOT_STARTED");
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0]).toMatchObject({ kind: "conflict", blocking: true });
    expect(r.events.at(-1)).toMatchObject({ type: "CONFLICT_FLAGGED", applied: false });
  });

  it("a confirmed conflict is applied on replay; a dismissed one is not", () => {
    const list = [
      obs({ kind: "decision", option: "PostgreSQL" }, 3),
      obs({ kind: "verification", option: "PostgreSQL" }, 5),
      obs({ kind: "in_use", option: "MongoDB" }, 6),
    ];
    const conflictMemory = list[2]!.memoryId;
    const confirmed = run(list, new Map([[`${conflictMemory}:conflict`, "confirmed" as const]]));
    expect(state(confirmed, "MongoDB").implementation).toBe("CLAIMED_IMPLEMENTED");
    expect(state(confirmed, "PostgreSQL").implementation).toBe("RETIRED");

    const dismissed = run(list, new Map([[`${conflictMemory}:conflict`, "dismissed" as const]]));
    expect(state(dismissed, "PostgreSQL")).toMatchObject({ implementation: "VERIFIED", disputed: false });
  });

  it("rule 5: a later decision supersedes an earlier one; the earlier one keeps its history", () => {
    const r = run([
      obs({ kind: "decision", option: "Heroku", subjectKey: "hosting" }, 1),
      obs({ kind: "decision", option: "Render", subjectKey: "hosting", previousOption: "Heroku", replacesPrevious: true }, 3),
    ]);
    const heroku = r.decisions.get("hosting::heroku")!;
    expect(heroku).toMatchObject({ commitment: "SUPERSEDED", supersededByKey: "hosting::render" });
    expect(heroku.decidedAt).not.toBeNull(); // history preserved
    expect(r.decisions.get("hosting::render")!.commitment).toBe("DECIDED");
  });

  it("a planned migration retires the previous implementation", () => {
    const r = run([
      obs({ kind: "in_use", option: "MongoDB" }, 1),
      obs({ kind: "decision", option: "PostgreSQL", previousOption: "MongoDB", replacesPrevious: true }, 3),
      obs({ kind: "implementation_claim", option: "PostgreSQL" }, 4),
    ]);
    expect(state(r, "MongoDB")).toMatchObject({ commitment: "SUPERSEDED", implementation: "RETIRED" });
    expect(state(r, "PostgreSQL").implementation).toBe("CLAIMED_IMPLEMENTED");
  });

  it("rule 6: rejected proposals remain in history", () => {
    const r = run([
      obs({ kind: "proposal", option: "Redis", subjectKey: "cache" }, 2),
      obs({ kind: "rejection", option: "Redis", subjectKey: "cache", reason: "low traffic" }, 2),
    ]);
    const redis = r.decisions.get("cache::redis")!;
    expect(redis).toMatchObject({ commitment: "REJECTED", reason: "low traffic" });
    expect(r.events.map((e) => e.type)).toEqual(["PROPOSED", "REJECTED"]);
  });

  it("rule 7: hedged or low-confidence statements are held for review", () => {
    const r = run([obs({ kind: "decision", option: "MySQL", hedged: true }), obs({ kind: "decision", option: "SQLite", confidence: 0.3 })]);
    expect(state(r, "MySQL").commitment).toBe("NONE");
    expect(state(r, "SQLite").commitment).toBe("NONE");
    expect(r.reviews.map((x) => x.kind)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("rule 7: an excerpt that is not in the source is held for review", () => {
    const r = run([obs({ kind: "decision", option: "PostgreSQL", excerptVerified: false })]);
    expect(state(r, "PostgreSQL").commitment).toBe("NONE");
    expect(r.reviews[0]?.kind).toBe("unverified_excerpt");
  });

  it("assistant 'decisions' are recorded only as proposals", () => {
    const r = run([obs({ kind: "decision", option: "PostgreSQL", speakerRole: "assistant" })]);
    expect(state(r, "PostgreSQL").commitment).toBe("PROPOSED");
  });

  it("deciding a previously rejected option requires confirmation", () => {
    const r = run([obs({ kind: "rejection", option: "Redis", subjectKey: "cache" }, 1), obs({ kind: "decision", option: "Redis", subjectKey: "cache" }, 2)]);
    expect(r.decisions.get("cache::redis")!.commitment).toBe("REJECTED");
    expect(r.reviews[0]?.kind).toBe("reopened");
  });

  it("implementation without a recorded decision is applied but flagged (non-blocking)", () => {
    const r = run([obs({ kind: "implementation_claim", option: "Stripe", subjectKey: "payments" })]);
    expect(r.decisions.get("payments::stripe")!.implementation).toBe("CLAIMED_IMPLEMENTED");
    expect(r.reviews[0]).toMatchObject({ kind: "missing_decision", blocking: false });
  });

  it("processes observations in event-time order regardless of input order", () => {
    const decided = obs({ kind: "decision", option: "PostgreSQL" }, 3);
    const verified = obs({ kind: "verification", option: "PostgreSQL" }, 5);
    const r = run([verified, decided]);
    expect(state(r, "PostgreSQL")).toMatchObject({ commitment: "DECIDED", implementation: "VERIFIED" });
  });

  it("commitments open, complete and cancel by fuzzy title match", () => {
    const r = run([
      obs({ kind: "commitment", subjectKey: null, commitmentTitle: "Write the data migration runbook", commitmentOwner: "Priya" }, 3),
      obs({ kind: "commitment", subjectKey: null, commitmentTitle: "Build a GraphQL API layer" }, 1),
      obs({ kind: "commitment_cancelled", subjectKey: null, commitmentTitle: "GraphQL API layer" }, 3),
      obs({ kind: "commitment_done", subjectKey: null, commitmentTitle: "data migration runbook" }, 5),
    ]);
    const list = [...r.commitments.values()];
    expect(list.find((c) => c.title.includes("runbook"))).toMatchObject({ status: "DONE", owner: "Priya" });
    expect(list.find((c) => c.title.includes("GraphQL"))?.status).toBe("CANCELLED");
  });

  it("a decision-level cancellation that only names a commitment cancels the commitment", () => {
    const r = run([
      obs({ kind: "commitment", subjectKey: null, commitmentTitle: "Build public API documentation portal" }, 1),
      obs({ kind: "cancellation", subjectKey: null, option: null, commitmentTitle: "API documentation portal" }, 3),
    ]);
    expect([...r.commitments.values()][0]?.status).toBe("CANCELLED");
  });

  it("every event references the memory that caused it", () => {
    const r = run([obs({ kind: "proposal", option: "MongoDB" }, 1), obs({ kind: "decision", option: "PostgreSQL" }, 3)]);
    for (const e of r.events) expect(e.memoryId).toMatch(/^m\d+$/);
    const sup = r.events.find((e) => e.type === "SUPERSEDED")!;
    expect(sup.actor).toBe("engine");
  });
});
