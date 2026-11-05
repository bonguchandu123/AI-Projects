import { describe, expect, it } from "vitest";
import { DEMO_CONVERSATIONS } from "../src/demo/studymate.js";
import { fallbackExtract, parseDue } from "../src/extraction/fallback.js";
import { locateExcerpt, parseConversationText } from "../src/extraction/parse.js";
import { extractionResultSchema } from "../src/domain/types.js";

function extract(i: number) {
  const c = DEMO_CONVERSATIONS[i]!;
  const messages = parseConversationText(c.text);
  return { messages, result: fallbackExtract(messages, new Date(c.occurredAt)) };
}
const brief = (items: ReturnType<typeof fallbackExtract>["items"]) =>
  items.map((x) => `${x.kind}:${x.option ?? x.commitment_title ?? ""}${x.previous_option ? `<${x.previous_option}` : ""}`);

describe("conversation parser", () => {
  it("splits speaker lines into messages and detects assistants", () => {
    const m = parseConversationText("Asha: hello there\ncontinued line\nAssistant: hi\nUser: ok");
    expect(m).toEqual([
      { seq: 0, role: "user", speaker: "Asha", content: "hello there\ncontinued line" },
      { seq: 1, role: "assistant", speaker: null, content: "hi" },
      { seq: 2, role: "user", speaker: null, content: "ok" },
    ]);
  });
  it("treats speaker-less text as one message", () => {
    expect(parseConversationText("We decided to use PostgreSQL.")).toHaveLength(1);
  });
  it("verifies excerpts against the source, tolerating whitespace and punctuation", () => {
    const m = parseConversationText("A: We decided   to use PostgreSQL.\nB: Second.");
    expect(locateExcerpt("we decided to use PostgreSQL", m, 0)).toBe(0);
    expect(locateExcerpt("We decided to use MySQL", m, 0)).toBeNull();
    expect(locateExcerpt("Second", m, 0)).toBe(1); // wrong hint still found
  });
});

describe("fallback extractor on the StudyMate demo dataset", () => {
  it("produces schema-valid output for every demo conversation", () => {
    DEMO_CONVERSATIONS.forEach((_, i) => {
      expect(() => extractionResultSchema.parse(extract(i).result)).not.toThrow();
    });
  });

  it("January: MongoDB proposed, Heroku decided, a commitment opened", () => {
    const { result } = extract(0);
    expect(brief(result.items)).toEqual([
      "fact:", "proposal:MongoDB", "decision:Heroku", "commitment:Build the public API documentation portal",
    ]);
    const mongo = result.items.find((x) => x.option === "MongoDB")!;
    expect(mongo.reason).toBe("it is easy to integrate with our Node.js backend");
    expect(result.items.at(-1)?.commitment_due).toBe("2026-02-28");
  });

  it("February: PostgreSQL considered (proposal, not decision), Redis proposed then rejected", () => {
    expect(brief(extract(1).result.items)).toEqual(["proposal:PostgreSQL", "proposal:Redis", "rejection:Redis"]);
  });

  it("March: migration decided with MongoDB as the replaced option and a reason", () => {
    const { result } = extract(2);
    expect(brief(result.items)).toEqual([
      "decision:PostgreSQL<MongoDB", "commitment:Write the data migration runbook", "decision:Stripe",
    ]);
    expect(result.items[0]).toMatchObject({ replaces_previous: true, reason: "relational data requirements" });
    expect(result.items[1]).toMatchObject({ commitment_owner: "Priya", commitment_due: "2026-03-20" });
  });

  it("March 18: hosting moved Heroku → Render; doc portal commitment cancelled", () => {
    expect(brief(extract(3).result.items)).toEqual([
      "decision:Render<Heroku", "commitment_cancelled:API documentation portal task",
    ]);
  });

  it("April: implementation claims (not verification)", () => {
    expect(brief(extract(4).result.items)).toEqual(["implementation_claim:PostgreSQL", "implementation_claim:Stripe"]);
  });

  it("May: verification, and the runbook commitment completed", () => {
    expect(brief(extract(5).result.items)).toEqual([
      "verification:PostgreSQL", "commitment_done:data migration runbook", "commitment:Add payment failure alerts",
    ]);
  });

  it("June: contradictory in-use statement", () => {
    expect(brief(extract(6).result.items)).toEqual(["in_use:MongoDB"]);
  });

  it("every excerpt is verbatim from the source", () => {
    DEMO_CONVERSATIONS.forEach((_, i) => {
      const { messages, result } = extract(i);
      for (const item of result.items) expect(locateExcerpt(item.excerpt, messages, item.message_index)).toBe(item.message_index);
    });
  });

  it("parses due dates relative to the conversation date", () => {
    const ref = new Date("2026-03-03T00:00:00Z");
    expect(parseDue("March 20", ref)).toBe("2026-03-20");
    expect(parseDue("end of February", ref)).toBe("2026-02-28");
    expect(parseDue("2026-07-01", ref)).toBe("2026-07-01");
    expect(parseDue("soon", ref)).toBeNull();
  });
});
