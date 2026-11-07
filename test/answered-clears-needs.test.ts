// Owner 2026-10-25 (card answered-clears-needs): any owner answer removes the menu from the Needs-you lists at once.
import { describe, expect, test } from "bun:test";
import { AskStore, ASK_TTL_MS } from "../src/ask.ts";
import { openMenus, type ChanInfo } from "../src/needsyou.ts";
import { queuedNote } from "../src/queued.ts";

const G = "1";
const CH = "100";
const THREAD = "200";
const q = (id: string) => ({ id, question: `Q ${id}?`, options: ["A", "B"], multi: false });
const chans = new Map<string, ChanInfo>([[CH, { name: "general", archived: false, finance: false }], [THREAD, { name: "fun", archived: false, finance: false }]]);

const T = Date.now();
function store(now = T) {
  const s = new AskStore(undefined, now);
  const set = s.create(CH, [q("a"), q("b")], now, "900");
  s.recordMessage(set.setId, 0, "m0");
  s.recordMessage(set.setId, 1, "m1");
  return { s, set };
}
const rows = (s: AskStore) => openMenus(s.openSets(), [], chans, G).map((r) => r.key);

describe("answered menus leave the Needs-you lists", () => {
  test("baseline: both questions listed", () => {
    const { s, set } = store();
    expect(rows(s)).toEqual([`${set.setId}/a`, `${set.setId}/b`]);
  });

  test("button pick hides that question and records via=pick", () => {
    const { s, set } = store();
    expect(s.answer(AskStore.customId(set.setId, 0), ["1"])).toBe("partial");
    expect(rows(s)).toEqual([`${set.setId}/b`]);
    expect(s.openSets()[0]!.responded?.["0"]?.via).toBe("pick");
  });

  test("✏️ Other text records via=other", () => {
    const { s, set } = store();
    s.answer(AskStore.customId(set.setId, 1), [], 2_000, "my own words");
    expect(s.openSets()[0]!.responded?.["1"]?.via).toBe("other");
    expect(rows(s)).toEqual([`${set.setId}/a`]);
  });

  test("Discord reply to one menu hides that question only", () => {
    const { s, set } = store();
    expect(s.markAnswered(["m1"], "reply", T + 1)).toEqual([set.setId]);
    expect(rows(s)).toEqual([`${set.setId}/a`]);
    expect(s.openSets()[0]!.answered).toBeUndefined();
  });

  test("reply to every menu marks the set answered with answeredAt and via", () => {
    const { s, set } = store();
    s.markAnswered(["m0", "m1"], "reply", T + 1);
    const o = s.openSets()[0]!;
    expect([o.answered, o.answeredAt, o.answerVia]).toEqual([true, T + 1, "reply"]);
    expect(rows(s)).toEqual([]);
    expect(set.setId).toBe(o.setId);
  });

  test("reply to the request message (sourceId) answers the whole set", () => {
    const { s } = store();
    s.markAnswered(["900"], "reply", T + 1);
    expect(rows(s)).toEqual([]);
  });

  test("unrelated message ids leave the menus listed (advisor 2026-10-25)", () => {
    const { s } = store();
    expect(s.markAnswered(["x", undefined], "reply", T + 1)).toEqual([]);
    expect(rows(s).length).toBe(2);
  });

  test("stack-thread answer: the one-hop ancestor id points at the menu", () => {
    const { s, set } = store();
    s.markAnswered(["copy-in-thread", "m1"], "stack-thread", T + 1);
    expect(rows(s)).toEqual([`${set.setId}/a`]);
    expect(s.openSets()[0]!.responded?.["1"]?.via).toBe("stack-thread");
  });

  test("✅ reaction on a menu", () => {
    const { s, set } = store();
    s.markAnswered(["m0"], "reaction", T + 1);
    expect(rows(s)).toEqual([`${set.setId}/b`]);
  });

  test("late answer to a closed or expired menu is recorded", () => {
    const { s, set } = store();
    s.close([set.setId]);
    expect(s.markAnswered(["m0"], "late", T + 1)).toEqual([set.setId]);
    expect(s.closedSet(set.setId)?.answered).toBe(true);
    const e = store(T - ASK_TTL_MS - 5);
    e.s.openSets(undefined, T); // prune → expired
    e.s.markAnswered(["m1"], "late", T);
    expect(e.s.closedSet(e.set.setId)?.answerVia).toBe("late");
  });

  test("an answered set stays answered after it closes", () => {
    const { s, set } = store();
    s.markAnswered(["m0", "m1"], "text", T + 1);
    s.close([set.setId]);
    expect(s.closedSet(set.setId)?.answerVia).toBe("text");
  });

  test("card note says answered; working", () => {
    expect(queuedNote(Date.UTC(2026, 9, 25, 12, 5))).toMatch(/^📨 answered \d\d:\d\d; working$/);
  });
});
