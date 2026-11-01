/**
 * Plan P1: the job queue survives a bot restart. Each waiting job is saved as the Discord message that
 * asked for it (channel id + message id) plus the text to run. At start the bridge fetches each message
 * again and queues it in the same order. File: <state dir>/queue.json, mode 0600, atomic write (tmp + rename).
 * Running jobs are not saved, except a running voice-call turn (card voicecall-drop): it runs again after a restart.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  /** Card voicecall-drop: the voice turn was RUNNING (not waiting) when the state was saved. */
  running?: boolean;
  /** How many restarts this running voice turn has already been run again after. */
  restarts?: number;
}

/**
 * Card voicecall-drop: a running voice turn is run again after ONE restart. If it was already re-run once
 * (the turn itself may restart the bot), it is dropped with a text note, so a restart loop cannot happen.
 * Returns the restart count for the new run, or "drop".
 */
export function voiceRestoreDecision(j: Pick<SavedJob, "running" | "restarts">): number | "drop" {
  if (!j.running) return j.restarts ?? 0;
  const n = (j.restarts ?? 0) + 1;
  return n > 1 ? "drop" : n;
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
