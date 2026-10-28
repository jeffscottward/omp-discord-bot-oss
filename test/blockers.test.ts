import { describe, expect, test } from "bun:test";
import { blockedTracks, ownerRoots, roots, type BItem } from "../src/blockers.ts";
import { renderNeedsYou } from "../src/needsyou.ts";

const M = (n: number) => `https://discord.com/channels/1/2/${n}`;
const items: BItem[] = [
  { id: "q", t: "Pick a host", s: "waiting", action: "Do the step", q: M(1) },
  { id: "a", t: "Build A", s: "partial", blockedBy: "b" },
  { id: "b", t: "Build B", s: "partial", blockedBy: ["q", "c"] }, // multi-parent
  { id: "c", t: "CI fix", s: "running", job: "ci-fix-tab" },
  { id: "d", t: "Deploy", s: "partial", blockedBy: "c" },
  { id: "x", t: "Cycle 1", s: "partial", blockedBy: "y" },
  { id: "y", t: "Cycle 2", s: "partial", blockedBy: "x" },
  { id: "m", t: "Missing", s: "partial", blockedBy: "gone" },
  { id: "e", t: "Wait vendor", s: "partial", blockedBy: "ext:vendor reply" },
  { id: "t", t: "Timer", s: "partial", blockedBy: "kb-daily.timer" },
  { id: "f", t: "Free", s: "partial", blockedBy: "z" },
  { id: "z", t: "Finished", s: "done" },
];
const byId = new Map(items.map((i) => [i.id, i]));

describe("roots", () => {
  test("multi-parent chain reaches owner and bot leaves", () => {
    const r = roots("a", byId);
    expect(r.map((l) => `${l.id}:${l.cls}`).sort()).toEqual(["c:bot", "q:owner"]);
    expect(r.find((l) => l.id === "q")!.chain).toEqual(["a", "b", "q"]);
  });
  test("cycles end as unknown, no hang", () => expect(roots("x", byId).map((l) => l.cls)).toEqual(["unknown"]));
  test("missing card is unknown", () => expect(roots("m", byId)).toMatchObject([{ id: "gone", cls: "unknown" }]));
  test("ext/time refs are external, units are bot", () => {
    expect(roots("e", byId)[0]!.cls).toBe("external");
    expect(roots("t", byId)[0]!.cls).toBe("bot");
  });
  test("done blockers do not block", () => expect(blockedTracks(items).some((t) => t.item.id === "f")).toBe(false));
  test("owner root counts unblocked cards", () => expect(ownerRoots(items)).toMatchObject([{ root: { id: "q" }, unblocks: [{ id: "a" }, { id: "b" }] }]));
});

describe("needs-you board split", () => {
  const text = renderNeedsYou(items, 1_800_000_000_000, "https://d/");
  test("owner root row links the root question with the unblock count", () => expect(text).toContain(`🔗 [Open](<${M(1)}>)\n🔓 unblocks 2 cards`));
  test("bot-only chains are on one waiting line", () => expect(text).toMatch(/⏳ Waiting on bots \(2\): ci-fix-tab, kb-daily/));
  test("external and unclear lines", () => {
    expect(text).toContain("🌐 Waiting on outside (1)");
    expect(text).toContain("❔ Blocker unclear (3)");
  });
});
test("an owner root is listed once, under Blocked on you", () => {
  const text = renderNeedsYou(items, 1_800_000_000_000, "https://d/");
  expect(text.split("Pick a host").length).toBe(2);
  expect(text).toContain("⛔ **Blocked on you** (1)");
  expect(text).not.toContain("Waiting on you");
});

describe("parity rules with the dashboard and fm why", () => {
  const its: BItem[] = [
    { id: "g", t: "Gate", s: "partial", until: "2099-01-01T00:00:00Z" },
    { id: "p", t: "Past", s: "partial", until: "2000-01-01T00:00:00Z" },
    { id: "h", t: "h", s: "partial", blockedBy: "gate" },
    { id: "k", t: "k", s: "partial", blockedBy: "p" },
    { id: "o", t: "o", s: "waiting", action: "Do the step", q: M(2), blocks: "r" },
    { id: "r", t: "r", s: "partial" },
    { id: "bq", t: "bq", s: "blocked", action: "Do the step", q: M(3), blockedBy: "c2" },
    { id: "c2", t: "c2", s: "running", job: "j" },
    { id: "w", t: "w", s: "partial", blockedBy: "bq" },
    { id: "legacy", t: "Login needed", s: "blocked", action: "Do the step", src: M(4) },
  ];
  const m = new Map(its.map((i) => [i.id, i]));
  test("title ref + future until = external", () => expect(roots("h", m)).toMatchObject([{ id: "g", cls: "external" }]));
  test("passed until counts as cleared", () => expect(blockedTracks(its).some((t) => t.item.id === "k")).toBe(false));
  test("reverse blocks edge", () => expect(roots("r", m)).toMatchObject([{ id: "o", cls: "owner" }]));
  test("a blocked card with its own question is an owner leaf too", () => expect(roots("w", m).map((l) => `${l.id}:${l.cls}`)).toContain("bq:owner"));
  test("legacy blocked card with a link stays on the board", () => expect(renderNeedsYou(its as never, Date.now(), "https://d/")).toContain("Login needed"));
});

test("an answered (queued) owner card is a bot leaf, not unclear (owner 2026-10-25)", () => {
  const { leafClass } = require("../src/blockers.ts");
  expect(leafClass({ id: "r", s: "waiting", action: "Do it", queued: 1 })).toBe("bot");
  expect(leafClass({ id: "r", s: "waiting", action: "Do it" })).toBe("owner");
  expect(leafClass({ id: "r", s: "waiting" })).toBe("unknown");
  expect(leafClass({ id: "r", s: "partial", queued: 1 })).toBe("bot");
});
