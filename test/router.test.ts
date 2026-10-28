import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../src/queue.ts";
import { DEFAULT_ROUTER, forcedStack, GENERAL, jevJudge, routeMessage, routerConfig, ruleRoute, StackTracker, type Judge } from "../src/router.ts";
import { StackRouter } from "../src/stackroute.ts";

const cfg = routerConfig({ stacks: [{ name: "finance", channelIds: ["T1"] }] });
const judgeSays = (stack: string, confidence: number): Judge & { calls: string[] } => {
  const calls: string[] = [];
  const judge: Judge = async (text) => {
    calls.push(text);
    return { stack, confidence };
  };
  return Object.assign(judge, { calls });
};

describe("route filter rules", () => {
  test("keywords pick the domain stack", () => {
    expect(ruleRoute("check the budget invoices", {}, cfg).decision).toMatchObject({ stack: "finance", by: "keyword" });
    expect(ruleRoute("the webapp charts page shows no candles", {}, cfg).decision).toMatchObject({ stack: "webapp", by: "keyword" });
    expect(ruleRoute("transcribe the new youtube videos into the kb", {}, cfg).decision).toMatchObject({ stack: "kb", by: "keyword" });
    expect(ruleRoute("Client Co email footer needs the postal address", {}, cfg).decision).toMatchObject({ stack: "realestate" });
    expect(ruleRoute("restart the discord bot service on the main host", {}, cfg).decision).toMatchObject({ stack: "infra" });
    expect(ruleRoute("remind me to call the dentist", {}, cfg).decision).toMatchObject({ stack: "personal" });
  });
  test("whole words only: 'kb' inside a word and 'tv' inside 'tvl' do not match", () => {
    expect(ruleRoute("kbd layout and tvl numbers", {}, cfg).decision).toBeNull();
  });
  test("forced prefix, inherited stack, channel and card area come before keywords", () => {
    expect(forcedStack("stack:kb newsletter notes", cfg.stacks)).toEqual({ stack: "kb", rest: "newsletter notes" });
    expect(forcedStack("@general what is running", cfg.stacks)?.stack).toBe(GENERAL);
    expect(forcedStack("@someone hi", cfg.stacks)).toBeNull();
    expect(ruleRoute("stack:kb newsletter notes", {}, cfg).decision).toMatchObject({ stack: "kb", by: "forced" });
    expect(ruleRoute("ok do it", { inherited: "webapp" }, cfg).decision).toMatchObject({ stack: "webapp", by: "inherit" });
    expect(ruleRoute("youtube", { channelId: "T1" }, cfg).decision).toMatchObject({ stack: "finance", by: "channel" });
    expect(ruleRoute("what about this one", { cardAreas: ["Client Co"] }, cfg).decision).toMatchObject({ stack: "realestate", by: "card" });
  });
  test("the word webapp wins over a tie with another stack (owner rule 2026-10-24)", () => {
    const r = ruleRoute("webapp finance", {}, cfg);
    expect(r.decision?.stack).toBe("webapp");
  });
});

describe("judge fallback", () => {
  test("ambiguous message: judge answer above the threshold wins", async () => {
    const j = judgeSays("webapp", 0.92);
    expect(await routeMessage("why does that page stay empty now", {}, cfg, j)).toMatchObject({ stack: "webapp", by: "judge" });
    expect(j.calls).toEqual(["why does that page stay empty now"]);
  });
  test("rule match never calls the judge", async () => {
    const j = judgeSays("kb", 1);
    expect((await routeMessage("tax invoices", {}, cfg, j)).stack).toBe("finance");
    expect(j.calls.length).toBe(0);
  });
  test("low confidence, unknown stack, error, timeout and no judge all fall back to FIRSTMATE", async () => {
    expect(await routeMessage("hmm what about that thing", {}, cfg, judgeSays("webapp", 0.4))).toMatchObject({ stack: GENERAL, by: "fallback" });
    expect((await routeMessage("hmm what about that thing", {}, cfg, judgeSays("nope", 0.99))).stack).toBe(GENERAL);
    expect(await routeMessage("hmm what about that thing", {}, cfg, async () => { throw new Error("boom"); })).toMatchObject({ stack: GENERAL, detail: expect.stringContaining("judge error") });
    const slow = routerConfig({ judgeTimeoutMs: 20 });
    expect(await routeMessage("hmm what about that thing", {}, slow, () => new Promise((r) => setTimeout(() => r({ stack: "kb", confidence: 1 }), 500)))).toMatchObject({ stack: GENERAL, detail: expect.stringContaining("timeout") });
    expect((await routeMessage("hmm what about that thing", {}, cfg)).stack).toBe(GENERAL);
  });
  test("short follow-ups stay with FIRSTMATE without the judge", async () => {
    const j = judgeSays("webapp", 1);
    for (const t of ["ok", "yes do it", "2", "continue"]) expect(await routeMessage(t, {}, cfg, j)).toMatchObject({ stack: GENERAL, by: "fallback" });
    expect(j.calls).toEqual([]);
  });
  test("financial details never reach the judge", async () => {
    const j = judgeSays("personal", 1);
    for (const t of ["move $5,000 to the other account", "sell 100 XYZ tomorrow", "account #123456 balance", "what's my 1Password password", "my checking balance is 52,300 after the wire", "net worth hit 1.2M", "Amex 4,812.33 due", "check the bot dashboard and my account account U1234567", "check the bot dashboard, and how are my puts on nvda doing"])
      await routeMessage(t, {}, cfg, j);
    expect(j.calls).toEqual([]);
  });
  test("jevJudge: decisions API request (redacted text, stack criteria), parses choice and confidence, drops the key on 401", async () => {
    const bodies: unknown[] = [];
    let keyCalls = 0;
    let status = 200;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ answers: { stack: { choice: "kb", confidence: 0.81, probabilities: { kb: 0.81 } } } }), { status });
    }) as unknown as typeof fetch;
    const j = jevJudge({ ompBin: "omp", fetchFn, keyFn: async () => (keyCalls++, "sk-test") });
    expect(await j("token sk-or-v1-0123456789abcdef0123456789abcdef summarize this", cfg.stacks)).toEqual({ stack: "kb", confidence: 0.81 });
    const b = bodies[0] as { model: string; state: { message: string }; questions: { stack: { criteria: Record<string, string> } } };
    expect(b.model).toBe("~typesafe/jev-latest");
    expect(b.state.message).not.toContain("0123456789abcdef0123456789abcdef");
    expect(Object.keys(b.questions.stack.criteria)).toContain(GENERAL);
    await j("again", cfg.stacks);
    expect(keyCalls).toBe(1); // cached
    status = 401;
    await expect(j("x", cfg.stacks)).rejects.toThrow("401");
    status = 200;
    await j("y", cfg.stacks);
    expect(keyCalls).toBe(2);
  });
});

test("routerConfig: defaults on, cap 4, stacks merge by name, cwd expands, bad fallback reset", () => {
  expect(DEFAULT_ROUTER.enabled).toBe(true);
  expect(DEFAULT_ROUTER.maxParallelStacks).toBe(4);
  const c = routerConfig({ fallback: "nope", maxParallelStacks: 0, stacks: [{ name: "finance", keywords: ["xyz"] }, { name: "music", keywords: ["song"] }] });
  expect(c.fallback).toBe(GENERAL);
  expect(c.maxParallelStacks).toBe(1);
  expect(c.stacks.find((s) => s.name === "finance")?.keywords).toEqual(["xyz"]);
  expect(c.stacks.find((s) => s.name === "music")?.cwd.startsWith("/")).toBe(true);
  expect(c.stacks.every((s) => !s.cwd.startsWith("~"))).toBe(true);
});

describe("stacks on the job queue", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  test("per-stack order: one job at a time per stack, FIFO", async () => {
    const q = new JobQueue<void>(4, { groupLimits: { stack: 4 } });
    const order: string[] = [];
    const gates: (() => void)[] = [];
    const job = (key: string, name: string) =>
      q.enqueue({ key, label: name, group: "stack", run: () => new Promise<void>((r) => { order.push(`start ${name}`); gates.push(() => { order.push(`end ${name}`); r(); }); }), onDone: () => {} });
    job("finance", "t1");
    job("finance", "t2");
    job("finance", "t3");
    await tick();
    expect(q.status().running.map((j) => j.label)).toEqual(["t1"]);
    gates.shift()!();
    await tick();
    gates.shift()!();
    await tick();
    gates.shift()!();
    await tick();
    expect(order).toEqual(["start t1", "end t1", "start t2", "end t2", "start t3", "end t3"]);
  });
  test("parallelism cap: at most maxParallelStacks stack jobs run; other jobs still run", async () => {
    const q = new JobQueue<void>(4, { groupLimits: { stack: 2 } });
    const release: (() => void)[] = [];
    const hold = () => new Promise<void>((r) => release.push(r));
    for (const k of ["finance", "webapp", "kb"]) q.enqueue({ key: k, label: k, group: "stack", run: hold, onDone: () => {} });
    q.enqueue({ key: "chan-1", label: "plain", run: hold, onDone: () => {} });
    await tick();
    expect(q.status().running.map((j) => j.label).sort()).toEqual(["finance", "plain", "webapp"]);
    release.shift()!(); // finance ends: kb starts
    await tick();
    expect(q.status().running.map((j) => j.label).sort()).toEqual(["kb", "plain", "webapp"]);
    while (release.length) release.shift()!();
  });
  test("failure isolation: a failing stack job does not block other stacks or the next job of its own stack", async () => {
    const q = new JobQueue<string>(4, { groupLimits: { stack: 4 } });
    const results: string[] = [];
    const onDone = (r: string | undefined, e?: unknown) => void results.push(e ? `err:${(e as Error).message}` : String(r));
    q.enqueue({ key: "finance", label: "a", group: "stack", run: async () => { throw new Error("finance broke"); }, onDone });
    q.enqueue({ key: "webapp", label: "b", group: "stack", run: async () => "webapp ok", onDone });
    q.enqueue({ key: "finance", label: "c", group: "stack", run: async () => "finance next ok", onDone });
    for (let i = 0; i < 5; i++) await tick();
    expect(results.sort()).toEqual(["err:finance broke", "finance next ok", "webapp ok"]);
  });
});

describe("status reporting", () => {
  test("StackTracker: queued → running → done/failed counts, cancel not counted, board lines, stacks.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "st-"));
    const file = join(dir, "stacks.json");
    const t = new StackTracker(cfg, file, () => 1_000);
    t.add({ id: "1", stack: "finance", preview: "newsletter check", link: "https://discord.com/channels/1/2/3", by: "keyword", detail: "" });
    t.add({ id: "2", stack: "finance", preview: "second", by: "keyword", detail: "" });
    t.add({ id: "3", stack: "kb", preview: "transcribe", by: "judge", detail: "" });
    t.start("1");
    t.start("3");
    const lines = t.boardLines((j) => j.preview);
    expect(lines[0]).toBe("🧭 **Stacks**");
    expect(lines).toContain("💹 **finance**: ⚙️ newsletter check · 1. second");
    t.finish("1", true);
    t.finish("3", false);
    t.finish("2");
    const s = Object.fromEntries(t.status().map((x) => [x.stack, x]));
    expect(s.finance).toMatchObject({ done: 1, failed: 0, running: [], queued: [] });
    expect(s.kb).toMatchObject({ done: 0, failed: 1 });
    expect(s.kb?.last?.state).toBe("failed");
    const disk = JSON.parse(readFileSync(file, "utf8")) as { stacks: { stack: string; done: number }[] };
    expect(disk.stacks.find((x) => x.stack === "finance")?.done).toBe(1);
    expect(t.boardLines((j) => j.preview)).toEqual([]);
  });

  test("StackRouter: one thread per stack (reused), router note follows the job, cancel shows 🛑, replies inherit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-"));
    writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [{ id: "c1", area: "Webapp" }] }));
    const r = new StackRouter(cfg, { stateFile: join(dir, "state.json"), statusFile: join(dir, "stacks.json"), itemsFile: join(dir, "items.json"), guildId: "G", log: () => {} });
    let n = 0;
    const threads = new Map<string, { id: string; archived: boolean; sent: string[]; send: (o: { content: string }) => Promise<{ id: string; content: string }>; setArchived: (v: boolean) => Promise<void> }>();
    const created: string[] = [];
    const parent = {
      threads: {
        fetch: async (id: string) => threads.get(id) ?? null,
        create: async (o: { name: string }) => {
          const t = { id: `T${++n}`, archived: false, sent: [] as string[], send: async (m: { content: string }) => (t.sent.push(m.content), { id: `M${++n}`, content: m.content }), setArchived: async (v: boolean) => void (t.archived = v) };
          threads.set(t.id, t);
          created.push(o.name);
          return t;
        },
      },
    };
    r.archiveGraceMs = 5;
    const notes: string[] = [];
    const msg = (id: string) => ({ id, url: `https://discord.com/channels/G/F/${id}`, reply: async (o: { content: string }) => { const m = { id: `N${id}`, content: o.content, edit: async (e: { content: string }) => void notes.push(e.content) }; notes.push(o.content); return m; } });
    const d = { stack: "finance", by: "keyword" as const, confidence: 0.9, detail: "keywords newsletter" };
    const copy1 = await r.forward(msg("o1") as never, parent as never, r.stack("finance")!, d, "newsletter check");
    const copy2 = await r.forward(msg("o2") as never, parent as never, r.stack("finance")!, d, "second");
    expect(created).toEqual(["💹 finance stack"]);
    expect(r.stackByThread("T1")?.name).toBe("finance");
    expect(threads.get("T1")!.sent[0]).toContain("📨 **From FIRSTMATE**");
    expect(notes[0]).toContain("🧭 → stack: 💹 **finance** (keyword) · ⏳ queued");
    // Owner replies to the original or the router note: same stack.
    expect(r.inherited(["o1"])).toBe("finance");
    expect(r.inherited(["No1"])).toBe("finance");
    r.track(10, r.stack("finance")!, "newsletter check", "x", copy1.id, true);
    r.track(11, r.stack("finance")!, "second", "x", copy2.id, false);
    await Promise.resolve();
    expect(notes.some((t) => t.includes("⚙️ running"))).toBe(true);
    r.sync([10], []); // 11 left the queue without starting: cancelled
    await Promise.resolve();
    expect(notes.some((t) => t.includes("🛑 cancelled"))).toBe(true);
    r.ended(10, true);
    await Promise.resolve();
    expect(notes.at(-1)).toContain("✅ done");
    expect(r.tracker.status().find((s) => s.stack === "finance")).toMatchObject({ done: 1, running: [], queued: [] });
    // Owner 2026-10-23: an empty stack's thread is archived after the grace time.
    expect(threads.get("T1")!.archived).toBe(false);
    await new Promise((res) => setTimeout(res, 30));
    expect(threads.get("T1")!.archived).toBe(true);
    expect(r.cardAreas(["c1"], [])).toEqual(["Webapp"]);
    // Restart: thread and routed ids are kept.
    const r2 = new StackRouter(cfg, { stateFile: join(dir, "state.json"), statusFile: join(dir, "stacks.json"), itemsFile: join(dir, "items.json"), guildId: "G", log: () => {} });
    expect(r2.stackByThread("T1")?.name).toBe("finance");
    expect(r2.inherited(["o2"])).toBe("finance");
  });
});

test("routerConfig: a null field in config keeps the default (no crash on areas: null)", () => {
  const c = routerConfig({ stacks: [{ name: "infra", areas: null, keywords: null } as never] });
  const infra = c.stacks.find((s) => s.name === "infra")!;
  expect(infra.areas.length).toBeGreaterThan(0);
  expect(ruleRoute("hello", { cardAreas: ["tools"] }, c).decision?.stack).toBe("infra");
});

test("StackRouter.thread: a transient lookup error keeps the saved thread; only a gone thread is replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sr2-"));
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ threads: { finance: "T9" }, msgs: {} }));
  const r = new StackRouter(cfg, { stateFile: state, statusFile: join(dir, "stacks.json"), itemsFile: join(dir, "items.json"), guildId: "G", log: () => {} });
  let err: { code: number } = { code: 0 };
  let created = 0;
  const lookup = async () => {
    throw Object.assign(new Error("x"), err);
  };
  const parent = { threads: { fetch: lookup, create: async () => ({ id: `N${++created}` }) } };
  err = { code: 500 };
  await expect(r.thread(parent as never, r.stack("finance")!)).rejects.toThrow();
  expect(created).toBe(0);
  err = { code: 10003 };
  const t = await r.thread(parent as never, r.stack("finance")!);
  expect(t.id).toBe("N1");
});
