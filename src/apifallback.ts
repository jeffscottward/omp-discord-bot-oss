/**
 * Paid-API fallback notice (owner 2026-11-01). ~/.omp/agent/config.yml routes `anthropic/*` to
 * `openrouter/anthropic/claude-opus-5.5` when the Claude subscription hits a usage limit (retry.fallbackOn: usage-limit).
 * OpenRouter bills per token, so after a run the bridge checks the run's session log; when an assistant message came
 * from OpenRouter Claude, it posts one notice to FIRSTMATE and one ntfy push. At most one notice per 6 hours.
 */
import { tail } from "./cyberreset.ts";
import { claimKey, ownerNtfy } from "./ownerntfy.ts";

export const WINDOW_MS = 6 * 60 * 60_000;

/** True when an assistant message dated at or after `sinceMs` came from OpenRouter's Claude. */
export function usedApiFallback(text: string, sinceMs: number): boolean {
  for (const line of text.split("\n")) {
    if (!line.includes('"openrouter"')) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || !("message" in e) || !("timestamp" in e) || typeof e.timestamp !== "string") continue;
    const m = e.message;
    if (!m || typeof m !== "object" || !("role" in m) || m.role !== "assistant") continue;
    const provider = "provider" in m ? m.provider : undefined;
    const model = "model" in m && typeof m.model === "string" ? m.model : "";
    const at = Date.parse(e.timestamp);
    if (provider === "openrouter" && /claude/i.test(model) && !Number.isNaN(at) && at >= sinceMs) return true;
  }
  return false;
}

export const NOTICE =
  "💳 **Claude subscription limit reached → now on the OpenRouter API (Claude Opus 5.5).** " +
  "Runs continue, but every token is billed to OpenRouter. ⚠️ Watch the cost. OMP returns to the subscription when the limit resets.";

export interface FallbackCheck {
  sessionFile?: string;
  startedAt?: number;
  channelLabel: string;
  post(text: string): Promise<unknown>;
  log(s: string): void;
  now?: number;
  stateFile?: string;
  ntfy?: typeof ownerNtfy;
}

/** Returns true when a notice was sent. Never throws. */
export async function checkApiFallback(c: FallbackCheck): Promise<boolean> {
  try {
    if (!c.sessionFile || !c.startedAt) return false;
    if (!usedApiFallback(tail(c.sessionFile), c.startedAt)) return false;
    const now = c.now ?? Date.now();
    const key = `api-fallback:${Math.floor(now / WINDOW_MS)}`;
    if (!claimKey(key, c.stateFile)) return false;
    c.log(`api-fallback: OpenRouter Claude used in ${c.channelLabel}; notifying`);
    await c.post(`${NOTICE}\n• First seen in: ${c.channelLabel}`).catch((e) => c.log(`api-fallback post: ${(e as Error).message}`));
    (c.ntfy ?? ownerNtfy)(`${key}:ntfy`, "input", "Claude limit reached: OMP is now on the OpenRouter API (Opus 5.5, billed per token). Watch the cost.", undefined, { file: c.stateFile, log: c.log });
    return true;
  } catch (e) {
    c.log(`api-fallback: ${(e as Error).message}`);
    return false;
  }
}
