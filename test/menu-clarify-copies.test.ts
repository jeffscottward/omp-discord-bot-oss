// Card voice-answer-closes-menu (owner 2026-10-31): a clarifying sentence leaves the menu open; one answer per set;
// copies of one ask in two channels close together.
import { describe, expect, test } from "bun:test";
import { AskStore, ANSWER_ECHO_MS } from "../src/ask.ts";
import { leavesOpen } from "../src/reask.ts";
import { matchMenuAnswer } from "../src/textanswer.ts";

const OWNER = "I would answer this, but I have no idea if the bot has restarted. Let me know if it has, and I will try it.";
const T = Date.now();
const q = { id: "q1", question: "Voice answer test: did the menu close?", options: ["✅ Yes", "❌ No", "✏️ Other (type or dictate a reply)"], multi: false };

describe("clarifying text leaves the menu open", () => {
  test("the owner's exact sentence asks back / defers", () => {
    expect(leavesOpen(OWNER)).toBe(true);
    for (const t of ["Let me know if it restarted.", "not sure", "I'll try it later", "I would answer, but I'm busy"]) expect(leavesOpen(t)).toBe(true);
    for (const t of ["Yes, it works.", "Yes, the sky is blue on a clear day.", "2"]) expect(leavesOpen(t)).toBe(false);
  });

  test("the matcher never calls the judge for it", async () => {
    let called = false;
    const cands = [{ setId: "s", qi: 0, question: q.question, options: q.options, messageId: "m" }];
    const m = await matchMenuAnswer(OWNER, cands as never, async () => ((called = true), { choice: "c0o0", confidence: 0.99 }));
    expect(m.kind).toBe("none");
    expect(called).toBe(false);
  });
});

describe("one answer per set", () => {
  test("a closed answered set is not answered again by a later comment or a late tap", () => {
    const s = new AskStore(undefined, T);
    const set = s.create("ch", [q], T);
    s.recordMessage(set.setId, 0, "m1");
    expect(s.answer(AskStore.customId(set.setId, 0), ["0"], T)).not.toBe("partial");
    // The bot's own turn for this answer (same moment) still counts once, so cards are queued.
    expect(s.markAnswered(["m1"], "late", T + 10)).toEqual([set.setId]);
    expect(s.markAnswered(["m1"], "reply", T + 18_000, "This one did close correctly")).toEqual([]);
    expect(s.markAnswered(["m1"], "late", T + ANSWER_ECHO_MS + 1)).toEqual([]);
    expect(s.closedSet(set.setId)?.answerVia).toBe("pick");
  });
});

describe("copies of one ask close together", () => {
  function two() {
    const s = new AskStore(undefined, T);
    const a = s.create("firstmate", [q], T);
    s.recordMessage(a.setId, 0, "fm1");
    const b = s.create("side", [q], T + 2_000);
    s.recordMessage(b.setId, 0, "side1");
    const other = s.create("side", [{ ...q, question: "Other question?" }], T + 3_000);
    return { s, a, b, other };
  }

  test("a tap on one copy closes the other copy as answered", () => {
    const { s, a, b, other } = two();
    s.answer(AskStore.customId(a.setId, 0), ["0"], T + 5_000);
    const closed = s.closeCopies(a.setId, T + 5_000);
    expect(closed.map((c) => c.setId)).toEqual([b.setId]);
    expect(s.closedSet(b.setId)?.answered).toBe(true);
    expect(s.closedSet(b.setId)?.answers).toEqual({ q1: ["✅ Yes"] });
    expect(s.openSets().map((x) => x.setId)).toEqual([other.setId]);
    // A second call closes nothing more (Needs you clears once).
    expect(s.closeCopies(a.setId, T + 6_000)).toEqual([]);
  });

  test("same text asked later by another session is not a copy", () => {
    const s = new AskStore(undefined, T);
    const a = s.create("firstmate", [q], T);
    const late = s.create("side", [q], T + 5 * 60_000);
    s.answer(AskStore.customId(a.setId, 0), ["0"], T + 6 * 60_000);
    expect(s.closeCopies(a.setId, T + 6 * 60_000)).toEqual([]);
    expect(s.openSets().map((x) => x.setId)).toEqual([late.setId]);
  });

  test("a reply/voice answer on the side copy closes the FIRSTMATE copy", () => {
    const { s, a, b } = two();
    s.answer(AskStore.customId(b.setId, 0), [], T + 5_000, "Yes it works");
    expect(s.closeCopies(b.setId, T + 5_000).map((c) => c.setId)).toEqual([a.setId]);
  });

  test("a late answer on a copy that expired closes the open copy", () => {
    const { s, a, b } = two();
    s.close([a.setId], "expired", T + 4_000);
    expect(s.markAnswered(["fm1"], "late", T + 5_000)).toEqual([a.setId]);
    expect(s.closeCopies(a.setId, T + 5_000).map((c) => c.setId)).toEqual([b.setId]);
  });
});
