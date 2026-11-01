// Card noreask-clarify (2026-10-31): an owner reply that asks back is a clarification request, not an answer.
// The no-re-ask filters (findAnswered across channels, dropRepeatedQuestions in the channel) must let the
// follow-up menu post. Real answers (button picks, "Other" answers) must still stop a re-ask.
import { describe, expect, test } from "bun:test";
import { AskStore, dropRepeatedQuestions, type AskQuestion } from "../src/ask.ts";
import { findAnswered, isClarification, isDeferral, isOpenAnswer, REASK_WINDOW_MS } from "../src/reask.ts";

// Real case: menu 100000000000000203 (Question 1 of 5) and the follow-up FIRSTMATE posted after it explained the
// context; the filter blocked it as "already answered" (msg 100000000000000204).
const OPTIONS = ["Build a value test now", "Backlog until the nightly export is on again", "Remove the JEV gate", "✏️ Other (type or dictate a reply)"];
const DESCRIPTIONS = ["Test the nightly export with vs without the JEV gate; research only, no live change", "The nightly export is off, so nothing uses it today", "Simpler export; no AI check", ""];
const MENU: AskQuestion = { id: "q1", question: "JEV gate on the nightly export: what now?", options: OPTIONS, descriptions: DESCRIPTIONS, multi: false };
const FOLLOW_UP: AskQuestion = { id: "q1", question: "JEV gate on the nightly export (gate added 10-14; the export is off):", options: OPTIONS, descriptions: DESCRIPTIONS, multi: false };
const CONFUSED = "I’m confused about the context of the question. What did I send you initially";
const CHANNEL = "100000000000000029";

/** A store with the JEV menu posted and answered as `how` at t=2000. */
function answered(how: { pick?: number; other?: string }): AskStore {
  const s = new AskStore();
  const set = s.create(CHANNEL, [MENU], 1000);
  s.recordMessage(set.setId, 0, "100000000000000203");
  const r = s.answer(AskStore.customId(set.setId, 0), how.pick !== undefined ? [String(how.pick)] : [], 2000, how.other);
  expect(r).not.toBe("unknown");
  return s;
}
const blocked = (s: AskStore, q: AskQuestion) => findAnswered(q, s.answeredQuestions(REASK_WINDOW_MS, 3000), 3000);
const repeated = (s: AskStore, q: AskQuestion) => dropRepeatedQuestions([q], s.openSets(CHANNEL, 3000), s.recentlyAnswered(CHANNEL, 24 * 3_600_000, 3000)).repeated;

describe("clarification text", () => {
  const asksBack = [
    CONFUSED,
    "Other: I'm confused about the context of the question. What did I send you initially",
    "what do you mean?",
    "Which one?",
    "Which one do you recommend?",
    "Can you explain what this gate does?",
    "Explain the options first",
    "I don't understand the question",
    "No, I'm confused. What is this about?",
    "What is this for",
    "Why would we remove it?",
    "Remind me what this card was about",
    "Need more context",
    "What does option 2 mean?",
    "Option 1 or 2? I am confused",
    "Sure, which one?",
    "Yes, but what is this about?",
    "No idea what this is",
    "I have no idea what this is about",
    "Still confused",
    "Confused.",
    "Very confusing",
    "This is so confusing",
    "I'm so very confused",
    "confused, explain",
    "More context? This is unclear.",
    "Missing context? Can't tell.",
  ];
  const answers = [
    "Backlog it until the nightly export is on again",
    "Yes, go ahead. Why did it fail though?",
    "Option 2, but can you also add tests?",
    "2",
    "Keep the artifacts for 30 days",
    "Use the context from yesterday's run and build the test",
    "Delete them all",
    "No",
    "Add some context to the error message",
    "Include more context in the logs",
    "Merge them, the two names are confusing",
    "Rename to avoid confusion",
  ];
  for (const t of asksBack) test(`asks back: ${t}`, () => expect(isClarification(t)).toBe(true));
  for (const t of answers) test(`answers: ${t}`, () => expect(isClarification(t)).toBe(false));
  test("button picks are never clarifications, even with a question mark", () => {
    expect(isOpenAnswer(["Which one is safer?"])).toBe(false);
    expect(isOpenAnswer([])).toBe(false);
    expect(isOpenAnswer([`Other: ${CONFUSED}`])).toBe(true);
    // Multi-select: a real pick next to the question is an answer.
    expect(isOpenAnswer(["Build a value test now", "Other: why?"])).toBe(false);
  });
});

// Live case 2026-10-31 (msg 100000000000000205): the owner's deferral on the voice-call test menu
// (100000000000000206) stopped the follow-up test menu 3 times.
const REMIND = "Remind me to test this later after an idle restart. I can't do anything until that restart happens. And I don't like it sitting in the needs you until I can actually test it. So queue the job as like planned or something. And then it will enter the needs you again once it's fired based on the restart that you do.";
const VOICE: AskQuestion = {
  id: "q1",
  question: "Voice call fix (card voicecall-drop) is merged (2d16ba9) and goes live at the next idle restart, after you leave 🎧 OMP Voice. Please test it: join the call, ask a question, wait for the spoken answer. Then leave and rejoin (forced reconnect) and ask again. Did both answers come back spoken?",
  options: ["✅ Both answers were spoken", "⚠️ Only the first answer was spoken", "❌ No spoken answer (I saw the 🔇 text note or nothing)", "⏳ Test later", "✏️ Other (type or dictate a reply)"],
  multi: false,
};
const VOICE_AGAIN: AskQuestion = { ...VOICE, question: "Join 🎧 OMP Voice, ask a question, wait for the spoken answer; then leave, rejoin and ask again. Did both answers come back spoken?" };

describe("deferral text", () => {
  const defers = [REMIND, "Remind me tomorrow", "Later", "⏳ Test later", "Test it later", "not now", "Not yet, ask me again Monday", "Ask me again after the deploy", "I can't test this until the restart happens", "Park it for later", "Check with me later", "Not right now", "Hold off", "I cannot test this until the restart", "Test after the idle restart", "⏳️ Later"];
  const answers = ["Merge now, clean up later", "Backlog until the nightly export is on again", "Ship it", "Delete the old artifacts", "Remind me what this was about", "Yes, remind me to rotate the key Monday", "No, it's not yet stable, revert it", "2, test it later", "Merge it. Ask on the PR if CI fails", "Delete it now, I'll check it later"];
  for (const t of defers) test(`defers: ${t.slice(0, 60)}`, () => expect(isDeferral(t)).toBe(true));
  for (const t of answers) test(`does not defer: ${t}`, () => expect(isDeferral(t)).toBe(false));
  test("a deferral pick or Other text leaves the question open; a real pick does not", () => {
    expect(isOpenAnswer(["⏳ Test later"])).toBe(true);
    expect(isOpenAnswer([`Other: ${REMIND}`])).toBe(true);
    expect(isOpenAnswer(["✅ Both answers were spoken"])).toBe(false);
    for (const label of ["Merge now, test later", "❌ Not yet fixed", "Queue it", "Hold it", "Fix later", "Retry later"]) expect(isOpenAnswer([label])).toBe(false);
    for (const label of ["⏳️ Later", "Not now", "Remind me tomorrow"]) expect(isOpenAnswer([label])).toBe(true);
  });
});

describe("no-re-ask filters keep a deferred question open", () => {
  const voice = (how: { pick?: number; other?: string }) => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [VOICE], 1000);
    s.recordMessage(set.setId, 0, "100000000000000206");
    expect(s.answer(AskStore.customId(set.setId, 0), how.pick !== undefined ? [String(how.pick)] : [], 2000, how.other)).not.toBe("unknown");
    return s;
  };
  test("replay: 'Other: Remind me to test this later …' does not block the voice test menu", () => {
    const s = voice({ other: REMIND });
    expect(blocked(s, VOICE_AGAIN)).toBeNull();
    expect(blocked(s, VOICE)).toBeNull();
    expect(repeated(s, VOICE)).toHaveLength(0);
  });
  test("the '⏳ Test later' button does not block it either", () => {
    const s = voice({ pick: 3 });
    expect(blocked(s, VOICE_AGAIN)).toBeNull();
    expect(repeated(s, VOICE)).toHaveLength(0);
  });
  test("a real result still stops the re-ask", () => {
    const s = voice({ pick: 0 });
    expect(blocked(s, VOICE_AGAIN)?.earlier.answer).toEqual(["✅ Both answers were spoken"]);
    expect(repeated(s, VOICE)).toHaveLength(1);
  });
  test("a Discord reply that defers leaves the closed menu open for the channel filter", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [VOICE], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.close([set.setId], "closed", 1500);
    s.markAnswered(["m1"], "reply", 2000, "not now, remind me tomorrow");
    expect(s.closedSet(set.setId)?.answered).toBe(true);
    expect(repeated(s, VOICE)).toHaveLength(0);
  });
});

describe("no-re-ask filters keep a clarified question open", () => {
  test("replay: JEV 'Other: I'm confused …' does not block the follow-up menu (any channel, same channel)", () => {
    const s = answered({ other: CONFUSED });
    expect(blocked(s, FOLLOW_UP)).toBeNull();
    expect(repeated(s, FOLLOW_UP)).toHaveLength(0);
    // Same text again in the same channel posts too.
    expect(repeated(s, MENU)).toHaveLength(0);
    // The menu still counts as responded for the boards (answered-clears-needs).
    expect(s.recentlyAnswered(CHANNEL, 24 * 3_600_000, 3000)).toHaveLength(1);
  });
  test("a normal Other answer still stops the re-ask", () => {
    const s = answered({ other: "Backlog it until the nightly export is on again; no test now" });
    expect(blocked(s, FOLLOW_UP)?.earlier.messageId).toBe("100000000000000203");
    expect(repeated(s, MENU)).toHaveLength(1);
  });
  test("a plain option pick still stops the re-ask", () => {
    const s = answered({ pick: 1 });
    expect(blocked(s, FOLLOW_UP)?.earlier.answer).toEqual(["Backlog until the nightly export is on again"]);
    expect(repeated(s, MENU)).toHaveLength(1);
  });
  test("a Discord reply that asks back (closed menu, no stored text) leaves the question open but clears the boards", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [MENU], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.close([set.setId], "closed", 1500);
    expect(s.markAnswered(["m1"], "reply", 2000, "wait, which one do you mean?")).toEqual([set.setId]);
    expect(s.closedSet(set.setId)?.answered).toBe(true);
    expect(repeated(s, MENU)).toHaveLength(0);
    expect(blocked(s, MENU)).toBeNull();
  });
  test("a reply that asks back, then a reply that answers: the answer wins", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [MENU], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.close([set.setId], "closed", 1500);
    s.markAnswered(["m1"], "reply", 2000, "which one do you mean?");
    expect(repeated(s, MENU)).toHaveLength(0);
    s.markAnswered(["m1"], "reply", 2500, "Backlog it");
    expect(repeated(s, MENU)).toHaveLength(1);
  });
  test("a late ✏️ text that asks back on an expired menu keeps it open; the textless late batch does not clear it", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [MENU], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.close([set.setId], "expired", 1500);
    s.markAnswered(["m1"], "late", 2000, "what does this mean?");
    s.markAnswered(["m1"], "late", 2100);
    expect(s.closedSet(set.setId)?.answered).toBe(true);
    expect(repeated(s, MENU)).toHaveLength(0);
    // A later real reply still wins.
    s.markAnswered(["m1"], "reply", 2500, "Backlog it");
    expect(repeated(s, MENU)).toHaveLength(1);
  });
  test("a late button pick after a reply that asked back clears the flag", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [MENU], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.markAnswered(["m1"], "reply", 1200, "what does this mean?");
    s.close([set.setId], "expired", 1500);
    expect(repeated(s, MENU)).toHaveLength(0);
    s.markAnswered(["m1"], "late", 2000, "2"); // useLostTap passes the pick number
    s.markAnswered(["m1"], "late", 2100);
    expect(repeated(s, MENU)).toHaveLength(1);
  });
  test("a Discord reply that answers still counts as answered for the channel filter", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [MENU], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.close([set.setId], "closed", 1500);
    s.markAnswered(["m1"], "reply", 2000, "Backlog it");
    expect(repeated(s, MENU)).toHaveLength(1);
  });
  test("an open menu replied to with a question keeps the flag after it closes with a real pick later", () => {
    const s = new AskStore();
    const set = s.create(CHANNEL, [MENU], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.markAnswered(["m1"], "reply", 1500, "what do you mean?");
    expect(s.answer(AskStore.customId(set.setId, 0), ["0"], 2000)).not.toBe("unknown");
    // The real pick wins over the earlier question back.
    expect(repeated(s, MENU)).toHaveLength(1);
    expect(blocked(s, FOLLOW_UP)?.earlier.answer).toEqual(["Build a value test now"]);
  });
});
