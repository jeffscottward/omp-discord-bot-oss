/**
 * 🚧 Main blocker (owner 2026-11-04, card mq-main-blocker): when one thing (usually CI) holds up many jobs, the
 * 📋 Master queue and the FIRSTMATE dashboard name it at the top, so the owner sees why items sit for hours.
 *
 * Blocker sources, computed on each board render (no API calls here; every source is a local file):
 *   ci   = card jobs that wait on a GitHub/GitLab run: fm-overseer's overseer.json + ci-cache.json (run status,
 *          created time, URL), plus cards whose blocked receipt names CI ("waiting on CI: PR #N, run <url> ...").
 *          Grouped per repository.
 *   cap  = fm-spawn's queue (~/.local/state/fm-spawn/queued.jsonl), named by fm-spawn's own reason from
 *          `fm-spawn --drain-queue --dry-run` (workspace over the tab cap, stack full, claims held, paused).
 *   bot  = bot jobs queued behind running ones (src/queue.ts).
 *   card = the root of a card's blockedBy chain (src/blockers.ts roots), e.g. a running card that 4 cards wait for.
 *          A parked card (backlog, not a gate; blockers.ts parked) is never a root and never listed (owner 2026-11-05,
 *          card mainblocker-backlog). A backlog gate card (e.g. webapp-ui-pause) still is. fm-autoclear R17 checks
 *          that every card row has an owner action link or a live job.
 * Each blocker holds up its direct waiters plus every unfinished card that waits for them (transitively through
 * blockedBy). A card root that itself waits on CI or a stack queue is not listed twice: the CI/queue blocker holds it.
 *
 * A blocker shows when it holds up >= MIN_HELD jobs or its oldest waiter waits > MIN_WAIT_MS. The board shows the
 * largest one as a ranked "🚧 Blockers" list (top 3, one line shape); nothing shows when none qualifies.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { edges, openRefs, roots } from "./blockers.ts";
import { safeTitle } from "./mention.ts";
import { isFinanceCard, linkLabel } from "./needsyou.ts";
import { safeSubject } from "./router.ts";
import { age, asItems, cardLink, cardStack, KEEP_FINISHED_MS, type FmCard, type LiveJob, type Receipt, type Resolvers } from "./masterqueue.ts";

export const MIN_HELD = 3;
export const MIN_WAIT_MS = 60 * 60_000;
export const MAX_SHOWN = 3;
/** overseer.json older than this is not used (fm-overseer runs every minute). */
export const OVERSEER_STALE_MS = 10 * 60_000;

export type BlockerKind = "ci" | "cap" | "bot" | "card";
export type Blocker = { key: string; kind: BlockerKind; name: string; link?: string; /** Link text; default by kind. */ linkLabel?: string; held: number; heldIds: string[]; since: number };
/** A run one card waits on: GitHub Actions run id or GitLab pipeline id (`kind`). */
export type CiWait = { card: string; repo: string; ref: string; status: string; created?: number; url?: string; kind?: "gh" | "gl" };
/** Live state of one run (fm-overseer ci-cache.json entry, or RunStatus). */
export type RunInfo = { status?: string; created?: number; url?: string; at?: number; /** Last lookup attempt (RunStatus). */ tried?: number };
export type SpawnEntry = { id?: string; card?: string; stack?: string; tsMs?: number; label?: string; workspace?: string };
/** What `fm-spawn --drain-queue --dry-run` says about its queue (parseDrainDry). */
export type DrainVerdict = { paused: boolean; tabCapped: string[]; maxTabs: number; willStart: string[]; claimWait: string[] };
export type BlockerData = {
  cards: FmCard[];
  receipts: Map<string, Receipt>;
  now: number;
  dash: string;
  ci?: CiWait[];
  spawnQueue?: SpawnEntry[];
  caps?: Record<string, number>;
  /** Live bot jobs (running + queued). */
  jobs?: LiveJob[];
  res?: Resolvers;
  /**
   * Live run state by "gh:<repo>:<id>" / "gl:<repo>:<id>". A run named in a blocked receipt counts only when this
   * says it is still queued or running: receipts keep their text after the run finished.
   */
  runInfo?: (key: string) => RunInfo | undefined;
  /** fm-spawn's own verdict on its queue; names the queue blocker (tab cap, stack full, ...). */
  drain?: DrainVerdict;
};

/** Runs that blocked receipts wait on (cards not running; receipts of the last 12 h); status still unverified. */
export function receiptRuns(cards: FmCard[], receipts: Map<string, Receipt>, now: number): CiWait[] {
  const out: CiWait[] = [];
  for (const c of cards) {
    if (!WAITS.has(c.s ?? "") || c.s === "running") continue; // a running card's own CI comes from fm-overseer
    const r = receipts.get(c.id);
    if (r?.result !== "blocked" || now - num(r.tsMs) >= KEEP_FINISHED_MS) continue;
    const w = receiptCi(c.id, String(r.summary ?? ""), num(r.tsMs) || now);
    if (w) out.push(w);
  }
  return out;
}

/** Card states that wait (an unfinished job: running, queued or blocked). Backlog and owner cards are not jobs. */
const WAITS = new Set(["running", "partial", "planned", "blocked"]);
/** Run states that still hold a job up (GitHub status, GitLab pipeline status, fm-overseer QUEUED_ST). */
const ACTIVE_RUN = new Set(["queued", "pending", "waiting", "created", "requested", "waiting_for_resource", "preparing", "scheduled", "in_progress", "running"]);
const QUEUED_RUN = new Set(["queued", "pending", "waiting", "created", "requested", "waiting_for_resource", "preparing", "scheduled"]);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

const GH_RUN = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)/;
const GL_PIPE = /https?:\/\/[^/\s]+\/([^\s]+?)\/-\/pipelines\/(\d+)/;
/** A wait on CI, not a passing mention ("CI 500 green", "hosted-only CI"): a wait word before CI, or a queue state after it. */
const CI_WAIT = /\b(waiting on|waits? (?:for|on)|queued|pending|blocked on)\b[^.;]{0,60}\b(CI|pipeline|runners?)\b|\b(CI|pipeline|run)\b[^.;]{0,15}\b(queued|pending|waiting)\b|\brunner queue\b/i;

/**
 * The CI run a blocked receipt waits on ("waiting on CI: PR #N, run <url>, ..."), or null. Only a GitHub Actions run
 * or GitLab pipeline URL counts: its live status can be checked (RunStatus). A PR link alone or no URL gives no CI
 * blocker. `status` stays "unknown" until runInfo says otherwise.
 */
export function receiptCi(card: string, summary: string, at: number): CiWait | null {
  if (!CI_WAIT.test(summary)) return null;
  const gh = GH_RUN.exec(summary);
  if (gh) return { card, kind: "gh", repo: gh[1]!, ref: gh[2]!, status: "unknown", created: at, url: gh[0] };
  const gl = GL_PIPE.exec(summary);
  if (gl) return { card, kind: "gl", repo: gl[1]!, ref: gl[2]!, status: "unknown", created: at, url: gl[0] };
  return null;
}

/** Name of a card as the board may show it (finance cards: subject only; no markdown or pings from titles). */
function cardName(c: FmCard | undefined, id: string): string {
  if (!c) return id;
  return isFinanceCard(c) ? safeSubject(c.t, c.id) : linkLabel(safeTitle(c.t ?? c.id, c.id, c.id));
}
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export function findBlockers(d: BlockerData): Blocker[] {
  const { cards, receipts, now, dash } = d;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const items = asItems(cards);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const e = edges(items);
  const waits = (id: string) => WAITS.has(byId.get(id)?.s ?? "");
  // Reverse open-blocker edges among waiting cards: ref -> cards that wait for it.
  const rev = new Map<string, string[]>();
  for (const i of items) {
    if (!waits(i.id)) continue;
    for (const r of openRefs(i, itemById, now, e)) rev.set(r, [...(rev.get(r) ?? []), i.id]);
  }
  const dependents = (start: string[]): Set<string> => {
    const out = new Set<string>();
    const todo = [...start];
    while (todo.length) {
      const x = todo.pop()!;
      for (const y of rev.get(x) ?? []) if (!out.has(y)) { out.add(y); todo.push(y); }
    }
    return out;
  };
  // Since when a card waits: its blocked receipt, else the last card change.
  const waitSince = (id: string): number => {
    const r = receipts.get(id);
    if (r?.result === "blocked" && num(r.tsMs)) return num(r.tsMs);
    return num(byId.get(id)?.cts) || now;
  };
  // Candidates in credit order (CI, then stack queue, then bot queue, then card roots). Each held card counts for ONE
  // blocker only (the first that holds it), so "holds up N" never counts a job twice.
  const cands: { key: string; kind: BlockerKind; name: string; link?: string; linkLabel?: string; direct: string[]; held: Set<string>; since: number }[] = [];
  const make = (key: string, kind: BlockerKind, name: string, link: string | undefined, direct: string[], since: number, linkLabel?: string) => {
    const held = new Set<string>(direct);
    for (const x of dependents(direct)) held.add(x);
    cands.push({ key, kind, name, ...(link ? { link } : {}), ...(linkLabel ? { linkLabel } : {}), direct, held, since });
  };

  // ci: overseer runs + blocked receipts that name CI, one blocker per repository.
  const ciWaits: CiWait[] = [];
  for (const w of d.ci ?? []) if (waits(w.card) && ACTIVE_RUN.has(w.status)) ciWaits.push(w);
  for (const w of receiptRuns(cards, receipts, now)) {
    if (ciWaits.some((x) => x.card === w.card)) continue;
    const info = d.runInfo?.(`${w.kind}:${w.repo}:${w.ref}`);
    if (!info?.status || !ACTIVE_RUN.has(info.status)) continue; // finished or not checked yet: no blocker
    ciWaits.push({ ...w, status: info.status, created: info.created ?? w.created, url: info.url ?? w.url });
  }
  const ciCards = new Set(ciWaits.map((w) => w.card));
  const byRepo = new Map<string, CiWait[]>();
  for (const w of ciWaits) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w]);
  for (const [repo, ws] of byRepo) {
    const runs = [...new Map(ws.map((w) => [w.ref, w])).values()];
    const queued = runs.filter((w) => QUEUED_RUN.has(w.status)).length;
    const label = repo.split("/").pop() || repo;
    const name = runs.length === 1
      ? `CI run ${label} #${runs[0]!.ref} (${QUEUED_RUN.has(runs[0]!.status) ? "queued" : "running"})`
      : `CI ${label}: ${[queued ? `${queued} run${queued === 1 ? "" : "s"} queued` : "", runs.length - queued ? `${runs.length - queued} running` : ""].filter(Boolean).join(", ")}`;
    const oldest = [...ws].sort((a, b) => (a.created ?? now) - (b.created ?? now));
    const link = (oldest.find((w) => w.url && QUEUED_RUN.has(w.status)) ?? oldest.find((w) => w.url))?.url;
    make(`ci:${repo}`, "ci", name, link, [...new Set(ws.map((w) => w.card))], Math.min(...ws.map((w) => w.created ?? now)));
  }

  // cap: fm-spawn's queue, grouped by the reason fm-spawn itself gives (`fm-spawn --drain-queue --dry-run`, DrainVerdict):
  // agent work paused, workspace over the tab cap, claims held, else the stack is full. Entries it would start now
  // wait for nothing. Without a verdict the line says "<stack> spawn queue" and claims no reason.
  const queuedCards = new Set<string>();
  const v = d.drain;
  const groups = new Map<string, { name: string; link?: string; linkLabel?: string; direct: Set<string>; since: number }>();
  const add = (key: string, name: string, link: string | undefined, id: string, at: number, linkLabel?: string) => {
    const g = groups.get(key) ?? { name, ...(link ? { link } : {}), ...(linkLabel ? { linkLabel } : {}), direct: new Set<string>(), since: now };
    g.direct.add(id);
    g.since = Math.min(g.since, at);
    groups.set(key, g);
  };
  const queueLink = dash ? `${dash}?tab=running` : undefined;
  const queueCardIds = new Set((d.spawnQueue ?? []).map((q) => q.card));
  for (const q of d.spawnQueue ?? []) {
    const c = q.card ? byId.get(q.card) : undefined;
    // Done/backlog cards leave the queue on the next drain; a card that already runs no longer waits for a slot.
    if (c && (!WAITS.has(c.s ?? "") || c.s === "running")) continue;
    if (v?.willStart.includes(q.label ?? "")) continue;
    const id = q.card ?? `queue:${q.id ?? q.label ?? "?"}`;
    const at = num(q.tsMs) || now;
    queuedCards.add(id);
    const stack = q.stack ?? "firstmate";
    const ws = q.workspace ?? (v?.tabCapped.length === 1 ? v.tabCapped[0] : undefined);
    if (v?.paused) add("cap:paused", "Agent work paused (fm-spawn starts no queued job)", queueLink, id, at);
    else if (v?.claimWait.includes(q.label ?? "")) add("cap:claims", "Claims held by other jobs (queued jobs wait)", queueLink, id, at);
    else if (ws && v?.tabCapped.includes(ws)) {
      const card = byId.get(`fm-tabcap-${ws}`);
      add(`cap:tabs:${ws}`, `Herdr workspace ${ws} over ${v.maxTabs} tabs (fm-spawn starts no queued job)`, card ? cardLink(card, dash) : queueLink, id, at, card ? "card" : undefined);
    } else if (v) {
      // fm-spawn keeps a slot for a running card and for a card whose receipt waits on CI; queue entries hold none.
      const cap = d.caps?.[stack];
      const slotsOnCi = cards.filter((x) => ciCards.has(x.id) && !queueCardIds.has(x.id) && cardStack(x, d.res) === stack).length;
      add(`cap:${stack}`, `${stack} stack full${cap ? `, max ${cap} jobs` : ""}${slotsOnCi ? `, ${slotsOnCi} slot${slotsOnCi === 1 ? "" : "s"} wait on CI` : ""}`, queueLink, id, at);
    } else add(`cap:${stack}`, `${stack} spawn queue`, queueLink, id, at);
  }

  // bot: owner bot jobs that wait in the bot's own queue.
  const botQ = (d.jobs ?? []).filter((j) => j.state === "queued");
  if (botQ.length) {
    const running = (d.jobs ?? []).filter((j) => j.state === "running").length;
    const oldest = [...botQ].sort((a, b) => a.since - b.since)[0]!;
    make("bot:queue", "bot", `Bot job queue (${running} running)`, oldest.link, botQ.map((j) => `job:${j.id}`), oldest.since);
  }

  // card: roots of blockedBy chains. A root that waits on CI or a stack queue is held by that blocker instead.
  const held = new Map<string, { direct: Set<string>; since: number }>();
  for (const i of items) {
    if (!waits(i.id) || !openRefs(i, itemById, now, e).length) continue;
    for (const l of roots(i.id, itemById, now)) {
      if (l.chain.length < 2 || ciCards.has(l.id) || queuedCards.has(l.id)) continue;
      // The tab-cap card (fm-tabcap-<ws>) and the tab-cap queue blocker are one blocker: its waiters join the queue one.
      const tabs = /^fm-tabcap-(.+)$/.exec(l.id);
      const tg = tabs ? groups.get(`cap:tabs:${tabs[1]}`) : undefined;
      if (tg) {
        tg.direct.add(l.chain[l.chain.length - 2]!);
        tg.since = Math.min(tg.since, waitSince(l.chain[l.chain.length - 2]!));
        continue;
      }
      const h = held.get(l.id) ?? { direct: new Set<string>(), since: now };
      // Only the card right below the root waits for it directly; dependents() adds the rest.
      h.direct.add(l.chain[l.chain.length - 2]!);
      // "Oldest waiting" = how long the card right below the root waits; a deeper card can have waited longer for
      // other reasons before this root held it.
      h.since = Math.min(h.since, waitSince(l.chain[l.chain.length - 2]!));
      held.set(l.id, h);
    }
  }
  for (const [key, g] of groups) make(key, "cap", g.name, g.link, [...g.direct], g.since, g.linkLabel);
  for (const [id, h] of held) {
    const c = byId.get(id);
    const name = c ? `${cut(cardName(c, id), 60)} (${c.s === "waiting" || c.s === "open" ? "waits on you" : c.s ?? "?"})` : `${cut(id, 60)} (not a card)`;
    make(`card:${id}`, "card", name, c ? cardLink(c, dash) : undefined, [...h.direct], h.since);
  }
  const order: BlockerKind[] = ["ci", "cap", "bot", "card"];
  const ranked = [...cands].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.held.size - a.held.size || a.key.localeCompare(b.key));
  const credited = new Set<string>();
  const out: Blocker[] = [];
  for (const c of ranked) {
    const mine = [...c.held].filter((x) => !credited.has(x));
    if (!mine.length) continue;
    for (const x of mine) credited.add(x);
    // The wait on THIS blocker: its direct waiters (a dependent cannot wait for it longer than they do). Only when
    // every direct waiter is credited elsewhere, the dependents' own waits are used.
    let since = c.direct.some((x) => mine.includes(x)) ? c.since : now;
    if (since === now) for (const x of mine) if (byId.has(x)) since = Math.min(since, waitSince(x));
    out.push({ key: c.key, kind: c.kind, name: c.name, ...(c.link ? { link: c.link } : {}), ...(c.linkLabel ? { linkLabel: c.linkLabel } : {}), held: mine.length, heldIds: mine, since: Math.min(since, now) });
  }
  return out.sort((a, b) => b.held - a.held || a.since - b.since || a.key.localeCompare(b.key));
}

/** Blockers that qualify (>= MIN_HELD jobs or a wait > MIN_WAIT_MS), largest first, at most MAX_SHOWN. */
export function mainBlockers(all: Blocker[], now: number): Blocker[] {
  return all.filter((b) => b.held >= MIN_HELD || now - b.since > MIN_WAIT_MS).slice(0, MAX_SHOWN);
}

const LINK_LABEL: Record<BlockerKind, string> = { ci: "CI run", cap: "queue", bot: "job", card: "card" };
/** Owner 2026-11-05 (card blocker-list-format): one ranked list with one fixed line shape. The old "-# 🚧 Also:" subtext
 * lines showed as raw "-#" text in Discord and mixed styles. Shape: **N.** name · status · ⛔ jobs · ⏱️ wait → link. */
const STATUS_TAG = /^(.*\S)\s*\(([^()]{1,24})\)$/;
export function blockerLine(b: Blocker, now: number, rank: number): string {
  const m = b.name.match(STATUS_TAG);
  const name = m ? m[1]! : b.name;
  const parts = [`**${rank}.** ${name}`];
  if (m) parts.push(m[2]!);
  parts.push(`⛔ ${b.held} job${b.held === 1 ? "" : "s"}`, `⏱️ ${age(now - b.since)}`);
  return parts.join(" · ") + (b.link ? ` → [${b.linkLabel ?? LINK_LABEL[b.kind]}](<${b.link}>)` : "");
}
/** Header plus the ranked lines (largest number of held jobs first, then the oldest wait). */
export function blockerLines(shown: Blocker[], now: number): string[] {
  if (!shown.length) return [];
  return [BLOCKER_HEAD, ...shown.map((b, i) => blockerLine(b, now, i + 1))];
}
export const BLOCKER_HEAD = "🚧 **Blockers** · ranked by jobs held, then wait";

// ---------- local sources ----------
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** CI runs per running card from fm-overseer (overseer.json `cards[].ci` + ci-cache.json details). Stale -> []. */
export function readCiWaits(overseerFile: string, cacheFile: string, now: number): CiWait[] {
  const o = readJson(overseerFile) as { generated?: number; cards?: { card?: string; ci?: Record<string, string> }[] } | null;
  if (!o || !Array.isArray(o.cards) || now - num(o.generated) > OVERSEER_STALE_MS) return [];
  const cache = (readJson(cacheFile) ?? {}) as Record<string, { status?: string; created?: number; url?: string }>;
  const out: CiWait[] = [];
  for (const c of o.cards) {
    if (!c?.card || !c.ci || typeof c.ci !== "object") continue;
    for (const [k, status] of Object.entries(c.ci)) {
      const at = k.lastIndexOf(":");
      if (at < 0) continue;
      const det = cache[`gh:${k}`] ?? cache[`gl:${k}`] ?? {};
      out.push({ card: c.card, repo: k.slice(0, at), ref: k.slice(at + 1), status: String(status ?? det.status ?? ""), ...(det.created ? { created: det.created } : {}), ...(det.url ? { url: det.url } : {}) });
    }
  }
  return out;
}

/** fm-spawn's stack queue (queued.jsonl, one JSON object per line). */
export function readSpawnQueue(file: string): SpawnEntry[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: SpawnEntry[] = [];
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line) as SpawnEntry;
      if (r && typeof r === "object") out.push(r);
    } catch {}
  }
  return out;
}

/** Stack caps like fm-spawn stack_caps(): webapp 3, then stack-caps.json (0/null removes a cap). */
export function readCaps(file: string): Record<string, number> {
  const caps: Record<string, number> = { webapp: 3 };
  const d = readJson(file);
  if (d && typeof d === "object" && !Array.isArray(d)) {
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v > 0) caps[k] = v;
      else if (v === null || v === 0 || v === false) delete caps[k];
    }
  }
  return caps;
}

export type BlockerFiles = { overseerFile: string; ciCacheFile: string; spawnQueueFile: string; capsFile: string; /** Dashboard copy (mainblocker.json). */ outFile?: string; /** Run lookup (tests); default ghGlRunFetch. */ runFetch?: RunFetch; /** Queue verdict (tests); default fmSpawnDryRun. */ drainRun?: DrainRun };

/**
 * Dashboard file: the same shown blockers, so the dashboard draws the same line. Written when it changed, and at
 * least every REWRITE_MS so `generated` stays fresh (the dashboard hides a file older than 15 min: bot down).
 */
export const REWRITE_MS = 5 * 60_000;
let lastOut = "";
let lastWrite = 0;
export function writeBlockersFile(file: string, shown: Blocker[], now: number): void {
  const blockers = shown.map(({ heldIds: _h, ...b }) => ({ ...b, linkLabel: b.linkLabel ?? LINK_LABEL[b.kind] }));
  const body = JSON.stringify(blockers);
  if (body === lastOut && now - lastWrite < REWRITE_MS) return;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ generated: now, minHeld: MIN_HELD, minWaitMs: MIN_WAIT_MS, blockers }));
  renameSync(tmp, file);
  lastOut = body;
  lastWrite = now;
}

/** fm-overseer's run cache (ci-cache.json: "gh:<repo>:<id>" -> {status, created, url, at}); {} when missing. */
export function readCiCache(file: string): Record<string, RunInfo> {
  const d = readJson(file);
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, RunInfo>) : {};
}

export type RunFetch = (kind: "gh" | "gl", repo: string, id: string) => Promise<RunInfo | null>;
/** Active runs are checked again after this; finished runs are final. */
export const RUN_RECHECK_MS = 3 * 60_000;
/** At most this many lookups per update (the board refreshes every minute). */
export const RUN_CALLS = 6;
/** An active status older than this (every lookup since failed) counts as unknown: no blocker. */
export const RUN_STALE_MS = 10 * 60_000;
const FINAL = (s?: string) => !!s && !ACTIVE_RUN.has(s);

/**
 * Live status of runs named in blocked receipts (card mq-main-blocker review: a receipt keeps "waiting on CI: run …"
 * after the run finished, so the board must not trust the text). fm-overseer only checks runs of RUNNING cards.
 * `get` is synchronous (the render path); `update` looks up missing or stale runs in the background.
 */
export class RunStatus {
  private readonly cache = new Map<string, RunInfo>();
  private busy = false;
  constructor(private readonly fetch: RunFetch, private readonly now: () => number = Date.now) {}
  /** The run's state; an active status not confirmed for RUN_STALE_MS (lookups keep failing) counts as unknown. */
  get(key: string): RunInfo | undefined {
    const c = this.cache.get(key);
    return c && (FINAL(c.status) || this.now() - (c.at ?? 0) < RUN_STALE_MS) ? c : undefined;
  }
  /** Looks up missing/stale runs (a failed lookup waits RUN_RECHECK_MS too). Returns how many statuses changed. */
  async update(runs: CiWait[]): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let changed = 0;
    try {
      const now = this.now();
      const todo = [...new Map(runs.filter((w) => w.kind).map((w) => [`${w.kind}:${w.repo}:${w.ref}`, w])).entries()]
        .filter(([k]) => { const c = this.cache.get(k); return !c || (!FINAL(c.status) && now - (c.tried ?? 0) >= RUN_RECHECK_MS); })
        .slice(0, RUN_CALLS);
      for (const [k, w] of todo) {
        const r = await this.fetch(w.kind!, w.repo, w.ref).catch(() => null);
        const before = this.get(k)?.status;
        // `at` = last successful lookup, `tried` = last attempt: a failure (auth, rate limit, 404) waits
        // RUN_RECHECK_MS before the next try and never makes an old "queued" look fresh.
        const old = this.cache.get(k);
        this.cache.set(k, r ? { ...r, at: this.now(), tried: this.now() } : { ...(old ?? {}), tried: this.now() });
        if (this.get(k)?.status !== before) changed++;
      }
    } finally {
      this.busy = false;
    }
    return changed;
  }
}

/** GitHub: `gh api repos/<repo>/actions/runs/<id>`; GitLab: the main's local API (token file). null on any error. */
export const ghGlRunFetch: RunFetch = async (kind, repo, id) => {
  if (!/^\d+$/.test(id) || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) return null;
  const iso = (s: unknown) => (typeof s === "string" && Date.parse(s)) || undefined;
  if (kind === "gh") {
    const p = Bun.spawn(["gh", "api", `repos/${repo}/actions/runs/${id}`], { stdout: "pipe", stderr: "ignore" });
    const kill = setTimeout(() => p.kill(), 20_000);
    try {
      const d = JSON.parse(await new Response(p.stdout).text()) as { status?: string; created_at?: string; html_url?: string };
      return d.status ? { status: d.status, created: iso(d.created_at), url: d.html_url } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(kill);
    }
  }
  try {
    const tok = readFileSync(join(homedir(), ".config", "gitlab-main", "token"), "utf8").trim();
    const api = process.env.OMP_GITLAB_API ?? "http://127.0.0.1:8080/api/v4";
    const r = await fetch(`${api}/projects/${encodeURIComponent(repo)}/pipelines/${id}`, { headers: { "PRIVATE-TOKEN": tok }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = (await r.json()) as { status?: string; created_at?: string; web_url?: string };
    return d.status ? { status: d.status, created: iso(d.created_at), url: d.web_url } : null;
  } catch {
    return null;
  }
};

/** Parse `fm-spawn --drain-queue --dry-run` output (scripts/fm-spawn drain_queue messages). */
export function parseDrainDry(out: string): DrainVerdict {
  const v: DrainVerdict = { paused: /agent work is paused/.test(out), tabCapped: [], maxTabs: 30, willStart: [], claimWait: [] };
  for (const m of out.matchAll(/workspace (\S+) is over (\d+) tabs/g)) {
    if (!v.tabCapped.includes(m[1]!)) v.tabCapped.push(m[1]!);
    v.maxTabs = Number(m[2]);
  }
  for (const line of out.split("\n")) {
    const start = /^DRY would start queued (.+)$/.exec(line);
    if (start) {
      const i = start[1]!.lastIndexOf(" (stack ");
      v.willStart.push(i >= 0 ? start[1]!.slice(0, i) : start[1]!);
    }
    const claim = /^fm-spawn --drain-queue: (.+?) waits: /.exec(line);
    if (claim) v.claimWait.push(claim[1]!);
  }
  return v;
}

/** fm-spawn's verdict is read again after this (it calls GitHub for its CI watch; fm-tick drains every minute). */
export const DRAIN_EVERY_MS = 5 * 60_000;
/** An older verdict is not used. */
export const DRAIN_STALE_MS = 15 * 60_000;
export type DrainRun = () => Promise<string | null>;

/** Cached `fm-spawn --drain-queue --dry-run` verdict (writes nothing; it names why queued jobs wait). */
export class DrainCheck {
  private v: { at: number; verdict: DrainVerdict } | null = null;
  private busy = false;
  constructor(private readonly run: DrainRun, private readonly now: () => number = Date.now) {}
  get(): DrainVerdict | undefined {
    return this.v && this.now() - this.v.at < DRAIN_STALE_MS ? this.v.verdict : undefined;
  }
  /** Runs the dry run when due. Returns true when the verdict changed. */
  async update(): Promise<boolean> {
    if (this.busy || (this.v && this.now() - this.v.at < DRAIN_EVERY_MS)) return false;
    this.busy = true;
    try {
      const out = await this.run().catch(() => null);
      if (out === null) return false;
      const verdict = parseDrainDry(out);
      const changed = JSON.stringify(verdict) !== JSON.stringify(this.v?.verdict);
      this.v = { at: this.now(), verdict };
      return changed;
    } finally {
      this.busy = false;
    }
  }
}

/** Default DrainRun: `fm-spawn --drain-queue --dry-run` (90 s limit); null when it fails. */
export const fmSpawnDryRun: DrainRun = async () => {
  const p = Bun.spawn(["fm-spawn", "--drain-queue", "--dry-run"], { stdout: "pipe", stderr: "pipe" });
  const kill = setTimeout(() => p.kill(), 90_000);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return (await p.exited) === 0 ? `${out}\n${err}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(kill);
  }
};
