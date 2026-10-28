import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Guild } from "discord.js";
import { ARCHIVE_IDS, CATEGORY_IDS, CATEGORY_LIMIT, channelTitle, Mirror, pickArchive, pickPaneCategory, rateLimitWait, rejectLongChannelCreate, type LivePane, type MirrorEntry } from "../src/mirror.ts";

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
    expect(alerts.length).toBe(1);
    await m.apply(fakeGuild(full), "main", [pane("a")]);
    expect(alerts.length).toBe(1); // once per category
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
  test("a full category makes no Discord call at all (owner 2026-10-24: 4,062 retries caused a 17 h rate limit)", async () => {
    const m = new Mirror(null, file(), new Set());
    const full = Array.from({ length: CATEGORY_LIMIT }, (_, i) => ({ id: `c${i}`, parentId: CATEGORY_IDS.main ?? "" }));
    const g = countingGuild(full, async () => ({ id: "new" }));
    await m.apply(g, "main", [pane("a")]);
    await m.apply(g, "main", [pane("a")]);
    expect(g.channels.calls).toBe(0);
    expect(m.entries).toEqual([]);
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
    const counts: Record<string, number> = { main: CATEGORY_LIMIT, rig2: 7 };
    expect(pickPaneCategory(["main", "rig2"], (id) => counts[id] ?? 0)).toBe("primary2");
    expect(pickPaneCategory(["main"], (id) => counts[id] ?? 0)).toBeUndefined();
  });
});

describe("topic emoji", () => {
  test("local-omp channels get 🧠", () => {
    expect(channelTitle("local-omp", "main")).toBe("🧠-local-omp");
    expect(channelTitle("main-github-local-omp-channel", "main")).toBe("🧠-main-github-local-omp-channel");
  });
});
