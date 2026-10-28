
import { extractAsk as ex2 } from "../src/ask.ts";
import { test as t2, expect as e2 } from "bun:test";
t2("recommended: explicit index and '(Recommended)' suffix", () => {
  const a = ex2('x\n```ask\n{"questions":[{"id":"a","question":"Q?","options":["A","B"],"recommended":1},{"id":"b","question":"R?","options":["X (Recommended)","Y"]}]}\n```');
  e2(a.questions?.[0]?.recommended).toBe(1);
  e2(a.questions?.[1]?.recommended).toBe(0);
  e2(a.questions?.[1]?.options[0]).toBe("X");
});

import { AskStore as AS3, ASK_TTL_MS as TTL3 } from "../src/ask.ts";
import { mkdtempSync as mk3, statSync as st3, rmSync as rm3 } from "node:fs";
import { tmpdir as td3 } from "node:os";
import { join as j3 } from "node:path";
t2("AskStore persists pending sets across a restart", () => {
  const dir = mk3(j3(td3(), "asks-"));
  try {
    const qs = [{ id: "a", question: "A?", options: ["x", "y"], multi: false }, { id: "b", question: "B?", options: ["p", "q"], multi: true }];
    const s1 = new AS3(dir);
    const set = s1.create("chan1", qs);
    s1.recordMessage(set.setId, 0, "m0");
    e2(s1.answer(AS3.customId(set.setId, 0), ["1"])).toBe("partial");
    s1.setPicks(AS3.customId(set.setId, 1), new Set([0]));
    e2(st3(j3(dir, "asks.json")).mode & 0o777).toBe(0o600);
    const s2 = new AS3(dir);
    e2(s2.question(AS3.customId(set.setId, 1))?.question).toBe("B?");
    e2([...s2.picks(AS3.customId(set.setId, 1))]).toEqual([0]);
    const r = s2.answer(AS3.customId(set.setId, 1), ["0", "1"]);
    e2(typeof r === "object" && r.channelId).toBe("chan1");
    e2(typeof r === "object" && r.answers).toEqual({ a: ["y"], b: ["p", "q"] });
    e2(new AS3(dir).question(AS3.customId(set.setId, 1))).toBeNull();
  } finally {
    rm3(dir, { recursive: true, force: true });
  }
});
t2("AskStore drops expired sets on load", () => {
  const dir = mk3(j3(td3(), "asks-"));
  try {
    const old = Date.now() - TTL3 - 1000;
    const set = new AS3(dir, old).create("c", [{ id: "a", question: "A?", options: ["x", "y"], multi: false }], old);
    e2(new AS3(dir).question(AS3.customId(set.setId, 0))).toBeNull();
  } finally {
    rm3(dir, { recursive: true, force: true });
  }
});

import { recoverAnswer } from "../src/ask.ts";
import { describe, expect, test } from "bun:test";
describe("lost menu taps (owner 2026-10-16)", () => {
  const msg = "❓ **Question 3 of 5**\nKeep 1% risk per trade?\n\n1️⃣ Yes, 1% **⭐ (Recommended)**\n2️⃣ Change it\n3️⃣ ✏️ Other (type or dictate a reply)\n\n*Tap a number (✏️ opens a text box), or type or dictate a reply.*";
  test("a number tap becomes the owner's answer with the option text", () => {
    const t = recoverAnswer(msg, 0)!;
    expect(t).toContain("- Keep 1% risk per trade? → 1. Yes, 1%");
    expect(t).not.toContain("Recommended");
    expect(recoverAnswer(msg, 1)).toContain("→ 2. Change it");
  });
  test("typed Other text is used as the answer", () => {
    expect(recoverAnswer(msg, null, " use 0.5% ")).toContain("→ use 0.5%");
  });
  test("unreadable message or no answer gives null", () => {
    expect(recoverAnswer("", 0)).toBeNull();
    expect(recoverAnswer(msg, null)).toBeNull();
  });
});


t2("long options and questions are kept in full (owner 2026-10-22)", () => {
  const opt = "Yes: apply receipts on finance cards, and decide 'finance' by the card's area only, not by title words";
  const q = "Q ".repeat(200).trim();
  const r = ex2("x\n```ask\n" + JSON.stringify({ questions: [{ id: "a", question: q, options: [opt, "No", "✏️ Other (type or dictate a reply)"] }] }) + "\n```");
  e2(r.questions?.[0]?.options[0]).toBe(opt);
  e2(r.questions?.[0]?.question).toBe(q);
});

import { isOtherOption as isOther9 } from "../src/ask.ts";
t2("every menu gets a ✏️ Other option even when the block left it out (owner 2026-10-23)", () => {
  const r = ex2('x\n```ask\n{"questions":[{"id":"a","question":"Q?","options":["A","B","C"]}]}\n```');
  const opts = r.questions![0]!.options;
  e2(opts.length).toBe(4);
  e2(isOther9(opts[3] ?? "")).toBe(true);
  const r2 = ex2('x\n```ask\n{"questions":[{"id":"a","question":"Q?","options":["A","✏️ Other (type)"]}]}\n```');
  e2(r2.questions![0]!.options.length).toBe(2);
});

t2("repeated question ids get unique ids (one answer must not fill two questions)", () => {
  const a = ex2('x\n```ask\n{"questions":[{"id":"a","question":"Q?","options":["A","B"]},{"id":"a","question":"R?","options":["X","Y"]},{"id":"q2","question":"S?","options":["X","Y"]}]}\n```');
  const ids = a.questions!.map((q) => q.id);
  e2(ids[0]).toBe("a");
  e2(new Set(ids).size).toBe(3);
});

t2("recommended index follows the kept options (repeated/empty options skipped, popped option loses it)", () => {
  const a = ex2('x\n```ask\n{"questions":[{"id":"a","question":"Q?","options":["a","a","b","c"],"recommended":2}]}\n```');
  e2(a.questions![0]!.options[a.questions![0]!.recommended!]).toBe("b");
  const many = Array.from({ length: 25 }, (_, i) => `o${i}`);
  const b = ex2('x\n```ask\n' + JSON.stringify({ questions: [{ id: "b", question: "R?", options: many, recommended: 24 }] }) + '\n```');
  e2(b.questions![0]!.recommended).toBeUndefined();
  const c = ex2('x\n```ask\n{"questions":[{"id":"c","question":"S?","options":[{"label":"x"},{"label":"y","recommended":true}]}]}\n```');
  e2(c.questions![0]!.recommended).toBe(1);
});

test("open menu questions are not asked again (owner 2026-10-27)", async () => {
  const { dropRepeatedQuestions } = await import("../src/ask.ts");
  const open = [{ setId: "s", channelId: "c", createdAt: 0, answers: { a: ["X"] }, messageIds: { a: "m1", b: "m2" },
    questions: [{ id: "a", question: "Pick A?", options: ["X", "Y"], multi: false }, { id: "b", question: "Pick B?", options: ["X", "Y"], multi: false }] }] as never;
  const r = dropRepeatedQuestions([
    { id: "1", question: "pick b", options: ["X", "Y"], multi: false },
    { id: "2", question: "Pick A?", options: ["X", "Y"], multi: false },
    { id: "3", question: "New one?", options: ["X", "Y"], multi: false },
  ] as never, open);
  expect(r.repeated).toEqual([{ question: "pick b", messageId: "m2" }]);
  expect(r.keep.map((q) => q.id)).toEqual(["2", "3"]);
});

test("questions answered in the last 24 h are not asked again (owner 2026-10-27)", async () => {
  const { dropRepeatedQuestions } = await import("../src/ask.ts");
  const done = [{ setId: "d", channelId: "c", createdAt: 0, closedAt: 1, reason: "closed", answered: true, questions: [{ id: "x", question: "Ship it?", options: ["Y", "N"], multi: false }] }] as never;
  const r = dropRepeatedQuestions([{ id: "1", question: "Ship it?", options: ["Y", "N"], multi: false }] as never, [], done);
  expect(r.keep).toEqual([]);
  expect(r.repeated[0]!.answered).toBe(true);
});
