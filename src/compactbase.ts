/**
 * Post-compaction baseline (owner 2026-11-03, card compact-baseline): after each FIRSTMATE auto-compaction,
 * measure the first assistant call after the `type:"compaction"` entry and post one line to the FIRSTMATE channel.
 * total = input + cacheRead + cacheWrite; fixed = cacheRead (cached system prompt and tools); summary = the rest.
 * The session file is large (50+ MB), so the watcher reads only new bytes after a stored offset.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokens } from "./ctxmeter.ts";

export type Baseline = { id: string; at: string; before: number; total: number; fixed: number; summary: number; model?: string };

/**
 * Every compaction in session JSONL text that already has an assistant usage after it.
 * `pending` = char index of the start of a compaction line that has no usage yet (rescan from there).
 */
export function scan(text: string): { found: Baseline[]; pending?: number } {
  const found: Baseline[] = [];
  let open: { id: string; at: string; before: number; pos: number } | undefined;
  let lastUsed = 0;
  let pos = 0;
  for (const l of text.split("\n")) {
    const start = pos;
    pos += l.length + 1;
    if (!l.includes('"compaction"') && !l.includes('"usage"')) continue;
    let e: { type?: string; id?: string; timestamp?: string; tokensBefore?: number; message?: { role?: string; model?: string; usage?: Record<string, number> } };
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === "compaction" && e.id) {
      open = { id: e.id, at: e.timestamp ?? "", before: e.tokensBefore ?? lastUsed, pos: start };
      continue;
    }
    const u = e.message?.usage;
    if (e.message?.role !== "assistant" || !u) continue;
    const fixed = u.cacheRead ?? 0;
    const total = (u.input ?? 0) + fixed + (u.cacheWrite ?? 0);
    if (total <= 0) continue;
    if (open) {
      found.push({ id: open.id, at: open.at, before: open.before, total, fixed, summary: total - fixed, ...(e.message.model ? { model: e.message.model } : {}) });
      open = undefined;
    }
    lastUsed = total;
  }
  return open ? { found, pending: open.pos } : { found };
}

export const baselines = (text: string): Baseline[] => scan(text).found;

/** "🧠 FIRSTMATE compacted: baseline 78k (8% of 1M) — fixed 27k + summary 51k; before compaction 847k" */
export function baselineLine(b: Baseline, window = 1_000_000): string {
  return `🧠 FIRSTMATE compacted: baseline ${tokens(b.total)} (${Math.round((b.total / window) * 100)}% of ${tokens(window)}) — fixed ${tokens(b.fixed)} + summary ${tokens(b.summary)}; before compaction ${tokens(b.before)}`;
}

type State = { seen: string[]; file?: string; offset?: number; pend?: Baseline[] };

/**
 * Watches one session file. `poll()` returns new baselines (deduped by compaction id); the caller posts
 * each one and then calls `done(id)`, so a failed post is retried on the next poll.
 * The first run (no state file) records the existing compactions without posting.
 */
export class BaselineWatch {
  private st: State;
  private pend: Baseline[] = [];
  private fresh: boolean;
  constructor(private stateFile: string) {
    let st: State | undefined;
    try {
      st = JSON.parse(readFileSync(stateFile, "utf8")) as State;
    } catch {
      st = undefined;
    }
    this.fresh = !st;
    this.st = st ?? { seen: [] };
    this.pend = this.st.pend ?? []; // unposted baselines survive a restart
  }
  private save(): void {
    if (!existsSync(dirname(this.stateFile))) mkdirSync(dirname(this.stateFile), { recursive: true });
    this.st.seen = this.st.seen.slice(-200);
    this.st.pend = this.pend;
    writeFileSync(this.stateFile, JSON.stringify(this.st));
  }
  poll(file: string): Baseline[] {
    let offset = this.st.file === file ? (this.st.offset ?? 0) : 0;
    const fd = openSync(file, "r");
    let text: string;
    try {
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0; // rewritten
      if (size === offset) return [...this.pend];
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      const end = buf.lastIndexOf(10) + 1; // only complete lines
      text = buf.subarray(0, end).toString("utf8");
      const r = scan(text);
      // Next start: the unresolved compaction line, else the end of the last complete line.
      const next = offset + (r.pending !== undefined ? Buffer.byteLength(text.slice(0, r.pending)) : end);
      this.st.file = file;
      this.st.offset = next;
      if (this.fresh) {
        this.st.seen.push(...r.found.map((b) => b.id));
        this.fresh = false;
        this.pend = [];
      } else {
        for (const b of r.found) if (!this.st.seen.includes(b.id) && !this.pend.some((p) => p.id === b.id)) this.pend.push(b);
      }
      this.save();
    } finally {
      closeSync(fd);
    }
    return [...this.pend];
  }
  done(id: string): void {
    this.pend = this.pend.filter((b) => b.id !== id);
    if (!this.st.seen.includes(id)) this.st.seen.push(id);
    this.save();
  }
}
