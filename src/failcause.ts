// Failed runs in plain words (owner pick 2026-10-23, UX review item 7). The bridge used to post only
// "OMP run failed (exit N)" with a raw stack. classifyFailure() reads the run's stderr/stdout and names the
// cause in one line, says what to do, and marks transient provider errors, which get ONE automatic retry.
// Patterns come from real session logs (2026-10-12..22): 402 balance, socket closed, Refusal (cyber), ENOSPC.

export type FailKind = "refusal" | "credit" | "usage-limit" | "auth" | "disk-full" | "session-busy" | "provider" | "start" | "unknown";

export interface FailCause {
  kind: FailKind;
  /** One plain line for the owner (no raw output). */
  line: string;
  /** A retry later can work without a change (provider hiccup, busy session). */
  transient: boolean;
}

const RULES: { kind: FailKind; re: RegExp; line: string; transient: boolean }[] = [
  // Order matters: a 402/429 for credit or plan limits must not count as a transient provider error.
  { kind: "refusal", re: /Refusal \(|stop_reason"?:\s*"?refusal|Usage Policy/i, line: "🚫 **The model refused this request** (provider safety check). A retry sends the same text, so it will likely be refused again; rephrase it or start a fresh session.", transient: false },
  { kind: "credit", re: /(^|\n)\s*(error:?\s*)?402\b|insufficient (funds|usd|balance|credit)|add credit|credit balance/i, line: "💳 **The model provider has no credit left** for this model. Add credit or pick another model with /models.", transient: false },
  { kind: "usage-limit", re: /usage limit|plan limit|quota exceeded|limit reached|resets at/i, line: "⏳ **The Claude plan limit is reached.** Wait for the reset (or redeem a banked reset), then tap 🔁 Retry.", transient: false },
  { kind: "auth", re: /(^|\n)\s*(error:?\s*)?401\b|unauthori[sz]ed|invalid[ _-]?(api[ _-]?key|token|grant)|authentication_error|not logged in|login required/i, line: "🔐 **The model provider rejected the sign-in.** The login needs a check on the main host before a retry can work.", transient: false },
  { kind: "disk-full", re: /ENOSPC|no space left on device|disk (is )?full|Disk quota exceeded/i, line: "💽 **The main host's disk is full**, so the run could not write its files. Free space first, then tap 🔁 Retry.", transient: false },
  { kind: "session-busy", re: /SQLITE_BUSY|database is locked|session (is )?(busy|locked|in use)|EBUSY|lock(ed)? by another/i, line: "🔒 **The session was busy** (another process held it). Tap 🔁 Retry.", transient: true },
  {
    kind: "provider",
    re: /(^|\n)\s*(error:?\s*)?(429|50[0-4]|52[0249])\b|(status|http|code)[ :=]*(429|50[0-4]|52[0249])\b|overloaded|rate[ _-]?limit|too many requests|socket (connection )?(was )?closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network error|deadline exceeded|internal server error|service unavailable|bad gateway|api_error/i,
    line: "🌐 **The model provider had a temporary error.**",
    transient: true,
  },
  { kind: "start", re: /spawn error|spawn \S+ (ENOENT|EACCES)/i, line: "🧩 **The agent could not start** on the main host.", transient: false },
];

export function classifyFailure(output: string, code: number | null | undefined): FailCause {
  for (const r of RULES) if (r.re.test(output)) return { kind: r.kind, line: r.line, transient: r.transient };
  return { kind: "unknown", line: `❓ **The run failed** (exit ${code ?? "n/a"}); the cause is not known. The last output is below.`, transient: false };
}

/**
 * Only quick failures with NO tool call retry by themselves: a run that called a tool may already have changed
 * files, cards or sent messages, and a retry would do that again. Unknown tool count (undefined) = no retry.
 */
export const AUTO_RETRY_MAX_MS = 2 * 60_000;
export const AUTO_RETRY_DELAY_MS = 20_000;

export function shouldAutoRetry(c: FailCause, durationMs: number, alreadyRetried: boolean, toolCalls: number | undefined): boolean {
  return c.transient && !alreadyRetried && durationMs < AUTO_RETRY_MAX_MS && toolCalls === 0;
}

/** Message ids that already had their one automatic retry (bounded: oldest entries drop first). */
export class RetryLedger {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 500) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  add(id: string, now = Date.now()): void {
    this.seen.set(id, now);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
  }
}

/** The failure message: cause line, then the last output, short, in a code block (already redacted by the caller). */
export function failureText(c: FailCause, detail: string, autoRetryInSec?: number): string {
  const tail = detail.trim().slice(-400).replace(/```/g, "ˋˋˋ");
  const retry = autoRetryInSec ? ` 🔁 Retrying once by itself in ${autoRetryInSec} s.` : c.kind === "refusal" ? "" : " Tap 🔁 Retry to run the same message again.";
  return `❌ **Run failed.** ${c.line}${retry}${tail ? `\n-# Last output:\n\`\`\`\n${tail}\n\`\`\`` : ""}`;
}
