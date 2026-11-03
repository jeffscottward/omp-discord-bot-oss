/**
 * Plan P1: the job queue survives a bot restart. Each owner job is saved as the Discord message that
 * asked for it (channel id + message id) plus the text to run. At start the bridge fetches each message
 * again and queues it in the same order. File: <state dir>/queue.json, mode 0600, atomic write (tmp + rename).
 * Card sma-bot-lost-turns (2026-11-03): RUNNING jobs are saved too (typed turns, ask-answer turns, voice turns),
 * with `running: true`. After a restart a running job runs again ONCE with a visible note; a job whose run
 * already ended is no longer in the file, so it never runs again.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobState } from "./jobstate.ts";

export interface SavedJob {
  /** Job id before the restart (only for logs and order). */
  id: number;
  channelId: string;
  messageId: string;
  authorId: string;
  /** The text the run uses (voice already transcribed). */
  text: string;
  fromVoice?: boolean;
  attachments?: { name: string; url: string }[];
  /** The "⏳ Queued." note with the old Cancel button; deleted after the restart. */
  noteId?: string;
  enqueuedAt: number;
  /** The job was RUNNING (not waiting) when the state was saved. */
  running?: boolean;
  /** How many restarts this job has already been run again after. */
  restarts?: number;
}

export const RERUN_NOTE = "🔁 The bot restarted while this was running. Running it again.";
export const DROP_NOTE = "⚠️ A bot restart cut this off twice, so it was not run again. Please send it again.";

/** What restoreQueue does with one saved job. `note`: posted as a reply to the job's message. */
export type RestorePlan = { action: "queue"; restarts: number; note?: string } | { action: "drop"; note: string };

/**
 * A waiting job is always queued again. A running job is queued again after ONE restart; if it was already
 * re-run once (the turn itself may restart the bot), it is dropped with a note, so a restart loop cannot happen.
 */
export function restorePlan(j: Pick<SavedJob, "running" | "restarts">): RestorePlan {
  if (!j.running) return { action: "queue", restarts: j.restarts ?? 0 };
  const n = (j.restarts ?? 0) + 1;
  return n > 1 ? { action: "drop", note: DROP_NOTE } : { action: "queue", restarts: n, note: RERUN_NOTE };
}

/**
 * The owner jobs to keep across a restart: one record per owner job in the queue. The queue's own job states say
 * which records are waiting and which are running. A record whose run ended stays (as running) until settle(),
 * which the bridge calls after the reply has posted: a restart before that runs the turn again, a restart after
 * that never runs a finished turn again (make-operations-idempotent).
 */
export class SavedQueue {
  private readonly jobs = new Map<number, SavedJob>();
  /** Saved jobs from before the restart that are not queued again yet (they stay in the file until then). */
  private pending: SavedJob[];
  /** Set by freeze(): the state at the bot's stop, returned by every later state() call. */
  private frozen?: QueueState;

  constructor(loaded: SavedJob[]) {
    this.pending = loaded.slice();
  }

  /** Record a job the queue holds (waiting or already running). */
  add(job: SavedJob): void {
    this.jobs.set(job.id, job);
  }

  get(id: number): SavedJob | undefined {
    return this.jobs.get(id);
  }

  /** The job's reply has posted (or it was stopped): forget it. True when it was recorded. */
  settle(id: number): boolean {
    return this.jobs.delete(id);
  }

  /** Saved jobs from before the restart that are still to restore, oldest first. */
  toRestore(): SavedJob[] {
    return this.pending.slice();
  }

  /** One saved job was queued again or dropped: it leaves the file at the next save. */
  restored(j: SavedJob): void {
    this.pending = this.pending.filter((x) => x !== j);
  }

  /**
   * The file content now. `live`: the queue's jobs. A record whose job left the queue: if it ran, its reply is still
   * being posted (kept as running until settle()); if it never ran, it was cancelled (dropped).
   */
  state(nextId: number, live: { id: number; state: JobState }[]): QueueState {
    if (this.frozen) return this.frozen;
    const states = new Map(live.map((j) => [j.id, j.state]));
    const jobs: SavedJob[] = [];
    for (const [id, rec] of this.jobs) {
      const s = states.get(id);
      if (s === "running") rec.running = true;
      if (s === "queued") jobs.push({ ...rec, running: undefined });
      else if (rec.running) jobs.push(rec);
      else this.jobs.delete(id);
    }
    return { nextId, jobs: [...this.pending, ...jobs] };
  }

  /**
   * SIGTERM/SIGINT: keep the state at the stop. systemd also stops the running omp children, so their runs end as
   * failures while the bot shuts down; those ends must not erase the records (they run again after the start).
   */
  freeze(nextId: number, live: { id: number; state: JobState }[]): QueueState {
    this.frozen = this.state(nextId, live);
    return this.frozen;
  }
}

export interface QueueState {
  /** Next job id, so a Cancel button from before the restart never matches a new job. */
  nextId: number;
  jobs: SavedJob[];
}

export const queueFile = (dir: string) => join(dir, "queue.json");

function isJob(x: unknown): x is SavedJob {
  if (!x || typeof x !== "object") return false;
  const j = x as Record<string, unknown>;
  return (
    typeof j.id === "number" &&
    typeof j.channelId === "string" && /^\d+$/.test(j.channelId) &&
    typeof j.messageId === "string" && /^\d+$/.test(j.messageId) &&
    typeof j.authorId === "string" &&
    typeof j.text === "string" &&
    typeof j.enqueuedAt === "number"
  );
}

/** Read the saved queue. A missing or bad file gives an empty queue (never throws). */
export function loadQueueState(dir: string): QueueState {
  try {
    const raw = JSON.parse(readFileSync(queueFile(dir), "utf8")) as { nextId?: unknown; jobs?: unknown };
    const jobs = Array.isArray(raw.jobs) ? raw.jobs.filter(isJob) : [];
    jobs.sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id - b.id);
    const nextId = typeof raw.nextId === "number" && raw.nextId > 0 ? Math.floor(raw.nextId) : 1;
    return { nextId, jobs };
  } catch {
    return { nextId: 1, jobs: [] };
  }
}

/** Write atomically with mode 0600. Returns false (and logs) on failure. */
export function saveQueueState(dir: string, state: QueueState): boolean {
  const file = queueFile(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error(`queue.json save failed: ${(e as Error).message}`);
    return false;
  }
}
