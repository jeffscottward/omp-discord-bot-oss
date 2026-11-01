// Owner 2026-10-30 (card bot-upgrades-1030): main pane channels are split into one category per stack; and
// (card mirror-create-loop) refused creates are not retried every pass.
import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Guild } from "discord.js";
import { CATEGORY_IDS, CATEGORY_LIMIT, MOVES_PER_PASS, Mirror, type LivePane, type MirrorEntry } from "../src/mirror.ts";
import { DEFAULT_STACKS, mergeStacks } from "../src/router.ts";
import { categoryOrder, paneStack, parseStackCategories, stackCategoryName } from "../src/stackcats.ts";

const STACKS = mergeStacks([{ name: "firstmate", emoji: "👷", keywords: [], areas: ["firstmate"], cwd: "~/Github" }]);
const MAIN = CATEGORY_IDS.main!;
const file = () => join(mkdtempSync(join(tmpdir(), "stack-split-")), "agents.json");
const cfgFile = (stackCategories: Record<string, string[]> = {}) => {
  const f = join(mkdtempSync(join(tmpdir(), "stack-split-cfg-")), "config.json");
  writeFileSync(f, JSON.stringify({ guildId: "g", mirror: { overflow: [], stackCategories } }));
  return f;
};
const pane = (id: string, tab: string, cwd = "/tmp"): LivePane => ({ machine: "main", paneId: id, tabId: `t-${id}`, workspace: "w", tab, short: tab.replace(/\s+/g, "-"), name: `main-github-${tab.replace(/\s+/g, "-")}`, cwd, sessionFile: null });

type Chan = { id: string; name: string; parentId: string | null; type: number; position?: number; rawPosition: number; topic?: string; parent?: { name: string } | null };
/** Fake guild: 🖥️ Main category with `paneCount` pane channels; creates add to the cache; setParent moves in the cache. */
function guild(paneCount: number, create?: (o: { name: string; type?: number; parent?: string }) => void) {
  const cache = new Map<string, Chan & Record<string, unknown>>();
  let n = 0;
  const calls: { name: string; type?: number; parent?: string; position?: number }[] = [];
  const addChan = (c: Chan) => {
    const full = {
      ...c,
      permissionOverwrites: { cache: new Map() },
      setParent: async (p: string) => { full.parentId = p; },
      setName: async () => {},
      setTopic: async () => {},
      isThread: () => false,
    };
    cache.set(c.id, full);
    return full;
  };
  addChan({ id: MAIN, name: "🖥️ Main", parentId: null, type: 4, position: 3, rawPosition: 3 });
  for (let i = 0; i < paneCount; i++) addChan({ id: `r${i}`, name: `🤖-x${i}`, parentId: MAIN, type: 0, rawPosition: i });
  const g = {
    channels: {
      cache,
      setPositions: async () => {},
      create: async (o: { name: string; type?: number; parent?: string; position?: number }) => {
        calls.push(o);
        create?.(o);
        const id = `new${++n}`;
        return addChan({ id, name: o.name, parentId: o.parent ?? null, type: o.type ?? 0, position: o.position, rawPosition: 0 });
      },
    },
  };
  return { g: g as unknown as Guild, cache, calls, addChan };
}
function splitMirror(cats: Record<string, string[]> = {}) {
  const m = new Mirror(null, file(), new Set());
  m.stackCats = { ...cats };
  m.stacks = () => STACKS;
  m.cards = () => [];
  m.configFile = cfgFile(cats);
  m.threadHome = "";
  return m;
}

describe("paneStack", () => {
  const p = { paneId: "wB:p1", tab: "misc work", name: "main-github-misc-work", cwd: "/tmp" };
  test("a card whose job names the pane wins; open cards before done cards", () => {
    const cards = [
      { id: "old", s: "done", job: "wB:p1", stack: "fun", cts: 9 },
      { id: "new", s: "running", job: "x,wB:p1", stack: "finance", cts: 1 },
      { id: "bad", s: "running", job: "wB:p1", stack: "no-such-stack", cts: 10 },
    ];
    expect(paneStack(p, cards, STACKS)).toBe("finance");
    expect(paneStack({ ...p, tab: "🛠️ Bot upgrades" }, [{ job: ["🛠️ bot upgrades"], stack: "infra" }], STACKS)).toBe("infra");
    // The FIRSTMATE tab is the general stack even when a card names it as job; the word webapp beats a card.
    expect(paneStack({ ...p, tab: "FIRSTMATE" }, [{ job: "firstmate", stack: "realestate", s: "running" }], STACKS)).toBe("firstmate");
    expect(paneStack({ ...p, tab: "webapp prs 24" }, [{ job: "webapp prs 24", stack: "finance" }], STACKS)).toBe("webapp");
  });
  test("the word webapp, then a clear keyword winner in the tab", () => {
    expect(paneStack({ ...p, tab: "📊 webapp phases 1-5" }, [], STACKS)).toBe("webapp");
    expect(paneStack({ ...p, tab: "budget llm first" }, [], STACKS)).toBe("finance");
  });
  test("the deepest stack folder holds the pane (worktrees count); ~/Github alone is too broad", () => {
    const gh = join(homedir(), "Github");
    expect(paneStack({ ...p, cwd: `${gh}/finance/example-webapp-wt-x` }, [], STACKS)).toBe("webapp");
    expect(paneStack({ ...p, cwd: `${gh}/realestate/web` }, [], STACKS)).toBe("realestate");
    expect(paneStack({ ...p, cwd: gh }, [], STACKS)).toBe("firstmate");
  });
  test("category names and config parsing", () => {
    expect(stackCategoryName({ emoji: "💹", name: "finance" }, 0)).toBe("💹 finance");
    expect(stackCategoryName({ emoji: "💹", name: "finance" }, 1)).toBe("💹 finance 2");
    expect(parseStackCategories({ finance: ["123", 5, "x"], bad: "1", empty: [] })).toEqual({ finance: ["123"] });
    expect(DEFAULT_STACKS.some((s) => s.name === "finance")).toBe(true);
  });
});

describe("stack categories", () => {
  test("a new pane gets its stack category: one category create, saved, channel inside it", async () => {
    const m = splitMirror();
    const { g, calls } = guild(CATEGORY_LIMIT);
    await m.apply(g, "main", [pane("a", "budget copy")]);
    expect(calls[0]).toMatchObject({ name: "💹 finance", type: 4, position: 4 });
    expect(calls[1]).toMatchObject({ parent: "new1" });
    expect(m.stackCats).toEqual({ finance: ["new1"] });
    expect(JSON.parse(readFileSync(m.configFile, "utf8")).mirror.stackCategories).toEqual({ finance: ["new1"] });
    expect(m.entries.map((e) => e.channelId)).toEqual(["new2"]);
  });

  test("categories are made one at a time: a second stack in the same minute waits (Main has room: channel goes there)", async () => {
    const m = splitMirror();
    const { g, calls } = guild(3);
    await m.apply(g, "main", [pane("a", "budget copy"), pane("b", "demoapp game")]);
    expect(calls.filter((c) => c.type === 4).map((c) => c.name)).toEqual(["💹 finance"]);
    const b = calls.find((c) => c.name.includes("demoapp"));
    expect(b?.parent).toBe(MAIN);
  });

  test("existing channels move to their stack category, at most MOVES_PER_PASS per pass; pinned stays", async () => {
    const { g, cache, addChan } = guild(0);
    addChan({ id: "T", name: "💹 finance", parentId: null, type: 4, position: 4, rawPosition: 4 });
    addChan({ id: "PIN", name: "📌 Pinned", parentId: null, type: 4, position: 9, rawPosition: 9 });
    const m = splitMirror({ finance: ["T"] });
    const panes = Array.from({ length: MOVES_PER_PASS + 2 }, (_, i) => pane(`p${i}`, `budget ${i}`));
    m.entries = panes.map((p, i) => ({ ...p, channelId: `c${i}`, archived: false }) as MirrorEntry);
    panes.forEach((_, i) => addChan({ id: `c${i}`, name: `💹-budget-${i}`, parentId: MAIN, type: 0, rawPosition: i }));
    const pinned = cache.get(`c${MOVES_PER_PASS + 1}`)!;
    pinned.parentId = "PIN";
    pinned.parent = { name: "📌 Pinned" };
    await m.apply(g, "main", panes);
    expect([...cache.values()].filter((c) => c.parentId === "T").length).toBe(MOVES_PER_PASS);
    await m.apply(g, "main", panes);
    expect([...cache.values()].filter((c) => c.parentId === "T").length).toBe(MOVES_PER_PASS + 1);
    expect(pinned.parentId).toBe("PIN");
  });

  test("a closed pane's channel in 🖥️ Main moves when its stack category exists; no category is made for it", async () => {
    const { g, cache, calls, addChan } = guild(0);
    addChan({ id: "T", name: "💹 finance", parentId: null, type: 4, position: 4, rawPosition: 4 });
    addChan({ id: "c1", name: "💹-budget-1", parentId: MAIN, type: 0, rawPosition: 1 });
    addChan({ id: "c2", name: "🎮-game", parentId: MAIN, type: 0, rawPosition: 2 });
    const m = splitMirror({ finance: ["T"] });
    m.entries = [{ ...pane("a", "budget 1"), channelId: "c1", archived: true }, { ...pane("b", "demoapp game"), channelId: "c2", archived: true }];
    await m.apply(g, "main", []);
    expect(cache.get("c1")!.parentId).toBe("T");
    expect(cache.get("c2")!.parentId).toBe(MAIN);
    expect(calls).toEqual([]);
  });

  test("a full stack category gets an overflow category '<emoji> <stack> 2'", async () => {
    const { g, calls, addChan } = guild(0);
    addChan({ id: "T", name: "💹 finance", parentId: null, type: 4, position: 4, rawPosition: 4 });
    for (let i = 0; i < CATEGORY_LIMIT; i++) addChan({ id: `t${i}`, name: `x${i}`, parentId: "T", type: 0, rawPosition: i });
    const m = splitMirror({ finance: ["T"] });
    await m.apply(g, "main", [pane("a", "budget copy")]);
    expect(calls[0]).toMatchObject({ name: "💹 finance 2", type: 4, position: 5 });
    expect(m.stackCats).toEqual({ finance: ["T", "new1"] });
  });

  test("a deleted stack category id is dropped and saved", async () => {
    const { g } = guild(1);
    const m = splitMirror({ finance: ["GONE"], fun: ["GONE2"] });
    m.createPausedUntil = Date.now() + 60_000;
    await m.apply(g, "main", []);
    expect(m.stackCats).toEqual({});
    expect(JSON.parse(readFileSync(m.configFile, "utf8")).mirror.stackCategories).toEqual({});
  });

  test("no category create while Discord blocks creates; a rate-limited category create pauses creates", async () => {
    const m = splitMirror();
    m.createPausedUntil = Date.now() + 60_000;
    const a = guild(0);
    await m.apply(a.g, "main", [pane("a", "budget copy")]);
    expect(a.calls).toEqual([]);
    const m2 = splitMirror();
    const rl = Object.assign(new Error("rate limited"), { name: "RateLimitError[/guilds/:id/channels]", timeToReset: 3_600_000 });
    const b = guild(0, () => { throw rl; });
    await m2.apply(b.g, "main", [pane("a", "budget copy"), pane("b", "budget two")]);
    expect(b.calls.length).toBe(1); // the category try; no channel create after the pause starts
    expect(m2.createPausedUntil).toBeGreaterThan(Date.now() + 3_000_000);
  });
});

describe("card mirror-create-loop", () => {
  test("a refused create is tried once per pane per hour and alerts FIRSTMATE once", async () => {
    const m = new Mirror(null, file(), new Set());
    m.threadHome = "";
    const fm: string[] = [];
    m.alertFirstmate = (t) => fm.push(t);
    const { g, calls } = guild(0, (o) => { if (o.type !== 4) throw new Error("Invalid Form Body: CHANNEL_PARENT_INVALID"); });
    for (let i = 0; i < 4; i++) await m.apply(g, "main", [pane("a", "x one"), pane("b", "x two")]);
    expect(calls.length).toBe(2); // one try per pane
    expect(fm.length).toBe(1);
    expect(fm[0]).toContain("CHANNEL_PARENT_INVALID");
  });

  test("a deleted 🖥️ Main category is never used as a parent", async () => {
    const m = new Mirror(null, file(), new Set());
    m.threadHome = "";
    m.configFile = cfgFile();
    const { g, cache, calls } = guild(0);
    cache.delete(MAIN);
    cache.set("other", { id: "other", name: "#general", parentId: null, type: 0, rawPosition: 0 } as never);
    await m.apply(g, "main", [pane("a", "x one")]);
    expect(calls.every((c) => c.parent !== MAIN)).toBe(true);
  });
});

describe("review fixes (881edcd)", () => {
  test("Main full + split: two stacks in one pass make ONE category; no '🖥️ Main N' overflow is made", async () => {
    const m = splitMirror();
    const { g, calls } = guild(CATEGORY_LIMIT);
    await m.apply(g, "main", [pane("a", "budget copy"), pane("b", "demoapp game")]);
    expect(calls.filter((c) => c.type === 4).map((c) => c.name)).toEqual(["💹 finance"]);
  });

  test("one failed category create stops category creates for every stack for an hour; one alert", async () => {
    const t0 = Date.now();
    try {
      const m = splitMirror();
      const fm: string[] = [];
      m.alertFirstmate = (t) => fm.push(t);
      const { g, calls } = guild(0, (o) => { if (o.type === 4) throw new Error("Missing Permissions"); });
      await m.apply(g, "main", [pane("a", "budget copy")]);
      setSystemTime(new Date(t0 + 5 * 60_000));
      await m.apply(g, "main", [pane("a", "budget copy"), pane("b", "demoapp game")]);
      expect(calls.filter((c) => c.type === 4).length).toBe(1);
      expect(fm.length).toBe(1);
      setSystemTime(new Date(t0 + 61 * 60_000));
      await m.apply(g, "main", [pane("a", "budget copy"), pane("b", "demoapp game")]);
      expect(calls.filter((c) => c.type === 4).length).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("no category to copy permissions from: no category create, one alert", async () => {
    const m = splitMirror();
    const fm: string[] = [];
    m.alertFirstmate = (t) => fm.push(t);
    const { g, cache, calls } = guild(0);
    cache.delete(MAIN);
    cache.set("other", { id: "other", name: "#general", parentId: null, type: 0, rawPosition: 0 } as never);
    await m.apply(g, "main", [pane("a", "budget copy")]);
    expect(calls.filter((c) => c.type === 4)).toEqual([]);
    expect(fm.join("\n")).toContain("permissions");
  });

  test("a failed move is not retried on the next pass", async () => {
    const { g, cache, addChan } = guild(0);
    addChan({ id: "T", name: "💹 finance", parentId: null, type: 4, position: 4, rawPosition: 4 });
    const ch = addChan({ id: "c1", name: "💹-budget", parentId: MAIN, type: 0, rawPosition: 1 });
    let tries = 0;
    ch.setParent = async () => { tries++; throw new Error("Missing Access"); };
    const m = splitMirror({ finance: ["T"] });
    m.entries = [{ ...pane("a", "budget copy"), channelId: "c1", archived: false }];
    await m.apply(g, "main", [pane("a", "budget copy")]);
    await m.apply(g, "main", [pane("a", "budget copy")]);
    expect(tries).toBe(1);
    expect(cache.get("c1")!.parentId).toBe(MAIN);
  });

  test("a deleted first category: the next one gets an unused name", async () => {
    const { g, calls, addChan } = guild(0);
    addChan({ id: "T2", name: "💹 finance 2", parentId: null, type: 4, position: 4, rawPosition: 4 });
    for (let i = 0; i < CATEGORY_LIMIT; i++) addChan({ id: `t${i}`, name: `x${i}`, parentId: "T2", type: 0, rawPosition: i });
    const m = splitMirror({ finance: ["T2"] });
    await m.apply(g, "main", [pane("a", "budget copy")]);
    expect(calls[0]?.name).toBe("💹 finance 3");
  });
});

describe("category order and tab ids (review follow-up)", () => {
  test("categoryOrder keeps 🖥️ Main and the stack categories together; others keep their order", () => {
    // Live state 19:48Z: webapp 4, Archive 5, firstmate 5, Voice 6, kb 7 ...
    const cats = [
      { id: "10", position: 0 }, { id: "11", position: 1 }, { id: "12", position: 2 }, { id: "20", position: 3 },
      { id: "30", position: 4 }, { id: "13", position: 5 }, { id: "31", position: 5 }, { id: "14", position: 6 }, { id: "32", position: 7 },
    ];
    expect(categoryOrder(cats, ["20", "31", "32", "30"])).toEqual(["10", "11", "12", "20", "31", "32", "30", "13", "14"]);
    expect(categoryOrder(cats, ["99"])).toEqual(["10", "11", "12", "20", "30", "13", "31", "14", "32"]);
  });
  test("a card job may name the pane's Herdr tab id", () => {
    expect(paneStack({ paneId: "wB:p9", tabId: "wB:tHX", tab: "misc", name: "main-misc" }, [{ job: "wB:tHX", stack: "infra" }], STACKS)).toBe("infra");
  });
  test("a new stack category re-orders the categories with one setPositions call", async () => {
    const m = splitMirror();
    const { g, addChan } = guild(0);
    addChan({ id: "900", name: "📦 Archive", parentId: null, type: 4, position: 4, rawPosition: 4 });
    const calls: { channel: string; position: number }[][] = [];
    // Fake guild: record every bulk position call (channel sorts use the same API).
    Object.assign(g.channels, { setPositions: async (p: { channel: string; position: number }[]) => { calls.push(p); } });
    await m.apply(g, "main", [pane("a", "budget copy")]);
    const ids = (calls.find((c) => c.some((x) => x.channel === MAIN)) ?? []).map((x) => x.channel);
    expect(ids.indexOf(MAIN)).toBeLessThan(ids.indexOf("new1"));
    expect(ids.indexOf("new1")).toBeLessThan(ids.indexOf("900")); // 💹 finance sits right after 🖥️ Main, before 📦 Archive
  });
});
