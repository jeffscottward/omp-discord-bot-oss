// Card sweep (owner 2026-10-22: "do a sweep on the cards as well, not just the channels. Each time you do
// the sweep on the channels"). Runs inside scripts/channel-cleanup.ts after the channel step.
// 1. Discord question cards: a bot menu message (custom_id `ask:<set>:…`) whose set is no longer open in the
//    bot's asks.json is closed (buttons removed, one closing line) when it is older than the ask TTL or a
//    newer menu in the same channel asks the same question. Open sets are never touched (the bot owns them).
// 2. Dashboard cards: an unfinished, non-finance card whose q/src links a channel that is archived or gone,
//    or whose q menu was closed in step 1, is set to partial "🧹 … needs check" once; the in-progress sweep
//    (firstmate-sweep) then finishes, restarts or asks about it. Nothing is deleted.

export interface MenuMsg { id: string; ts: number; setId: string; question: string }
export interface Card { id: string; s?: string; t?: string; area?: string; n?: string; q?: string; src?: string }
export type ChannelState = "live" | "archived" | "gone";

export const CLOSED_LINE = "⌛ Closed by the card sweep (already answered, asked again later, or expired).";
const SKIP_WORDS = /\b(account|order|trade|finance)\b/i; // same finance guard as fm-autoclear
const SWEEP_STATES: Record<string, true> = { open: true, waiting: true, partial: true, blocked: true };

/** The question of a posted menu message (same parsing as ask.ts recoverAnswer), lowercased for comparison. */
export function menuQuestion(content: string): string {
  const q = content.split("\n").map((l) => l.trim().replace(/^❓/, "").replace(/\*\*Question \d+ of \d+\*\*/, "").trim()).find(Boolean) ?? "";
  return q.replace(/[*_`]/g, "").toLowerCase();
}

/** Set id from a menu custom_id (`ask:<set>:<q>[:<opt>]`), else null. */
export function askSetId(customId: string): string | null {
  return customId.match(/^ask:([a-z0-9]+):/)?.[1] ?? null;
}

/** Menu message ids to close. `msgs` may be in any order. */
export function staleMenus(msgs: MenuMsg[], openSets: Set<string>, now: number, ttlMs: number): string[] {
  const sorted = [...msgs].sort((a, b) => a.ts - b.ts);
  return sorted
    .filter((m, i) => !openSets.has(m.setId) && (now - m.ts > ttlMs || (!!m.question && sorted.slice(i + 1).some((n) => n.setId !== m.setId && n.question === m.question))))
    .map((m) => m.id);
}

/**
 * Owner 2026-10-23 (Discord UX item 3): open sets now live 7 days, so a menu asked again later can still be
 * open in the bot. These menus are closed through the bot (POST /asks/close) before the sweep edits them.
 */
export function askedAgainOpen(msgs: MenuMsg[], openSets: Set<string>): MenuMsg[] {
  const sorted = [...msgs].sort((a, b) => a.ts - b.ts);
  return sorted.filter((m, i) => openSets.has(m.setId) && !!m.question && sorted.slice(i + 1).some((n) => n.setId !== m.setId && n.question === m.question));
}

/** Channel and message ids linked by a Discord URL. */
export function discordLink(url: string | undefined): { channel: string; message?: string } | null {
  const m = url?.match(/discord\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?/);
  return m?.[1] ? { channel: m[1], message: m[2] } : null;
}

/** Cards to flag, with the reason. Finance cards and finished/parked/running cards are never touched. */
export function staleCards(cards: Card[], channelState: (id: string) => ChannelState, closedMenus: Set<string>): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const c of cards) {
    if (!SWEEP_STATES[c.s ?? ""] || c.area === "finance" || SKIP_WORDS.test(c.t ?? "")) continue;
    if (c.n?.startsWith("🧹")) continue; // already flagged once
    const q = discordLink(c.q);
    const src = discordLink(c.src);
    const chans = [q?.channel, src?.channel].filter((x): x is string => !!x);
    const gone = chans.find((ch) => channelState(ch) !== "live");
    if (gone) out.push({ id: c.id, reason: `its Discord channel is ${channelState(gone)}` });
    else if (q?.message && closedMenus.has(q.message) && (c.s === "waiting" || c.s === "open")) out.push({ id: c.id, reason: "its question menu was closed" });
  }
  return out;
}
