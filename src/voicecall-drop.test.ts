// Card voicecall-drop (2026-10-31): a call drop during hold music must not lose the spoken answer.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceChat } from "./voicechat.ts";

class FakeCall extends VoiceChat {
  ready = true;
  played: string[] = [];
  failNext = 0;
  /** The rejoin finishes the next time the queue waits for the call (no wall-clock timers). */
  rejoins = true;
  waits = 0;
  constructor() {
    super({ guildId: "1", channelId: "2", ownerId: "3", onTranscript: async () => {}, log: () => {} });
  }
  protected override connectedReady(): boolean {
    return this.ready;
  }
  protected override async waitReady(_ms: number): Promise<boolean> {
    this.waits++;
    if (!this.ready && this.rejoins) this.ready = true;
    return this.ready;
  }
  protected override async toDiscordOpus(src: string): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "vc-test-"));
    const out = join(dir, "say.ogg");
    writeFileSync(out, existsSync(src) ? readFileSync(src) : src);
    return out;
  }
  holdStarts = 0;
  setCueMs(ms: number): void {
    this.holdCueMs = ms;
  }
  /** One progress line now, as the hold timer would say it (the test decides when). */
  cue(): Promise<void> {
    return this.holdCue();
  }
  protected override hasConnection(): boolean {
    return true;
  }
  protected override playHold(_filter: string): void {
    this.holdStarts++;
    this.settle();
  }
  private waiters: { done: () => boolean; resolve: () => void }[] = [];
  /**
   * Resolves when done() holds; checked after every played line and every hold start. Card bot-gate-flake
   * (2026-11-03): a fixed wait (110 ms for two 30 ms progress lines) failed under host load; the test waits for the
   * event itself, and bun's test timeout catches an event that never comes.
   */
  until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push({ done, resolve });
    return promise;
  }
  private settle(): void {
    this.waiters = this.waiters.filter((w) => !(w.done() && (w.resolve(), true)));
  }
  protected override async fadeOutHold(): Promise<void> {}
  protected override async synth(text: string): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "vc-synth-"));
    const out = join(dir, "t.ogg");
    writeFileSync(out, text);
    return out;
  }
  protected override async playOne(file: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      this.ready = false; // the call dropped mid-play
      throw new Error("Player did not start (no subscriber)");
    }
    this.played.push(readFileSync(file, "utf8"));
    this.settle();
  }
}

test("answer that arrives while the call reconnects is spoken after the rejoin", async () => {
  const vc = new FakeCall();
  vc.ownerJoined();
  vc.ready = false; // dropped while hold music played
  expect(await vc.speakFile("answer")).toBe("said");
  expect(vc.waits).toBe(1);
  expect(vc.played.length).toBe(1);
  vc.ownerLeft();
});

test("drop in the middle of the answer: one retry after the rejoin", async () => {
  const vc = new FakeCall();
  vc.ownerJoined();
  vc.failNext = 1;
  expect(await vc.speakFile("answer")).toBe("said");
  expect(vc.waits).toBe(2);
  expect(vc.played.length).toBe(1);
  vc.ownerLeft();
});

test("call never comes back: result is failed (caller posts the text note)", async () => {
  const vc = new FakeCall();
  vc.ownerJoined();
  vc.ready = false;
  vc.rejoins = false;
  expect(await vc.speakFile("answer")).toBe("failed");
  expect(vc.played.length).toBe(0);
  vc.ownerLeft();
});

test("owner not in the call: answer kept as missed", async () => {
  const vc = new FakeCall();
  expect(await vc.speakFile("answer")).toBe("missed");
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The real 10-31 rejoin failure: a 2.5 min run, only hold music, owner left 23 s before the answer.
test("leave -> rejoin -> ask: progress line during hold, late answer said on the next join", async () => {
  const vc = new FakeCall();
  vc.setCueMs(30);
  vc.ownerJoined();
  vc.ownerLeft();
  vc.ownerJoined(); // rejoin
  expect(await vc.speakFile("One moment.")).toBe("said");
  vc.startHold(["/x/a.ogg"]);
  await vc.until(() => vc.holdStarts >= 2); // a progress line played and the music resumed
  expect(vc.played.filter((p) => p === "Still working on it.").length).toBeGreaterThanOrEqual(1);
  expect(vc.holdStarts).toBeGreaterThanOrEqual(2); // music resumes after each progress line
  vc.ownerLeft(); // owner gives up before the answer
  const n = vc.played.length;
  await tick(60);
  expect(vc.played.length).toBe(n); // no progress lines while away
  expect(await vc.speakFile("the answer")).toBe("missed");
  vc.ownerJoined();
  await vc.until(() => vc.played.at(-1) === "the answer");
  expect(vc.played.slice(-2)).toEqual(["Here is the answer that came in after you left.", "the answer"]);
  vc.ownerLeft();
});

test("answer while on hold stops the progress lines", async () => {
  const vc = new FakeCall();
  vc.setCueMs(30);
  vc.ownerJoined();
  vc.startHold(["/x/a.ogg"]);
  expect(await vc.speakFile("the answer")).toBe("said");
  const n = vc.played.length;
  await tick(80);
  expect(vc.played.length).toBe(n);
  vc.ownerLeft();
});

// The real 10-31 failure: the bot restarted while a voice turn ran. The turn is saved, loaded and run again once.
test("running voice turn survives one restart, a second restart drops it", async () => {
  const { loadQueueState, restorePlan, saveQueueState } = await import("./queuestate.ts");
  const dir = mkdtempSync(join(tmpdir(), "vc-state-"));
  const turn = { id: 7, channelId: "11", messageId: "22", authorId: "3", text: "are you there", fromVoice: true, enqueuedAt: 1, running: true, restarts: 0 };
  saveQueueState(dir, { nextId: 8, jobs: [turn] });
  const first = loadQueueState(dir).jobs[0]!;
  expect(first.fromVoice).toBe(true);
  const p = restorePlan(first);
  expect(p).toMatchObject({ action: "queue", restarts: 1 }); // run again after the first restart
  saveQueueState(dir, { nextId: 9, jobs: [{ ...first, restarts: 1 }] }); // re-run saved as running again
  expect(restorePlan(loadQueueState(dir).jobs[0]!).action).toBe("drop"); // second restart: no loop
  expect(restorePlan({ running: false })).toEqual({ action: "queue", restarts: 0 }); // waiting jobs are always restored
});

// Owner retest 10-31 21:27Z: 3 min of hold music, no progress line. Same path as main.ts onVoiceTranscript.
test("main.ts path: speak('One moment.').then(startHold) -> progress lines repeat while hold plays", async () => {
  const vc = new FakeCall();
  vc.setCueMs(30);
  vc.ownerJoined();
  await vc.speak("One moment.").then(() => vc.startHold(["/x/a.ogg"]));
  await vc.until(() => vc.played.filter((p) => p === "Still working on it.").length >= 2);
  expect(vc.played[0]).toBe("One moment.");
  expect(vc.played.filter((p) => p === "Still working on it.").length).toBeGreaterThanOrEqual(2);
  vc.ownerLeft();
});

// Card voice-answer-closes-menu (owner 2026-10-31): "Yes, grass is green" closed the menu, but hold music played until he left.
test("voice turn used as a menu answer: one confirmation, no hold music", async () => {
  const vc = new FakeCall();
  vc.setCueMs(20);
  vc.ownerJoined();
  const pending = vc.speak("One moment.").then(() => vc.startHold(["/x/a.ogg"]));
  const confirm = vc.confirmInstead("Got it: Yes. Menu closed."); // one call, as in main.ts
  await pending;
  expect(vc.holding).toBe(false);
  await confirm;
  await pending;
  await tick(60);
  expect(vc.holding).toBe(false);
  expect(vc.played.filter((p) => p === "Still working on it.")).toEqual([]);
  expect(vc.played).toContain("Got it: Yes. Menu closed.");
  vc.ownerLeft();
});

test("hold music without a run ending it stops at the max and says so once", async () => {
  const vc = new FakeCall();
  vc.setCueMs(1_000);
  (vc as unknown as { holdMaxMs: number }).holdMaxMs = 40;
  vc.ownerJoined();
  vc.startHold(["/x/a.ogg"]);
  expect(vc.holding).toBe(true);
  await vc.until(() => vc.played.some((p) => p.startsWith("I stopped the hold music")));
  await tick(60); // a short real window for a second stop line ("says so once"); none comes, whatever the load
  expect(vc.holding).toBe(false);
  expect(vc.played.filter((p) => p.startsWith("I stopped the hold music")).length).toBe(1);
  vc.ownerLeft();
});

// A test that times out skips the rest of its body; afterEach still runs, so a frozen clock (setSystemTime) and an open
// call never reach later tests or test files (bun runs every file in one process).
let held: FakeCall | undefined;
afterEach(() => {
  setSystemTime();
  held?.ownerLeft();
  held = undefined;
});

test("progress lines do not push the hold max back", async () => {
  // Card bot-gate-flake (2026-11-03): with real 30 ms progress-line timers a loaded host (load 60-110) fitted 0-1
  // lines into the max. Here the test says each line itself and moves Date.now (setSystemTime); the max timer is real.
  const vc = (held = new FakeCall());
  vc.setCueMs(3_600_000); // the progress-line timer never fires on its own
  (vc as unknown as { holdMaxMs: number }).holdMaxMs = 10_000;
  const t0 = Date.now();
  setSystemTime(t0);
  vc.ownerJoined();
  vc.startHold(["/x/a.ogg"]);
  await vc.cue();
  await vc.until(() => vc.holdStarts >= 2); // line said, music resumed
  setSystemTime(t0 + 9_990); // 10 ms of the max left, counted from the first start
  await vc.cue();
  await vc.until(() => vc.holdStarts >= 3);
  // The max fires about 10 ms later. A max counted again from this progress line would wait 10 s, past bun's test
  // timeout, so the test fails.
  await vc.until(() => vc.played.some((p) => p.startsWith("I stopped the hold music")));
  await tick(60); // a short real window for a second stop line; none comes, whatever the load
  expect(vc.played.filter((p) => p === "Still working on it.").length).toBe(2);
  expect(vc.holding).toBe(false);
  expect(vc.played.filter((p) => p.startsWith("I stopped the hold music")).length).toBe(1);
});
