// Card bot-ask-multi-other (owner 2026-11-03): multi-select ✏️ Other keeps a note with the picks until ✅ Done.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore } from "../src/ask.ts";
import { askRows, withNote, NOTE_MARK } from "../src/askrows.ts";
import { askMultiHint } from "../src/http.ts";

const OTHER = "✏️ Other (type or dictate a reply)";
const withStore = (fn: (s: AskStore) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "asks-mo-"));
  try { fn(new AskStore(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("multi-select + Other note -> one submission with every pick and the note", () => withStore((s) => {
  const set = s.create("c", [{ id: "ph", question: "Which phases?", options: ["A", "B", "C", OTHER], multi: true }]);
  const id = AskStore.customId(set.setId, 0);
  s.setPicks(id, new Set([0, 1, 2]));
  s.setNote(id, "first draft");
  expect(s.note(id)).toBe("first draft");
  s.setNote(id, "  also do D  "); // edited before Done
  expect(s.note(id)).toBe("also do D");
  const r = s.answer(id, [...s.picks(id)].map(String), Date.now(), s.note(id));
  expect(typeof r === "object" && r.answers).toEqual({ ph: ["A", "B", "C", "Other: also do D"] });
}));

test("note persists across a restart and an empty note clears it", () => {
  const dir = mkdtempSync(join(tmpdir(), "asks-mo-"));
  try {
    const s1 = new AskStore(dir);
    const set = s1.create("c", [{ id: "q", question: "Which?", options: ["A", OTHER], multi: true }]);
    const id = AskStore.customId(set.setId, 0);
    s1.setNote(id, "keep");
    expect(new AskStore(dir).note(id)).toBe("keep");
    s1.setNote(id, "");
    expect(s1.note(id)).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("single-select one tap still submits", () => withStore((s) => {
  const set = s.create("c", [{ id: "q", question: "Pick?", options: ["A", "B", OTHER], multi: false }]);
  const r = s.answer(AskStore.customId(set.setId, 0), ["1"]);
  expect(typeof r === "object" && r.answers).toEqual({ q: ["B"] });
}));

test("menu rows: Other toggle turns green with a note; Done present; text shows the note once", () => {
  const q = { id: "q", question: "Which?", options: ["A", "B", OTHER], multi: true };
  const btns = (note: string) => askRows("abc", 0, q, new Set([0]), note).flatMap((r) => r.toJSON().components) as { custom_id: string; style: number }[];
  const other = (note: string) => btns(note).find((b) => b.custom_id.endsWith(":other"))!;
  expect(other("").style).toBe(2);
  expect(other("x").style).toBe(3);
  expect(btns("").some((b) => b.custom_id.endsWith(":done"))).toBe(true);
  const once = withNote(withNote("Menu", "one"), "two");
  expect(once.split(NOTE_MARK).length).toBe(2);
  expect(once.endsWith("*two*")).toBe(true);
  expect(withNote(once, "")).toBe("Menu");
});

test("/post hint suggests multi for 'which of these' single-select questions", () => {
  const mk = (multi: boolean) => '```ask\n{"questions":[{"id":"f","question":"Which of these features?","options":["A","B"],"multi":' + multi + "}]}\n```";
  expect(askMultiHint(mk(false))).toContain('"multi": true');
  expect(askMultiHint(mk(true))).toBeNull();
});

test("a typed reply or voice pick keeps the pending note (not lost)", () => withStore((s) => {
  const set = s.create("c", [{ id: "q", question: "Which?", options: ["A", "B", OTHER], multi: true }, { id: "r", question: "Which too?", options: ["X", "Y", OTHER], multi: true }]);
  const q0 = AskStore.customId(set.setId, 0), q1 = AskStore.customId(set.setId, 1);
  s.setPicks(q0, new Set([0]));
  s.setNote(q0, "my note");
  expect(s.answer(q0, ["0"], Date.now(), "typed reply")).toBe("partial");
  s.setNote(q1, "only note");
  const r = s.answer(q1, ["1"]);
  expect(typeof r === "object" && r.answers).toEqual({ q: ["A", "Other: my note\n\ntyped reply"], r: ["Y", "Other: only note"] });
}));

test("review fixes: long note keeps the reply; long menu text is never cut; hint skips either/or", () => withStore((s) => {
  const set = s.create("c", [{ id: "q", question: "Which?", options: ["A", OTHER], multi: true }, { id: "z", question: "Z?", options: ["A", OTHER], multi: true }]);
  const id = AskStore.customId(set.setId, 0);
  s.setNote(id, "n".repeat(1000));
  expect(s.answer(id, [], Date.now(), "reply")).toBe("partial");
  expect(s.isAnswered(id)).toBe(true);
  const long = "m".repeat(1900);
  expect(withNote(long, "note").startsWith(long)).toBe(true);
  expect(withNote("m".repeat(1990), "note")).toBe("m".repeat(1990));
  const mk = (q: string) => '```ask\n{"questions":[{"id":"f","question":"' + q + '","options":["A","B"]}]}\n```';
  expect(askMultiHint(mk("Which of the two branches should I merge?"))).toBeNull();
  expect(askMultiHint(mk("Did any of the tests fail?"))).toBeNull();
  expect(askMultiHint(mk("Which phases should I build?"))).not.toBeNull();
}));
