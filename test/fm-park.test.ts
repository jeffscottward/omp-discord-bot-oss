import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRefs, parkedRefs, isGate, type BItem } from "../src/blockers.ts";
import { cardRows } from "../src/masterqueue.ts";

// Card mainblocker-backlog (owner 2026-11-05): `fm set <id> backlog` parks the card, so fm removes it from every other
// card's blockedBy and notes that in the parent. A gate card (title "Gate: …", field gate, id "gate-…") keeps its links.
const FM = join(import.meta.dir, "..", "kit", "bin", "fm");
let dir = "";
let env: Record<string, string> = {};

function items(list: object[]) {
  writeFileSync(join(dir, "items.json"), JSON.stringify({ updated: "", items: list }));
}
function card(id: string) {
  return JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items.find((i: { id: string }) => i.id === id);
}
function fm(...args: string[]) {
  const r = Bun.spawnSync(["python3", "-B", FM, ...args], { env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fm-park-"));
  mkdirSync(join(dir, "home"));
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(dir, "home"),
    OMP_KIT_ENV: "/nonexistent",
    FM_DIR: dir,
    REPORTS_WEB_DIR: dir,
    FM_ITEMS: join(dir, "items.json"),
    FM_SPAWN_STATE: join(dir, "spawn"),
    FM_SPAWN_PATH: "/nonexistent",
    OMP_BOT_ENV: join(dir, "no-bot.env"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("fm set <id> backlog removes the id (or its title) from other cards' blockedBy and notes it there", () => {
  items([
    { id: "kid", t: "Second part", s: "partial", area: "security", stack: "infra" },
    { id: "par", t: "Parent", s: "partial", area: "security", stack: "security", n: "waits", blockedBy: ["kid", "other"] },
    { id: "par2", t: "Parent 2", s: "planned", area: "security", stack: "security", blockedBy: "Second part" },
    { id: "other", t: "Other", s: "running", area: "security", stack: "security", job: "x.timer" },
    { id: "old", t: "Old", s: "done", area: "security", stack: "security", blockedBy: ["kid"] },
  ]);
  const r = fm("set", "kid", "backlog", "macOS manual job");
  expect(r.code).toBe(0);
  expect(r.out).toContain("kid: parked; blocker link removed on par, par2");
  expect(card("kid")).toMatchObject({ s: "backlog", n: "macOS manual job" });
  expect(card("par").blockedBy).toEqual(["other"]);
  expect(card("par").n).toBe("waits [parked blocker removed: kid]");
  expect(card("par2").blockedBy).toBeUndefined();
  expect(card("par2").n).toBe("[parked blocker removed: kid]");
  expect(card("old").blockedBy).toEqual(["kid"]); // done cards are history: not changed
  // Idempotent: a second set changes no parent again.
  expect(fm("set", "kid", "backlog").out).not.toContain("blocker link removed");
  // fm why names the parked card, never as a blocker.
  items([
    { id: "kid", t: "Second part", s: "backlog", area: "security", stack: "infra" },
    { id: "par", t: "Parent", s: "partial", area: "security", stack: "security", blockedBy: ["kid"] },
  ]);
  const why = fm("why", "par");
  expect(why.out).toContain("parked: kid (backlog; no blocker)");
  expect(why.out).toContain("par: no open blockers");
});

test("refs resolve like blockers.ts edges(): an exact id wins over a title; the parked card's own blocks go too", () => {
  items([
    { id: "deploy", t: "Other card", s: "partial", area: "x", stack: "firstmate" },
    { id: "b", t: "Deploy", s: "partial", area: "x", stack: "firstmate", blocks: ["w2", "fin"] },
    { id: "w1", t: "W1", s: "partial", area: "x", stack: "firstmate", blockedBy: "deploy" }, // means card `deploy`, not b
    { id: "w2", t: "W2", s: "partial", area: "x", stack: "firstmate" },
    { id: "fin", t: "Fin", s: "done", area: "x", stack: "firstmate" },
  ]);
  const r = fm("set", "b", "backlog");
  expect(r.out).toContain("blocker link removed on w2");
  expect(card("w1").blockedBy).toBe("deploy");
  expect(card("w1").n).toBeUndefined();
  expect(card("b").blocks).toEqual(["fin"]); // done cards stay; open ones go
  expect(card("w2").n).toBe("[parked blocker removed: b]");
});

test("the R11 marker '[blocked by …]' loses the parked id (and goes when empty)", () => {
  items([
    { id: "kid", t: "Kid", s: "partial", area: "x", stack: "firstmate" },
    { id: "o", t: "O", s: "running", area: "x", stack: "firstmate", job: "x.timer" },
    { id: "p1", t: "P1", s: "partial", area: "x", stack: "firstmate", n: "🧾 Receipt blocked: waits. [blocked by kid]", blockedBy: ["kid"] },
    { id: "p2", t: "P2", s: "partial", area: "x", stack: "firstmate", n: "w [blocked by kid, o]", blockedBy: ["kid", "o"] },
  ]);
  expect(fm("set", "kid", "backlog").code).toBe(0);
  expect(card("p1").n).toBe("🧾 Receipt blocked: waits. [parked blocker removed: kid]");
  expect(card("p2").n).toBe("w [blocked by o] [parked blocker removed: kid]");
});

test("after a real `fm set <id> backlog`, the master queue row of the parent still says 🗃️ parked", () => {
  items([
    { id: "kid", t: "Second part", s: "partial", area: "x", stack: "firstmate" },
    { id: "par", t: "Parent", s: "partial", area: "x", stack: "firstmate", n: "🧾 Receipt blocked: waits for kid", blockedBy: ["kid"] },
  ]);
  expect(fm("set", "kid", "backlog").code).toBe(0);
  const cards = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items;
  const now = Date.now();
  const rows = cardRows(cards, new Map([["par", { card: "par", result: "blocked", tsMs: now - 60_000, summary: "waits for kid" }]]), now, "https://d/");
  expect(rows.find((x) => x.key === "card:par")?.where).toBe("🗃️ parked: kid");
  // Taken out of backlog: the mark no longer counts (the link is gone; the receipt reason shows again).
  const back = cards.map((c: { id: string }) => (c.id === "kid" ? { ...c, s: "partial" } : c));
  expect(cardRows(back, new Map([["par", { card: "par", result: "blocked", tsMs: now - 60_000, summary: "waits for kid" }]]), now, "https://d/").find((x) => x.key === "card:par")?.where).toBe("⛔ waits for kid");
});

test("a gate card in backlog keeps its links (title Gate:, field gate)", () => {
  items([
    { id: "webapp-ui-pause", t: "Gate: Webapp UI work paused", s: "partial", area: "webapp-ui", stack: "webapp-ui" },
    { id: "g2", t: "Plain", s: "partial", area: "x", stack: "firstmate" },
    { id: "ui1", t: "UI 1", s: "partial", area: "webapp-ui", stack: "webapp-ui", blockedBy: ["webapp-ui-pause", "g2"] },
  ]);
  expect(fm("set", "webapp-ui-pause", "backlog").out).not.toContain("removed");
  expect(fm("field", "g2", "gate", "1").code).toBe(0);
  expect(card("g2").gate).toBe(true);
  expect(fm("set", "g2", "backlog").out).not.toContain("removed");
  expect(card("ui1").blockedBy).toEqual(["webapp-ui-pause", "g2"]);
  expect(fm("why", "ui1").out).not.toContain("parked:");
});

test("blockers.ts: parked cards are no open refs; gates stay open (same rule as fm)", () => {
  const list: BItem[] = [
    { id: "p", s: "partial", blockedBy: ["k", "g", "gate-x", "f", "r"] },
    { id: "k", t: "Kid", s: "backlog" },
    { id: "g", t: "Gate: pause", s: "backlog" },
    { id: "gate-x", s: "backlog" },
    { id: "f", t: "Flag", s: "backlog", gate: "yes" },
    { id: "r", s: "running" },
  ];
  const by = new Map(list.map((i) => [i.id, i]));
  expect(openRefs(list[0]!, by)).toEqual(["g", "gate-x", "f", "r"]);
  expect(parkedRefs(list[0]!, by)).toEqual(["k"]);
  expect(isGate({ id: "j", t: "JEV gate on re-entry", s: "backlog" })).toBe(false);
});
