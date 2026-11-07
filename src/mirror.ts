// Herdr tab ↔ Discord channel mirroring (read-only toward Herdr and the panes).
// - sync(): `herdr agent list` / `herdr tab list` on the main host and the peer machine (over SSH). Each OMP pane
//   gets a channel named after its tab in 🖥️ Main / 💻 second machine. When the pane is gone, the channel
//   is marked archived; scripts/purge-archive.py deletes it after the learners ran. The mapping is stable by pane id (then tab id) and stored in agents.json.
// - tail(): reads each pane's session JSONL from a saved byte offset (read-only) and posts every
//   new final assistant reply (text only) to its channel through the privacy filter.
// - decide(): Discord → session. Messages never type into a pane. If no omp process holds the
//   pane's session, the turn continues that session file (sandboxed `omp -p --resume`).
//   Otherwise it runs in a linked side session with a read-only excerpt as context. A scratch
//   test showed that a second writer's turn forks off the holder's branch and is lost.
//   Exception (owner pick 2026-10-19, Orca #2): quick-reply buttons on a wait card type into a
//   waiting pane under the guards in src/quickreply.ts.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ChannelType, ThreadAutoArchiveDuration, type Client, type Guild, type SendableChannels, type TextChannel, type ThreadChannel } from "discord.js";
import { CONFIG, CONFIG_FILE, FIRSTMATE_SESSION, FM_DIR, GUILD_ID, STATE_DIR } from "./config.ts";
import { askInfo, isQuestionReply, questionLine, type AskInfo, type PaneWait } from "./quickreply.ts";
import { freshWatch, watchCheck, watchEvents, type WatchAction, type WatchState } from "./stall.ts";
import { channelMention } from "./mention.ts";
import { SessionTail, shortModel, subagentFiles } from "./heartbeat.ts";
import { routerConfig, type StackDef } from "./router.ts";
import { catalogMtime, loadCatalog } from "./stackcatalog.ts";
import { categoryOrder, paneStack, parseStackCategories, stackCategoryName, type StackCard } from "./stackcats.ts";
import { emojiKey } from "./stackemoji.ts";

/** Internal machine keys: "main" is always this machine; "second" is the optional peer from config.mirror.peers[0]. */
export type Machine = "main" | "second";
const PEER = CONFIG.mirror.peers[0];
export const HOSTS: { machine: Machine; ssh: string | null; herdr: string }[] = [
  { machine: "main", ssh: null, herdr: "herdr" },
  ...(PEER ? [{ machine: "second" as const, ssh: PEER.ssh, herdr: PEER.herdr }] : []),
];
/** Discord category ids (this machine's panes, the peer's panes, 📦 Archive) from config.mirror.categories. */
export const CATEGORY_IDS = { main: CONFIG.mirror.categories.local, second: CONFIG.mirror.categories.peer, archive: CONFIG.mirror.categories.archive } as const;
/** Archive categories in order (📦 Archive, 📦 Archive 2, …): config.mirror.categories.archive + config.mirror.archives. */
export const ARCHIVE_IDS: string[] = [CONFIG.mirror.categories.archive, ...CONFIG.mirror.archives].filter(Boolean);
/** Discord allows at most 50 channels in one category. */
export { CATEGORY_LIMIT } from "./archivelimit.ts";
import { CATEGORY_LIMIT } from "./archivelimit.ts";
/** First archive category with room (fewer than 50 channels); undefined when all are full. */
export function pickArchive(ids: string[], count: (id: string) => number): string | undefined {
  return ids.find((id) => count(id) < CATEGORY_LIMIT);
}
/** Overflow categories for this machine's live pane channels (config.mirror.overflow), used in order. */
export const OVERFLOW_IDS: string[] = CONFIG.mirror.overflow.filter(Boolean);
/** Overflow categories for the second machine's live pane channels (config.mirror.overflowSecond). */
export const OVERFLOW_IDS_SECOND: string[] = (CONFIG.mirror.overflowSecond ?? []).filter(Boolean);
const overflowList = (m: string): string[] => (m === "main" ? OVERFLOW_IDS : OVERFLOW_IDS_SECOND);
const overflowKey = (m: string): "overflow" | "overflowSecond" => (m === "main" ? "overflow" : "overflowSecond");
/** First pane category with room: the machine's own category, then its overflow categories. */
export function pickPaneCategory(ids: string[], count: (id: string) => number): string | undefined {
  return ids.find((id) => count(id) < CATEGORY_LIMIT);
}
/** Discord allows at most 500 channels (categories included) in one server; keep a margin. */
export const GUILD_CHANNEL_LIMIT = 500;
/** After a failed overflow-category create, wait this long before the next try (no create storm). */
export const OVERFLOW_RETRY_MS = 60 * 60_000;
/** Name of the next overflow category: "🖥️ Main" + 3 categories so far -> "🖥️ Main 4". */
export function overflowName(baseName: string, existing: number): string {
  return `${baseName.replace(/\s+\d+$/, "")} ${existing + 1}`;
}
/** Owner 2026-10-30 (card bot-upgrades-1030): at least this long between two category creates (one at a time). */
export const STACK_CATEGORY_GAP_MS = 60_000;
/** Channel moves into stack categories per sync pass (no PATCH burst). */
export const MOVES_PER_PASS = 5;
/**
 * Owner 2026-11-07 (card server-full-auto-drop): "Always use a Discord channel. ALWAYS. If at capacity, make a new
 * category; if the server is full, run a sweep and drop the 10 oldest channels." A create at or above
 * SERVER_SWEEP_AT server channels (or one Discord refuses with SERVER_FULL_RE) first runs the sweep, then creates at once.
 */
export const SERVER_SWEEP_AT = GUILD_CHANNEL_LIMIT - 5;
/** Never more than this many channels per sweep (owner rule). */
export const SERVER_SWEEP_MAX = 10;
/** At most one sweep per this window: a sweep that freed nothing (or a full server again) waits for the next one. */
export const SERVER_SWEEP_GAP_MS = 10 * 60_000;
/** Discord 30013: "Maximum number of server channels reached (500)" (older wording: "guild channels"). */
export const SERVER_FULL_RE = /maximum number of (server|guild) channels/i;
/** Server channels that count toward the 500 limit (threads do not; the cache also holds active threads). */
export function serverChannelCount(guild: Guild): number {
  return [...guild.channels.cache.values()].filter((c) => !c.isThread?.()).length;
}
export type ServerSweepResult = { ids: string[]; names: string[] };
/** Parse `purge-archive.py --json` stdout (lines such as "skip ...: already gone" may come before the JSON). */
export function parseSweepOutput(out: string): ServerSweepResult {
  const at = out.startsWith("{") ? 0 : out.indexOf("\n{");
  if (at < 0) throw new Error("no JSON in the purge-archive output");
  const j = JSON.parse(out.slice(at)) as { dryRun?: boolean; deletedIds?: unknown; deletedNames?: unknown };
  if (j.dryRun) return { ids: [], names: [] };
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { ids: strs(j.deletedIds), names: strs(j.deletedNames) };
}
/**
 * The ids/names a sweep run deleted: its JSON (stdout) plus the "dropped <id> <name>" stderr lines, which name
 * what went even when the run died before its JSON (timeout, crash). `parsed`: the JSON was readable.
 */
export function parseSweepRun(out: string, err: string): { r: ServerSweepResult; parsed: boolean } {
  let r: ServerSweepResult = { ids: [], names: [] };
  let parsed = true;
  try {
    r = parseSweepOutput(out);
  } catch {
    parsed = false;
  }
  for (const m of err.matchAll(/^dropped (\d+) (.*)$/gm)) {
    if (r.ids.includes(m[1]!)) continue;
    r.ids.push(m[1]!);
    r.names.push(m[2]!);
  }
  return { r, parsed };
}
/**
 * Run scripts/purge-archive.py --drop-oldest N --json (protected channels are never picked; JSON + HTML copy first).
 * `hold`: channel ids the bot uses right now (live panes, panes matched again in this pass): never deleted, even
 * before agents.json on disk says so (review 2026-11-07).
 */
export function runServerSweep(hold: string[] = [], n = SERVER_SWEEP_MAX, timeoutMs = 5 * 60_000): Promise<ServerSweepResult> {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const { promise, resolve, reject } = Promise.withResolvers<ServerSweepResult>();
  const args = ["-B", script, "--drop-oldest", String(Math.min(n, SERVER_SWEEP_MAX)), "--json", ...(hold.length ? ["--hold", hold.join(",")] : [])];
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  child.on("error", (e) => {
    clearTimeout(timer);
    reject(e);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    const { r, parsed } = parseSweepRun(out, err);
    if ((code === 0 && parsed) || r.ids.length) resolve(r);
    else reject(new Error(`purge-archive exited ${code}${parsed ? "" : " without JSON"}: ${err.trim().slice(-200)}`));
  });
  return promise;
}
/** Every pane category in config.json: both machines' categories, their overflow and the stack categories. */
export function paneCategoryIds(): Set<string> {
  const stackIds = Object.values(parseStackCategories(CONFIG.mirror.stackCategories)).flat();
  return new Set([CATEGORY_IDS.main, CATEGORY_IDS.second, ...OVERFLOW_IDS, ...OVERFLOW_IDS_SECOND, ...stackIds].filter(Boolean));
}

let stackCache: { at: number; stacks: StackDef[] } | null = null;
/** Stacks for the split: code defaults + legacy config router.stacks + the catalog; re-read when the catalog changes. */
function defaultStacks(): StackDef[] {
  const at = catalogMtime();
  if (!stackCache || stackCache.at !== at) stackCache = { at, stacks: routerConfig(CONFIG.router, loadCatalog().stacks).stacks };
  return stackCache.stacks;
}
let cardCache: { file: string; at: number; cards: StackCard[] } | null = null;
/** FIRSTMATE cards (items.json, read-only); re-read when the file changes. Unreadable: no cards. */
function defaultCards(): StackCard[] {
  const file = process.env.OMP_FM_ITEMS ?? join(FM_DIR, "items.json");
  try {
    const at = statSync(file).mtimeMs;
    if (cardCache?.file === file && cardCache.at === at) return cardCache.cards;
    const d: unknown = JSON.parse(readFileSync(file, "utf8"));
    const items = d && typeof d === "object" && "items" in d && Array.isArray(d.items) ? (d.items as StackCard[]) : [];
    cardCache = { file, at, cards: items.filter((x) => x && typeof x === "object") };
    return cardCache.cards;
  } catch {
    return [];
  }
}
/**
 * Owner 2026-10-28: save the overflow category list in config.json `mirror.overflow` (backup first, 0600,
 * tmp + rename), so a category the mirror created stays in use after a restart.
 */
export function saveOverflowIds(ids: string[], file = CONFIG_FILE, key: "overflow" | "overflowSecond" = "overflow"): void {
  saveMirrorValue(key, [...ids], file);
}
/** Save one `mirror.<key>` value in config.json (backup first, 0600, tmp + rename). */
export function saveMirrorValue(key: string, value: unknown, file = CONFIG_FILE): void {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("config.json is not an object");
  const cfg = raw as Record<string, unknown>; // parsed config object; only `mirror` is read and replaced
  const mirror = cfg.mirror && typeof cfg.mirror === "object" ? (cfg.mirror as Record<string, unknown>) : {};
  cfg.mirror = { ...mirror, [key]: value };
  writeFileSync(`${file}.before-overflow-${Date.now()}`, readFileSync(file), { mode: 0o600 });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
/**
 * Owner 2026-10-24: a channel create that Discord rate-limits for longer than this fails at once (discord.js
 * `rejectOnRateLimit`, set in main.ts). Before, the sync awaited an 11-17 h wait and stopped mirroring.
 */
export const CREATE_WAIT_MAX_MS = 60_000;
export function rejectLongChannelCreate(d: { method: string; route: string; timeToReset: number }): boolean {
  // Owner 2026-10-30: thread creates (🧵 jobs fallback) also fail at once instead of waiting hours inside sync.
  return d.method.toUpperCase() === "POST" && (d.route === "/guilds/:id/channels" || d.route === "/channels/:id/threads") && d.timeToReset > CREATE_WAIT_MAX_MS;
}
/** A discord.js RateLimitError (thrown because of rejectOnRateLimit): its wait in ms, else null. */
export function rateLimitWait(err: unknown): number | null {
  const e = err as { name?: unknown; timeToReset?: unknown };
  return typeof e?.timeToReset === "number" && String(e.name ?? "").startsWith("RateLimitError") ? e.timeToReset : null;
}
/** Channels the mirror leaves alone (owner 2026-10-19: channels switched to the local model). */
export const DETACHED_CHANNEL_IDS = new Set<string>([...CONFIG.localOmpChannelIds, ...CONFIG.veniceChannelIds, ...CONFIG.uncensoredChannelIds, ...CONFIG.unrestrictedChannelIds]);

const MAP_FILE = join(STATE_DIR, "agents.json");
/** Plan P5: stall lines, "resumed" lines and automatic-continue decisions for one pane. */
export type WatchHandler = (e: MirrorEntry, a: WatchAction) => Promise<void>;
/** Orca #2: post a wait card (returns its message id) or close one with a note. */
export type WaitHandler = (e: MirrorEntry, w: PaneWait, action: { open: true } | { close: string }) => Promise<string | undefined>;
const MAX_TAIL_BYTES = 1024 * 1024;
const SSH_OPTS = [
  "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5",
  "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/omp-mirror-ssh-%r@%h", "-o", "ControlPersist=10m",
];

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[mirror]", ...a);

export type MirrorEntry = {
  machine: Machine;
  paneId: string;
  tabId?: string;
  workspace: string;
  tab: string;
  name: string;
  channelId: string;
  archived: boolean;
  cwd?: string;
  sessionFile?: string | null;
  /** Byte offset already mirrored in sessionFile. */
  offset?: number;
  /** Live progress of the pane's current turn (owner 2026-10-15). */
  progress?: Progress;
  /** Last thinking level seen in this session (kept while no turn is open, so the next status shows it). */
  thinking?: string;
  /** Plan P5: open tool calls, stall line and automatic-continue state (src/stall.ts). */
  watch?: WatchState;
  /** Orca #2 (owner 2026-10-19): the pane waits for the owner; its card has quick-reply buttons. */
  wait?: PaneWait;
  /** Owner 2026-10-30: the entry maps a public thread in the 🧵 jobs channel (channel creates were blocked). */
  threadOnly?: boolean;
};

/** One tool step of a running turn, for the live status message. */
export type ProgressStep = { ts: number; label: string };
/**
 * Owner decision 2026-10-15: each mirrored channel gets ONE silent status message per pane turn,
 * edited in place with the latest steps (tool name + the agent's short intent). Read-only.
 */
export type Progress = {
  msgId?: string;
  startTs: number;
  lastTs: number;
  count: number;
  steps: ProgressStep[];
  /** Owner 2026-10-15: what the turn was asked to do, so the channel reads like a conversation. */
  task?: string;
  state: "working" | "done" | "stopped";
  reason?: string;
  /** Owner 2026-10-15: commits, pushes and opened PRs of this turn; kept after the turn ends. */
  git?: ProgressStep[];
  /** Owner 2026-10-19: "provider/model" of the pane's session (same lines as the bridge's Working message). */
  model?: string;
  /** Owner 2026-10-31 (card reply-thinking-level): effective thinking level, "low (auto)" for a router pick. */
  thinking?: string;
  /** Owner 2026-10-19: latest tool call, shown as the last line; `done` once its result arrived. */
  lastTool?: { ts: number; tool: string; intent: string; callId?: string; done: boolean };
  /** Owner 2026-10-31 (card job-subagents-line): subagents the pane's session started this turn. */
  subagents?: ProgressSub[];
};
export type ProgressSub = { name: string; model?: string; done: boolean; lastTool?: string; running?: boolean; calls: number; lastWrite: number };
/** At most this many subagent lines (running ones first), as in the bridge's Working message. */
export const PROGRESS_SUBS = 5;

/** Subagent lines of a status message (pure). */
export function renderSubagents(subs: ProgressSub[] | undefined, mainModel?: string): string[] {
  if (!subs?.length) return [];
  const c = (x: string, n: number) => x.replace(/[`*_~|<>@\n]/g, "").slice(0, n);
  const sorted = [...subs].sort((a, b) => Number(a.done) - Number(b.done) || b.lastWrite - a.lastWrite);
  const out = [`🤝 **Subagents:** ${sorted.filter((x) => !x.done).length} running · ${sorted.filter((x) => x.done).length} finished`];
  for (const x of sorted.slice(0, PROGRESS_SUBS)) {
    const model = x.model && x.model !== mainModel ? ` (${c(shortModel(x.model), 40)})` : "";
    const state = x.done ? "✅ finished" : x.lastTool ? `${x.running ? "🔧" : "🧠"} ${x.running ? "running" : "last"} \`${c(x.lastTool, 30)}\`` : "🧠 starting";
    out.push(`  ↳ 🤖 **${c(x.name, 40)}**${model}: ${state} · ${x.calls} calls`);
  }
  if (sorted.length > PROGRESS_SUBS) out.push(`  ↳ +${sorted.length - PROGRESS_SUBS} more subagents`);
  return out;
}

/** Subagent state for a session file (local files only); `tails` keeps read offsets between calls. */
export function scanSubagents(sessionFile: string, sinceMs: number, tails: Map<string, SessionTail>): ProgressSub[] {
  const dir = sessionFile.replace(/\.jsonl$/, "");
  const out: ProgressSub[] = [];
  for (const f of subagentFiles(dir)) {
    // Checked on every call: a cached tail of an earlier turn's subagent is dropped (review 2026-10-31).
    let old = true;
    try {
      old = statSync(f).mtimeMs < sinceMs;
    } catch {}
    if (old) {
      tails.delete(f);
      continue;
    }
    let t = tails.get(f);
    if (!t) {
      t = new SessionTail(f);
      tails.set(f, t);
    }
    const mtime = t.poll();
    const rel = f.slice(dir.length + 1).replace(/\.jsonl$/, "");
    const p = [...t.pending.values()].at(-1) ?? t.lastTool;
    out.push({ name: rel.slice(rel.lastIndexOf("/") + 1), ...(t.model ? { model: t.model } : {}), done: t.done, ...(p ? { lastTool: p.name, running: t.pending.size > 0 } : {}), calls: t.toolCalls, lastWrite: Math.max(t.lastEntryAt, mtime) });
  }
  return out;
}
export const PROGRESS_STEPS = 8;
export const PROGRESS_GIT = 8;
/** Minimum gap between edits of one status message (Discord allows about 5 edits per 5 s per channel). */
export const PROGRESS_EDIT_MS = 4_000;

export type SessionEvent =
  | { kind: "turn"; ts: number; text?: string }
  | { kind: "note"; ts: number; text: string }
  /** `ask`/`entryId` (Orca #2): the parsed ask question and the session entry id, OMP's record of the wait. */
  | { kind: "step"; ts: number; label: string; callId?: string; tool?: string; intent?: string; ask?: AskInfo; entryId?: string }
  /** A tool result (plan P5: closes the open call `callId`). */
  | { kind: "result"; ts: number; callId: string }
  | { kind: "reply"; ts: number; text: string; entryId?: string }
  /** `error`: the provider's error message when reason is "error" (plan P5 auto-continue). */
  | { kind: "stopped"; ts: number; reason: string; error?: string }
  | { kind: "git"; ts: number; label: string }
  /** Owner 2026-10-19: the model the session uses (model_change entry or an assistant message). */
  | { kind: "model"; ts: number; model: string }
  /** Owner 2026-10-31: the thinking level from the last thinking_level_change entry. */
  | { kind: "thinking"; ts: number; level: string };

export type LivePane = { machine: Machine; paneId: string; tabId: string; workspace: string; tab: string; name: string; short?: string; cwd: string; sessionFile: string | null };

/** Run a read-only shell snippet locally or on the host over SSH. */
export function sh(ssh: string | null, script: string, timeoutMs = 15_000): Promise<{ code: number; out: Buffer }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number; out: Buffer }>();
  const p = ssh ? spawn("ssh", [...SSH_OPTS, ssh, script]) : spawn("bash", ["-c", script]);
  const chunks: Buffer[] = [];
  p.stdout.on("data", (d: Buffer) => chunks.push(d));
  p.stderr.on("data", () => {});
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  p.on("close", (code) => {
    clearTimeout(t);
    resolve({ code: code ?? 1, out: Buffer.concat(chunks) });
  });
  p.on("error", () => resolve({ code: 1, out: Buffer.alloc(0) }));
  p.stdin.end();
  return promise;
}

/**
 * Owner 2026-10-17: an emoji in front of every mirrored channel name shows what it is about at a glance.
 * First keyword match wins; the machine emoji is the fallback. Display only: entries keep the plain slug.
 */
const TOPIC_EMOJI: [RegExp, string][] = [
  [/firstmate/, "👷‍♂️"], [/example-activity/, "🛠️"], [/reel|insta/, "📱"], [/kb-|knowledge/, "📚"], [/webapp|roboquant|backtest|quant/, "📊"],
  [/rebalance|rally|newsletter|finance|newsfeed|market/, "💹"], [/realestate|real-estate|student-loan/, "🏠"],
  [/inception|film|movie|debate/, "🎬"], [/local-omp|local-model/, "🧠"], [/self-healing|harness|bot|omp/, "🧰"], [/apps|demo|demoapp/, "🎮"],
];
/** Owner 2026-10-17: sort channels in a category by emoji group (TOPIC_EMOJI order), then by name. */
export function sortKey(title: string): string {
  const plain = title.replace(/\uFE0F/g, "");
  const i = TOPIC_EMOJI.findIndex(([, e]) => plain.startsWith(e.replace(/\uFE0F/g, "")));
  return `${String(i < 0 ? 99 : i).padStart(2, "0")}|${plain.replace(/^[^a-z0-9]+/, "")}`;
}
/**
 * Owner 2026-10-24: the display name drops the machine and workspace prefix ("main-github-"), so it fits the master
 * queue. `short` is the tab part; the entry keeps the full slug (`name`) for lookups and the emoji match.
 */
export function channelTitle(name: string, machine: string, short?: string): string {
  const hit = TOPIC_EMOJI.find(([re]) => re.test(name))?.[1] ?? (machine === "second" ? "💻" : "🤖");
  return `${hit}-${short || name}`.slice(0, 100);
}

/** Discord channel name from the Herdr tab title. */
export function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 90) || "agent";
}

type HerdrItem = Record<string, unknown>;
function herdrList(raw: string, key: string): HerdrItem[] {
  try {
    const parsed = JSON.parse(raw) as { result?: Record<string, unknown> };
    const list = parsed.result?.[key];
    return Array.isArray(list) ? (list as HerdrItem[]) : [];
  } catch {
    return [];
  }
}

/** Parse `herdr agent list` + `herdr tab list` (pure; exported for tests). null = host unreadable. */
export function parseHerdr(machine: Machine, agentsRaw: string, tabsRaw: string, workspacesRaw = ""): LivePane[] | null {
  if (!agentsRaw.includes('"agents"')) return null;
  const tabLabel = new Map(herdrList(tabsRaw, "tabs").map((t) => [String(t.tab_id), String(t.label ?? t.tab_id)]));
  // Owner 2026-10-14: channel names are namespaced by workspace ("apps-demoapp"). Owner 2026-10-14 later: machine prefix too ("main-github-firstmate").
  const wsLabel = new Map(herdrList(workspacesRaw, "workspaces").map((w) => [String(w.workspace_id), String(w.label ?? "")]));
  const omp = herdrList(agentsRaw, "agents").filter((a) => a.agent === "omp");
  // Owner 2026-10-19: a second OMP pane in a tab (e.g. a Heeler split below FIRSTMATE) must not rename the
  // existing channel. The oldest pane (lowest Herdr id: shorter first, then lexical) keeps the plain name;
  // only the extra panes get a "-<pane>" suffix.
  const firstInTab = new Map<string, { paneId: string; rank: string }>();
  for (const a of omp) {
    const paneId = String(a.pane_id);
    const local = paneId.split(":").pop() ?? paneId;
    const rank = `${String(local.length).padStart(4, "0")}|${local}`;
    const cur = firstInTab.get(String(a.tab_id));
    if (!cur || rank < cur.rank) firstInTab.set(String(a.tab_id), { paneId, rank });
  }
  return omp.map((a) => {
    const paneId = String(a.pane_id);
    const tabId = String(a.tab_id);
    const tab = tabLabel.get(tabId) ?? tabId;
    const session = a.agent_session as { kind?: string; value?: string } | undefined;
    const suffix = firstInTab.get(tabId)?.paneId !== paneId ? `-${paneId.split(":").pop()}` : "";
    return {
      machine,
      paneId,
      tabId,
      workspace: String(a.workspace_id ?? ""),
      tab,
      short: slug(`${tab}${suffix}`),
      name: slug(`${machine}-${wsLabel.get(String(a.workspace_id ?? "")) ? `${wsLabel.get(String(a.workspace_id ?? ""))}-` : ""}${tab}${suffix}`),
      cwd: String(a.cwd ?? ""),
      sessionFile: session?.kind === "path" && typeof session.value === "string" && session.value.endsWith(".jsonl") ? session.value : null,
    };
  });
}

/**
 * True when an omp process runs in the pane: in its foreground group or anywhere below the pane's
 * shell. `ps` lines are "pid ppid comm args…" (pure; exported for tests).
 */
export function paneHasLiveOmp(processInfoRaw: string, ps: string): boolean {
  let info: { shell_pid?: number; foreground_processes?: { name?: string; argv?: string[] }[] } | undefined;
  try {
    info = (JSON.parse(processInfoRaw) as { result?: { process_info?: typeof info } }).result?.process_info;
  } catch {
    return true; // unknown → treat as held (never touch)
  }
  if (!info) return true;
  const isOmp = (name: string, args: string) => name === "omp" || /(^|\/)omp(\s|$)/.test(args);
  if (info.foreground_processes?.some((p) => isOmp(p.name ?? "", (p.argv ?? []).join(" ")))) return true;
  if (!info.shell_pid) return true;
  const rows: { pid: number; ppid: number; name: string; args: string }[] = [];
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!, args: m[4] ?? "" });
  }
  const byParent = new Map<number, typeof rows>();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
  const stack = [info.shell_pid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of byParent.get(pid) ?? []) {
      if (isOmp(c.name, c.args)) return true;
      stack.push(c.pid);
    }
  }
  return false;
}

/** Text of an assistant entry, text blocks only. */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** First line-ish of a text, markdown-safe, cut at `max` characters. */
export function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").replace(/[`*_~|<>@]/g, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
/** A Discord-bridged prompt carries rules and excerpts; show only the owner's own words. */
export function ownerText(text: string): string {
  const m = text.match(/--- owner message ---\n([\s\S]*?)\n--- end owner message ---/);
  return m ? m[1]! : text;
}

/** One-line step label: tool name plus the agent's intent (`i`); no other arguments (privacy). */
export function stepLabel(name: unknown, args: unknown): string {
  const tool = (typeof name === "string" ? name : "tool").replace(/[^\w.:-]/g, "").slice(0, 32) || "tool";
  // eval has no `i`; its `title` is the same kind of short label.
  const a = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const raw = typeof a.i === "string" ? a.i : a.title;
  const intent = typeof raw === "string" ? raw : "";
  const clean = intent.replace(/\s+/g, " ").replace(/[`*_~|<>@#]/g, "").trim().slice(0, 80);
  return clean ? `${tool} · ${clean}` : tool;
}

/** Git text for a status line: one line, no Discord markdown or mentions (underscores stay). */
const gitClean = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").replace(/[`*~|<>@]/g, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Owner 2026-10-15: notes for commits, pushes and opened PRs (pure). Input: the shell command of a
 * tool call and its successful result text. Only the command's own git/gh calls count; the result
 * must not show a failure. Returns status lines (empty when nothing happened).
 */
export function gitNotes(rawCommand: string, output: string): string[] {
  const out: string[] = [];
  // Heredoc bodies are text (PR bodies, scripts), not commands; a git/gh call must start a command.
  const stripped = rawCommand.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, "");
  const command = stripped
    .split(/\n|;|&&|\|\||\||\(/).map((c) => c.trim()).filter((c) => /^(git|gh)\b/.test(c)).join(" ; ");
  const failed = /\b(fatal:|error:|rejected\]|! \[rejected|Authentication failed)/i;
  if (/\bgit(\s+-C\s+\S+)?\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
    if (!/nothing (added )?to commit|no changes added to commit/i.test(output) && !failed.test(output)) {
      const s = output.match(/^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/m);
      const msg = stripped.match(/\s-[a-zA-Z]*m\s+(["'])([\s\S]*?)\1/)?.[2]?.split("\n")[0];
      if (s) out.push(`📝 Committed ${s[2]!.slice(0, 7)} on ${gitClean(s[1]!, 50)}: ${gitClean(s[3]!, 80)}`);
      else out.push(msg ? `📝 Committed: ${gitClean(msg, 90)}` : "📝 Committed");
    }
  }
  if (/\bgit(\s+-C\s+\S+)?\s+push\b/.test(command) && !/--dry-run/.test(command)) {
    if (!failed.test(output) && !/Everything up-to-date/i.test(output)) {
      const repo = output.match(/^To (?:https:\/\/|ssh:\/\/)?(?:git@)?github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m)?.[1];
      const branch =
        output.match(/(?:\[new branch\]|[0-9a-f]{7,}\.\.\.?[0-9a-f]{7,}|\+ [0-9a-f]{7,}\.\.\.[0-9a-f]{7,})\s+\S+\s+->\s+(\S+)/)?.[1] ??
        command.match(/\bpush\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+[\w.-]+\s+([^\s;&|)]+)/)?.[1]?.replace(/^HEAD:/, "");
      out.push(`⬆️ Pushed${branch ? ` ${gitClean(branch, 60)}` : ""}${repo ? ` to ${gitClean(repo, 60)}` : ""}`);
    }
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const m = output.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (m) out.push(`🔀 Opened PR ${gitClean(m[1]!, 60)}#${m[2]}`);
  }
  return out;
}

/** Shell commands of recent tool calls by id, so a result read in a later chunk still finds its call. */
const callCommands = new Map<string, string>();
const rememberCall = (id: string, command: string) => {
  callCommands.set(id, command);
  if (callCommands.size > 500) callCommands.delete(callCommands.keys().next().value!);
};

/**
 * Offset after one tail read: past the complete lines; or, when a FULL read window holds no newline (one JSONL
 * line longer than the window, e.g. a huge tool result), past the window, so the pane does not stall on it for
 * good. The rest of that line then fails to parse and is dropped. null = wait for more bytes.
 */
export function tailOffset(start: number, chunkLen: number, consumed: number, max = MAX_TAIL_BYTES): number | null {
  if (consumed) return start + consumed;
  if (chunkLen >= max) return start + chunkLen;
  return null;
}

/**
 * Ordered events in the complete lines of a JSONL chunk: turn start (user message), tool steps,
 * final replies (stopReason "stop"; text may be empty) and stopped turns (aborted/error/length).
 * `consumed` is the byte length of the complete lines (a partial last line is left for later).
 */
export function sessionEvents(chunk: Buffer, now = Date.now()): { events: SessionEvent[]; consumed: number } {
  const end = chunk.lastIndexOf(0x0a);
  if (end === -1) return { events: [], consumed: 0 };
  const events: SessionEvent[] = [];
  for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        type?: string;
        id?: string;
        timestamp?: string;
        model?: unknown;
        thinkingLevel?: unknown;
        configured?: unknown;
        message?: { role?: string; stopReason?: string; content?: unknown; toolCallId?: string; isError?: boolean; errorMessage?: unknown; provider?: unknown; model?: unknown };
      };
      if (e.type === "model_change" && typeof e.model === "string") {
        events.push({ kind: "model", ts: e.timestamp ? Date.parse(e.timestamp) || now : now, model: e.model });
        continue;
      }
      if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string" && e.thinkingLevel) {
        const level = e.configured === "auto" ? `${e.thinkingLevel} (auto)` : e.thinkingLevel;
        events.push({ kind: "thinking", ts: e.timestamp ? Date.parse(e.timestamp) || now : now, level });
        continue;
      }
      if (e.type !== "message" || !e.message) continue;
      const parsed = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
      const ts = Number.isFinite(parsed) ? parsed : now;
      const { role, stopReason, content } = e.message;
      if (role === "user") {
        events.push({ kind: "turn", ts, text: oneLine(ownerText(assistantText(content)), 200) });
        continue;
      }
      if (role === "toolResult") {
        const id = e.message.toolCallId;
        const command = id ? callCommands.get(id) : undefined;
        if (id) callCommands.delete(id);
        if (id) events.push({ kind: "result", ts, callId: id });
        if (command && !e.message.isError) for (const label of gitNotes(command, assistantText(content))) events.push({ kind: "git", ts, label });
        continue;
      }
      if (role !== "assistant") continue;
      if (typeof e.message.model === "string" && e.message.model)
        events.push({ kind: "model", ts, model: typeof e.message.provider === "string" && e.message.provider ? `${e.message.provider}/${e.message.model}` : e.message.model });
      if (Array.isArray(content))
        for (const b of content)
          if (typeof b === "object" && b !== null && "type" in b && b.type === "toolCall") {
            const label = stepLabel("name" in b ? b.name : undefined, "arguments" in b ? b.arguments : undefined);
            const [tool, intent = ""] = label.split(" · ");
            const callId = "id" in b && typeof b.id === "string" ? b.id : undefined;
            const ask = tool === "ask" && "arguments" in b ? (askInfo(b.arguments) ?? undefined) : undefined;
            events.push({ kind: "step", ts, label, callId, tool, intent, ...(ask ? { ask, entryId: e.id } : {}) });
            const args = "arguments" in b && typeof b.arguments === "object" && b.arguments !== null ? (b.arguments as Record<string, unknown>) : {};
            if ("id" in b && typeof b.id === "string" && typeof args.command === "string" && /\b(git|gh)\b/.test(args.command))
              rememberCall(b.id, args.command);
          }
      // Owner 2026-10-15: the agent's short narration between tools ("Now I'll launch the reviewers") is shown too;
      // tool names alone ("eval, eval, eval") said nothing.
      if (stopReason !== "stop") {
        const said = oneLine(assistantText(content), 160);
        if (said) events.push({ kind: "note", ts, text: said });
      }
      if (stopReason === "stop") events.push({ kind: "reply", ts, text: assistantText(content), ...(e.id ? { entryId: e.id } : {}) });
      else if (stopReason === "aborted" || stopReason === "error" || stopReason === "length") {
        const err = e.message.errorMessage;
        events.push({ kind: "stopped", ts, reason: stopReason, error: stopReason === "error" && typeof err === "string" ? err.slice(0, 500) : undefined });
      }
    } catch {}
  }
  return { events, consumed: end + 1 };
}

/**
 * Final assistant replies (stopReason "stop", text only) in the complete lines of a JSONL chunk.
 * `consumed` is the byte length of the complete lines (a partial last line is left for later).
 */
export function finalReplies(chunk: Buffer): { texts: string[]; consumed: number } {
  const { events, consumed } = sessionEvents(chunk);
  const texts = events.flatMap((e) => (e.kind === "reply" && e.text ? [e.text] : []));
  return { texts, consumed };
}

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Status message text (pure). Discord `<t:…>` stamps render in the reader's time zone, and the
 * relative ones (":R") keep counting without edits.
 */
export function renderProgress(tab: string, p: Progress): string {
  const s = Math.floor(p.startTs / 1000);
  const l = Math.floor(p.lastTs / 1000);
  const steps = `${p.count} step${p.count === 1 ? "" : "s"}`;
  // Git notes stay visible after the turn ends (the finished status is otherwise one line).
  const git = (p.git ?? []).map((x) => `${x.label} · <t:${Math.floor(x.ts / 1000)}:t>`);
  if (p.state === "done") return [`✅ **${tab}** · turn finished <t:${l}:R> · ${steps} in ${duration(p.lastTs - p.startTs)}`, ...git].join("\n");
  if (p.state === "stopped")
    return [`⏹️ **${tab}** · turn stopped (${p.reason ?? "unknown"}) <t:${l}:R> · ${steps} in ${duration(p.lastTs - p.startTs)}`, ...git].join("\n");
  const lines = p.steps.map((x) => (x.label.startsWith("💬 ") ? `${x.label}` : `• <t:${Math.floor(x.ts / 1000)}:t> ${x.label}`));
  const task = p.task ? [`📝 **Task:** ${p.task}`] : [];
  // Owner 2026-10-19: the same 🤖 Model and 🛠️ Last tool lines as the bridge's Working message.
  // Owner 2026-10-31: reasoning level on its own 🧠 line below the model line.
  const model = p.model
    ? [`🤖 Model: \`${p.model.replace(/[`*_~|<>@]/g, "").slice(0, 80)}\``, ...(p.thinking ? [`🧠 Reasoning: ${p.thinking.replace(/[`*_~|<>@]/g, "").slice(0, 30)}`] : [])]
    : [];
  const lt = p.lastTool;
  const last = lt
    ? `🛠️ **Last tool:** \`${lt.tool.replace(/[`*_~|<>@]/g, "").slice(0, 30)}\`${lt.intent ? `: ${lt.intent}` : ""} · ${lt.done ? "done" : "running"} · called <t:${Math.floor(lt.ts / 1000)}:R>`
    : "🛠️ **Last tool:** none yet";
  return [`⚙️ **${tab}** · working · started <t:${s}:R> · ${steps} · last step <t:${l}:R>`, ...model, ...renderSubagents(p.subagents, p.model), ...task, ...git, ...lines, last].join("\n");
}

/** Apply one event to a channel's progress (pure). Returns the new progress and whether to edit now. */
export function applyEvent(p: Progress | undefined, ev: SessionEvent): { p: Progress | undefined; urgent: boolean } {
  const fresh = (ts: number): Progress => ({ startTs: ts, lastTs: ts, count: 0, steps: [], state: "working", ...(p?.msgId ? { msgId: p.msgId } : {}) });
  switch (ev.kind) {
    case "turn": {
      // A steering message during a running turn keeps the same status message.
      if (p?.state === "working") return { p, urgent: false };
      // Card job-status-last: a new turn reuses the channel's one status card (edited in place, never a second card).
      return { p: { ...fresh(ev.ts), task: ev.text || undefined, model: p?.model, thinking: p?.thinking }, urgent: false };
    }
    case "note": {
      const cur = p?.state === "working" ? p : fresh(ev.ts);
      const steps = [...cur.steps, { ts: ev.ts, label: `💬 ${ev.text}` }].slice(-PROGRESS_STEPS);
      return { p: { ...cur, steps, lastTs: ev.ts }, urgent: false };
    }
    case "step": {
      const cur = p?.state === "working" ? p : fresh(ev.ts);
      const steps = [...cur.steps, { ts: ev.ts, label: ev.label }].slice(-PROGRESS_STEPS);
      const lastTool = { ts: ev.ts, tool: ev.tool ?? ev.label, intent: ev.intent ?? "", callId: ev.callId, done: false };
      return { p: { ...cur, steps, count: cur.count + 1, lastTs: ev.ts, lastTool }, urgent: false };
    }
    case "git": {
      const cur = p?.state === "working" ? p : fresh(ev.ts);
      const git = [...(cur.git ?? []), { ts: ev.ts, label: ev.label }].slice(-PROGRESS_GIT);
      return { p: { ...cur, git, lastTs: ev.ts }, urgent: false };
    }
    case "result":
      if (p?.lastTool && p.lastTool.callId === ev.callId && !p.lastTool.done) return { p: { ...p, lastTool: { ...p.lastTool, done: true } }, urgent: false };
      return { p, urgent: false };
    case "model":
      if (!p || p.model === ev.model) return { p, urgent: false };
      return { p: { ...p, model: ev.model }, urgent: false };
    case "thinking":
      if (!p || p.thinking === ev.level) return { p, urgent: false };
      return { p: { ...p, thinking: ev.level }, urgent: false };
    case "reply":
    case "stopped":
      // No tool steps in this turn: no status message is needed, the reply says it all.
      if (!p || p.state !== "working") return { p, urgent: false };
      if (!p.msgId && p.count === 0) return { p: undefined, urgent: false };
      // A reused card (job-status-last) keeps its last content for a turn without tool steps.
      if (p.count === 0) return { p: { ...p, state: ev.kind === "reply" ? "done" : "stopped", reason: ev.kind === "stopped" ? ev.reason : undefined }, urgent: false };
      return {
        p: { ...p, state: ev.kind === "reply" ? "done" : "stopped", reason: ev.kind === "stopped" ? ev.reason : undefined, lastTs: ev.ts },
        urgent: true,
      };
  }
}

export type StatusPoster = (channelId: string, text: string, msgId?: string) => Promise<string | undefined>;

/** Recent user/assistant text of a session file tail, as a read-only context excerpt (pure). */
export function transcriptExcerpt(tail: Buffer, maxChars = 6000): string {
  const out: string[] = [];
  for (const line of tail.toString("utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } };
      if (e.type !== "message") continue;
      if (e.message?.role === "user") {
        const t = assistantText(e.message.content);
        if (t) out.push(`USER: ${t.slice(0, 1500)}`);
      } else if (e.message?.role === "assistant" && e.message.stopReason === "stop") {
        const t = assistantText(e.message.content);
        if (t) out.push(`ASSISTANT: ${t.slice(0, 2500)}`);
      }
    } catch {}
  }
  let text = "";
  for (const part of out.reverse()) {
    if (text.length + part.length > maxChars) break;
    text = `${part}\n\n${text}`;
  }
  return text.trim();
}

/** How a Discord message in a mirrored channel runs. */
export type Decision =
  | { mode: "pane"; entry: MirrorEntry; sessionFile: string; cwd: string; key: string }
  | { mode: "side"; entry: MirrorEntry; key: string; cwd: string; reason: string; context: string }
  | { mode: "busy"; entry: MirrorEntry; cwd: string; reason: string };

/**
 * Card discord-side-run-duplicates-job-pane (2026-11-01): a live omp in the job pane already works in its repo
 * folder. A second `omp -p` there (side session or thread) writes the same files. Busy = main-host pane, live omp,
 * cwd is a project folder (not the ~/Github root), and the channel is not FIRSTMATE (its side session is by design).
 */
/** Reply when a message would start a second run next to a live job pane. */
export function busyReply(tab: string, paneId: string, cwd: string): string {
  return `⛔ Not started: the job pane **${tab}** (${paneId}) is live and works in \`${cwd.replace(/^.*\/Github\//, "~/Github/")}\`. A second omp run there would edit the same files. Wait until the job ends, then send the message again (or stop the job first).`;
}

export function liveJobBusy(o: { machine: string; cwd: string; github: string; live: boolean; firstmate: boolean; archived?: boolean }): boolean {
  return o.live && !o.firstmate && !o.archived && o.machine === "main" && o.cwd !== o.github && o.cwd.startsWith(`${o.github}/`);
}

const GITHUB = join(homedir(), "Github");

/** Side session for a mirrored channel: FIRSTMATE keeps its dedicated session; threads get their own. */
export function sideSessionKey(e: MirrorEntry, threadId: string | null): string {
  if (threadId) return threadId;
  return e.machine === "main" && e.tab === "FIRSTMATE" ? FIRSTMATE_SESSION.key : `side-${e.channelId}`;
}

export class Mirror {
  entries: MirrorEntry[] = [];
  hostOk = new Map<Machine, boolean>();
  /** Channel ids with a pane-mode run in progress (tail skips them). */
  busy = new Set<string>();
  #syncing = false;
  #tailing = false;
  /** Channels whose status message has unsent changes, and when each was last edited. */
  #pending = new Set<string>();
  #lastEdit = new Map<string, number>();
  /** Subagent session tails per subagent file (card job-subagents-line). */
  #subTails = new Map<string, SessionTail>();
  /** Wait cards of panes that closed or switched session; closed on the next tail. */
  #staleWaits: { e: MirrorEntry; w: PaneWait; why: string }[] = [];
  /** Posts one line to #omp-alerts (set by main). */
  alert: ((text: string) => void) | null = null;
  /** Categories already reported full in this bot run. */
  #fullAlerted = new Set<string>();
  /** Category id -> time until it counts as full (Discord said full while the cache count was lower). */
  #fullUntil = new Map<string, number>();
  #categoryFull(key: string, text: string): void {
    if (this.#fullAlerted.has(key)) return;
    this.#fullAlerted.add(key);
    this.alert?.(`⚠️ Discord category limit: ${text}.`);
  }
  /** Owner 2026-10-24: Discord blocked channel creates until this time (ms); the sync skips creates until then.
   * Owner 2026-10-30: saved in create-pause.json next to agents.json, so a restart does not send a refused create. */
  #pausedUntil = 0;
  get createPausedUntil(): number {
    return this.#pausedUntil;
  }
  set createPausedUntil(v: number) {
    this.#pausedUntil = v;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const f = join(dirname(this.file), "create-pause.json");
      writeFileSync(`${f}.tmp`, JSON.stringify({ until: v }), { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch (e) {
      log(`saving create pause failed: ${(e as Error).message}`);
    }
  }
  /** Text channel that holds pane threads while creates are blocked (config mirror.threadHome). */
  threadHome: string = CONFIG.mirror.threadHome ?? "";
  /** Pane id -> last "no channel" reason logged, so a skipped create logs once, not every 15 s (4,062 lines in 36 h). */
  #skipLogged = new Map<string, string>();
  #skip(p: LivePane, why: string): null {
    if (this.#skipLogged.get(p.paneId) !== why) log(`no channel for ${p.name} (${p.machine}:${p.paneId}): ${why}`);
    this.#skipLogged.set(p.paneId, why);
    return null;
  }
  /** config.json that keeps `mirror.overflow` (tests point it at a scratch file). */
  configFile = CONFIG_FILE;
  /** Last overflow-category create attempt (ms); at most one try per OVERFLOW_RETRY_MS after a failure. */
  #overflowFailedAt = 0;
  /** Last failed 🧵 jobs channel create and last failed thread-to-channel move (ms); retried after OVERFLOW_RETRY_MS.
   * One shared move time: a refused create stops every thread-only pane's move for the window, not one pane only. */
  #homeFailedAt = 0;
  #promoteFailedAt = 0;
  /** Thread creates refused (permission, thread cap, rate limit) until this time (ms). */
  #threadBlockedUntil = 0;
  /** Owner 2026-10-30 (card mirror-create-loop): Herdr tab -> last refused channel create (ms). One try per pane per
   * OVERFLOW_RETRY_MS; rate limits (createPausedUntil) and full categories (#fullUntil) have their own gates.
   * Keyed by tab id: a Herdr restart changes pane ids, not tab ids. */
  #paneCreateFailedAt = new Map<string, number>();
  /** Channel id -> last failed move into a stack category (ms); retried after OVERFLOW_RETRY_MS. */
  #moveFailedAt = new Map<string, number>();
  /** Posts one line to FIRSTMATE (set by main); null: #omp-alerts (`alert`). */
  alertFirstmate: ((text: string) => void) | null = null;
  /** One FIRSTMATE alert per key in this bot run. */
  #alertOnce(key: string, text: string): void {
    if (this.#fullAlerted.has(key)) return;
    this.#fullAlerted.add(key);
    (this.alertFirstmate ?? this.alert)?.(text);
  }
  /** Owner 2026-10-30 (card bot-upgrades-1030): stack name -> category ids (config mirror.stackCategories).
   * null: no split (main panes use 🖥️ Main + overflow). Tests set it. */
  stackCats: Record<string, string[]> | null = CONFIG.mirror.stackCategories ? parseStackCategories(CONFIG.mirror.stackCategories) : null;
  /** Stacks and FIRSTMATE cards for paneStack() (tests replace them). */
  stacks: () => StackDef[] = defaultStacks;
  cards: () => StackCard[] = defaultCards;
  /** Last category create of any kind (ms) and last failed stack-category create (ms, all stacks share it):
   * one category at a time, and one try per hour after a failure. */
  #lastCatCreate = 0;
  #catFailedAt = 0;
  /** Owner 2026-11-07 (card server-full-auto-drop): the server-full sweep. Null (off) unless main.ts sets it to
   * runServerSweep: a test with a full fake guild must never run a real drop with the main's bot token. */
  serverSweep: ((hold: string[]) => Promise<ServerSweepResult>) | null = null;
  /** Channels of panes matched again in the current sync pass (their agents.json entry is saved at the pass end). */
  #passHold = new Set<string>();
  #sweepAt = 0;
  #sweeping: Promise<number> | null = null;
  /** Channels the last sweep deleted: a caller inside its window may try its create again. */
  #lastFreed = 0;
  /** Discord refused a create as "server full" and the sweep freed nothing: until then a create first tries a sweep. */
  #serverFullUntil = 0;
  /**
   * Owner 2026-11-07: run the server-full sweep (one at a time, at most one per SERVER_SWEEP_GAP_MS, never more than
   * SERVER_SWEEP_MAX channels), drop the deleted ids from the cache, reopen the gates the full server closed and tell
   * #omp-alerts once with the names. Returns the number of channels deleted (inside the window: the last sweep's).
   * Public for tests.
   */
  async sweepServer(guild: Guild, why: string): Promise<number> {
    const sweep = this.serverSweep;
    if (!sweep) return 0; // no sweeper wired (tests, or main.ts did not set one)
    if (this.#sweeping) return this.#sweeping;
    if (Date.now() - this.#sweepAt < SERVER_SWEEP_GAP_MS) return this.#lastFreed;
    this.#sweepAt = Date.now();
    this.#lastFreed = 0;
    const hour = Math.floor(Date.now() / OVERFLOW_RETRY_MS);
    const run = async (): Promise<number> => {
      await null; // the single-flight promise below is set before any of this runs
      try {
        const hold = new Set([...this.#passHold, ...this.detached, ...this.entries.filter((x) => !x.archived).map((x) => x.channelId)]);
        const r = await sweep([...hold]);
        if (!r.ids.length) {
          log(`server sweep (${why}): no deletable channel`);
          this.#alertOnce(`sweep-none:${hour}`, `⚠️ The Discord server is full (${why}) and the sweep found no channel it may delete (all held: open card, ask menu, queued job, keep list, live pane or active in the last hour). At 500 channels new jobs use a 🧵 thread until a slot frees.`);
          return 0;
        }
        for (const id of r.ids) guild.channels.cache.delete(id);
        if (r.ids.length > SERVER_SWEEP_MAX) this.alert?.(`🚨 The server-full sweep deleted ${r.ids.length} channels, more than the ${SERVER_SWEEP_MAX} allowed. Check scripts/purge-archive.py --drop-oldest.`);
        // Freed slots reopen only the gates the full server closed (other failures keep their own hour-long gates):
        // the "server full" window, and the one-per-minute category gap, so a category is made right after the sweep.
        this.#serverFullUntil = 0;
        this.#lastCatCreate = 0;
        this.#fullAlerted.delete("guild-limit");
        this.#lastFreed = r.ids.length;
        const names = r.names.map((n) => `#${n}`).join(", ");
        log(`server sweep (${why}): deleted ${r.ids.length} oldest idle channels: ${names}`);
        this.alert?.(`🧹 The Discord server was full (${why}): deleted the ${r.ids.length} oldest idle closed-job channels (JSON + HTML copies saved): ${names}. Job channels are created now.`);
        return r.ids.length;
      } catch (err) {
        log(`server sweep (${why}) failed: ${(err as Error).message}`);
        this.#alertOnce(`sweep-fail:${hour}`, `⚠️ The Discord server is full (${why}) and the channel sweep failed: ${(err as Error).message.slice(0, 300)}. New jobs use a 🧵 thread meanwhile.`);
        return 0;
      } finally {
        this.#sweeping = null;
      }
    };
    this.#sweeping = run();
    return this.#sweeping;
  }
  /**
   * Permission overwrites for a new pane category, copied from the first existing category among `ids`
   * (🖥️ Main first). Null when none exists: the caller must not create a category with server default permissions.
   */
  #overwrites(guild: Guild, ids: string[]): { id: string; type: number; allow: bigint; deny: bigint }[] | null {
    for (const id of ids) {
      const c = id ? guild.channels.cache.get(id) : undefined;
      if (c && "permissionOverwrites" in c) return [...c.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
    }
    return null;
  }
  /**
   * Owner 2026-10-30 (card bot-upgrades-1030): create the next category of a stack ("💹 finance", then
   * "💹 finance 2") with the 🖥️ Main permission overwrites, after the last pane category, and save it in config.json
   * `mirror.stackCategories`. At most one category create per STACK_CATEGORY_GAP_MS, never during a create pause,
   * and one try per OVERFLOW_RETRY_MS after any failure (all stacks). Returns the id or undefined. Public for tests.
   */
  async addStackCategory(guild: Guild, stack: StackDef, ids: string[], baseId: string): Promise<string | undefined> {
    const now = Date.now();
    if (!this.stackCats || now < this.createPausedUntil || now - this.#lastCatCreate < STACK_CATEGORY_GAP_MS) return undefined;
    // Card server-full-auto-drop: Discord said "server full" -> no category create until the sweep frees slots.
    if (now - this.#catFailedAt < OVERFLOW_RETRY_MS || now < this.#serverFullUntil) return undefined;
    const channels = serverChannelCount(guild);
    // The server limit is the sweep's job (make() sweeps at SERVER_SWEEP_AT), so this local refusal sets no hour-long
    // failure gate. A category needs room for itself and its first channel.
    if (channels >= GUILD_CHANNEL_LIMIT - 1) {
      this.#categoryFull("guild-limit", `the server has ${channels}/${GUILD_CHANNEL_LIMIT} channels; no new stack category`);
      return undefined;
    }
    const allIds = [baseId, ...Object.values(this.stackCats).flat(), ...overflowList("main")];
    const permissionOverwrites = this.#overwrites(guild, allIds);
    if (!permissionOverwrites) {
      this.#catFailedAt = now;
      this.#alertOnce("stackcat-noperm", "⚠️ No pane category is left to copy permissions from, so the bot does not create stack categories (a new one would use the server default permissions). Create one category with the right permissions and add its id to config.json mirror.stackCategories.");
      return undefined;
    }
    this.#lastCatCreate = now;
    const positions = allIds
      .map((id) => guild.channels.cache.get(id))
      .map((c) => (c && "position" in c && typeof c.position === "number" ? c.position : -1))
      .filter((x) => x >= 0);
    // The next unused name: after "💹 finance" was deleted, "💹 finance 2" stays and the new one is "💹 finance 3".
    const taken = new Set(ids.map((id) => guild.channels.cache.get(id)?.name));
    let k = ids.length;
    while (taken.has(stackCategoryName(stack, k))) k++;
    const name = stackCategoryName(stack, k);
    try {
      const cat = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites, ...(positions.length ? { position: Math.max(...positions) + 1 } : {}), reason: `stack ${stack.name} pane channels` });
      this.stackCats[stack.name] = [...ids, cat.id];
      log(`created stack category ${name} (${cat.id})`);
      // Owner 2026-11-01: bots cannot mute a category; tell the owner so they can mute it once.
      this.alert?.(`🗂️ New category "${name}" ${channelMention(cat.id, "")}: mute it once (long-press → Mute) and its future channels stay quiet.`);
      await this.orderCategories(guild, baseId);
      try {
        saveMirrorValue("stackCategories", this.stackCats, this.configFile);
      } catch (e) {
        log(`stack category ${cat.id} made, but saving config.json failed: ${(e as Error).message}`);
        this.alert?.(`⚠️ Created category "${name}" (${cat.id}) but could not save it in config.json mirror.stackCategories: ${(e as Error).message}. Add the id by hand before the next bot restart.`);
      }
      return cat.id;
    } catch (err) {
      // Server full (30013): the sweep in make() handles it (and reopens the category gap), not the hour-long gate.
      const full = SERVER_FULL_RE.test((err as Error).message);
      if (full) this.#serverFullUntil = Date.now() + SERVER_SWEEP_GAP_MS;
      else this.#catFailedAt = Date.now();
      const wait = rateLimitWait(err);
      if (wait !== null) this.createPausedUntil = Date.now() + wait;
      log(`create stack category ${name} failed: ${(err as Error).message}`);
      if (wait === null && !full) this.#alertOnce("stackcat-fail", `⚠️ Could not create category "${name}" (${(err as Error).message}). Pane channels stay in 🖥️ Main; the bot tries one stack category again in one hour.`);
      return undefined;
    }
  }
  /** Category order fixed in this bot run (one try per run; each new stack category orders again). */
  #catsOrdered = false;
  /**
   * Owner 2026-10-30 (review): keep 🖥️ Main and the stack categories together (stacks by name, each stack's
   * overflow after it); the other categories keep their order. One bulk PATCH, only when the order is off.
   */
  async orderCategories(guild: Guild, baseId: string): Promise<void> {
    this.#catsOrdered = true;
    if (!this.stackCats) return;
    // Owner 2026-11-07 (card stack-emoji-unique): a stack whose emoji changed renames its categories once per run.
    const byName = new Map(this.stacks().map((s) => [s.name, s]));
    for (const [name, ids] of Object.entries(this.stackCats)) {
      const stack = byName.get(name);
      if (!stack) continue;
      for (const id of ids) {
        const cat = guild.channels.cache.get(id);
        const m = cat?.name.match(new RegExp(`^(.*?) (${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?: \\d+)?)$`));
        if (!cat || !m || emojiKey(m[1]!) === emojiKey(stack.emoji ?? "")) continue;
        const want = `${stack.emoji} ${m[2]}`.slice(0, 100);
        // Not awaited: a channel rename rate limit (2 per 10 min) must not stall startup or the reorder below.
        void cat.edit({ name: want, reason: "unique stack emoji" }).then(() => log(`renamed category ${cat.name} -> ${want}`), (err: Error) => log(`rename category ${id} failed: ${err.message}`));
      }
    }
    const group = [baseId, ...Object.keys(this.stackCats).sort().flatMap((s) => this.stackCats?.[s] ?? [])];
    const cats = [...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((c) => ({ id: c.id, position: "position" in c && typeof c.position === "number" ? c.position : 0 }));
    const want = categoryOrder(cats, group);
    const now = categoryOrder(cats, []);
    if (want.join() === now.join() && new Set(cats.map((c) => c.position)).size === cats.length) return;
    log(`order ${want.length} categories`);
    await guild.channels.setPositions(want.map((id, i) => ({ channel: id, position: i }))).catch((err: Error) => log(`category order failed: ${err.message}`));
  }
  /**
   * Owner 2026-10-28 (card stack-catalog): create the next pane overflow category with the same permission
   * overwrites as the machine's own category, add it to OVERFLOW_IDS and `cats`, and save it in config.json.
   * Returns its id, or undefined (alerted once) when it cannot be made. Public for tests.
   */
  async addOverflow(guild: Guild, baseId: string, cats: string[], machine = "main"): Promise<string | undefined> {
    const list = overflowList(machine);
    if (Date.now() - this.#overflowFailedAt < OVERFLOW_RETRY_MS || Date.now() - this.#lastCatCreate < STACK_CATEGORY_GAP_MS || Date.now() < this.#serverFullUntil) return undefined;
    // Threads do not count toward the server limit (the cache holds active threads too).
    const channels = serverChannelCount(guild);
    if (channels >= GUILD_CHANNEL_LIMIT - 1) {
      // No hour-long gate for the server limit: the sweep in make() frees slots and the next try may run at once.
      this.#categoryFull("guild-limit", `the server has ${channels}/${GUILD_CHANNEL_LIMIT} channels; no new pane category`);
      return undefined;
    }
    const base = guild.channels.cache.get(baseId);
    const last = guild.channels.cache.get(cats[cats.length - 1] ?? baseId);
    const name = overflowName(base?.name ?? "🖥️ Main", cats.length);
    // Never a pane category with server default permissions (owner privacy): copy 🖥️ Main, else an overflow category.
    const permissionOverwrites = this.#overwrites(guild, [baseId, ...cats]);
    if (!permissionOverwrites) {
      this.#overflowFailedAt = Date.now();
      this.#categoryFull("no-perm-source", `no ${machine} pane category is left to copy permissions from; no new pane category`);
      return undefined;
    }
    this.#lastCatCreate = Date.now();
    try {
      const cat = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites, ...(last && "position" in last ? { position: last.position + 1 } : {}), reason: "pane categories full" });
      list.push(cat.id);
      cats.push(cat.id);
      try {
        saveOverflowIds(list, this.configFile, overflowKey(machine));
      } catch (e) {
        log(`overflow category ${cat.id} made, but saving config.json failed: ${(e as Error).message}`);
        this.alert?.(`⚠️ Created pane category "${name}" (${cat.id}) but could not save it in config.json mirror.overflow: ${(e as Error).message}. Add the id by hand before the next bot restart.`);
      }
      log(`created overflow category ${name} (${cat.id}); pane categories: ${cats.length}`);
      this.alert?.(`🗂️ All pane categories were full: created category "${name}" ${channelMention(cat.id, "")} for new pane channels. Mute it once (long-press → Mute) and its future channels stay quiet.`);
      return cat.id;
    } catch (err) {
      // Server full (30013): the sweep in make() handles it (and reopens the category gap), not the hour-long gate.
      if (SERVER_FULL_RE.test((err as Error).message)) this.#serverFullUntil = Date.now() + SERVER_SWEEP_GAP_MS;
      else this.#overflowFailedAt = Date.now();
      const wait = rateLimitWait(err);
      if (wait !== null) this.createPausedUntil = Date.now() + wait;
      log(`create overflow category ${name} failed: ${(err as Error).message}`);
      this.#categoryFull(`overflow:${Math.floor(Date.now() / OVERFLOW_RETRY_MS)}`, `pane categories are full and creating "${name}" failed (${(err as Error).message}); new panes get no channel`);
      return undefined;
    }
  }

  constructor(
    private client: Client | null,
    private file = MAP_FILE,
    /** Channel ids detached from their pane: never updated, renamed, archived or tailed. */
    private detached: Set<string> = DETACHED_CHANNEL_IDS,
  ) {
    try {
      const saved: unknown = JSON.parse(readFileSync(join(dirname(file), "create-pause.json"), "utf8"));
      if (saved && typeof saved === "object" && "until" in saved && typeof saved.until === "number") this.#pausedUntil = saved.until;
    } catch { /* no saved pause */ }
    if (!existsSync(file)) return;
    try {
      this.entries = (JSON.parse(readFileSync(file, "utf8")) as MirrorEntry[]).map(
        ({ machine, paneId, tabId, workspace, tab, name, channelId, archived, cwd, sessionFile, offset, progress, watch, wait, threadOnly }) =>
          ({ machine, paneId, tabId, workspace, tab, name, channelId, archived, cwd, sessionFile, offset, progress, watch, wait, ...(threadOnly ? { threadOnly } : {}) }),
      );
    } catch {
      this.entries = [];
    }
  }

  save(): void {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** Owner 2026-10-30: the live channel of a card's `job` token (pane id, tab id, tab label or channel name). Main only: card jobs are main panes, ids repeat per machine. */
  byJob(token: string): MirrorEntry | undefined {
    const t = token.trim().toLowerCase();
    if (!t) return undefined;
    const live = this.entries.filter((e) => e.machine === "main" && !e.archived && !this.detached.has(e.channelId));
    // Ids first, labels only when no id matches; more than one channel = unresolved (never guess).
    for (const keys of [(e: MirrorEntry) => [e.paneId, e.tabId], (e: MirrorEntry) => [e.tab, e.name]]) {
      const hits = new Set(live.filter((e) => keys(e).some((v) => v?.toLowerCase() === t)).map((e) => e.channelId));
      if (hits.size === 1) return live.find((e) => e.channelId === [...hits][0]);
      if (hits.size > 1) return undefined;
    }
    return undefined;
  }

  byChannel(channelId: string): MirrorEntry | undefined {
    if (this.detached.has(channelId)) return undefined; // local-omp channels: never a pane route
    return this.entries.find((e) => e.channelId === channelId);
  }

  /**
   * Owner 2026-10-30: the pane entry for a message channel, and the thread id when the message is in a thread
   * under the pane channel. A pane thread in the 🧵 jobs channel is the pane's own channel (threadId null).
   */
  resolve(channelId: string, parentId: string | null): { entry: MirrorEntry | undefined; threadId: string | null } {
    const own = this.byChannel(channelId);
    if (own?.threadOnly) return { entry: own, threadId: null };
    return { entry: this.byChannel(parentId ?? channelId), threadId: parentId ? channelId : null };
  }

  /** Reconcile live panes (one host) into entries; pure apart from entry mutation. Returns work to do. */
  plan(machine: Machine, live: LivePane[]): { create: LivePane[]; update: { e: MirrorEntry; p: LivePane }[]; archive: MirrorEntry[] } {
    const liveIds = new Set(live.map((p) => p.paneId));
    const create: LivePane[] = [];
    const update: { e: MirrorEntry; p: LivePane }[] = [];
    const claimed = new Set<MirrorEntry>();
    const free = (x: MirrorEntry) => x.machine === machine && !claimed.has(x);
    // Detached channels keep their pane claimed (no new channel for it) but get no update or archive.
    for (const x of this.entries) if (x.machine === machine && this.detached.has(x.channelId)) claimed.add(x);
    // Stable mapping: pane id first (all panes), then tab id (Herdr restart changes pane ids), then name.
    const exact = new Map(live.map((p) => [p, this.entries.find((x) => free(x) && x.paneId === p.paneId)]));
    for (const e of exact.values()) if (e) claimed.add(e);
    const detachedPanes = new Set(this.entries.filter((x) => x.machine === machine && this.detached.has(x.channelId)).map((x) => x.paneId));
    for (const p of live) {
      if (detachedPanes.has(p.paneId)) continue;
      const e =
        exact.get(p) ??
        this.entries.find((x) => free(x) && x.tabId === p.tabId && !liveIds.has(x.paneId)) ??
        this.entries.find((x) => free(x) && x.name === p.name && !liveIds.has(x.paneId));
      if (e) {
        claimed.add(e);
        update.push({ e, p });
      } else create.push(p);
    }
    const archive = this.entries.filter((x) => x.machine === machine && !x.archived && !claimed.has(x));
    return { create, update, archive };
  }

  /**
   * The text channel that holds pane threads: config mirror.threadHome, else #omp-alerts (owner 2026-10-31).
   * Never creates a channel; returns undefined when neither channel exists. Single source of truth for
   * #thread(); public for tests.
   */
  async threadHomeChannel(guild: Guild): Promise<TextChannel | undefined> {
    // Owner 2026-10-31: job threads open in #omp-alerts (an existing channel); the bot never creates a 🧵-jobs channel.
    const id = this.threadHome || CONFIG.alertsChannelId || "";
    const have = id ? guild.channels.cache.get(id) : undefined;
    return have?.type === ChannelType.GuildText ? (have as TextChannel) : undefined;
  }


  /** A public thread for the pane in the thread home (threadHomeChannel); its first message holds the topic text. */
  async #thread(guild: Guild, p: LivePane, why: string): Promise<{ id: string; threadOnly: true } | null> {
    // Only an existing home is used (no create call): mirror.threadHome, else #omp-alerts.
    const home = await this.threadHomeChannel(guild);
    if (!home) return this.#skip(p, `${why}; no thread home (mirror.threadHome or #omp-alerts)`);
    // A refused thread create (permission, thread cap, rate limit) is retried only after the block ends.
    if (Date.now() < this.#threadBlockedUntil) return this.#skip(p, `${why}; thread creates blocked until ${new Date(this.#threadBlockedUntil).toISOString()}`);
    try {
      const t = await home.threads.create({ name: channelTitle(p.name, p.machine, p.short).slice(0, 100), type: ChannelType.PublicThread, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason: why });
      await t.send({ content: `🧵 ${this.#topic(p)}\nNo own channel yet: ${why}. This thread moves to a channel when Discord allows it.`, allowedMentions: { parse: [] } }).catch(() => {});
      this.#skipLogged.delete(p.paneId);
      log(`created thread ${t.id} for ${p.name} (${p.machine}:${p.paneId}): ${why}`);
      return { id: t.id, threadOnly: true };
    } catch (err) {
      this.#threadBlockedUntil = Date.now() + (rateLimitWait(err) ?? OVERFLOW_RETRY_MS);
      return this.#skip(p, `${why}; thread create failed: ${(err as Error).message}`);
    }
  }

  /** Move a thread-only entry to its new channel: link it in the thread, remap, archive the thread. */
  async #promote(guild: Guild, e: MirrorEntry, channelId: string): Promise<void> {
    const old = (guild.channels.cache.get(e.channelId) ?? (await this.client?.channels.fetch(e.channelId).catch(() => null))) as ThreadChannel | null | undefined;
    log(`moved ${e.name} from thread ${e.channelId} to channel ${channelId}`);
    e.channelId = channelId;
    delete e.threadOnly;
    e.progress = undefined; // the status message lives in the thread
    // An open card moves with the pane: tail() posts it again in the channel (msgId unset).
    e.wait = e.wait && !e.wait.sending ? { ...e.wait, msgId: undefined } : undefined;
    if (old?.isThread()) {
      await old.send({ content: `➡️ This pane now has its own channel: ${channelMention(channelId, "a new channel")}.`, allowedMentions: { parse: [] } }).catch(() => {});
      await old.setArchived(true).catch(() => {});
    }
  }

  #topic(p: LivePane): string {
    return `Mirrors Herdr ${p.machine}:${p.paneId} (tab ${p.tab}). Terminal replies are posted here. Messages here never type into the pane: they continue its session only when no omp process holds it, otherwise a linked side session runs.`;
  }

  /**
   * Owner decision 2026-10-14: a mirrored channel was deleted in Discord. Close its Herdr tab only
   * when the tab's agent is idle; if it is working or waiting for input (or its state is unknown),
   * leave the tab open (the next sync recreates the channel). Returns what happened.
   */
  async closeDeleted(channelId: string): Promise<{ tab: string; result: "closed" | "busy" | "unknown" | "failed" } | null> {
    const e = this.entries.find((x) => x.channelId === channelId && !x.archived);
    if (!e) return null;
    const host = HOSTS.find((h) => h.machine === e.machine);
    if (!host || !e.tabId) return { tab: e.tab, result: "unknown" };
    const r = await sh(host.ssh, `${host.herdr} pane list`);
    let status: string | null = null;
    let tabPanes: { id: string; status: string }[] = [];
    try {
      const panes: { pane_id: string; tab_id: string; agent_status?: string }[] = JSON.parse(r.out.toString("utf8")).result.panes;
      status = panes.find((x) => x.pane_id === e.paneId)?.agent_status ?? null;
      tabPanes = panes.filter((x) => x.tab_id === e.tabId).map((x) => ({ id: x.pane_id, status: x.agent_status ?? "unknown" }));
    } catch {}
    if (status === null) return { tab: e.tab, result: "unknown" };
    // Any agent in the tab working or waiting for input blocks the close.
    if (tabPanes.some((x) => x.status === "working" || x.status === "blocked")) return { tab: e.tab, result: "busy" };
    const c = await sh(host.ssh, `${host.herdr} tab close ${JSON.stringify(e.tabId)}`);
    if (c.code !== 0) return { tab: e.tab, result: "failed" };
    this.entries = this.entries.filter((x) => x !== e);
    this.save();
    log(`closed ${e.machine} tab ${e.tabId} (${e.tab}) after its channel was deleted`);
    return { tab: e.tab, result: "closed" };
  }

  async sync(): Promise<void> {
    if (this.#syncing || !this.client || !CATEGORY_IDS.main) return; // no mirror categories configured: mirroring is off
    this.#syncing = true;
    try {
      const guild = await this.client.guilds.fetch(GUILD_ID);
      await guild.channels.fetch();
      for (const host of HOSTS) {
        const r = await sh(host.ssh, `${host.herdr} agent list; printf '\\n@@\\n'; ${host.herdr} tab list; printf '\\n@@\\n'; ${host.herdr} workspace list`);
        const [agentsRaw = "", tabsRaw = "", wsRaw = ""] = r.out.toString("utf8").split("\n@@\n");
        const live = r.code === 0 ? parseHerdr(host.machine, agentsRaw, tabsRaw, wsRaw) : null;
        this.hostOk.set(host.machine, live !== null);
        if (!live) continue; // host offline: leave its channels alone
        await this.apply(guild, host.machine, live);
      }
      this.save();
    } catch (e) {
      log(`sync failed: ${(e as Error).message}`);
    } finally {
      this.#syncing = false;
    }
  }

  /** Public for tests. */
  async apply(guild: Guild, machine: Machine, live: LivePane[]): Promise<void> {
    const { create, update, archive } = this.plan(machine, live);
    // Review 2026-11-07: a server-full sweep in this pass must not delete a channel this pass hands back to its pane.
    this.#passHold = new Set(update.map(({ e }) => e.channelId));
    const parentId = CATEGORY_IDS[machine];
    // A full category (50 channels) must not stop the whole sync pass: catch per pane, alert once.
    // Owner 2026-10-24: never call Discord when every pane category is full or Discord paused channel creates.
    // Retrying every 15 s (4,062 creates in 36 h) made Discord block all channel creates for about 17 h.
    // Owner 2026-10-30: a deleted overflow category (CHANNEL_PARENT_INVALID, "0 channels") must never block new
    // channels: drop ids Discord no longer has, save the list, and let addOverflow make the next one.
    const ovf = overflowList(machine);
    if (guild.channels.cache.size > 0) {
      const gone = ovf.filter((id) => !guild.channels.cache.has(id));
      if (gone.length) {
        for (const id of gone) ovf.splice(ovf.indexOf(id), 1);
        log(`dropped deleted overflow categories: ${gone.join(", ")}`);
        try {
          saveOverflowIds(ovf, this.configFile, overflowKey(machine));
        } catch (e) {
          log(`saving config.json after dropping overflow categories failed: ${(e as Error).message}`);
        }
      }
    }
    // Owner 2026-10-30 (card mirror-create-loop): a deleted pane category is never a create target. A category
    // exists when the cache has it or a cached channel names it as parent (an empty cache: assume it exists).
    const exists = (id: string) => guild.channels.cache.size === 0 || guild.channels.cache.has(id) || [...guild.channels.cache.values()].some((c) => c.parentId === id);
    const baseGone = !!parentId && !exists(parentId);
    if (baseGone && !this.#fullAlerted.has(`missing:${parentId}`)) {
      this.#fullAlerted.add(`missing:${parentId}`);
      log(`${machine} pane category ${parentId} no longer exists; new channels use the overflow or stack categories`);
    }
    const cats = [...(baseGone ? [] : [parentId ?? ""]), ...ovf];
    // Owner 2026-10-30: Discord says "maximum number of channels" while the cache count is lower -> treat the
    // category as full for an hour, so the next or a new overflow category gets the channel.
    const count = (id: string) => ((this.#fullUntil.get(id) ?? 0) > Date.now() ? CATEGORY_LIMIT : [...guild.channels.cache.values()].filter((c) => c.parentId === id).length);
    // Owner 2026-10-30 (card bot-upgrades-1030): main pane channels go to the category of their stack. A deleted
    // stack category id is dropped (and saved). Without a stack category (not made yet, or full and its next one
    // cannot be made yet) the channel uses 🖥️ Main + overflow as before.
    const split = machine === "main" && this.stackCats !== null;
    const stackCats = this.stackCats ?? {};
    const stacks = split ? this.stacks() : [];
    const cards = split ? this.cards() : [];
    if (split && guild.channels.cache.size > 0) {
      let dropped = false;
      for (const [s, ids] of Object.entries(stackCats)) {
        const keep = ids.filter(exists);
        if (keep.length === ids.length) continue;
        dropped = true;
        log(`dropped deleted ${s} stack categories: ${ids.filter((id) => !keep.includes(id)).join(", ")}`);
        if (keep.length) stackCats[s] = keep;
        else delete stackCats[s];
      }
      if (dropped) {
        try {
          saveMirrorValue("stackCategories", stackCats, this.configFile);
        } catch (e) {
          log(`saving config.json after dropping stack categories failed: ${(e as Error).message}`);
        }
      }
    }
    if (split && !this.#catsOrdered && !baseGone && parentId && guild.channels.cache.size > 0) await this.orderCategories(guild, parentId);
    const stackOf = (p: LivePane | MirrorEntry) => paneStack(p, cards, stacks);
    /** A category of stack `s` with room; with `create`, makes the stack's next category (one at a time, gated). */
    const stackParent = async (s: string, create: boolean): Promise<string | undefined> => {
      if (!split) return undefined;
      const ids = stackCats[s] ?? [];
      const room = pickPaneCategory(ids, count);
      if (room !== undefined || !create) return room;
      const def = stacks.find((x) => x.name === s);
      return def ? this.addStackCategory(guild, def, ids, parentId ?? "") : undefined;
    };
    let moves = 0;
    /** True once make() sent a channel create to Discord (a promote that only hit a local gate is not a failure). */
    let attempted = false;
    /** True when make() fell back because the server is full: the sweep window gates it, not the hour-long promote gate. */
    let fullFail = false;
    /** Move a channel into a stack category (counts toward MOVES_PER_PASS). A failed move waits OVERFLOW_RETRY_MS. */
    const move = async (ch: TextChannel, target: string, s: string): Promise<boolean> => {
      if (Date.now() - (this.#moveFailedAt.get(ch.id) ?? 0) < OVERFLOW_RETRY_MS) return false;
      moves++;
      try {
        await ch.setParent(target, { lockPermissions: false });
        this.#moveFailedAt.delete(ch.id);
        log(`moved ${ch.name} to the ${s} stack category ${target}`);
        return true;
      } catch (err) {
        this.#moveFailedAt.set(ch.id, Date.now());
        log(`move ${ch.name} to ${target} failed: ${(err as Error).message}`);
        if (/maximum number of channels/i.test((err as Error).message)) this.#fullUntil.set(target, Date.now() + OVERFLOW_RETRY_MS);
        return false;
      }
    };
    // Owner 2026-10-30 (card discord-thread-fallback): when no channel can be made, the pane gets a public thread
    // in the 🧵 jobs channel, so the owner can still read replies, answer menus and type. allowThread=false: real channel only.
    const make = async (p: LivePane, allowThread = true): Promise<{ id: string; threadOnly?: true } | null> => {
      const now = Date.now();
      const fallback = (why: string) => (allowThread ? this.#thread(guild, p, why) : this.#skip(p, why));
      if (now < this.createPausedUntil) return fallback(`Discord blocks channel creates until ${new Date(this.createPausedUntil).toISOString()}`);
      // Owner 2026-10-30 (card mirror-create-loop): after a refused create, one try per pane per hour.
      const failKey = p.tabId ? `${p.tabId}:${p.name}` : p.paneId;
      const failedAt = this.#paneCreateFailedAt.get(failKey) ?? 0;
      if (now - failedAt < OVERFLOW_RETRY_MS) return fallback(`the last channel create failed at ${new Date(failedAt).toISOString()}; next try after ${new Date(failedAt + OVERFLOW_RETRY_MS).toISOString()}`);
      // Owner 2026-11-07 (card server-full-auto-drop): a (nearly) full server first sweeps the oldest idle closed-job
      // channels; the create follows at once (no hour wait). Nothing deletable at 495-499: the create still goes out.
      const serverFull = () => serverChannelCount(guild) >= SERVER_SWEEP_AT || Date.now() < this.#serverFullUntil;
      if (serverFull()) {
        await this.sweepServer(guild, `${serverChannelCount(guild)}/${GUILD_CHANNEL_LIMIT} channels before the create for ${p.name}`);
        if (serverChannelCount(guild) >= GUILD_CHANNEL_LIMIT || Date.now() < this.#serverFullUntil) {
          fullFail = true;
          return fallback(`the server is full (${serverChannelCount(guild)}/${GUILD_CHANNEL_LIMIT}) and no channel could be dropped yet`);
        }
      }
      const pickParent = async (): Promise<string | undefined> => {
        const own = await stackParent(stackOf(p), true);
        if (Date.now() < this.createPausedUntil) return undefined; // the caller falls back for the pause
        const got = own ?? pickPaneCategory(cats, count);
        // Owner 2026-10-28: every main pane category full -> create the next "🖥️ Main N" overflow category.
        // With the stack split, stack categories replace that: the pane waits in a 🧵 thread for its stack category.
        return got === undefined && parentId && !split ? this.addOverflow(guild, parentId, cats, machine) : got;
      };
      let parent = await pickParent();
      // A new category refused for the server limit (cache count, or Discord's 30013 on the category): sweep, then
      // try once more in this pass.
      if (parent === undefined && Date.now() >= this.createPausedUntil && serverFull() && (await this.sweepServer(guild, `no room for a new pane category (${serverChannelCount(guild)}/${GUILD_CHANNEL_LIMIT})`)) > 0)
        parent = await pickParent();
      if (Date.now() < this.createPausedUntil) return fallback(`Discord blocks channel creates until ${new Date(this.createPausedUntil).toISOString()}`);
      if (parent === undefined) {
        if (split) this.#categoryFull(`stackwait:${parentId}`, `${machine} pane categories are full and the stack category cannot be made yet (one category create per minute, one try per hour after a failure); new panes use a 🧵 thread meanwhile`);
        else this.#categoryFull(parentId ?? "", `${machine} pane category is full (${count(parentId ?? "")}/${CATEGORY_LIMIT}); new panes get no channel`);
        return fallback(`pane categories full (${cats.length} × ${CATEGORY_LIMIT})`);
      }
      log(`create channel ${p.name} for ${machine}:${p.paneId}`);
      attempted = true;
      const create = () => guild.channels.create({ name: channelTitle(p.name, machine, p.short), type: ChannelType.GuildText, parent: parent || undefined, topic: this.#topic(p) });
      try {
        const ch = await create().catch(async (err: Error) => {
          // Discord 30013 (server at 500): sweep, then the create again right away.
          if (!SERVER_FULL_RE.test(err.message) || !(await this.sweepServer(guild, `Discord refused the channel for ${p.name}: ${err.message}`))) throw err;
          log(`create channel ${p.name} again after the server sweep`);
          return create();
        });
        this.#skipLogged.delete(p.paneId);
        this.#paneCreateFailedAt.delete(failKey);
        return ch;
      } catch (err) {
        const wait = rateLimitWait(err);
        if (wait !== null) {
          this.createPausedUntil = now + wait;
          const until = new Date(this.createPausedUntil);
          log(`channel creates rate-limited by Discord for ${Math.round(wait / 60_000)} min (until ${until.toISOString()})`);
          this.#categoryFull(`ratelimit:${Math.floor(this.createPausedUntil / 3_600_000)}`, `Discord blocks new channels until ${until.toTimeString().slice(0, 5)} (rate limit); new panes get their channel after that`);
          return fallback(`Discord blocks channel creates until ${until.toISOString()}`);
        }
        const n = count(parent);
        const msg = (err as Error).message;
        log(`create channel ${p.name} failed (${n} channels in category): ${msg}`);
        if (SERVER_FULL_RE.test(msg)) {
          // The sweep freed nothing (or is waiting for its window): the next create tries a sweep first, no hour wait.
          this.#serverFullUntil = Date.now() + SERVER_SWEEP_GAP_MS;
          fullFail = true;
          return fallback(`the server is full (${msg}); no channel could be dropped yet`);
        }
        // Category vanished between cache and create: forget it so the next pass picks or makes another one.
        if (/CHANNEL_PARENT_INVALID|Category does not exist/i.test(msg)) {
          if (ovf.includes(parent)) {
            ovf.splice(ovf.indexOf(parent), 1);
            try { saveOverflowIds(ovf, this.configFile, overflowKey(machine)); } catch { /* logged on next prune */ }
          }
          for (const [s, ids] of Object.entries(stackCats)) {
            if (!ids.includes(parent)) continue;
            if (ids.length > 1) stackCats[s] = ids.filter((id) => id !== parent);
            else delete stackCats[s];
            try { saveMirrorValue("stackCategories", stackCats, this.configFile); } catch { /* logged on next prune */ }
          }
        }
        if (/maximum number of channels in category/i.test(msg)) this.#fullUntil.set(parent, Date.now() + OVERFLOW_RETRY_MS);
        if (n >= CATEGORY_LIMIT || /maximum number of channels/i.test(msg)) this.#categoryFull(parent, `${machine} pane category is full (${n}/${CATEGORY_LIMIT}); no channel for ${p.name}`);
        else {
          // Not a full category (that one has its own gate): this pane waits an hour; FIRSTMATE hears once per error.
          this.#paneCreateFailedAt.set(failKey, Date.now());
          this.#alertOnce(`createfail:${msg.slice(0, 80)}`, `⚠️ Channel create for ${p.name} failed: ${msg}. Each pane tries again at most once per hour; it uses a 🧵 thread meanwhile.`);
        }
        return fallback(`channel create failed: ${msg}`);
      }
    };
    for (const p of create) {
      const ch = await make(p);
      if (ch) this.entries.push({ ...p, channelId: ch.id, archived: false, offset: undefined, ...(ch.threadOnly ? { threadOnly: true } : {}) });
    }
    for (const { e, p } of update) {
      if (e.threadOnly) {
        // Creates allowed again: make the real channel, link it in the thread, remap, archive the thread.
        // At most one try per OVERFLOW_RETRY_MS: a refused create must not repeat every 15 s.
        if (Date.now() >= this.createPausedUntil && Date.now() - this.#promoteFailedAt >= OVERFLOW_RETRY_MS) {
          attempted = false;
          fullFail = false;
          const fresh = await make(p, false);
          if (fresh) {
            this.#promoteFailedAt = 0;
            await this.#promote(guild, e, fresh.id);
          } else if (attempted && !fullFail) this.#promoteFailedAt = Date.now();
        } else if (!guild.channels.cache.has(e.channelId) && this.client) {
          // Only Discord's "Unknown Channel" (10003) means the thread was deleted; other fetch errors keep it.
          const gone = await this.client.channels.fetch(e.channelId).then(
            () => false,
            (err: unknown) => err !== null && typeof err === "object" && "code" in err && err.code === 10003,
          );
          const again = gone ? await this.#thread(guild, p, "the pane thread was deleted") : null;
          if (again) e.channelId = again.id;
        }
      } else if (!guild.channels.cache.get(e.channelId)) {
        // make() logs the create (or the skip reason once); no line every 15 s while creates are blocked.
        const fresh = await make(p);
        if (!fresh) continue;
        e.channelId = fresh.id;
        if (fresh.threadOnly) e.threadOnly = true;
      } else {
        const ch = guild.channels.cache.get(e.channelId) as TextChannel;
        // A rename blocked by Discord's limit (2 per 10 min) must not stall every later sync.
        const title = channelTitle(p.name, machine, p.short);
        if (ch.name.replace(/\uFE0F/g, "") !== title.replace(/\uFE0F/g, "")) {
          log(`rename ${ch.name} -> ${title}`);
          void ch.setName(title).catch((err: Error) => log(`rename failed: ${err.message}`));
        }
        // Owner 2026-10-18: channels the owner put in the 📌 Pinned category stay there.
        const pinned = /pinned/i.test(ch.parent?.name ?? "");
        // Owner 2026-10-30: a pane channel moves to its stack category (made here when missing, one at a time).
        let moved = false;
        if (split && !pinned && moves < MOVES_PER_PASS) {
          const s = stackOf(p);
          if (!(stackCats[s] ?? []).includes(ch.parentId ?? "")) {
            const target = await stackParent(s, true);
            if (target !== undefined && target !== ch.parentId) moved = await move(ch, target, s);
          }
        }
        // Owner 2026-10-24: a channel in an overflow or stack category stays there (moving it back fails while 🖥️ Main is full).
        const paneCats = new Set([...cats, ...Object.values(stackCats).flat()]);
        // A full 🖥️ Main would refuse the move: no PATCH every pass.
        if (!moved && !pinned && !baseGone && !paneCats.has(ch.parentId ?? "") && count(parentId ?? "") < CATEGORY_LIMIT) await ch.setParent(parentId, { lockPermissions: false }).catch(() => {});
        if (ch.topic !== this.#topic(p)) await ch.setTopic(this.#topic(p)).catch(() => {});
      }
      if (e.sessionFile !== p.sessionFile) {
        e.offset = undefined; // new session: mirror from now on
        this.#halt(e, "new session");
      }
      Object.assign(e, { paneId: p.paneId, tabId: p.tabId, workspace: p.workspace, tab: p.tab, name: p.name, cwd: p.cwd, sessionFile: p.sessionFile, archived: false });
    }
    for (const e of archive) {
      const ch = guild.channels.cache.get(e.channelId) as TextChannel | undefined;
      log(`archive ${e.name}`);
      if (e.threadOnly) {
        const t = guild.channels.cache.get(e.channelId);
        if (t?.isThread()) void t.setArchived(true).catch(() => {});
      }
      // Owner 2026-10-23: "archive" = delete. The channel stays where it is; scripts/purge-archive.py deletes it
      // after the learners (daily-skill-bot) processed its OMP logs. No archive category, no move, no categoryFull.
      void ch;
      e.archived = true;
      this.#halt(e, "pane closed");
    }
    // Owner 2026-10-30: channels of closed panes (not purged yet) leave 🖥️ Main and overflow too, when their stack
    // category exists and has room (no category is made for them).
    if (split) {
      for (const e of this.entries) {
        if (moves >= MOVES_PER_PASS) break;
        if (e.machine !== machine || !e.archived || e.threadOnly || this.detached.has(e.channelId)) continue;
        const ch = guild.channels.cache.get(e.channelId) as TextChannel | undefined;
        if (!ch || ch.type !== ChannelType.GuildText || !cats.includes(ch.parentId ?? "")) continue;
        const s = stackOf(e);
        const target = await stackParent(s, false);
        if (target !== undefined) await move(ch, target, s);
      }
    }
    for (const id of new Set([...cats, ...(split ? Object.values(stackCats).flat() : [])])) await this.#sort(guild, id);
  }

  /** Keep the category's text channels sorted by emoji group; one bulk PATCH only when the order is off. */
  async #sort(guild: Guild, parentId: string | undefined): Promise<void> {
    if (!parentId) return;
    const chans = [...guild.channels.cache.values()].filter((c) => c.parentId === parentId && c.type === ChannelType.GuildText) as TextChannel[];
    const now = [...chans].sort((a, b) => a.rawPosition - b.rawPosition).map((c) => c.id);
    const want = [...chans].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name))).map((c) => c.id);
    if (now.join() === want.join()) return;
    const base = Math.min(...chans.map((c) => c.rawPosition));
    log(`sort ${chans.length} channels in ${parentId}`);
    await guild.channels.setPositions(want.map((id, i) => ({ channel: id, position: base + i }))).catch((err: Error) => log(`sort failed: ${err.message}`));
  }

  /** Read [offset, offset+MAX) of a session file on its host; size is the current file size. */
  async #read(e: MirrorEntry, offset: number): Promise<{ size: number; chunk: Buffer } | null> {
    if (!e.sessionFile) return null;
    if (e.machine === "main") {
      // OMP creates the file lazily: a missing file reads as empty, so mirroring starts at byte 0.
      if (!existsSync(e.sessionFile)) return { size: 0, chunk: Buffer.alloc(0) };
      try {
        const size = statSync(e.sessionFile).size;
        if (size <= offset) return { size, chunk: Buffer.alloc(0) };
        const len = Math.min(size - offset, MAX_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        const fd = openSync(e.sessionFile, "r");
        try {
          readSync(fd, buf, 0, len, offset);
        } finally {
          closeSync(fd);
        }
        return { size, chunk: buf };
      } catch {
        return null;
      }
    }
    const q = `'${e.sessionFile.replace(/'/g, "'\\''")}'`;
    const r = await sh(
      HOSTS.find((h) => h.machine === e.machine)!.ssh,
      `if [ -e ${q} ]; then stat -c %s ${q} && tail -c +${offset + 1} ${q} | head -c ${MAX_TAIL_BYTES}; else echo 0; fi`,
    );
    if (r.code !== 0) return null;
    const nl = r.out.indexOf(0x0a);
    if (nl === -1) return null;
    return { size: Number(r.out.subarray(0, nl).toString()), chunk: r.out.subarray(nl + 1) };
  }

  /** A working status whose session ended without a final entry: mark it stopped. */
  #halt(e: MirrorEntry, reason: string): void {
    if (e.wait) {
      this.#staleWaits.push({ e, w: e.wait, why: reason });
      e.wait = undefined;
    }
    if (e.progress?.state !== "working") return;
    if (!e.progress.msgId) {
      e.progress = undefined; // nothing was posted yet: nothing to mark
      return;
    }
    e.progress = { ...e.progress, state: "stopped", reason, lastTs: Date.now() };
    this.#pending.add(e.channelId);
  }

  /** Card job-status-last: the channel's status card id (undefined = none). */
  statusMsg(channelId: string): string | undefined {
    return this.entries.find((x) => x.channelId === channelId)?.progress?.msgId;
  }
  /** The status card was moved (reposted) as `msgId`. */
  setStatusMsg(channelId: string, msgId: string): void {
    const e = this.entries.find((x) => x.channelId === channelId);
    if (!e?.progress) return;
    e.progress.msgId = msgId;
    this.#pending.add(channelId); // redraw from progress: an edit may have raced the copy
    this.save();
  }

  /** Threads that are a live pane's own channel (thread fallback): the idle alert-thread sweep must not archive them. */
  paneThreadIds(): Set<string> {
    return new Set(this.entries.filter((x) => x.threadOnly && !x.archived).map((x) => x.channelId));
  }

  /** Pane threads whose 1-week auto-archive change Discord refused (not retried in this bot run). */
  #autoArchiveFailed = new Set<string>();
  /**
   * Owner 2026-11-07 (card server-full-auto-drop): a pane thread in use never stays archived. Unarchive it (and keep
   * the 1-week auto-archive) before a post. `force`: Discord said "Thread is archived" while the cache did not know.
   * Returns true when the thread is open (or the channel is no thread). Public for tests.
   */
  async openThread(id: string, force = false): Promise<boolean> {
    const cached = this.client?.channels.cache.get(id);
    const t = (force || !cached ? await this.client?.channels.fetch(id, { force: true }).catch(() => null) : cached) as ThreadChannel | null | undefined;
    if (!t?.isThread?.()) return true;
    if (t.archived || force) {
      try {
        await t.setArchived(false, "pane thread in use");
        log(`unarchived pane thread ${id}`);
      } catch (err) {
        log(`unarchive pane thread ${id} failed: ${(err as Error).message}`);
        return false;
      }
    }
    // A refused change is not retried on every post (one try per thread per bot run).
    if (t.autoArchiveDuration !== ThreadAutoArchiveDuration.OneWeek && !this.#autoArchiveFailed.has(id))
      await t.setAutoArchiveDuration(ThreadAutoArchiveDuration.OneWeek).catch((err: Error) => {
        this.#autoArchiveFailed.add(id);
        log(`set 1-week auto-archive on pane thread ${id} failed: ${err.message}`);
      });
    return true;
  }

  /** One post into the pane's channel; a pane thread is unarchived first, and once more if Discord still says archived. */
  async #toPane<T>(e: MirrorEntry, send: () => Promise<T>): Promise<T> {
    if (e.threadOnly) await this.openThread(e.channelId);
    return send().catch(async (err: Error) => {
      // The cache missed the archive: unarchive for real, then post once more.
      if (!/thread is archived/i.test(err.message) || !(await this.openThread(e.channelId, true))) throw err;
      return send();
    });
  }

  /** Create or edit the channel's status message (throttled unless urgent). */
  async #flush(e: MirrorEntry, status: StatusPoster, urgent: boolean): Promise<boolean> {
    const p = e.progress;
    if (!p || !this.#pending.has(e.channelId)) return false;
    const now = Date.now();
    if (!urgent && p.msgId && now - (this.#lastEdit.get(e.channelId) ?? 0) < PROGRESS_EDIT_MS) return false;
    this.#pending.delete(e.channelId);
    this.#lastEdit.set(e.channelId, now);
    const sent = p.msgId;
    const id = await this.#toPane(e, () => status(e.channelId, renderProgress(e.tab, p), sent)).catch((err: Error) => {
      log(`status failed: ${err.message}`);
      return sent;
    });
    if (id === sent || p.msgId !== sent) return false; // a move (job-status-last) replaced the card meanwhile
    p.msgId = id;
    return true;
  }

  /**
   * Post new final replies (and keep the live status message current) for every mirrored pane session.
   * `onWatch` (plan P5): stall detector and automatic-continue decisions; `now` is the clock.
   */
  async tail(post: (channelId: string, text: string) => Promise<void>, status?: StatusPoster, onWatch?: WatchHandler, now = Date.now, onWait?: WaitHandler): Promise<void> {
    if (this.#tailing) return;
    this.#tailing = true;
    let dirty = false;
    try {
      // Cards of panes that closed or switched session (see #halt).
      for (const s of this.#staleWaits.splice(0)) if (onWait && s.w.msgId && !s.w.sending) await onWait(s.e, s.w, { close: `-# ⏹️ Closed: ${s.why}.` }).catch(() => undefined);
      for (const e of this.entries) {
        // Throttled edits still go out when nothing new was read (also for a just-archived pane).
        if (status && (await this.#flush(e, status, false))) dirty = true;
        if (e.archived || !e.sessionFile || this.busy.has(e.channelId) || this.detached.has(e.channelId)) continue;
        if (e.machine !== "main" && this.hostOk.get(e.machine) === false) continue;
        // A wait card that moved with its pane (thread -> channel, see #promote) opens again in the new channel.
        if (onWait && e.wait && !e.wait.msgId && !e.wait.sending) {
          e.wait.msgId = await onWait(e, e.wait, { open: true }).catch((err: Error) => (log(`wait card failed: ${err.message}`), undefined));
          dirty = true;
        }
        const start = e.offset;
        const r = await this.#read(e, start ?? 0);
        if (!r) continue;
        if (start === undefined || r.size < start) {
          e.offset = r.size; // first sight or truncated: start mirroring from here
          if (onWatch) e.watch = { ...freshWatch(now()), size: r.size };
          dirty = true;
          continue;
        }
        const { events, consumed } = r.chunk.length ? sessionEvents(r.chunk) : { events: [], consumed: 0 };
        if (onWatch && (await this.#watch(e, events, r.size, onWatch, now()))) dirty = true;
        // Card job-subagents-line: list the turn's subagents (main-host session files only; remote hosts are skipped).
        if (status && e.machine === "main" && e.progress?.state === "working" && e.progress.count > 0) {
          const subs = scanSubagents(e.sessionFile, e.progress.startTs - 5_000, this.#subTails);
          const key = (x?: ProgressSub[]) => JSON.stringify((x ?? []).map((y) => [y.name, y.model, y.done, y.lastTool, y.running, y.calls]));
          if (key(subs) !== key(e.progress.subagents)) {
            e.progress = { ...e.progress, subagents: subs.length ? subs : undefined };
            this.#pending.add(e.channelId);
          }
        }
        const next = tailOffset(start, r.chunk.length, consumed);
        if (next === null) continue;
        e.offset = next;
        dirty = true;
        // A wait answered in the same chunk needs no card (for example after a bot restart).
        const answered = new Set(events.flatMap((ev) => (ev.kind === "result" ? [ev.callId] : [])));
        for (const [n, ev] of events.entries()) {
          if (status) {
            if (ev.kind === "thinking") e.thinking = ev.level;
            const r0 = applyEvent(e.progress, ev);
            const p = r0.p && e.thinking && !r0.p.thinking ? { ...r0.p, thinking: e.thinking } : r0.p;
            // The first tool step of a new turn shows at once on a reused card (job-status-last), as a new card did.
            const urgent = r0.urgent || (!!p?.msgId && p.state === "working" && p.count > 0 && (e.progress?.state !== "working" || e.progress.count === 0));
            // A turn start alone posts nothing; the status message appears with the first tool step.
            if (p && p !== e.progress && ((p.state === "working" && p.count > 0) || urgent)) this.#pending.add(e.channelId);
            e.progress = p;
            if (urgent) await this.#flush(e, status, true); // finish the status before the reply posts below it
          }
          if (ev.kind === "reply" && ev.text) {
            await this.#toPane(e, () => post(e.channelId, `🖥️ **${e.tab}** · terminal reply\n${ev.text}`)).catch((err: Error) => log(`post failed: ${err.message}`));
          }
          if (onWait) await this.#waitEvent(e, ev, events.slice(n + 1), answered, onWait, now());
        }
        if (status) await this.#flush(e, status, false);
      }
    } finally {
      if (dirty) this.save();
      this.#tailing = false;
    }
  }

  /** Orca #2: open or close the pane's wait card for one session event. */
  async #waitEvent(e: MirrorEntry, ev: SessionEvent, later: SessionEvent[], answered: Set<string>, onWait: WaitHandler, now: number): Promise<void> {
    const nonce = () => `${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    if (ev.kind === "step" && ev.ask && ev.callId) {
      if (answered.has(ev.callId)) return;
      return this.#setWait(e, { nonce: nonce(), kind: "ask", ts: ev.ts, callId: ev.callId, rec: ev.entryId, ask: ev.ask }, "a new question", onWait);
    }
    if (ev.kind === "result" && e.wait?.kind === "ask" && e.wait.callId === ev.callId) return this.#setWait(e, undefined, "answered at the terminal", onWait);
    if (ev.kind === "stopped" && e.wait?.kind === "ask") return this.#setWait(e, undefined, `the turn stopped (${ev.reason})`, onWait);
    if (ev.kind === "turn" && e.wait) return this.#setWait(e, undefined, "answered at the terminal", onWait);
    if (ev.kind === "reply" && ev.text && isQuestionReply(ev.text)) {
      if (later.some((x) => x.kind === "turn")) return;
      return this.#setWait(e, { nonce: nonce(), kind: "question", ts: ev.ts, rec: ev.entryId, question: questionLine(ev.text) }, "a new question", onWait);
    }
  }

  /** Replace the pane's wait: close the old card (unless an inject owns it), then post the new card. */
  async #setWait(e: MirrorEntry, next: PaneWait | undefined, why: string, onWait: WaitHandler): Promise<void> {
    const old = e.wait;
    e.wait = next;
    if (old?.msgId && !old.sending) await onWait(e, old, { close: `-# ⏹️ Closed: ${why}.` }).catch((err: Error) => log(`wait close failed: ${err.message}`));
    if (next) next.msgId = await onWait(e, next, { open: true }).catch((err: Error) => (log(`wait card failed: ${err.message}`), undefined));
  }

  /** Last `bytes` of an entry's session file (main: local read; second machine: over SSH). */
  async readTail(e: { machine: string; sessionFile?: string | null }, bytes = 256 * 1024): Promise<string | null> {
    const entry = this.entries.find((x) => x.machine === e.machine && x.sessionFile === e.sessionFile);
    if (!entry) return null;
    const probe = await this.#read(entry, Number.MAX_SAFE_INTEGER);
    if (!probe) return null;
    const r = await this.#read(entry, Math.max(0, probe.size - bytes));
    return r ? r.chunk.toString("utf8") : null;
  }

  /** Feed the stall/continue watch; run its actions. True when the saved state changed. */
  async #watch(e: MirrorEntry, events: SessionEvent[], size: number, onWatch: WatchHandler, now: number): Promise<boolean> {
    const w = (e.watch ??= freshWatch(now));
    const before = JSON.stringify(w);
    watchEvents(w, events, size, now);
    for (const a of watchCheck(w, now)) await onWatch(e, a).catch((err: Error) => log(`watch ${a.kind} failed: ${err.message}`));
    return JSON.stringify(w) !== before;
  }

  /**
   * After a pane-mode run: skip what the run itself appended (it was posted from stdout). The watch still
   * reads it (plan P5), so a continue run that stops on a new transient error is seen.
   */
  async markConsumed(e: MirrorEntry, now = Date.now()): Promise<void> {
    const probe = await this.#read(e, Number.MAX_SAFE_INTEGER);
    if (!probe) return;
    if (e.watch && e.offset !== undefined && probe.size > e.offset) {
      const r = await this.#read(e, Math.max(e.offset, probe.size - MAX_TAIL_BYTES));
      if (r) watchEvents(e.watch, sessionEvents(r.chunk).events, r.size, now);
    }
    e.offset = probe.size;
    this.save();
  }

  /** True only when the probe ran and found a live omp (a failed probe is "unknown", not live). */
  async #confirmedLiveOmp(e: MirrorEntry): Promise<boolean> {
    const host = HOSTS.find((h) => h.machine === e.machine)!;
    const pane = e.paneId.replace(/[^A-Za-z0-9:_-]/g, "");
    const r = await sh(host.ssh, `${host.herdr} pane process-info --pane '${pane}'; printf '\\n@@\\n'; ps -eo pid=,ppid=,comm=,args=`);
    if (r.code !== 0) return false;
    const [info = "", ps = ""] = r.out.toString("utf8").split("\n@@\n");
    return paneHasLiveOmp(info, ps);
  }

  async #liveOmp(e: MirrorEntry): Promise<boolean> {
    const host = HOSTS.find((h) => h.machine === e.machine)!;
    const pane = e.paneId.replace(/[^A-Za-z0-9:_-]/g, "");
    const r = await sh(host.ssh, `${host.herdr} pane process-info --pane '${pane}'; printf '\\n@@\\n'; ps -eo pid=,ppid=,comm=,args=`);
    if (r.code !== 0) return true;
    const [info = "", ps = ""] = r.out.toString("utf8").split("\n@@\n");
    return paneHasLiveOmp(info, ps);
  }

  async #excerpt(e: MirrorEntry): Promise<string> {
    if (!e.sessionFile) return "";
    const probe = await this.#read(e, Number.MAX_SAFE_INTEGER);
    if (!probe) return "";
    const from = Math.max(0, probe.size - 256 * 1024);
    const r = await this.#read(e, from);
    return r ? transcriptExcerpt(r.chunk) : "";
  }

  /**
   * Decide where a Discord message in a mirrored channel runs. threadId: messages in a thread
   * under the channel always get their own side session.
   */
  async decide(channelId: string, threadId: string | null, firstmateId = ""): Promise<Decision | null> {
    const e = this.byChannel(channelId);
    if (!e) return null;
    const sideKey = sideSessionKey(e, threadId);
    const cwdOk = e.machine === "main" && e.cwd && (e.cwd === GITHUB || e.cwd.startsWith(`${GITHUB}/`)) && existsSync(e.cwd);
    const cwd = cwdOk ? e.cwd! : GITHUB;
    const side = async (reason: string): Promise<Decision> => ({ mode: "side", entry: e, key: sideKey, cwd, reason, context: await this.#excerpt(e) });
    if (cwdOk && !e.archived && liveJobBusy({ machine: e.machine, cwd, github: GITHUB, firstmate: e.channelId === firstmateId || e.tab === "FIRSTMATE", live: await this.#confirmedLiveOmp(e) }))
      return { mode: "busy", entry: e, cwd, reason: "a live omp in the job pane works in this folder" };
    if (threadId) return side("thread under the channel");
    if (e.archived) return side("the pane is closed");
    if (e.machine !== "main") return side("second machine panes are continued in a main side session");
    if (!e.sessionFile || !existsSync(e.sessionFile)) return side("the pane has no session file");
    if (await this.#liveOmp(e)) return side("an omp process holds the pane's session");
    return { mode: "pane", entry: e, sessionFile: e.sessionFile, cwd, key: `pane-${e.channelId}` };
  }

  /** Post target lookup for tail(). */
  async channel(channelId: string): Promise<SendableChannels | null> {
    const ch = await this.client?.channels.fetch(channelId).catch(() => null);
    return ch?.isSendable() ? ch : null;
  }
}
