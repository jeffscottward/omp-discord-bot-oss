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
import { readReceipts } from "./masterqueue.ts";

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
  /** ms of the last owner answer (fm field queued). */
  queued?: number;
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
export function matchCards(items: Card[], refs: ResponseRefs, blockedAt: Map<string, number> = new Map()): string[] {
  if (!refs.messageIds.length && !refs.itemIds.length) return [];
  const msgs = new Set(refs.messageIds);
  const named = new Set(refs.itemIds);
  const out: string[] = [];
  for (const c of items) {
    if (!c.id || !(OWNER_STATES[c.s ?? ""] || c.s === "partial") || c.until || c.id.startsWith("gate-")) continue;
    const q = messageIdOf(c.q);
    // Card answered-menu-clears-block (owner 2026-11-05): a card a worker set partial with a blocked receipt keeps its
    // owner question in q; an answer to that exact menu also matches it. Only while the blocked receipt is newer than
    // the last owner answer (`queued`): a partial card in progress, or one already answered, is never re-queued.
    if (c.s === "partial") {
      if (q && msgs.has(q) && !c.until && !c.id.startsWith("gate-") && isBlocked(c, blockedAt)) out.push(c.id);
      continue;
    }
    const src = messageIdOf(c.src);
    if (named.has(c.id) || (q && msgs.has(q)) || (src && msgs.has(src))) out.push(c.id);
  }
  return out;
}

function isBlocked(c: Card, blockedAt: Map<string, number>): boolean {
  const at = blockedAt.get(c.id ?? "") ?? 0;
  return at > 0 && at > (c.queued ?? 0);
}

/** Card id -> tsMs of its newest receipt when that receipt is "blocked" (receipts/<file>.json). */
export function blockedReceipts(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, r] of readReceipts(dir)) {
    const at = Number(r.tsMs);
    if (r.result === "blocked" && at > 0) out.set(id, at);
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
  /** Expand menu ids to their answer text ids: only when the whole set is answered (a partial answer must not queue sibling cards). */
  expand?: boolean;
  /** The owner asked back (noreask-clarify): a card blocked on the menu keeps q and its ⛔ row. */
  askedBack?: boolean;
  /** receipts/ dir (blocked cards); default FM_DIR/receipts. */
  receipts?: string;
  /** Short answer text per menu message id; a matched card with that q gets "📨 answered: <answer>" and its q cleared. */
  answers?: Map<string, string>;
}

/** Note for a card whose q menu was answered: the short answer, cut at 120 chars. */
export function answeredNote(ms: number, answer: string): string {
  const a = answer.replace(/\s+/g, " ").trim();
  return a ? `📨 answered ${hhmm(ms)}: ${a.length > 120 ? `${a.slice(0, 119)}…` : a}` : queuedNote(ms);
}

/** Owner 2026-10-31 (card needs-you-route-answered): extra message ids for a response (menu ids -> answer text ids). */
let refExpander: (ids: string[]) => string[] = () => [];
export function setRefExpander(fn: (ids: string[]) => string[]): void {
  refExpander = fn;
}
/** Card answered-menu-clears-block: default answer texts (asks.json) for calls that pass no `answers`. */
let answerSource: () => Map<string, string> = () => new Map();
export function setAnswerSource(fn: () => Map<string, string>): void {
  answerSource = fn;
}

/** Mark every matching card as queued. Never throws; returns the ids marked. */
export async function markQueued(refs: ResponseRefs, o: MarkOptions = {}): Promise<string[]> {
  const log = o.log ?? (() => {});
  if (!refs.messageIds.length && !refs.itemIds.length) return [];
  if (o.expand) try {
    refs = { ...refs, messageIds: [...new Set([...refs.messageIds, ...refExpander(refs.messageIds)])] };
  } catch (e) {
    log(`queued: expand failed: ${errText(e)}`);
  }
  let items: Card[];
  try {
    items = parseCards(readFileSync(o.file ?? ITEMS_FILE, "utf8"));
  } catch (e) {
    log(`queued: cannot read the tracker: ${errText(e)}`);
    return [];
  }
  const ids = matchCards(items, refs, o.askedBack ? new Map() : blockedReceipts(o.receipts ?? join(FM_DIR, "receipts")));
  if (!ids.length) return [];
  let answers = o.answers;
  if (!answers) try { answers = answerSource(); } catch { answers = new Map(); }
  const now = o.now ?? Date.now();
  // An owner response is not an fm-autoclear change, so FM_AUTO is dropped.
  const { FM_AUTO: _auto, ...base } = process.env;
  const env = { ...base, FM_BY: QUEUED_BY };
  const fm = o.fm ?? FM_BIN;
  const done: string[] = [];
  const byId = new Map(items.map((c) => [c.id, c]));
  for (const id of ids) {
    const qMid = messageIdOf(byId.get(id)?.q);
    const answered = byId.get(id)?.s === "partial" && qMid !== undefined && refs.messageIds.includes(qMid);
    try {
      await run(fm, ["field", id, "queued", String(now)], { env, timeout: 10_000 });
      await run(fm, ["set", id, "partial", answered && answers.has(qMid!) ? answeredNote(now, answers.get(qMid!)!) : queuedNote(now)], { env, timeout: 10_000 });
      // The answered menu is no longer an open question: q goes, so no board links it (src keeps the history).
      if (answered) await run(fm, ["q", id, "-"], { env, timeout: 10_000 });
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
      ? [{ id: "id" in x ? str(x.id) : undefined, s: "s" in x ? str(x.s) : undefined, q: "q" in x ? str(x.q) : undefined, src: "src" in x ? str(x.src) : undefined, until: "until" in x ? str(x.until) : undefined, ...("queued" in x && Number(x.queued) > 0 ? { queued: Number(x.queued) } : {}) }]
      : [],
  );
}

/** stderr of a failed execFile (fm prints its refusal there), else the error message. */
function errText(e: unknown): string {
  if (e && typeof e === "object" && "stderr" in e && typeof e.stderr === "string" && e.stderr.trim()) return e.stderr.trim();
  return e instanceof Error ? e.message : String(e);
}

/**
 * Card answered-menu-clears-block (owner 2026-11-05): menu message ids of partial cards whose q menu is already
 * answered (the one-time repair at bot start; markQueued then applies the answer like a live one).
 */
export function answeredBlockedRefs(items: Card[], answers: Map<string, string>, blockedAt: Map<string, number>): string[] {
  const out: string[] = [];
  for (const c of items) {
    const q = messageIdOf(c.q);
    if (c.id && c.s === "partial" && q && answers.has(q) && isBlocked(c, blockedAt)) out.push(q);
  }
  return out;
}
