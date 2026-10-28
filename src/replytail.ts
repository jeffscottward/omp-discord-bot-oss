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
const TRADING_RE = /finance|newsletter|market/i;
export function isFinanceChannel(
  id: string | undefined,
  names: (string | null | undefined)[],
  ids = new Set((process.env.OMP_TRADING_CHANNEL_IDS ?? "").split(/[\s,]+/).filter(Boolean)),
): boolean {
  if (id && ids.has(id)) return true;
  return names.some((n) => !!n && TRADING_RE.test(n));
}
