/**
 * Deterministic rule-based extractor. Used when Gemini is not configured or fails.
 * Output is always labelled extraction_method = "fallback".
 *
 * Deliberately conservative: sentence-level patterns over a known technology
 * catalog. Sentences that match nothing produce no memory (we do not store
 * every sentence as "memory").
 */
import type { ExtractionItem, ExtractionResult, ParsedMessage } from "../domain/types.js";
import { SUBJECT_LABELS, catalogByName, findTechMentions } from "./catalog.js";

const RX = {
  hedged: /\b(maybe|might|perhaps|probably|i think|not sure|possibly)\b/i,
  verification: /\b(verified|confirmed|validated|is running successfully|running successfully|working correctly|passed (all )?(the )?tests)\b/i,
  implementation:
    /\b(has|have) been (implemented|completed|deployed|migrated|integrated|shipped|rolled out)\b|\b(is|are|was|were) (now )?(implemented|deployed|integrated|live)\b|\bmigration (is|was|has been) (complete|completed|done|finished)\b|\bwe (have )?(migrated|deployed|implemented|integrated|shipped)\b/i,
  reversal: /\b(revert(ed)?|roll(ed)? back|go(ing)? back to|reversed?)\b/i,
  cancellation: /\b(cancel(l?ed)?|called off|abandon(ed)?|scrapp(ed)?|shelved)\b/i,
  rejection: /\b(reject(ed|s)?|decided against|ruled out|won't use|will not use|not going to use|turned down)\b/i,
  decision:
    /\b(decided|have decided|chose|chosen|going with|settled on|selected|agreed (to|on)|finali[sz]ed|will use|we'll use|will migrate|are moving|moving \w+ from|switch(ing)? to)\b/i,
  inUse: /\b(still|currently)\s+(use|uses|using|stores?|storing|runs? on|relies on|is on)\b|\bwe use\b|\bis (hosted|running) on\b/i,
  proposal:
    /\b(consider(ing|ed)?|propos(e|ed|ing|al)|suggest(ed|s|ion)?|planning to (use|adopt)|plan to (use|adopt)|thinking (about|of)|evaluat(e|ing)|explor(e|ing)|could use|might use|should (we )?use|what about)\b/i,
  commitment:
    /^(?:([A-Z][a-z]*)\s+)?(?:will|is going to|'ll)\s+((?:write|build|create|prepare|finish|set up|add|document|implement|deliver|draft|update)\b.*?)(?:\s+by\s+(.+?))?[.!]?$/,
  done: /\b(finished|completed|delivered|wrapped up)\b\s+(.+?)[.!]?$/i,
  commitmentCancelled: /\b(cancel(?:l?ed)?|called off|dropped|abandoned|scrapped)\b\s+(.+?)(?:\s+because\b.*)?[.!]?$/i,
  reason: /\b(?:because(?: of)?|since|due to)\s+(.+?)[.!]?$/i,
  fact: /\bwe are building\b/i,
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Parse "March 20", "20 March", "end of February", "2026-03-20" relative to the conversation date. */
export function parseDue(text: string, ref: Date): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso?.[1]) return iso[1];
  const t = text.toLowerCase();
  const year = ref.getUTCFullYear();
  const mk = (m: number, d: number) => {
    let y = year;
    if (Date.UTC(y, m, d) < ref.getTime() - 180 * 864e5) y++;
    return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  };
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i]!;
    const endOf = new RegExp(`end of ${name}`).test(t);
    if (endOf) return mk(i + 1, 0); // day 0 of next month = last day
    const a = new RegExp(`${name}\\s+(\\d{1,2})`).exec(t) ?? new RegExp(`(\\d{1,2})\\s+${name}`).exec(t);
    if (a?.[1]) return mk(i, Number(a[1]));
  }
  return null;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function cleanReason(s: string): string {
  return s.replace(/^of\s+/i, "").replace(/[.!]+$/, "").trim();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pickOption(sentence: string, techs: ReturnType<typeof findTechMentions>) {
  const subjectTechs = techs.filter((t) => t.entry.subject);
  const fromTo = /\bfrom\s+([\w.]+(?:\s[\w.]+)?)\s+to\s+([\w.]+)/i.exec(sentence);
  if (fromTo?.[1] && fromTo[2]) {
    const prev = catalogByName(fromTo[1].split(" ")[0]!) ?? findTechMentions(fromTo[1])[0]?.entry;
    const next = catalogByName(fromTo[2]) ?? findTechMentions(fromTo[2])[0]?.entry;
    if (prev?.subject && next?.subject) return { option: next, previous: prev, replaces: true };
  }
  const instead = /\binstead of\s+([\w.]+)/i.exec(sentence);
  if (instead?.[1]) {
    const prev = catalogByName(instead[1]);
    const other = subjectTechs.find((t) => t.entry.name !== prev?.name);
    if (prev?.subject && other) return { option: other.entry, previous: prev, replaces: true };
  }
  const first = subjectTechs[0];
  return first ? { option: first.entry, previous: null, replaces: false } : null;
}

export function fallbackExtract(messages: readonly ParsedMessage[], conversationDate: Date): ExtractionResult {
  const items: ExtractionItem[] = [];
  const entities = new Map<string, ExtractionResult["entities"][number]>();

  messages.forEach((msg, messageIndex) => {
    if (msg.speaker) entities.set(msg.speaker.toLowerCase(), { name: msg.speaker, kind: "person" });
    const speakerRole = msg.role;
    for (const sentence of splitSentences(msg.content)) {
      const techs = findTechMentions(sentence);
      for (const t of techs) entities.set(t.entry.name.toLowerCase(), { name: t.entry.name, kind: "technology" });
      const hedged = RX.hedged.test(sentence);
      const reasonMatch = RX.reason.exec(sentence);
      const reason = reasonMatch?.[1] ? cleanReason(reasonMatch[1]) : null;
      const base = {
        excerpt: sentence,
        message_index: messageIndex,
        speaker_role: speakerRole,
        hedged,
        confidence: hedged ? 0.5 : 0.8,
        commitment_title: null,
        commitment_owner: null,
        commitment_due: null,
        reason,
      } as const;

      // Commitments first: "<Name> will <verb> ... by <date>".
      const c = RX.commitment.exec(sentence);
      if (c?.[2]) {
        const title = capitalize(c[2].trim());
        const owner = c[1] && !/^(I|We)$/.test(c[1]) ? c[1] : msg.speaker;
        items.push({
          ...base, kind: "commitment", summary: `${owner ? `${owner} committed to: ` : "Commitment: "}${title}`,
          subject_key: null, subject_label: null, option: null, previous_option: null, replaces_previous: false,
          commitment_title: title, commitment_owner: owner ?? null, commitment_due: c[3] ? parseDue(c[3], conversationDate) : null,
          reason: null,
        });
        continue;
      }

      const pick = pickOption(sentence, techs);
      if (!pick) {
        const done = RX.done.exec(sentence);
        const cancelled = RX.commitmentCancelled.exec(sentence);
        if (cancelled?.[2]) {
          const title = cancelled[2].replace(/^the\s+/i, "");
          items.push({
            ...base, kind: "commitment_cancelled", summary: `Commitment cancelled: ${title}`,
            subject_key: null, subject_label: null, option: null, previous_option: null, replaces_previous: false,
            commitment_title: title,
          });
        } else if (done?.[2]) {
          const title = done[2].replace(/^the\s+/i, "");
          items.push({
            ...base, kind: "commitment_done", summary: `Commitment completed: ${title}`,
            subject_key: null, subject_label: null, option: null, previous_option: null, replaces_previous: false,
            commitment_title: title,
          });
        } else if (RX.fact.test(sentence)) {
          items.push({
            ...base, kind: "fact", summary: sentence.replace(/[.!]+$/, ""), subject_key: null, subject_label: null,
            option: null, previous_option: null, replaces_previous: false,
          });
        }
        continue;
      }

      const kind: ExtractionItem["kind"] | null = RX.verification.test(sentence)
        ? "verification"
        : RX.implementation.test(sentence)
          ? "implementation_claim"
          : RX.reversal.test(sentence)
            ? "reversal"
            : RX.cancellation.test(sentence)
              ? "cancellation"
              : RX.rejection.test(sentence)
                ? "rejection"
                : RX.decision.test(sentence)
                  ? "decision"
                  : RX.inUse.test(sentence)
                    ? "in_use"
                    : RX.proposal.test(sentence)
                      ? "proposal"
                      : null;
      if (!kind) continue;

      const subject = pick.option.subject!;
      const label = SUBJECT_LABELS[subject] ?? subject;
      const verb: Record<string, string> = {
        verification: "verified", implementation_claim: "claimed implemented", reversal: "reversed",
        cancellation: "cancelled", rejection: "rejected", decision: "decided", in_use: "stated in use", proposal: "proposed",
      };
      const optionsToEmit =
        kind === "proposal" && !pick.replaces
          ? techs.filter((t) => t.entry.subject === subject).map((t) => t.entry)
          : [pick.option];
      for (const option of optionsToEmit) {
        items.push({
          ...base,
          kind,
          summary: `${option.name} ${verb[kind]} as ${label.toLowerCase()}${pick.previous && option === pick.option ? ` (replacing ${pick.previous.name})` : ""}`,
          subject_key: subject,
          subject_label: label,
          option: option.name,
          previous_option: option === pick.option ? (pick.previous?.name ?? null) : null,
          replaces_previous: option === pick.option && pick.replaces,
        });
      }
    }
  });

  return { items, entities: [...entities.values()], relationships: [] };
}
