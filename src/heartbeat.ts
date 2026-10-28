// Heartbeat for the ⚙️ Working… message (owner 2026-10-15): every 10 s the bridge checks the run itself
// (is the process tree alive, does it use CPU, does the session log grow, which tool is running) and
// edits the Working message with the result, so the owner can tell a slow run from a stuck one.
// Only tool names and their short intent text are shown (never commands, arguments or output).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { WORKING_EMOJI } from "./config.ts";
import { redact } from "./redact.ts";

export const HEARTBEAT_MS = 10_000;
/** No log write, no pending tool, almost no CPU and no network/disk I/O for this long: report "may be stuck". */
export const STUCK_MS = 5 * 60_000;
/** A tool still running after this long with no CPU, no I/O and no subagent writes: report "tool may be hung". */
export const HUNG_MS = 10 * 60_000;
/**
 * Root-process read+write bytes per second above which the run counts as active. Measured 2026-10-15 on
 * the main host (1 s samples of /proc/<pid>/io): an idle omp at its prompt ~50 B/s; a model streaming a long
 * tool call a steady ~400–900 B/s; pauses between turns 0–200 B/s. So a long model turn with no log
 * write stays 🟢 instead of a false 🔴.
 */
export const IO_ACTIVE_BPS = 300;
const CLK_TCK = 100; // Linux USER_HZ

export interface TreeSample {
  alive: boolean;
  procs: number;
  /** utime+stime per process in the tree, in clock ticks (CPU deltas are summed per pid, so exits don't go negative). */
  ticks: Map<number, number>;
  /** rchar+wchar of the root process (/proc/<pid>/io), bytes; includes socket traffic. */
  ioBytes: number;
}

/** Sum CPU time over the process and all its descendants (walks /proc by parent pid). */
export function sampleTree(rootPid: number, procDir = "/proc"): TreeSample {
  const kids = new Map<number, number[]>();
  const ticks = new Map<number, number>();
  let names: string[] = [];
  try {
    names = readdirSync(procDir);
  } catch {}
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(procDir, n, "stat"), "utf8");
    } catch {
      continue; // exited between readdir and read
    }
    // Fields after "(comm)": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime …
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pid = Number(n);
    const ppid = Number(f[1]);
    ticks.set(pid, Number(f[11]) + Number(f[12]));
    (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
  }
  const perPid = new Map<number, number>();
  if (!ticks.has(rootPid)) return { alive: false, procs: 0, ticks: perPid, ioBytes: 0 };
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    if (perPid.has(p)) continue;
    perPid.set(p, ticks.get(p) ?? 0);
    stack.push(...(kids.get(p) ?? []));
  }
  let ioBytes = 0;
  try {
    for (const m of readFileSync(join(procDir, String(rootPid), "io"), "utf8").matchAll(/^(?:rchar|wchar): (\d+)$/gm)) ioBytes += Number(m[1]);
  } catch {}
  return { alive: true, procs: perPid.size, ticks: perPid, ioBytes };
}

/** CPU % of one core between two samples: per-pid deltas; a new pid counts from 0, an exited pid drops out. */
export function cpuPercent(prev: TreeSample, cur: TreeSample, ms: number, skipPid?: number): number {
  if (ms <= 0) return 0;
  let d = 0;
  for (const [pid, t] of cur.ticks) if (pid !== skipPid) d += Math.max(0, t - (prev.ticks.get(pid) ?? 0));
  return ((d / CLK_TCK) * 1000 * 100) / ms;
}

export interface Pending {
  name: string;
  intent: string;
  since: number;
  id?: string;
}

/** One session entry in short form for the 🩺 Check report (UX item 5). */
export interface RecentEntry {
  at: number;
  kind: "prompt" | "call" | "result" | "error" | "text";
  name: string;
  intent: string;
}
export const RECENT_MAX = 5;

/** Reads only the bytes a session JSONL gained since the last tick. */
export class SessionTail {
  private offset = 0;
  private partial = "";
  toolCalls = 0;
  lastEntryAt = 0;
  /** What the last complete entry was: the model then works ("model") or a tool runs ("tool"). */
  lastKind: "model" | "tool" | "none" = "none";
  readonly pending = new Map<string, Pending>();
  /** Most recent tool call (shown for subagents between tool calls). */
  lastTool: Pending | null = null;
  /** The session wrote its exit record (a finished subagent). */
  done = false;
  /** Owner 2026-10-19: the model the session uses ("provider/model"), from model_change or assistant entries. */
  model = "";
  /** Thinking level from the last thinking_level_change ("low", or "low (auto)" when configured as auto). */
  thinking = "";
  /** UX item 5 (🩺 Check): the last RECENT_MAX entries in short form (tool names and intents only, no content). */
  readonly recent: RecentEntry[] = [];

  constructor(
    readonly file: string,
    startOffset = 0,
  ) {
    this.offset = startOffset;
    if (startOffset > 0) this.#prime(startOffset);
  }

  /** A continued session: read the model and thinking level from the last 512 KB before this run. */
  #prime(end: number): void {
    try {
      const start = Math.max(0, end - 512 * 1024);
      const fd = openSync(this.file, "r");
      try {
        const buf = Buffer.alloc(end - start);
        const n = readSync(fd, buf, 0, buf.length, start);
        for (const line of buf.subarray(0, n).toString("utf8").split("\n")) this.#meta(line);
      } finally {
        closeSync(fd);
      }
    } catch {}
  }

  #meta(line: string): void {
    if (!line.includes('"model') && !line.includes('"thinking_level_change"')) return;
    let e: { type?: string; model?: string; thinkingLevel?: string; configured?: string; message?: { role?: string; provider?: string; model?: string } };
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === "model_change" && typeof e.model === "string") this.model = e.model;
    else if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string")
      this.thinking = e.configured && e.configured !== e.thinkingLevel ? `${e.thinkingLevel} (${e.configured})` : e.thinkingLevel;
    else if (e.type === "message" && e.message?.role === "assistant" && e.message.model)
      this.model = e.message.provider ? `${e.message.provider}/${e.message.model}` : e.message.model;
  }

  /** Feed raw JSONL text (exposed for tests). */
  ingest(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.#meta(line);
      let e: { type?: string; customType?: string; timestamp?: string; message?: { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "custom" && e.customType === "session_exit") {
        this.done = true;
        continue;
      }
      const m = e.message;
      if (e.type !== "message" || !m) continue;
      const at = Date.parse(e.timestamp ?? "") || Date.now();
      this.lastEntryAt = Math.max(this.lastEntryAt, at);
      this.done = false;
      if (m.role === "assistant") {
        const calls = Array.isArray(m.content) ? m.content.filter((p: { type?: string }) => p?.type === "toolCall") : [];
        for (const c of calls as { id?: string; name?: string; intent?: string; arguments?: { i?: string } }[]) {
          this.toolCalls++;
          const p: Pending = { name: c.name ?? "tool", intent: c.intent ?? c.arguments?.i ?? "", since: at, id: c.id };
          this.lastTool = p;
          if (c.id) this.pending.set(c.id, p);
          this.#remember(at, "call", p.name, p.intent);
        }
        if (!calls.length) this.#remember(at, "text", "", "");
        this.lastKind = calls.length ? "tool" : "none";
      } else if (m.role === "toolResult") {
        const call = m.toolCallId ? this.pending.get(m.toolCallId) : undefined;
        if (m.toolCallId) this.pending.delete(m.toolCallId);
        this.#remember(at, m.isError ? "error" : "result", call?.name ?? m.toolName ?? "tool", "");
        this.lastKind = this.pending.size ? "tool" : "model";
      } else if (m.role === "user") {
        this.#remember(at, "prompt", "", "");
        this.lastKind = "model";
      }
    }
  }

  #remember(at: number, kind: RecentEntry["kind"], name: string, intent: string): void {
    this.recent.push({ at, kind, name, intent });
    if (this.recent.length > RECENT_MAX) this.recent.shift();
  }

  /** Read new bytes from disk; returns the file's mtime (0 if missing). */
  poll(): number {
    if (!existsSync(this.file)) return 0;
    const st = statSync(this.file);
    if (st.size < this.offset) {
      // File replaced: start over, and drop the old file's half line (it would spoil the new first line).
      this.offset = 0;
      this.partial = "";
    }
    if (st.size > this.offset) {
      const fd = openSync(this.file, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size - this.offset, 8 * 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += n;
        this.ingest(buf.subarray(0, n).toString("utf8"));
      } finally {
        closeSync(fd);
      }
    }
    return st.mtimeMs;
  }
}

/** One subagent session the run started (`<session>/<Name>.jsonl`, nested `<Name>/<Name>.<Child>.jsonl`). */
export interface SubagentView {
  name: string;
  lastWrite: number;
  toolCalls: number;
  pending: Pending[];
  lastTool: Pending | null;
  done: boolean;
  model?: string;
}

export interface HeartbeatView {
  now: number;
  startedAt: number;
  tree: TreeSample;
  /** CPU use of the whole tree since the previous sample, as % of one core. */
  cpuPct: number;
  /**
   * CPU of the root's descendants only (tool processes, kernels, MCP servers). While a tool runs, the
   * root omp keeps streaming the advisor and MCP traffic, so only this and log writes show tool progress.
   */
  childCpuPct?: number;
  /** Root-process read+write bytes per second since the previous sample. */
  ioBps: number;
  /** Last session-log write (ms epoch), 0 if none yet. */
  lastWrite: number;
  toolCalls: number;
  pending: Pending[];
  lastKind: "model" | "tool" | "none";
  subagents: SubagentView[];
  /** Most recent tool call of the main session, and whether it still runs (owner 2026-10-19: always the last line). */
  lastTool?: Pending | null;
  lastToolRunning?: boolean;
  /** "provider/model" of the main session (owner 2026-10-19: show which model works, not only that it thinks). */
  model?: string;
  thinking?: string;
}

export const dur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** A run that has written nothing to its session after 8 s is compacting: normal runs write within ~2 s. */
export const COMPACT_MS = 60_000;
export function compacting(v: HeartbeatView): boolean {
  return v.tree.alive && !v.lastWrite && !v.pending.length && v.now - v.startedAt >= 8_000;
}

export type Verdict = "alive" | "waiting" | "hung" | "stuck" | "gone";

/** Newest sign of life: main log, any subagent log, or the start of the running tool. */
export function lastActivity(v: HeartbeatView): number {
  let t = v.lastWrite || v.startedAt;
  for (const s of v.subagents) if (!s.done) t = Math.max(t, s.lastWrite);
  for (const p of v.pending) t = Math.max(t, p.since);
  return t;
}

export function verdict(v: HeartbeatView): Verdict {
  if (!v.tree.alive) return "gone";
  const quiet = v.now - lastActivity(v);
  if (quiet < 60_000) return "alive";
  // A running tool: root CPU and I/O come from the advisor/MCP too, so judge the tool by its processes.
  if (v.pending.length) return (v.childCpuPct ?? 0) >= 2 ? "alive" : quiet >= HUNG_MS ? "hung" : "waiting";
  // No tool: the model streams its reply over the API socket (root I/O) without writing the log.
  if (v.cpuPct >= 2 || v.ioBps >= IO_ACTIVE_BPS) return "alive";
  return quiet >= STUCK_MS ? "stuck" : "waiting";
}

// Redact before cutting: a token cut by the length limit would no longer match the redact patterns.
const clean = (s: string, n: number) => redact(s.replace(/\s+/g, " ").replace(/[`*_~|<>@]/g, "")).text.slice(0, n);
const toolText = (p: Pending, now: number, n = 80) => {
  const what = clean(p.intent, n);
  return `\`${clean(p.name, 30)}\`${what ? `: ${what}` : ""} (${dur(now - p.since)})`;
};
/** At most this many subagent lines (running ones first). */
const MAX_SUBAGENTS = 5;

/** "anthropic/claude-opus-5-5" -> "claude-opus-5-5". */
export const shortModel = (m: string): string => m.slice(m.lastIndexOf("/") + 1);

/** The Working message text. Discord renders <t:…:T> in the owner's own time zone. */
export function formatHeartbeat(v: HeartbeatView): string {
  const vd = verdict(v);
  const quiet = dur(v.now - lastActivity(v));
  const head = {
    alive: "🟢 **Alive**",
    waiting: "🟡 **Quiet, still running**",
    hung: `🟠 **The running tool may be hung:** no CPU, no I/O and no log writes for ${quiet}. Tap ❌ Stop to end it.`,
    stuck: `🔴 **No activity for ${quiet}; it may be stuck.** Tap ❌ Stop to end it.`,
    gone: "❌ **The agent process has exited.** The answer should arrive shortly.",
  }[vd];
  const lines = [`${WORKING_EMOJI} Working… ${dur(v.now - v.startedAt)}`, `${head} · checked <t:${Math.floor(v.now / 1000)}:T>`];
  if (v.model) lines.push(`🤖 Model: \`${clean(v.model, 80)}\`${v.thinking ? ` · thinking ${clean(v.thinking, 30)}` : ""}`);
  const p = v.pending.at(-1);
  if (p) {
    lines.push(`🔧 Running ${toolText(p, v.now)}${v.pending.length > 1 ? ` +${v.pending.length - 1} more` : ""}`);
  } else if (compacting(v)) {
    // Owner 2026-10-15: measured compactions took 58–61 s (3 in the FIRSTMATE session log).
    const left = COMPACT_MS - (v.now - v.startedAt);
    lines.push(`🗜️ Compacting memory (usually ~60 s${left > 0 ? `, about ${dur(left)} left` : ", almost done"})`);
  }
  // Owner 2026-10-19: no "🧠 model is thinking or writing" line (the 🤖 Model and 🛠️ Last tool lines cover it).
  // Owner 2026-10-15: during a wait, show each subagent's last activity and tool.
  const subs = [...v.subagents].sort((a, b) => Number(a.done) - Number(b.done) || b.lastWrite - a.lastWrite);
  for (const s of subs.slice(0, MAX_SUBAGENTS)) {
    const sp = s.pending.at(-1);
    const age = s.lastWrite ? `log ${dur(v.now - s.lastWrite)} ago` : "no log yet";
    const state = s.done ? "✅ finished" : sp ? `🔧 ${toolText(sp, v.now, 60)}` : s.lastTool ? `🧠 thinking · last ${toolText(s.lastTool, v.now, 40)}` : "🧠 starting";
    lines.push(`  ↳ 🤖 **${clean(s.name, 40)}**${s.model && s.model !== v.model ? ` (${clean(shortModel(s.model), 40)})` : ""}: ${state} · ${age} · ${s.toolCalls} calls`);
  }
  if (subs.length > MAX_SUBAGENTS) lines.push(`  ↳ +${subs.length - MAX_SUBAGENTS} more subagents`);
  if (v.tree.alive) {
    const log = v.lastWrite ? `log written ${dur(v.now - v.lastWrite)} ago` : "no log yet";
    const io = v.ioBps >= 1024 ? `${(v.ioBps / 1024).toFixed(1)} KB/s` : `${Math.round(v.ioBps)} B/s`;
    lines.push(`📝 ${log} · ${v.toolCalls} tool calls · CPU ${Math.round(v.cpuPct)}% · I/O ${io} · ${v.tree.procs} procs`);
  }
  // Owner 2026-10-19: always end with the latest tool call, described by its intent. Arguments are never shown
  // (commands can hold secrets; design rule since 20fbac8).
  const lt = v.lastTool;
  if (lt) {
    const what = clean(lt.intent, 100);
    const when = v.lastToolRunning ? `running ${dur(v.now - lt.since)}` : `done · called ${dur(v.now - lt.since)} ago`;
    lines.push(`🛠️ **Last tool:** \`${clean(lt.name, 30)}\`${what ? `: ${what}` : ""} · ${when}`);
  } else lines.push("🛠️ **Last tool:** none yet");
  return lines.join("\n");
}

/** Subagent session files under a session's artifact dir (depth ≤ 3; the advisor log is skipped). */
export function subagentFiles(artifactDir: string, depth = 3): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(artifactDir);
  } catch {
    return out;
  }
  for (const n of names) {
    const f = join(artifactDir, n);
    if (n.endsWith(".jsonl")) {
      if (n !== "__advisor.jsonl") out.push(f);
    } else if (depth > 1 && !n.includes(".")) {
      try {
        if (statSync(f).isDirectory()) out.push(...subagentFiles(f, depth - 1));
      } catch {}
    }
  }
  return out;
}

/** Newest .jsonl directly in `dir` (the session a `--continue`/new run writes). */
export function newestJsonl(dir: string): string | null {
  let best: { f: string; t: number } | null = null;
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith(".jsonl")) continue;
      const f = join(dir, n);
      const t = statSync(f).mtimeMs;
      if (!best || t > best.t) best = { f, t };
    }
  } catch {}
  return best?.f ?? null;
}

/** Per-run state: call tick() every HEARTBEAT_MS to get the next message text. */
export class RunHeartbeat {
  private tail: SessionTail | null = null;
  private prev: { at: number; tree: TreeSample } | null = null;
  /** Session and subagent file sizes at run start, so continued sessions only count this run's entries. */
  private readonly startSizes = new Map<string, number>();
  private readonly subTails = new Map<string, SessionTail>();

  /** Root pid of the run's process tree; set right after spawn. */
  pid = 0;

  constructor(
    readonly startedAt: number,
    readonly sessionDir: string,
    readonly resumeFile?: string,
    /** The run's --model, else the configured default; shown until the session log names the model. */
    readonly modelHint?: string,
  ) {
    let files: string[] = [];
    if (resumeFile) files = [resumeFile];
    else {
      try {
        files = readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl")).map((n) => join(sessionDir, n));
      } catch {}
    }
    for (const f of files) {
      for (const g of [f, ...subagentFiles(f.replace(/\.jsonl$/, ""))]) {
        try {
          this.startSizes.set(g, statSync(g).size);
        } catch {}
      }
    }
  }

  private pollSubagents(file: string): SubagentView[] {
    const out: SubagentView[] = [];
    const dir = file.replace(/\.jsonl$/, "");
    for (const f of subagentFiles(dir)) {
      let tail = this.subTails.get(f);
      if (!tail) {
        try {
          if (statSync(f).mtimeMs < this.startedAt) continue; // an earlier run's subagent
        } catch {
          continue;
        }
        tail = new SessionTail(f, this.startSizes.get(f) ?? 0);
        this.subTails.set(f, tail);
      }
      const mtime = tail.poll();
      const rel = f.slice(dir.length + 1).replace(/\.jsonl$/, "");
      out.push({
        name: rel.slice(rel.lastIndexOf("/") + 1),
        lastWrite: Math.max(tail.lastEntryAt, mtime >= this.startedAt ? mtime : 0),
        toolCalls: tail.toolCalls,
        pending: [...tail.pending.values()],
        lastTool: tail.lastTool,
        done: tail.done,
        model: tail.model || undefined,
      });
    }
    return out;
  }

  /** Newest sign of life (main log, live subagent logs, running tool start); polls the logs, no CPU sample. */
  activity(now = Date.now()): number {
    const file = this.resumeFile ?? newestJsonl(this.sessionDir);
    if (file && this.tail?.file !== file) this.tail = new SessionTail(file, this.startSizes.get(file) ?? 0);
    const mtime = this.tail?.poll() ?? 0;
    const subagents = file ? this.pollSubagents(file) : [];
    const t = this.tail;
    const lastWrite = Math.max(t?.lastEntryAt ?? 0, mtime >= this.startedAt ? mtime : 0);
    return lastActivity({ now, startedAt: this.startedAt, lastWrite, subagents, pending: t ? [...t.pending.values()] : [] } as unknown as HeartbeatView);
  }

  /** Newest view from tick()/sample() (UX item 5: the 🩺 Check report reuses it instead of a second CPU sample). */
  lastView: HeartbeatView | null = null;

  /** The run's session log (main), for the 🩺 Check report. */
  get sessionFile(): string | null {
    return this.tail?.file ?? null;
  }

  /** Tool calls of the main session in this run so far (after activity()/sample() polled the log); undefined = no log. */
  get toolCalls(): number | undefined {
    return this.tail ? this.tail.toolCalls : undefined; // no log read: unknown
  }

  /** Recent session entries in short form (tool names and intents only). */
  get recent(): readonly RecentEntry[] {
    return this.tail?.recent ?? [];
  }

  sample(now = Date.now()): HeartbeatView {
    const file = this.resumeFile ?? newestJsonl(this.sessionDir);
    if (file && this.tail?.file !== file) this.tail = new SessionTail(file, this.startSizes.get(file) ?? 0);
    const mtime = this.tail?.poll() ?? 0;
    const subagents = file ? this.pollSubagents(file) : [];
    const tree = sampleTree(this.pid);
    const ms = this.prev ? now - this.prev.at : 0;
    const cpuPct = this.prev ? cpuPercent(this.prev.tree, tree, ms) : 0;
    const childCpuPct = this.prev ? cpuPercent(this.prev.tree, tree, ms, this.pid) : 0;
    const ioBps = this.prev && ms > 0 ? (Math.max(0, tree.ioBytes - this.prev.tree.ioBytes) * 1000) / ms : 0;
    this.prev = { at: now, tree };
    const t = this.tail;
    // A session file modified after the run started was written by this run.
    const lastWrite = Math.max(t?.lastEntryAt ?? 0, mtime >= this.startedAt ? mtime : 0);
    this.lastView = {
      now,
      startedAt: this.startedAt,
      tree,
      cpuPct,
      childCpuPct,
      ioBps,
      lastWrite,
      toolCalls: t?.toolCalls ?? 0,
      pending: t ? [...t.pending.values()] : [],
      lastKind: t?.lastKind ?? "none",
      subagents,
      lastTool: t?.lastTool ?? null,
      lastToolRunning: Boolean(t?.lastTool?.id && t.pending.has(t.lastTool.id)),
      model: t?.model || this.modelHint || undefined,
      thinking: t?.thinking || undefined,
    };
    return this.lastView;
  }

  tick(now = Date.now()): string {
    return formatHeartbeat(this.sample(now));
  }
}
