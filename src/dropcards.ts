/**
 * Owner 2026-11-01 (card drop-clears-card): when a secret drop is received or expires, every card whose q is that
 * drop's Discord message leaves the Needs-you board: q and action are removed. Cards that still wait on the owner
 * (waiting/open/blocked) become partial with a note; running/partial/done cards keep their state.
 */
import { messageIdOf, type Card } from "./queued.ts";

export const DROP_RECEIVED_NOTE = "🔐 key received";
export const DROP_EXPIRED_NOTE = "🔐 drop expired; re-ask if still needed";
const OWNER_STATES = new Set(["waiting", "open", "blocked"]);

/** The fm argv lists to run for one drop outcome (pure; order matters: partial first, fm refuses waiting without q). */
export function dropCardCommands(cards: Card[], dropMessageId: string, outcome: "received" | "expired"): string[][] {
  const note = outcome === "received" ? DROP_RECEIVED_NOTE : DROP_EXPIRED_NOTE;
  const out: string[][] = [];
  for (const c of cards) {
    if (!c.id || messageIdOf(c.q) !== dropMessageId) continue;
    if (OWNER_STATES.has(c.s ?? "")) out.push(["set", c.id, "partial", note]);
    out.push(["q", c.id, "-"], ["action", c.id, "-"]);
  }
  return out;
}
