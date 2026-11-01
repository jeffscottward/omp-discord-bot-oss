import { describe, expect, test } from "bun:test";
import type { AskSet } from "./ask.ts";
import { matchMenuAnswer, menuCandidates, menuChoices, type MenuJudge } from "./textanswer.ts";

const set = (over: Partial<AskSet> = {}): AskSet => ({
  setId: "s1",
  channelId: "chan",
  createdAt: 1,
  answers: {},
  messageIds: { "0": "m0" },
  questions: [{ id: "q1", question: "Phone-style call check, version 9f7370e: did you hear the status sentence between the songs?", options: ["✅ Yes, I heard it", "❌ No", "✏️ Other (type or dictate a reply)"], multi: false }],
  ...over,
});
const judge = (choice: string, confidence: number): MenuJudge => async () => ({ choice, confidence });

describe("voice/text answer matches an open menu (card voice-answer-closes-menu)", () => {
  test("candidates: same channel, parent or stack thread only; answered and multi questions skipped", () => {
    expect(menuCandidates([set()], ["chan"]).map((c) => c.messageId)).toEqual(["m0"]);
    expect(menuCandidates([set({ channelId: "thread" })], ["chan", null, "thread"])).toHaveLength(1);
    expect(menuCandidates([set()], ["other"])).toEqual([]);
    expect(menuCandidates([set({ answers: { q1: ["✅ Yes, I heard it"] } })], ["chan"])).toEqual([]);
  });

  test("choices never offer the Other option", () => {
    expect(Object.keys(menuChoices(menuCandidates([set()], ["chan"])))).toEqual(["c0o0", "c0o1", "none"]);
  });

  test("the live case: 'Yes, I heard it.' answers option 1", async () => {
    const m = await matchMenuAnswer("Yes, I heard it.", menuCandidates([set()], ["chan"]), judge("c0o0", 0.93));
    expect(m.kind).toBe("answer");
    if (m.kind === "answer") expect([m.cand.setId, m.cand.qi, m.option]).toEqual(["s1", 0, 0]);
  });

  test("low confidence leaves the menu open (unsure)", async () => {
    const m = await matchMenuAnswer("hmm maybe", menuCandidates([set()], ["chan"]), judge("c0o0", 0.5));
    expect(m.kind).toBe("unsure");
  });

  test("judge says none: other topic", async () => {
    expect((await matchMenuAnswer("deploy the bot", menuCandidates([set()], ["chan"]), judge("none", 0.9))).kind).toBe("none");
  });

  test("asking back or deferring never answers, and the judge is not called", async () => {
    let called = false;
    const j: MenuJudge = async () => ((called = true), { choice: "c0o0", confidence: 1 });
    expect((await matchMenuAnswer("What do you mean?", menuCandidates([set()], ["chan"]), j)).kind).toBe("none");
    expect((await matchMenuAnswer("I have to test it again", menuCandidates([set()], ["chan"]), j)).kind).toBe("none");
    expect(called).toBe(false);
  });

  test("judge error, timeout or bad choice: unsure", async () => {
    const c = menuCandidates([set()], ["chan"]);
    expect((await matchMenuAnswer("yes", c, async () => { throw new Error("x"); })).kind).toBe("unsure");
    expect((await matchMenuAnswer("yes", c, () => new Promise(() => {}), { timeoutMs: 10 })).kind).toBe("unsure");
    expect((await matchMenuAnswer("yes", c, judge("c0o2", 0.99))).kind).toBe("unsure");
  });

  test("no open menu: nothing happens", async () => {
    expect((await matchMenuAnswer("yes", [], judge("c0o0", 1))).kind).toBe("none");
  });
});
