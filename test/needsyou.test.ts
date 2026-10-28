import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoardChannel, type BoardMsg, type FmItem, isNeedsYouBoard, linkLabel, openMenus, NeedsYouBoard, needsYouGroup, needsYouRow, newlyNeeding, renderNeedsYou, snapshot } from "../src/needsyou.ts";

const DASH = "https://dash.example/reports/firstmate/";
const NOW = 1_800_000_000_000;
const MSG = "https://discord.com/channels/1/2/3";
const items: FmItem[] = [
  { id: "w1", t: "Pick a domain", s: "waiting", action: "Do the step", q: MSG, cts: NOW - 3 * 3600_000 },
  { id: "o1", t: "Which model?", s: "open", action: "Do the step", src: "https://discord.com/channels/1/2/4", cts: NOW - 5 * 60_000 },
  // Owner 2026-10-25 (needs-you-action-gate): queued (📨 answered) and no-action cards are never listed.
  { id: "o2", t: "Owner bug report queued", s: "open", action: "Do the step", src: "https://discord.com/channels/1/2/6", cts: NOW, queued: 1 },
  { id: "w2", t: "FYI no action", s: "waiting", q: "https://discord.com/channels/1/2/7", cts: NOW },
  { id: "b1", t: "Login needed", s: "blocked", action: "Do the step", src: "https://discord.com/channels/1/2/5", cts: NOW - 3 * 86400_000 },
  { id: "b2", t: "Blocked on another card", s: "blocked", action: "Do the step", cts: NOW },
  { id: "tr", t: "Sell 100 XYZ acct 1234", area: "finance", s: "waiting", action: "Do the step", cts: NOW },
  { id: "nolink", t: "No link", s: "waiting", action: "Do the step", q: "https://github.com/x/pull/1" },
  { id: "d", t: "Done", s: "done", q: MSG },
];

describe("renderNeedsYou", () => {
  const text = renderNeedsYou(items, NOW, DASH);
  test("groups in order with counts", () => {
    expect(isNeedsYouBoard(text)).toBe(true);
    const w = text.indexOf("Waiting on you** (3)");
    const o = text.indexOf("Open questions** (1)");
    const b = text.indexOf("Blocked on you** (1)");
    expect(w).toBeGreaterThan(0);
    expect(o).toBeGreaterThan(w);
    expect(b).toBeGreaterThan(o);
    expect(text).not.toContain("Done");
    expect(text).not.toContain("Blocked on another card");
  });
  test("rows link the Discord message, else the dashboard card", () => {
    expect(text).toContain(`🏃 Pick a domain · 3h\n👉 1. Do the step\n🔗 [Open](<${MSG}>)`);
    expect(text).toContain("🏃 Which model? · 5m");
    expect(text).toContain("🔗 [Open](<https://discord.com/channels/1/2/5>)");
    expect(text).toContain(`🔗 [Open](<${DASH}?item=nolink>)`);
    expect(text).not.toContain("Owner bug report queued");
    expect(text).not.toContain("FYI no action");
    expect(text).not.toContain("📨");
  });
  test("finance cards show only a link, no title or account data", () => {
    expect(text).toContain(`💹 Finance card: tr · 0m\n👉 1. Open the finance card and do the step it names.\n🔗 [Open](<${DASH}?item=tr>)`);
    expect(text).not.toContain("XYZ");
    expect(text).not.toContain("1234");
  });
  test("empty state", () => {
    const e = renderNeedsYou([{ id: "d", s: "done" }], NOW, DASH);
    expect(e).toContain("✅ Nothing needs you right now.");
    expect(e).toContain(`${DASH}?tab=needs`);
  });
  test("stays under the Discord limit", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, t: "A fairly long card title that keeps going on", s: "waiting", action: "Do the step", q: MSG }));
    const t = renderNeedsYou(many, NOW, DASH);
    expect(t.length).toBeLessThanOrEqual(2000);
    expect(t).toMatch(/➕ \d+ more on the dashboard/);
  });
});

test("groups and new-card detection", () => {
  expect(needsYouGroup(items[3]!)).toBeNull();
  const prev = snapshot(items);
  expect(newlyNeeding(items, prev)).toEqual([]);
  const next = items.map((i) => (i.id === "d" ? { ...i, s: "open", action: "Do the step" } : i));
  expect(newlyNeeding(next, prev).map((i) => i.id)).toEqual(["d"]);
  // blocked never alerts on its own
  expect(newlyNeeding([{ id: "z", s: "blocked", action: "Do the step", q: MSG }], {})).toEqual([]);
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

describe("NeedsYouBoard keep-last", () => {
  test("posts once, edits in place, moves below new messages, cleans old boards, alerts new cards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ny-"));
    const file = join(dir, "items.json");
    const write = (its: FmItem[]) => writeFileSync(file, JSON.stringify({ items: its }));
    write(items);
    const f = fakeChannel("bot");
    // A stale board from before a restart, plus an older duplicate.
    f.post("✍️ **Needs you** old", "bot");
    f.post("✍️ **Needs you** older", "bot");
    const b = new NeedsYouBoard({ getChannel: async () => f.ch, botId: () => "bot", itemsFile: file, stateFile: join(dir, "s.json"), dash: DASH, log: () => {}, now: () => NOW });
    await b.refresh();
    expect(f.list.filter((m) => isNeedsYouBoard(m.content)).length).toBe(1);
    expect(f.list[0]!.content).toContain("Pick a domain");

    // Owner writes below: board moves back to the bottom, still one board.
    f.post("hi", "owner");
    await b.refresh(true);
    expect(isNeedsYouBoard(f.list[0]!.content)).toBe(true);
    expect(f.list.filter((m) => isNeedsYouBoard(m.content)).length).toBe(1);

    // Card change while last: edited in place (same id).
    const id = f.list[0]!.id;
    write(items.map((i) => (i.id === "d" ? { ...i, s: "waiting", action: "Do the step", t: "New ask" } : i)));
    await b.refresh();
    expect(f.list.some((m) => m.content.startsWith("🔔 Needs you:") && m.content.includes("New ask"))).toBe(true);
    expect(isNeedsYouBoard(f.list[0]!.content)).toBe(true);
    expect(f.list[0]!.id).not.toBe(id); // alert went above, so the board was re-posted below it
    expect(f.list.filter((m) => isNeedsYouBoard(m.content)).length).toBe(1);

    const id2 = f.list[0]!.id;
    write([]);
    await b.refresh();
    expect(f.list[0]!.id).toBe(id2);
    expect(f.list[0]!.content).toContain("✅ Nothing needs you right now.");
  });
});

test("labels never break masked links (owner 2026-10-22)", () => {
  const long = "Client OS: build email unsubscribe + suppression (checklist item 18) for the [new] flow";
  for (const raw of [long, "Fix `x` and *y* <z>", "See https://x.com/a and example.com/b", "a|b~c_d\\e"]) {
    const l = linkLabel(raw);
    expect(l).not.toMatch(/[[\]()<>`*_~|\\]/);
    expect(l).not.toMatch(/https?:|\.com/);
  }
  expect(linkLabel(long).length).toBeLessThanOrEqual(70);
  expect(linkLabel("See example.com/b now")).toBe("See example now");
  const row = needsYouRow({ id: "a", s: "blocked", action: "Do the step", t: long, src: "https://discord.com/channels/1/2" } as FmItem, "⛔", 0, "https://d/");
  expect(row).toContain("(<https://d/?item=a>)");
});

describe("open menus (owner 2026-10-22)", () => {
  const { openMenus, renderNeedsYou: render } = require("../src/needsyou.ts");
  const sets = [
    { setId: "a", channelId: "1", questions: [{ id: "x", question: "What next for the [TV]?" }, { id: "y", question: "Done" }], answers: { y: ["ok"] }, createdAt: 1000, messageIds: { "0": "11", "1": "12" } },
    { setId: "b", channelId: "2", questions: [{ id: "z", question: "Buy 10 AAPL?" }], createdAt: 2000, messageIds: { "0": "21" } },
    { setId: "c", channelId: "3", questions: [{ id: "z", question: "archived" }], createdAt: 3000, messageIds: { "0": "31" } },
    { setId: "d", channelId: "4", questions: [{ id: "z", question: "deleted" }], createdAt: 4000, messageIds: { "0": "41" } },
    { setId: "e", channelId: "1", questions: [{ id: "z", question: "linked" }], createdAt: 5000, messageIds: { "0": "51" } },
  ];
  const chans = new Map<string, unknown>([
    ["1", { name: "📺-tv", archived: false, finance: false }],
    ["2", { name: "💹-newsletter-triage", archived: false, finance: true }],
    ["3", { name: "old", archived: true, finance: false }],
    ["4", null],
  ]);
  const items = [{ id: "c1", s: "done", q: "https://discord.com/channels/9/1/51" }];
  test("filters, newest first, finance hides text", () => {
    const rows = openMenus(sets, items, chans, "9");
    expect(rows.map((r: { label: string }) => r.label)).toEqual(["Finance question: newsletter-triage", "What next for the TV?"]);
    expect(rows[1].link).toBe("https://discord.com/channels/9/1/11");
    const text = render([], 10_000, "", 1900, rows);
    expect(text).toContain("❓ **Open menus** (2)");
    expect(text).not.toContain("AAPL");
  });
  test("finance card rows carry the id", () => {
    const text = render([{ id: "mwb-push-redeploy", s: "waiting", action: "Do the step", area: "finance", t: "secret" }], 10_000, "");
    expect(text).toContain("💹 Finance card: mwb-push-redeploy");
  });
});

test("no empty group header when the board is full", () => {
  const menus = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `Menu question number ${i}`, link: `https://discord.com/channels/1/2/${1000 + i}`, createdAt: 0 }));
  const text = renderNeedsYou([{ id: "x", s: "blocked", action: "Do the step", q: "https://discord.com/channels/1/2/3", t: "Blocked thing" }], 1, "https://d/", 1900, menus);
  expect(text).not.toContain("Blocked on you");
  expect(text).toContain("more on the dashboard");
  expect(text.length).toBeLessThanOrEqual(2000);
});

test("dismissed menus stay off the board (owner 2026-10-22)", () => {
  const sets = [{ setId: "s", channelId: "c", questions: [{ id: "a", question: "Q?" }], createdAt: 1, messageIds: { "0": "m1" } }];
  const chans = new Map([["c", { name: "x", archived: false, finance: false }]]);
  expect(openMenus(sets, [], chans, "g").length).toBe(1);
  expect(openMenus(sets, [], chans, "g", new Set(["m1"])).length).toBe(0);
});

test("link labels are plain text: no emoji or middle dot inside [..] (owner 2026-10-23)", () => {
  expect(linkLabel("🐘 Client Co · PlanetScale ✅")).toBe("Client Co - PlanetScale");
  const row = needsYouRow({ id: "mwb-push-redeploy", s: "blocked", action: "Do the step", area: "Finance", t: "x" } as FmItem, "⛔", 0, "https://d/");
  expect(row).toContain("🏃 💹 Finance card: mwb-push-redeploy");
  expect(/\[[^\]]*\p{Extended_Pictographic}[^\]]*\]\(/u.test(row)).toBe(false);
});

describe("needs-you alerts are removed once seen (owner 2026-10-23)", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "nya-"));
    const file = join(dir, "items.json");
    const write = (its: FmItem[]) => writeFileSync(file, JSON.stringify({ items: its }));
    write([]);
    const f = fakeChannel("bot");
    let now = NOW;
    const b = new NeedsYouBoard({ getChannel: async () => f.ch, botId: () => "bot", ownerId: "owner", itemsFile: file, stateFile: join(dir, "s.json"), dash: DASH, log: () => {}, now: () => now });
    const alerts = () => f.list.filter((m) => m.content.startsWith("🔔 "));
    return { f, b, write, alerts, tick: (ms: number) => void (now += ms) };
  };
  const ask: FmItem = { id: "n", t: "New ask", s: "waiting", action: "Do the step", q: MSG };
  test("old untracked alerts are deleted; a new alert stays until 30 min pass", async () => {
    const t = setup();
    t.f.post("🔔 Needs you: legacy", "bot");
    await t.b.refresh();
    expect(t.alerts().length).toBe(0);
    t.write([ask]);
    await t.b.refresh();
    expect(t.alerts().length).toBe(1);
    t.tick(10 * 60_000); await t.b.refresh();
    expect(t.alerts().length).toBe(1);
    t.tick(21 * 60_000); await t.b.refresh();
    expect(t.alerts().length).toBe(0);
  });
  test("owner message or reaction after the alert marks it seen", async () => {
    const t = setup();
    await t.b.refresh(); t.write([ask]); await t.b.refresh();
    t.tick(1000); t.b.onMessage({ content: "ok", author: { id: "someone-else" } }); await t.b.refresh();
    expect(t.alerts().length).toBe(1);
    t.b.onMessage({ content: "ok", author: { id: "owner" } }); await t.b.refresh();
    expect(t.alerts().length).toBe(0);
    t.write([ask, { ...ask, id: "n2" }]); t.tick(1000); await t.b.refresh();
    expect(t.alerts().length).toBe(1);
    t.tick(1000); t.b.onReaction("owner"); await t.b.refresh();
    expect(t.alerts().length).toBe(0);
  });
  test("answering the card (it leaves the group) removes its alert", async () => {
    const t = setup();
    await t.b.refresh(); t.write([ask]); await t.b.refresh();
    t.write([{ ...ask, s: "partial", queued: 1 }]); await t.b.refresh();
    expect(t.alerts().length).toBe(0);
    expect(t.f.list.filter((m) => isNeedsYouBoard(m.content)).length).toBe(1);
  });
});

import { isFinanceCard } from "../src/needsyou.ts";
import { cardRows as cardRowsT } from "../src/masterqueue.ts";
test("finance cards: area finance, 'Finance: …' or stack finance hide the title", () => {
  expect(isFinanceCard({ area: "finance" })).toBe(true);
  expect(isFinanceCard({ area: "Finance: options" })).toBe(true);
  expect(isFinanceCard({ area: "tools", stack: "finance" })).toBe(true);
  expect(isFinanceCard({ area: "finance-cards apps" })).toBe(false);
  expect(isFinanceCard({})).toBe(false);
  const rows = cardRowsT([{ id: "x", t: "SECRET 100 shares", area: "Finance: options", s: "running", job: "wB:p1" }], new Map(), 1_800_000_000_000, "https://d/");
  expect(rows[0]!.title).toBe("Finance card x");
});

describe("needs-you action gate (owner 2026-10-25, card needs-you-action-gate)", () => {
  const { actionSteps, actionBlock, hasOwnerAction, STEP_MAX } = require("../src/needsyou.ts");
  test("admission: action required, queued excluded", () => {
    expect(needsYouGroup({ id: "a", s: "waiting", q: MSG } as FmItem)).toBe(null);
    expect(needsYouGroup({ id: "a", s: "waiting", q: MSG, action: "  " } as FmItem)).toBe(null);
    expect(needsYouGroup({ id: "a", s: "open", q: MSG, action: "Pick", queued: 1 } as FmItem)).toBe(null);
    expect(needsYouGroup({ id: "a", s: "partial", action: "Pick" } as FmItem)).toBe(null);
    expect(needsYouGroup({ id: "a", s: "waiting", q: MSG, action: "Tap Approve" } as FmItem)).toBe("waiting");
    expect(hasOwnerAction({ action: "x", queued: "1792847920186" })).toBe(false);
  });
  test("the owner's own queued bug report (pw64 case) is not listed", () => {
    const t = renderNeedsYou([{ id: "pw64-hd-fueltank-bleed", t: "Fuel tank bleed", s: "partial", queued: "1", src: MSG, action: "x" } as FmItem], NOW, DASH);
    expect(t).toContain("Nothing needs you");
  });
  test("steps: semicolons, numbered lists, sentences with numbers, code", () => {
    expect(actionSteps("Tap Approve; Enter code")).toEqual(["Tap Approve", "Enter code"]);
    expect(actionSteps("1. Open menu 2. Pick B 3. Wait")).toEqual(["Open menu", "Pick B", "Wait"]);
    expect(actionSteps("Approve the PR by Oct 3. Then merge it")).toEqual(["Approve the PR by Oct 3. Then merge it"]);
    expect(actionSteps("Run `a; b` in shell")).toEqual(["Run `a; b` in shell"]);
    expect(actionSteps("a\n- b")).toEqual(["a", "b"]);
    expect(actionSteps("x".repeat(2000))[0]!.length).toBe(STEP_MAX);
  });
  test("block shape: bars, YOUR ACTION, numbered steps, link; long action keeps the link", () => {
    const b = actionBlock("T", ["a", "b"], MSG);
    expect(b).toBe(`🏃 T\n👉 1. a 2. b\n🔗 [Open](<${MSG}>)`);
    const row = needsYouRow({ id: "l", t: "L", s: "waiting", q: MSG, action: "y".repeat(5000) } as FmItem, "✍️", NOW, DASH);
    expect(row.length).toBeLessThan(500);
    expect(row).toContain("🔗 [Open]");
  });
});

import { actionBlock as _ab } from "../src/needsyou";
import { it as _it, expect as _ex } from "bun:test";
_it("menu rows have no 👉 step line (owner 2026-10-25, msg 100000000000000043)", () => {
  const b = _ab("Q", [], "https://discord.com/channels/1/2/3");
  _ex(b).not.toContain("👉");
  _ex(b).toBe("🏃 Q\n🔗 [Open](<https://discord.com/channels/1/2/3>)");
});
