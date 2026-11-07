/**
 * Reply tail (owner 2026-10-21): the model signature and the dashboard link form ONE bullet list
 * at the end of a reply, always after exactly one blank line:
 *
 *   <content>
 *
 *   - 🧠 <provider/model>
 *   - ⚓ [Open …](<url>)
 */

export const DISCORD_MAX = 2000;

/** The bullet list; "" when there is nothing to show. */
export function buildTail(model?: string, dashLine?: string): string {
  const lines: string[] = [];
  if (model) lines.push(`- 🧠 ${model}`);
  if (dashLine) lines.push(`- ${dashLine}`);
  return lines.join("\n");
}

/**
 * Put the tail under `content` (plus `spacer` after it, the audio-player gap). When the result
 * would exceed the Discord limit, the content stays as it is and the tail is returned as its own
 * follow-up message; the tail is never dropped.
 */
export function attachTail(content: string, tail: string, spacer = "", max = DISCORD_MAX): { content: string; followup?: string } {
  if (!tail) return { content };
  const body = content.replace(/\s+$/, "");
  if (!body) return { content: tail + spacer };
  const joined = `${body}\n\n${tail}${spacer}`;
  if (joined.length <= max) return { content: joined };
  return { content: content + spacer, followup: tail };
}

/** Finance channels get table PNGs only, never a web page (owner 2026-10-21). */
const FINANCE_RE = /finance|newsletter|market/i;
export function isFinanceChannel(
  id: string | undefined,
  names: (string | null | undefined)[],
  ids = new Set((process.env.OMP_FINANCE_CHANNEL_IDS ?? "").split(/[\s,]+/).filter(Boolean)),
): boolean {
  if (id && ids.has(id)) return true;
  return names.some((n) => !!n && FINANCE_RE.test(n));
}

/**
 * Owner 2026-10-31 (card reply-thinking-level): the effective thinking level of a run, shown after the model.
 * OMP writes a thinking_level_change entry at session start and again when the auto classifier picks a
 * different level for a turn, so the LAST entry is the level the final turn used. "auto" marks a router pick.
 */
export function lastThinking(file?: string, readTail: (f: string) => string = tailOf): string | undefined {
  if (!file) return undefined;
  let text = "";
  try {
    text = readTail(file);
  } catch {
    return undefined;
  }
  let out: string | undefined;
  for (const m of text.matchAll(/"type":"thinking_level_change"[^\n]*?"thinkingLevel":"([a-z]+)"(?:,"configured":"([a-z]+)")?/g)) {
    out = m[2] === "auto" ? `${m[1]} (auto)` : m[1];
  }
  return out;
}

function tailOf(file: string): string {
  const { closeSync, fstatSync, openSync, readSync } = require("node:fs") as typeof import("node:fs");
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Owner 2026-10-31: the thinking level is its own bullet under the model ("- 🧩 thinking <level>"). */
export function modelWithThinking(model: string | undefined, thinking: string | undefined): string | undefined {
  if (!model) return model;
  return thinking ? `${model}\n- 🧩 thinking ${thinking}` : model;
}
