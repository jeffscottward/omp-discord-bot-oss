export interface Job<R> {
  id: number;
  /** Session key (thread id / dm key). Jobs with the same key never run concurrently. */
  key: string;
  label: string;
  /** First words of the owner's message, for the queue stack display. */
  preview?: string;
  /** Optional group with its own cap (JobQueue `groupLimits`), e.g. "stack" for FIRSTMATE router stacks. */
  group?: string;
  run: () => Promise<R>;
  onStart?: () => void | Promise<void>;
  onDone: (result: R | undefined, error?: unknown) => void | Promise<void>;
  enqueuedAt: number;
  startedAt?: number;
}

export interface JobView {
  id: number;
  key: string;
  label: string;
  preview?: string;
  since: number;
}

/**
 * FIFO queue: at most `max` concurrent jobs, at most one per key.
 * Drain (plan P1): while a drain is active, no new job starts. Running jobs continue; queued jobs wait.
 * A drain has an end time, so a lost restart waiter cannot stop the queue for ever; kick() starts the
 * waiting jobs again after the drain ends.
 */
export class JobQueue<R> {
  private nextId: number;
  private readonly pending: Job<R>[] = [];
  private readonly running = new Map<number, Job<R>>();
  /** Jobs whose run ended but whose reply (text, audio) is still being posted. */
  private finishing = 0;
  private drainUntil = 0;
  private drainSince = 0;
  /** Called after the waiting list changes (enqueue, cancel, start), e.g. to save it to disk. */
  onChange?: () => void;
  /** Called when a started job's run ended (before onDone), e.g. for the 📋 Master queue's finished rows. */
  onSettled?: (job: JobView, result: R | undefined, error: unknown) => void;
  private readonly now: () => number;
  /** Max running jobs per group (jobs without a group, or with an unlisted group, only count against `max`). */
  groupLimits: Record<string, number>;

  constructor(
    private readonly max: number,
    opts: { startId?: number; now?: () => number; groupLimits?: Record<string, number> } = {},
  ) {
    this.nextId = Math.max(1, Math.floor(opts.startId ?? 1));
    this.now = opts.now ?? Date.now;
    this.groupLimits = opts.groupLimits ?? {};
  }

  /** The id the next job gets (persisted so ids are not used again after a restart). */
  peekNextId(): number {
    return this.nextId;
  }

  /** Start or extend a drain for `ttlMs`. ttlMs <= 0 ends the drain at once. */
  drain(ttlMs: number): { draining: boolean; since: number; until: number } {
    const now = this.now();
    if (ttlMs <= 0) {
      this.drainUntil = 0;
      this.drainSince = 0;
      this.pump();
    } else {
      if (!this.draining()) this.drainSince = now;
      this.drainUntil = now + ttlMs;
    }
    return { draining: this.draining(), since: this.drainSince, until: this.drainUntil };
  }

  draining(): boolean {
    return this.drainUntil > this.now();
  }

  drainInfo(): { draining: boolean; since: number; until: number } {
    const on = this.draining();
    return { draining: on, since: on ? this.drainSince : 0, until: on ? this.drainUntil : 0 };
  }

  /** Start waiting jobs if possible (call from a timer: a drain can end without an event). */
  kick(): void {
    this.pump();
  }

  enqueue(spec: Omit<Job<R>, "id" | "enqueuedAt">): { id: number; position: number } {
    const job: Job<R> = { ...spec, id: this.nextId++, enqueuedAt: this.now() };
    this.pending.push(job);
    this.pump();
    this.onChange?.();
    const idx = this.pending.indexOf(job);
    return { id: job.id, position: idx === -1 ? 0 : idx + 1 };
  }

  /** Remove a job that has not started yet. True if it was waiting. */
  cancel(id: number): boolean {
    const i = this.pending.findIndex((j) => j.id === id);
    if (i === -1) return false;
    this.pending.splice(i, 1);
    this.onChange?.();
    return true;
  }

  status(): { running: JobView[]; queued: JobView[]; max: number; finishing: number } {
    return {
      max: this.max,
      finishing: this.finishing,
      running: [...this.running.values()].map((j) => ({ id: j.id, key: j.key, label: j.label, preview: j.preview, since: j.startedAt! })),
      queued: this.pending.map((j) => ({ id: j.id, key: j.key, label: j.label, preview: j.preview, since: j.enqueuedAt })),
    };
  }

  private pump(): void {
    if (this.draining()) return;
    let started = false;
    while (this.running.size < this.max) {
      const busy = new Set([...this.running.values()].map((j) => j.key));
      const inGroup = new Map<string, number>();
      for (const j of this.running.values()) if (j.group) inGroup.set(j.group, (inGroup.get(j.group) ?? 0) + 1);
      const full = (g?: string) => g !== undefined && this.groupLimits[g] !== undefined && (inGroup.get(g) ?? 0) >= this.groupLimits[g]!;
      const idx = this.pending.findIndex((j) => !busy.has(j.key) && !full(j.group));
      if (idx === -1) break;
      const [job] = this.pending.splice(idx, 1);
      this.start(job!);
      started = true;
    }
    if (started) this.onChange?.();
  }

  private start(job: Job<R>): void {
    job.startedAt = this.now();
    this.running.set(job.id, job);
    void (async () => {
      let result: R | undefined;
      let error: unknown;
      // Let enqueue() return first: callers' onStart/onDone use the id it returns
      // (a job that starts at once would otherwise read it before it exists).
      await Promise.resolve();
      try {
        await job.onStart?.();
        result = await job.run();
      } catch (e) {
        error = e;
      }
      this.running.delete(job.id);
      try {
        this.onSettled?.({ id: job.id, key: job.key, label: job.label, preview: job.preview, since: job.startedAt! }, result, error);
      } catch (e) {
        console.error(`job ${job.id} onSettled failed: ${(e as Error).message}`);
      }
      this.pump();
      this.finishing++;
      try {
        await job.onDone(result, error);
      } catch (e) {
        console.error(`job ${job.id} onDone failed: ${(e as Error).message}`);
      } finally {
        this.finishing--;
      }
    })();
  }
}

/** Board/master-queue preview of a job: its first 6 words (max 60 chars), or "attachment" for a message without text. */
export function jobPreview(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const words = t ? t.split(" ") : [];
  return words.length ? `${words.slice(0, 6).join(" ").slice(0, 60)}${words.length > 6 ? "…" : ""}` : "attachment";
}
