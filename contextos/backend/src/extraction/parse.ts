import type { ParsedMessage } from "../domain/types.js";

const SPEAKER_LINE = /^\s*([A-Za-z][A-Za-z0-9 ._'-]{0,39}?)\s*:\s+(.+)$/;
const ASSISTANT_NAMES = /^(assistant|ai|odysseus|bot|gpt|chatgpt|claude|gemini|copilot)$/i;

/**
 * Turn pasted conversation text into messages.
 * "Name: text" lines start a new message; other lines continue the previous one.
 * Text without any speaker lines becomes a single message.
 */
export function parseConversationText(text: string): ParsedMessage[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = SPEAKER_LINE.exec(line);
    if (m?.[1] && m[2] && !/^https?$/i.test(m[1])) {
      const speaker = m[1].trim();
      const role: ParsedMessage["role"] = ASSISTANT_NAMES.test(speaker)
        ? "assistant"
        : /^system$/i.test(speaker)
          ? "system"
          : /^user$/i.test(speaker)
            ? "user"
            : "user";
      current = { seq: out.length, role, speaker: /^(user|assistant|system)$/i.test(speaker) ? null : speaker, content: m[2].trim() };
      out.push(current);
    } else if (line.trim()) {
      if (!current) {
        current = { seq: out.length, role: "unknown", speaker: null, content: line.trim() };
        out.push(current);
      } else {
        current.content += `\n${line.trim()}`;
      }
    }
  }
  return out;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;,]+$/, "");
}

/**
 * Check that an extractor's excerpt really appears in the stored source.
 * Returns the index of the message that contains it, or null if it was not found.
 */
export function locateExcerpt(excerpt: string, messages: readonly ParsedMessage[], hintIndex: number): number | null {
  const needle = norm(excerpt);
  if (needle.length < 3) return null;
  const hinted = messages[hintIndex];
  if (hinted && norm(hinted.content).includes(needle)) return hintIndex;
  const found = messages.findIndex((m) => norm(m.content).includes(needle));
  return found >= 0 ? found : null;
}
