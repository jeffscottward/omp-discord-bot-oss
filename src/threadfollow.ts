/**
 * Card stack-thread-follow (owner 2026-11-04): "If there's an active job, there should be an active thread."
 * Discord's sidebar shows only threads the owner has joined. On each 📋 Master queue refresh the bot adds the owner
 * to every stack thread with a running/queued job, and removes the owner from a stack thread after 30 min with no
 * such job. The thread and its messages stay. Adding a member posts no message and pings nobody.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const IDLE_LEAVE_MS = 30 * 60_000;

export type FollowState = {
  /** stack -> owner is a member (as last set or observed by us). */
  member: Record<string, boolean>;
  /** stack -> last time (ms) a running/queued job was seen. */
  lastActive: Record<string, number>;
  /** stack -> thread id that `member` refers to (a recreated thread resets membership). */
  thread?: Record<string, string>;
};
/** After a failed join, wait this long before the next try (no API call on every refresh). */
export const JOIN_RETRY_MS = 30 * 60_000;

export type FollowPlan = { add: string[]; remove: string[] };

/**
 * Pure decision. `active`: stacks with a running/queued job now. `known`: stacks that have a thread.
 * Add: active and not a member. Remove: a member, not active, and idle for IDLE_LEAVE_MS (or never seen active).
 */
/**
 * Discord posts a system line (type 1 add / type 2 remove) for every member change and has no silent add.
 * Leaving is OFF until the owner decides (card stack-thread-follow): each stack thread gets at most one add line.
 */
export const LEAVE_ENABLED = false;

export function planFollow(active: Set<string>, known: Set<string>, st: FollowState, now: number, leave = LEAVE_ENABLED): FollowPlan {
  const add: string[] = [];
  const remove: string[] = [];
  for (const s of [...known].sort()) {
    // Owner 2026-11-07 ("Either keep me or don't"): keep the owner in EVERY stack thread, active or not, and never
    // remove (LEAVE_ENABLED=false). Each thread gets at most one add, ever; no more add/remove system lines.
    if (!st.member[s] && (active.has(s) || !leave)) {
      add.push(s);
    } else if (!active.has(s) && leave && st.member[s] !== false) {
      // Unknown membership (undefined) counts as "maybe a member": one DELETE settles it.
      const last = st.lastActive[s];
      if (last === undefined || now - last >= IDLE_LEAVE_MS) remove.push(s);
    }
  }
  return { add, remove };
}

export type FollowApi = {
  /** Unarchive the thread if needed, then PUT thread-members/<owner>. */
  /** `active`: the stack has work. An idle thread is joined only if it is open (never unarchived for a join). Return false = deferred. */
  join: (threadId: string, active: boolean) => Promise<boolean | void>;
  /** DELETE thread-members/<owner>. */
  leave: (threadId: string) => Promise<void>;
};

/** Saved state survives bot restarts, so a restart does not reset the 30-min idle timer. */
export function loadFollow(file: string | undefined): FollowState {
  try {
    if (file && existsSync(file)) {
      const d = JSON.parse(readFileSync(file, "utf8")) as Partial<FollowState>;
      return { member: d.member && typeof d.member === "object" ? d.member : {}, lastActive: d.lastActive && typeof d.lastActive === "object" ? d.lastActive : {}, thread: d.thread && typeof d.thread === "object" ? d.thread : {} };
    }
  } catch {}
  return { member: {}, lastActive: {} };
}

export class ThreadFollow {
  readonly st: FollowState;
  private busy = false;
  private readonly retryAt = new Map<string, number>();
  private readonly deferAt = new Map<string, number>();
  private saved = "";
  constructor(private api: FollowApi, private log: (s: string) => void = () => {}, private file?: string) {
    this.st = loadFollow(file);
    this.saved = JSON.stringify(this.st);
  }
  private save(): void {
    const t = JSON.stringify(this.st);
    if (!this.file || t === this.saved) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, t);
      renameSync(`${this.file}.tmp`, this.file);
      this.saved = t;
    } catch (e) {
      this.log(`thread follow save: ${(e as Error).message}`);
    }
  }

  /** Apply one tick. `threads`: stack -> thread id. At most one API call per stack per change (cached). */
  async tick(active: Set<string>, threads: Record<string, string>, now: number): Promise<FollowPlan> {
    for (const s of active) this.st.lastActive[s] = now;
    if (this.busy) return { add: [], remove: [] };
    this.busy = true;
    try {
      const known = new Set(Object.keys(threads).filter((s) => threads[s]));
      // After a restart, an idle stack waits IDLE_LEAVE_MS from first sight before the owner leaves it.
      for (const s of known) this.st.lastActive[s] ??= now;
      this.st.thread ??= {};
      for (const s of known) if (this.st.thread[s] !== threads[s]) { delete this.st.member[s]; this.st.thread[s] = threads[s]!; }
      const plan = planFollow(active, known, this.st, now);
      for (const s of plan.add) {
        if ((this.retryAt.get(s) ?? 0) > now) continue;
        if (!active.has(s) && (this.deferAt.get(s) ?? 0) > now) continue;
        try {
          const ok = await this.api.join(threads[s]!, active.has(s));
          if (ok !== false) this.st.member[s] = true; // false: archived idle thread, added when the stack next has work
          else if (!active.has(s)) this.deferAt.set(s, now + JOIN_RETRY_MS); // do not re-fetch it every tick
        } catch (e) {
          this.retryAt.set(s, now + JOIN_RETRY_MS);
          this.log(`thread follow join ${s}: ${(e as Error).message}`);
        }
      }
      for (const s of plan.remove) {
        try {
          await this.api.leave(threads[s]!);
        } catch (e) {
          this.log(`thread follow leave ${s}: ${(e as Error).message}`);
        }
        this.st.member[s] = false; // also after an error (e.g. thread gone): do not retry each tick
      }
      return plan;
    } finally {
      this.save();
      this.busy = false;
    }
  }
}

/** Stacks with a running/queued row on the board. */
export function activeStacks(rows: { stack?: string; state: string }[]): Set<string> {
  return new Set(rows.filter((r) => r.stack && (r.state === "running" || r.state === "queued")).map((r) => r.stack!));
}
