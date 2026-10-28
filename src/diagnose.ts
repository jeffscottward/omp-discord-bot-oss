// 🩺 Check for bridge runs (owner pick 2026-10-23, UX review item 5). The Working… heartbeat says alive/quiet/
// stuck, but not why; the owner then asked FIRSTMATE to inspect the run (12 requests in 9 days). formatCheck()
// builds a report WITHOUT an LLM: process state, CPU, current tool and since when, child processes (names
// and states only), the last session entries (tool names and intents only), restart/drain state and the
// queue. Never commands, arguments, output or file contents (same privacy rule as the heartbeat).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dur, lastActivity, verdict, type HeartbeatView, type RecentEntry } from "./heartbeat.ts";
import { redact } from "./redact.ts";

export const CHECK_PREFIX = "diag:";

export interface ProcInfo {
  pid: number;
  comm: string;
  /** /proc state letter: R running, S sleeping, D disk wait, Z zombie, T stopped. */
  state: string;
}

/** Names and states of the tree's processes except the root (comm only; never the command line). */
export function childProcs(view: HeartbeatView | null | undefined, rootPid: number, procDir = "/proc"): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const pid of view?.tree.ticks.keys() ?? []) {
    if (pid === rootPid) continue;
    try {
      const stat = readFileSync(join(procDir, String(pid), "stat"), "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      out.push({ pid, comm, state: stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) });
    } catch {} // exited since the sample
  }
  return out;
}

const STATE: Record<string, string> = { R: "running", S: "sleeping", D: "disk wait ⚠️", Z: "zombie ⚠️", T: "stopped ⚠️", I: "idle" };
const clean = (s: string, n: number) => redact(s.replace(/\s+/g, " ").replace(/[`*_~|<>@]/g, "")).text.slice(0, n);

/** "bash ×2 (sleeping), rg (running)": grouped by name and state, at most 8 groups. */
export function procSummary(ps: ProcInfo[]): string {
  if (!ps.length) return "none";
  const groups = new Map<string, number>();
  for (const p of ps) {
    const k = `${clean(p.comm, 20)}\u0000${STATE[p.state] ?? p.state}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const parts = [...groups].map(([k, n]) => {
    const [name, st] = k.split("\u0000");
    return `${name}${n > 1 ? ` ×${n}` : ""} (${st})`;
  });
  return parts.length > 8 ? `${parts.slice(0, 8).join(", ")} +${parts.length - 8} more` : parts.join(", ");
}

const ts = (ms: number) => `<t:${Math.floor(ms / 1000)}:T>`;

export function recentLine(e: RecentEntry): string {
  const what = clean(e.intent, 80);
  const name = `\`${clean(e.name, 30)}\``;
  const text = {
    prompt: "👤 message to the agent",
    call: `🔧 called ${name}${what ? `: ${what}` : ""}`,
    result: `✅ ${name} finished`,
    error: `❌ ${name} returned an error`,
    text: "🧠 model wrote a reply",
  }[e.kind];
  return `${ts(e.at)} ${text}`;
}

export interface CheckInput {
  now: number;
  /** Why the report was posted. */
  reason: "button" | "quiet" | "no-start";
  /** The running job of this channel, if any. */
  job?: { id: number; startedAt: number; preview: string } | null;
  /** Agent root pid (0 = not spawned yet) and its newest heartbeat view. */
  pid?: number;
  view?: HeartbeatView | null;
  children?: ProcInfo[];
  recent?: readonly RecentEntry[];
  sessionFile?: string | null;
  /** The bot stops a run after this long without activity. */
  idleLimitMs: number;
  restart: { pending: boolean; updates: number; draining: boolean; holding: string[] };
  queue: { waitingHere: string[]; runningAll: number; queuedAll: number; max: number; waitReason?: string };
}

const REASON = {
  button: "",
  quiet: " · posted by itself: the run has been quiet",
  "no-start": " · posted by itself: your message got no Working… within 60 s",
};

export function formatCheck(c: CheckInput): string {
  const lines = [`🩺 **Check**${REASON[c.reason]} · ${ts(c.now)}`];
  const v = c.view;
  if (c.job) {
    lines.push(`▶️ **Job #${c.job.id}:** ${clean(c.job.preview, 60)} · started ${dur(c.now - c.job.startedAt)} ago`);
    if (!c.pid || !v) {
      lines.push("⚙️ **Process:** not started yet. The job waits for its session (a /compact or another session command can hold it) or the agent is starting.");
    } else {
      const vd = verdict({ ...v, now: c.now });
      const quiet = c.now - lastActivity(v);
      const head = { alive: "🟢 alive", waiting: "🟡 quiet, still running", hung: "🟠 the running tool may be hung", stuck: "🔴 no activity; it may be stuck", gone: "❌ the agent process has exited" }[vd];
      lines.push(`📊 **State:** ${head} · last activity ${dur(quiet)} ago`);
      if (v.tree.alive) {
        const io = v.ioBps >= 1024 ? `${(v.ioBps / 1024).toFixed(1)} KB/s` : `${Math.round(v.ioBps)} B/s`;
        lines.push(`⚙️ **Process:** pid ${c.pid} · CPU ${Math.round(v.cpuPct)}% (tools ${Math.round(v.childCpuPct ?? 0)}%) · I/O ${io} · ${v.tree.procs} procs`);
        lines.push(`👶 **Child processes:** ${procSummary(c.children ?? [])}`);
      }
      const p = v.pending.at(-1);
      lines.push(p ? `🔧 **Current tool:** \`${clean(p.name, 30)}\`${p.intent ? `: ${clean(p.intent, 80)}` : ""} · since ${ts(p.since)} (${dur(c.now - p.since)})` : "🔧 **Current tool:** none (the model is thinking or writing)");
      const left = c.idleLimitMs - quiet;
      if (vd !== "alive" && vd !== "gone")
        lines.push(`⏱️ The bot stops a run after ${dur(c.idleLimitMs)} without activity${left > 0 ? ` (in about ${dur(left)})` : ""}. Tap ❌ Stop to end it now.`);
    }
    const recent = c.recent ?? [];
    if (recent.length) lines.push(`📜 **Last ${recent.length} log entries:**`, ...recent.map((e) => `- ${recentLine(e)}`));
    if (c.sessionFile) lines.push(`🗂️ Session log: \`${c.sessionFile.replace(/^\/home\/[^/]+/, "~")}\``);
  } else lines.push("▶️ **No job runs in this channel now.**");
  const q = c.queue;
  const here = q.waitingHere.length ? `${q.waitingHere.length} waiting here (next: ${clean(q.waitingHere[0]!, 50)})` : "nothing waiting here";
  lines.push(`⏳ **Queue:** ${here} · all channels: ${q.runningAll}/${q.max} running, ${q.queuedAll} waiting`);
  if (q.waitReason) lines.push(`❓ **Why it waits:** ${q.waitReason}`);
  const r = c.restart;
  if (r.draining) lines.push(`🔄 **Restart:** pending (${r.updates} update${r.updates === 1 ? "" : "s"}); new jobs wait${r.holding.length ? ` for ${r.holding.slice(0, 3).join(", ")}` : ""}.`);
  else if (r.pending) lines.push(`🔄 **Restart:** pending (${r.updates} update${r.updates === 1 ? "" : "s"}); it waits until no job runs.`);
  else lines.push("🔄 **Restart:** none pending");
  // Keep whole lines under Discord's 2000-character limit.
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > 1950) break;
    out += (out ? "\n" : "") + l;
  }
  return out;
}

/** Why a queued job has not started (null: it waits behind this channel's own running job, which is normal). */
export function waitReason(o: { draining: boolean; sameChannelRunning: boolean; running: number; max: number; holding: string[]; runningLabels: string[] }): string | null {
  if (o.draining) return `a bot restart is pending, so new jobs wait${o.holding.length ? ` until ${o.holding.slice(0, 3).join(", ")} ends` : ""}. They start after the restart.`;
  if (o.sameChannelRunning) return null;
  if (o.running >= o.max) return `all ${o.max} run slots are busy (${o.runningLabels.slice(0, 3).join(", ")}${o.runningLabels.length > 3 ? ` +${o.runningLabels.length - 3}` : ""}). It starts when one ends.`;
  return "no known reason: it should start at once. This looks like a bot problem; tap ❌ Cancel and send it again.";
}

/** Auto report when a run is quiet this long: 10 min, but before the idle stop (IDLE_TIMEOUT_MS) ends the run. */
export function autoCheckQuietMs(idleLimitMs: number): number {
  return Math.max(60_000, Math.min(10 * 60_000, idleLimitMs - 2 * 60_000));
}
