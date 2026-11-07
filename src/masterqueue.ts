import { safeSubject } from "./router.ts";
import { WORKING_EMOJI } from "./config.ts";
/**
 * 📋 Master queue (owner 2026-10-23, "where is my master queue report"): one live board in the FIRSTMATE
 * channel that lists EVERY job: bot runs in any channel (src/queue.ts) plus FIRSTMATE cards that carry a
 * `job` field (Herdr side sessions, units) and their worker receipts.
 *
 * Each row: title + link to its message, where it runs (channel/thread, or the card's job tab/unit), state
 * (⏳ queued / ⚙️ running / ✅ finished / ❌ failed / 🛑 stopped) and the finish time. Finished jobs stay
 * visible for 12 h (bot jobs are saved in a small state file, so a restart keeps them).
 *
 * The board is never edited: each change is a new silent post (old one deleted), kept at the bottom of the channel; only the bridge's own ⏳ Queue box
 * may sit below it (both boards are "last" boxes; this one never reprints for the Queue box).
 */
import { channelMention, safeTitle } from "./mention.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { actionBlock, actionSteps, isFinanceCard, itemLink, linkLabel, loadOpenMenus, answeredMenuIds, needsYouEntries, type BoardChannel, type BoardMsg, type FmItem, type MenuRow, type MenuSource } from "./needsyou.ts";
import { edges, openRefs, parkedRefs } from "./blockers.ts";
import { fixMaskedLinks } from "./maskedlinks.ts";
import { blockerLines, DrainCheck, findBlockers, fmSpawnDryRun, ghGlRunFetch, mainBlockers, OVERSEER_STALE_MS, readCaps, readCiCache, readCiWaits, readSpawnQueue, receiptRuns, RunStatus, writeBlockersFile, type BlockerFiles } from "./mainblocker.ts";
import type { FinalJobState, JobState } from "./jobstate.ts";

export const MASTER_HEAD = "📋 **Master queue**";
export const isMasterBoard = (text: string): boolean => text.startsWith(MASTER_HEAD) || text.startsWith("\u2063") || text.startsWith(`━━━━━━━━━━━━━━━━━━━━\n${MASTER_HEAD}`);
export const KEEP_FINISHED_MS = 12 * 3_600_000; // owner 2026-10-24: finished jobs older than 12 h are not listed

export type RowState = JobState | "blocked" | "check" | "bot" | "needs";
export type Row = {
  key: string;
  /** Needs-you rows: the owner's action steps (owner 2026-10-25, needs-you-action-gate). */
  steps?: string[];
  /** Needs-you root rows: how many cards this owner step unblocks. */
  unblocks?: number;
  title: string;
  link?: string;
  /** Where it runs: `<#channel>` for bot jobs, the job tab/unit for cards. */
  where: string;
  state: RowState;
  /** Queued/running: since when. Finished: finish time. */
  at: number;
  /** Stack name from the FIRSTMATE router, when routed. */
  stack?: string;
  /** Discord thread/channel of that stack (shown as a channel link). */
  stackChannel?: string;
  /** Blocked/check rows: link to the worker receipt with the full reason (card mq-blocked-reason-full). */
  why?: string;
  /** Blocked rows waiting on an owner question: the open menu message (card q), linked directly (owner 2026-11-05). */
  question?: string;
  /** Blocked rows: one "why" emoji + ≤4-word reason chip, linked to the blocker (owner 2026-11-07, card mq-blocked-compact). */
  chip?: string;
};

/** Where a card's job runs, in plain words (owner 2026-10-23: no raw Herdr ids like "wB:pMC"). */
export type JobPlace = {
  channelId?: string;
  tab?: string;
  /** Herdr answered and the id does not exist: the only case that may say "closed tab" (owner 2026-10-24). */
  gone?: boolean;
  /** Stable session key (Herdr pane id when known), so two cards on one pane show it once. */
  session?: string;
};
export type HerdrPane = { pane_id: string; tab_id: string };
export type HerdrTab = { tab_id: string; label?: string; pane_count?: number };
/** `herdr <pane|tab> list` stdout -> its array, or null when the output is not that shape. */
function herdrList(stdout: string, key: "panes" | "tabs"): Record<string, unknown>[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !("result" in v) || !v.result || typeof v.result !== "object" || !(key in v.result)) return null;
  const list: unknown = new Map(Object.entries(v.result)).get(key);
  return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : null;
}
export function parseHerdrPanes(stdout: string): HerdrPane[] | null {
  const l = herdrList(stdout, "panes");
  return l && l.flatMap((p) => (typeof p.pane_id === "string" && typeof p.tab_id === "string" ? [{ pane_id: p.pane_id, tab_id: p.tab_id }] : []));
}
export function parseHerdrTabs(stdout: string): HerdrTab[] | null {
  const l = herdrList(stdout, "tabs");
  return l && l.flatMap((t) => (typeof t.tab_id === "string" ? [{ tab_id: t.tab_id, ...(typeof t.label === "string" ? { label: t.label } : {}) }] : []));
}
/**
 * Live Herdr lookup for a card `job` (pane id, tab id or tab label). Returns the tab label and session key,
 * `{ gone: true }` when the snapshot has no such pane/tab, or undefined when the value is not a Herdr reference.
 */
export function herdrPlace(job: string, panes: HerdrPane[], tabs: HerdrTab[]): JobPlace | undefined {
  const tabById = new Map(tabs.map((t) => [t.tab_id, t]));
  const onlyPane = (t: HerdrTab) => {
    const ps = panes.filter((p) => p.tab_id === t.tab_id);
    return ps.length === 1 ? ps[0]!.pane_id : t.tab_id;
  };
  if (HERDR_ID.test(job)) {
    const pane = panes.find((p) => p.pane_id === job);
    const tab = tabById.get(pane ? pane.tab_id : job);
    if (!tab) return { gone: true };
    return { ...(tab.label ? { tab: tab.label } : {}), session: pane ? pane.pane_id : onlyPane(tab) };
  }
  const byLabel = tabs.find((t) => t.label === job);
  return byLabel ? { tab: byLabel.label, session: onlyPane(byLabel) } : undefined;
}
export type Resolvers = {
  job?: (job: string) => JobPlace | undefined;
  /** `live`: the row is running/queued/blocked (card stack-coverage: only those may reopen a stack thread). */
  stackChannel?: (stack: string, live?: boolean) => string | undefined;
  /** Owner 2026-10-24: stack of a card area (router areas), for cards without a `stack` field. */
  areaStack?: (area: string) => string | undefined;
};
/** Stack for a card's terminal job: its `stack` field, else its area's stack, else "firstmate" (owner 2026-10-24). */
export function cardStack(c: Pick<FmCard, "stack" | "area">, res?: Resolvers): string {
  return c.stack || res?.areaStack?.(c.area ?? "") || "firstmate";
}
const HERDR_ID = /^w[A-Za-z0-9]+:[pt][A-Za-z0-9]+$/;

/** Plain-English place for a card's `job` field: its Discord channel, else its terminal tab name, else the unit. */
export function jobPlace(raw: string | string[], r?: Resolvers): string {
  // `fm field <id> job a,b` stores a list: show the first place (live board crash 2026-10-23: job.startsWith on an array).
  const job = String(Array.isArray(raw) ? (raw[0] ?? "") : raw).trim();
  if (!job) return "💻 no job recorded";
  const p = r?.job?.(job);
  if (p?.channelId) return channelMention(p.channelId, p.tab ? `💻 ${p.tab}` : "💬 a closed channel");
  // Owner 2026-10-24 ("we should never have an unknown"): a terminal job always names its Herdr tab.
  if (p?.tab) return `💻 ${p.tab}`;
  if (HERDR_ID.test(job)) return p?.gone ? "💻 closed tab" : p?.session ? "💻 terminal tab" : "💻 terminal tab (Herdr not reachable)"; // "closed" only when Herdr confirms it
  if (/\.(timer|service)$/.test(job)) return `background service ${job.replace(/\.(timer|service)$/, "")}`;
  if (job.startsWith("remote:")) return `remote host service ${job.slice("remote:".length)}`;
  return `💻 ${job}`;
}

/** A live bot job (src/queue.ts view plus the bridge's own maps). `state`: queued or running (src/jobstate.ts). */
export type LiveJob = { id: number; title: string; channelId: string; link?: string; state: JobState; since: number; stack?: string };
/** A finished bot job, saved for 12 h. */
export type DoneJob = { id: number; title: string; channelId: string; link?: string; state: FinalJobState; at: number; stack?: string };

export type FmCard = { id: string; action?: string; t?: string; area?: string; s?: string; q?: string; src?: string; job?: string | string[]; cts?: number | string; stack?: string; blockedBy?: string | string[]; blocks?: string | string[]; ext?: string; until?: string; queued?: unknown };
export type Receipt = { card?: string; result?: string; tsMs?: number | string; summary?: string; /** File name under receipts/ (set by readReceipts). */ file?: string };

/** A receipt summary on one board line: links become 🔗 (the board cuts long lines), whitespace collapses. */
/** First http(s) URL in a receipt summary (the PR/MR/run a keyword chip links to; card mq-blocked-compact). */
export function firstUrl(summary: unknown): string | undefined {
  return /https?:\/\/[^\s,;)>]+/.exec(String(summary ?? ""))?.[0];
}

function receiptReason(summary: unknown): string {
  return String(summary ?? "").replace(/<?https?:\/\/[^\s,;)>]+>?/g, "🔗").replace(/\s+/g, " ").trim() || "blocked";
}

/** First sentence of a reason: up to the first ". ", "! " or "? " (a dot inside "1.3" or "a.b" does not end it). */
export function firstSentence(s: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(s.trim());
  return (m ? m[0].replace(/\.$/, "") : s).trim();
}

/** Text cut to max chars at a word boundary, with "…" (card mq-blocked-reason-full: no cut-off words). */
export function cutWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const sp = head.lastIndexOf(" ");
  return `${(sp > max / 2 ? head.slice(0, sp) : head).replace(/[\s,;:(]+$/, "")}…`;
}

const DISCORD_MSG = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

/** Placeholder for the animated gear in row text built before render (the gear emoji is passed to rowLine). */
export const GEAR_TOKEN = "\u2060GEAR\u2060";
/** Blocker state icons on Blocked rows (owner 2026-11-07); running uses the animated gear. */
const CARD_STATE_ICON: Record<string, string> = { partial: "🔧", planned: "📋", backlog: "💤", waiting: "⏳", open: "❓", blocked: "⛔", done: "✅" };
export function cardLink(c: FmCard, dash: string): string | undefined {
  if (c.src && DISCORD_MSG.test(c.src)) return c.src;
  if (c.q && DISCORD_MSG.test(c.q)) return c.q;
  return dash ? `${dash}?item=${encodeURIComponent(c.id)}` : undefined;
}

/** Dashboard 🧾 Why panel for a card's receipt file (deeplink-contract.md: ?item=<id>&why=1&receipt=<file>). */
export function whyLink(dash: string, id: string, file: string): string {
  return `${dash}?item=${encodeURIComponent(id)}&why=1&receipt=${encodeURIComponent(file)}`;
}

/** Cards as the Needs-you code reads them (numeric cts, one job string); other fields stay as they are. */
export function asItems(cards: FmCard[]): FmItem[] {
  return cards.map((c) => ({ ...c, cts: num(c.cts) || undefined, job: Array.isArray(c.job) ? c.job[0] : c.job }));
}

const NEEDS_WHERE = { waiting: "your action", open: "your answer to a question", blocked: "your step" } as const;

/**
 * Owner 2026-10-24: ✍️ Needs you on the board (owner 2026-11-03: at the bottom). Card mq-needs-menus: the SAME items as the 🔔 Needs-you board
 * (src/needsyou.ts needsYouEntries): open question menus plus waiting/open/blocked-on-you cards. A card whose q is a
 * menu shows once. The "Waiting on bots / Blocker unclear" summaries stay off this board.
 */
export function needsRows(cards: FmCard[], now: number, dash: string, menus: MenuRow[] = []): Row[] {
  return needsYouEntries(asItems(cards), menus).map((e): Row => {
    if (e.kind === "menu") return { key: `menu:${e.menu.key}`, title: e.menu.label, link: e.menu.link, where: "your pick in a question menu", steps: [], state: "needs", at: e.menu.createdAt };
    const c = e.item;
    const finance = isFinanceCard(c);
    const title = finance ? safeSubject(c.t, c.id) : (c.t ?? c.id);
    const where = e.unblocks ? `${NEEDS_WHERE[e.group]} (unblocks ${e.unblocks} card${e.unblocks === 1 ? "" : "s"})` : NEEDS_WHERE[e.group];
    const steps = finance ? ["Open the card and do the step it names."] : actionSteps(c.action ?? "");
    return { key: `need:${c.id}`, title, link: itemLink(c, dash) || undefined, where, steps, ...(e.unblocks ? { unblocks: e.unblocks } : {}), state: "needs", at: c.cts || now };
  });
}

/**
 * Card rows: cards with a `job` field. Running/queued now, or finished (card done / receipt) in the last 12 h.
 * Owner 2026-11-01 (card fm-job-cap-ci-wait): a blocked receipt unlinks the job (fm-autoclear R11); the card still gets
 * a ⛔ row for 12 h, and its place line shows the worker's reason ("waiting on CI: PR #N ...").
 * Card mq-blocked-reason-full: the reason is its first sentence (≤ 100 chars, cut at a word) plus a "why" link to the
 * worker receipt (full text). A card blocked by other cards (blockedBy) shows "waits for <title> (<state>)";
 * when every blocker card is done, the row is 🔧 "blocker done; needs a check" (fm-autoclear R15 flags the card too).
 */
/**
 * Card answered-menu-clears-block (owner 2026-11-05): `answered` = menu message ids the owner already answered
 * (needsyou.ts answeredMenuIds). A blocked card whose question is answered, or that the owner answered after the
 * blocked receipt (`queued` newer than the receipt), is a 🔧 "📨 answered; needs pickup" row without a question link.
 */
export function cardRows(cards: FmCard[], receipts: Map<string, Receipt>, now: number, dash: string, res?: Resolvers, answered: Map<string, string> = new Map()): Row[] {
  const rows: Row[] = [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  // Blockers resolve like the dashboard and fm-audit (src/blockers.ts): id or title, reverse `blocks` edges, a
  // passed time gate counts as cleared.
  const items = asItems(cards);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const blockEdges = edges(items);
  // Owner 2026-10-24 ("are these not the same thing?"): cards that share one job session show it once.
  const sessionOwner = new Map<string, string>();
  for (const c of cards) {
    if (!c.id) continue;
    const r = receipts.get(c.id);
    const rAt = num(r?.tsMs);
    // partial only: fm-spawn's queue sets a re-queued card to planned, and an old reason must not show there.
    const blocked = c.s === "partial" && r?.result === "blocked" && now - rAt < KEEP_FINISHED_MS;
    if (!c.job && !blocked) continue;
    const job = c.job ?? "";
    const finance = isFinanceCard(c);
    // Finance cards: subject, or the id when the title carries money, sizes or account data (owner 2026-10-30).
    const title = finance ? safeSubject(c.t, c.id) : (c.t ?? c.id);
    const first0 = String(Array.isArray(job) ? (job[0] ?? "") : job).trim();
    const place = res?.job?.(first0);
    const session = place?.session; // only live Herdr sessions are grouped
    // Only cards that get a job row may own or share a session (blocked/waiting cards are not listed here).
    const listed = c.s === "running" || c.s === "partial" || c.s === "planned";
    // Owner 2026-11-02: rows that share a session show the same place link as the first row, not "same session as …".
    const sharedWith = session && listed ? sessionOwner.get(session) : undefined;
    if (session && listed && !sharedWith) sessionOwner.set(session, jobPlace(job, res));
    const blockers = blockEdges.get(c.id) ?? [];
    const open = openRefs(itemById.get(c.id) ?? { id: c.id }, itemById, now, blockEdges);
    // Card mainblocker-backlog (owner 2026-11-05): a parked (backlog, not a gate) blocker holds nothing; the row only
    // names it ("🗃️ parked: <id>") and never says "blocker done".
    const parkedIds = parkedRefs(itemById.get(c.id) ?? { id: c.id }, itemById, blockEdges);
    const qUrl = c.q ?? "";
    const qMid = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/(\d+)$/.exec(qUrl)?.[1];
    const pickup = blocked && ((qMid !== undefined && answered.has(qMid)) || num(c.queued) > rAt);
    const cleared = blocked && (pickup || (blockers.length > 0 && !open.length && !parkedIds.length));
    const waitsFor = open.slice(0, 2).map((id) => {
      const b = byId.get(id);
      const t = !b ? id : isFinanceCard(b) ? safeSubject(b.t, b.id) : linkLabel(safeTitle(b.t ?? b.id, b.id, b.id)); // no markdown or pings from titles
      // Owner 2026-11-07: the blocker title is the link (same link as its Running row); its state is an icon, not "(running)".
      const icon = b?.s === "running" ? GEAR_TOKEN : (CARD_STATE_ICON[b?.s ?? ""] ?? "❔");
      const link = b ? cardLink(b, dash) : undefined;
      const label = cutWords(t, 40);
      return `${icon} ${link ? `[${label}](<${link}>)` : label}`;
    });
    const reason = firstSentence(receiptReason(r?.summary));
    const where = !blocked
      ? (sharedWith ?? jobPlace(job, res))
      : pickup
        ? "📨 answered; needs pickup"
        : cleared
          ? "Needs check 🔍"
          : open.length
            ? `⛔ ${waitsFor.join(", ")}${open.length > 2 ? ` +${open.length - 2} more` : ""}`
            : parkedIds.length
              ? `🗃️ parked: ${parkedIds.slice(0, 3).map((id) => cutWords(id, 40)).join(", ")}${parkedIds.length > 3 ? ` +${parkedIds.length - 3} more` : ""}`
              : `⛔ ${finance ? safeSubject(reason, "blocked") : reason}`;
    // The why link opens the card's receipt (receipts/<file>, the exact text that the row cuts; the card note may have
    // changed since) in the dashboard's 🧾 Why panel, not as raw JSON (owner 2026-11-03, card why-link-dashboard;
    // deeplink-contract.md ?why= ?receipt=). The file name is kept: it may differ from the card id.
    const why = blocked && dash ? { why: whyLink(dash, c.id, r?.file ?? `${c.id}.json`) } : {};
    // Owner 2026-11-05: a card blocked on an unanswered owner question links that question directly (open menus only).
    const question = blocked && !cleared && qMid ? { question: qUrl } : {};
    const chip = blocked && !cleared ? { chip: reasonChip({ open, url: firstUrl(r?.summary), byId, dash, parked: parkedIds.length > 0, qUrl: qMid ? qUrl : "", why: why.why, reason }) } : {};
    const base = { key: `card:${c.id}`, title, link: cardLink(c, dash), where, ...why, ...question, ...chip, ...stackOf(cardStack(c, res), res, c.s !== "done") };
    // Owner 2026-10-24: background services and scheduled jobs are not queue jobs; they get their own section.
    const first = String(Array.isArray(job) ? (job[0] ?? "") : job);
    if (/\.(service|timer)$/.test(first) || first.startsWith("remote:")) {
      // Title = the bot's own name; the card it belongs to goes on the second line.
      const bot = first.replace(/^remote:/, "remote host ").replace(/\.(service|timer)$/, "");
      if (c.s !== "done") rows.push({ ...base, title: bot, where: `card: ${title}`, state: "bot", at: num(c.cts) || now });
      continue;
    }
    const cAt = num(c.cts);
    if (c.s === "running") rows.push({ ...base, state: "running", at: cAt || now });
    else if (c.s === "partial" || c.s === "planned") {
      if (r?.result === "failed" && now - rAt < KEEP_FINISHED_MS) rows.push({ ...base, state: "failed", at: rAt });
      else if (blocked) rows.push({ ...base, state: cleared ? "check" : "blocked", at: rAt });
      else rows.push({ ...base, state: "queued", at: cAt || now });
    } else if (c.s === "done") {
      const at = rAt || cAt;
      if (at && now - at < KEEP_FINISHED_MS) rows.push({ ...base, state: r?.result === "failed" ? "failed" : "done", at });
    }
  }
  return rows;
}

function stackOf(stack: string | undefined, res?: Resolvers, live = false): Pick<Row, "stack" | "stackChannel"> {
  if (!stack) return {};
  const ch = res?.stackChannel?.(stack, live);
  // Owner 2026-10-26 (no-unknown-channel): keep only a stack thread id that resolves; a dead id is dropped here.
  const ok = ch && channelMention(ch, "") !== "";
  return { stack, ...(ok ? { stackChannel: ch } : {}) };
}

/**
 * One "why" emoji + a ≤4-word reason chip for a Blocked row, linked to the blocker (owner 2026-11-07, card
 * mq-blocked-compact: no free-text note in the queue; the full note stays on the card/dashboard).
 */
export function reasonChip(o: { url?: string; open: string[]; byId: Map<string, FmCard>; dash: string; parked: boolean; qUrl: string; why?: string; reason: string }): string {
  const ln = (label: string, url?: string) => (url ? `[${label}](<${url}>)` : label);
  if (o.open.length) {
    const b = o.byId.get(o.open[0]!);
    const more = o.open.length > 1 ? ` +${o.open.length - 1}` : "";
    return `🔗 waits on ${ln(cutWords(o.open[0]!, 14), b ? cardLink(b, o.dash) : undefined)}${more}`;
  }
  if (o.qUrl) return `🙋 ${ln("you", o.qUrl)}`;
  if (o.parked) return `🗃️ parked`;
  const r = o.reason.toLowerCase();
  const [e, w] = /\b(ci|pipeline|checks?)\b/.test(r) ? ["⏳", "CI"]
    : /\b(key|token|secret|credential|login|auth|2fa|otp)s?\b/.test(r) ? ["🔑", "key"]
    : /\b(owner|approv\w*|decision|you|human|confirm)\b/.test(r) ? ["🙋", "you"]
    : /\b(pr|mr|merge|review)\b/.test(r) ? ["🔀", "PR"]
    : /\b(deploy|restart|service)\b/.test(r) ? ["🚀", "deploy"]
    : ["⛔", "blocked"];
  return `${e} ${ln(w, o.url)}`;
}

export function botRows(live: LiveJob[], done: DoneJob[], now: number, res?: Resolvers): Row[] {
  const rows: Row[] = live.map((j) => ({ key: `job:${j.id}`, title: j.title, ...(j.link ? { link: j.link } : {}), where: j.channelId ? channelMention(j.channelId, "💬 a closed channel") : "💬 no channel recorded", state: j.state, at: j.since, ...stackOf(j.stack, res, true) }));
  const liveIds = new Set(live.map((j) => j.id));
  // Owner 2026-11-07 (card heal-failed-finished): a failed or stopped job is never left idle in Finished. When a
  // later job ran in the same channel (still live, or finished ok), that later job healed it, so the row drops.
  const healed = healedJobs(live, done);
  for (const d of done) {
    if (liveIds.has(d.id) || now - d.at >= KEEP_FINISHED_MS || healed.has(d.id)) continue;
    rows.push({ key: `job:${d.id}`, title: d.title, ...(d.link ? { link: d.link } : {}), where: d.channelId ? channelMention(d.channelId, "💬 a closed channel") : "💬 no channel recorded", state: d.state, at: d.at, ...stackOf(d.stack, res) });
  }
  return rows;
}

/**
 * Failed/stopped job ids that a later job healed. A stopped job: any later job in the same channel (live now, or
 * finished ok after it) took over. A failed job: only a later run of the SAME message (same link: the auto retry or
 * 🔁 retry), so an unrelated message in a busy channel never hides a real failure.
 */
export function healedJobs(live: Pick<LiveJob, "id" | "channelId" | "link">[], done: Pick<DoneJob, "id" | "channelId" | "state" | "at" | "link">[]): Set<number> {
  const out = new Set<number>();
  for (const d of done) {
    if (d.state === "done" || !d.channelId) continue;
    if (d.state === "failed" && !d.link) continue;
    const same = (o: { channelId?: string; link?: string }) => o.channelId === d.channelId && (d.state === "stopped" || o.link === d.link);
    const later = live.some((j) => same(j) && j.id > d.id) || done.some((o) => same(o) && o.state === "done" && o.id > d.id && o.at >= d.at);
    if (later) out.add(d.id);
  }
  return out;
}

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

const ICON: Record<RowState, string> = { queued: "⏳", running: "⚙️", done: "✅", failed: "❌", stopped: "🛑", blocked: "⛔", check: "✅", bot: "🤖", needs: "✍️" };
export const TITLE_MAX = 26;
const FINISHED: Partial<Record<RowState, true>> = { done: true, failed: true, stopped: true, blocked: true, check: true };

export function rowLine(r: Row, now: number, n?: number, gear = "⚙️"): string {
  const label = linkLabel(safeTitle(r.title, r.key.replace(/^[a-z]+:/, ""), r.key));
  // Owner 2026-10-25 (needs-you-action-gate): every Needs-you item is a blocked-out action section.
  if (r.state === "needs") return actionBlock(`${label} · ${age(now - r.at)}`, r.steps ?? [], r.link ?? "") + (r.unblocks ? `\n🔓 unblocks ${r.unblocks} card${r.unblocks === 1 ? "" : "s"}` : "");
  // Owner 2026-10-24: the title line must fit one phone line (icon + title + age), so titles are cut at 26 chars.
  const short = label.length > TITLE_MAX ? `${label.slice(0, TITLE_MAX - 1).trimEnd()}…` : label;
  const title = r.link ? `[${short}](<${r.link}>)` : short;
  const when = r.state === "bot" ? `on ${age(now - r.at)}` : FINISHED[r.state] ? `<t:${Math.floor(r.at / 1000)}:t>` : r.state === "running" ? age(now - r.at) : `⏳ ${age(now - r.at)}`; // owner 2026-10-24: emoji instead of the word "waiting"
  // Owner 2026-10-23: details on their own indented line, in plain words, with channel links.
  // A blocked row carries the worker's reason (card fm-job-cap-ci-wait), cut at a word, plus a "why" link to the full
  // receipt text (card mq-blocked-reason-full).
  // Owner 2026-11-07 (card mq-blocked-compact): a blocked row's detail line is one why emoji + ≤4-word chip, no note.
  const chipLine = r.state === "blocked" && r.chip ? r.chip + (r.why ? ` · 🗃️ [Card](<${r.why}>)` : "") : "";
  const where = chipLine || (r.state === "blocked" || r.state === "check" ? (r.where.includes("](<") ? r.where : cutWords(r.where, 100)).replaceAll(GEAR_TOKEN, gear) + (r.question ? ` · ❓ [question](<${r.question}>)` : "") + (r.why ? ` · 🗃️ [Card](<${r.why}>)` : "") : r.where.length > 60 ? `${r.where.slice(0, 59)}…` : r.where);
  // Owner 2026-10-24: a job running in its own stack thread shows that thread once, not twice.
  // Owner 2026-10-24: show a stack only as a link to a DIFFERENT channel; plain-text stack names duplicate the channel link.
  const stackRef = r.stackChannel ? channelMention(r.stackChannel, "") : "";
  // Owner 2026-11-03 (card stack-coverage): every job shows its stack. A stack with no live thread shows its name,
  // so the row never looks like it went straight to a channel.
  const stackShown = stackRef || (r.stack ? `🧭 ${r.stack} stack` : "");
  const stack = !stackShown || r.where === stackRef ? "" : ` · ${stackShown}`;
  // Owner 2026-11-07: a check row has no detail line of its own; its 🗃️ Card link follows the stack/channel line.
  if (r.state === "check") {
    const card = r.why ? ` · 🗃️ [Card](<${r.why}>)` : "";
    return `${n !== undefined ? `${n}. ` : ""}${ICON.check} ${title} · ${when}\n\u2003\u2003↳ ${stackShown || r.where}${card}`;
  }
  const detail = r.state === "bot" ? `↳ ${where}` : stack
      ? // Owner 2026-10-24: stack first, then the job's own channel (or 💻) one level deeper.
        `↳ ${stackShown}\n\u2003\u2003\u2003\u2003↳ ${where}`
      : `↳ ${where}`;
  return `${n !== undefined ? `${n}. ` : ""}${r.state === "running" ? gear : ICON[r.state]} ${title} · ${when}\n\u2003\u2003${detail}`;
}

export const RULE = "━━━━━━━━━━━━━━━━━━━━";
export const SUB = "———————————";
/** Owner 2026-10-23: same style as the ⏳ Queue box (━ bars around the board, ——— under each section title, animated gear). */
/** Counts written by ~/.local/bin/bots-page (every 10 min). */
export function botCounts(file = join(process.env.HOME ?? "", "Documents/reports/web/bots/counts.json")): { running: number; scheduled: number; down: number } | null {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { running?: number; scheduled?: number; down?: number };
    return { running: d.running ?? 0, scheduled: d.scheduled ?? 0, down: d.down ?? 0 };
  } catch {
    return null;
  }
}
export type DownUnit = { card: string; state: "healing" | "needs you" | "blocked" };
/** Down units with their tracker cards, written by self-healing-harness unitheal every 2 min (card unit-down-triage).
 *  null when missing, older than 10 min (the harness is not running) or holding a row it cannot read: then the line
 *  falls back to the plain bots-page count, so a bad file never hides a down unit. */
export function downUnits(now: number, file = join(process.env.HOME ?? "", "Documents/reports/web/bots/down.json")): DownUnit[] | null {
  try {
    const d: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!d || typeof d !== "object" || !("at" in d) || !("units" in d) || typeof d.at !== "string" || !Array.isArray(d.units)) return null;
    if (!(now - Date.parse(d.at) <= 10 * 60_000)) return null;
    const rows: DownUnit[] = [];
    for (const u of d.units as unknown[]) {
      if (!(u && typeof u === "object" && "card" in u && "state" in u && typeof u.card === "string")) return null;
      if (u.state !== "healing" && u.state !== "needs you" && u.state !== "blocked") return null;
      rows.push({ card: u.card, state: u.state });
    }
    return rows;
  } catch {
    return null;
  }
}
/** Owner 2026-11-07 (card unit-down-triage): "⚠️ N down" says what the down units' cards are doing (🩹 healing /
 *  ✍️ needs you / ⛔ blocked) and links those cards (dashboard tag unit-down). The unitheal list (2 min old at most)
 *  wins for the breakdown; the count is the larger of both, so a unit unitheal does not track (yet) still shows. */
export function botsLine(c: { running: number; scheduled: number; down: number } | null, down: DownUnit[] | null, dash: string, linked: number): string {
  const n = Math.max(down?.length ?? 0, c?.down ?? 0);
  let s = c ? `${c.running} running · ${c.scheduled} scheduled` : `${linked} linked to cards`;
  if (!n) return s;
  s += ` · ⚠️ ${n} down`;
  if (!down) return s;
  const by = (st: DownUnit["state"]) => down.filter((u) => u.state === st).length;
  const parts = [["🩹", "healing"], ["✍️", "needs you"], ["⛔", "blocked"]] as const;
  const what = parts.flatMap(([e, st]) => (by(st) ? [`${e} ${by(st)} ${st}`] : [])).join(" · ");
  const untracked = n - down.length ? `${what ? " · " : ""}${n - down.length} without a card` : "";
  return `${s} (${what && dash ? `[${what}](<${dash}?tag=unit-down>)` : what}${untracked})`;
}
// Owner 2026-11-03: no "(continued)" title on later pages; an invisible mark (U+2063) still lets the bot find its own pages.
export const MASTER_CONT = "\u2063";
/**
 * Board pages (each ≤ limit chars). Owner 2026-10-24: every row is shown, no "+N more"; a long board continues in
 * more messages. Sections: Running, Queued, Blocked (receipt reason), Finished (12 h), then 🤖 Bots and scheduled jobs.
 */
export function renderMasterPages(rows: Row[], now: number, dash: string, limit = 1900, gear = "⚙️", notice = "", top: string[] = []): string[] {
  const foot = dash ? `🗂️ [Dashboard: running jobs](<${dash}?tab=running>)` : "";
  // Owner 2026-11-03 (card mq-top-link): the dashboard link also sits near the top, right below the title.
  const head = [RULE, `${MASTER_HEAD} · updated <t:${Math.floor(now / 1000)}:R>`, foot].filter(Boolean).join("\n");
  // Owner 2026-11-04 (msg 100000000000000052, card mq-main-blocker): the 🚧 Main blocker section sits directly ABOVE
  // ✍️ Needs you (near the bottom, where the owner starts reading). An empty board shows it below the notice.
  if (!rows.length) return [[head, notice, ...top, SUB, "✅ No jobs queued, running or finished in the last 12 h.", foot, RULE].filter(Boolean).join("\n")];
  const running = rows.filter((r) => r.state === "running").sort((a, b) => a.at - b.at);
  const queued = rows.filter((r) => r.state === "queued").sort((a, b) => a.at - b.at);
  // Owner 2026-11-01 (card fm-job-cap-ci-wait): blocked jobs (e.g. "waiting on CI: PR #N ...") wait, they are not
  // finished; they get their own section so the reason line shows on the board.
  const blocked = rows.filter((r) => r.state === "blocked").sort((a, b) => a.at - b.at);
  // Card mq-blocked-reason-full: blocked rows whose blocker cards are all done wait for a check, not for the blocker.
  const check = rows.filter((r) => r.state === "check").sort((a, b) => a.at - b.at);
  const finished = rows.filter((r) => FINISHED[r.state] && r.state !== "blocked" && r.state !== "check").sort((a, b) => b.at - a.at);
  const bots = rows.filter((r) => r.state === "bot").sort((a, b) => a.title.localeCompare(b.title));
  // Board notice (owner alert pause, src/alertpause.ts) right below the head.
  const lines: string[] = notice ? [notice] : [];
  // Owner 2026-11-03: the whole board reads from the BOTTOM up, so the owner never scrolls.
  // Bottom to top: ✍️ Needs you, Running, Queued, Blocked, Needs a check, Finished, Bots. Inside each list the
  // oldest row is lowest (seen first from the bottom); the section title stays above its rows.
  const section = (title: string, ls: string[]) => ls.length && lines.push("\u200b", title, SUB, ...ls.reverse());
  const needs = rows.filter((r) => r.state === "needs").sort((a, b) => a.at - b.at);
  // Owner 2026-10-24 (pick "Count line + link"): bots and scheduled jobs are one count line, not rows.
  const n = botsLine(botCounts(), downUnits(now), dash, bots.length);
  lines.push("\u200b", `🤖 **Bots and scheduled jobs:** ${n}${dash ? ` → [list](<${dash}?tab=services>)` : ""}`);
  // Owner 2026-10-24: finished jobs are one count line with a dashboard link (they made a 4-message board).
  const failed = finished.filter((r) => r.state !== "done").length;
  lines.push("\u200b", `🏁 **Finished, last 12 h:** ${finished.length}${failed ? ` (⚠️ ${failed} failed or stopped)` : ""}${dash ? ` → [list](<${dash}?tab=done>)` : ""}`);
  section("✅ 🔧 🔍 **Needs Check**", check.map((r) => rowLine(r, now, undefined, gear)));
  section(`⛔ **Blocked** (${blocked.length})`, blocked.map((r) => rowLine(r, now, undefined, gear)));
  section(`⏳ **Queued** (${queued.length})`, queued.map((r, i) => rowLine(r, now, i + 1)));
  section(`${gear} **Running** (${running.length})`, running.map((r) => rowLine(r, now, undefined, gear)));
  if (top.length) lines.push("\u200b", ...top);
  // Owner 2026-11-03 (card mq-needs-bottom): ✍️ Needs you sits at the BOTTOM, right above the dashboard link.
  section(`✍️ **Needs you** (${needs.length})`, needs.map((r) => rowLine(r, now)));
  if (foot) lines.push("\u200b", foot); // owner 2026-10-24: blank line above the dashboard link
  const pages: string[] = [];
  let cur = [head];
  let len = head.length;
  for (const raw of lines) {
    const l = raw.length > limit - 200 ? `${raw.slice(0, limit - 201)}…` : raw;
    if (len + l.length + 1 + RULE.length + 1 > limit) {
      pages.push(cur.join("\n"));
      cur = [];
      len = MASTER_CONT.length;
    }
    // Owner 2026-11-03: the invisible page mark sits INSIDE the first line of a later page, never on its own line
    // (an own line showed as a blank gap between list items). A page never starts with a blank spacer line.
    if (!cur.length) {
      if (l.replace(/[\u200b\s]/g, "") === "") continue;
      cur.push(`${MASTER_CONT}${l}`);
    } else cur.push(l);
    len += l.length + 1;
  }
  cur.push(RULE);
  pages.push(cur.join("\n"));
  return pages.map(fixMaskedLinks);
}
/** First page only (tests and callers that need one message). */
export function renderMaster(rows: Row[], now: number, dash: string, limit = 1900, gear = "⚙️", notice = "", top: string[] = []): string {
  return renderMasterPages(rows, now, dash, limit, gear, notice, top).join("\n");
}

export function readCards(file: string): FmCard[] | null {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { items?: unknown };
    return Array.isArray(d.items) ? (d.items as FmCard[]).filter((x) => x && typeof x.id === "string") : null;
  } catch {
    return null;
  }
}

/** Newest receipt per card (receipts/<card>.json). */
export function readReceipts(dir: string): Map<string, Receipt> {
  const out = new Map<string, Receipt>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Receipt;
      const key = r.card ?? f.slice(0, -5);
      // Two files can name one card: keep the newest (readdir order is arbitrary).
      const had = out.get(key);
      if (!had || num(r.tsMs) >= num(had.tsMs)) out.set(key, { ...r, file: f }); // the why link opens this file
    } catch {}
  }
  return out;
}

export type MasterOpts = {
  getChannel: () => Promise<BoardChannel | null>;
  /** Board notice line below the head ("" = none); owner alert pause. */
  notice?: () => string;
  botId: () => string | undefined;
  /** Button rows on the last page (⏸️ Pause / ▶️ Resume, card omp-pause-button); other pages get none. */
  components?: () => unknown[];
  /** Live bot jobs (running + queued), every channel. */
  jobs: () => LiveJob[];
  /** Messages that may sit below this board without a reprint (the ⏳ Queue box). */
  mayBeBelow: (m: { content: string; author: { id: string } }) => boolean;
  itemsFile: string;
  receiptsDir: string;
  stateFile: string;
  dash: string;
  log: (s: string) => void;
  resolvers?: Resolvers;
  /** Open question menus (same source as the 🔔 Needs-you board), card mq-needs-menus. */
  menus?: MenuSource;
  now?: () => number;
  /** 🚧 Main blocker sources (card mq-main-blocker); without it the board shows no blocker line. */
  blockers?: BlockerFiles;
  /** Card stack-thread-follow: called with the board rows on each refresh (owner joins/leaves stack threads). */
  onRows?: (rows: Row[], now: number) => void;
};

/** SuppressEmbeds (4) | SuppressNotifications (4096). */
const FLAGS = 4 | 4096;
/**
 * Board rows without the head lines and without " · 6m"-style elapsed times (also the 🚧 line's "oldest waiting 6h 12m"),
 * so a minute tick alone does not repost the board.
 */
const ageless = (t: string): string => t.split("\n").slice(2).join("\n").replace(/ · \d+[smhd]( \d+[smhd])?\b/g, " · ~").replace(/oldest waiting \d+[smhd]( \d+[smhd])?\b/g, "oldest waiting ~");
export const AGE_REPOST_MS = 10 * 60_000;
/**
 * Owner 2026-11-04 (no UI thrashing): after new messages in the channel, the board moves to the bottom only once
 * the channel is quiet for MOVE_QUIET_MS, so a burst of messages (a long answer in parts, several replies) causes
 * ONE move at the end. MOVE_MAX_WAIT_MS caps the wait during a long steady stream.
 */
export const MOVE_QUIET_MS = 8_000;
export const MOVE_MAX_WAIT_MS = 45_000;
/** Delay before the board move for a message at `now` in a burst that began at `burstSince`. */
export function moveDelay(burstSince: number, now: number): number {
  return Math.max(0, Math.min(MOVE_QUIET_MS, MOVE_MAX_WAIT_MS - (now - burstSince)));
}

export class MasterQueueBoard {
  private boards: BoardMsg[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastText = "";
  private lastComps = "null";
  private lastEdit = 0;
  private force = false;
  /** First message of the current burst (ms), for MOVE_MAX_WAIT_MS; 0 = no burst open. */
  private burstSince = 0;
  private done: DoneJob[] = [];
  private readonly titles = new Map<number, Omit<LiveJob, "state" | "since">>();

  constructor(private o: MasterOpts) {
    try {
      if (existsSync(o.stateFile)) {
        const d = JSON.parse(readFileSync(o.stateFile, "utf8")) as { done?: DoneJob[] };
        this.done = Array.isArray(d.done) ? d.done : [];
      }
    } catch {}
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  /** Components for page i of n: the rows on the last page, [] on the others (nothing without the option). */
  private comps(i: number, n: number): { components?: unknown[] } {
    if (!this.o.components) return {};
    return { components: i === n - 1 ? this.o.components() : [] };
  }

  start(): void {
    this.schedule(0);
    this.poll = setInterval(() => this.schedule(0), 60_000);
  }
  stop(): void {
    clearInterval(this.poll ?? undefined);
    clearTimeout(this.timer ?? undefined);
  }

  /** The queue changed (enqueue, start, cancel): remember titles/links for the finish row; refresh soon. */
  onQueueChange(): void {
    for (const j of this.o.jobs()) this.titles.set(j.id, { id: j.id, title: j.title, channelId: j.channelId, ...(j.link ? { link: j.link } : {}), ...(j.stack ? { stack: j.stack } : {}) });
    this.schedule(2000);
  }

  /** A bot job ended (src/queue.ts onSettled). Kept 12 h. `info`: current title/channel/link (wins over saved ones). */
  finished(id: number, state: DoneJob["state"], info: Partial<LiveJob> = {}): void {
    const t = this.titles.get(id);
    this.titles.delete(id);
    const title = info.title || t?.title || `job ${id}`;
    const channelId = info.channelId || t?.channelId || "";
    const link = info.link ?? t?.link;
    const stack = info.stack ?? t?.stack;
    const now = this.now();
    this.done = [{ id, title, channelId, ...(link ? { link } : {}), state, at: now, ...(stack ? { stack } : {}) }, ...this.done.filter((d) => d.id !== id && now - d.at < KEEP_FINISHED_MS)].slice(0, 200);
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      writeFileSync(`${this.o.stateFile}.tmp`, JSON.stringify({ done: this.done }));
      renameSync(`${this.o.stateFile}.tmp`, this.o.stateFile);
    } catch (e) {
      this.o.log(`master queue save: ${(e as Error).message}`);
    }
    this.schedule(1500);
  }

  /** A message landed in the channel: move the board back to the bottom (debounced). */
  onMessage(m: { content: string; author: { id: string } }): void {
    if (m.author.id === this.o.botId() && (isMasterBoard(m.content) || this.o.mayBeBelow(m))) return;
    const now = this.now();
    if (!this.burstSince) this.burstSince = now;
    this.schedule(moveDelay(this.burstSince, now), true);
  }

  schedule(delay: number, force = false): void {
    if (force) this.force = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.burstSince = 0;
      const f = this.force;
      this.force = false;
      this.chain = this.chain.then(() => this.refresh(f)).catch((e) => this.o.log(`master queue: ${(e as Error).message}`));
    }, delay);
  }
  idle(): Promise<void> {
    return this.chain;
  }

  rows(menus: MenuRow[] = []): Row[] {
    const now = this.now();
    const cards = readCards(this.o.itemsFile) ?? [];
    return [...botRows(this.o.jobs(), this.done, now, this.o.resolvers), ...cardRows(cards, readReceipts(this.o.receiptsDir), now, this.o.dash, this.o.resolvers, this.o.menus ? answeredMenuIds(this.o.menus.asksFile) : undefined), ...needsRows(cards, now, this.o.dash, menus)];
  }

  /** Open menus for the ✍️ Needs you section (empty without a menu source). */
  async openMenus(): Promise<MenuRow[]> {
    if (!this.o.menus) return [];
    return loadOpenMenus(this.o.menus, asItems(readCards(this.o.itemsFile) ?? [])).catch((e) => (this.o.log(`master queue menus: ${(e as Error).message}`), []));
  }

  /** Live status of runs named in blocked receipts (card mq-main-blocker); created on first use. */
  private runs: RunStatus | null = null;
  /** fm-spawn's own verdict on its queue (why queued jobs wait); created on first use. */
  private drain: DrainCheck | null = null;

  /** 🚧 Main blocker lines for the board head (card mq-main-blocker); also writes the dashboard copy. */
  blockerTop(now: number): string[] {
    const f = this.o.blockers;
    if (!f) return [];
    try {
      const cards = readCards(this.o.itemsFile) ?? [];
      const receipts = readReceipts(this.o.receiptsDir);
      // Receipt text says "waiting on CI: run …" also after the run ended: only a run checked as queued/running counts.
      // fm-overseer's cache (fresh entries) first, else our own lookup; a lookup that changes a status redraws.
      this.runs ??= new RunStatus(f.runFetch ?? ghGlRunFetch, () => this.now());
      const runs = this.runs;
      void runs.update(receiptRuns(cards, receipts, now)).then((n) => n && this.schedule(1000)).catch(() => {});
      this.drain ??= new DrainCheck(f.drainRun ?? fmSpawnDryRun, () => this.now());
      void this.drain.update().then((ch) => ch && this.schedule(1000)).catch(() => {});
      const cache = readCiCache(f.ciCacheFile);
      const runInfo = (k: string) => {
        const o = cache[k];
        const mine = runs.get(k);
        return o?.status && now - (o.at ?? 0) < OVERSEER_STALE_MS && (o.at ?? 0) >= (mine?.at ?? 0) ? o : mine;
      };
      const all = findBlockers({
        cards,
        receipts,
        now,
        dash: this.o.dash,
        ci: readCiWaits(f.overseerFile, f.ciCacheFile, now),
        spawnQueue: readSpawnQueue(f.spawnQueueFile),
        caps: readCaps(f.capsFile),
        jobs: this.o.jobs(),
        runInfo,
        ...(this.drain.get() ? { drain: this.drain.get() } : {}),
        ...(this.o.resolvers ? { res: this.o.resolvers } : {}),
      });
      const shown = mainBlockers(all, now);
      // A failed dashboard write must not hide the board line.
      if (f.outFile) try { writeBlockersFile(f.outFile, shown, now); } catch (e) { this.o.log(`master queue blockers file: ${(e as Error).message}`); }
      return blockerLines(shown, now);
    } catch (e) {
      this.o.log(`master queue blockers: ${(e as Error).message}`);
      return [];
    }
  }

  async refresh(force = false): Promise<void> {
    const ch = await this.o.getChannel();
    if (!ch) return;
    const now = this.now();
    const allRows = this.rows(await this.openMenus());
    try { this.o.onRows?.(allRows, now); } catch (e) { this.o.log(`master queue onRows: ${(e as Error).message}`); }
    const pages = renderMasterPages(allRows, now, this.o.dash, 1900, WORKING_EMOJI, this.o.notice?.() ?? "", this.blockerTop(now));
    const text = pages.join("\n");
    // Lines 0-1 are the ━ rule and the head with the changing `updated <t:…:R>` stamp: compare the rows below them.
    const comps = JSON.stringify(this.o.components?.() ?? null);
    const sameRows = text.split("\n").slice(2).join("\n") === this.lastText.split("\n").slice(2).join("\n") && comps === this.lastComps;
    // Only elapsed times changed ("1m" -> "6m"): no repost before AGE_REPOST_MS, so running jobs do not churn the channel.
    const ageOnly = !sameRows && comps === this.lastComps && ageless(text) === ageless(this.lastText) && now - this.lastEdit < AGE_REPOST_MS;
    this.lastComps = comps;
    const fetched = await ch.messages.fetch({ limit: 40 }).catch(() => null);
    const recent = fetched ? [...fetched.values()] : []; // newest first
    const me = this.o.botId();
    const mine = recent.filter((m) => m.author.id === me && isMasterBoard(m.content));
    if (!this.boards.length) this.boards = [...mine].reverse(); // oldest first = page order
    const ids = new Set(this.boards.map((m) => m.id));
    const firstAt = this.boards.length ? recent.findIndex((m) => m.id === this.boards[0]!.id) : -1;
    // "Last": below the first page only its own pages and the ⏳ Queue box.
    const isLast = firstAt >= 0 && recent.slice(0, firstAt).every((m) => m.author.id === me && (ids.has(m.id) || this.o.mayBeBelow(m)));
    // Owner 2026-10-30 (card discord-queue-own-message): never edit a message to carry the queue. A change is a
    // fresh silent post (SuppressNotifications) at the bottom; the previous board is deleted afterwards.
    if (isLast && this.boards.length === pages.length && (sameRows || ageOnly) && !force) {
      // unchanged and still at the bottom: nothing to do
    } else {
      const fresh: BoardMsg[] = [];
      for (const pg of pages) {
        const m = await ch.send({ content: pg, flags: FLAGS, allowedMentions: { parse: [] }, ...this.comps(fresh.length, pages.length) }).catch((e) => (this.o.log(`master queue post: ${(e as Error).message}`), null));
        if (!m) break;
        fresh.push(m);
      }
      if (fresh.length !== pages.length) {
        for (const m of fresh) await m.delete().catch(() => {});
        return;
      }
      for (const m of this.boards) await m.delete().catch(() => {});
      this.boards = fresh;
      this.lastEdit = now;
    }
    this.lastText = text;
    const keep = new Set(this.boards.map((m) => m.id));
    for (const m of mine) if (!keep.has(m.id)) await m.delete().catch(() => {});
  }

}

/**
 * Owner 2026-10-24 (card mq-live-tab): the 📋 Master queue covers the FIRSTMATE channel, so the bridge posts
 * no per-message ⏳ Queue box there. Every other channel keeps it. `/queue` still prints one on request.
 */
export function queueBoxAllowed(channelId: string, firstmateChannelId: string | undefined): boolean {
  return !firstmateChannelId || channelId !== firstmateChannelId;
}
