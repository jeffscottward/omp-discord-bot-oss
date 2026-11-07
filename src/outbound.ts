import { splitPasteBlocks } from "./blocks.ts";
import { ATTACH_THRESHOLD } from "./config.ts";
import { redact } from "./redact.ts";
import { redactKnownSecrets } from "./secrets.ts";
import { splitMessage } from "./split.ts";
import { shortenLinks } from "./links.ts";
import { tablesToCode } from "./tables.ts";

export const DISCORD_MAX = 2000;

export interface OutMsg {
  /** Message text (≤ 2000 chars). */
  content: string;
  /** Attached file (long answers: answer.md; long paste blocks: paste-N.txt). */
  file?: { name: string; data: string };
  /** A paste block: content is only the fenced block (or the block is the attached .txt). */
  paste?: boolean;
}

export interface Outbound {
  /** Messages to send in order. */
  messages: OutMsg[];
  hits: Record<string, number>;
}

/** Prose only: split; very long prose becomes one preview message plus a .md attachment. */
function proseMessages(raw: string): OutMsg[] {
  const text = shortenLinks(raw);
  if (text.length <= ATTACH_THRESHOLD) return splitMessage(text).map((content) => ({ content }));
  const preview = splitMessage(text, 1800)[0] ?? "";
  return [{ content: `${preview}\n\n*(${text.length.toLocaleString()} chars — full answer attached)*`, file: { name: "answer.md", data: text } }];
}

/**
 * Redact (patterns + known secret values), then split. Paste blocks (see src/blocks.ts) become
 * their own messages containing only the fenced block; a block too long for one message is
 * attached as a .txt instead. The prose around them stays in normal messages.
 */
/** Card empty-answer-fix (owner 2026-10-31): true when the answer has no prose left to post. */
export function isBlankAnswer(text: string): boolean {
  return !tablesToCode(text.trim()).trim();
}

/**
 * Card empty-answer-fix: decide what an answer without prose posts. Prose messages are skipped when the answer is
 * blank; files/audio/links still go out in a message without placeholder text. `fallback` is the one real line to post
 * only when nothing at all was posted (for example an ask-only answer whose questions were all dropped).
 */
export function emptyAnswerPlan(o: { prose: string; files: number; audio: boolean; links: number }): { blank: boolean; carrier: boolean } {
  const blank = isBlankAnswer(o.prose);
  return { blank, carrier: blank && (o.files > 0 || o.audio || o.links > 0) };
}
export const EMPTY_FALLBACK = "↩️ No new text or question: the owner already answered this earlier.";
export function emptyAnswerFallback(blank: boolean, postedCount: number): string | undefined {
  return blank && postedCount === 0 ? EMPTY_FALLBACK : undefined;
}

export function prepareOutbound(text: string): Outbound {
  const r = redact(tablesToCode(text.trim()) || "(empty answer)");
  const known = redactKnownSecrets(r.text);
  const safe = known.text;
  const hits = known.hits ? { ...r.hits, "known-secret": known.hits } : r.hits;
  const segments = splitPasteBlocks(safe);
  if (!segments.some((s) => s.kind === "block")) return { messages: proseMessages(safe), hits };

  const proseTotal = segments.reduce((n, s) => n + (s.kind === "prose" ? s.text.length : 0), 0);
  const messages: OutMsg[] = [];
  let n = 0;
  const pushBlock = (s: { body: string; fenced: string }) => {
    n++;
    if (s.fenced.length <= DISCORD_MAX) messages.push({ content: s.fenced, paste: true });
    else
      messages.push({
        content: `📎 Paste block ${n} (${s.body.length.toLocaleString()} chars) is attached — too long for one message.`,
        file: { name: `paste-${n}.txt`, data: s.body },
        paste: true,
      });
  };
  if (proseTotal > ATTACH_THRESHOLD) {
    // Very long prose: preview + full answer.md first, then every paste block on its own.
    messages.push(...proseMessages(safe));
    for (const s of segments) if (s.kind === "block") pushBlock(s);
    return { messages, hits };
  }
  for (const s of segments) {
    if (s.kind === "prose") messages.push(...proseMessages(s.text));
    else pushBlock(s);
  }
  return { messages, hits };
}

/**
 * Owner 2026-10-19: a copy-ready message. Redact secrets, but keep the text exactly as written:
 * no link shortening (Copy Text would copy "[host ↗](<url>)"), no tables, no splitting.
 */
export function prepareCopy(text: string): { content: string; hits: Record<string, number> } | { error: string } {
  const r = redact(text.trim());
  const known = redactKnownSecrets(r.text);
  const hits = known.hits ? { ...r.hits, "known-secret": known.hits } : r.hits;
  if (!known.text) return { error: "empty text" };
  if (known.text.length > DISCORD_MAX) return { error: `copy text longer than ${DISCORD_MAX} chars` };
  return { content: known.text, hits };
}
