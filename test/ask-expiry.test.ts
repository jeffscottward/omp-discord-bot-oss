// Owner 2026-10-23 (Discord UX item 3): expired menus get a correct label, taps on one set form one turn,
// sets stay open 7 days, expired sets wait for the "⌛ Expired · 🔁 Ask again" edit.
import { describe, expect, jest, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { ASK_TTL_MS, AskStore, CLOSED_KEEP_MS, lateHeader, menuTotal, recoverAnswer, setIdTime, TapBatcher, type AskQuestion } from "../src/ask.ts";
import { askedAgainOpen } from "../src/cardsweep.ts";

const Q: AskQuestion[] = [
  { id: "a", question: "First?", options: ["Yes", "No"], multi: false },
  { id: "b", question: "Second?", options: ["Yes", "No"], multi: false },
];
const H = 3_600_000;

describe("late-tap labels", () => {
  test("a set id carries its creation time", () => {
    const now = Date.UTC(2026, 9, 23);
    expect(setIdTime(`${(now - 5 * H).toString(36)}0`, now)).toBe(now - 5 * H);
    expect(setIdTime("zz", now)).toBeNull();
  });
  test("expired, closed and lost read differently", () => {
    expect(lateHeader("expired", 45 * H)).toContain("expired menu (asked 45 h ago)");
    expect(lateHeader("closed")).toContain("already closed");
    expect(lateHeader("lost")).toContain("lost in a bot restart");
    expect(recoverAnswer("❓ Keep?\n\n1️⃣ Yes\n2️⃣ No", 0, undefined, "expired", 72 * H)).toContain("asked 3 days ago");
  });
  test("store: unknown old id = expired, unknown recent id = lost, open = null", () => {
    const now = Date.now();
    const s = new AskStore(undefined, now);
    const open = s.create("c", Q, now);
    expect(s.lateKind(open.setId, now)).toBeNull();
    expect(s.lateKind(`${(now - 45 * H).toString(36)}0`, now)!.kind).toBe("expired");
    expect(s.lateKind(`${(now - 2 * H).toString(36)}0`, now)!.kind).toBe("lost");
  });
  test("menuTotal reads 'Question x of N'", () => {
    expect(menuTotal("❓ **Question 2 of 3**\nX?")).toBe(3);
    expect(menuTotal("❓ X?")).toBe(1);
  });
});

describe("store expiry", () => {
  test("sets stay open 7 days, then wait for the Ask again edit", () => {
    const t0 = Date.now();
    const s = new AskStore(undefined, t0);
    const set = s.create("c", Q, t0);
    s.recordMessage(set.setId, 0, "m0");
    expect(s.question(AskStore.customId(set.setId, 0), t0 + 3 * 24 * H)).not.toBeNull();
    const later = t0 + ASK_TTL_MS + 1;
    expect(s.question(AskStore.customId(set.setId, 0), later)).toBeNull();
    expect(s.unedited(later).map((c) => c.setId)).toEqual([set.setId]);
    expect(s.lateKind(set.setId, later)!.kind).toBe("expired");
    s.markEdited(set.setId);
    expect(s.unedited(later)).toEqual([]);
    expect(s.closedSet(set.setId)!.messageIds).toEqual({ "0": "m0" });
    s.forgetClosed(set.setId);
    expect(s.closedSet(set.setId)).toBeNull();
  });
  test("closed sets persist (0600) and are dropped after 30 days", () => {
    const dir = mkdtempSync("/tmp/askexp-");
    const t0 = Date.now();
    const s = new AskStore(dir, t0);
    const set = s.create("c", Q, t0);
    expect(s.close([set.setId, "nope"], "asked-again", t0)).toEqual([set.setId]);
    expect(statSync(`${dir}/asks.json`).mode & 0o777).toBe(0o600);
    const s2 = new AskStore(dir, t0 + 1000);
    expect(s2.openSets()).toEqual([]);
    expect(s2.lateKind(set.setId, t0 + 1000)!.kind).toBe("closed");
    const s3 = new AskStore(dir, t0 + CLOSED_KEEP_MS + 2000);
    expect(s3.closedSet(set.setId)).toBeNull();
  });
});

describe("TapBatcher", () => {
  test("collects taps of one set and flushes once all questions are tapped", () => {
    const out: string[][] = [];
    const b = new TapBatcher<number>((_k, lines) => out.push(lines), 60_000);
    b.add("s", 3, "0", "- A → 1", 1);
    b.add("s", 3, "0", "- A → 2", 2); // same question again: replaces
    b.add("s", 3, "1", "- B → 1", 3);
    expect(out).toEqual([]);
    b.add("s", 3, "2", "- C → 1", 4);
    expect(out).toEqual([["- A → 2", "- B → 1", "- C → 1"]]);
  });
  test("flushes after the window", () => {
    jest.useFakeTimers();
    try {
      const out: number[][] = [];
      const b = new TapBatcher<number>((_k, _l, items) => out.push(items), 60_000);
      b.add("s", 3, "0", "x", 1);
      b.add("t", 1, "0", "y", 2);
      expect(out).toEqual([[2]]);
      jest.advanceTimersByTime(60_001);
      expect(out).toEqual([[2], [1]]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("card sweep: open menus asked again", () => {
  test("only open sets with a newer menu for the same question", () => {
    const msgs = [
      { id: "1", ts: 1, setId: "a", question: "q" },
      { id: "2", ts: 2, setId: "b", question: "q" },
      { id: "3", ts: 3, setId: "c", question: "other" },
    ];
    expect(askedAgainOpen(msgs, new Set(["a", "b", "c"])).map((m) => m.id)).toEqual(["1"]);
    expect(askedAgainOpen(msgs, new Set(["b"]))).toEqual([]);
  });
});
