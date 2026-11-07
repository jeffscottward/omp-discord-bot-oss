// Card server-full-auto-drop (owner 2026-11-07): "Always use a Discord channel. ALWAYS. If at capacity, make a new
// category; if the server is full, run a sweep and drop the 10 oldest channels."
import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, Guild } from "discord.js";
import { CATEGORY_IDS, Mirror, parseSweepOutput, parseSweepRun, SERVER_SWEEP_MAX, serverChannelCount, type LivePane, type MirrorEntry, type ServerSweepResult } from "../src/mirror.ts";
import { mergeStacks } from "../src/router.ts";

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterEach(() => setSystemTime());

const pane = (id: string, name = `p-${id}`): LivePane => ({ machine: "main", paneId: id, tabId: `t-${id}`, workspace: "w", tab: name, name, cwd: "/x", sessionFile: null });
const FULL = "Maximum number of server channels reached (500)";

/**
 * Fake guild at the server limit: a thread home H, the 🖥️ Main category and `fill` other channels. channels.create
 * refuses with Discord's 30013 text while the cache holds 500 channels (or `refuse` more times), else makes C<n>.
 */
function fullGuild(fill: number, refuse = 0) {
  const cache = new Map<string, unknown>();
  let n = 0;
  const calls = { create: 0 };
  cache.set("H", { id: "H", name: "omp-alerts", parentId: null, type: 0, rawPosition: 0, threads: { create: async (o: { name: string }) => {
    const t = { id: `T${++n}`, name: o.name, parentId: "H", type: 11, isThread: () => true, send: async () => {}, setArchived: async () => {} };
    cache.set(t.id, t);
    return t;
  } } });
  cache.set(CATEGORY_IDS.main!, { id: CATEGORY_IDS.main, name: "🖥️ Main", parentId: null, type: 4, position: 2, rawPosition: 2, permissionOverwrites: { cache: new Map() } });
  for (let i = 0; i < fill; i++) cache.set(`F${i}`, { id: `F${i}`, name: `f${i}`, parentId: "OTHER", type: 0, rawPosition: 0, topic: "", setName: async () => {}, setTopic: async () => {}, setParent: async () => {} });
  const g = {
    channels: {
      cache,
      setPositions: async () => {},
      create: async (o: { name: string }) => {
        calls.create++;
        if (refuse > 0 || serverChannelCount(g as unknown as Guild) >= 500) {
          refuse--;
          throw new Error(FULL);
        }
        const c = { id: `C${++n}`, name: o.name, parentId: CATEGORY_IDS.main, type: 0, rawPosition: 0, topic: "", setName: async () => {}, setTopic: async () => {}, setParent: async () => {} };
        cache.set(c.id, c);
        return c;
      },
    },
  };
  return { g: g as unknown as Guild, cache, calls };
}

function mirror() {
  const dir = tempDir("server-full-");
  const m = new Mirror(null, join(dir, "agents.json"), new Set());
  m.threadHome = "H";
  m.stackCats = null;
  m.configFile = join(dir, "config.json");
  writeFileSync(m.configFile, "{}");
  const alerts: string[] = [];
  m.alert = (t) => void alerts.push(t);
  m.alertFirstmate = (t) => void alerts.push(t);
  let sweeps = 0;
  const holds: string[][] = [];
  const sweepWith = (fn: () => ServerSweepResult) => {
    m.serverSweep = async (hold) => {
      sweeps++;
      holds.push(hold);
      return fn();
    };
  };
  return { m, alerts, sweepWith, sweeps: () => sweeps, holds };
}

describe("review 2026-11-07: the sweep never deletes a channel the bot uses", () => {
  test("a pane matched again in this pass (entry still archived on disk) and live panes are passed as --hold", async () => {
    const { m, sweepWith, holds } = mirror();
    const { g } = fullGuild(498);
    // F5: the old channel of tab t-b (pane closed, then a new pane id in the same tab); F6: a live pane.
    m.entries = [
      { ...pane("old-b", "p-b"), tabId: "t-b", channelId: "F5", archived: true },
      { ...pane("c"), channelId: "F6", archived: false },
    ];
    sweepWith(() => ({ ids: ["F1"], names: ["x"] }));
    await m.apply(g, "main", [pane("a"), { ...pane("b"), tabId: "t-b" }, pane("c")]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toContain("F5");
    expect(holds[0]).toContain("F6");
    expect(holds[0]).not.toContain("F1");
  });
});

describe("owner 2026-11-07: a full server sweeps, then the job gets a real channel", () => {
  test("500 channels: the sweep drops 10, the channel is created in the same pass (no thread)", async () => {
    const { m, alerts, sweepWith, sweeps } = mirror();
    const { g, cache, calls } = fullGuild(498); // + H + 🖥️ Main = 500
    const ids = Array.from({ length: SERVER_SWEEP_MAX }, (_, i) => `F${i}`);
    sweepWith(() => ({ ids, names: ids.map((id) => `old-${id}`) }));
    await m.apply(g, "main", [pane("a")]);
    expect(sweeps()).toBe(1);
    expect(m.entries[0]?.channelId).toMatch(/^C/);
    expect(m.entries[0]?.threadOnly).toBeUndefined();
    expect(calls.create).toBe(1);
    for (const id of ids) expect(cache.has(id)).toBe(false);
    expect(serverChannelCount(g)).toBe(491);
    const sweepAlert = alerts.filter((a) => a.startsWith("🧹"));
    expect(sweepAlert).toHaveLength(1);
    expect(sweepAlert[0]).toContain("#old-F0");
    expect(sweepAlert[0]).toContain("#old-F9");
  });

  test("Discord says full while the cache count is lower: sweep, then create again right away", async () => {
    const { m, sweepWith, sweeps } = mirror();
    const { g, calls } = fullGuild(100, 1);
    sweepWith(() => ({ ids: ["F1", "F2"], names: ["a", "b"] }));
    await m.apply(g, "main", [pane("a")]);
    expect(sweeps()).toBe(1);
    expect(calls.create).toBe(2);
    expect(m.entries[0]?.channelId).toMatch(/^C/);
    expect(m.entries[0]?.threadOnly).toBeUndefined();
  });

  test("nothing deletable: a thread meanwhile, no create storm, and the move to a channel as soon as a slot exists", async () => {
    const { m, alerts, sweepWith, sweeps } = mirror();
    const { g, cache, calls } = fullGuild(498);
    sweepWith(() => ({ ids: [], names: [] }));
    await m.apply(g, "main", [pane("a")]);
    const e = m.entries[0]!;
    expect(e.threadOnly).toBe(true);
    expect(calls.create).toBe(0); // the precheck saw 500/500: no refused create sent
    expect(alerts.some((a) => a.includes("no channel it may delete"))).toBe(true);
    await m.apply(g, "main", [pane("a")]);
    expect(sweeps()).toBe(1); // one sweep per window
    expect(calls.create).toBe(0);
    expect(e.threadOnly).toBe(true);
    // Someone frees slots (hourly cleanup, hand delete): the next pass moves the pane to a channel, no hour wait.
    for (let i = 0; i < 20; i++) cache.delete(`F${i}`);
    await m.apply(g, "main", [pane("a")]);
    expect(e.channelId).toMatch(/^C/);
    expect(e.threadOnly).toBeUndefined();
    expect(calls.create).toBe(1);
  });

  test("496 channels and nothing deletable: the sweep runs, and the channel is still created (Discord has room)", async () => {
    const { m, sweepWith, sweeps } = mirror();
    const { g, calls } = fullGuild(494); // + H + 🖥️ Main = 496
    sweepWith(() => ({ ids: [], names: [] }));
    await m.apply(g, "main", [pane("a")]);
    expect(sweeps()).toBe(1);
    expect(calls.create).toBe(1);
    expect(m.entries[0]?.channelId).toMatch(/^C/);
    expect(m.entries[0]?.threadOnly).toBeUndefined();
  });

  test("a script that reports more than 10: every id leaves the cache and #omp-alerts hears it loudly", async () => {
    const { m, alerts, sweepWith } = mirror();
    const { g, cache } = fullGuild(498);
    const ids = Array.from({ length: 14 }, (_, i) => `F${i}`);
    sweepWith(() => ({ ids, names: ids }));
    expect(await m.sweepServer(g, "test")).toBe(14);
    expect(ids.filter((id) => cache.has(id))).toEqual([]);
    expect(alerts.some((a) => a.startsWith("🚨") && a.includes("14 channels"))).toBe(true);
  });

  test("single flight: concurrent callers share one sweep; a throwing sweep never sticks", async () => {
    const { m, sweepWith, sweeps } = mirror();
    const { g } = fullGuild(10);
    sweepWith(() => ({ ids: ["F1"], names: ["a"] }));
    const [a, b] = await Promise.all([m.sweepServer(g, "one"), m.sweepServer(g, "two")]);
    expect([a, b, sweeps()]).toEqual([1, 1, 1]);
    expect(await m.sweepServer(g, "inside the window")).toBe(1); // the last sweep's count, no new run
    expect(sweeps()).toBe(1);
    const m2 = mirror();
    m2.m.serverSweep = () => {
      throw new Error("sync boom");
    };
    expect(await m2.m.sweepServer(g, "x")).toBe(0);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    m2.sweepWith(() => ({ ids: ["F2"], names: ["b"] }));
    expect(await m2.m.sweepServer(g, "after the window")).toBe(1);
  });

  test("parseSweepOutput / parseSweepRun: JSON after skip lines, dry run deletes nothing, stderr names a crashed run", () => {
    const out = `skip /channels/1: already gone (404)\n${JSON.stringify({ dryRun: false, deletedIds: ["1", "2"], deletedNames: ["a", "b"] }, null, 1)}\n`;
    expect(parseSweepOutput(out)).toEqual({ ids: ["1", "2"], names: ["a", "b"] });
    expect(parseSweepOutput(JSON.stringify({ dryRun: true, deletedIds: ["1"], deletedNames: ["a"] }))).toEqual({ ids: [], names: [] });
    expect(() => parseSweepOutput("boom")).toThrow();
    expect(parseSweepRun(out, "dropped 1 a\ndropped 2 b\n")).toEqual({ r: { ids: ["1", "2"], names: ["a", "b"] }, parsed: true });
    expect(parseSweepRun("", "dropped 7 🤖-old-job\nTraceback ...\n")).toEqual({ r: { ids: ["7"], names: ["🤖-old-job"] }, parsed: false });
  });
});

describe("owner 2026-11-07: split mode (live config: stack categories), the job's stack category full", () => {
  const STACKS = mergeStacks([{ name: "firstmate", emoji: "👷", keywords: [], areas: ["firstmate"], cwd: "~/Github" }]);
  const MAINCAT = CATEGORY_IDS.main!;
  /** 500 channels: 🖥️ Main (50 inside), webapp category V1 (50 inside), thread home H, fillers. `refuseCat`: Discord 30013 on the first category create. */
  function splitGuild(refuseCat: boolean | "always" = false) {
    const cache = new Map<string, Record<string, unknown>>();
    const created: { type?: number; parent?: string; id: string }[] = [];
    const tries = { cat: 0 };
    let n = 0;
    const add = (c: { id: string; name: string; parentId: string | null; type: number; position?: number }) => {
      const full: Record<string, unknown> = { ...c, rawPosition: c.position ?? 0, topic: "", permissionOverwrites: { cache: new Map() }, isThread: () => false, setParent: async (p: string) => void (full.parentId = p), setName: async () => {}, setTopic: async () => {}, edit: async () => {} };
      cache.set(c.id, full);
      return full;
    };
    add({ id: MAINCAT, name: "🖥️ Main", parentId: null, type: 4, position: 3 });
    add({ id: "V1", name: "📊 webapp", parentId: null, type: 4, position: 4 });
    add({ id: "H", name: "omp-alerts", parentId: null, type: 0 });
    (cache.get("H") as Record<string, unknown>).threads = { create: async () => ({ id: "T1", isThread: () => true, send: async () => {}, setArchived: async () => {} }) };
    for (let i = 0; i < 50; i++) add({ id: `r${i}`, name: `r${i}`, parentId: MAINCAT, type: 0 });
    for (let i = 0; i < 50; i++) add({ id: `v${i}`, name: `v${i}`, parentId: "V1", type: 0 });
    for (let i = 0; cache.size < 500; i++) add({ id: `F${i}`, name: `f${i}`, parentId: "OTHER", type: 0 });
    const g = {
      channels: {
        cache,
        setPositions: async () => {},
        create: async (o: { name: string; type?: number; parent?: string; position?: number }) => {
          if (o.type === 4) tries.cat++;
          if (serverChannelCount(g as unknown as Guild) >= 500 || (refuseCat && o.type === 4)) {
            if (o.type === 4 && refuseCat !== "always") refuseCat = false;
            throw new Error(FULL);
          }
          const id = `new${++n}`;
          created.push({ type: o.type, parent: o.parent, id });
          return add({ id, name: o.name, parentId: o.parent ?? null, type: o.type ?? 0, position: o.position });
        },
      },
    };
    return { g: g as unknown as Guild, created, tries };
  }
  function splitMirror() {
    const r = mirror();
    r.m.stackCats = { webapp: ["V1"] };
    r.m.stacks = () => STACKS;
    r.m.cards = () => [];
    writeFileSync(r.m.configFile, JSON.stringify({ guildId: "g", mirror: { overflow: [], stackCategories: { webapp: ["V1"] } } }));
    const ids = Array.from({ length: SERVER_SWEEP_MAX }, (_, i) => `F${i}`);
    r.sweepWith(() => ({ ids, names: ids }));
    return r;
  }

  test("500 channels: one sweep, the next stack category and the channel in the same pass, no thread", async () => {
    const { m, sweeps } = splitMirror();
    const { g, created } = splitGuild();
    await m.apply(g, "main", [pane("a", "webapp chart job")]);
    expect(sweeps()).toBe(1);
    const cat = created.find((c) => c.type === 4);
    expect(cat).toBeDefined();
    const e = m.entries[0]!;
    expect(e.threadOnly).toBeUndefined();
    expect(created.find((c) => c.id === e.channelId)?.parent).toBe(cat!.id);
    expect(m.stackCats?.webapp).toEqual(["V1", cat!.id]);
  });

  test("Discord 30013 on the category create (cache count lower): sweep, category and channel in the same pass", async () => {
    const { m, sweeps } = splitMirror();
    const { g, created } = splitGuild(true);
    for (let i = 20; i < 40; i++) g.channels.cache.delete(`F${i}`); // cache says 480: no precheck sweep
    await m.apply(g, "main", [pane("a", "webapp chart job")]);
    expect(sweeps()).toBe(1);
    const cat = created.find((c) => c.type === 4);
    expect(cat).toBeDefined();
    expect(m.entries[0]?.threadOnly).toBeUndefined();
    expect(created.find((c) => c.id === m.entries[0]?.channelId)?.parent).toBe(cat!.id);
  });

  test("Discord keeps refusing categories and nothing is deletable: one category try per 10-minute window, no storm", async () => {
    const { m, sweepWith } = splitMirror();
    sweepWith(() => ({ ids: [], names: [] }));
    const { g, tries } = splitGuild("always");
    for (let i = 20; i < 40; i++) g.channels.cache.delete(`F${i}`); // cache says 480
    // A live webapp pane whose channel r0 still sits in 🖥️ Main: every pass wants to move it into a webapp category.
    m.entries = [{ ...pane("c", "webapp moved job"), channelId: "r0", archived: false }];
    await m.apply(g, "main", [pane("a", "webapp chart job"), pane("c", "webapp moved job")]);
    expect(tries.cat).toBe(1);
    expect(m.entries.find((x) => x.paneId === "a")?.threadOnly).toBe(true);
    // More passes inside the window (15 s apart): no second category create.
    for (let i = 1; i <= 3; i++) {
      setSystemTime(new Date(Date.now() + 15_000 * i));
      await m.apply(g, "main", [pane("a", "webapp chart job"), pane("b", "webapp other job"), pane("c", "webapp moved job")]);
    }
    expect(tries.cat).toBe(1);
  });
});

describe("review 2026-11-07: tests can never run a real sweep", () => {
  test("a new Mirror has no sweeper; a full fake guild then falls back without a sweep", async () => {
    const dir = tempDir("no-sweeper-");
    const m = new Mirror(null, join(dir, "agents.json"), new Set());
    expect(m.serverSweep).toBeNull();
    m.threadHome = "H";
    m.stackCats = null;
    m.configFile = join(dir, "config.json");
    writeFileSync(m.configFile, "{}");
    const { g, calls } = fullGuild(498);
    expect(await m.sweepServer(g, "test")).toBe(0);
    await m.apply(g, "main", [pane("a")]);
    expect(calls.create).toBe(0);
    expect(m.entries[0]?.threadOnly).toBe(true);
  });
});

describe("owner 2026-11-07: a pane thread in use is never archived", () => {
  const T0 = Date.parse("2026-11-07T18:00:00Z");
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const jsonl = (...lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  const user = (s: number) => ({ type: "message", timestamp: at(s), message: { role: "user", content: [{ type: "text", text: "go" }] } });
  const tools = (s: number) => ({ type: "message", timestamp: at(s), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { i: "build" } }] } });

  function threadClient(archived: boolean, cacheSaysArchived = archived) {
    const log: string[] = [];
    const thread = {
      id: "T1",
      archived: cacheSaysArchived,
      autoArchiveDuration: 1440,
      isThread: () => true,
      setArchived: async (v: boolean) => {
        log.push(`archived=${v}`);
        thread.archived = v;
        archived = v;
      },
      setAutoArchiveDuration: async (d: number) => {
        log.push(`auto=${d}`);
        thread.autoArchiveDuration = d;
      },
    };
    const client = { channels: { cache: new Map([["T1", thread]]), fetch: async () => ({ ...thread, archived }) } };
    return { client: client as unknown as Client, log, isArchived: () => archived };
  }

  function tailSetup(client: Client) {
    const dir = tempDir("pane-thread-");
    const session = join(dir, "s.jsonl");
    writeFileSync(session, "");
    const m = new Mirror(client, join(dir, "agents.json"), new Set());
    const e: MirrorEntry = { ...pane("a"), channelId: "T1", archived: false, sessionFile: session, threadOnly: true };
    m.entries = [e];
    return { m, e, session };
  }

  test("the status post unarchives the thread first (and keeps the 1-week auto-archive)", async () => {
    const { client, log, isArchived } = threadClient(true);
    const { m, session } = tailSetup(client);
    const status = async (_c: string, _t: string, msgId?: string) => {
      if (isArchived()) throw new Error("Thread is archived");
      log.push("status");
      return msgId ?? "M1";
    };
    setSystemTime(new Date(T0));
    await m.tail(async () => {}, status);
    appendFileSync(session, jsonl(user(0), tools(1)));
    await m.tail(async () => {}, status);
    expect(log).toEqual(["archived=false", "auto=10080", "status"]);
  });

  test("Discord says archived while the cache did not know: unarchive for real, post once more", async () => {
    const { client, log, isArchived } = threadClient(true, false);
    const { m, session } = tailSetup(client);
    let tries = 0;
    const status = async (_c: string, _t: string, msgId?: string) => {
      tries++;
      if (isArchived()) throw new Error("Thread is archived");
      log.push("status");
      return msgId ?? "M1";
    };
    setSystemTime(new Date(T0));
    await m.tail(async () => {}, status);
    appendFileSync(session, jsonl(user(0), tools(1)));
    await m.tail(async () => {}, status);
    expect(tries).toBe(2);
    expect(log.filter((l) => l !== "auto=10080")).toEqual(["archived=false", "status"]);
  });

  test("paneThreadIds: live thread-only entries only (the idle alert-thread sweep skips them)", () => {
    const m = new Mirror(null, join(tempDir("pane-ids-"), "agents.json"), new Set());
    m.entries = [
      { ...pane("a"), channelId: "T1", archived: false, threadOnly: true },
      { ...pane("b"), channelId: "T2", archived: true, threadOnly: true },
      { ...pane("c"), channelId: "C3", archived: false },
    ];
    expect([...m.paneThreadIds()]).toEqual(["T1"]);
  });
});

describe("purge-archive.py --drop-oldest", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");

  test("bad values exit before any Discord call", () => {
    const home = tempDir("drop-oldest-home-");
    for (const bad of [["--drop-oldest"], ["--drop-oldest", "x"], ["--drop-oldest", "0"], ["--drop-oldest", "11"]]) {
      const r = Bun.spawnSync(["python3", "-B", script, "--dry-run", ...bad], { env: { ...process.env, HOME: home } });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain("--drop-oldest");
    }
  }, 20_000);

  /**
   * Runs main() of purge-archive.py --drop-oldest 10 --json against a fake HOME and a fake Discord API: 16 closed-pane
   * channels oldest first (the 4 oldest protected: keep list, open card, ask menu, queued job), one live pane, and
   * optionally a channel active a minute ago (`recent`). `failId`: its DELETE answers HTTP 500.
   */
  function runDrop(o: { dry?: boolean; failId?: string; failAll?: boolean; count?: number; recent?: boolean; hold?: string[] } = {}) {
    const home = tempDir("drop-oldest-run-");
    const G = "900000000000000000";
    const ids = Array.from({ length: o.count ?? 16 }, (_, i) => String(1000000000000000000n + BigInt(i) * 4194304000n));
    const [keep, card, ask, queued] = ids as [string, string, string, string];
    // The live pane's channel is the oldest of all and sits in a legacy 📦 archive category (a candidate there).
    const live = "999999999999999999";
    // A snowflake from one minute ago: held for "active in the last hour", whatever its rank.
    const recent = String(BigInt(Date.now() - 60_000 - 1420070400000) << 22n);
    const closed = o.recent ? [recent, ...ids] : ids;
    const w = (p: string, v: unknown) => {
      mkdirSync(join(home, p, ".."), { recursive: true });
      writeFileSync(join(home, p), typeof v === "string" ? v : JSON.stringify(v));
    };
    w(".config/omp-discord/bot.env", "DISCORD_TOKEN=x\n");
    w(".config/omp-discord/config.json", { guildId: G, keepChannelIds: [keep], mirror: { categories: { archive: "ARCH" } } });
    w("Documents/reports/web/firstmate/items.json", [{ id: "c", s: "running", q: `https://discord.com/channels/${G}/${card}` }]);
    w(".local/share/omp-discord-bot/asks.json", { sets: [{ channelId: ask }] });
    w(".local/share/omp-discord-bot/queue.json", { jobs: [{ id: 1, channelId: queued }] });
    w(".local/share/omp-discord-bot/agents.json", [...closed.map((channelId) => ({ channelId, archived: true, machine: "main" })), { channelId: live, archived: false, machine: "main" }]);
    const py = `
import importlib.util, io, json, sys, urllib.error, urllib.request
sys.argv = ["purge-archive.py", "--drop-oldest", "10", "--json"${o.dry ? ', "--dry-run"' : ""}${o.hold ? `, "--hold", "${o.hold.join(",")}"` : ""}]
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
ids = ${JSON.stringify(closed)}
chans = [{"id": i, "name": "ch-" + i[-6:], "type": 0, "parent_id": "P", "last_message_id": i} for i in ids]
chans.append({"id": "${live}", "name": "live", "type": 0, "parent_id": "ARCH", "last_message_id": "${live}"})
deleted = []
attempts = []
class R:
    def __init__(self, b): self.b = b
    def read(self): return self.b
def urlopen(req, timeout=30):
    p, m = req.full_url.split("/api/v10", 1)[1], req.get_method()
    if m == "DELETE":
        attempts.append(p.split("/")[2])
        if ${o.failAll ? "True" : "False"} or p.split("/")[2] == "${o.failId ?? ""}": raise urllib.error.HTTPError(p, 500, "boom", {}, io.BytesIO(b""))
        deleted.append(p.split("/")[2]); return R(b"")
    if p == "/guilds/${G}/channels": return R(json.dumps(chans).encode())
    if p == "/guilds/${G}/threads/active": return R(b'{"threads": []}')
    if "/threads/archived/" in p: return R(b'{"threads": [], "has_more": false}')
    if "/messages" in p:
        cid = p.split("/")[2]
        return R(json.dumps([] if "before=" in p else [{"id": cid, "timestamp": "2026-10-01T00:00:00Z", "author": {"username": "u"}, "content": "hi " + cid, "attachments": []}]).encode())
    raise SystemExit("unexpected " + m + " " + p)
pa.urllib.request.urlopen = urlopen
out = io.StringIO(); real = sys.stdout; sys.stdout = out
pa.main()
sys.stdout = real
print(json.dumps({"deleted": deleted, "attempts": attempts, "out": out.getvalue()}))
`;
    const r = Bun.spawnSync(["python3", "-B", "-c", py], { env: { ...process.env, HOME: home } });
    const res = JSON.parse(r.stdout.toString()) as { deleted: string[]; attempts: string[]; out: string };
    return { home, ids, protectedIds: [keep, card, ask, queued, live], recent, stderr: r.stderr.toString(), ...res };
  }

  test("deletes exactly the 10 oldest unprotected candidates, each with a JSON + HTML copy; held channels never", () => {
    const { home, ids, protectedIds, stderr, deleted, out } = runDrop();
    const expected = ids.slice(4, 14);
    expect(deleted).toEqual(expected);
    for (const held of [...protectedIds, ids[14], ids[15]]) expect(deleted).not.toContain(held);
    const j = JSON.parse(out.slice(out.indexOf("{\n"))) as { results: { id: string; reason: string }[] };
    expect(j.results.find((x) => x.id === protectedIds[4])?.reason).toBe("pane is live again");
    expect(parseSweepOutput(out).ids).toEqual(expected);
    // One "dropped <id> <name>" stderr line per delete (the bot's record if the run dies before its JSON).
    expect(parseSweepRun("", stderr).r.ids).toEqual(expected);
    const copies = readdirSync(join(home, ".local/state/omp-discord/deleted-archive"));
    expect(copies).toHaveLength(1);
    expect(readdirSync(join(home, ".local/state/omp-discord/deleted-archive", copies[0]!))).toHaveLength(10);
    for (const id of expected) {
      const page = join(home, "Documents/reports/web/discord-archive", `${id}.html`);
      expect(existsSync(page)).toBe(true);
      expect(readFileSync(page, "utf8")).toContain(`hi ${id}`);
    }
  }, 30_000);

  test("a failed delete is held and replaced by the next oldest (still 10, never 11); --hold and a channel active in the last hour are never picked", () => {
    const id = (i: number) => String(1000000000000000000n + BigInt(i) * 4194304000n);
    const { ids, deleted, out, recent } = runDrop({ failId: id(6), recent: true, hold: [id(5)] });
    expect(deleted).toEqual([ids[4]!, ...ids.slice(7, 16)]);
    expect(deleted).not.toContain(recent);
    const j = JSON.parse(out.slice(out.indexOf("{\n"))) as { results: { id: string; delete: boolean; reason: string }[] };
    expect(j.results.find((x) => x.id === ids[6])?.reason).toContain("delete failed");
    expect(j.results.find((x) => x.id === ids[5])?.reason).toBe("in use by the bot (--hold)");
    expect(j.results.find((x) => x.id === recent)?.reason).toBe("server-full sweep: active in the last hour");
  }, 60_000);

  test("every DELETE refused (missing permission, 5xx): the sweep stops after 2 x 10 tries", () => {
    const { deleted, attempts, out } = runDrop({ failAll: true, count: 40 });
    expect(deleted).toEqual([]);
    expect(attempts).toHaveLength(20);
    const j = JSON.parse(out.slice(out.indexOf("{\n"))) as { results: { reason: string }[] };
    expect(j.results.filter((x) => x.reason === "server-full sweep stopped after repeated failures").length).toBeGreaterThan(0);
  }, 60_000);

  test("--dry-run --drop-oldest: names the 10 it would drop, deletes nothing", () => {
    const { ids, deleted, out } = runDrop({ dry: true });
    expect(deleted).toEqual([]);
    const j = JSON.parse(out) as { dryRun: boolean; deletedIds: string[] };
    expect(j.dryRun).toBe(true);
    expect(j.deletedIds.sort()).toEqual(ids.slice(4, 14).sort());
    expect(parseSweepOutput(out)).toEqual({ ids: [], names: [] });
  }, 30_000);
});
