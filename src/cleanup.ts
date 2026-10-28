// Idle channel/tab cleanup (owner 2026-10-18). Pure helpers are exported for tests; the CLI is
// scripts/channel-cleanup.ts. Never deletes a channel: finished ones move to 📦 Archive.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const API = "https://discord.com/api/v10";

export function loadToken(file = join(homedir(), ".config/omp-discord/bot.env")): string {
  const m = readFileSync(file, "utf8").match(/^DISCORD_BOT_TOKEN=(.*)$/m);
  if (!m) throw new Error("DISCORD_BOT_TOKEN missing");
  return m[1]!.trim().replace(/^["']|["']$/g, "");
}

export type Msg = { id: string; authorId: string; bot: boolean; ts: number; content: string };

export async function discord(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    if (r.status === 429) {
      const j = (await r.json().catch(() => ({}))) as { retry_after?: number };
      await Bun.sleep(((j.retry_after ?? 1) + 0.2) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`discord ${init.method ?? "GET"} ${path.split("?")[0]} -> ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error("discord rate limited");
}

/** Newest-first pages; returns oldest-first, at most `max` messages. */
export async function fetchMessages(token: string, channelId: string, max = 100): Promise<Msg[]> {
  const all: Msg[] = [];
  let before = "";
  while (all.length < max) {
    const page = (await discord(token, `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`)) as {
      id: string; author: { id: string; bot?: boolean }; timestamp: string; content: string; embeds?: { description?: string; title?: string }[];
    }[];
    if (!page.length) break;
    for (const m of page)
      all.push({
        id: m.id, authorId: m.author.id, bot: !!m.author.bot, ts: Date.parse(m.timestamp),
        content: [m.content, ...(m.embeds ?? []).map((e) => `${e.title ?? ""} ${e.description ?? ""}`)].join("\n").trim(),
      });
    before = page.at(-1)!.id;
    if (page.length < 100) break;
  }
  return all.sort((a, b) => a.ts - b.ts);
}

export function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))]!;
}

/** Channels that are never touched (owner list 2026-10-18). Matched on the channel slug. */
export const PROTECTED = /firstmate|dashboard|alert|p2b|links|youtube|bake-?off|account/i;

/** Long-lived helpers every idle omp keeps as children; anything else below omp is real work. */
const HELPER = [
  /jev-browser\/bridge\.py mcp/,
  /context-mode\/server\.bundle\.mjs/,
  /__omp_worker_(daemon_broker|js_eval_process)/,
  /\btsc\b.*--lsp/,
  /omp-python-runner-\d+\/runner-/,
  /language-server|--stdio/,
];

/**
 * True when the pane runs anything besides its shell, omp, and omp's long-lived helpers.
 * Unknown input counts as busy (never close what we cannot see). Pure; exported for tests.
 */
export function paneBusy(processInfoRaw: string, ps: string): boolean {
  let info: { shell_pid?: number; foreground_processes?: { name?: string; argv?: string[] }[] } | undefined;
  try {
    info = (JSON.parse(processInfoRaw) as { result?: { process_info?: typeof info } }).result?.process_info;
  } catch {
    return true;
  }
  if (!info?.shell_pid) return true;
  const fg = info.foreground_processes ?? [];
  if (fg.some((p) => !/^(bash|zsh|sh|fish|omp)$/.test(p.name ?? ""))) return true;
  const rows: { pid: number; ppid: number; name: string; args: string }[] = [];
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!, args: m[4] ?? "" });
  }
  if (!rows.length) return true;
  const kids = (pid: number) => rows.filter((r) => r.ppid === pid);
  for (const c of kids(info.shell_pid)) {
    if (!/^(omp)$/.test(c.name) && !/(^|\/)omp(\s|$)/.test(c.args)) return true; // another job under the shell
    // Walk below omp: only helper processes (and their own children) are allowed.
    const stack = kids(c.pid);
    while (stack.length) {
      const p = stack.pop()!;
      if (!HELPER.some((h) => h.test(p.args))) return true;
    }
  }
  return false;
}

/** Last assistant entry in a session tail: did the turn end (stop) with no pending tool call? */
export function sessionEnded(tail: string): boolean | null {
  const lines = tail.trim().split("\n").reverse();
  for (const line of lines) {
    let j: { type?: string; message?: { role?: string; stopReason?: string } };
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== "message" || !j.message) continue;
    if (j.message.role === "user" || j.message.role === "toolResult") return false; // a turn is in progress
    if (j.message.role === "assistant") return j.message.stopReason === "stop";
  }
  return null;
}

/** Does this text ask the owner something? */
export function asksOwner(text: string): boolean {
  const t = text.slice(-600);
  return /\?\s*(\*|_|`|\)|$)/m.test(t) || /\b(still waiting|please (confirm|choose|decide)|which (one|option)|should i|do you want|your (call|decision)|approve)\b/i.test(t);
}

/** Final messages that admit unfinished work or an unconfirmed result. */
export function hasCaveat(text: string): boolean {
  return /\b(could not|couldn't|cannot|can't|unable to|not (yet|confirmed|verified|done|pushed)|pending|need(s)? (a )?(rebase|relay|review|approval|decision)|will need|blocked|failed|failing|todo|on hold|unresolved|unknown)\b/i.test(text.slice(-1500));
}

/** True when a not-done FIRSTMATE tracker item names this channel (slug or id). */
export function trackerOpen(items: { s?: string }[], slug: string, channelId: string): boolean {
  const plain = slug.replace(/^[^a-z0-9]+-/i, "");
  return items.some((i) => i.s !== "done" && (JSON.stringify(i).includes(channelId) || JSON.stringify(i).includes(plain)));
}

export type Verdict = { kind: "finished" | "unsure" | "active" | "protected"; reason: string };

export function classify(a: {
  name: string; idleMs: number; thresholdMs: number; lastFromOwner: boolean; lastText: string;
  agentStatus: string | null; busy: boolean; ended: boolean | null; openTrackerItem?: boolean;
}): Verdict {
  if (PROTECTED.test(a.name)) return { kind: "protected", reason: "owner never-close list" };
  if (a.idleMs < a.thresholdMs) return { kind: "active", reason: "under the idle threshold" };
  if (a.agentStatus === "working" || a.agentStatus === "blocked") return { kind: "unsure", reason: `agent is ${a.agentStatus}` };
  if (a.busy) return { kind: "unsure", reason: "a process still runs in the tab" };
  if (a.lastFromOwner) return { kind: "unsure", reason: "last message is from the owner (no reply)" };
  if (a.openTrackerItem) return { kind: "unsure", reason: "FIRSTMATE tracker has an open item for it" };
  if (!a.lastText.trim()) return { kind: "unsure", reason: "no readable final message" };
  if (asksOwner(a.lastText)) return { kind: "unsure", reason: "last message asks a question" };
  if (hasCaveat(a.lastText)) return { kind: "unsure", reason: "last message reports unfinished or unconfirmed work" };
  if (a.agentStatus !== "idle") return { kind: "unsure", reason: `agent state ${a.agentStatus ?? "unknown"}` };
  if (a.ended === false) return { kind: "unsure", reason: "session turn did not finish" };
  return { kind: "finished", reason: "final report, no open question, agent idle, nothing running" };
}

/** At most one ask per channel per week. */
export function dueForAsk(lastAsked: number | undefined, now: number, weekMs = 7 * 24 * 3_600_000): boolean {
  return lastAsked === undefined || now - lastAsked >= weekMs;
}
