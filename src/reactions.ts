// Owner 2026-10-23 (Discord UX item 9): 3,079 rate-limited reaction calls in 10 days. Every job did
// ⏳ add → ⏳ remove + ⚙️ add within milliseconds, and each queue move re-did the 1️⃣ 2️⃣ … badges.
// One status reaction per message now: changes settle for a short time and only the last state is sent,
// so a job that starts at once costs one PUT for ⚙️ and two calls for ✅/❌.

export type ReactionApply<M> = (msg: M, emoji: string, on: boolean) => Promise<void>;

interface Slot<M> {
  msg: M;
  current: string | null;
  desired: string | null;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  waiters: (() => void)[];
}

export class StatusReactions<M extends { id: string }> {
  private slots = new Map<string, Slot<M>>();
  /** Reaction API calls made (for tests and logs). */
  calls = 0;

  /** `final`: states after which a message is forgotten once applied (✅, ❌). */
  constructor(
    private apply: ReactionApply<M>,
    private settleMs = 1_500,
    private final: ReadonlySet<string> = new Set(),
  ) {}

  /** Record a reaction the message already carries (e.g. ⏳ from before a restart), so set() replaces it. */
  assume(msg: M, emoji: string): void {
    if (!this.slots.has(msg.id)) this.slots.set(msg.id, { msg, current: emoji, desired: emoji, timer: null, running: null, waiters: [] });
  }

  /** Set the one status reaction of `msg` (null removes it). Resolves when that state (or a later one) is applied. */
  set(msg: M, emoji: string | null): Promise<void> {
    let s = this.slots.get(msg.id);
    if (!s) {
      if (emoji === null) return Promise.resolve();
      s = { msg, current: null, desired: null, timer: null, running: null, waiters: [] };
      this.slots.set(msg.id, s);
    }
    s.desired = emoji;
    const { promise, resolve } = Promise.withResolvers<void>();
    s.waiters.push(resolve);
    // Final states (✅/❌) and removals apply at once: a restart right after a run ends must not leave ⚙️.
    const now = emoji === null || this.final.has(emoji);
    if (now && s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (!s.timer && !s.running) {
      if (now) this.flush(s);
      else s.timer = setTimeout(() => this.flush(s!), this.settleMs);
    }
    return promise;
  }

  private flush(s: Slot<M>): void {
    s.timer = null;
    s.running = (async () => {
      while (s.current !== s.desired) {
        const want = s.desired;
        if (s.current !== null) {
          this.calls++;
          await this.apply(s.msg, s.current, false).catch(() => {}); // apply logs its own errors; never loop on one
          s.current = null;
        }
        if (want !== null && s.desired === want) {
          this.calls++;
          await this.apply(s.msg, want, true).catch(() => {});
          s.current = want;
        }
      }
    })().finally(() => {
      s.running = null;
      for (const w of s.waiters.splice(0)) w();
      if (s.current === s.desired && (s.current === null || this.final.has(s.current))) this.slots.delete(s.msg.id);
      else if (s.current !== s.desired) s.timer = setTimeout(() => this.flush(s), 0);
    });
  }
}
