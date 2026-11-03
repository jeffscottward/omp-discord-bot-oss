/**
 * Card sma-bot-lost-turns (state-machine-audit #8): one lifecycle for a bot job. The queue (src/queue.ts), the
 * stack tracker (src/router.ts, src/stackroute.ts), the 📋 Master queue (src/masterqueue.ts) and the status
 * reactions (src/main.ts) all use this type and this transition function. Before, each copy had its own names
 * ("cancelled" in the stack tracker, "stopped" on the master board, `ok: undefined` in between).
 *
 *   queued ──start──▶ running ──end──▶ done | failed | stopped
 *     └──────cancel──────────────────▶ stopped
 *
 * "stopped" is the one name for a job the owner stopped while it ran and a waiting job that was cancelled.
 */
export type JobState = "queued" | "running" | "done" | "failed" | "stopped";
export type FinalJobState = Extract<JobState, "done" | "failed" | "stopped">;
export type JobEvent =
  | { type: "start" }
  | { type: "cancel" }
  /** The run ended. `cancelled`: the owner tapped ❌ Stop. `error`: the run threw. */
  | { type: "end"; ok: boolean; cancelled: boolean; error?: unknown };

export function jobTransition(state: JobState, ev: JobEvent): JobState {
  if (state === "queued") return ev.type === "start" ? "running" : ev.type === "cancel" ? "stopped" : state;
  if (state === "running" && ev.type === "end") return ev.error ? "failed" : ev.cancelled ? "stopped" : ev.ok ? "done" : "failed";
  return state; // a final state never moves; a running job ends only through "end"
}

export function isFinal(s: JobState): s is FinalJobState {
  return s === "done" || s === "failed" || s === "stopped";
}

/**
 * The "end" event for a run's result. A result object's `ok`/`cancelled` fields decide (RunResult in src/omp.ts);
 * a run that returns no such object and does not throw counts as done.
 */
export function endEvent(result: unknown, error: unknown): JobEvent {
  const r = result && typeof result === "object" ? (result as { ok?: unknown; cancelled?: unknown }) : {};
  return { type: "end", ok: r.ok === undefined ? true : r.ok === true, cancelled: r.cancelled === true, error };
}

/**
 * The one status reaction on the owner's message for each state (owner 2026-10-15: ⏳ waiting, ⚙️ being worked
 * on, ✅/❌ finished). A stopped job carries none: the "🛑 Stopped." reply says it.
 */
export function jobReaction(s: JobState, working: string): string | null {
  return { queued: "⏳", running: working, done: "✅", failed: "❌", stopped: null }[s];
}
