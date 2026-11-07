import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskStore } from "../src/ask.ts";
import { askLinkLine, pointerIsStale, pointerTargets } from "../src/asklink.ts";

// Card delete-answered-pointers (owner 2026-11-05).
const q = { id: "a", question: "Pick one?", options: ["Yes", "No"], multi: false };

function store() {
  const dir = mkdtempSync(join(tmpdir(), "askptr-"));
  return { s: new AskStore(dir, 1000), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a pointer is stale once the menu is answered by a button pick, and survives a reload", () => {
  const { s, done } = store();
  try {
    const set = s.create("job", [q], 1000);
    s.recordMessage(set.setId, 0, "m1");
    s.recordPointer(set.setId, "fm", "p1");
    s.recordPointer(set.setId, "fm", "p1"); // no duplicate
    expect(s.stalePointers()).toEqual([]);
    expect(s.setForMessage("m1")).toEqual({ setId: set.setId, open: true });
    s.answer(AskStore.customId(set.setId, 0), ["0"], 2000);
    expect(s.stalePointers()).toEqual([{ setId: set.setId, pointers: [{ channelId: "fm", messageId: "p1" }] }]);
    s.dropPointers(set.setId, ["p1"]);
    expect(s.stalePointers()).toEqual([]);
  } finally {
    done();
  }
});

test("typed reply, cancel and copies make pointers stale; an unanswered expired set keeps them", () => {
  const { s, done } = store();
  try {
    const a = s.create("job", [q], 1000);
    s.recordMessage(a.setId, 0, "ma");
    s.recordPointer(a.setId, "fm", "pa");
    const b = s.create("other", [q], 1001); // copy of the same ask
    s.recordMessage(b.setId, 0, "mb");
    s.recordPointer(b.setId, "fm", "pb");
    const c = s.create("job", [{ ...q, id: "c", question: "Other?" }], 1002);
    s.recordMessage(c.setId, 0, "mc");
    s.recordPointer(c.setId, "fm", "pc");
    s.markAnswered(["ma"], "text", 2000, "Yes please");
    s.closeCopies(a.setId, 2000);
    expect(s.pointerStale(a.setId)).toBe(true);
    expect(s.pointerStale(b.setId)).toBe(true);
    expect(s.pointerStale(c.setId)).toBe(false);
    s.cancel(c.setId, 2100);
    expect(s.pointerStale(c.setId)).toBe(true);
    expect(s.stalePointers().map((x) => x.setId).sort()).toEqual([a.setId, b.setId, c.setId].sort());
  } finally {
    done();
  }
});

test("pointerTargets parses only pointer lines; staleness needs every target stale", () => {
  const line = askLinkLine("123", "Pick one?", "https://discord.com/channels/1/123/999");
  expect(pointerTargets(line)).toEqual(["999"]);
  expect(pointerTargets("⏳ Still waiting: [a](<https://discord.com/channels/1/2/7>) · [b](<https://discord.com/channels/1/2/8>)")).toEqual(["7", "8"]);
  expect(pointerTargets("Hello https://discord.com/channels/1/2/3")).toBeNull();
  expect(pointerTargets("❓ Open question in <#1>: no link")).toBeNull();
  expect(pointerIsStale(["7", "8"], (id) => id === "7")).toBe(false);
  expect(pointerIsStale(["7", "8"], () => true)).toBe(true);
});
