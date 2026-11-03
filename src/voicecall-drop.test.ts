// Card voicecall-drop (2026-10-31): a call drop during hold music must not lose the spoken answer.
import { expect, test } from "bun:test";
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
  protected override hasConnection(): boolean {
    return true;
  }
  protected override playHold(_filter: string): void {
    this.holdStarts++;
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
  await tick(80);
  expect(vc.played.filter((p) => p === "Still working on it.").length).toBeGreaterThanOrEqual(1);
  expect(vc.holdStarts).toBeGreaterThanOrEqual(2); // music resumes after each progress line
  vc.ownerLeft(); // owner gives up before the answer
  const n = vc.played.length;
  await tick(60);
  expect(vc.played.length).toBe(n); // no progress lines while away
  expect(await vc.speakFile("the answer")).toBe("missed");
  vc.ownerJoined();
  await tick(20);
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
  await tick(110);
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
  await tick(100);
  expect(vc.holding).toBe(false);
  expect(vc.played.filter((p) => p.startsWith("I stopped the hold music")).length).toBe(1);
  vc.ownerLeft();
});

test("progress lines do not push the hold max back", async () => {
  const vc = new FakeCall();
  vc.setCueMs(30);
  (vc as unknown as { holdMaxMs: number }).holdMaxMs = 400;
  vc.ownerJoined();
  vc.startHold(["/x/a.ogg"]);
  await tick(700);
  expect(vc.played.filter((p) => p === "Still working on it.").length).toBeGreaterThanOrEqual(2);
  expect(vc.holding).toBe(false);
  expect(vc.played.filter((p) => p.startsWith("I stopped the hold music")).length).toBe(1);
  vc.ownerLeft();
});
