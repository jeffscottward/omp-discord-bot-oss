import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsYouBoard, type BoardChannel, type BoardMsg } from "../src/needsyou.ts";
import { botRows, cardRows, herdrPlace, jobPlace, needsRows, parseHerdrPanes, parseHerdrTabs, isMasterBoard, renderMasterPages, KEEP_FINISHED_MS, MasterQueueBoard, renderMaster, rowLine, type FmCard, type LiveJob, type Receipt } from "../src/masterqueue.ts";
import { JobQueue } from "../src/queue.ts";

const DASH = "https://dash.example/reports/firstmate/";
const NOW = 1_800_000_000_000;
const MSG = "https://discord.com/channels/1/2/3";

describe("rows", () => {
  test("cards with a job: running, queued, finished in 24 h, failed receipt; finance titles hidden", () => {
    const cards: FmCard[] = [
      { id: "r1", t: "Build the board", s: "running", job: "wB:p1", src: MSG, cts: String(NOW - 600_000) },
      { id: "q1", t: "Queued work", s: "partial", job: "wB:p2", cts: NOW - 60_000 },
      { id: "d1", t: "Finished work", s: "done", job: "wB:p3", cts: NOW - 3600_000 },
      { id: "old", t: "Old work", s: "done", job: "wB:p4", cts: NOW - KEEP_FINISHED_MS - 1 },
      { id: "f1", t: "Failed work", s: "partial", job: "wB:p5", cts: NOW - 7200_000 },
      { id: "nojob", t: "No job field", s: "running" },
      { id: "tr", t: "Sell 100 XYZ acct 1234", area: "finance", s: "running", job: "wB:p6" },
    ];
    const receipts = new Map<string, Receipt>([["f1", { card: "f1", result: "failed", tsMs: NOW - 1800_000 }]]);
    const rows = cardRows(cards, receipts, NOW, DASH);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by["card:r1"]).toMatchObject({ state: "running", link: MSG, where: "💻 terminal tab (Herdr not reachable)", at: NOW - 600_000 });
    expect(by["card:q1"]?.state).toBe("queued");
    expect(by["card:q1"]?.link).toBe(`${DASH}?item=q1`);
    expect(by["card:d1"]?.state).toBe("done");
    expect(by["card:old"]).toBeUndefined();
    expect(by["card:f1"]).toMatchObject({ state: "failed", at: NOW - 1800_000 });
    expect(by["card:nojob"]).toBeUndefined();
    expect(by["card:tr"]?.title).toBe("Finance card tr");
  });

  test("bot jobs: live first, finished kept 24 h, a live id wins over its saved finish", () => {
    const live: LiveJob[] = [{ id: 7, title: "fix the bot", channelId: "c1", link: MSG, running: true, since: NOW - 120_000 }];
    const rows = botRows(live, [
      { id: 5, title: "done job", channelId: "c2", state: "done", at: NOW - 3600_000 },
      { id: 6, title: "expired", channelId: "c2", state: "failed", at: NOW - KEEP_FINISHED_MS },
      { id: 7, title: "stale", channelId: "c1", state: "done", at: NOW - 10 },
    ], NOW);
    expect(rows.map((r) => [r.key, r.state])).toEqual([["job:7", "running"], ["job:5", "done"]]);
    expect(rows[0]!.where).toBe("<#c1>");
  });

  test("render: sections, finish time, stack tag, overflow count, empty state", () => {
    const text = renderMaster([
      { key: "a", title: "Running one", link: MSG, where: "<#c1>", state: "running", at: NOW - 300_000, stack: "finance" },
      { key: "b", title: "Waiting one", where: "<#c2>", state: "queued", at: NOW - 60_000 },
      { key: "c", title: "Done one", where: "terminal tab “Build”", state: "done", at: NOW - 3600_000 },
      { key: "d", title: "Broke", where: "<#c3>", state: "failed", at: NOW - 60_000 },
    ], NOW, DASH);
    expect(isMasterBoard(text)).toBe(true);
    expect(text).toContain("⚙️ **Running** (1)");
    expect(text).toContain(`⚙️ [Running one](<${MSG}>) · 5m\n\u2003\u2003↳ <#c1>`);
    expect(text).toContain("1. ⏳ Waiting one · ⏳ 1m\n\u2003\u2003↳ <#c2>");
    expect(text).toContain("🏁 **Finished, last 12 h:** 2 (⚠️ 1 failed or stopped)");
    expect(text).not.toContain("Done one");
    const many = Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`, title: `Job number ${i} with a fairly long title`, where: "<#c>", state: "running" as const, at: NOW - i }));
    // Owner 2026-10-24: every row shown, no "+N more"; long boards continue in more messages.
    const pages = renderMasterPages(many, NOW, DASH);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) { expect(p.length).toBeLessThanOrEqual(1900); expect(isMasterBoard(p)).toBe(true); }
    const all = pages.join("\n");
    for (let i = 0; i < 80; i++) expect(all).toContain(`Job number ${i} with`);
    expect(all).not.toContain("more on the dashboard");
    expect(renderMaster([], NOW, DASH)).toContain("No jobs queued, running or finished");
  });
});

/** Fake channel: list is newest-first, like Discord. */
function fakeChannel(botId: string) {
  const list: BoardMsg[] = [];
  let n = 0;
  const mk = (content: string, author = botId): BoardMsg => {
    const m: BoardMsg = {
      id: String(++n),
      content,
      author: { id: author },
      edit: async (o) => void (m.content = o.content),
      delete: async () => void (list.includes(m) && list.splice(list.indexOf(m), 1)),
    };
    return m;
  };
  const ch: BoardChannel = {
    send: async (o) => {
      const m = mk(o.content);
      list.unshift(m);
      return m;
    },
    messages: { fetch: async () => new Map(list.map((m) => [m.id, m])) },
  };
  const post = (content: string, author: string) => list.unshift(mk(content, author));
  return { ch, list, post };
}

describe("MasterQueueBoard", () => {
  test("keeps one board at the bottom (the ⏳ Queue box may sit below), edits in place, keeps finished jobs across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mq-"));
    const items = join(dir, "items.json");
    mkdirSync(join(dir, "receipts"));
    writeFileSync(items, JSON.stringify({ items: [{ id: "side", t: "Side session job", s: "running", job: "wB:p9", cts: NOW - 60_000 }] }));
    const f = fakeChannel("bot");
    f.post("📋 **Master queue** old", "bot");
    let live: LiveJob[] = [{ id: 1, title: "owner task", channelId: "c1", link: MSG, running: true, since: NOW - 60_000 }];
    const opts = {
      getChannel: async () => f.ch,
      botId: () => "bot",
      jobs: () => live,
      mayBeBelow: (m: { content: string }) => m.content.startsWith("⏳ **Queue"),
      itemsFile: items,
      receiptsDir: join(dir, "receipts"),
      stateFile: join(dir, "mq.json"),
      dash: DASH,
      log: () => {},
      now: () => NOW,
    };
    const b = new MasterQueueBoard(opts);
    b.onQueueChange();
    await b.refresh();
    expect(f.list.filter((m) => isMasterBoard(m.content)).length).toBe(1);
    expect(f.list[0]!.content).toContain("owner task");
    expect(f.list[0]!.content).toContain("Side session job");

    // The ⏳ Queue box below the board: no reprint, edit in place.
    f.post("⏳ **Queue**", "bot");
    const id = f.list[1]!.id;
    live = [];
    b.finished(1, "done", { title: "owner task", channelId: "c1", link: MSG });
    await b.refresh();
    expect(f.list[1]!.id).toBe(id);
    expect(f.list[1]!.content).toContain("🏁 **Finished, last 12 h:** 1");

    // Owner writes: the board moves back to the bottom.
    f.post("hi", "owner");
    await b.refresh(true);
    expect(isMasterBoard(f.list[0]!.content)).toBe(true);
    expect(f.list.filter((m) => isMasterBoard(m.content)).length).toBe(1);

    // Restart: the finished job is still listed (state file).
    const b2 = new MasterQueueBoard(opts);
    expect(b2.rows().some((r) => r.key === "job:1" && r.state === "done")).toBe(true);
  });

  test("same rows: no edit when only the `updated` stamp changed (5-min throttle applies)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mq-"));
    mkdirSync(join(dir, "receipts"));
    const items = join(dir, "items.json");
    writeFileSync(items, JSON.stringify({ items: [] }));
    const f = fakeChannel("bot");
    let now = NOW;
    const b = new MasterQueueBoard({
      getChannel: async () => f.ch,
      botId: () => "bot",
      jobs: () => [{ id: 1, title: "owner task", channelId: "c1", link: MSG, running: true, since: NOW - 60_000 }],
      mayBeBelow: () => false,
      itemsFile: items,
      receiptsDir: join(dir, "receipts"),
      stateFile: join(dir, "mq.json"),
      dash: DASH,
      log: () => {},
      now: () => now,
    });
    await b.refresh();
    const board = f.list[0]!;
    let edits = 0;
    const edit = board.edit;
    board.edit = async (o) => (edits++, edit(o));
    now += 2_000;
    await b.refresh();
    expect(edits).toBe(0);
    now += 300_001;
    await b.refresh();
    expect(edits).toBe(1);
  });
});

test("JobQueue onSettled reports each started job once with its result, before onDone", async () => {
  const q = new JobQueue<{ ok: boolean }>(2);
  const seen: string[] = [];
  q.onSettled = (j, r, e) => seen.push(`${j.id}:${e ? "err" : r?.ok}`);
  const done = Promise.withResolvers<void>();
  let left = 2;
  const onDone = () => {
    seen.push("onDone");
    if (--left === 0) done.resolve();
  };
  q.enqueue({ key: "a", label: "a", run: async () => ({ ok: true }), onDone });
  q.enqueue({ key: "b", label: "b", run: async () => { throw new Error("x"); }, onDone });
  await done.promise;
  expect(seen.filter((s) => s !== "onDone").sort()).toEqual(["1:true", "2:err"]);
  expect(seen.indexOf("1:true")).toBeLessThan(seen.lastIndexOf("onDone"));
});

describe("plain-English job place (owner 2026-10-23)", () => {
  test("no raw Herdr ids; channel link, stack channel, indented second line", async () => {
    const { jobPlace, rowLine } = await import("../src/masterqueue.ts");
    expect(jobPlace("wB:pMC", { job: () => ({ gone: true }) })).toBe("💻 closed tab");
    // No Herdr answer: never claim the tab is closed (owner 2026-10-24, live pane wB:pPV showed "closed tab").
    expect(jobPlace("wB:pMC")).toBe("💻 terminal tab (Herdr not reachable)");
    expect(jobPlace("wB:pMC", { job: () => ({ channelId: "42", tab: "X" }) })).toBe("<#42>");
    expect(jobPlace("wB:pMC", { job: () => ({ tab: "Build" }) })).toBe("💻 Build");
    expect(jobPlace(["kb-ig-daily-retry.timer", "wB:p1"])).toBe("background service kb-ig-daily-retry");
    expect(jobPlace([])).toBe("💻 no job recorded");
    expect(jobPlace("kb-ig-daily-retry.timer")).toBe("background service kb-ig-daily-retry");
    const rows = cardRows([{ id: "c1", t: "Fix", job: "wB:pMC", s: "running", stack: "infra" }], new Map(), NOW, DASH, { job: () => ({ channelId: "7" }), stackChannel: () => "9" });
    const line = rowLine(rows[0]!, NOW);
    expect(line).not.toContain("wB:pMC");
    expect(line).toContain("\n\u2003\u2003↳ <#9>\n\u2003\u2003\u2003\u2003↳ <#7>");
  });
  test("a card without `stack` gets its area's stack, else firstmate (owner 2026-10-24 addendum)", () => {
    const threads: Record<string, string> = { infra: "9", firstmate: "5" };
    const res = { job: () => ({ channelId: "7" }), stackChannel: (s: string) => threads[s], areaStack: (a: string) => (a.toLowerCase() === "discord" ? "infra" : undefined) };
    const rows = cardRows([
      { id: "a", t: "A", job: "wB:p1", s: "running", area: "Discord" },
      { id: "b", t: "B", job: "wB:p2", s: "running", area: "Something" },
      { id: "c", t: "C", job: "wB:p3", s: "running", area: "Discord", stack: "kb" },
    ], new Map(), NOW, DASH, res);
    expect(rows.map((r) => r.stack)).toEqual(["infra", "firstmate", "kb"]);
    expect(rowLine(rows[0]!, NOW)).toContain("↳ <#9>\n\u2003\u2003\u2003\u2003↳ <#7>");
    expect(rowLine(rows[1]!, NOW)).toContain("↳ <#5>\n\u2003\u2003\u2003\u2003↳ <#7>");
  });
  test("live Herdr pane without a mirror entry names its tab; closed only when Herdr lacks the id (mq-live-tab)", () => {
    const panes = parseHerdrPanes(JSON.stringify({ result: { panes: [{ pane_id: "wB:pPV", tab_id: "wB:tBP", label: "OMP" }, { pane_id: "wB:pX1", tab_id: "wB:tT2" }, { pane_id: "wB:pX2", tab_id: "wB:tT2" }, { bogus: 1 }] } }))!;
    const tabs = parseHerdrTabs(JSON.stringify({ result: { tabs: [{ tab_id: "wB:tBP", label: "📈 webapp-phases" }, { tab_id: "wB:tT2", label: "Split" }] } }))!;
    expect(panes).toHaveLength(3);
    expect(parseHerdrPanes("not json")).toBeNull();
    expect(parseHerdrTabs(JSON.stringify({ result: {} }))).toBeNull();
    expect(herdrPlace("wB:pPV", panes, tabs)).toEqual({ tab: "📈 webapp-phases", session: "wB:pPV" });
    expect(herdrPlace("wB:tBP", panes, tabs)).toEqual({ tab: "📈 webapp-phases", session: "wB:pPV" }); // one-pane tab = that pane
    expect(herdrPlace("📈 webapp-phases", panes, tabs)).toEqual({ tab: "📈 webapp-phases", session: "wB:pPV" });
    expect(herdrPlace("wB:tT2", panes, tabs)).toEqual({ tab: "Split", session: "wB:tT2" });
    expect(herdrPlace("wB:pGONE", panes, tabs)).toEqual({ gone: true });
    expect(herdrPlace("free text", panes, tabs)).toBeUndefined();
    const res = { job: (j: string) => herdrPlace(j, panes, tabs) };
    expect(jobPlace("wB:pPV", res)).toBe("💻 📈 webapp-phases");
    expect(jobPlace("wB:pGONE", res)).toBe("💻 closed tab");
  });
  test("two cards on one live pane: second row says 'same session as' (owner 2026-10-24)", () => {
    const panes = [{ pane_id: "wB:pPV", tab_id: "wB:tBP" }];
    const tabs = [{ tab_id: "wB:tBP", label: "📈 webapp-phases" }];
    const res = { job: (j: string) => herdrPlace(j, panes, tabs) };
    const rows = cardRows([
      { id: "webapp-phases", t: "Webapp phases", job: "wB:pPV", s: "running" },
      { id: "master-rules-webapp", t: "Master rules in Webapp", job: "📈 webapp-phases", s: "running" },
      { id: "other", t: "Other", job: "wB:pGONE", s: "running" },
      { id: "other2", t: "Other 2", job: "wB:pGONE", s: "running" },
    ], new Map(), NOW, DASH, res);
    expect(rows.map((r) => r.where)).toEqual(["💻 📈 webapp-phases", "same session as Webapp phases", "💻 closed tab", "💻 closed tab"]);
    // A blocked card (no job row) listed first must not own the session (review finding).
    const rows2 = cardRows([
      { id: "b", t: "Blocked first", job: "wB:pPV", s: "blocked", action: "Do the step" },
      { id: "r", t: "Running", job: "wB:pPV", s: "running" },
    ], new Map(), NOW, DASH, res);
    expect(rows2.map((r) => r.where)).toEqual(["💻 📈 webapp-phases"]);
    expect(jobPlace("wB:pX", { job: () => ({ session: "wB:pX" }) })).toBe("💻 terminal tab");
    expect(rowLine(rows[1]!, NOW)).toContain("↳ same session as Webapp phases");
  });
});

describe("bots section (owner 2026-10-24)", () => {
  test("service/timer/remote cards leave Running and list under 🤖 Bots", async () => {
    const { renderMaster } = await import("../src/masterqueue.ts");
    const rows = cardRows([
      { id: "b1", t: "Discord bot", job: "omp-discord-bot.service", s: "running" },
      { id: "b2", t: "Copier", job: ["remote:copybook-copier.timer"], s: "running" },
      { id: "j1", t: "Real job", job: "wB:p1", s: "running" },
    ], new Map(), NOW, DASH);
    expect(rows.filter((r) => r.state === "bot").map((r) => r.key)).toEqual(["card:b1", "card:b2"]);
    const t = renderMaster(rows, NOW, DASH);
    expect(t).toContain("**Running** (1)");
    expect(t).toContain("🤖 **Bots and scheduled jobs:**");
    expect(t).not.toContain("Discord bot ·");
  });
});

test("owner 2026-10-24: finished jobs older than 12 h are not listed", () => {
  const now = Date.UTC(2026, 9, 24, 12);
  expect(KEEP_FINISHED_MS).toBe(12 * 3_600_000);
  const done = [
    { id: 1, title: "recent", channelId: "c", state: "done" as const, at: now - 11 * 3_600_000 },
    { id: 2, title: "old", channelId: "c", state: "done" as const, at: now - 13 * 3_600_000 },
  ];
  expect(botRows([], done, now).map((r) => r.title)).toEqual(["recent"]);
  const cards: FmCard[] = [
    { id: "a", t: "card recent", s: "done", job: "wB:p1", cts: now - 11 * 3_600_000 },
    { id: "b", t: "card old", s: "done", job: "wB:p2", cts: now - 13 * 3_600_000 },
  ] as FmCard[];
  expect(cardRows(cards, new Map(), now, "").map((r) => r.title)).toEqual(["card recent"]);
});

test("job in its own stack thread: thread shown once (owner 2026-10-24)", async () => {
  const { rowLine } = await import("../src/masterqueue.ts");
  const l = rowLine({ key: "j", title: "T", where: "<#9>", state: "running", at: NOW, stack: "infra", stackChannel: "9" }, NOW);
  expect(l.match(/<#9>/g)?.length).toBe(1);
  expect(l).not.toContain("stack:");
});

test("needs-you cards on top of the master queue (owner 2026-10-24)", async () => {
  const { needsRows, renderMaster } = await import("../src/masterqueue.ts");
  const rows = needsRows([{ id: "w1", t: "Approve deploy", s: "waiting", action: "Do the step", q: "https://discord.com/channels/1/2/3" }, { id: "o1", t: "Pick layout", s: "open", action: "Do the step" }, { id: "x", t: "Other", s: "running" }], NOW, DASH);
  expect(rows.map((r) => r.key)).toEqual(["need:w1", "need:o1"]);
  const t = renderMaster(rows, NOW, DASH);
  expect(t).toContain("✍️ **Needs you** (2)");
  expect(t).toContain("🏃 Approve deploy · 0m\n👉 1. Do the step\n🔗 [Open](<https://discord.com/channels/1/2/3>)");
  expect(t.indexOf("Needs you")).toBeLessThan(t.indexOf("Finished"));
});

describe("master queue ✍️ Needs you = 🔔 Needs-you board (owner 2026-10-24, card mq-needs-menus)", () => {
  const MENU = "https://discord.com/channels/9/101/555";
  const set = { setId: "s1", channelId: "101", questions: [{ id: "q1", question: "What should the DemoApp session do next?" }], createdAt: NOW - 3_600_000, messageIds: { "0": "555" } };
  const chans = async () => ({ name: "main-github-firstmate", archived: false, finance: false });
  function fixture(items: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "mqm-"));
    mkdirSync(join(dir, "receipts"));
    writeFileSync(join(dir, "items.json"), JSON.stringify({ items }));
    writeFileSync(join(dir, "asks.json"), JSON.stringify({ sets: [set] }));
    return dir;
  }
  async function boards(items: unknown[]) {
    const dir = fixture(items);
    const src = { asksFile: join(dir, "asks.json"), chanInfo: chans, guildId: "9" };
    const fm = fakeChannel("bot");
    const ny = fakeChannel("bot");
    const base = { botId: () => "bot", itemsFile: join(dir, "items.json"), dash: DASH, log: () => {}, now: () => NOW };
    const mq = new MasterQueueBoard({ ...base, getChannel: async () => fm.ch, jobs: () => [], mayBeBelow: () => false, receiptsDir: join(dir, "receipts"), stateFile: join(dir, "mq.json"), menus: src });
    const nb = new NeedsYouBoard({ ...base, getChannel: async () => ny.ch, stateFile: join(dir, "ny.json"), alerts: false, ...src });
    await mq.refresh();
    await nb.refresh();
    return { master: fm.list.map((m) => m.content).join("\n"), needs: ny.list.map((m) => m.content).join("\n") };
  }
  const links = (t: string) => [...t.matchAll(/\]\(<(https:[^>]+)>\)/g)].map((m) => m[1]!).filter((u) => !u.startsWith(DASH)).sort();

  test("an open menu with no card shows on the master board, with its link and age", async () => {
    const { master, needs } = await boards([]);
    expect(master).toContain("✍️ **Needs you** (1)");
    expect(master).toContain(`· 1h 0m\n🔗 [Open](<${MENU}>)`);
    expect(links(master)).toEqual(links(needs));
  });

  test("a card whose q is that menu shows once; both boards list the same items", async () => {
    const { master, needs } = await boards([
      { id: "pw", t: "DemoApp next step", s: "open", action: "Do the step", q: MENU, cts: NOW - 600_000 },
      { id: "w1", t: "Approve deploy", s: "waiting", action: "Do the step", src: "https://discord.com/channels/9/102/777", cts: NOW - 60_000 },
      { id: "b1", t: "Login needed", s: "blocked", action: "Do the step", q: "https://discord.com/channels/9/103/888", cts: NOW - 60_000 },
      { id: "r1", t: "Running job", s: "running" },
    ]);
    expect(master).toContain("✍️ **Needs you** (3)");
    expect(master.split(MENU).length - 1).toBe(1);
    expect(master).toContain("DemoApp next step");
    expect(master).not.toContain("What should the DemoApp");
    expect(links(master)).toEqual(links(needs));
  });

  test("no menu source: cards only (old behaviour)", () => {
    const rows = needsRows([{ id: "o1", t: "Pick layout", s: "open", action: "Do the step" }], NOW, DASH);
    expect(rows.map((r) => r.key)).toEqual(["need:o1"]);
  });
});

import { rowLine as _rowLine, TITLE_MAX as _TM } from "../src/masterqueue.ts";
test("title line fits one phone line (owner 2026-10-24)", () => {
  const line = _rowLine({ key: "k", title: "A very long job title that would wrap on a phone screen", link: "https://x/y", where: "<#1>", state: "queued", at: 0 } as any, 60_000);
  const label = (line.split("\n")[0] ?? "").match(/\[(.*?)\]/)?.[1] ?? "";
  expect(label.length).toBeLessThanOrEqual(_TM);
  expect(label.endsWith("…")).toBe(true);
});

test("terminal job: just 💻 · stack link (owner 2026-10-24)", async () => {
  const { rowLine } = await import("../src/masterqueue.ts");
  const l = rowLine({ key: "j", title: "T", where: "💻", state: "running", at: NOW, stack: "infra", stackChannel: "9" }, NOW);
  expect(l).toContain("↳ <#9>\n\u2003\u2003\u2003\u2003↳ 💻");
  expect(l).not.toContain("stack:");
});

import { readReceipts } from "../src/masterqueue.ts";
test("readReceipts: two files for one card keep the newest receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ card: "c1", result: "done", tsMs: 2000 }));
  writeFileSync(join(dir, "z.json"), JSON.stringify({ card: "c1", result: "failed", tsMs: 1000 }));
  writeFileSync(join(dir, "b.json"), JSON.stringify({ card: "c3", result: "failed", tsMs: 1000 }));
  writeFileSync(join(dir, "y.json"), JSON.stringify({ card: "c3", result: "done", tsMs: 2000 }));
  writeFileSync(join(dir, "c2.json"), JSON.stringify({ result: "done", tsMs: "5" }));
  const r = readReceipts(dir);
  expect(r.get("c1")!.result).toBe("done");
  expect(r.get("c3")!.result).toBe("done");
  expect(r.get("c2")!.result).toBe("done");
});

test("master queue needs rows are action blocks with the unblock count (owner 2026-10-25)", async () => {
  const { rowLine } = await import("../src/masterqueue.ts");
  const l = rowLine({ key: "need:r", title: "Pick a host", where: "x", steps: ["Pick A"], unblocks: 2, link: "https://discord.com/channels/1/2/3", state: "needs", at: NOW }, NOW);
  expect(l).toContain("🏃 Pick a host");
  expect(l).toContain("👉 1. Pick A");
  expect(l).toContain("🔓 unblocks 2 cards");
});
