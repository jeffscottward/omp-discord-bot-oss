/**
 * Plan P5: stall detector and automatic continue for mirrored pane sessions (pure; the clock is a parameter).
 *
 * v1: a tool call that started and has no result, while the session file did not grow for STALL_MS, posts ONE
 * line "waiting on <tool> (<intent>) since HH:MM" in the pane's channel; growth after that posts "resumed".
 * v2 (owner decision 2026-10-16: stopped agents may continue on their own): a turn that stopped on a transient
 * provider error is continued through the bridge's safe resume path, only when no live omp holds the session
 * (checked by the caller at run time). At most MAX_CONTINUES per session per hour, after 2 min, then 8 min.
 */
import type { SessionEvent } from "./mirror.ts";

export const STALL_MS = 15 * 60_000;
export const CONTINUE_WINDOW_MS = 60 * 60_000;
/** Wait before the 1st and the 2nd automatic continue in one hour (exponential: 2, 8 min). */
export const CONTINUE_DELAYS_MS = [2 * 60_000, 8 * 60_000];
export const MAX_CONTINUES = CONTINUE_DELAYS_MS.length;
/** An error older than this (e.g. read after a long bot outage) is not continued any more. */
export const MAX_ERROR_AGE_MS = 6 * 60 * 60_000;

export type WatchState = {
  /** Tool calls with no result yet, by call id. */
  open: Record<string, { tool: string; intent: string; ts: number }>;
  /** Last time the session file grew, and its size then. */
  lastGrowth: number;
  size?: number;
  /** The stall line was posted for this call; `growth` = lastGrowth then, `since` = the call's start. */
  stall?: { callId: string; growth: number; since: number };
  /** The last turn stopped on a transient error and nothing happened since. */
  error?: { message: string; ts: number; done?: boolean };
  /** Times of automatic continues (kept for CONTINUE_WINDOW_MS). */
  continues?: number[];
};

export type WatchAction =
  | { kind: "stall"; tool: string; intent: string; since: number }
  | { kind: "resumed"; since: number }
  | { kind: "continue"; message: string; attempt: number }
  | { kind: "limit"; message: string };

const NOT_TRANSIENT =
  /usage[ _-]?limit|hit your .{0,40}limit|quota|insufficient|billing|credit|no api key|unauthori[sz]ed|forbidden|\b40[0-4]\b|invalid|quarantin|abort|cancel|context (length|window)|too long|unavailable for free/i;
const TRANSIENT =
  /socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|connection (was )?(closed|reset|timeout|error|refused)|disconnect|stream (closed|stalled|error)|websocket (closed|transport)|overloaded|\b5\d\d\b|server[_ ]error|service[_ ]unavailable|bad gateway|gateway timeout|timed? ?out|rate[ _-]?limit|\b429\b|ResourceExhausted|temporar|try again|retry|network/i;

/**
 * A provider or transport error that is worth an automatic continue. A used-up usage limit, auth errors,
 * bad requests, user aborts and unknown errors are not (conservative: unknown = no).
 */
export function isTransientError(message: string): boolean {
  if (!message.trim()) return false;
  if (NOT_TRANSIENT.test(message)) return false;
  return TRANSIENT.test(message);
}

export const freshWatch = (now: number): WatchState => ({ open: {}, lastGrowth: now });

/** Apply new session events and the file's current size. Mutates and returns `w`. */
export function watchEvents(w: WatchState, events: SessionEvent[], size: number, now: number): WatchState {
  if (w.size !== undefined && size !== w.size) w.lastGrowth = now;
  w.size = size;
  for (const ev of events) {
    if (ev.kind === "step" && ev.callId) w.open[ev.callId] = { tool: ev.tool ?? "tool", intent: ev.intent ?? "", ts: ev.ts };
    else if (ev.kind === "result" && ev.callId) delete w.open[ev.callId];
    else if (ev.kind === "reply" || ev.kind === "stopped") w.open = {};
    // Any new activity (owner message, step, reply) ends a waiting error: someone continued already.
    if (ev.kind === "turn" || ev.kind === "step" || ev.kind === "reply") w.error = undefined;
    if (ev.kind === "stopped") w.error = ev.reason === "error" && ev.error && isTransientError(ev.error) ? { message: ev.error, ts: ev.ts } : undefined;
  }
  return w;
}

/** What to do now (at most one stall/resume line and one continue decision). Mutates `w`. */
export function watchCheck(w: WatchState, now: number): WatchAction[] {
  const out: WatchAction[] = [];
  if (w.stall && (w.lastGrowth > w.stall.growth || !w.open[w.stall.callId])) {
    out.push({ kind: "resumed", since: w.stall.since });
    w.stall = undefined;
  }
  const oldest = Object.entries(w.open).sort((a, b) => a[1].ts - b[1].ts)[0];
  if (!w.stall && oldest && now - w.lastGrowth > STALL_MS && now - oldest[1].ts > STALL_MS) {
    const [callId, c] = oldest;
    w.stall = { callId, growth: w.lastGrowth, since: c.ts };
    out.push({ kind: "stall", tool: c.tool, intent: c.intent, since: c.ts });
  }
  if (w.error && !w.error.done && now - w.error.ts > MAX_ERROR_AGE_MS) w.error.done = true;
  if (w.error && !w.error.done) {
    w.continues = (w.continues ?? []).filter((t) => now - t < CONTINUE_WINDOW_MS);
    const n = w.continues.length;
    if (n >= MAX_CONTINUES) {
      w.error.done = true;
      out.push({ kind: "limit", message: w.error.message });
    } else if (now - w.error.ts >= CONTINUE_DELAYS_MS[n]!) {
      w.error.done = true;
      w.continues.push(now);
      out.push({ kind: "continue", message: w.error.message, attempt: n + 1 });
    }
  }
  return out;
}
