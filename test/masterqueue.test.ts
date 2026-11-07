import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsYouBoard, type BoardChannel, type BoardMsg } from "../src/needsyou.ts";
import { botRows, botsLine, downUnits, cardRows, cutWords, whyLink, firstSentence, herdrPlace, jobPlace, needsRows, parseHerdrPanes, parseHerdrTabs, isMasterBoard, renderMasterPages, KEEP_FINISHED_MS, MasterQueueBoard, renderMaster, rowLine, GEAR_TOKEN, type FmCard, type LiveJob, type Receipt } from "../src/masterqueue.ts";
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
    expect(by["card:tr"]?.title).toBe("tr");
  });

  test("blocked receipt (card fm-job-cap-ci-wait): the card keeps a ⛔ row with the worker's reason after the job is unlinked", () => {
    const why = "waiting on CI: PR #212, run https://github.com/o/r/actions/runs/1, 40 jobs queued ahead since 14:05Z";
    const cards: FmCard[] = [
      { id: "b1", t: "Webapp fix", s: "partial", cts: NOW - 60_000 },
      { id: "b2", t: "Old block", s: "partial", cts: NOW - 60_000 },
      { id: "tr", t: "Sell 100 XYZ", area: "finance", s: "partial" },
      { id: "p1", t: "Plain partial", s: "partial" },
      { id: "tc", t: "Webapp CI", area: "finance", s: "partial" },
      { id: "pl", t: "Re-queued by fm-spawn", s: "planned", job: "wB:p9" },
    ];
    const receipts = new Map<string, Receipt>([
      ["b1", { card: "b1", result: "blocked", tsMs: NOW - 600_000, summary: why }],
      ["b2", { card: "b2", result: "blocked", tsMs: NOW - KEEP_FINISHED_MS - 1, summary: why }],
      ["tr", { card: "tr", result: "blocked", tsMs: NOW - 600_000, summary: "sell 100 at $5" }],
      ["tc", { card: "tc", result: "blocked", tsMs: NOW - 600_000, summary: "waiting on CI: PR #7" }],
      ["pl", { card: "pl", result: "blocked", tsMs: NOW - 600_000, summary: why }],
    ]);
    const by = Object.fromEntries(cardRows(cards, receipts, NOW, DASH).map((r) => [r.key, r]));
    expect(by["card:b1"]).toMatchObject({ state: "blocked", where: "⛔ waiting on CI: PR #212, run 🔗, 40 jobs queued ahead since 14:05Z", at: NOW - 600_000 });
    expect(by["card:b2"]).toBeUndefined();
    expect(by["card:tr"]?.where).toBe("⛔ blocked");
    expect(by["card:p1"]).toBeUndefined();
    expect(by["card:tc"]?.where).toBe("⛔ waiting on CI: PR #7");
    expect(by["card:pl"]?.state).toBe("queued");
    const line = rowLine(by["card:b1"]!, NOW);
    expect(line).toContain("↳ ⏳ [CI](<http");
  });

  test("a blocked card whose only blocker is parked (backlog) says 🗃️ parked, never 'blocker done' (card mainblocker-backlog)", () => {
    const cards: FmCard[] = [
      { id: "par", t: "Parent", s: "partial", blockedBy: ["kid"] },
      { id: "kid", t: "Second part", s: "backlog" },
      { id: "par2", t: "Parent 2", s: "partial", blockedBy: ["kid", "run"] },
      { id: "run", t: "Running part", s: "running", job: "wB:p1" },
    ];
    const receipts = new Map<string, Receipt>([
      ["par", { card: "par", result: "blocked", tsMs: NOW - 600_000, summary: "waits for kid" }],
      ["par2", { card: "par2", result: "blocked", tsMs: NOW - 600_000, summary: "waits" }],
    ]);
    const by = Object.fromEntries(cardRows(cards, receipts, NOW, DASH).map((r) => [r.key, r]));
    expect(by["card:par"]?.where).toBe("🗃️ parked: kid");
    expect(by["card:par2"]?.where).toBe(`⛔ ${GEAR_TOKEN} [Running part](<${DASH}?item=run>)`);
  });

  test("blocked rows get their own section with the reason line; they are not counted as finished (card fm-job-cap-ci-wait)", () => {
    const pages = renderMasterPages([
      { key: "card:b1", title: "Webapp fix", where: "⛔ waiting on CI: PR #212, run 🔗, 40 jobs queued ahead since 14:05Z", state: "blocked", at: NOW - 600_000 },
      { key: "card:d1", title: "Done work", where: "💻", state: "done", at: NOW - 60_000 },
    ], NOW, DASH);
    const text = pages.join("\n");
    expect(text).toContain("⛔ **Blocked** (1)");
    expect(text).toContain("⛔ waiting on CI: PR #212, run 🔗, 40 jobs queued ahead since 14:05Z");
    expect(text).toContain("🏁 **Finished, last 12 h:** 1 →");
  });

  test("blocked reason (card mq-blocked-reason-full): first sentence, ≤ 100 chars cut at a word, plus a why link to the receipt in the dashboard", () => {
    const long = "Local fix ready in worktree webapp-wt-dep63 (vinext 1.3 drops next/router from optimizer include; doctor pins synced and the lockfile matches). Commit is blocked because biome fails.";
    const cards: FmCard[] = [
      { id: "s1", t: "Short reason", s: "partial" },
      { id: "l1", t: "Long reason", s: "partial" },
    ];
    const receipts = new Map<string, Receipt>([
      ["s1", { card: "s1", result: "blocked", tsMs: NOW - 600_000, summary: "Fix pushed (ca2e1f41). CI run 4153 still waits on queued shards." }],
      ["l1", { card: "l1", result: "blocked", tsMs: NOW - 600_000, summary: long }],
    ]);
    const by = Object.fromEntries(cardRows(cards, receipts, NOW, DASH).map((r) => [r.key, r]));
    expect(by["card:s1"]).toMatchObject({ state: "blocked", where: "⛔ Fix pushed (ca2e1f41)", why: `${DASH}?item=s1&why=1&receipt=s1.json` });
    const line = rowLine(by["card:l1"]!, NOW);
    const detail = line.split("\n").at(-1)!;
    // The reason is cut at a word (no half word before "…") and the full text is one tap away.
    expect(detail).toContain("↳ ⛔ blocked · 🗃️ [Card](<");
    expect(detail).toEndWith(` · 🗃️ [Card](<${DASH}?item=l1&why=1&receipt=l1.json>)`);
    expect(detail).not.toContain("Commit is blocked");
    // No dashboard URL: no why link, the row still renders.
    expect(cardRows(cards, receipts, NOW, "").find((r) => r.key === "card:s1")?.why).toBeUndefined();
    // The why link opens the file the reason came from (its name may differ from the card id).
    const odd = cardRows([{ id: "a b", t: "x", s: "partial" }], new Map([["a b", { card: "a b", result: "blocked", tsMs: NOW - 1, summary: "y", file: "old name.json" }]]), NOW, DASH)[0];
    expect(odd?.why).toBe(`${DASH}?item=a%20b&why=1&receipt=old%20name.json`);
    expect(firstSentence("vinext 1.3 drops next/router. Then more.")).toBe("vinext 1.3 drops next/router");
    expect(cutWords("aaa bbb ccc", 8)).toBe("aaa bbb…");
    expect(cutWords("short", 100)).toBe("short");
  });

  test("blockedBy (card mq-blocked-reason-full): 'waits for <blocker title> (<state>)' instead of the receipt text", () => {
    const cards: FmCard[] = [
      { id: "dep", t: "Report page data", s: "partial", blockedBy: ["ci-prio"] },
      { id: "dep2", t: "Two blockers", s: "partial", blockedBy: ["ci-prio", "gone-card", "Finished blocker"] },
      // A reverse `blocks` edge counts too (same resolver as the dashboard and fm-audit).
      { id: "dep3", t: "Blocked via blocks", s: "partial" },
      { id: "rev", t: "Reverse blocker", s: "running", blocks: "dep3" },
      { id: "ci-prio", t: "Webapp CI: deploys/live line first; cap Dependabot", s: "running" },
      { id: "done-card", t: "Finished blocker", s: "done" },
    ];
    const receipts = new Map<string, Receipt>([
      ["dep", { card: "dep", result: "blocked", tsMs: NOW - 600_000, summary: "waiting on CI: PR #158, run https://x/1, 1 run ahead." }],
      ["dep2", { card: "dep2", result: "blocked", tsMs: NOW - 600_000, summary: "blocked." }],
      ["dep3", { card: "dep3", result: "blocked", tsMs: NOW - 600_000, summary: "blocked." }],
    ]);
    const by = Object.fromEntries(cardRows(cards, receipts, NOW, DASH).map((r) => [r.key, r]));
    expect(by["card:dep"]).toMatchObject({ state: "blocked", where: `⛔ ${GEAR_TOKEN} [Webapp CI: deploys/live line first…](<${DASH}?item=ci-prio>)`, why: `${DASH}?item=dep&why=1&receipt=dep.json` });
    // Only open blockers are named (a title ref to a done card is cleared); a name that is not a card is never done.
    expect(by["card:dep2"]?.where).toBe(`⛔ ${GEAR_TOKEN} [Webapp CI: deploys/live line first…](<${DASH}?item=ci-prio>), ❔ gone-card`);
    expect(by["card:dep3"]?.where).toBe(`⛔ ${GEAR_TOKEN} [Reverse blocker](<${DASH}?item=rev>)`);
    // A blocker title cannot break the why link or ping anyone.
    const md = cardRows([{ id: "d3", t: "x", s: "partial", blockedBy: "mdb" }, { id: "mdb", t: "Fix [link](x) for <@123>", s: "running" }], new Map([["d3", { card: "d3", result: "blocked", tsMs: NOW - 1, summary: "b" }]]), NOW, DASH)[0]!.where;
    expect(md).not.toContain("<@");
    expect(md.match(/\[/g)?.length).toBe(1); // only the link itself, no brackets from the title
  });

  test("blocker done (card mq-blocked-reason-full): a dependent whose blockers are all done is 🔧 'blocker done; needs a check'", () => {
    const cards: FmCard[] = [
      { id: "dep", t: "Overseer section live", s: "partial", blockedBy: ["perf", "perf2"] },
      { id: "perf", t: "Dashboard perf", s: "done" },
      { id: "perf2", t: "Dashboard perf 2", s: "done" },
    ];
    const receipts = new Map<string, Receipt>([["dep", { card: "dep", result: "blocked", tsMs: NOW - 600_000, summary: "Section only in commit 19d9c33." }]]);
    const rows = cardRows(cards, receipts, NOW, DASH);
    expect(rows).toEqual([expect.objectContaining({ key: "card:dep", state: "check", where: "Needs check 🔍", why: `${DASH}?item=dep&why=1&receipt=dep.json` })]);
    // A blocked receipt without blockers keeps its ⛔ reason (no blockers is not "blocker done").
    const plain = cardRows([{ id: "p", t: "p", s: "partial" }], new Map([["p", { card: "p", result: "blocked", tsMs: NOW - 1, summary: "waiting on CI." }]]), NOW, DASH)[0];
    expect(plain).toMatchObject({ state: "blocked", where: "⛔ waiting on CI" });
    const text = renderMasterPages(rows, NOW, DASH).join("\n");
    expect(text).toContain("✅ 🔧 🔍 **Needs Check**\n");
    expect(text).not.toContain("Needs Check** (");
    expect(text).not.toContain("⛔ **Blocked**");
    expect(text).toContain(`↳ 🧭 firstmate stack · 🗃️ [Card](<${DASH}?item=dep&why=1&receipt=dep.json>)`);
    expect(text).not.toContain("Needs check 🔍"); // no second detail line
    // Not counted as finished.
    expect(text).toContain("🏁 **Finished, last 12 h:** 0");
  });

  test("bot jobs: live first, finished kept 24 h, a live id wins over its saved finish", () => {
    const live: LiveJob[] = [{ id: 7, title: "fix the bot", channelId: "c1", link: MSG, state: "running", since: NOW - 120_000 }];
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
    expect(text).toContain(`⚙️ [Running one](<${MSG}>) · 5m\n\u2003\u2003↳ 🧭 finance stack\n\u2003\u2003\u2003\u2003↳ <#c1>`);
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
    expect(all).not.toContain("(continued)"); // owner 2026-11-03
    // Owner 2026-11-03: no blank gap where a page starts (mark inside the first line, no spacer line first).
    for (const p of pages.slice(1)) { const first = p.split("\n")[0]!; expect(first.replace(/[\u200b\u2063\s]/g, "").length).toBeGreaterThan(0); }
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
  const sends: { flags?: number }[] = [];
  const ch: BoardChannel = {
    send: async (o) => {
      sends.push({ flags: o.flags });
      const m = mk(o.content);
      list.unshift(m);
      return m;
    },
    messages: { fetch: async () => new Map(list.map((m) => [m.id, m])) },
  };
  const post = (content: string, author: string) => list.unshift(mk(content, author));
  return { ch, list, post, sends };
}

describe("MasterQueueBoard", () => {
  test("keeps one board at the bottom (the ⏳ Queue box may sit below), never edits (new silent post replaces the old board), keeps finished jobs across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mq-"));
    const items = join(dir, "items.json");
    mkdirSync(join(dir, "receipts"));
    writeFileSync(items, JSON.stringify({ items: [{ id: "side", t: "Side session job", s: "running", job: "wB:p9", cts: NOW - 60_000 }] }));
    const f = fakeChannel("bot");
    f.post("📋 **Master queue** old", "bot");
    let live: LiveJob[] = [{ id: 1, title: "owner task", channelId: "c1", link: MSG, state: "running", since: NOW - 60_000 }];
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

    // Rows change: a NEW silent board is posted and the old one deleted; no message is edited (owner 2026-10-30).
    let edits = 0;
    for (const m of f.list) { const e = m.edit; m.edit = async (o) => (edits++, e(o)); }
    f.post("⏳ **Queue**", "bot");
    const id = f.list[1]!.id;
    live = [];
    b.finished(1, "done", { title: "owner task", channelId: "c1", link: MSG });
    await b.refresh();
    expect(edits).toBe(0);
    expect(f.list.some((m) => m.id === id)).toBe(false);
    expect(f.list[0]!.content).toContain("🏁 **Finished, last 12 h:** 1");
    expect(f.list[1]!.content).toBe("⏳ **Queue**");
    expect(f.sends.at(-1)!.flags! & 4096).toBe(4096);

    // Owner writes: the board moves back to the bottom.
    f.post("hi", "owner");
    await b.refresh(true);
    expect(isMasterBoard(f.list[0]!.content)).toBe(true);
    expect(f.list.filter((m) => isMasterBoard(m.content)).length).toBe(1);

    // Restart: the finished job is still listed (state file).
    const b2 = new MasterQueueBoard(opts);
    expect(b2.rows().some((r) => r.key === "job:1" && r.state === "done")).toBe(true);
  });

  test("same rows: no repost for stamp or elapsed-time changes within 10 min; never an edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mq-"));
    mkdirSync(join(dir, "receipts"));
    const items = join(dir, "items.json");
    writeFileSync(items, JSON.stringify({ items: [] }));
    const f = fakeChannel("bot");
    let now = NOW;
    const b = new MasterQueueBoard({
      getChannel: async () => f.ch,
      botId: () => "bot",
      jobs: () => [{ id: 1, title: "owner task", channelId: "c1", link: MSG, state: "running", since: NOW - 60_000 }],
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
    expect(f.list[0]!.id).toBe(board.id);
    now += 300_001;
    await b.refresh();
    expect(edits).toBe(0);
    expect(f.list[0]!.id).toBe(board.id); // only "1m" -> "6m" changed: no repost yet
    now += 300_000;
    await b.refresh();
    expect(edits).toBe(0);
    expect(f.list[0]!.id).not.toBe(board.id); // after 10 min the elapsed time is refreshed by a new post
    expect(f.list.filter((m) => isMasterBoard(m.content)).length).toBe(1);
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
    expect(jobPlace(["ex-daily-retry.timer", "wB:p1"])).toBe("background service ex-daily-retry");
    expect(jobPlace([])).toBe("💻 no job recorded");
    expect(jobPlace("ex-daily-retry.timer")).toBe("background service ex-daily-retry");
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
  test("cards on one live pane: every row shows the first row's channel link (owner 2026-11-02)", () => {
    const panes = [{ pane_id: "wB:pPV", tab_id: "wB:tBP" }];
    const tabs = [{ tab_id: "wB:tBP", label: "📈 webapp-phases" }];
    const res = { job: (j: string) => herdrPlace(j, panes, tabs) };
    const rows = cardRows([
      { id: "webapp-phases", t: "Webapp phases", job: "wB:pPV", s: "running" },
      { id: "master-rules-webapp", t: "Master rules in Webapp", job: "📈 webapp-phases", s: "running" },
      { id: "third", t: "Third on same pane", job: "wB:pPV", s: "running" },
      { id: "other", t: "Other", job: "wB:pGONE", s: "running" },
      { id: "other2", t: "Other 2", job: "wB:pGONE", s: "running" },
    ], new Map(), NOW, DASH, res);
    expect(rows.map((r) => r.where)).toEqual(["💻 📈 webapp-phases", "💻 📈 webapp-phases", "💻 📈 webapp-phases", "💻 closed tab", "💻 closed tab"]);
    // A blocked card (no job row) listed first must not own the session (review finding).
    const rows2 = cardRows([
      { id: "b", t: "Blocked first", job: "wB:pPV", s: "blocked", action: "Do the step" },
      { id: "r", t: "Running", job: "wB:pPV", s: "running" },
    ], new Map(), NOW, DASH, res);
    expect(rows2.map((r) => r.where)).toEqual(["💻 📈 webapp-phases"]);
    expect(jobPlace("wB:pX", { job: () => ({ session: "wB:pX" }) })).toBe("💻 terminal tab");
    expect(rows.map((r) => rowLine(r, NOW)).join("\n")).not.toContain("same session as");
  });
});

describe("bots section (owner 2026-10-24)", () => {
  test("service/timer/remote cards leave Running and list under 🤖 Bots", async () => {
    const { renderMaster } = await import("../src/masterqueue.ts");
    const rows = cardRows([
      { id: "b1", t: "Discord bot", job: "omp-discord-bot.service", s: "running" },
      { id: "b2", t: "Sync", job: ["remote:example-sync.timer"], s: "running" },
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

test("needs-you cards at the bottom of the master queue (owner 2026-11-03, card mq-needs-bottom)", async () => {
  const { needsRows, renderMaster } = await import("../src/masterqueue.ts");
  const rows = needsRows([{ id: "w1", t: "Approve deploy", s: "waiting", action: "Do the step", q: "https://discord.com/channels/1/2/3" }, { id: "o1", t: "Pick layout", s: "open", action: "Do the step" }, { id: "x", t: "Other", s: "running" }], NOW, DASH);
  expect(rows.map((r) => r.key)).toEqual(["need:w1", "need:o1"]);
  const t = renderMaster(rows, NOW, DASH);
  expect(t).toContain("✍️ **Needs you** (2)");
  expect(t).toContain("🏃 Approve deploy · 0m\n👉 1. Do the step\n🔗 [Open](<https://discord.com/channels/1/2/3>)");
  expect(t.indexOf("Needs you")).toBeGreaterThan(t.indexOf("Finished"));
  expect(t.indexOf("Needs you")).toBeGreaterThan(t.indexOf("Bots and scheduled jobs"));
  expect(t.indexOf("Needs you")).toBeLessThan(t.lastIndexOf("Dashboard: running jobs"));
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
  // The kept file name is recorded for the board's why link.
  expect([r.get("c1")!.file, r.get("c3")!.file, r.get("c2")!.file]).toEqual(["a.json", "y.json", "c2.json"]);
});

test("master queue needs rows are action blocks with the unblock count (owner 2026-10-25)", async () => {
  const { rowLine } = await import("../src/masterqueue.ts");
  const l = rowLine({ key: "need:r", title: "Pick a host", where: "x", steps: ["Pick A"], unblocks: 2, link: "https://discord.com/channels/1/2/3", state: "needs", at: NOW }, NOW);
  expect(l).toContain("🏃 Pick a host");
  expect(l).toContain("👉 1. Pick A");
  expect(l).toContain("🔓 unblocks 2 cards");
});

test("needs-you alerts-only mode: no board in FIRSTMATE, one ping per new card (owner 2026-10-27)", async () => {
  const { NeedsYouBoard } = await import("../src/needsyou.ts");
  const dir = mkdtempSync(join(tmpdir(), "nyao-"));
  const items = join(dir, "items.json");
  writeFileSync(items, JSON.stringify({ items: [] }));
  const fm = fakeChannel("bot");
  const nb = new NeedsYouBoard({ getChannel: async () => fm.ch, botId: () => "bot", itemsFile: items, stateFile: join(dir, "s.json"), dash: DASH, log: () => {}, now: () => NOW, alertsOnly: true });
  await nb.refresh();
  expect(fm.list.length).toBe(0);
  writeFileSync(items, JSON.stringify({ items: [{ id: "w1", t: "Do it", s: "waiting", q: "https://discord.com/channels/1/2/3", action: "Tap it", cts: NOW }] }));
  await nb.refresh();
  expect(fm.list.length).toBe(1);
  expect(fm.list[0]!.content.startsWith("🔔")).toBe(true);
});


test("mq-top-link: dashboard link near the top and at the bottom, no context line", () => {
  const now = Date.now();
  const rows = [{ key: "a", title: "job", where: "x", state: "running" as const, at: now - 60_000 }];
  for (const text of [renderMaster(rows, now, "https://d"), renderMaster([], now, "https://d")]) {
    const ls = text.split("\n");
    expect(ls.slice(0, 4).some((l) => l.includes("Dashboard: running jobs"))).toBe(true);
    expect(ls.slice(-3).some((l) => l.includes("Dashboard: running jobs"))).toBe(true);
    expect(text).not.toContain("context:");
  }
});

test("multi-page board: ✍️ Needs you ends up on the last page (card mq-needs-bottom)", async () => {
  const { needsRows, renderMasterPages } = await import("../src/masterqueue.ts");
  const need = needsRows([{ id: "w1", t: "Approve deploy", s: "waiting", action: "Do the step", q: "https://discord.com/channels/1/2/3" }], NOW, DASH);
  const running = Array.from({ length: 40 }, (_, i) => ({ key: `job:${i}`, title: `Running job number ${i} with a long title to fill the page`, where: "💬 x", state: "running", at: NOW - i * 1000 }));
  const pages = renderMasterPages([...running, ...need] as never, NOW, DASH, 1900);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.at(-1)).toContain("✍️ **Needs you** (1)");
  for (const p of pages.slice(0, -1)) expect(p).not.toContain("Needs you");
});

test("why link (card why-link-dashboard): opens the dashboard 🧾 Why panel, never the raw receipt JSON", () => {
  const dash = "https://my-host.example-tailnet.ts.net/reports/firstmate/";
  const u = new URL(whyLink(dash, "a&b c", "old name.json"));
  // Same dashboard page as the card links, with the deep-link params the dashboard reads (deeplink-contract.md C13).
  expect(u.origin + u.pathname).toBe(dash);
  expect(u.searchParams.get("item")).toBe("a&b c");
  expect(u.searchParams.get("why")).toBe("1");
  // The receipt file name is kept (it may differ from the card id).
  expect(u.searchParams.get("receipt")).toBe("old name.json");
  expect(u.pathname).not.toContain("receipts/");
  // Safe inside Discord's [why](<url>) markdown: no space or angle bracket.
  expect(whyLink(dash, "x>y", "x y.json")).not.toMatch(/[\s<>]/);
});

describe("stack-coverage: every row shows its stack", () => {
  test("a stack without a live thread shows its name; a linked stack shows the link", () => {
    const base = { key: "card:x", title: "Gamma Forge", where: "<#99>", state: "running" as const, at: NOW };
    expect(rowLine({ ...base, stack: "webapp" }, NOW)).toContain("↳ 🧭 webapp stack\n");
    expect(rowLine({ ...base, stack: "webapp" }, NOW)).toContain("↳ <#99>");
    expect(rowLine({ ...base, stack: "webapp", stackChannel: "77" }, NOW)).toContain("↳ <#77>\n");
    expect(rowLine({ ...base, stack: "webapp", stackChannel: "99" }, NOW)).not.toContain("🧭");
  });
});

import { moveDelay, MOVE_QUIET_MS, MOVE_MAX_WAIT_MS } from "../src/masterqueue.ts";
import { test as t5, expect as e5 } from "bun:test";
t5("board move waits for a quiet channel, capped during a long stream (owner 2026-11-04)", () => {
  e5(moveDelay(1000, 1000)).toBe(MOVE_QUIET_MS); // first message: wait for quiet
  e5(moveDelay(1000, 1000 + 20_000)).toBe(MOVE_QUIET_MS); // still inside the cap: each message resets the quiet wait
  e5(moveDelay(1000, 1000 + MOVE_MAX_WAIT_MS - 3_000)).toBe(3_000); // near the cap: only the time left
  e5(moveDelay(1000, 1000 + MOVE_MAX_WAIT_MS + 5_000)).toBe(0); // past the cap: move now
});

import { cardRows as cr6, renderMasterPages as rmp6 } from "../src/masterqueue.ts";
import { test as t6, expect as e6 } from "bun:test";
t6("a card blocked on an owner question links the question in its row (owner 2026-11-05)", () => {
  const Q = "https://discord.com/channels/1/2/3";
  const now = Date.now();
  const rc = new Map([["c1", { result: "blocked", summary: "Waits on owner pick.", tsMs: now }], ["c2", { result: "blocked", summary: "Waits on CI.", tsMs: now }]]) as Map<string, Receipt>;
  const rows = cr6([{ id: "c1", t: "Needs owner pick", s: "partial", q: Q }], rc, now, "https://dash.example");
  const r = rows.find((x) => x.key === "card:c1");
  e6(r?.question).toBe(Q);
  const text = rmp6(rows, Date.now(), "https://dash.example").join("\n");
  e6(text).toContain(`🙋 [you](<${Q}>)`);
  const plain = cr6([{ id: "c2", t: "No question", s: "partial" }], rc, now, "https://dash.example").find((x) => x.key === "card:c2");
  e6(plain?.question).toBeUndefined();
});

import { answeredMenuIds as _answeredMenuIds } from "../src/needsyou.ts";
describe("answered owner question leaves ⛔ Blocked (card answered-menu-clears-block)", () => {
  const T = Date.UTC(2026, 10, 5, 12);
  const Q = (m: string) => `https://discord.com/channels/1/2/${m}`;
  const cards: FmCard[] = [
    { id: "open", t: "Open q", s: "partial", q: Q("111") },
    { id: "ans", t: "Answered q", s: "partial", q: Q("222") },
    { id: "late", t: "Answered after receipt", s: "partial", queued: T - 60_000 },
  ];
  const receipts = new Map<string, Receipt>(cards.map((c) => [c.id, { card: c.id, result: "blocked", tsMs: T - 600_000, summary: "needs owner pick" }]));
  test("open menu keeps the ❓ link; answered menu or a later answer shows 📨 needs pickup without a link", () => {
    const by = Object.fromEntries(cardRows(cards, receipts, T, "", undefined, new Map([["222", "4 Hold"]])).map((r) => [r.key, r]));
    expect(by["card:open"]).toMatchObject({ state: "blocked", question: Q("111") });
    expect(by["card:ans"]).toMatchObject({ state: "check", where: "📨 answered; needs pickup" });
    expect(by["card:ans"]?.question).toBeUndefined();
    expect(by["card:late"]).toMatchObject({ state: "check", where: "📨 answered; needs pickup" });
    expect(rowLine(by["card:open"]!, T)).toContain(`🙋 [you](<${Q("111")}>)`);
    expect(rowLine(by["card:ans"]!, T)).not.toContain("❓");
  });
  test("answeredMenuIds reads open and closed sets; cancelled sets do not count", () => {
    const dir = mkdtempSync(join(tmpdir(), "amids-"));
    const f = join(dir, "asks.json");
    writeFileSync(f, JSON.stringify({
      sets: [
        { setId: "a", channelId: "2", questions: [{ id: "q1", question: "?" }, { id: "q2", question: "?" }], answers: { q1: ["4 Hold"] }, messageIds: { "0": "10", "1": "11" }, createdAt: 1 },
        { setId: "r", channelId: "2", questions: [{ id: "q1", question: "?" }], answers: {}, responded: { "0": { at: 1, via: "text" } }, messageIds: { "0": "12" }, createdAt: 1 },
      ],
      closed: [
        { setId: "c", channelId: "2", questions: [{ id: "q1", question: "?" }], answered: true, answers: { q1: ["Yes"] }, messageIds: { "0": "20" }, createdAt: 1 },
        { setId: "k", channelId: "2", questions: [{ id: "q1", question: "?" }], answered: true, clarify: { q1: "which one?" }, messageIds: { "0": "40" }, createdAt: 1 },
        { setId: "x", channelId: "2", questions: [{ id: "q1", question: "?" }], cancelled: true, answered: false, messageIds: { "0": "30" }, createdAt: 1 },
      ],
    }));
    const m = _answeredMenuIds(f);
    expect([...m.entries()].sort()).toEqual([["10", "4 Hold"], ["12", ""], ["20", "Yes"]]);
  });
});

test("Blocked row: blocker title links like its Running row, gear for running, 🗃️ Card link (owner 2026-11-07)", () => {
  const cards: FmCard[] = [{ id: "a", t: "A", s: "partial", blockedBy: ["b"] }, { id: "b", t: "Builder", s: "running", job: "wB:p9" }];
  const rows = cardRows(cards, new Map<string, Receipt>([["a", { card: "a", result: "blocked", tsMs: NOW - 1, summary: "x" }]]), NOW, DASH);
  const text = renderMasterPages(rows, NOW, DASH, 1900, "<a:spin_gear:1>").join("\n");
  expect(text).toContain(`↳ 🔗 waits on [b](<${DASH}?item=b>) · 🗃️ [Card](<`);
  expect(text).not.toContain("waits for");
  expect(text).not.toContain("(running)");
  expect(text).not.toContain(GEAR_TOKEN);
});

describe("bots line: down units with their cards (card unit-down-triage)", () => {
  const c = { running: 27, scheduled: 38, down: 2 };
  test("the unitheal list names what each down unit's card is doing and links the cards", () => {
    const t = botsLine(c, [{ card: "unit-a", state: "healing" }, { card: "unit-b", state: "needs you" }, { card: "unit-c", state: "healing" }], "https://d.example/fm", 0);
    expect(t).toBe("27 running · 38 scheduled · ⚠️ 3 down ([🩹 2 healing · ✍️ 1 needs you](<https://d.example/fm?tag=unit-down>))");
  });
  test("no unitheal list: the plain bots-page count; nothing down: no warning", () => {
    expect(botsLine(c, null, "https://d.example/fm", 0)).toBe("27 running · 38 scheduled · ⚠️ 2 down");
    expect(botsLine({ ...c, down: 0 }, [], "https://d.example/fm", 0)).toBe("27 running · 38 scheduled");
    // the bots page counts more than unitheal tracks: the count stays, the gap is named
    expect(botsLine(c, [{ card: "unit-a", state: "healing" }], "", 0)).toBe("27 running · 38 scheduled · ⚠️ 2 down (🩹 1 healing · 1 without a card)");
    expect(botsLine(null, null, "", 4)).toBe("4 linked to cards");
    expect(botsLine(null, [{ card: "unit-a", state: "blocked" }], "", 4)).toBe("4 linked to cards · ⚠️ 1 down (⛔ 1 blocked)");
  });
  test("downUnits reads a fresh down.json only", () => {
    const dir = mkdtempSync(join(tmpdir(), "down-"));
    const f = join(dir, "down.json");
    const now = Date.parse("2026-11-07T18:00:00Z");
    writeFileSync(f, JSON.stringify({ at: "2026-11-07T17:58:00Z", units: [{ card: "unit-a", state: "blocked", host: "main" }] }));
    expect(downUnits(now, f)).toEqual([{ card: "unit-a", state: "blocked" }]);
    // a row it cannot read: no list at all, so the plain count (never 0 by mistake) is shown
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ at: "2026-11-07T17:58:00Z", units: [{ card: "unit-a", state: "later-state" }] }));
    expect(downUnits(now, join(dir, "bad.json"))).toBeNull();
    expect(downUnits(now + 11 * 60_000, f)).toBeNull();
    expect(downUnits(now, join(dir, "missing.json"))).toBeNull();
  });
});

import { reasonChip as _chip } from "../src/masterqueue.ts";
test("Blocked why line is one emoji + ≤4-word chip that fits a phone line (card mq-blocked-compact)", () => {
  const vis = (s: string) => s.replace(/\[([^\]]*)\]\(<[^>]*>\)/g, "$1");
  const long = "Private #258 closed by webapp-private-pr-migration (link posted), but the public /plays work is still open and waits on review";
  const chips = [
    _chip({ open: ["webapp-private-pr-migration"], byId: new Map(), dash: "", parked: false, qUrl: "", reason: long }),
    _chip({ open: [], byId: new Map(), dash: "", parked: false, qUrl: "", reason: "waiting on CI pipeline" }),
    _chip({ open: [], byId: new Map(), dash: "", parked: false, qUrl: "", reason: "needs an API key" }),
    _chip({ open: [], byId: new Map(), dash: "", parked: false, qUrl: "", reason: long }),
  ];
  expect(chips[1]).toBe("⏳ CI");
  expect(_chip({ open: [], byId: new Map(), dash: "", parked: false, qUrl: "", url: "https://x/mr/258", reason: "waits on PR review" })).toBe("🔀 [PR](<https://x/mr/258>)");
  expect(chips[2]).toBe("🔑 key");
  for (const c of chips) {
    expect(vis(c).split(" ").length).toBeLessThanOrEqual(5);
    expect(`↳ ${vis(c)} · 🗃️ Card`.length).toBeLessThanOrEqual(45);
  }
});
