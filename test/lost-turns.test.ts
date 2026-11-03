// Card sma-bot-lost-turns (state-machine-audit #8): a bot restart must not lose a RUNNING owner turn
// (typed message or ask-answer turn). Running jobs are saved in queue.json with a running marker, restored
// once with a visible note, never twice, and a job whose run already ended is never run again.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endEvent, jobReaction, jobTransition, type JobState } from "../src/jobstate.ts";
import { JobQueue } from "../src/queue.ts";
import { loadQueueState, RERUN_NOTE, restorePlan, saveQueueState, SavedQueue, type SavedJob } from "../src/queuestate.ts";

type R = { ok: boolean; cancelled?: boolean };
/** A run that never ends (the bot restarts while it runs). */
const never = () => Promise.withResolvers<R>().promise;
/** Let the queue's start/settle microtasks run (no timers in the queue). */
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** One bot process: the queue plus the saved-job records, wired as src/main.ts wires them. */
function bridge(dir: string) {
  const loaded = loadQueueState(dir);
  const q = new JobQueue<R>(2, { startId: loaded.nextId });
  const saved = new SavedQueue(loaded.jobs);
  const save = () => saveQueueState(dir, saved.state(q.peekNextId(), [...q.status().running, ...q.status().queued]));
  q.onChange = save;
  /**
   * handle(): enqueue the owner's turn, then record it (it may already be running). `replaces`: the old record of a
   * restored job. onDone settles the record after the reply posted (`reply`, default at once).
   */
  const handle = (rec: Omit<SavedJob, "id" | "enqueuedAt">, run: () => Promise<R>, opts: { reply?: Promise<void>; replaces?: SavedJob } = {}) => {
    const { id } = q.enqueue({
      key: rec.channelId,
      label: rec.text,
      run,
      onDone: async () => {
        await opts.reply;
        if (saved.settle(id)) save();
      },
    });
    if (opts.replaces) saved.restored(opts.replaces);
    saved.add({ ...rec, id, enqueuedAt: Date.now() });
    save();
    return id;
  };
  return { q, saved, handle, save, loaded };
}

const typed = { channelId: "100", messageId: "200", authorId: "1", text: "fix the board" };
// An ask-answer turn runs on the bot's menu message with the bot-written answers text (src/main.ts handleAskButton).
const askAnswer = { channelId: "101", messageId: "300", authorId: "1", text: "Q1: Which fix? → Option A" };

test("a running typed job and a running ask-answer turn survive a restart and run again exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lost-turns-"));
  const a = bridge(dir);
  a.handle(typed, never);
  a.handle(askAnswer, never);
  await tick();
  expect(a.q.status().running.length).toBe(2);
  // Restart 1: both running turns are in queue.json with the running marker.
  const b = bridge(dir);
  const jobs = b.saved.toRestore();
  expect(jobs.map((j) => [j.messageId, j.text, j.running])).toEqual([
    ["200", "fix the board", true],
    ["300", "Q1: Which fix? → Option A", true],
  ]);
  const plans = jobs.map((j) => restorePlan(j));
  expect(plans).toEqual([
    { action: "queue", restarts: 1, note: RERUN_NOTE },
    { action: "queue", restarts: 1, note: RERUN_NOTE },
  ]);
  // Restore: each is queued again once (as main.ts restoreQueue does: the new record replaces the old one in one step).
  for (const [i, j] of jobs.entries()) {
    const p = plans[i]!;
    if (p.action === "queue") b.handle({ channelId: j.channelId, messageId: j.messageId, authorId: j.authorId, text: j.text, restarts: p.restarts }, never, { replaces: j });
    expect(loadQueueState(dir).jobs.length).toBe(2); // never both the old and the new record, never neither
  }
  await tick();
  expect(b.q.status().running.length).toBe(2);
  expect(b.saved.toRestore()).toEqual([]);
  // Restart 2 while the re-run is still running: dropped with a note, never a third run (no restart loop).
  const c = bridge(dir);
  expect(c.saved.toRestore().map((j) => restorePlan(j).action)).toEqual(["drop", "drop"]);
});

test("a stop (SIGTERM) freezes queue.json: a run that ends during the shutdown keeps its running record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lost-turns-"));
  const a = bridge(dir);
  const gate = Promise.withResolvers<R>();
  a.handle(typed, () => gate.promise);
  await tick();
  // main.ts shutdown(): save the state at the stop, then systemd's SIGTERM ends the omp child (a failed run).
  saveQueueState(dir, a.saved.freeze(a.q.peekNextId(), [...a.q.status().running, ...a.q.status().queued]));
  gate.resolve({ ok: false });
  await tick();
  expect(a.q.status().running.length).toBe(0);
  expect(loadQueueState(dir).jobs.map((j) => [j.messageId, j.running])).toEqual([["200", true]]);
});

test("a run that ended while its reply still posts is kept; once the reply posted it is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lost-turns-"));
  const a = bridge(dir);
  const reply = Promise.withResolvers<void>();
  a.handle(typed, async () => ({ ok: true }), { reply: reply.promise });
  a.handle(askAnswer, never); // another job: its saves must not drop the first record while the reply posts
  await tick();
  expect(a.q.status().running.map((j) => j.state)).toEqual(["running"]);
  a.save();
  expect(loadQueueState(dir).jobs.map((j) => [j.messageId, j.running])).toEqual([
    ["200", true],
    ["300", true],
  ]);
  reply.resolve();
  await tick();
  expect(loadQueueState(dir).jobs.map((j) => j.messageId)).toEqual(["300"]);
});

test("a finished job (done, failed or stopped) is not saved and never runs again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lost-turns-"));
  const a = bridge(dir);
  a.handle(typed, async () => ({ ok: true }));
  a.handle(askAnswer, async () => ({ ok: false, cancelled: true }));
  a.handle({ ...typed, messageId: "201", channelId: "102" }, async () => {
    throw new Error("boom");
  });
  await tick();
  await tick();
  expect(a.q.status().running.length).toBe(0);
  expect(loadQueueState(dir).jobs).toEqual([]);
});

test("a waiting job is restored without a note; a cancelled waiting job is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lost-turns-"));
  const a = bridge(dir);
  a.handle(typed, never);
  const waitId = a.handle({ ...typed, messageId: "202", text: "second" }, never); // same channel: waits
  a.handle({ ...typed, messageId: "203", text: "third" }, never);
  await tick();
  expect(a.q.cancel(waitId)).toBe(true);
  const jobs = bridge(dir).saved.toRestore();
  expect(jobs.map((j) => [j.messageId, j.running ?? false])).toEqual([
    ["200", true],
    ["203", false],
  ]);
  expect(restorePlan(jobs[1]!)).toEqual({ action: "queue", restarts: 0 });
});

test("one JobState transition table drives the queue, the stack tracker, the master board and the reactions", () => {
  const go = (s: JobState, ...evs: Parameters<typeof jobTransition>[1][]) => evs.reduce(jobTransition, s);
  expect(go("queued", { type: "start" })).toBe("running");
  expect(go("queued", { type: "cancel" })).toBe("stopped");
  expect(go("queued", { type: "start" }, endEvent({ ok: true }, undefined))).toBe("done");
  expect(go("running", endEvent({ ok: false }, undefined))).toBe("failed");
  expect(go("running", endEvent(undefined, new Error("x")))).toBe("failed");
  expect(go("running", endEvent({ ok: false, cancelled: true }, undefined))).toBe("stopped");
  // Final states never move again.
  expect(go("done", { type: "start" }, { type: "cancel" })).toBe("done");
  expect(go("stopped", { type: "start" })).toBe("stopped");
  expect(["queued", "running", "done", "failed", "stopped"].map((s) => jobReaction(s as JobState, "⚙️"))).toEqual(["⏳", "⚙️", "✅", "❌", null]);
});

test("the queue reports each job's JobState: running in status, final state to onSettled and onDone", async () => {
  const q = new JobQueue<R>(1);
  const settled: string[] = [];
  const done: string[] = [];
  q.onSettled = (j) => settled.push(`${j.id}:${j.state}`);
  const gate = Promise.withResolvers<R>();
  q.enqueue({ key: "a", label: "a", run: () => gate.promise, onDone: (_r, _e, s) => void done.push(`1:${s}`) });
  q.enqueue({ key: "b", label: "b", run: async () => ({ ok: true }), onDone: (_r, _e, s) => void done.push(`2:${s}`) });
  expect(q.status().running.map((j) => j.state)).toEqual(["running"]);
  expect(q.status().queued.map((j) => j.state)).toEqual(["queued"]);
  gate.resolve({ ok: false, cancelled: true });
  for (let i = 0; i < 5; i++) await tick();
  expect(settled).toEqual(["1:stopped", "2:done"]);
  expect(done).toEqual(["1:stopped", "2:done"]);
});
