// Failed runs in plain words (owner pick 2026-10-23, UX review item 7). The bridge used to post only
// "OMP run failed (exit N)" with a raw stack. classifyFailure() reads the run's stderr/stdout and names the
// cause in one line, says what to do, and marks transient provider errors, which retry by themselves (two tries, card heal-failed-finished).
// Patterns come from real session logs (2026-10-12..22): 402 balance, socket closed, Refusal (cyber), ENOSPC.

export type FailKind = "refusal" | "credit" | "usage-limit" | "auth" | "disk-full" | "session-busy" | "rate-limit" | "provider" | "start" | "unknown";

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
  { kind: "usage-limit", re: /usage limit|plan limit|quota exceeded|limit reached|resets at/i, line: "⏳ **The Claude plan limit is reached.** Wait for the reset (or redeem a banked reset) first.", transient: false },
  { kind: "auth", re: /(^|\n)\s*(error:?\s*)?401\b|unauthori[sz]ed|invalid[ _-]?(api[ _-]?key|token|grant)|authentication_error|not logged in|login required/i, line: "🔐 **The model provider rejected the sign-in.** The login needs a check on the main host before a retry can work.", transient: false },
  { kind: "disk-full", re: /ENOSPC|no space left on device|disk (is )?full|Disk quota exceeded/i, line: "💽 **The main host's disk is full**, so the run could not write its files. Free space first.", transient: false },
  { kind: "session-busy", re: /SQLITE_BUSY|database is locked|session (is )?(busy|locked|in use)|EBUSY|lock(ed)? by another/i, line: "🔒 **The session was busy** (another process held it).", transient: true },
  // Owner 2026-10-30: rate errors (429, rate limit, overloaded) retry by themselves after a cool-down.
  {
    kind: "rate-limit",
    re: /(^|\n)\s*(error:?\s*)?(429|529)\b|(status|http|code)[ :=]*(429|529)\b|rate[ _-]?limit|too many requests|overloaded/i,
    line: "🚦 **The model provider rate-limited the run.**",
    transient: true,
  },
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
 * Until 2026-11-07 only quick failures with no tool call retried, once; see HEAL_RETRY_DELAYS_MS for today's rule.
 * Owner 2026-10-30: a rate error ALWAYS retries by itself after a growing cool-down (RATE_RETRY_DELAYS_MS),
 * also after tool calls: the retry resumes the same session, so the model sees its earlier tool results.
 */
export const AUTO_RETRY_DELAY_MS = 20_000;
export const RATE_RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000];

/**
 * Owner 2026-11-07 (card heal-failed-finished): always heal, fix and retry, so no failed job sits idle in Finished.
 * Transient and unknown failures retry by themselves at most HEAL_RETRY_DELAYS_MS.length (2) times per message, also
 * after tool calls (the retry then sends a "continue" text, see main.ts). Causes that need an owner fix first
 * (refusal, credit, plan limit, sign-in, disk full, start) do not retry: the failure text names the fix.
 */
export const HEAL_RETRY_DELAYS_MS = [AUTO_RETRY_DELAY_MS, 2 * 60_000];

/** Cool-down (ms) before the next automatic retry, or undefined for no automatic retry. */
export function autoRetryDelay(c: FailCause, _durationMs: number, retries: number, _toolCalls: number | undefined): number | undefined {
  if (c.kind === "rate-limit") return RATE_RETRY_DELAYS_MS[retries];
  if (!c.transient && c.kind !== "unknown") return undefined;
  return HEAL_RETRY_DELAYS_MS[retries];
}

export function shouldAutoRetry(c: FailCause, durationMs: number, alreadyRetried: boolean, toolCalls: number | undefined): boolean {
  return autoRetryDelay(c, durationMs, alreadyRetried ? 1 : 0, toolCalls) !== undefined;
}

/** Automatic retries per message id (bounded: oldest entries drop first). */
export class RetryLedger {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 500) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  count(id: string): number {
    return this.seen.get(id) ?? 0;
  }
  add(id: string): void {
    const n = this.count(id) + 1;
    this.seen.delete(id);
    this.seen.set(id, n);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
  }
}

/** "1 min", "90 s": short cool-down text. */
export function coolText(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/** The failure message: cause line, then the last output, short, in a code block (already redacted by the caller). */
export function failureText(c: FailCause, detail: string, autoRetryInMs?: number, attempt = 1): string {
  const tail = detail.trim().slice(-400).replace(/```/g, "ˋˋˋ");
  const retry = autoRetryInMs
    ? ` ⏳ Cooling down: retrying by itself in ${coolText(autoRetryInMs)} (auto-retry ${attempt}). Tap 🔁 Force retry to run it now.`
    : c.kind === "refusal" ? "" : " Tap 🔁 Force retry to run the same message again.";
  return `❌ **Run failed.** ${c.line}${retry}${tail ? `\n-# Last output:\n\`\`\`\n${tail}\n\`\`\`` : ""}`;
}
