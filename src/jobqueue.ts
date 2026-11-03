// Card discord-queue-for-job (owner pick 2026-11-03): an owner message in a job channel whose pane has a
// live omp is queued instead of refused. The queue is per pane and kept in a state file, so it survives a
// bot restart. The mirror sync loop calls tick(): when the pane's omp is idle (herdr agent idle, finished
// session turn, pane not focused, input box empty) all queued messages go to that pane as ONE prompt, in
// order (`herdr agent prompt`, this pane only). When the job ends before delivery, each message starts
// the normal run instead.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentState, editorEmpty, sessionIdle } from "./firstmate.ts";
import { paneFacts } from "./quickreply.ts";

export const QUEUED_NOTE = "📨 Queued for the job: it gets this after its current step.";
export const DELIVERED_NOTE = "✅ Delivered to the job";
export const QUEUE_LABEL = "[Queued from Discord by the owner while you worked; read in order]";

export type QueuedItem = { messageId: string; channelId: string; noteId: string | null; url: string; text: string; at: number };
export type PaneQueue = { paneId: string; channelId: string; items: QueuedItem[]; delivered?: { noteIds: string[]; afterId: string; sessionFile: string; size: number; at: number } };

type Herdr = (args: string[]) => Promise<{ code: number; out: string }>;

export interface JobQueueDeps {
  file: string;
  herdr: Herdr;
  readTail: (file: string) => string | null;
  fileSize: (file: string) => number;
  /** Still a live job pane for this channel (Mirror.decide() → "busy")? Throws when unsure (no fallback run then). */
  jobLive: (channelId: string) => Promise<boolean>;
  editNote: (channelId: string, noteId: string, content: string) => Promise<void>;
  /** Newest message in the channel after afterId (the job's reply), as a URL. */
  latestAfter: (channelId: string, afterId: string) => Promise<string | null>;
  /** Job ended before delivery: run the message the normal way. */
  runNormally: (item: QueuedItem) => Promise<void>;
  log?: (...a: unknown[]) => void;
  now?: () => number;
}

/** One prompt for several queued messages, oldest first. */
export function queuedPrompt(items: QueuedItem[]): string {
  return [QUEUE_LABEL, ...items.map((it, i) => `--- Message ${i + 1} of ${items.length} (${it.url}) ---\n${it.text}`)].join("\n\n");
}

export class PaneJobQueue {
  readonly queues = new Map<string, PaneQueue>();
  #ticking = false;
  readonly #log: (...a: unknown[]) => void;
  readonly #now: () => number;

  constructor(private readonly d: JobQueueDeps) {
    this.#log = d.log ?? (() => {});
    this.#now = d.now ?? Date.now;
    try {
      if (existsSync(d.file)) for (const q of JSON.parse(readFileSync(d.file, "utf8")) as PaneQueue[]) this.queues.set(q.paneId, q);
    } catch (e) {
      this.#log(`jobqueue: state unreadable: ${(e as Error).message}`);
    }
  }

  #save(): void {
    mkdirSync(dirname(this.d.file), { recursive: true });
    const tmp = `${this.d.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.queues.values()], null, 1), { mode: 0o600 });
    renameSync(tmp, this.d.file);
  }

  add(paneId: string, item: Omit<QueuedItem, "at">): void {
    const q = this.queues.get(paneId) ?? { paneId, channelId: item.channelId, items: [] };
    if (q.items.some((x) => x.messageId === item.messageId)) return;
    q.items.push({ ...item, at: this.#now() });
    this.queues.set(paneId, q);
    this.#save();
  }

  /** Idle check for one pane. Returns the session file when it is safe to send. */
  async #idle(paneId: string): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
    const st = agentState((await this.d.herdr(["agent", "get", paneId])).out, paneId);
    if (!st.ok) return st;
    const pf = paneFacts((await this.d.herdr(["pane", "list"])).out, paneId, st.sessionFile);
    if (!pf.ok) return pf;
    if (pf.focused) return { ok: false, reason: "the pane is focused (the owner may type there)" };
    const tail = this.d.readTail(st.sessionFile);
    if (tail === null) return { ok: false, reason: "session unreadable" };
    const idle = sessionIdle(tail);
    if (!idle.ok) return idle;
    const screen = await this.d.herdr(["agent", "read", paneId, "--source", "visible", "--lines", "6"]);
    if (screen.code !== 0) return { ok: false, reason: "input box unreadable" };
    const ed = editorEmpty(screen.out);
    return ed.ok ? { ok: true, sessionFile: st.sessionFile } : ed;
  }

  /** Called by the mirror sync loop. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const q of [...this.queues.values()]) await this.#tickOne(q).catch((e) => this.#log(`jobqueue ${q.paneId}: ${(e as Error).message}`));
    } finally {
      this.#ticking = false;
    }
  }

  async #tickOne(q: PaneQueue): Promise<void> {
    // After delivery: once the job finished that turn, link its reply in the notes.
    if (q.delivered) {
      const dl = q.delivered;
      const grown = this.d.fileSize(dl.sessionFile) > dl.size;
      const done = grown && (await this.#idle(q.paneId)).ok;
      const stale = this.#now() - dl.at > 6 * 3600_000;
      if (done || stale || !(await this.d.jobLive(q.channelId))) {
        const url = done ? await this.d.latestAfter(q.channelId, dl.afterId) : null;
        for (const n of dl.noteIds) await this.d.editNote(q.channelId, n, url ? `${DELIVERED_NOTE}: [reply](${url})` : DELIVERED_NOTE).catch(() => {});
        delete q.delivered;
      }
    }
    if (!q.items.length) {
      if (!q.delivered) this.queues.delete(q.paneId);
      this.#save();
      return;
    }
    if (!(await this.d.jobLive(q.channelId))) {
      const items = q.items.splice(0);
      this.#save();
      this.#log(`jobqueue ${q.paneId}: job ended; ${items.length} message(s) run normally`);
      for (const it of items) {
        if (it.noteId) await this.d.editNote(it.channelId, it.noteId, "▶️ The job ended before delivery: running your message now.").catch(() => {});
        await this.d.runNormally(it).catch((e) => this.#log(`jobqueue run: ${(e as Error).message}`));
      }
      // add() may have queued new items during the awaits above.
      if (!q.delivered && !q.items.length && this.queues.get(q.paneId) === q) this.queues.delete(q.paneId);
      this.#save();
      return;
    }
    if (q.delivered) return; // the job has not answered the previous delivery yet
    const idle = await this.#idle(q.paneId);
    if (!idle.ok) return;
    const items = q.items.slice();
    const size = this.d.fileSize(idle.sessionFile);
    const r = await this.d.herdr(["agent", "prompt", q.paneId, queuedPrompt(items)]);
    if (r.code !== 0) return void this.#log(`jobqueue ${q.paneId}: herdr agent prompt failed`);
    q.items.splice(0, items.length);
    const noteIds = items.map((x) => x.noteId).filter((x): x is string => Boolean(x));
    q.delivered = { noteIds, afterId: noteIds.at(-1) ?? items.at(-1)!.messageId, sessionFile: idle.sessionFile, size, at: this.#now() };
    this.#save();
    this.#log(`jobqueue ${q.paneId}: delivered ${items.length} message(s)`);
    for (const n of noteIds) await this.d.editNote(q.channelId, n, `${DELIVERED_NOTE} (waiting for its reply)`).catch(() => {});
  }
}
