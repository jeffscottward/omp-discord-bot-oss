import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore } from "../src/ask.ts";

const q = { id: "a", question: "Old question?", options: ["Yes", "No"], multi: false };

test("cancel closes an open set without an answer and keeps the record", () => {
  const dir = mkdtempSync(join(tmpdir(), "askcancel-"));
  try {
    const s = new AskStore(dir, 1000);
    const set = s.create("c1", [q], 1000);
    s.recordPart(set.setId, "m0");
    s.recordMessage(set.setId, 0, "m1");
    s.recordPart(set.setId, "m1");
    const c = s.cancel(set.setId, 2000);
    expect(c?.cancelled).toBe(true);
    expect(c?.answered).toBe(false);
    expect(c?.cancelledAt).toBe(2000);
    expect(c?.reason).toBe("cancelled");
    expect(c?.partIds).toEqual(["m0", "m1"]);
    expect(s.openSets(undefined, 2000)).toHaveLength(0);
    expect(s.cancel(set.setId, 2001)).toBeNull();
    expect(s.answer(AskStore.customId(set.setId, 0), ["0"], 2002)).toBe("unknown");
    s.markDeleted(set.setId, 3000);
    const disk = JSON.parse(readFileSync(join(dir, "asks.json"), "utf8"));
    expect(disk.sets).toHaveLength(0);
    expect(disk.closed[0]).toMatchObject({ setId: set.setId, cancelled: true, answered: false, deletedAt: 3000 });
    expect(new AskStore(dir, 3001).closedSet(set.setId)?.cancelled).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel of an answered-marked set clears the answered flag", () => {
  const s = new AskStore(undefined, 1000);
  const set = s.create("c1", [q], 1000);
  s.recordMessage(set.setId, 0, "m1");
  s.markAnswered(["m1"], "reply", 1500);
  const c = s.cancel(set.setId, 2000);
  expect(c?.answered).toBe(false);
  expect(c?.answerVia).toBeUndefined();
});

import { ASK_CANCEL_PREFIX, askRows } from "../src/askrows.ts";

const ids = (rows: ReturnType<typeof askRows>) => rows.map((r) => r.toJSON().components.map((c) => ("custom_id" in c ? c.custom_id : "")));

for (const [n, multi] of [[2, false], [5, false], [20, false], [25, false], [24, true], [3, true]] as const) {
  test(`Cancel has its own last row, within 5 rows (${n} options, multi=${multi})`, () => {
    const options = Array.from({ length: n }, (_, i) => (i === n - 1 ? "✏️ Other (type or dictate a reply)" : `o${i}`));
    const rows = ids(askRows("s1", 0, { id: "a", question: "Q", options, multi }));
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(5);
    expect(rows.at(-1)).toEqual([`${ASK_CANCEL_PREFIX}s1`]);
    expect(rows.flat()).toContain("ask:s1:0:other");
    if (multi) expect(rows.flat()).toContain("ask:s1:0:done");
  });
}
