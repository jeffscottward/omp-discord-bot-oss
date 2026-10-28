/**
 * Owner ✅ reaction = "I did it" (owner 2026-10-23, card react-done).
 * The owner adds ✅ (also ✔️ / ☑️) to a BOT message, for example with Discord's double-tap quick reaction.
 * The bot then:
 * 1. marks every owner-facing card whose `q` or `src` links that message: `q` removed, partial "✅ Owner marked done HH:MM"
 *    (a partial card leaves the Needs-you board);
 * 2. after 60 s (the cancel window; card writes happen then too), queues ONE owner turn in that channel: "✅ (owner reaction) The step in <link> is done. Continue."
 * One follow-up per message. Removing the reaction within 60 s cancels a follow-up that has not started.
 * Only the owner's reactions count; the bot's own status reactions (⏳ ⚙️ ✅ ❌) are never the owner's.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { FM_BIN, hhmm, ITEMS_FILE, matchCards, parseCards, QUEUED_BY } from "./queued.ts";

const run = promisify(execFile);

const DONE: Record<string, true> = { "✅": true, "✔️": true, "✔": true, "☑️": true, "☑": true };
export const isDoneEmoji = (name: string | null | undefined): boolean => !!name && DONE[name] === true;

export interface ReactionFacts {
  emoji: string | null | undefined;
  reactorId: string;
  ownerId: string;
  messageAuthorId: string | undefined;
  botId: string | undefined;
}

/** True when this reaction is the owner's "done" mark on a bot message. */
export function isOwnerDone(f: ReactionFacts): boolean {
  return isDoneEmoji(f.emoji) && f.reactorId === f.ownerId && !!f.botId && f.messageAuthorId === f.botId;
}

export const doneNote = (ms: number) => `✅ Owner marked done ${hhmm(ms)}`;
export const followUpText = (link: string) => `✅ (owner reaction) The step in ${link} is done. Continue.`;

export interface MarkDoneOptions {
  now?: number;
  file?: string;
  fm?: string;
  log?: (s: string) => void;
}

/** Mark cards linked to `messageId` as done by the owner. Never throws; returns the ids marked. */
export async function markOwnerDone(messageId: string, o: MarkDoneOptions = {}): Promise<string[]> {
  const log = o.log ?? (() => {});
  let ids: string[];
  try {
    ids = matchCards(parseCards(readFileSync(o.file ?? ITEMS_FILE, "utf8")), { messageIds: [messageId], itemIds: [] });
  } catch (e) {
    log(`react-done: cannot read the tracker: ${(e as Error).message}`);
    return [];
  }
  const now = o.now ?? Date.now();
  const { FM_AUTO: _auto, ...base } = process.env;
  const env = { ...base, FM_BY: QUEUED_BY };
  const fm = o.fm ?? FM_BIN;
  const done: string[] = [];
  for (const id of ids) {
    try {
      await run(fm, ["q", id, "-"], { env, timeout: 10_000 });
      await run(fm, ["set", id, "partial", doneNote(now)], { env, timeout: 10_000 });
      done.push(id);
    } catch (e) {
      log(`react-done: fm failed for ${id}: ${String((e as Error).message).slice(0, 200)}`);
    }
  }
  if (done.length) log(`react-done: owner ✅; marked ${done.join(", ")}`);
  return done;
}

/** One follow-up per message; a removal within `cancelMs` cancels a follow-up that has not started. */
export class DoneFollowUps {
  private pending = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  private fired = new Set<string>();
  constructor(
    private start: (messageId: string) => void,
    private graceMs = 60_000,
    private cancelMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Returns false when this message already has a follow-up (debounce). */
  add(messageId: string): boolean {
    if (this.pending.has(messageId) || this.fired.has(messageId)) return false;
    const timer = setTimeout(() => {
      this.pending.delete(messageId);
      this.fired.add(messageId);
      this.start(messageId);
    }, this.graceMs);
    this.pending.set(messageId, { timer, at: this.now() });
    return true;
  }

  /** Owner removed the ✅. Returns true when a not-yet-started follow-up was cancelled. */
  remove(messageId: string): boolean {
    const p = this.pending.get(messageId);
    if (!p || this.now() - p.at > this.cancelMs) return false;
    clearTimeout(p.timer);
    this.pending.delete(messageId);
    return true;
  }
}
