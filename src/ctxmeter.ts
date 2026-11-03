/**
 * Context meter (owner 2026-11-03, card context-meter): how much of the model's context window the last
 * call of a session used, like the OMP status line. Used tokens = input + cacheRead + cacheWrite of the
 * last assistant usage in the session file; the window comes from `omp models` (cached).
 */
import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type CtxUse = { used: number; window: number; pct: number; model?: string };

/** OMP compacts at 85% of the window by default (compaction.thresholdPercent). */
export const COMPACT_PCT = Number(process.env.OMP_COMPACT_PCT) || 85;

/** Last assistant usage in session JSONL text. */
export function lastUsage(text: string): { used: number; model?: string } | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? "";
    if (!l.includes('"usage"')) continue;
    try {
      const e = JSON.parse(l) as { message?: { role?: string; model?: string; usage?: Record<string, number> } };
      const u = e.message?.usage;
      if (e.message?.role !== "assistant" || !u) continue;
      const used = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      if (used > 0) return { used, ...(e.message.model ? { model: e.message.model } : {}) };
    } catch {
      /* partial first line of the tail */
    }
  }
  return undefined;
}

/** Parse "1M", "200K", "128000" into tokens. */
export function parseSize(s: string): number | undefined {
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s.trim());
  if (!m) return undefined;
  const u = (m[2] ?? "").toLowerCase();
  return Math.round(Number(m[1]) * (u === "m" ? 1e6 : u === "k" ? 1e3 : 1));
}

/** model -> window from the `omp models` table. */
export function parseModels(out: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of out.split("\n")) {
    const c = l.split("│").map((x) => x.trim());
    if (c.length < 4 || !c[1] || c[1] === "model") continue;
    const w = parseSize(c[2] ?? "");
    if (w && !map.has(c[1])) map.set(c[1], w);
  }
  return map;
}

let windows = new Map<string, number>();
let loadedAt = 0;
let loading = false;
/** Refresh the window table in the background (never blocks the event loop); every 6 h, retry after 10 min on failure. */
function refreshWindows(): void {
  if (loading || Date.now() - loadedAt < (windows.size ? 6 * 3600_000 : 600_000)) return;
  loading = true;
  loadedAt = Date.now();
  execFile("omp", ["models"], { encoding: "utf8", timeout: 30_000 }, (err, out) => {
    loading = false;
    if (!err) {
      const m = parseModels(out);
      if (m.size) windows = m;
    }
  });
}
// Start loading at import, so the first board render (after Discord login) already has the windows.
if (!process.env.BUN_TEST && process.env.NODE_ENV !== "test") refreshWindows();
export function windowOf(model: string): number | undefined {
  refreshWindows();
  return windows.get(model) ?? windows.get(model.split("/").pop() ?? model);
}

export function compute(used: number, window: number, model?: string): CtxUse {
  return { used, window, pct: Math.round((used / window) * 100), ...(model ? { model } : {}) };
}

/** Context use of a session file; `win` overrides the window lookup (tests). */
export function ctxOfFile(file: string, win?: (model: string) => number | undefined): CtxUse | undefined {
  let text = "";
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - 2 * 1024 * 1024);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const u = lastUsage(text);
  if (!u?.model) return undefined;
  const w = (win ?? windowOf)(u.model);
  return w ? compute(u.used, w, u.model) : undefined;
}

/** Newest session file in a session folder. */
export function newestSession(dir: string): string | undefined {
  try {
    const fs = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    return fs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

export function ctxIcon(pct: number): string {
  return pct >= 85 ? "🔴" : pct >= 70 ? "⚠️" : "🧠";
}

export function tokens(n: number): string {
  return n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1e3)}k`;
}

/** Board line: "🧠 FIRSTMATE context: 83% (827k / 1M) · compacts at 85%". */
export function ctxLine(label: string, c: CtxUse): string {
  return `${ctxIcon(c.pct)} ${label} context: ${c.pct}% (${tokens(c.used)} / ${tokens(c.window)}) · compacts at ${COMPACT_PCT}%`;
}

/** Short form for stack threads: "stack-ai 41%". */
export function ctxShort(label: string, c: CtxUse): string {
  return `${label} ${c.pct >= 70 ? `${ctxIcon(c.pct)} ` : ""}${c.pct}%`;
}

/** Reply footer suffix: " · ctx 83%". */
export function ctxSuffix(c?: CtxUse): string {
  return c ? ` · ctx ${c.pct}%${c.pct >= 70 ? ` ${ctxIcon(c.pct)}` : ""}` : "";
}

/**
 * Master queue lines: FIRSTMATE in long form, then stack sessions used in the last 12 h in short form.
 * `sessionsRoot` holds one folder per session key (firstmate, stack-<name>).
 */
export function boardCtxLines(sessionsRoot: string, now = Date.now(), win?: (model: string) => number | undefined): string {
  const out: string[] = [];
  const fm = newestSession(join(sessionsRoot, "firstmate"));
  const c = fm && ctxOfFile(fm, win);
  if (c) out.push(ctxLine("FIRSTMATE", c));
  let keys: string[] = [];
  try {
    keys = readdirSync(sessionsRoot).filter((k) => /^stack-[a-z0-9-]+$/.test(k)).sort();
  } catch {
    /* no sessions */
  }
  const stacks: string[] = [];
  for (const k of keys) {
    const f = newestSession(join(sessionsRoot, k));
    if (!f || now - statSync(f).mtimeMs > 12 * 3600_000) continue;
    const s = ctxOfFile(f, win);
    if (s) stacks.push(ctxShort(k.slice(6), s));
  }
  if (stacks.length) out.push(`🧵 Stacks context: ${stacks.join(" · ")}`);
  return out.join("\n");
}
