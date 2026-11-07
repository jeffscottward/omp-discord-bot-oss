import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore, answersText } from "../src/ask.ts";

const qs = [
  { id: "a", question: "A?", options: ["x", "✏️ Other (type or dictate a reply)"], multi: false },
  { id: "b", question: "B?", options: ["p", "q"], multi: false },
];
const fresh = () => new AskStore(mkdtempSync(join(tmpdir(), "reply-ans-")));

test("text reply to a single-question menu answers it as Other", () => {
  const s = fresh();
  const set = s.create("c", [qs[0]!]);
  s.recordPart(set.setId, "m0");
  s.recordMessage(set.setId, 0, "m0");
  const qid = s.questionForReply("m0");
  expect(qid).toBe(AskStore.customId(set.setId, 0));
  const r = s.answer(qid!, [], Date.now(), "use the blue one");
  expect(typeof r === "object" && answersText(r)).toContain("Other: use the blue one");
  expect(s.questionForReply("m0")).toBeNull(); // closed: a second reply is a normal message
});

test("voice reply: the transcript answers the same way", () => {
  const s = fresh();
  const set = s.create("c", [qs[0]!]);
  s.recordMessage(set.setId, 0, "m0");
  const transcript = "go with option two please";
  const r = s.answer(s.questionForReply("m0")!, [], Date.now(), transcript);
  expect(typeof r === "object" && r.answers.a).toEqual([`Other: ${transcript}`]);
  // main.ts: the reply check runs after voice transcription, on the transcript text.
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  const body = src.slice(src.indexOf("async function handle("));
  expect(body.indexOf("answerByReply(msg")).toBeGreaterThan(body.indexOf("text = text ? `${text}\\n${spoken}` : spoken"));
});

test("multi-question set: a reply answers only that question; parts map to their question", () => {
  const s = fresh();
  const set = s.create("c", qs);
  for (const id of ["p0a", "p0b"]) s.recordPart(set.setId, id);
  s.recordMessage(set.setId, 0, "p0b");
  s.recordPart(set.setId, "p1");
  s.recordMessage(set.setId, 1, "p1");
  expect(s.questionForReply("p0a")).toBe(AskStore.customId(set.setId, 0)); // first part of a long Question 1
  expect(s.questionForReply("p1")).toBe(AskStore.customId(set.setId, 1));
  expect(s.answer(s.questionForReply("p1")!, [], Date.now(), "neither")).toBe("partial");
  expect(s.question(AskStore.customId(set.setId, 0))?.question).toBe("A?"); // still open
  const r = s.answer(AskStore.customId(set.setId, 0), ["0"]);
  expect(typeof r === "object" && r.answers).toEqual({ a: ["x"], b: ["Other: neither"] });
});

test("already-answered or closed menu: reply is a normal message", () => {
  const s = fresh();
  const set = s.create("c", qs);
  s.recordMessage(set.setId, 0, "m0");
  s.recordMessage(set.setId, 1, "m1");
  s.answer(AskStore.customId(set.setId, 0), ["0"]);
  expect(s.questionForReply("m0")).toBeNull(); // this question answered, set still open
  s.close([set.setId]);
  expect(s.questionForReply("m1")).toBeNull();
  expect(s.questionForReply("unrelated")).toBeNull();
});
