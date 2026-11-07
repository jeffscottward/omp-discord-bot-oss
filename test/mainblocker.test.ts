import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCKER_HEAD, DrainCheck, parseDrainDry, RunStatus, blockerLines, findBlockers, mainBlockers, readCaps, readCiWaits, readSpawnQueue, receiptCi, writeBlockersFile, type CiWait } from "../src/mainblocker.ts";
import { renderMasterPages, type FmCard, type Receipt, type Row } from "../src/masterqueue.ts";

const DASH = "https://dash.example/reports/firstmate/";
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const RUN = "https://github.com/o/webapp-research/actions/runs/41900402833";

describe("main blocker", () => {
  test("one CI run blocking 5 cards renders the 🚧 line with count, oldest wait and run link", () => {
    const cards: FmCard[] = [
      { id: "a", t: "Job A", s: "running", job: "wB:p1", cts: NOW - 30 * MIN },
      { id: "b", t: "Job B", s: "partial", cts: NOW - 5 * MIN },
      { id: "c", t: "Job C", s: "partial", blockedBy: "a", cts: NOW - 10 * MIN },
      { id: "d", t: "Job D", s: "planned", blockedBy: ["c"], cts: NOW - 10 * MIN },
      { id: "e", t: "Job E", s: "partial", blockedBy: "Job B", cts: NOW - 10 * MIN }, // by title
      { id: "x", t: "Done", s: "done", blockedBy: "a" }, // finished cards are not held up
      { id: "y", t: "Backlog", s: "backlog", blockedBy: "a" },
    ];
    const receipts = new Map<string, Receipt>([["b", { card: "b", result: "blocked", tsMs: NOW - 40 * MIN, summary: `waiting on CI: PR #12, run ${RUN}, 4 jobs queued ahead since 01:00Z` }]]);
    const ci: CiWait[] = [{ card: "a", repo: "o/webapp-research", ref: "41900402833", status: "queued", created: NOW - (6 * 60 + 12) * MIN, url: RUN }];
    const all = findBlockers({ cards, receipts, now: NOW, dash: DASH, ci, runInfo: (k) => (k === "gh:o/webapp-research:41900402833" ? { status: "queued" } : undefined) });
    // The same receipt with a finished (or not yet checked) run is no CI wait: b leaves the CI blocker.
    for (const info of [{ status: "completed" }, undefined]) {
      const again = findBlockers({ cards, receipts, now: NOW, dash: DASH, ci, runInfo: () => info });
      expect(again.find((b) => b.kind === "ci")?.heldIds).not.toContain("b");
    }
    const shown = mainBlockers(all, NOW);
    expect(shown[0]).toMatchObject({ kind: "ci", held: 5, link: RUN, since: NOW - (6 * 60 + 12) * MIN });
    expect(new Set(shown[0]!.heldIds)).toEqual(new Set(["a", "b", "c", "d", "e"]));
    // a and b are CI waiters: no separate card blocker for them.
    expect(all.some((b) => b.key === "card:a" || b.key === "card:b")).toBe(false);
    expect(blockerLines(shown, NOW)[0]).toBe(BLOCKER_HEAD);
    expect(blockerLines(shown, NOW)[1]).toBe(`**1.** CI run webapp-research #41900402833 · queued · ⛔ 5 jobs · ⏱️ 6h 12m → [CI run](<${RUN}>)`);
  });

  test("stack queue and card roots; up to 2 more as small lines; the slot holders on CI are named", () => {
    const cards: FmCard[] = [
      { id: "s1", t: "Slot 1", s: "running", stack: "webapp", job: "wB:p1" },
      { id: "s2", t: "Slot 2, receipt waits on CI", s: "partial", stack: "webapp" },
      { id: "q1", t: "Queued 1", s: "planned", stack: "webapp", cts: NOW },
      { id: "q2", t: "Queued 2", s: "planned", stack: "webapp", cts: NOW },
      { id: "q3", t: "Queued 3", s: "planned", stack: "webapp", cts: NOW },
      { id: "q4", t: "Queued 4", s: "done", stack: "webapp" }, // left the queue: ignored
      { id: "root", t: "Shell [x](y) @everyone", s: "running", job: "wB:p9", src: "https://discord.com/channels/1/2/3" },
      { id: "w1", t: "W1", s: "partial", blockedBy: "root", cts: NOW - 90 * MIN },
      { id: "solo", t: "Solo", s: "partial", blockedBy: "root2", cts: NOW - 5 * MIN },
      { id: "root2", t: "Root 2", s: "partial", cts: NOW },
    ];
    const spawnQueue = [
      { id: "e1", card: "q1", stack: "webapp", tsMs: NOW - 7 * 60 * MIN },
      { id: "e2", card: "q2", stack: "webapp", tsMs: NOW - 60 * MIN },
      { id: "e3", card: "q3", stack: "webapp", tsMs: NOW - 2 * MIN },
      { id: "e4", card: "q4", stack: "webapp", tsMs: NOW - 9 * 60 * MIN },
    ];
    const ci: CiWait[] = [{ card: "s1", repo: "o/r", ref: "1", status: "in_progress", created: NOW - 10 * MIN }, { card: "s2", repo: "o/r", ref: "1", status: "in_progress", created: NOW - 10 * MIN }];
    const drain = { paused: false, tabCapped: [], maxTabs: 30, willStart: [], claimWait: [] };
    const all = findBlockers({ cards, receipts: new Map(), now: NOW, dash: DASH, ci, spawnQueue, caps: { webapp: 3 }, drain });
    const shown = mainBlockers(all, NOW);
    expect(shown.map((b) => b.key)).toEqual(["cap:webapp", "card:root"]);
    // Without fm-spawn's verdict the line claims no reason.
    expect(findBlockers({ cards, receipts: new Map(), now: NOW, dash: DASH, ci, spawnQueue, caps: { webapp: 3 } })[0]!.name).toBe("webapp spawn queue"); // ci:o/r (2 jobs, 10 min) and card:root2 (5 min) do not qualify
    const [head, main, also] = blockerLines(shown, NOW);
    expect(head).toBe(BLOCKER_HEAD);
    expect(main).toBe(`**1.** webapp stack full, max 3 jobs, 2 slots wait on CI · ⛔ 3 jobs · ⏱️ 7h 0m → [queue](<${DASH}?tab=running>)`);
    // Titles lose markdown (same title cleaning as board rows; the board posts with mentions disabled); small subtext line.
    expect(also).toStartWith("**2.** Shell");
    expect(also).not.toContain("-#");
    expect(also).not.toContain("](y)");
    expect(also).toContain("⛔ 1 job · ⏱️ 1h 30m → [card](<https://discord.com/channels/1/2/3>)");
  });

  test("nothing qualifies: no line; the board top stays as before", () => {
    const cards: FmCard[] = [{ id: "r", t: "R", s: "running", job: "wB:p1" }, { id: "w", t: "W", s: "partial", blockedBy: "r", cts: NOW - 5 * MIN }];
    const shown = mainBlockers(findBlockers({ cards, receipts: new Map(), now: NOW, dash: DASH }), NOW);
    expect(shown).toEqual([]);
    expect(blockerLines(shown, NOW)).toEqual([]);
  });

  test("bot job queue counts queued owner jobs", () => {
    const jobs = [1, 2, 3].map((id) => ({ id, title: `j${id}`, channelId: "c", state: "queued" as const, since: NOW - id * MIN }));
    const all = findBlockers({ cards: [], receipts: new Map(), now: NOW, dash: DASH, jobs: [...jobs, { id: 9, title: "r", channelId: "c", state: "running", since: NOW }] });
    expect(mainBlockers(all, NOW)[0]).toMatchObject({ key: "bot:queue", name: "Bot job queue (1 running)", held: 3 });
  });

  test("the Main blocker section sits directly above ✍️ Needs you (owner 2026-11-04)", () => {
    const rows: Row[] = [
      { key: "job:1", title: "t", where: "w", state: "running", at: NOW },
      { key: "needs:x", title: "Answer me", where: "", state: "needs", at: NOW, steps: ["do it"], link: "https://discord.com/channels/1/2/3" },
    ];
    const top = [BLOCKER_HEAD, "**1.** X · ⛔ 3 jobs · ⏱️ 1h 0m", "**2.** Y · ⛔ 1 job · ⏱️ 2h 0m"];
    const page = renderMasterPages(rows, NOW, DASH, 1900, "⚙️", "⏸️ notice", top).join("\n");
    const ls = page.split("\n");
    const at = (p: string) => ls.findIndex((l) => l.startsWith(p));
    expect(at("⏸️ notice")).toBe(3); // the notice stays below the head
    expect(at(BLOCKER_HEAD)).toBeGreaterThan(ls.findIndex((l) => l.includes("**Running**")));
    expect(at("**2.** Y")).toBe(at(BLOCKER_HEAD) + 2);
    // Next lines: a spacer, then the Needs you title.
    expect(ls[at("**2.** Y") + 1]).toBe("\u200b");
    expect(ls[at("**2.** Y") + 2]).toStartWith("✍️ **Needs you** (1)");
    // No Needs you: the section is the last one, above the dashboard link.
    const none = renderMasterPages(rows.slice(0, 1), NOW, DASH, 1900, "⚙️", "", top).join("\n").split("\n");
    expect(none[none.findIndex((l) => l.startsWith("**2.** Y")) + 2]).toStartWith("🗂️ [Dashboard");
  });

  test("receiptCi parses run, PR or nothing", () => {
    expect(receiptCi("c", `waiting on CI: run ${RUN}`, 5)).toMatchObject({ repo: "o/webapp-research", ref: "41900402833", url: RUN });
    expect(receiptCi("c", "CI queued: https://github.com/o/r/pull/7", 5)).toBeNull(); // a PR alone: no run to check
    expect(receiptCi("c", "waiting on pipeline https://gitlab.main/me/bot/-/pipelines/203", 5)).toMatchObject({ repo: "me/bot", ref: "203" });
    expect(receiptCi("c", "blocked on the owner", 5)).toBeNull();
    expect(receiptCi("c", "specific circumstances", 5)).toBeNull();
    // A passing mention is no wait; a wait without a run/PR URL gives no CI blocker (nothing to name or link).
    expect(receiptCi("c", "JEV judge live (7ff7868, CI 500 green). Apply waits for 24 h dry run: https://github.com/o/r/pull/3", 5)).toBeNull();
    expect(receiptCi("c", "Waits for PR #212 in the webapp CI train (runner queue).", 5)).toBeNull();
  });

  test("each held card counts for one blocker only: CI first, then the stack queue", () => {
    const cards: FmCard[] = [
      { id: "ci1", t: "On CI", s: "partial", cts: NOW },
      { id: "q1", t: "Queued, waits for ci1", s: "planned", blockedBy: "ci1", cts: NOW },
      { id: "q2", t: "Queued", s: "planned", cts: NOW },
    ];
    const ci: CiWait[] = [{ card: "ci1", repo: "o/r", ref: "9", status: "queued", created: NOW - 2 * MIN, url: "u" }];
    const spawnQueue = [{ card: "q1", stack: "webapp", tsMs: NOW - 3 * MIN }, { card: "q2", stack: "webapp", tsMs: NOW - MIN }];
    const all = findBlockers({ cards, receipts: new Map(), now: NOW, dash: DASH, ci, spawnQueue, caps: { webapp: 3 }, drain: { paused: false, tabCapped: [], maxTabs: 30, willStart: [], claimWait: [] } });
    const by = Object.fromEntries(all.map((b) => [b.key, b]));
    expect(by["ci:o/r"]).toMatchObject({ held: 2 });
    expect(by["cap:webapp"]).toMatchObject({ held: 1, heldIds: ["q2"] });
    expect(all.reduce((n, b) => n + b.held, 0)).toBe(3);
  });

  test("file readers: overseer (fresh only) + ci cache, spawn queue, caps; dashboard file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-"));
    const ov = join(dir, "overseer.json");
    const cache = join(dir, "ci-cache.json");
    writeFileSync(ov, JSON.stringify({ generated: NOW - MIN, cards: [{ card: "a", ci: { "o/r:55": "queued" } }, { card: "b", ci: {} }] }));
    writeFileSync(cache, JSON.stringify({ "gh:o/r:55": { status: "queued", created: NOW - 9 * MIN, url: "u" } }));
    expect(readCiWaits(ov, cache, NOW)).toEqual([{ card: "a", repo: "o/r", ref: "55", status: "queued", created: NOW - 9 * MIN, url: "u" }]);
    expect(readCiWaits(ov, cache, NOW + 60 * MIN)).toEqual([]); // stale overseer
    expect(readCiWaits(join(dir, "none"), cache, NOW)).toEqual([]);
    const q = join(dir, "queued.jsonl");
    writeFileSync(q, `${JSON.stringify({ id: "1", card: "a", stack: "webapp", tsMs: 1 })}\nnot json\n\n`);
    expect(readSpawnQueue(q)).toEqual([{ id: "1", card: "a", stack: "webapp", tsMs: 1 }]);
    expect(readSpawnQueue(join(dir, "none"))).toEqual([]);
    const caps = join(dir, "caps.json");
    writeFileSync(caps, JSON.stringify({ kb: 2, webapp: null }));
    expect(readCaps(caps)).toEqual({ kb: 2 });
    expect(readCaps(join(dir, "none"))).toEqual({ webapp: 3 });
    const out = join(dir, "mainblocker.json");
    writeBlockersFile(out, [{ key: "ci:o/r", kind: "ci", name: "CI run r #55 (queued)", link: "u", held: 3, heldIds: ["a"], since: NOW - MIN }], NOW);
    const d = JSON.parse(readFileSync(out, "utf8"));
    expect(d).toMatchObject({ generated: NOW, blockers: [{ name: "CI run r #55 (queued)", held: 3, since: NOW - MIN, link: "u", linkLabel: "CI run" }] });
    expect(d.blockers[0].heldIds).toBeUndefined();
  });

  test("RunStatus: looks up once, finished runs are final, active runs recheck after 3 min, failures back off", async () => {
    let t = NOW;
    const calls: string[] = [];
    const answers: Record<string, string | null> = { "1": "queued", "2": "completed", "3": null };
    const rs = new RunStatus(async (_k, _r, id) => (calls.push(id), answers[id] ? { status: answers[id]! } : null), () => t);
    const w = (ref: string): CiWait => ({ card: ref, kind: "gh", repo: "o/r", ref, status: "unknown" });
    expect(await rs.update([w("1"), w("2"), w("3"), w("1")])).toBe(2); // 3 failed: no status change
    expect(calls).toEqual(["1", "2", "3"]);
    expect(rs.get("gh:o/r:1")?.status).toBe("queued");
    expect(await rs.update([w("1"), w("2"), w("3")])).toBe(0);
    expect(calls.length).toBe(3); // nothing stale yet
    t += 3 * MIN;
    answers["1"] = "completed";
    expect(await rs.update([w("1"), w("2"), w("3")])).toBe(1);
    expect(calls.slice(3)).toEqual(["1", "3"]); // 2 is final
    // Lookups now fail: the last "queued" is not refreshed; after RUN_STALE_MS it counts as unknown.
    const fail = new RunStatus(async () => null, () => t);
    const ok = new RunStatus(async () => ({ status: "queued" }), () => t);
    await ok.update([w("7")]);
    expect(ok.get("gh:o/r:7")?.status).toBe("queued");
    let failing = false;
    const flaky = new RunStatus(async () => (failing ? null : { status: "queued" }), () => t);
    await flaky.update([w("8")]);
    failing = true;
    t += 3 * MIN;
    await flaky.update([w("8")]);
    expect(flaky.get("gh:o/r:8")?.status).toBe("queued"); // 3 min old: still trusted
    t += 8 * MIN;
    await flaky.update([w("8")]);
    expect(flaky.get("gh:o/r:8")).toBeUndefined(); // 11 min without a successful check
    expect(await fail.update([w("9")])).toBe(0);
    expect(fail.get("gh:o/r:9")).toBeUndefined();
  });

  test("fm-spawn verdict: tab cap names the blocker and absorbs the fm-tabcap-<ws> card; jobs it would start wait for nothing", () => {
    const out = [
      "DRY CI wait webapp-agent-viewer: PR #222 pending (13 of 16 checks not finished)",
      "fm-spawn --drain-queue: workspace wB is over 30 tabs; its queued jobs wait",
      "fm-spawn --drain-queue: 🔒 claimed job waits: branch:r:x held by card y",
      "DRY would start queued 🧪 go now (x) (stack kb, card go)",
    ].join("\n");
    const v = parseDrainDry(out);
    expect(v).toEqual({ paused: false, tabCapped: ["wB"], maxTabs: 30, willStart: ["🧪 go now (x)"], claimWait: ["🔒 claimed job"] });
    expect(parseDrainDry("fm-spawn --drain-queue: agent work is paused (x); queue kept").paused).toBe(true);
    const cards: FmCard[] = [
      { id: "q1", t: "Q1", s: "planned", stack: "webapp" },
      { id: "q2", t: "Q2", s: "planned", stack: "webapp" },
      { id: "go", t: "Go", s: "planned", stack: "kb" },
      { id: "cl", t: "Claimed", s: "planned", stack: "kb" },
      { id: "fm-tabcap-wB", t: "wB Herdr tab cap", s: "partial", src: "https://discord.com/channels/1/2/9" },
      { id: "dep", t: "Dep", s: "partial", blockedBy: "fm-tabcap-wB", cts: NOW - 30 * MIN },
    ];
    const spawnQueue = [
      { card: "q1", stack: "webapp", label: "Q1", workspace: "wB", tsMs: NOW - 4 * 60 * MIN },
      { card: "q2", stack: "webapp", label: "Q2", tsMs: NOW - 60 * MIN }, // no workspace: the one capped workspace
      { card: "go", stack: "kb", label: "🧪 go now (x)", workspace: "wB", tsMs: NOW - 9 * 60 * MIN },
      { card: "cl", stack: "kb", label: "🔒 claimed job", workspace: "wB", tsMs: NOW - 2 * MIN },
    ];
    const all = findBlockers({ cards, receipts: new Map(), now: NOW, dash: DASH, spawnQueue, caps: { webapp: 3 }, drain: v });
    expect(all[0]).toMatchObject({ key: "cap:tabs:wB", name: "Herdr workspace wB over 30 tabs (fm-spawn starts no queued job)", held: 3, link: "https://discord.com/channels/1/2/9", linkLabel: "card", since: NOW - 4 * 60 * MIN });
    expect(new Set(all[0]!.heldIds)).toEqual(new Set(["q1", "q2", "dep"]));
    expect(all.some((b) => b.key === "card:fm-tabcap-wB" || b.heldIds.includes("go"))).toBe(false);
    expect(all.find((b) => b.key === "cap:claims")?.heldIds).toEqual(["cl"]);
  });

  test("DrainCheck: runs at most every 5 min, keeps the last verdict on failure, drops it after 15 min", async () => {
    let t = NOW;
    let calls = 0;
    let out: string | null = "fm-spawn --drain-queue: workspace wB is over 30 tabs; its queued jobs wait";
    const dc = new DrainCheck(async () => (calls++, out), () => t);
    expect(await dc.update()).toBe(true);
    expect(dc.get()?.tabCapped).toEqual(["wB"]);
    expect(await dc.update()).toBe(false);
    expect(calls).toBe(1);
    t += 5 * MIN;
    out = null;
    expect(await dc.update()).toBe(false);
    expect(dc.get()?.tabCapped).toEqual(["wB"]);
    t += 11 * MIN;
    expect(dc.get()).toBeUndefined();
  });

  // Card mainblocker-backlog (owner 2026-11-05): sec-pw-macdev was parked in backlog, yet the parent's blockedBy kept it
  // as "card:sec-pw-macdev (backlog)" in mainblocker.json. A backlog card that is not a gate holds nothing.
  test("a parked backlog card is never a Main blocker; a backlog gate card still is", () => {
    const cards: FmCard[] = [
      { id: "sec-pw-macdev", t: "Check second-dev (macOS) for Playwright Chromium", s: "backlog", job: "macdev-reach-watch.timer" },
      { id: "sec-playwright-chromium", t: "SECURITY: Playwright", s: "partial", blockedBy: ["sec-pw-macdev"], cts: NOW - 5 * 60 * MIN },
      { id: "w2", t: "W2", s: "planned", blockedBy: "Check second-dev (macOS) for Playwright Chromium", cts: NOW - 5 * 60 * MIN }, // by title
      { id: "w3", t: "W3", s: "partial", blockedBy: "w2", cts: NOW - 5 * 60 * MIN },
      { id: "webapp-ui-pause", t: "Gate: Webapp UI work paused by owner", s: "backlog", src: "https://discord.com/channels/1/2/3" },
      { id: "ui1", t: "UI 1", s: "partial", blockedBy: "webapp-ui-pause", cts: NOW - 5 * 60 * MIN },
      { id: "ui2", t: "UI 2", s: "partial", blockedBy: "webapp-ui-pause", cts: NOW - 5 * 60 * MIN },
      { id: "ui3", t: "UI 3", s: "partial", blockedBy: "webapp-ui-pause", cts: NOW - 5 * 60 * MIN },
      { id: "flagged", t: "Field gate", s: "backlog", gate: true } as FmCard,
      { id: "fw", t: "FW", s: "partial", blockedBy: "flagged", cts: NOW - 5 * 60 * MIN },
    ];
    const all = findBlockers({ cards, receipts: new Map(), now: NOW, dash: DASH });
    expect(all.some((b) => b.key === "card:sec-pw-macdev")).toBe(false);
    // Nothing holds the parent or w2 any more (w2 itself may still hold w3: it is an open planned card).
    expect(all.some((b) => b.heldIds.some((x) => ["sec-playwright-chromium", "w2"].includes(x)))).toBe(false);
    expect(all.find((b) => b.key === "card:webapp-ui-pause")).toMatchObject({ held: 3 });
    expect(all.find((b) => b.key === "card:flagged")).toMatchObject({ held: 1 });
    const dir = mkdtempSync(join(tmpdir(), "mb-park-"));
    const file = join(dir, "mainblocker.json");
    writeBlockersFile(file, mainBlockers(all, NOW), NOW);
    const keys = (JSON.parse(readFileSync(file, "utf8")).blockers as { key: string }[]).map((b) => b.key);
    expect(keys).toContain("card:webapp-ui-pause");
    expect(keys).not.toContain("card:sec-pw-macdev");
  });
});

test("blocker lines: one shape, status split out, ranked, no subtext markers (owner 2026-11-05)", () => {
  const { blockerLine } = require("../src/mainblocker.ts");
  const b = { key: "card:x", kind: "card", name: "Gate: Webapp UI work paused (backlog)", link: "https://x/y", held: 14, heldIds: [], since: NOW - 3_600_000 };
  expect(blockerLine(b, NOW, 1)).toBe("**1.** Gate: Webapp UI work paused · backlog · ⛔ 14 jobs · ⏱️ 1h 0m → [card](<https://x/y>)");
});
