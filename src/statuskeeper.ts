/**
 * Card job-status-last (owner 2026-11-04): the pane status card is always the last message in its job channel,
 * like the master queue board. After other messages land, the card moves to the bottom (delete + silent repost)
 * once the channel is quiet (same debounce as the master queue: src/masterqueue.ts moveDelay), so a burst causes
 * ONE move. Status-card edits never trigger a move. Stray older status cards of the bot are deleted on each move.
 */
import { moveDelay } from "./masterqueue.ts";

/** True for the text of a pane status card (src/mirror.ts renderProgress). */
export function isStatusCard(text: string): boolean {
  return /^(⚙️|✅|⏹️) \*\*[^\n]+?\*\* · (working|turn finished|turn stopped)/.test(text);
}

export interface KeeperOpts {
  /** Move the card of the channel to the bottom (the caller checks whether it is already last). */
  move: (channelId: string) => Promise<void>;
  log: (s: string) => void;
  now?: () => number;
}

export class StatusKeeper {
  private timers = new Map<string, NodeJS.Timeout>();
  private bursts = new Map<string, number>();
  private chains = new Map<string, Promise<void>>();
  constructor(private o: KeeperOpts) {}

  /** A message landed in a mirrored channel. `own`: sent by the bot. */
  onMessage(channelId: string, content: string, own: boolean): void {
    if (own && isStatusCard(content)) return;
    const now = (this.o.now ?? Date.now)();
    if (!this.bursts.has(channelId)) this.bursts.set(channelId, now);
    clearTimeout(this.timers.get(channelId));
    this.timers.set(
      channelId,
      setTimeout(() => {
        this.timers.delete(channelId);
        this.bursts.delete(channelId);
        void this.lock(channelId, () => this.o.move(channelId)).catch((e) => this.o.log(`status move ${channelId}: ${(e as Error).message}`));
      }, moveDelay(this.bursts.get(channelId) ?? now, now)),
    );
  }
  /** Move without the debounce (caller holds the lock). */
  moveNow(channelId: string): Promise<void> {
    return this.o.move(channelId);
  }
  /** Run `fn` after every earlier move/status write of the channel (status edits and moves never overlap). */
  lock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(channelId) ?? Promise.resolve()).then(fn);
    this.chains.set(channelId, run.then(() => undefined, () => undefined));
    return run;
  }
  idle(channelId: string): Promise<void> {
    return this.chains.get(channelId) ?? Promise.resolve();
  }
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** The Discord message/channel parts moveCard uses (a test seam). */
export interface CardMsg {
  id: string;
  content: string;
  author: { id: string };
  components: { toJSON(): unknown }[];
  delete(): Promise<unknown>;
}
export interface CardChannel {
  messages: { fetch(q: { limit: number }): Promise<Map<string, CardMsg>>; fetch(id: string): Promise<CardMsg> };
  send(o: object): Promise<unknown>;
}

/**
 * Put the card `cur` last: delete stray bot status cards in the last 50 messages, then repost the card at the
 * bottom (silent, same buttons) unless it is already last. The card itself is found even when older than 50
 * messages. Returns the new card id, or undefined when nothing moved.
 */
export async function moveCard(ch: CardChannel, me: string | undefined, cur: string | undefined, own: (m: unknown) => CardMsg, quiet: object): Promise<string | undefined> {
  if (!cur) return undefined;
  const recent = [...(await ch.messages.fetch({ limit: 50 })).values()].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  for (const m of recent) if (m.author.id === me && m.id !== cur && isStatusCard(m.content)) await m.delete().catch(() => undefined);
  const card = recent.find((m) => m.id === cur) ?? (await ch.messages.fetch(cur).catch(() => null));
  if (!card || recent[0]?.id === card.id) return undefined;
  const copy = own(await ch.send({ content: card.content, components: card.components.map((c) => c.toJSON()), ...quiet }));
  await card.delete().catch(() => undefined);
  return copy.id;
}
