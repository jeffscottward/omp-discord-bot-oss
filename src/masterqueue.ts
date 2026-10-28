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
 * The board is edited in place and kept at the bottom of the channel; only the bridge's own ⏳ Queue box
 * may sit below it (both boards are "last" boxes; this one never reprints for the Queue box).
 */
import { channelMention, safeTitle } from "./mention.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { actionBlock, actionSteps, isFinanceCard, itemLink, linkLabel, loadOpenMenus, needsYouEntries, type BoardChannel, type BoardMsg, type FmItem, type MenuRow, type MenuSource } from "./needsyou.ts";

export const MASTER_HEAD = "📋 **Master queue**";
export const isMasterBoard = (text: string): boolean => text.startsWith(MASTER_HEAD) || text.startsWith(`━━━━━━━━━━━━━━━━━━━━\n${MASTER_HEAD}`);
export const KEEP_FINISHED_MS = 12 * 3_600_000; // owner 2026-10-24: finished jobs older than 12 h are not listed

export type RowState = "queued" | "running" | "done" | "failed" | "stopped" | "blocked" | "bot" | "needs";
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
  stackChannel?: (stack: string) => string | undefined;
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
  if (job.startsWith("remote:")) return `remote host service ${job.slice(9)}`;
  return `💻 ${job}`;
}

/** A live bot job (src/queue.ts view plus the bridge's own maps). */
export type LiveJob = { id: number; title: string; channelId: string; link?: string; running: boolean; since: number; stack?: string };
/** A finished bot job, saved for 12 h. */
export type DoneJob = { id: number; title: string; channelId: string; link?: string; state: "done" | "failed" | "stopped"; at: number; stack?: string };

export type FmCard = { id: string; action?: string; t?: string; area?: string; s?: string; q?: string; src?: string; job?: string | string[]; cts?: number | string; stack?: string; blockedBy?: string | string[]; ext?: string; queued?: unknown };
export type Receipt = { card?: string; result?: string; tsMs?: number | string };

const DISCORD_MSG = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

function cardLink(c: FmCard, dash: string): string | undefined {
  if (c.src && DISCORD_MSG.test(c.src)) return c.src;
  if (c.q && DISCORD_MSG.test(c.q)) return c.q;
  return dash ? `${dash}?item=${encodeURIComponent(c.id)}` : undefined;
}

/** Cards as the Needs-you code reads them (numeric cts, one job string); other fields stay as they are. */
export function asItems(cards: FmCard[]): FmItem[] {
  return cards.map((c) => ({ ...c, cts: num(c.cts) || undefined, job: Array.isArray(c.job) ? c.job[0] : c.job }));
}

const NEEDS_WHERE = { waiting: "your action", open: "your answer to a question", blocked: "your step" } as const;

/**
 * Owner 2026-10-24: ✍️ Needs you at the top of the board. Card mq-needs-menus: the SAME items as the 🔔 Needs-you board
 * (src/needsyou.ts needsYouEntries): open question menus plus waiting/open/blocked-on-you cards. A card whose q is a
 * menu shows once. The "Waiting on bots / Blocker unclear" summaries stay off this board.
 */
export function needsRows(cards: FmCard[], now: number, dash: string, menus: MenuRow[] = []): Row[] {
  return needsYouEntries(asItems(cards), menus).map((e): Row => {
    if (e.kind === "menu") return { key: `menu:${e.menu.key}`, title: e.menu.label, link: e.menu.link, where: "your pick in a question menu", steps: [], state: "needs", at: e.menu.createdAt };
    const c = e.item;
    const finance = isFinanceCard(c);
    const title = finance ? `Finance card ${c.id}` : (c.t ?? c.id);
    const where = e.unblocks ? `${NEEDS_WHERE[e.group]} (unblocks ${e.unblocks} card${e.unblocks === 1 ? "" : "s"})` : NEEDS_WHERE[e.group];
    const steps = finance ? ["Open the finance card and do the step it names."] : actionSteps(c.action ?? "");
    return { key: `need:${c.id}`, title, link: itemLink(c, dash) || undefined, where, steps, ...(e.unblocks ? { unblocks: e.unblocks } : {}), state: "needs", at: c.cts || now };
  });
}

/** Card rows: cards with a `job` field. Running/queued now, or finished (card done / receipt) in the last 12 h. */
export function cardRows(cards: FmCard[], receipts: Map<string, Receipt>, now: number, dash: string, res?: Resolvers): Row[] {
  const rows: Row[] = [];
  // Owner 2026-10-24 ("are these not the same thing?"): cards that share one job session show it once.
  const sessionOwner = new Map<string, string>();
  for (const c of cards) {
    if (!c.job || !c.id) continue;
    const finance = isFinanceCard(c);
    // Finance cards: no title on the board (it can carry positions or account data).
    const title = finance ? `Finance card ${c.id}` : (c.t ?? c.id);
    const first0 = String(Array.isArray(c.job) ? (c.job[0] ?? "") : c.job).trim();
    const place = res?.job?.(first0);
    const session = place?.session; // only live Herdr sessions are grouped
    // Only cards that get a job row may own or share a session (blocked/waiting cards are not listed here).
    const listed = c.s === "running" || c.s === "partial" || c.s === "planned";
    const sharedWith = session && listed ? sessionOwner.get(session) : undefined;
    if (session && listed && !sharedWith) sessionOwner.set(session, title);
    const shortOf = (t: string) => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t);
    const where = sharedWith ? `same session as ${shortOf(linkLabel(sharedWith))}` : jobPlace(c.job, res);
    const base = { key: `card:${c.id}`, title, link: cardLink(c, dash), where, ...stackOf(cardStack(c, res), res) };
    // Owner 2026-10-24: background services and scheduled jobs are not queue jobs; they get their own section.
    const first = String(Array.isArray(c.job) ? (c.job[0] ?? "") : c.job);
    if (/\.(service|timer)$/.test(first) || first.startsWith("remote:")) {
      // Title = the bot's own name; the card it belongs to goes on the second line.
      const bot = first.replace(/^remote:/, "remote host ").replace(/\.(service|timer)$/, "");
      if (c.s !== "done") rows.push({ ...base, title: bot, where: `card: ${title}`, state: "bot", at: num(c.cts) || now });
      continue;
    }
    const r = receipts.get(c.id);
    const rAt = num(r?.tsMs);
    const cAt = num(c.cts);
    if (c.s === "running") rows.push({ ...base, state: "running", at: cAt || now });
    else if (c.s === "partial" || c.s === "planned") {
      if (r?.result === "failed" && now - rAt < KEEP_FINISHED_MS) rows.push({ ...base, state: "failed", at: rAt });
      else if (r?.result === "blocked" && now - rAt < KEEP_FINISHED_MS) rows.push({ ...base, state: "blocked", at: rAt });
      else rows.push({ ...base, state: "queued", at: cAt || now });
    } else if (c.s === "done") {
      const at = rAt || cAt;
      if (at && now - at < KEEP_FINISHED_MS) rows.push({ ...base, state: r?.result === "failed" ? "failed" : "done", at });
    }
  }
  return rows;
}

function stackOf(stack: string | undefined, res?: Resolvers): Pick<Row, "stack" | "stackChannel"> {
  if (!stack) return {};
  const ch = res?.stackChannel?.(stack);
  // Owner 2026-10-26 (no-unknown-channel): keep only a stack thread id that resolves; a dead id is dropped here.
  const ok = ch && channelMention(ch, "") !== "";
  return { stack, ...(ok ? { stackChannel: ch } : {}) };
}

export function botRows(live: LiveJob[], done: DoneJob[], now: number, res?: Resolvers): Row[] {
  const rows: Row[] = live.map((j) => ({ key: `job:${j.id}`, title: j.title, ...(j.link ? { link: j.link } : {}), where: j.channelId ? channelMention(j.channelId, "💬 a closed channel") : "💬 no channel recorded", state: j.running ? "running" : "queued", at: j.since, ...stackOf(j.stack, res) }));
  const liveIds = new Set(live.map((j) => j.id));
  for (const d of done) {
    if (liveIds.has(d.id) || now - d.at >= KEEP_FINISHED_MS) continue;
    rows.push({ key: `job:${d.id}`, title: d.title, ...(d.link ? { link: d.link } : {}), where: d.channelId ? channelMention(d.channelId, "💬 a closed channel") : "💬 no channel recorded", state: d.state, at: d.at, ...stackOf(d.stack, res) });
  }
  return rows;
}

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

const ICON: Record<RowState, string> = { queued: "⏳", running: "⚙️", done: "✅", failed: "❌", stopped: "🛑", blocked: "⛔", bot: "🤖", needs: "✍️" };
export const TITLE_MAX = 26;
const FINISHED: Partial<Record<RowState, true>> = { done: true, failed: true, stopped: true, blocked: true };

export function rowLine(r: Row, now: number, n?: number, gear = "⚙️"): string {
  const label = linkLabel(safeTitle(r.title, r.key.replace(/^[a-z]+:/, ""), r.key));
  // Owner 2026-10-25 (needs-you-action-gate): every Needs-you item is a blocked-out action section.
  if (r.state === "needs") return actionBlock(`${label} · ${age(now - r.at)}`, r.steps ?? [], r.link ?? "") + (r.unblocks ? `\n🔓 unblocks ${r.unblocks} card${r.unblocks === 1 ? "" : "s"}` : "");
  // Owner 2026-10-24: the title line must fit one phone line (icon + title + age), so titles are cut at 26 chars.
  const short = label.length > TITLE_MAX ? `${label.slice(0, TITLE_MAX - 1).trimEnd()}…` : label;
  const title = r.link ? `[${short}](<${r.link}>)` : short;
  const when = r.state === "bot" ? `on ${age(now - r.at)}` : FINISHED[r.state] ? `<t:${Math.floor(r.at / 1000)}:t>` : r.state === "running" ? age(now - r.at) : `⏳ ${age(now - r.at)}`; // owner 2026-10-24: emoji instead of the word "waiting"
  // Owner 2026-10-23: details on their own indented line, in plain words, with channel links.
  const where = r.where.length > 60 ? `${r.where.slice(0, 59)}…` : r.where;
  // Owner 2026-10-24: a job running in its own stack thread shows that thread once, not twice.
  // Owner 2026-10-24: show a stack only as a link to a DIFFERENT channel; plain-text stack names duplicate the channel link.
  const stackRef = r.stackChannel ? channelMention(r.stackChannel, "") : "";
  const stack = !stackRef || r.where === stackRef ? "" : ` · ${stackRef}`;
  const detail = r.state === "bot" ? `↳ ${where}` : stack
      ? // Owner 2026-10-24: stack first, then the job's own channel (or 💻) one level deeper.
        `↳ ${stackRef}\n\u2003\u2003\u2003\u2003↳ ${where}`
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
export const MASTER_CONT = `${MASTER_HEAD} (continued)`;
/**
 * Board pages (each ≤ limit chars). Owner 2026-10-24: every row is shown, no "+N more"; a long board continues in
 * more messages. Sections: Running, Queued, Finished (12 h), then 🤖 Bots and scheduled jobs.
 */
export function renderMasterPages(rows: Row[], now: number, dash: string, limit = 1900, gear = "⚙️", notice = ""): string[] {
  const head = `${RULE}\n${MASTER_HEAD} · updated <t:${Math.floor(now / 1000)}:R>`;
  const foot = dash ? `🗂️ [Dashboard: running jobs](<${dash}?tab=running>)` : "";
  if (!rows.length) return [[head, notice, SUB, "✅ No jobs queued, running or finished in the last 12 h.", foot, RULE].filter(Boolean).join("\n")];
  const running = rows.filter((r) => r.state === "running").sort((a, b) => a.at - b.at);
  const queued = rows.filter((r) => r.state === "queued").sort((a, b) => a.at - b.at);
  const finished = rows.filter((r) => FINISHED[r.state]).sort((a, b) => b.at - a.at);
  const bots = rows.filter((r) => r.state === "bot").sort((a, b) => a.title.localeCompare(b.title));
  // Board notice (owner alert pause, src/alertpause.ts) right below the head.
  const lines: string[] = notice ? [notice] : [];
  const section = (title: string, ls: string[]) => ls.length && lines.push("\u200b", title, SUB, ...ls);
  const needs = rows.filter((r) => r.state === "needs").sort((a, b) => a.at - b.at);
  section(`✍️ **Needs you** (${needs.length})`, needs.map((r) => rowLine(r, now)));
  section(`${gear} **Running** (${running.length})`, running.map((r) => rowLine(r, now, undefined, gear)));
  section(`⏳ **Queued** (${queued.length})`, queued.map((r, i) => rowLine(r, now, i + 1)));
  // Owner 2026-10-24: finished jobs are one count line with a dashboard link (they made a 4-message board).
  const failed = finished.filter((r) => r.state !== "done").length;
  lines.push("\u200b", `🏁 **Finished, last 12 h:** ${finished.length}${failed ? ` (⚠️ ${failed} failed or stopped)` : ""}${dash ? ` → [list](<${dash}?tab=done>)` : ""}`);
  // Owner 2026-10-24 (pick "Count line + link"): bots and scheduled jobs are one count line, not rows.
  const c = botCounts();
  const n = c ? `${c.running} running · ${c.scheduled} scheduled${c.down ? ` · ⚠️ ${c.down} down` : ""}` : `${bots.length} linked to cards`;
  lines.push("\u200b", `🤖 **Bots and scheduled jobs:** ${n}${dash ? ` → [list](<${dash}?tab=services>)` : ""}`);
  if (foot) lines.push("\u200b", foot); // owner 2026-10-24: blank line above the dashboard link
  const pages: string[] = [];
  let cur = [head];
  let len = head.length;
  for (const raw of lines) {
    const l = raw.length > limit - 200 ? `${raw.slice(0, limit - 201)}…` : raw;
    if (len + l.length + 1 + RULE.length + 1 > limit) {
      pages.push(cur.join("\n"));
      cur = [MASTER_CONT];
      len = MASTER_CONT.length;
    }
    cur.push(l);
    len += l.length + 1;
  }
  cur.push(RULE);
  pages.push(cur.join("\n"));
  return pages;
}
/** First page only (tests and callers that need one message). */
export function renderMaster(rows: Row[], now: number, dash: string, limit = 1900, gear = "⚙️", notice = ""): string {
  return renderMasterPages(rows, now, dash, limit, gear, notice).join("\n");
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
      if (!had || num(r.tsMs) >= num(had.tsMs)) out.set(key, r);
    } catch {}
  }
  return out;
}

export type MasterOpts = {
  getChannel: () => Promise<BoardChannel | null>;
  /** Board notice line below the head ("" = none); owner alert pause. */
  notice?: () => string;
  botId: () => string | undefined;
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
};

/** SuppressEmbeds (4) | SuppressNotifications (4096). */
const FLAGS = 4 | 4096;

export class MasterQueueBoard {
  private boards: BoardMsg[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastText = "";
  private lastEdit = 0;
  private force = false;
  private done: DoneJob[] = [];
  private readonly titles = new Map<number, Omit<LiveJob, "running" | "since">>();

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
    this.schedule(2500, true);
  }

  schedule(delay: number, force = false): void {
    if (force) this.force = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
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
    return [...botRows(this.o.jobs(), this.done, now, this.o.resolvers), ...cardRows(cards, readReceipts(this.o.receiptsDir), now, this.o.dash, this.o.resolvers), ...needsRows(cards, now, this.o.dash, menus)];
  }

  /** Open menus for the ✍️ Needs you section (empty without a menu source). */
  async openMenus(): Promise<MenuRow[]> {
    if (!this.o.menus) return [];
    return loadOpenMenus(this.o.menus, asItems(readCards(this.o.itemsFile) ?? [])).catch((e) => (this.o.log(`master queue menus: ${(e as Error).message}`), []));
  }

  async refresh(force = false): Promise<void> {
    const ch = await this.o.getChannel();
    if (!ch) return;
    const now = this.now();
    const pages = renderMasterPages(this.rows(await this.openMenus()), now, this.o.dash, 1900, WORKING_EMOJI, this.o.notice?.() ?? "");
    const text = pages.join("\n");
    // Lines 0-1 are the ━ rule and the head with the changing `updated <t:…:R>` stamp: compare the rows below them.
    const sameRows = text.split("\n").slice(2).join("\n") === this.lastText.split("\n").slice(2).join("\n");
    const fetched = await ch.messages.fetch({ limit: 40 }).catch(() => null);
    const recent = fetched ? [...fetched.values()] : []; // newest first
    const me = this.o.botId();
    const mine = recent.filter((m) => m.author.id === me && isMasterBoard(m.content));
    if (!this.boards.length) this.boards = [...mine].reverse(); // oldest first = page order
    const ids = new Set(this.boards.map((m) => m.id));
    const firstAt = this.boards.length ? recent.findIndex((m) => m.id === this.boards[0]!.id) : -1;
    // "Last": below the first page only its own pages and the ⏳ Queue box.
    const isLast = firstAt >= 0 && recent.slice(0, firstAt).every((m) => m.author.id === me && (ids.has(m.id) || this.o.mayBeBelow(m)));
    if (isLast && this.boards.length === pages.length) {
      if (!sameRows || force || now - this.lastEdit > 300_000) {
        for (let i = 0; i < pages.length; i++) await this.boards[i]!.edit({ content: pages[i]! }).catch((e) => this.o.log(`master queue edit: ${(e as Error).message}`));
        this.lastEdit = now;
      }
    } else {
      const fresh: BoardMsg[] = [];
      for (const pg of pages) {
        const m = await ch.send({ content: pg, flags: FLAGS, allowedMentions: { parse: [] } }).catch((e) => (this.o.log(`master queue post: ${(e as Error).message}`), null));
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
