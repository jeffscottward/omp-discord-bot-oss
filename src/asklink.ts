/**
 * Owner 2026-11-04 (card fm-asks-in-job-channels,
 * https://discord.com/channels/100000000000000054/100000000000000051/100000000000000055):
 * "Any questions have to be pushed over to those channels directly; FIRSTMATE gets a notification with a link,
 * very terse. Never print the whole question and its context in FIRSTMATE."
 *
 * - A job's /post with an ask block aimed at FIRSTMATE goes to the job's own channel (its pane's mirrored channel,
 *   the card's job channel, else the card's stack thread). FIRSTMATE's own asks (no pane/card) stay in FIRSTMATE.
 * - Every menu posted in a job channel or stack thread sends ONE silent line to FIRSTMATE with the menu link.
 */
import { channelMention } from "./mention.ts";
import type { StackCard } from "./stackcats.ts";

/**
 * Where a job's ask block goes instead of FIRSTMATE, or null (keep the caller's target). Pure.
 * `byJob` is the mirror's main-only job lookup (mirror.byJob): Herdr pane ids repeat per machine, so a Second caller's
 * pane is never looked up (its menu would land in a main job's channel and the answer would reach the wrong job).
 */
export function jobAskChannel(
  who: { pane?: string; card?: string; machine?: "main" | "second" },
  d: { byJob: (token: string) => string | undefined; cards: StackCard[]; threads: Record<string, string>; firstmateId: string },
): string | null {
  const hit = (token: string) => {
    const id = d.byJob(token);
    return id && id !== d.firstmateId ? id : null;
  };
  if (who.pane) {
    // A named pane that is a Second pane or has no channel yet stays in FIRSTMATE (FIRSTMATE relays as before): the card
    // fallbacks below would put the menu in another session (a main job or the stack's own session), and the answer
    // would not reach the job that asked.
    return who.machine === "second" ? null : hit(who.pane);
  }
  if (!who.card) return null;
  const card = d.cards.find((c) => c.id === who.card);
  if (!card) return null;
  // Card jobs are main panes (fm-spawn). fm stores `job` as one token, a comma list or an array: the first token that
  // resolves wins.
  const tokens = (Array.isArray(card.job) ? card.job : typeof card.job === "string" ? card.job.split(",") : [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of tokens) {
    const job = hit(t);
    if (job) return job;
  }
  const t = typeof card.stack === "string" ? d.threads[card.stack] : undefined;
  return t && t !== d.firstmateId ? t : null;
}

/**
 * True when a menu in this channel needs the one-line FIRSTMATE link: a stack thread, or a mirrored job channel (or a
 * thread in one). Never FIRSTMATE or its other threads, DMs, configured channels, or detached coordinator channels
 * (local-omp, Venice, uncensored, unrestricted). Pure.
 */
export function needsAskLink(o: { channelId: string; firstmateId: string; dm: boolean; detached: boolean; stackThread: boolean; mirrorChannelId: string | undefined }): boolean {
  if (!o.firstmateId || o.channelId === o.firstmateId || o.dm || o.detached) return false;
  return o.stackThread || (!!o.mirrorChannelId && o.mirrorChannelId !== o.firstmateId);
}

/** "❓ Open question in <#channel>: <title ≤ 60 chars> → <link>". No options, no context. Pure. */
export function askLinkLine(channelId: string, question: string, url: string): string {
  const flat = question.replace(/[*_`~|>]/g, "").replace(/\s+/g, " ").trim();
  const title = flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
  return `❓ Open question in ${channelMention(channelId)}: ${title || "question"} → ${url}`;
}

/**
 * Card delete-answered-pointers (owner 2026-11-05,
 * https://discord.com/channels/100000000000000054/100000000000000051/100000000000000056): "Whenever we answer a
 * question, we should delete the open question message that points to it."
 * The menu message ids a bot pointer message links to, or null when `content` is not a pointer. Pure.
 */
export function pointerTargets(content: string): string[] | null {
  const t = content.trimStart();
  if (!t.startsWith("❓ Open question in") && !t.startsWith("⏳ Still waiting:")) return null;
  const ids = [...t.matchAll(/discord\.com\/channels\/\d+\/\d+\/(\d+)/g)].map((m) => m[1]!);
  return ids.length ? [...new Set(ids)] : null;
}

/** True when every menu the pointer links to is stale (answered, closed, or no longer known). Pure. */
export function pointerIsStale(targets: string[], staleFor: (menuMessageId: string) => boolean): boolean {
  return targets.length > 0 && targets.every(staleFor);
}
