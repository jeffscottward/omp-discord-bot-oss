/**
 * OMP session commands for Discord (card omp-discord-commands-build, owner pick 2026-10-21).
 *
 * `omp -p` does not run slash commands, so the bot uses two routes (spike result in docs/omp-commands.md):
 * - `omp --mode rpc` on the channel's session folder for session commands (compact, context, export, handoff,
 *   rename, branch, btw) and for read-only slash commands that have an RPC handler (tools, mcp list, changelog ...).
 * - Read the session JSONL directly for views that must also work while a run is active (todo, session list).
 *
 * Every RPC operation holds the session lock (`withSessionLock`). runOmp waits for that lock, so a turn never
 * starts while a session command writes the same session file. Callers refuse an RPC operation while a turn
 * runs or waits in the same channel.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Session lock: one RPC operation per session key; runOmp waits for it.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

/** Resolves when no session command holds `key` (runOmp awaits this before it spawns). */
export async function waitSessionFree(key: string): Promise<void> {
  for (let p = locks.get(key); p; p = locks.get(key)) await p;
}

export function sessionLocked(key: string): boolean {
  return locks.has(key);
}

/** Run `fn` while holding the lock for `key`. A second caller waits for the first. */
export async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Take the lock in the same tick when it is free, so a turn that starts right after cannot slip in.
  for (let p = locks.get(key); p; p = locks.get(key)) await p;
  const { promise, resolve } = Promise.withResolvers<void>();
  locks.set(key, promise);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    resolve();
  }
}

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

/** Slash commands the bot may send through RPC. Each one was checked to return agentInvoked:false (no model turn). */
export const RPC_SLASH = new Set(["context", "shake", "todo", "jobs", "tools", "mcp", "changelog", "memory", "session", "modelpreset", "fast", "fresh"]);
/** Sub-arguments allowed per command (empty set = no argument allowed; missing = any argument). */
const RPC_SLASH_ARGS: Record<string, RegExp> = {
  context: /^$/,
  shake: /^$/,
  todo: /^$/,
  jobs: /^$/,
  tools: /^$/,
  mcp: /^(list|resources)?$/,
  changelog: /^(full)?$/,
  memory: /^(view)?$/,
  session: /^(info)?$/,
  modelpreset: /^$/,
  fast: /^(on|off|status)$/,
  fresh: /^$/,
};

export function allowedSlash(text: string): boolean {
  const m = text.match(/^\/([a-z-]+)(?:\s+(.*))?$/);
  if (!m) return false;
  const [, name = "", arg = ""] = m;
  return RPC_SLASH.has(name) && (RPC_SLASH_ARGS[name]?.test(arg.trim()) ?? false);
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcOptions {
  bin: string;
  sessionDir: string;
  cwd: string;
  /** Continue this file instead of the newest one (pinned by /resume or /branch). */
  resumeFile?: string;
  /** Extra args (model and overlay for isolated Venice/Qwen sessions). */
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface RpcSession {
  call(cmd: Record<string, unknown> & { type: string }): Promise<RpcResponse>;
  /** Run an allowed slash command; returns its command_output text (ANSI removed). */
  slash(text: string): Promise<string>;
  close(): void;
}

/** The one record guard of this module (the repo has no schema library); fields stay unknown. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function rpcArgs(o: RpcOptions): string[] {
  const args = ["--mode", "rpc", "--no-ui", "--session-dir", o.sessionDir, ...(o.extraArgs ?? [])];
  if (o.resumeFile) args.push("--resume", o.resumeFile);
  else args.push("--continue");
  return args;
}

/** Start one `omp --mode rpc` process for a session folder. Always close() it (or use withRpc). */
export function openRpc(o: RpcOptions): RpcSession {
  mkdirSync(o.sessionDir, { recursive: true });
  const child = spawn(o.bin, rpcArgs(o), { cwd: existsSync(o.cwd) ? o.cwd : process.env.HOME, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OMP_AUTO_START: "0" } });
  const pending = new Map<string, (r: RpcResponse) => void>();
  let outputs: string[] = [];
  let buf = "";
  let stderr = "";
  let n = 0;
  let dead: Error | null = null;
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: unknown;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(m)) continue;
      if (m.type === "command_output" && typeof m.text === "string") outputs.push(m.text);
      else if (m.type === "response" && typeof m.id === "string" && pending.has(m.id)) {
        const done = pending.get(m.id)!;
        pending.delete(m.id);
        done(m as unknown as RpcResponse); // shape checked: type "response" with a string id
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => void (stderr = (stderr + d.toString()).slice(-2000)));
  const fail = (e: Error) => {
    dead = e;
    for (const [id, done] of pending) done({ id, type: "response", success: false, error: e.message });
    pending.clear();
  };
  child.on("error", (e) => fail(e));
  child.on("close", (code) => fail(new Error(`omp rpc exited (${code ?? "signal"})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`)));
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;
  const call = (cmd: Record<string, unknown> & { type: string }): Promise<RpcResponse> => {
    if (dead) return Promise.resolve({ type: "response", success: false, error: dead.message });
    const id = `b${n++}`;
    const { promise, resolve } = Promise.withResolvers<RpcResponse>();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, type: "response", success: false, error: `timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    return promise;
  };
  return {
    call,
    async slash(text) {
      if (!allowedSlash(text)) throw new Error(`not an allowed session command: ${text}`);
      outputs = [];
      const r = await call({ type: "prompt", message: text });
      if (!r.success) throw new Error(r.error ?? "rpc prompt failed");
      if (isRecord(r.data) && r.data.agentInvoked === true) {
        await call({ type: "abort" });
        throw new Error(`${text} reached the model; aborted`);
      }
      return stripAnsi(outputs.join("\n")).trim();
    },
    close() {
      try {
        child.stdin.end();
      } catch {}
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      }, 3_000).unref();
    },
  };
}

/** Open an RPC process, run `fn`, close it. */
export async function withRpc<T>(o: RpcOptions, fn: (s: RpcSession) => Promise<T>): Promise<T> {
  const s = openRpc(o);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

/** Throw the RPC error, else return data. */
export function rpcData(r: RpcResponse): unknown {
  if (!r.success) throw new Error(r.error ?? `${r.command ?? "rpc"} failed`);
  return r.data;
}

// ---------------------------------------------------------------------------
// Session files (read-only views)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  file: string;
  id: string;
  title: string;
  cwd: string;
  created: number;
  modified: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  model?: string;
  thinking?: string;
  bytes: number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
}

function eachEntry(file: string, fn: (e: Record<string, unknown>) => void): void {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e: unknown = JSON.parse(line);
      if (isRecord(e)) fn(e);
    } catch {}
  }
}

/** Bot prompts wrap the owner's words in "--- owner message ---" (src/preamble.ts). Short first line for titles. */
export function promptPreview(text: string): string {
  const owner = text.match(/--- (?:owner|bridge) message ---\n([\s\S]*?)\n--- end /)?.[1] ?? text;
  return owner.replace(/\s+/g, " ").trim().slice(0, 90);
}

export function summarizeSession(file: string): SessionSummary {
  const st = statSync(file);
  const s: SessionSummary = { file, id: basename(file, ".jsonl").split("_").pop() ?? "", title: "", cwd: "", created: st.birthtimeMs || st.mtimeMs, modified: st.mtimeMs, userMessages: 0, assistantMessages: 0, toolCalls: 0, bytes: st.size };
  let firstUser = "";
  eachEntry(file, (e) => {
    if ((e.type === "title" || e.type === "title_change") && typeof e.title === "string") s.title = e.title;
    else if (e.type === "session") {
      if (typeof e.cwd === "string") s.cwd = e.cwd;
      if (typeof e.timestamp === "string") s.created = Date.parse(e.timestamp) || s.created;
    } else if (e.type === "model_change" && typeof e.model === "string") s.model = e.model;
    else if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") s.thinking = e.thinkingLevel;
    else if (e.type === "message" && isRecord(e.message)) {
      const m = e.message;
      if (m.role === "user") {
        s.userMessages++;
        if (!firstUser) firstUser = textOf(m.content);
      } else if (m.role === "assistant") {
        s.assistantMessages++;
        if (Array.isArray(m.content)) s.toolCalls += m.content.filter((c) => isRecord(c) && c.type === "toolCall").length;
      }
    }
  });
  if (!s.title) s.title = promptPreview(firstUser) || "(untitled)";
  return s;
}

/** Session files of one folder, newest first (top-level *.jsonl only; subfolders hold subagent artifacts). */
export function listSessions(dir: string, limit = 25): SessionSummary[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit)
    .map((f) => summarizeSession(f));
}

/** The file the next turn continues: the pin, else the newest session file. */
export function currentFile(dir: string, pin?: SessionPin): string | undefined {
  if (pin?.file && existsSync(pin.file)) return pin.file;
  if (pin?.fresh) return undefined;
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export interface TodoItem {
  done: boolean;
  active: boolean;
  text: string;
  phase: string;
}

/** Last todo state in a session: parsed from the newest `todo` tool result text. */
export function readTodos(file: string): { items: TodoItem[]; summary: string } | null {
  let last = "";
  eachEntry(file, (e) => {
    if (e.type === "message" && isRecord(e.message) && e.message.role === "toolResult" && e.message.toolName === "todo") last = textOf(e.message.content);
  });
  if (!last) return null;
  return parseTodoText(last);
}

export function parseTodoText(text: string): { items: TodoItem[]; summary: string } {
  const items: TodoItem[] = [];
  let phase = "";
  let summary = "";
  for (const line of text.split("\n")) {
    const ov = line.match(/^Overall:\s*(.+)$/);
    if (ov) summary = ov[1]!.trim();
    const it = line.match(/^\s*-\s*\[([ Xx>~-])\]\s*(.+)$/);
    if (it) {
      const mark = it[1]!;
      items.push({ done: mark === "X" || mark === "x", active: mark === ">", text: it[2]!.trim(), phase });
      continue;
    }
    const ph = line.match(/^\s{2}([^\s-].*):\s*$/);
    if (ph) phase = ph[1]!.trim();
  }
  return { items, summary };
}

// ---------------------------------------------------------------------------
// Per-session state: pin (/resume, /new, /branch) and run mode (/mode, /goal)
// ---------------------------------------------------------------------------

export interface SessionPin {
  /** Continue this file (absolute path inside the session folder). */
  file?: string;
  /** Next turn starts a new session file (no --continue). Cleared after that turn. */
  fresh?: boolean;
}

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
export const EFFORTS: Effort[] = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ChannelMode {
  effort?: Effort;
  plan?: boolean;
  fast?: boolean;
  advisor?: boolean;
  extendedContext?: boolean;
  goal?: string;
}

export interface ChannelState {
  pin?: SessionPin;
  mode?: ChannelMode;
}

export class StateStore {
  private data: Record<string, ChannelState> = {};
  constructor(private file: string) {
    try {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isRecord(v)) this.data = v as Record<string, ChannelState>; // our own file, written by save()
    } catch {}
  }
  get(key: string): ChannelState {
    return this.data[key] ?? {};
  }
  update(key: string, fn: (s: ChannelState) => ChannelState): ChannelState {
    const next = fn({ ...this.get(key) });
    if (!next.pin && !next.mode) delete this.data[key];
    else this.data[key] = next;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
    return next;
  }
}

/** Overlay file for mode settings that have no CLI flag (advisor off, extended context). */
export function modeOverlay(dir: string, key: string, m: ChannelMode): string | undefined {
  const lines: string[] = [];
  if (m.advisor === false) lines.push("advisor:", "  enabled: false");
  if (m.extendedContext !== undefined) lines.push(`extendedContext: ${m.extendedContext}`);
  if (!lines.length) return undefined;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `mode-${key}.yml`);
  writeFileSync(file, `# Written by omp-discord-bot (/mode for this channel)\n${lines.join("\n")}\n`);
  return file;
}

/** Read-only tools for plan mode (no edit/write/bash/eval/task). */
export const PLAN_TOOLS = "read,grep,glob,find,web_search,todo";

/** CLI args for a channel's mode. Isolated (Venice/Qwen) turns keep their own thinking/advisor flags. */
export function modeArgs(m: ChannelMode | undefined, overlay: string | undefined, isolated: boolean): string[] {
  if (!m) return [];
  const a: string[] = [];
  if (!isolated) {
    if (m.effort) a.push("--thinking", m.effort);
    if (m.advisor === true) a.push("--advisor");
    if (overlay) a.push("--config", overlay);
  }
  if (m.plan) a.push("--tools", PLAN_TOOLS);
  return a;
}

/** Text the bot adds in front of the owner's message for plan mode and /goal. */
export function modePreamble(m: ChannelMode | undefined): string {
  if (!m) return "";
  const parts: string[] = [];
  if (m.goal) parts.push(`[Channel goal set by the owner with /goal: ${m.goal}]`);
  if (m.plan)
    parts.push(
      "[PLAN MODE set by the owner with /mode: investigate read-only. Do not edit files, run state-changing commands or start jobs. End your answer with a numbered plan under the heading \"## Plan\". The owner approves it with a button; then you implement it.]",
    );
  return parts.length ? `${parts.join("\n")}\n\n` : "";
}

// ---------------------------------------------------------------------------
// Formatting helpers (phone width)
// ---------------------------------------------------------------------------

export function kTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function bar(percent: number, width = 20): string {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${"█".repeat(full)}${"░".repeat(width - full)}`;
}

export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return `${Math.round(d / 86_400_000)} d ago`;
}

/** Discord message limit with room for a code fence. */
export function clip(s: string, max = 1850): string {
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n… (cut)`;
}

/** Copy a session file into another session folder (a fork at the current point). Returns the new path. */
export function forkFile(file: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(file));
  writeFileSync(dest, readFileSync(file));
  return dest;
}

/** Move a session file (and its artifact folder) into `<dir>/.trash/` (the /delete button). */
export function trashFile(file: string): void {
  const trash = join(dirname(file), ".trash");
  mkdirSync(trash, { recursive: true });
  renameSync(file, join(trash, basename(file)));
  const art = file.replace(/\.jsonl$/, "");
  if (existsSync(art)) renameSync(art, join(trash, basename(art)));
}
