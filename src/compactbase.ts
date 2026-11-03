/**
 * Post-compaction baseline (owner 2026-11-03, card compact-baseline): after each FIRSTMATE auto-compaction,
 * measure the first assistant call after the `type:"compaction"` entry and post one line to the FIRSTMATE channel.
 * total = input + cacheRead + cacheWrite; fixed = cacheRead (cached system prompt and tools); summary = the rest.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokens } from "./ctxmeter.ts";

export type Baseline = { id: string; at: string; before: number; total: number; fixed: number; summary: number; model?: string };

/** Every compaction in session JSONL text that already has an assistant usage after it. */
export function baselines(text: string): Baseline[] {
  const out: Baseline[] = [];
  let open: { id: string; at: string; before: number } | undefined;
  let lastUsed = 0;
  for (const l of text.split("\n")) {
    if (!l.includes('"compaction"') && !l.includes('"usage"')) continue;
    let e: { type?: string; id?: string; timestamp?: string; tokensBefore?: number; message?: { role?: string; model?: string; usage?: Record<string, number> } };
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === "compaction" && e.id) {
      open = { id: e.id, at: e.timestamp ?? "", before: e.tokensBefore ?? lastUsed };
      continue;
    }
    const u = e.message?.usage;
    if (e.message?.role !== "assistant" || !u) continue;
    const fixed = u.cacheRead ?? 0;
    const total = (u.input ?? 0) + fixed + (u.cacheWrite ?? 0);
    if (total <= 0) continue;
    if (open) {
      out.push({ ...open, total, fixed, summary: total - fixed, ...(e.message.model ? { model: e.message.model } : {}) });
      open = undefined;
    }
    lastUsed = total;
  }
  return out;
}

/** "🧠 FIRSTMATE compacted: baseline 78k (8% of 1M) — fixed 27k + summary 51k; before compaction 847k" */
export function baselineLine(b: Baseline, window = 1_000_000): string {
  return `🧠 FIRSTMATE compacted: baseline ${tokens(b.total)} (${Math.round((b.total / window) * 100)}% of ${tokens(window)}) — fixed ${tokens(b.fixed)} + summary ${tokens(b.summary)}; before compaction ${tokens(b.before)}`;
}

type State = { seen: string[] };
function load(file: string): State | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as State;
  } catch {
    return undefined;
  }
}

/**
 * New baselines to post, deduped by compaction id in `stateFile`. The first run (no state file)
 * records the existing compactions without posting, so a restart never posts old ones again.
 */
export function newBaselines(text: string, stateFile: string): Baseline[] {
  const all = baselines(text);
  const st = load(stateFile);
  const seen = new Set(st?.seen ?? []);
  const fresh = st ? all.filter((b) => !seen.has(b.id)) : [];
  if (!st || fresh.length) {
    for (const b of all) seen.add(b.id);
    if (!existsSync(dirname(stateFile))) mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ seen: [...seen].slice(-200) }));
  }
  return fresh;
}
