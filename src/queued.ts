/**
 * "📨 Queued" state for owner responses (owner 2026-10-18).
 * Goal: the owner never double-submits. When the owner responds to a Needs-you / Open card, the bot marks the card
 * before the agent run starts, so the dashboard shows "📨 Queued: you responded <time>; working on it".
 *
 * A response matches a card (state waiting/open/blocked) when:
 * - a message id the owner responded to (menu pick, reply-to, a Discord message link in the owner's text) equals
 *   the message id in the card's `q` or `src` link, or
 * - the owner's own text names the card as `⚓ item:<id>` or as a dashboard `?item=<id>` link.
 * Bot-written text (the replied-to bot message, ask question text) is never scanned: its "Still waiting" links
 * and item tokens name cards the owner did not answer.
 * Time gates (`until`, `gate-*` ids) are never matched.
 *
 * Order of the two fm writes: `fm field <id> queued <epoch ms>` first, then `fm set <id> partial "📨 Queued: …"`.
 * fm refuses fm-autoclear writes that move a card with `queued` back to waiting/open/blocked, so the field first
 * also covers an fm-autoclear run that read the card before this change. `fm set … partial` records `queuedFrom`.
 * Any later set to another state (running, done, a new question) removes both fields, so the badge ends there.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FM_DIR } from "./config.ts";

const run = promisify(execFile);

export const ITEMS_FILE = process.env.OMP_FM_ITEMS ?? join(FM_DIR, "items.json");
export const FM_BIN = process.env.OMP_FM_BIN ?? join(homedir(), ".local/bin/fm");
/** `by` on the card (fm FM_BY): the owner's own response, received by the Discord bot. */
export const QUEUED_BY = "owner:discord";
const OWNER_STATES: Record<string, true> = { waiting: true, open: true, blocked: true };

export interface Card {
  id?: string;
  s?: string;
  q?: string;
  src?: string;
  until?: string;
}

export interface ResponseRefs {
  messageIds: string[];
  itemIds: string[];
}

const ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
const MSG_IN_LINK = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d{5,25})/g;
const ITEM_TOKEN = new RegExp(`⚓\\s*item:\\s*\`?(${ID})`, "gu");
const ITEM_LINK = new RegExp(`/reports/firstmate/?\\?(?:[^\\s<>)\\]#]*&)?item=(${ID})`, "g");

/** Message id at the end of a Discord message link; undefined for a channel link or any other URL. */
export function messageIdOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/\d+\/(\d{5,25})(?:[/?#]|$)/.exec(url);
  return m?.[1];
}

/** Message ids and card ids that one owner response refers to. `texts`: owner text and the replied-to bot text. */
export function responseRefs(messageIds: (string | null | undefined)[], texts: (string | null | undefined)[]): ResponseRefs {
  const ids = new Set(messageIds.filter((x): x is string => typeof x === "string" && /^\d{5,25}$/.test(x)));
  const items = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(MSG_IN_LINK)) ids.add(m[1]!);
    for (const re of [ITEM_TOKEN, ITEM_LINK]) for (const m of t.matchAll(re)) items.add(m[1]!.replace(/[._-]+$/, ""));
  }
  return { messageIds: [...ids], itemIds: [...items] };
}

/** Ids of the owner-facing cards the response refers to (no time gates, no other states). */
export function matchCards(items: Card[], refs: ResponseRefs): string[] {
  if (!refs.messageIds.length && !refs.itemIds.length) return [];
  const msgs = new Set(refs.messageIds);
  const named = new Set(refs.itemIds);
  const out: string[] = [];
  for (const c of items) {
    if (!c.id || !OWNER_STATES[c.s ?? ""] || c.until || c.id.startsWith("gate-")) continue;
    const q = messageIdOf(c.q);
    const src = messageIdOf(c.src);
    if (named.has(c.id) || (q && msgs.has(q)) || (src && msgs.has(src))) out.push(c.id);
  }
  return out;
}

/** Main-local HH:MM (the bot runs with the owner's time zone). */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Owner 2026-10-25 (card answered-clears-needs): the card leaves Needs you at once, worded "answered; working". */
export const queuedNote = (ms: number) => `📨 answered ${hhmm(ms)}; working`;

export interface MarkOptions {
  now?: number;
  file?: string;
  fm?: string;
  log?: (s: string) => void;
}

/** Mark every matching card as queued. Never throws; returns the ids marked. */
export async function markQueued(refs: ResponseRefs, o: MarkOptions = {}): Promise<string[]> {
  const log = o.log ?? (() => {});
  if (!refs.messageIds.length && !refs.itemIds.length) return [];
  let items: Card[];
  try {
    items = parseCards(readFileSync(o.file ?? ITEMS_FILE, "utf8"));
  } catch (e) {
    log(`queued: cannot read the tracker: ${errText(e)}`);
    return [];
  }
  const ids = matchCards(items, refs);
  if (!ids.length) return [];
  const now = o.now ?? Date.now();
  // An owner response is not an fm-autoclear change, so FM_AUTO is dropped.
  const { FM_AUTO: _auto, ...base } = process.env;
  const env = { ...base, FM_BY: QUEUED_BY };
  const fm = o.fm ?? FM_BIN;
  const done: string[] = [];
  for (const id of ids) {
    try {
      await run(fm, ["field", id, "queued", String(now)], { env, timeout: 10_000 });
      await run(fm, ["set", id, "partial", queuedNote(now)], { env, timeout: 10_000 });
      done.push(id);
    } catch (e) {
      log(`queued: fm failed for ${id}: ${errText(e).slice(0, 200)}`);
    }
  }
  if (done.length) log(`queued: owner responded; marked ${done.join(", ")}`);
  return done;
}

/** Cards from items.json text; entries that are not objects are skipped, string fields only. */
export function parseCards(text: string): Card[] {
  const raw: unknown = JSON.parse(text);
  const list: unknown[] = raw && typeof raw === "object" && "items" in raw && Array.isArray(raw.items) ? raw.items : [];
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return list.flatMap((x) =>
    x && typeof x === "object"
      ? [{ id: "id" in x ? str(x.id) : undefined, s: "s" in x ? str(x.s) : undefined, q: "q" in x ? str(x.q) : undefined, src: "src" in x ? str(x.src) : undefined, until: "until" in x ? str(x.until) : undefined }]
      : [],
  );
}

/** stderr of a failed execFile (fm prints its refusal there), else the error message. */
function errText(e: unknown): string {
  if (e && typeof e === "object" && "stderr" in e && typeof e.stderr === "string" && e.stderr.trim()) return e.stderr.trim();
  return e instanceof Error ? e.message : String(e);
}
