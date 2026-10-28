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
import { join } from "node:path";
import { ChannelType, type Client, type Guild, type SendableChannels, type TextChannel } from "discord.js";
import { CONFIG, FIRSTMATE_SESSION, GUILD_ID, STATE_DIR } from "./config.ts";
import { askInfo, isQuestionReply, questionLine, type AskInfo, type PaneWait } from "./quickreply.ts";
import { freshWatch, watchCheck, watchEvents, type WatchAction, type WatchState } from "./stall.ts";

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
export const CATEGORY_LIMIT = 50;
/** First archive category with room (fewer than 50 channels); undefined when all are full. */
export function pickArchive(ids: string[], count: (id: string) => number): string | undefined {
  return ids.find((id) => count(id) < CATEGORY_LIMIT);
}
/** Overflow categories for this machine's live pane channels (config.mirror.overflow), used in order. */
export const OVERFLOW_IDS: string[] = CONFIG.mirror.overflow.filter(Boolean);
/** First pane category with room: the machine's own category, then its overflow categories. */
export function pickPaneCategory(ids: string[], count: (id: string) => number): string | undefined {
  return ids.find((id) => count(id) < CATEGORY_LIMIT);
}
/**
 * Owner 2026-10-24: a channel create that Discord rate-limits for longer than this fails at once (discord.js
 * `rejectOnRateLimit`, set in main.ts). Before, the sync awaited an 11-17 h wait and stopped mirroring.
 */
export const CREATE_WAIT_MAX_MS = 60_000;
export function rejectLongChannelCreate(d: { method: string; route: string; timeToReset: number }): boolean {
  return d.method.toUpperCase() === "POST" && d.route === "/guilds/:id/channels" && d.timeToReset > CREATE_WAIT_MAX_MS;
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
  /** Plan P5: open tool calls, stall line and automatic-continue state (src/stall.ts). */
  watch?: WatchState;
  /** Orca #2 (owner 2026-10-19): the pane waits for the owner; its card has quick-reply buttons. */
  wait?: PaneWait;
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
  /** Owner 2026-10-19: latest tool call, shown as the last line; `done` once its result arrived. */
  lastTool?: { ts: number; tool: string; intent: string; callId?: string; done: boolean };
};
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
  | { kind: "model"; ts: number; model: string };

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
        message?: { role?: string; stopReason?: string; content?: unknown; toolCallId?: string; isError?: boolean; errorMessage?: unknown; provider?: unknown; model?: unknown };
      };
      if (e.type === "model_change" && typeof e.model === "string") {
        events.push({ kind: "model", ts: e.timestamp ? Date.parse(e.timestamp) || now : now, model: e.model });
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
  const model = p.model ? [`🤖 Model: \`${p.model.replace(/[`*_~|<>@]/g, "").slice(0, 80)}\``] : [];
  const lt = p.lastTool;
  const last = lt
    ? `🛠️ **Last tool:** \`${lt.tool.replace(/[`*_~|<>@]/g, "").slice(0, 30)}\`${lt.intent ? `: ${lt.intent}` : ""} · ${lt.done ? "done" : "running"} · called <t:${Math.floor(lt.ts / 1000)}:R>`
    : "🛠️ **Last tool:** none yet";
  return [`⚙️ **${tab}** · working · started <t:${s}:R> · ${steps} · last step <t:${l}:R>`, ...model, ...task, ...git, ...lines, last].join("\n");
}

/** Apply one event to a channel's progress (pure). Returns the new progress and whether to edit now. */
export function applyEvent(p: Progress | undefined, ev: SessionEvent): { p: Progress | undefined; urgent: boolean } {
  const fresh = (ts: number): Progress => ({ startTs: ts, lastTs: ts, count: 0, steps: [], state: "working" });
  switch (ev.kind) {
    case "turn": {
      // A steering message during a running turn keeps the same status message.
      if (p?.state === "working") return { p, urgent: false };
      return { p: { ...fresh(ev.ts), task: ev.text || undefined, model: p?.model }, urgent: false };
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
    case "reply":
    case "stopped":
      // No tool steps in this turn: no status message is needed, the reply says it all.
      if (!p || p.state !== "working") return { p, urgent: false };
      if (!p.msgId && p.count === 0) return { p: undefined, urgent: false };
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
  | { mode: "side"; entry: MirrorEntry; key: string; cwd: string; reason: string; context: string };

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
  /** Wait cards of panes that closed or switched session; closed on the next tail. */
  #staleWaits: { e: MirrorEntry; w: PaneWait; why: string }[] = [];
  /** Posts one line to #omp-alerts (set by main). */
  alert: ((text: string) => void) | null = null;
  /** Categories already reported full in this bot run. */
  #fullAlerted = new Set<string>();
  #categoryFull(key: string, text: string): void {
    if (this.#fullAlerted.has(key)) return;
    this.#fullAlerted.add(key);
    this.alert?.(`⚠️ Discord category limit: ${text}.`);
  }
  /** Owner 2026-10-24: Discord blocked channel creates until this time (ms); the sync skips creates until then. */
  createPausedUntil = 0;
  /** Pane id -> last "no channel" reason logged, so a skipped create logs once, not every 15 s (4,062 lines in 36 h). */
  #skipLogged = new Map<string, string>();
  #skip(p: LivePane, why: string): null {
    if (this.#skipLogged.get(p.paneId) !== why) log(`no channel for ${p.name} (${p.machine}:${p.paneId}): ${why}`);
    this.#skipLogged.set(p.paneId, why);
    return null;
  }

  constructor(
    private client: Client | null,
    private file = MAP_FILE,
    /** Channel ids detached from their pane: never updated, renamed, archived or tailed. */
    private detached: Set<string> = DETACHED_CHANNEL_IDS,
  ) {
    if (!existsSync(file)) return;
    try {
      this.entries = (JSON.parse(readFileSync(file, "utf8")) as MirrorEntry[]).map(
        ({ machine, paneId, tabId, workspace, tab, name, channelId, archived, cwd, sessionFile, offset, progress, watch, wait }) =>
          ({ machine, paneId, tabId, workspace, tab, name, channelId, archived, cwd, sessionFile, offset, progress, watch, wait }),
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

  byChannel(channelId: string): MirrorEntry | undefined {
    if (this.detached.has(channelId)) return undefined; // local-omp channels: never a pane route
    return this.entries.find((e) => e.channelId === channelId);
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
    const parentId = CATEGORY_IDS[machine];
    // A full category (50 channels) must not stop the whole sync pass: catch per pane, alert once.
    // Owner 2026-10-24: never call Discord when every pane category is full or Discord paused channel creates.
    // Retrying every 15 s (4,062 creates in 36 h) made Discord block all channel creates for about 17 h.
    const cats = [parentId ?? "", ...(machine === "main" ? OVERFLOW_IDS : [])];
    const count = (id: string) => [...guild.channels.cache.values()].filter((c) => c.parentId === id).length;
    const make = async (p: LivePane) => {
      const now = Date.now();
      if (now < this.createPausedUntil) return this.#skip(p, `Discord blocks channel creates until ${new Date(this.createPausedUntil).toISOString()}`);
      const parent = pickPaneCategory(cats, count);
      if (parent === undefined) {
        this.#categoryFull(parentId ?? "", `${machine} pane category is full (${count(parentId ?? "")}/${CATEGORY_LIMIT}); new panes get no channel`);
        return this.#skip(p, `pane categories full (${cats.length} × ${CATEGORY_LIMIT})`);
      }
      log(`create channel ${p.name} for ${machine}:${p.paneId}`);
      try {
        const ch = await guild.channels.create({ name: channelTitle(p.name, machine, p.short), type: ChannelType.GuildText, parent: parent || undefined, topic: this.#topic(p) });
        this.#skipLogged.delete(p.paneId);
        return ch;
      } catch (err) {
        const wait = rateLimitWait(err);
        if (wait !== null) {
          this.createPausedUntil = now + wait;
          const until = new Date(this.createPausedUntil);
          log(`channel creates rate-limited by Discord for ${Math.round(wait / 60_000)} min (until ${until.toISOString()})`);
          this.#categoryFull(`ratelimit:${Math.floor(this.createPausedUntil / 3_600_000)}`, `Discord blocks new channels until ${until.toTimeString().slice(0, 5)} (rate limit); new panes get their channel after that`);
          return this.#skip(p, `Discord blocks channel creates until ${until.toISOString()}`);
        }
        const n = count(parent);
        log(`create channel ${p.name} failed (${n} channels in category): ${(err as Error).message}`);
        if (n >= CATEGORY_LIMIT || /maximum number of channels/i.test((err as Error).message)) this.#categoryFull(parent, `${machine} pane category is full (${n}/${CATEGORY_LIMIT}); no channel for ${p.name}`);
        return null;
      }
    };
    for (const p of create) {
      const ch = await make(p);
      if (ch) this.entries.push({ ...p, channelId: ch.id, archived: false, offset: undefined });
    }
    for (const { e, p } of update) {
      const ch = guild.channels.cache.get(e.channelId) as TextChannel | undefined;
      if (!ch) {
        // make() logs the create (or the skip reason once); no line every 15 s while creates are blocked.
        const fresh = await make(p);
        if (!fresh) continue;
        e.channelId = fresh.id;
      } else {
        // A rename blocked by Discord's limit (2 per 10 min) must not stall every later sync.
        const title = channelTitle(p.name, machine, p.short);
        if (ch.name.replace(/\uFE0F/g, "") !== title.replace(/\uFE0F/g, "")) {
          log(`rename ${ch.name} -> ${title}`);
          void ch.setName(title).catch((err: Error) => log(`rename failed: ${err.message}`));
        }
        // Owner 2026-10-18: channels the owner put in the 📌 Pinned category stay there.
        const pinned = /pinned/i.test(ch.parent?.name ?? "");
        // Owner 2026-10-24: a channel in an overflow category stays there (moving it back fails while 🖥️ Main is full).
        if (!pinned && !cats.includes(ch.parentId ?? "")) await ch.setParent(parentId, { lockPermissions: false }).catch(() => {});
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
      // Owner 2026-10-23: "archive" = delete. The channel stays where it is; scripts/purge-archive.py deletes it
      // after the learners (daily-skill-bot) processed its OMP logs. No archive category, no move, no categoryFull.
      void ch;
      e.archived = true;
      this.#halt(e, "pane closed");
    }
    for (const id of cats) await this.#sort(guild, id);
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

  /** Create or edit the channel's status message (throttled unless urgent). */
  async #flush(e: MirrorEntry, status: StatusPoster, urgent: boolean): Promise<boolean> {
    const p = e.progress;
    if (!p || !this.#pending.has(e.channelId)) return false;
    const now = Date.now();
    if (!urgent && p.msgId && now - (this.#lastEdit.get(e.channelId) ?? 0) < PROGRESS_EDIT_MS) return false;
    this.#pending.delete(e.channelId);
    this.#lastEdit.set(e.channelId, now);
    const id = await status(e.channelId, renderProgress(e.tab, p), p.msgId).catch((err: Error) => {
      log(`status failed: ${err.message}`);
      return p.msgId;
    });
    if (id === p.msgId) return false;
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
        const next = tailOffset(start, r.chunk.length, consumed);
        if (next === null) continue;
        e.offset = next;
        dirty = true;
        // A wait answered in the same chunk needs no card (for example after a bot restart).
        const answered = new Set(events.flatMap((ev) => (ev.kind === "result" ? [ev.callId] : [])));
        for (const [n, ev] of events.entries()) {
          if (status) {
            const { p, urgent } = applyEvent(e.progress, ev);
            // A turn start alone posts nothing; the status message appears with the first tool step.
            if (p && p !== e.progress && ((p.state === "working" && p.count > 0) || urgent)) this.#pending.add(e.channelId);
            e.progress = p;
            if (urgent) await this.#flush(e, status, true); // finish the status before the reply posts below it
          }
          if (ev.kind === "reply" && ev.text)
            await post(e.channelId, `🖥️ **${e.tab}** · terminal reply\n${ev.text}`).catch((err: Error) => log(`post failed: ${err.message}`));
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
  async decide(channelId: string, threadId: string | null): Promise<Decision | null> {
    const e = this.byChannel(channelId);
    if (!e) return null;
    const sideKey = sideSessionKey(e, threadId);
    const cwdOk = e.machine === "main" && e.cwd && (e.cwd === GITHUB || e.cwd.startsWith(`${GITHUB}/`)) && existsSync(e.cwd);
    const cwd = cwdOk ? e.cwd! : GITHUB;
    const side = async (reason: string): Promise<Decision> => ({ mode: "side", entry: e, key: sideKey, cwd, reason, context: await this.#excerpt(e) });
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
