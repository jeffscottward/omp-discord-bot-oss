/**
 * Discord messages hold at most 2000 characters. A long voice transcript must be split into parts
 * (owner 2026-10-31, card voice-long-transcript): one 202 s voice message was lost when its single
 * 2,073-char header message was rejected.
 */
export const DISCORD_MAX = 2000;

/** Split text at word boundaries into pieces of at most `max` chars (hard-cuts words longer than `max`). */
export function splitWords(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    const nl = rest.lastIndexOf("\n", max);
    if (nl > cut) cut = nl;
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Transcript header message(s): "🎙️ from **name**: *text*", italic per part, each <= `max` chars. */
export function voiceHeaderParts(name: string, spoken: string, max = DISCORD_MAX): string[] {
  const clean = spoken.replace(/[*_`]/g, "").trim();
  const prefix = `🎙️ from **${name.replace(/[*_`]/g, "")}**: `;
  const single = `${prefix}*${clean}*`;
  if (single.length <= max) return [single];
  const marker = (i: number, n: number) => ` (${i}/${n})`;
  const room = max - prefix.length - 2 - marker(99, 99).length;
  const pieces = splitWords(clean, room);
  return pieces.map((p, i) => (i === 0 ? `${prefix}*${p}*` : `*${p}*`) + marker(i + 1, pieces.length));
}

export interface HeaderSenders<M> {
  first: (content: string) => Promise<M | null>;
  rest: (content: string) => Promise<void>;
  notice: (content: string) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Post the transcript header parts. Never throws: on a send failure it logs, posts one short notice
 * (best effort) and returns null, so the caller still starts the run with the full transcript.
 */
export async function postVoiceHeader<M>(parts: string[], s: HeaderSenders<M>): Promise<M | null> {
  try {
    const first = await s.first(parts[0]!);
    for (const p of parts.slice(1)) await s.rest(p);
    return first;
  } catch (e) {
    s.log(`voice header post: ${(e as Error).message}`);
    await s.notice("⚠️ I couldn't post the transcript, but I am working on the full text.").catch(() => {});
    return null;
  }
}
