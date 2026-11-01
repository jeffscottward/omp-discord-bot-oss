import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Guild } from "discord.js";
import { CONFIG } from "../src/config.ts";
import { ARCHIVE_IDS, CATEGORY_IDS, CATEGORY_LIMIT, channelTitle, Mirror, OVERFLOW_IDS, OVERFLOW_IDS_SECOND, overflowName, pickArchive, pickPaneCategory, rateLimitWait, rejectLongChannelCreate, type LivePane, type MirrorEntry } from "../src/mirror.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "mirror-archive-")), "agents.json");
const pane = (id: string, name = `p-${id}`): LivePane => ({ machine: "main", paneId: id, tabId: `t-${id}`, workspace: "w", tab: name, name, cwd: "/x", sessionFile: null });
const entry = (id: string, channelId: string): MirrorEntry => ({ ...pane(id), channelId, archived: false });

/** Fake guild: channels.create always fails (category full); setParent can fail. */
function fakeGuild(chans: { id: string; parentId: string | null }[], setParentOk = true) {
  const cache = new Map(
    chans.map((c) => [c.id, { ...c, name: "x", topic: "", type: 0, rawPosition: 0, setParent: async () => { if (!setParentOk) throw new Error("Maximum number of channels in category reached (50)"); }, setName: async () => {}, setTopic: async () => {} }]),
  );
  return { channels: { cache, create: async () => { throw new Error("Maximum number of channels in category reached (50)"); }, setPositions: async () => {} } } as unknown as Guild;
}

/** Fake guild whose channels.create runs `create` and counts calls. */
function countingGuild(chans: { id: string; parentId: string | null }[], create: (o: { parent?: string }) => Promise<unknown>) {
  const g = fakeGuild(chans) as unknown as { channels: { create: unknown; calls: number } };
  g.channels.calls = 0;
  g.channels.create = async (o: { parent?: string }) => {
    g.channels.calls++;
    return create(o);
  };
  return g as unknown as Guild & { channels: { calls: number } };
}

describe("archive category pick", () => {
  test("first archive category with fewer than 50 channels wins", () => {
    const counts: Record<string, number> = { a: CATEGORY_LIMIT, b: 3 };
    expect(pickArchive(["a", "b"], (id) => counts[id] ?? 0)).toBe("b");
    expect(pickArchive(["a", "b"], () => 10)).toBe("a");
    expect(pickArchive(["a"], () => CATEGORY_LIMIT)).toBeUndefined();
  });
});

describe("detached channels", () => {
  test("a detached channel keeps its pane (no new channel) and is never updated or archived", () => {
    const m = new Mirror(null, file(), new Set(["D"]));
    m.entries = [entry("p1", "D"), entry("p2", "C2")];
    const live = m.plan("main", [pane("p1"), pane("p2")]);
    expect(live.create).toEqual([]);
    expect(live.update.map((u) => u.e.channelId)).toEqual(["C2"]);
    const gone = m.plan("main", []);
    expect(gone.archive.map((e) => e.channelId)).toEqual(["C2"]);
    expect(m.byChannel("D")).toBeUndefined(); // thread/parent lookups never route a detached channel to a pane
    expect(m.byChannel("C2")?.channelId).toBe("C2");
  });
});

describe("category limit", () => {
  test("a failed channel create does not stop the sync pass and alerts once", async () => {
    const m = new Mirror(null, file(), new Set());
    const alerts: string[] = [];
    m.alert = (t) => alerts.push(t);
    const full = Array.from({ length: CATEGORY_LIMIT }, (_, i) => ({ id: `c${i}`, parentId: "" }));
    await m.apply(fakeGuild(full), "main", [pane("a"), pane("b")]);
    expect(m.entries).toEqual([]);
    expect(alerts.length).toBe(2); // category-full alert + one failed overflow-category try;
    await m.apply(fakeGuild(full), "main", [pane("a")]);
    expect(alerts.length).toBe(2); // owner 2026-10-30: category now counts as full, so one overflow-category try (fails here) alerts once
    await m.apply(fakeGuild(full), "main", [pane("a")]);
    expect(alerts.length).toBe(2); // no repeat within the hour
  });
  test("a closed pane is marked archived in place: no move, no alert (owner 2026-10-23: archive = delete later)", async () => {
    const m = new Mirror(null, file(), new Set());
    const alerts: string[] = [];
    m.alert = (t) => alerts.push(t);
    m.entries = [entry("gone", "G")];
    await m.apply(fakeGuild([{ id: "G", parentId: "primarycat" }], false), "main", []);
    expect(m.entries[0]!.archived).toBe(true);
    expect(alerts).toEqual([]);
  });
  test("ARCHIVE_IDS drops empty ids", () => {
    expect(ARCHIVE_IDS.every(Boolean)).toBe(true);
  });
  test("every pane category full: the next '🖥️ Main N' category is made with the same overwrites and saved (owner 2026-10-28)", async () => {
    const m = new Mirror(null, file(), new Set());
    const cfg = join(mkdtempSync(join(tmpdir(), "mirror-cfg-")), "config.json");
    writeFileSync(cfg, JSON.stringify({ guildId: "g", mirror: { categories: { local: CATEGORY_IDS.main }, overflow: [] } }));
    m.configFile = cfg;
    const alerts: string[] = [];
    m.alert = (t) => alerts.push(t);
    const full = Array.from({ length: CATEGORY_LIMIT }, (_, i) => ({ id: `c${i}`, parentId: CATEGORY_IDS.main ?? "" }));
    const made: { name?: string; type?: number; parent?: string; position?: number; permissionOverwrites?: unknown[] }[] = [];
    const g = countingGuild(full, async (o) => {
      made.push(o);
      return { id: `new${made.length}` };
    });
    const ow = { id: "bot", type: 1, allow: { bitfield: 1049600n }, deny: { bitfield: 0n } };
    g.channels.cache.set(CATEGORY_IDS.main!, { id: CATEGORY_IDS.main, name: "🖥️ Main", parentId: null, type: 4, position: 2, permissionOverwrites: { cache: new Map([["bot", ow]]) } } as never);
    try {
      await m.apply(g, "main", [pane("a")]);
      expect(made[0]).toMatchObject({ name: "🖥️ Main 2", type: 4, position: 3, permissionOverwrites: [{ id: "bot", type: 1, allow: 1049600n, deny: 0n }] });
      expect(made[1]!.parent).toBe("new1"); // the pane channel goes into the new category
      expect(m.entries.map((e) => e.channelId)).toEqual(["new2"]);
      expect(OVERFLOW_IDS).toContain("new1");
      expect(JSON.parse(readFileSync(cfg, "utf8")).mirror.overflow).toEqual(["new1"]);
      expect(alerts.join("\n")).toContain("🖥️ Main 2");
    } finally {
      OVERFLOW_IDS.splice(OVERFLOW_IDS.indexOf("new1"), 1);
    }
  });
  test("a failed overflow-category create alerts once and is not retried within the hour", async () => {
    const m = new Mirror(null, file(), new Set());
    m.configFile = "/nonexistent/never-written.json";
    const alerts: string[] = [];
    m.alert = (t) => alerts.push(t);
    const full = Array.from({ length: CATEGORY_LIMIT }, (_, i) => ({ id: `c${i}`, parentId: CATEGORY_IDS.main ?? "" }));
    const g = countingGuild(full, async () => {
      throw new Error("Missing Permissions");
    });
    // A real guild cache holds the 🖥️ Main category (a new category copies its permissions).
    g.channels.cache.set(CATEGORY_IDS.main!, { id: CATEGORY_IDS.main, name: "🖥️ Main", parentId: null, type: 4, position: 2, permissionOverwrites: { cache: new Map() } } as never);
    await m.apply(g, "main", [pane("a")]);
    await m.apply(g, "main", [pane("a")]);
    expect(g.channels.calls).toBe(1);
    expect(m.entries).toEqual([]);
    expect(alerts.length).toBe(2); // the overflow failure + the category-full notice, each once
  });
  test("overflowName counts on from the base name", () => {
    expect(overflowName("🖥️ Main", 2)).toBe("🖥️ Main 3");
    expect(overflowName("🖥️ Main 2", 1)).toBe("🖥️ Main 2");
  });
  test("a long rate limit pauses creates: one call, then none until the pause ends", async () => {
    const m = new Mirror(null, file(), new Set());
    const alerts: string[] = [];
    m.alert = (t) => alerts.push(t);
    const rl = Object.assign(new Error("rate limited"), { name: "RateLimitError[/guilds/:id/channels]", timeToReset: 3_600_000 });
    const g = countingGuild([], async () => { throw rl; });
    const before = Date.now();
    await m.apply(g, "main", [pane("a"), pane("b")]);
    expect(g.channels.calls).toBe(1); // b is skipped: the pause is already known
    expect(m.createPausedUntil).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(alerts.length).toBe(1);
    await m.apply(g, "main", [pane("a"), pane("b")]);
    expect(g.channels.calls).toBe(1);
    m.createPausedUntil = Date.now() - 1;
    const ok = countingGuild([], async () => ({ id: "made" }));
    await m.apply(ok, "main", [pane("a")]);
    expect(ok.channels.calls).toBe(1);
    expect(m.entries.map((e) => e.channelId)).toEqual(["made"]);
  });
  test("rate-limit filter rejects only long channel-create waits", () => {
    expect(rejectLongChannelCreate({ method: "POST", route: "/guilds/:id/channels", timeToReset: 41_089_017 })).toBe(true);
    expect(rejectLongChannelCreate({ method: "POST", route: "/guilds/:id/channels", timeToReset: 2_000 })).toBe(false);
    expect(rejectLongChannelCreate({ method: "PATCH", route: "/channels/:id", timeToReset: 600_000 })).toBe(false);
    expect(rateLimitWait(Object.assign(new Error("x"), { name: "RateLimitError[/x]", timeToReset: 5 }))).toBe(5);
    expect(rateLimitWait(new Error("Maximum number of channels"))).toBeNull();
  });
  test("overflow categories are used in order when the main one is full", () => {
    const counts: Record<string, number> = { main: CATEGORY_LIMIT, main2: 7 };
    expect(pickPaneCategory(["main", "main2"], (id) => counts[id] ?? 0)).toBe("main2");
    expect(pickPaneCategory(["main"], (id) => counts[id] ?? 0)).toBeUndefined();
  });
});

describe("topic emoji", () => {
  test("local-omp channels get 🧠", () => {
    expect(channelTitle("local-omp", "main")).toBe("🧠-local-omp");
    expect(channelTitle("main-github-local-omp-channel", "main")).toBe("🧠-main-github-local-omp-channel");
  });
});

describe("owner 2026-10-30: a full category never leaves a job without a channel", () => {
  const cfgFile = () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "mirror-cfg-")), "config.json");
    writeFileSync(cfg, JSON.stringify({ guildId: "g", mirror: { overflow: [], overflowSecond: [] } }));
    return cfg;
  };
  test("second pane category full: a second overflow category is made and saved under overflowSecond", async () => {
    const m = new Mirror(null, join(mkdtempSync(join(tmpdir(), "mirror-")), "m.json"), new Set());
    m.configFile = cfgFile();
    const secondCat = CATEGORY_IDS.second || "secondcat";
    const full = Array.from({ length: CATEGORY_LIMIT }, (_, i) => ({ id: `m${i}`, parentId: secondCat }));
    const made: { name?: string; parent?: string }[] = [];
    const g = countingGuild(full, async (o) => { made.push(o); return { id: `mnew${made.length}` }; });
    g.channels.cache.set(secondCat, { id: secondCat, name: "💻 Second", parentId: null, type: 4, position: 5, permissionOverwrites: { cache: new Map() } } as never);
    try {
      await m.apply(g, "second", [{ ...pane("a"), machine: "second" }]);
      expect(made[0]).toMatchObject({ name: "💻 Second 2" });
      expect(made[1]!.parent).toBe("mnew1");
      expect(JSON.parse(readFileSync(m.configFile, "utf8")).mirror.overflowSecond).toEqual(["mnew1"]);
    } finally {
      OVERFLOW_IDS_SECOND.splice(0);
    }
  });
  test("Discord says 'maximum number' while the cache count is low: next pass uses a new overflow category", async () => {
    const m = new Mirror(null, join(mkdtempSync(join(tmpdir(), "mirror-")), "m.json"), new Set());
    m.configFile = cfgFile();
    const main = CATEGORY_IDS.main || "rigcat";
    const made: { name?: string; parent?: string }[] = [];
    const g = countingGuild([], async (o) => {
      if (o.parent === main) throw new Error("Maximum number of channels in category reached (50)");
      made.push(o);
      return { id: `rnew${made.length}` };
    });
    g.channels.cache.set(main, { id: main, name: "🖥️ Main", parentId: null, type: 4, position: 2, permissionOverwrites: { cache: new Map() } } as never);
    try {
      await m.apply(g, "main", [pane("a")]);
      expect(m.entries.length).toBe(0);
      await m.apply(g, "main", [pane("a")]);
      expect(made[0]).toMatchObject({ name: "🖥️ Main 2" });
      expect(made[1]!.parent).toBe("rnew1");
      expect(m.entries.map((e) => e.channelId)).toEqual(["rnew2"]);
    } finally {
      OVERFLOW_IDS.splice(OVERFLOW_IDS.indexOf("rnew1"), 1);
    }
  });
});

describe("owner 2026-10-30: thread fallback when channel creates are blocked", () => {
  /** Fake guild with a 🧵 jobs channel H; channel creates succeed unless `blocked`. */
  function threadGuild() {
    const sent: { id: string; text: string }[] = [];
    const archived: string[] = [];
    const cache = new Map<string, unknown>();
    let n = 0;
    const thread = (id: string, name: string) => ({
      id, name, parentId: "H", type: 11, isThread: () => true,
      send: async (o: { content: string }) => { sent.push({ id, text: o.content }); },
      setArchived: async () => { archived.push(id); },
    });
    cache.set("H", { id: "H", name: "🧵-jobs", parentId: null, type: 0, rawPosition: 0, threads: { create: async (o: { name: string }) => { const t = thread(`T${++n}`, o.name); cache.set(t.id, t); return t; } } });
    // The 🖥️ Main category exists (a real guild cache holds every category; a missing one is never a create target).
    cache.set(CATEGORY_IDS.main!, { id: CATEGORY_IDS.main, name: "🖥️ Main", parentId: null, type: 4, position: 2, rawPosition: 2, permissionOverwrites: { cache: new Map() } });
    const g = { channels: { cache, setPositions: async () => {}, create: async (o: { name: string }) => { const c = { id: `C${++n}`, name: o.name, parentId: CATEGORY_IDS.main, type: 0, rawPosition: 0, topic: "", setName: async () => {}, setTopic: async () => {}, setParent: async () => {} }; cache.set(c.id, c); return c; } } };
    return { g: g as unknown as Guild, sent, archived };
  }

  test("pause -> thread; resume -> channel, link, remap, archived thread", async () => {
    const f = file();
    const m = new Mirror(null, f, new Set());
    m.threadHome = "H";
    m.createPausedUntil = Date.now() + 3_600_000;
    const { g, sent, archived } = threadGuild();
    await m.apply(g, "main", [pane("a")]);
    expect(m.entries).toHaveLength(1);
    const e = m.entries[0]!;
    expect(e.threadOnly).toBe(true);
    expect(e.channelId).toMatch(/^T/);
    expect(m.resolve(e.channelId, "H")).toEqual({ entry: e, threadId: null }); // the thread is the pane's own channel
    expect(sent[0]?.text).toContain("Mirrors Herdr main:a");
    const threadId = e.channelId;
    await m.apply(g, "main", [pane("a")]); // still paused: keeps the thread, no new one
    expect(e.channelId).toBe(threadId);
    m.createPausedUntil = Date.now() - 1;
    await m.apply(g, "main", [pane("a")]);
    expect(e.channelId).toMatch(/^C/);
    expect(e.threadOnly).toBeUndefined();
    expect(sent.some((s) => s.id === threadId && s.text.includes(`<#${e.channelId}>`))).toBe(true);
    expect(archived).toContain(threadId);
  });

  test("a restart keeps the create pause and thread-only entries", async () => {
    const f = file();
    const m = new Mirror(null, f, new Set());
    m.threadHome = "H";
    const until = Date.now() + 3_600_000;
    m.createPausedUntil = until;
    const { g } = threadGuild();
    await m.apply(g, "main", [pane("a")]);

    writeFileSync(f, JSON.stringify(m.entries));
    const again = new Mirror(null, f, new Set());
    expect(again.createPausedUntil).toBe(until);
    expect(again.entries[0]?.threadOnly).toBe(true);
  });

  test("no thread home: the pane is skipped, no create call", async () => {
    const m = new Mirror(null, file(), new Set());
    m.threadHome = "";
    m.createPausedUntil = Date.now() + 3_600_000;
    const g = countingGuild([], async () => ({ id: "X" }));
    await m.apply(g, "main", [pane("a")]);
    expect(m.entries).toHaveLength(0);
    expect(g.channels.calls).toBe(0);
  });

  test("owner 2026-10-31: no mirror.threadHome -> the thread opens in #omp-alerts (alertsChannelId)", async () => {
    const saved = CONFIG.alertsChannelId;
    CONFIG.alertsChannelId = "H"; // the fake guild's text channel H stands for #omp-alerts
    try {
      const m = new Mirror(null, file(), new Set());
      m.threadHome = "";
      m.createPausedUntil = Date.now() + 3_600_000;
      const { g, sent } = threadGuild();
      await m.apply(g, "main", [pane("a")]);
      expect(m.entries).toHaveLength(1);
      const e = m.entries[0]!;
      expect(e.threadOnly).toBe(true);
      expect(g.channels.cache.get(e.channelId)).toMatchObject({ parentId: "H" });
      expect(sent[0]?.text).toContain("Mirrors Herdr main:a");
    } finally {
      CONFIG.alertsChannelId = saved;
    }
  });

  test("neither mirror.threadHome nor alertsChannelId: the pane is skipped, no thread create", async () => {
    const saved = CONFIG.alertsChannelId;
    CONFIG.alertsChannelId = "";
    try {
      const m = new Mirror(null, file(), new Set());
      m.threadHome = "";
      m.createPausedUntil = Date.now() + 3_600_000;
      const { g, sent } = threadGuild();
      await m.apply(g, "main", [pane("a")]);
      expect(m.entries).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect([...g.channels.cache.keys()].some((k) => k.startsWith("T"))).toBe(false);
    } finally {
      CONFIG.alertsChannelId = saved;
    }
  });
});

describe("owner 2026-10-30: refused creates are not retried every pass", () => {
  test("thread home and thread-to-channel move each try once per backoff window", async () => {
    const m = new Mirror(null, file(), new Set());
    m.threadHome = "";
    const g = countingGuild([], async () => { throw new Error("Missing Permissions"); });
    expect(await m.threadHomeChannel(g)).toBeUndefined();
    expect(await m.threadHomeChannel(g)).toBeUndefined();
    expect(g.channels.calls).toBe(0); // owner 2026-10-31: never creates a 🧵-jobs channel; threads open in #omp-alerts;
    m.entries = [{ ...entry("a", "T1"), threadOnly: true }];
    (g.channels.cache as Map<string, unknown>).set("T1", { id: "T1", isThread: () => true });
    (g.channels.cache as Map<string, unknown>).set(CATEGORY_IDS.main!, { id: CATEGORY_IDS.main, name: "🖥️ Main", parentId: null, type: 4, position: 2, permissionOverwrites: { cache: new Map() } });
    const before = g.channels.calls;
    await m.apply(g, "main", [pane("a")]);
    await m.apply(g, "main", [pane("a")]);
    expect(g.channels.calls - before).toBe(1);
    expect(m.entries[0]?.channelId).toBe("T1");
  });
});

describe("owner 2026-10-30: review fixes for the thread fallback", () => {
  test("a refused thread create is not retried on the next pass", async () => {
    const m = new Mirror(null, file(), new Set());
    m.threadHome = "H";
    m.createPausedUntil = Date.now() + 3_600_000;
    let tries = 0;
    const g = countingGuild([], async () => ({ id: "X" }));
    (g.channels.cache as Map<string, unknown>).set("H", { id: "H", type: 0, parentId: null, name: "🧵-jobs", rawPosition: 0, threads: { create: async () => { tries++; throw new Error("Missing Permissions"); } } });
    await m.apply(g, "main", [pane("a")]);
    await m.apply(g, "main", [pane("a")]);
    expect(tries).toBe(1);
    expect(g.channels.calls).toBe(0);
  });

  test("long rate limits on thread creates fail at once", () => {
    expect(rejectLongChannelCreate({ method: "POST", route: "/channels/:id/threads", timeToReset: 600_000 })).toBe(true);
    expect(rejectLongChannelCreate({ method: "POST", route: "/channels/:id/threads", timeToReset: 2_000 })).toBe(false);
  });

  test("an open wait card moves with the pane to its new channel", async () => {
    const m = new Mirror(null, file(), new Set());
    const created: string[] = [];
    const g = countingGuild([], async () => { created.push("C9"); return { id: "C9" }; });
    m.entries = [{ ...entry("a", "T1"), threadOnly: true, wait: { nonce: "n", kind: "question", ts: 1, rec: "r", question: "q?", msgId: "M1" } as MirrorEntry["wait"] }];
    await m.apply(g, "main", [pane("a")]);
    expect(m.entries[0]?.channelId).toBe("C9");
    expect(m.entries[0]?.wait?.nonce).toBe("n");
    expect(m.entries[0]?.wait?.msgId).toBeUndefined();
  });
});
