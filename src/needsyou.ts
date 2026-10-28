/**
 * 🔔-needs-you (owner 2026-10-22, card needs-you-channel): one live "✍️ Needs you" board that stays the
 * LAST message of a post-only channel and lists every FIRSTMATE card that waits on the owner.
 * Source: the FIRSTMATE tracker items.json (read-only here; only `fm` writes it).
 * Optional: a one-line alert above the board when a card newly needs the owner.
 */
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { blockedTracks, ownerRoots } from "./blockers.ts";

export type FmItem = {
  id: string;
  t?: string;
  area?: string;
  stack?: string;
  s?: string;
  q?: string;
  src?: string;
  cts?: number;
  changed?: string;
  queued?: unknown;
  job?: string;
  blockedBy?: string | string[];
  ext?: string;
  /** Owner 2026-10-25 (card needs-you-action-gate): the concrete step(s) only the owner can do. */
  action?: string;
};

export const BOARD_HEAD = "✍️ **Needs you**";
/** Owner 2026-10-23: same style as the FIRSTMATE master board (━ bars around it, ——— under each section title). */
const RULE = "━━━━━━━━━━━━━━━━━━━━";
const SUB = "———————————";
export const isNeedsYouBoard = (text: string): boolean => text.startsWith(BOARD_HEAD) || text.startsWith(`${RULE}\n${BOARD_HEAD}`);

type Group = "waiting" | "open" | "blocked";
const GROUPS: { key: Group; title: string; emoji: string }[] = [
  { key: "waiting", title: "✍️ **Waiting on you**", emoji: "✍️" },
  { key: "open", title: "⚠️ **Open questions**", emoji: "⚠️" },
  { key: "blocked", title: "⛔ **Blocked on you**", emoji: "⛔" },
];

// Owner 2026-10-22: a row must open a message, never a bare channel.
const DISCORD_MSG = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;

/**
 * Owner 2026-10-25 (card needs-you-action-gate): a card is listed under Needs you ONLY when it waits on the owner
 * (waiting/open/blocked-with-link) AND names a concrete owner action (`action`) AND is not already answered/queued (📨).
 * Answered, partial, running, bot-blocked cards, the owner's own bug reports and FYIs are never listed.
 */
export const hasOwnerAction = (it: { action?: unknown; queued?: unknown }): boolean =>
  typeof it.action === "string" && it.action.trim() !== "" && !it.queued;

/** Which group a card belongs to, or null when it does not need the owner. */
export function needsYouGroup(it: FmItem): Group | null {
  if (!hasOwnerAction(it)) return null;
  if (it.s === "waiting" || it.s === "open") return it.s;
  if (it.s === "blocked" && (it.q || it.src)) return "blocked";
  return null;
}

/**
 * Action steps: one per line, or "a; b" (outside `code`), or "1. a 2. b" (only when the text starts with 1. / 1) and
 * the numbers run in order, so "by Oct 3. Then" stays one step). Each step is capped so the 🔗 link always fits.
 */
export const STEP_MAX = 300;
export function actionSteps(action: string): string[] {
  const cap = (x: string) => (x.length > STEP_MAX ? `${x.slice(0, STEP_MAX - 1).trimEnd()}…` : x);
  const out: string[] = [];
  for (const line of action.split(/\r?\n/)) {
    let parts: string[] = [];
    if (/^\s*1[.)]\s/.test(line)) {
      let rest = line.replace(/^\s*1[.)]\s*/, "");
      for (let n = 2; ; n++) {
        const m = new RegExp(`\\s${n}[.)]\\s`).exec(rest);
        if (!m) break;
        parts.push(rest.slice(0, m.index));
        rest = rest.slice(m.index + m[0].length);
      }
      parts.push(rest);
    } else {
      // "; " splits steps only outside backticks.
      let cur = "", tick = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (c === "`") tick = !tick;
        if (!tick && c === ";" && /\s/.test(line[i + 1] ?? "")) { parts.push(cur); cur = ""; continue; }
        cur += c;
      }
      parts.push(cur);
    }
    for (const x of parts) { const t = x.replace(/^\s*[-*•]\s+/, "").trim(); if (t) out.push(cap(t)); }
  }
  return out.slice(0, 6);
}

/**
 * Owner 2026-10-25 (later): no ━ bars between items and no "YOUR ACTION" label; one 🏃 line per item, then steps and link.
 */
export function actionBlock(title: string, steps: string[], link: string): string {
  const s = steps.map((x, i) => `${i + 1}. ${x}`).join(" ");
  return [`🏃 ${title}`, ...(s ? [`👉 ${s}`] : []), ...(link ? [`🔗 [Open](<${link}>)`] : [])].join("\n");
}

/** The row link: the open question (q), then the source message (src), then the dashboard card. */
export function itemLink(it: Pick<FmItem, "id" | "q" | "src">, dash: string): string {
  if (it.q && DISCORD_MSG.test(it.q)) return it.q;
  if (it.src && DISCORD_MSG.test(it.src)) return it.src;
  return dash ? `${dash}?item=${encodeURIComponent(it.id)}` : "";
}

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * Finance card: area "finance" or "Finance: …" (fm-spawn and the router map both to the finance stack), or stack
 * finance. Its title never goes to Discord (it can carry positions or account data).
 */
export const isFinanceCard = (it: { area?: string; stack?: string }): boolean =>
  it.stack === "finance" || /^finance\s*(?::|$)/.test((it.area ?? "").trim().toLowerCase());
const isFinance = (it: FmItem) => isFinanceCard(it);

function shortTitle(it: FmItem): string {
  // Finance cards: link only, never the title (it can carry positions or account data).
  if (isFinance(it)) return `Finance card: ${linkLabel(it.id)}`; // 💹 goes outside the link (owner 2026-10-23)
  return linkLabel(it.t ?? it.id);
}

/**
 * Owner 2026-10-22: some rows showed raw markdown on the phone. A masked-link label must not contain
 * brackets, parentheses, angle brackets, markdown markers or URLs/domains (Discord then shows the raw text).
 */
export function linkLabel(raw: string): string {
  const t = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    // Keep the site name readable ("example.com/b" -> "example"); Discord will not mask a label that holds a domain.
    .replace(/\b(?:www\.)?([\w-]+)(?:\.[\w-]+)*\.(?:com|net|org|io|dev|ai|app|sh|gg)\b\S*/gi, "$1")
    .replace(/[[\]()<>`*_~|\\]/g, " ")
    // Owner 2026-10-23: a label with an emoji (or ·) rendered as raw markdown on iOS; keep labels plain text.
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, " ")
    .replace(/\s·\s/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
  return t.length > 70 ? `${t.slice(0, 69).trimEnd()}…` : t || "card";
}

/** asks.json subset (src/ask.ts AskSet). */
export type AskSetLite = {
  setId: string;
  channelId: string;
  questions: { id: string; question: string }[];
  answers?: Record<string, string[]>;
  createdAt: number;
  messageIds?: Record<string, string>;
  sourceId?: string;
  answered?: boolean;
  responded?: Record<string, unknown>;
};
/** Channel lookup: null = deleted/unknown. */
export type ChanInfo = { name: string; archived: boolean; finance: boolean } | null;
/** `source`: link to the owner's request the menu answers (owner 2026-10-23). */
export type MenuRow = { key: string; label: string; link: string; createdAt: number; source?: string };

/**
 * Owner 2026-10-22: open question menus without a tracker card. One row per unanswered question that has a
 * posted menu; newest set first; skips menus a card links (q/src), and archived or deleted channels.
 */
export function openMenus(sets: AskSetLite[], items: FmItem[], chans: Map<string, ChanInfo>, guildId: string, dismissed: Set<string> = new Set()): MenuRow[] {
  const linked = new Set<string>(dismissed); // owner 2026-10-22: menus the owner cleared stay off the board
  for (const it of items) for (const u of [it.q, it.src]) if (u) { const m = /\/(\d+)\/?$/.exec(u); if (m?.[1]) linked.add(m[1]); }
  const rows: MenuRow[] = [];
  for (const s of [...sets].sort((a, b) => b.createdAt - a.createdAt)) {
    const ch = chans.get(s.channelId);
    if (!ch || ch.archived || s.answered) continue; // owner 2026-10-25: any owner response hides the menu at once
    s.questions.forEach((q, i) => {
      const mid = s.messageIds?.[String(i)];
      if (!mid || s.answers?.[q.id]?.length || s.responded?.[String(i)] || linked.has(mid)) return;
      const label = ch.finance ? `Finance question: ${linkLabel(ch.name.replace(/^[^\w]+-?/u, ""))}` : linkLabel(q.question);
      const source = s.sourceId ? { source: `https://discord.com/channels/${guildId}/${s.channelId}/${s.sourceId}` } : {};
      rows.push({ key: `${s.setId}/${q.id}`, label, link: `https://discord.com/channels/${guildId}/${s.channelId}/${mid}`, createdAt: s.createdAt, ...source });
    });
  }
  return rows;
}

export function readAskSets(file: string): AskSetLite[] {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { sets?: unknown };
    return Array.isArray(d.sets) ? (d.sets as AskSetLite[]).filter((s) => s && typeof s.channelId === "string" && Array.isArray(s.questions)) : [];
  } catch {
    return [];
  }
}

/** Where open menus come from: asks.json, a channel lookup, and the owner's dismissed list next to asks.json. */
export type MenuSource = { asksFile: string; chanInfo: (id: string) => Promise<ChanInfo>; guildId: string };

/** Open question menus for `items` (both boards call this, owner 2026-10-24, card mq-needs-menus). */
export async function loadOpenMenus(src: MenuSource, items: FmItem[]): Promise<MenuRow[]> {
  const sets = readAskSets(src.asksFile);
  const chans = new Map<string, ChanInfo>();
  for (const id of new Set(sets.map((s) => s.channelId))) chans.set(id, await src.chanInfo(id).catch(() => null));
  let dismissed = new Set<string>();
  try { dismissed = new Set((JSON.parse(readFileSync(join(dirname(src.asksFile), "needsyou-dismissed.json"), "utf8")) as string[]).map(String)); } catch { /* none */ }
  return openMenus(sets, items, chans, src.guildId, dismissed);
}

export type NeedsEntry = { kind: "menu"; menu: MenuRow } | { kind: "card"; group: Group; item: FmItem; unblocks: number };

/**
 * Owner 2026-10-24 (card mq-needs-menus): THE list of what needs the owner. The 🔔 Needs-you board and the 📋 Master
 * queue both render from it, so they cannot differ. Open menus first (newest set first), then cards by group
 * (waiting, open, blocked; oldest first). A menu that a card links (q/src) is already left out by openMenus, so it
 * shows once, as the card. The "Waiting on bots / outside / Blocker unclear" summaries are not in this list.
 */
export function needsYouEntries(items: FmItem[], menus: MenuRow[]): NeedsEntry[] {
  const out: NeedsEntry[] = menus.map((menu) => ({ kind: "menu", menu }));
  const picked = items.filter((it) => needsYouGroup(it));
  // Owner 2026-10-23 (blocker-tracks): a card blocked by another card counts as "on you" only when its chain ends
  // at an owner question; the row links that ROOT question and says how many cards it unblocks.
  const roots = new Map(ownerRoots(items).map((r) => [r.root.id, r.unblocks.length]));
  const tracks = blockedTracks(items);
  for (const g of GROUPS) {
    let rows = picked.filter((it) => needsYouGroup(it) === g.key && (g.key === "blocked" || !roots.has(it.id))); // roots list once, under Blocked
    if (g.key === "blocked") {
      rows = rows.filter((it) => !tracks.some((t) => t.item.id === it.id)); // chained cards are listed by their root
      for (const id of roots.keys()) { const r = items.find((i) => i.id === id); if (r && !rows.includes(r)) rows.push(r); }
    }
    rows.sort((a, b) => (a.cts ?? 0) - (b.cts ?? 0));
    for (const item of rows) out.push({ kind: "card", group: g.key, item, unblocks: roots.get(item.id) ?? 0 });
  }
  return out;
}

/** One card as an action block (owner 2026-10-25). Finance cards: no title or steps on Discord, link only. */
export function needsYouRow(it: FmItem, emoji: string, now: number, dash: string): string {
  const link = itemLink(it, dash);
  const when = it.cts ? ` · ${age(now - it.cts)}` : "";
  const title = `${isFinance(it) ? "💹 " : ""}${shortTitle(it)}${when}`;
  const steps = isFinance(it) ? ["Open the finance card and do the step it names."] : actionSteps(it.action ?? "");
  void emoji;
  return actionBlock(title, steps, link);
}

/** Board text (≤ 2000 chars): grouped rows, oldest first in each group; empty state when nothing waits. */
export function renderNeedsYou(items: FmItem[], now: number, dash: string, limit = 1900, menus: MenuRow[] = [], notice = ""): string {
  // Board notice (owner alert pause, src/alertpause.ts) is part of the head, so it is never cut.
  const head = `${RULE}\n${BOARD_HEAD} · updated <t:${Math.floor(now / 1000)}:R>${notice ? `\n${notice}` : ""}`;
  limit -= RULE.length + 1;
  const dashLine = dash ? `📋 [Dashboard: Needs you](<${dash}?tab=needs>)` : "";
  const entries = needsYouEntries(items, menus);
  if (!entries.length && !blockedTracks(items).length) return [head, SUB, "✅ Nothing needs you right now.", dashLine, RULE].filter(Boolean).join("\n");
  const lines = [head];
  let hidden = 0;
  let hiddenMenus = 0;
  // Open menus first (owner 2026-10-22): they have no dashboard card, so only cards may overflow to the dashboard.
  if (menus.length) {
    lines.push("\u200b", `❓ **Open menus** (${menus.length})`, SUB);
    for (const e of entries) {
      if (e.kind !== "menu") continue;
      const m = e.menu;
      // Owner 2026-10-23: the request the menu answers; plain link label, emoji outside the brackets.
      const title = `${m.label.startsWith("Finance question") ? "💹 " : ""}${m.label.length > 60 ? `${m.label.slice(0, 59).trimEnd()}…` : m.label} · ${age(now - m.createdAt)}`;
      const row = actionBlock(title, [], m.link) + (m.source ? `\n↩️ [request](<${m.source}>)` : "");
      if ([...lines, row, dashLine].join("\n").length > limit - 60) hiddenMenus++;
      else lines.push(row);
    }
  }
  const tracks = blockedTracks(items);
  for (const g of GROUPS) {
    const rows = entries.filter((e): e is Extract<NeedsEntry, { kind: "card" }> => e.kind === "card" && e.group === g.key);
    if (!rows.length) continue;
    lines.push("\u200b", `${g.title} (${rows.length})`, SUB);
    for (const { item: it, unblocks: n } of rows) {
      const row = needsYouRow(it, g.emoji, now, dash) + (n ? `\n🔓 unblocks ${n} card${n === 1 ? "" : "s"}` : "");
      if ([...lines, row, dashLine].join("\n").length > limit - 40) hidden++;
      else lines.push(row);
    }
    if (lines[lines.length - 1] === SUB && lines[lines.length - 2]?.startsWith(g.title)) lines.splice(-3, 3); // no row fitted: no empty header
  }
  // Not on the owner: one collapsed line each, no action implied.
  const other = (cls: string) => tracks.filter((t) => !t.roots.some((l) => l.cls === "owner") && t.roots.some((l) => l.cls === cls));
  const names = (cls: string, ts: ReturnType<typeof other>) =>
    [...new Set(ts.flatMap((t) => t.roots.filter((l) => l.cls === cls).map((l) => l.item?.job ?? l.id)))].slice(0, 6).map((x) => linkLabel(x)).join(", ");
  for (const [cls, title] of [["bot", "⏳ Waiting on bots"], ["external", "🌐 Waiting on outside"], ["unknown", "❔ Blocker unclear"]] as const) {
    const ts = other(cls);
    const row = `${title} (${ts.length}): ${names(cls, ts)}`;
    if (ts.length && [...lines, row, dashLine].join("\n").length <= limit - 40) lines.push("\u200b", row);
  }
  lines.push("\u200b");
  if (hidden) lines.push(`➕ ${hidden} more on the dashboard`);
  if (hiddenMenus) lines.push(`➕ ${hiddenMenus} more open menus (board is full; answer the menus above first)`);
  if (dashLine) lines.push(dashLine);
  lines.push(RULE);
  return lines.join("\n");
}

/** Cards that newly need the owner since `prev` (id → group). One alert per card per state change. */
export function newlyNeeding(items: FmItem[], prev: Record<string, string>): FmItem[] {
  return items.filter((it) => {
    const g = needsYouGroup(it);
    return g !== null && prev[it.id] !== g && (g === "waiting" || g === "open");
  });
}

export function snapshot(items: FmItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    const g = needsYouGroup(it);
    if (g) out[it.id] = g;
  }
  return out;
}

export function readItems(file: string): FmItem[] | null {
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as { items?: unknown };
    return Array.isArray(d.items) ? (d.items as FmItem[]).filter((x) => x && typeof x.id === "string") : null;
  } catch {
    return null; // mid-write or missing: keep the last board
  }
}

/** Minimal Discord surface (discord.js Message/TextChannel), so tests can use fakes. */
export type BoardMsg = { id: string; content: string; author: { id: string }; edit(o: { content: string }): Promise<unknown>; delete(): Promise<unknown> };
export type BoardChannel = {
  send(o: { content: string; flags?: number; allowedMentions?: { parse: [] } }): Promise<BoardMsg>;
  messages: { fetch(o: { limit: number }): Promise<Map<string, BoardMsg> | { values(): IterableIterator<BoardMsg> }> };
};

/** SuppressEmbeds (4) | SuppressNotifications (4096). */
const FLAGS = 4 | 4096;

export type NeedsYouOpts = {
  getChannel: () => Promise<BoardChannel | null>;
  botId: () => string | undefined;
  itemsFile: string;
  stateFile: string;
  dash: string;
  log: (s: string) => void;
  now?: () => number;
  alerts?: boolean;
  /** asks.json path plus channel lookup for the ❓ Open menus group. */
  asksFile?: string;
  chanInfo?: (id: string) => Promise<ChanInfo>;
  guildId?: string;
  /** Owner user id: an owner message or reaction in the channel marks earlier alerts as seen. */
  ownerId?: string;
  /** Board notice line below the head ("" = none); owner alert pause. */
  notice?: () => string;
  /** True while owner alerts are paused: the 🔔 alert lines are not sent (the board still lists the cards). */
  paused?: () => boolean;
};

/**
 * Owner 2026-10-23: "🔔 Needs you" alerts must not pile up. Bots cannot read Discord read state, so an alert counts as
 * SEEN when the owner posts or reacts in the channel after it, the card left the group it was alerted for (answered,
 * queued, done), or 30 min passed. A seen alert is deleted; the board stays the only list. The push already happened.
 */
export const ALERT_TTL_MS = 30 * 60_000;
export type AlertRec = { id: string; card: string; group: string; at: number };
export function seenAlerts(alerts: AlertRec[], items: FmItem[], now: number, ownerSeenAt: number): AlertRec[] {
  const group = new Map(items.map((i) => [i.id, needsYouGroup(i)]));
  return alerts.filter((a) => now - a.at >= ALERT_TTL_MS || ownerSeenAt > a.at || group.get(a.card) !== a.group);
}
export const isAlert = (text: string): boolean => text.startsWith("🔔 ");

export class NeedsYouBoard {
  private board: BoardMsg | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastText = "";
  private lastEdit = 0;
  private ownerSeenAt = 0;
  constructor(private o: NeedsYouOpts) {}
  private get alertsFile(): string {
    return join(dirname(this.o.stateFile), "needs-you-alerts.json");
  }
  private loadAlerts(): AlertRec[] {
    try { return JSON.parse(readFileSync(this.alertsFile, "utf8")) as AlertRec[]; } catch { return []; }
  }
  /** Owner reacted in the channel: earlier alerts count as seen. */
  onReaction(userId: string): void {
    if (this.o.ownerId && userId !== this.o.ownerId) return;
    this.ownerSeenAt = (this.o.now ?? Date.now)();
    this.schedule(1200);
  }

  /** Watch items.json (debounced) plus a 60 s poll; first refresh finds/cleans old boards. */
  start(): void {
    this.schedule(0);
    try {
      this.watcher = watch(join(this.o.itemsFile, ".."), (_e, f) => {
        if (!f || String(f).startsWith("items.json")) this.schedule(1500);
      });
    } catch (e) {
      this.o.log(`needs-you watch: ${(e as Error).message}`);
    }
    this.poll = setInterval(() => this.schedule(0), 60_000);
  }
  stop(): void {
    this.watcher?.close();
    clearInterval(this.poll ?? undefined);
    clearTimeout(this.timer ?? undefined);
  }
  /** A message landed in the channel (alert, owner): move the board back to the bottom. */
  onMessage(m: { content: string; author: { id: string } }): void {
    if (m.author.id === this.o.botId() && isNeedsYouBoard(m.content)) return;
    if (m.author.id !== this.o.botId() && (!this.o.ownerId || m.author.id === this.o.ownerId)) this.ownerSeenAt = (this.o.now ?? Date.now)();
    this.schedule(1200, true);
  }
  private force = false;
  schedule(delay: number, force = false): void {
    if (force) this.force = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
      const f = this.force;
      this.force = false;
      this.chain = this.chain.then(() => this.refresh(f)).catch((e) => this.o.log(`needs-you: ${(e as Error).message}`));
    }, delay);
  }
  /** Settled when the queued refresh finished (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private loadState(): Record<string, string> | null {
    if (!existsSync(this.o.stateFile)) return null;
    try {
      return JSON.parse(readFileSync(this.o.stateFile, "utf8")) as Record<string, string>;
    } catch {
      return null;
    }
  }

  async refresh(force = false): Promise<void> {
    const items = readItems(this.o.itemsFile);
    if (!items) return;
    const ch = await this.o.getChannel();
    if (!ch) return;
    const now = (this.o.now ?? Date.now)();
    const newAlerts: AlertRec[] = [];
    if (this.o.alerts !== false) {
      const prev = this.loadState();
      const snap = snapshot(items);
      // Paused: the snapshot still advances, so the pause end does not send every card that changed meanwhile.
      if (prev && !this.o.paused?.()) {
        for (const it of newlyNeeding(items, prev)) {
          const g = needsYouGroup(it)!;
          const line = `🔔 ${g === "open" ? "New question" : "Needs you"}: ${needsYouRow(it, g === "open" ? "⚠️" : "✍️", now, this.o.dash)}`;
          const sent = await ch.send({ content: line, flags: 4, allowedMentions: { parse: [] } }).catch((e) => (this.o.log(`needs-you alert: ${(e as Error).message}`), null));
          if (sent) newAlerts.push({ id: sent.id, card: it.id, group: g, at: now });
          force = true;
        }
      }
      if (JSON.stringify(prev) !== JSON.stringify(snap)) writeFileSync(this.o.stateFile, JSON.stringify(snap));
      // Record new alerts at once, so a failed board post below cannot leave them untracked (then deleted).
      if (newAlerts.length) writeFileSync(this.alertsFile, JSON.stringify([...this.loadAlerts(), ...newAlerts]));
    }
    const menus = this.o.asksFile && this.o.chanInfo ? await loadOpenMenus({ asksFile: this.o.asksFile, chanInfo: this.o.chanInfo, guildId: this.o.guildId ?? "" }, items) : [];
    const text = renderNeedsYou(items, now, this.o.dash, 1900, menus, this.o.notice?.() ?? "");
    const sameRows = text.split("\n").slice(2).join("\n") === this.lastText.split("\n").slice(2).join("\n");
    const fetched = await ch.messages.fetch({ limit: 30 }).catch(() => null);
    const recent = fetched ? [...fetched.values()] : [];
    const me = this.o.botId();
    // After a restart: adopt the newest old board.
    if (!this.board) this.board = recent.find((m) => m.author.id === me && isNeedsYouBoard(m.content)) ?? null;
    const isLast = !!this.board && recent[0]?.id === this.board.id;
    if (this.board && isLast) {
      // Rows unchanged: refresh ages only every 10 min (saves API calls on the 60 s poll).
      if (!sameRows || force || now - this.lastEdit > 600_000) {
        await this.board.edit({ content: text }).catch((e) => this.o.log(`needs-you edit: ${(e as Error).message}`));
        this.lastEdit = now;
      }
    } else {
      const fresh = await ch.send({ content: text, flags: FLAGS, allowedMentions: { parse: [] } }).catch((e) => (this.o.log(`needs-you post: ${(e as Error).message}`), null));
      if (!fresh) return;
      await this.board?.delete().catch(() => {});
      this.board = fresh;
      this.lastEdit = now;
    }
    this.lastText = text;
    // Never leave two boards.
    for (const m of recent) if (m.id !== this.board.id && m.author.id === me && isNeedsYouBoard(m.content)) await m.delete().catch(() => {});
    // Seen alerts go; untracked old alerts (before this feature, or a lost record) go too.
    const alerts = this.loadAlerts();
    const gone = new Set(seenAlerts(alerts, items, now, this.ownerSeenAt).map((a) => a.id));
    const tracked = new Set(alerts.map((a) => a.id));
    for (const m of recent) if (m.author.id === me && isAlert(m.content) && (gone.has(m.id) || !tracked.has(m.id))) { await m.delete().catch(() => {}); gone.add(m.id); }
    const keep = alerts.filter((a) => !gone.has(a.id) && now - a.at < 2 * ALERT_TTL_MS);
    if (keep.length || existsSync(this.alertsFile)) writeFileSync(this.alertsFile, JSON.stringify(keep));
  }
}
