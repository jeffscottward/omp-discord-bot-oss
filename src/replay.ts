// Owner 2026-11-03 (card discord-charts): an owner message the bot missed (for example, in a channel added to the
// config after the last start) can be run once after the next start. An agent writes
// state/replay.json = [{"channelId": "...", "messageId": "..."}]. At ClientReady the bot fetches each message,
// runs it like a new message only when the owner wrote it in the last 24 h, and deletes the file first so a
// crash loop cannot run it twice. Nothing here can create an owner message; it only re-reads real ones.

import { existsSync, readFileSync, rmSync } from "node:fs";

export interface ReplayItem { channelId: string; messageId: string }

export const REPLAY_MAX_AGE_MS = 24 * 3600 * 1000;

/** Read and delete the replay file. Bad entries are dropped. Max 5 items. */
export function takeReplays(file: string): ReplayItem[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { raw = []; }
  rmSync(file, { force: true });
  if (!Array.isArray(raw)) return [];
  const out: ReplayItem[] = [];
  for (const r of raw as unknown[]) {
    if (!r || typeof r !== "object") continue;
    const { channelId, messageId } = r as { channelId?: unknown; messageId?: unknown };
    if (typeof channelId === "string" && /^\d{17,20}$/.test(channelId) && typeof messageId === "string" && /^\d{17,20}$/.test(messageId)) out.push({ channelId, messageId });
  }
  return out.slice(0, 5);
}

/** A fetched message may be replayed only when the owner wrote it recently. */
export function replayAllowed(m: { authorId: string; createdMs: number }, ownerId: string, now = Date.now()): boolean {
  return m.authorId === ownerId && now - m.createdMs >= 0 && now - m.createdMs <= REPLAY_MAX_AGE_MS;
}
