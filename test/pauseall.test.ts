import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFinanceInstruction, isFinanceCard, pause, pauseSummary, readState, resume, type Card, type Pane } from "../src/pauseall.ts";

function world(panes: Pane[], cards: Card[]) {
  const calls: string[][] = [];
  const fmCalls: string[][] = [];
  const tabs = [{ tab_id: "t:fm", label: "FIRSTMATE" }, { tab_id: "t:a", label: "Job A" }, { tab_id: "t:b", label: "Job B" }, { tab_id: "t:v", label: "Webapp UI" }];
  const herdr = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") return { code: 0, out: JSON.stringify({ result: { panes } }) };
    if (args[0] === "tab" && args[1] === "list") return { code: 0, out: JSON.stringify({ result: { tabs } }) };
    if (args[1] === "send-keys") {
      const p = panes.find((x) => x.pane_id === args[2]);
      if (p && p.label !== "stubborn") p.agent_status = "idle";
      return { code: 0, out: "" };
    }
    if (args[0] === "agent" && args[1] === "prompt") return { code: 0, out: "" };
    return { code: 1, out: "" };
  };
  const fm = async (args: string[]) => {
    fmCalls.push(args);
    const c = cards.find((x) => x.id === args[1]);
    if (c && args[0] === "set" && args[2] === "running" && !c.job) return { code: 1, out: "" };
    if (c && args[0] === "set") {
      c.s = args[2] === "paused" ? "partial" : args[2];
      if (args[2] === "paused") delete c.job;
    }
    if (c && args[0] === "field") c.job = args[3];
    return { code: 0, out: "" };
  };
  return { herdr, fm, calls, fmCalls, tracker: () => cards, stateFile: join(mkdtempSync(join(tmpdir(), "pa-")), "s.json"), sleep: async () => {} };
}

const pane = (id: string, tab: string, status = "working", label = ""): Pane => ({ pane_id: id, tab_id: tab, agent: "omp", agent_status: status, label });

describe("pause all", () => {
  test("Esc to every working OMP pane except FIRSTMATE, every running card paused, then 0 running", async () => {
    const panes = [pane("p:fm", "t:fm"), pane("p:a", "t:a"), pane("p:b", "t:b"), pane("p:idle", "t:b", "idle"), { pane_id: "p:sh", tab_id: "t:a", agent: "", agent_status: "working" }];
    const cards: Card[] = [{ id: "a", s: "running", job: "Job A" }, { id: "b", s: "running", job: "p:b" }, { id: "c", s: "done" }];
    const w = world(panes, cards);
    const r = await pause({ ...w, reason: "test", kind: "all" });
    const esc = w.calls.filter((c) => c[1] === "send-keys").map((c) => c[2]);
    expect(esc.sort()).toEqual(["p:a", "p:b"]);
    expect(r.stopped.sort()).toEqual(["p:a", "p:b"]);
    expect(r.stillWorking).toEqual([]);
    expect(cards.filter((c) => c.s === "running")).toEqual([]);
    expect(pauseSummary(r)).toBe("✅ Pause all: 2/2 working pane(s) stopped, 2 card(s) set paused.");
    const back = await resume({ ...w });
    expect(back.cards.sort()).toEqual(["a", "b"]);
    expect(cards.find((c) => c.id === "a")).toMatchObject({ s: "running", job: "Job A" });
    expect(readState(w.stateFile)).toBeNull();
  });

  test("a running card without a job is left alone (it could not be restored)", async () => {
    const cards: Card[] = [{ id: "x", s: "running" }];
    const w = world([pane("p:fm", "t:fm", "idle")], cards);
    const r = await pause({ ...w, reason: "t", kind: "all" });
    expect(r.cards).toEqual([]);
    expect(cards[0]!.s).toBe("running");
  });

  test("a resume running at the same time as a pause never drops the newly paused cards", async () => {
    const panes = [pane("p:fm", "t:fm"), pane("p:a", "t:a"), pane("p:b", "t:b")];
    const cards: Card[] = [{ id: "a", s: "running", job: "p:a" }, { id: "b", s: "running", job: "p:b" }];
    const w = world(panes, cards);
    await pause({ ...w, reason: "t", kind: "yield", cards: (c) => c.id === "a" });
    await Promise.all([resume({ ...w }), pause({ ...w, reason: "t", kind: "yield", cards: (c) => c.id === "b" })]);
    expect(readState(w.stateFile)?.cards.map((c) => c.id)).toEqual(["b"]);
    expect(cards[0]!.s).toBe("running");
  });

  test("resends Esc once to a pane that keeps working and reports it", async () => {
    const panes = [pane("p:fm", "t:fm", "idle"), pane("p:a", "t:a", "working", "stubborn")];
    const w = world(panes, []);
    const r = await pause({ ...w, reason: "t", kind: "all", verifyMs: 30, pollMs: 10 });
    expect(w.calls.filter((c) => c[1] === "send-keys").length).toBe(2);
    expect(r.stillWorking).toEqual(["p:a"]);
    expect(pauseSummary(r)).toContain("⚠️");
  });

  test("refuses without a FIRSTMATE tab and touches nothing", async () => {
    const w = world([pane("p:a", "t:a")], [{ id: "a", s: "running", job: "p:a" }]);
    const herdr = async (a: string[]) => (a[0] === "tab" ? { code: 0, out: JSON.stringify({ result: { tabs: [] } }) } : w.herdr(a));
    await expect(pause({ ...w, herdr, reason: "t", kind: "all" })).rejects.toThrow(/FIRSTMATE/);
    expect(w.fmCalls).toEqual([]);
  });

  test("excluded panes and their cards are left alone", async () => {
    const panes = [pane("p:fm", "t:fm"), pane("p:a", "t:a"), pane("p:b", "t:b")];
    const cards: Card[] = [{ id: "a", s: "running", job: "p:a" }, { id: "b", s: "running", job: "p:b" }];
    const w = world(panes, cards);
    const r = await pause({ ...w, reason: "t", kind: "all", exclude: ["p:b"] });
    expect(r.panes).toEqual(["p:a"]);
    expect(r.cards).toEqual(["a"]);
    expect(cards[1]!.s).toBe("running");
  });
});

describe("bank priority yield", () => {
  test("detects owner bank position/portfolio instructions only", () => {
    expect(isFinanceInstruction("close my ACME invoices in bank")).toBe(true);
    expect(isFinanceInstruction("check my positions please")).toBe(true);
    expect(isFinanceInstruction("roll the portfolio hedge")).toBe(true);
    expect(isFinanceInstruction("fix the portfolio page CSS on the site")).toBe(false);
    expect(isFinanceInstruction("show the Webapp UI board")).toBe(false);
    expect(isFinanceInstruction("the bank yield bug again")).toBe(false);
    expect(isFinanceInstruction("check the account settings page")).toBe(false);
    expect(isFinanceCard({ area: "marketing" })).toBe(false);
    expect(isFinanceCard({ area: "finance" })).toBe(true);
  });

  test("non-finance jobs yield, finance jobs keep running; dry run changes nothing", async () => {
    const panes = [pane("p:fm", "t:fm"), pane("p:v", "t:v"), pane("p:a", "t:a"), pane("p:vi", "t:v", "idle")];
    const cards: Card[] = [{ id: "webapp-ui", s: "running", area: "webapp", job: "Webapp UI" }, { id: "budget", s: "running", area: "finance", job: "Job A" }];
    const w = world(panes, cards);
    const dry = await pause({ ...w, reason: "y", kind: "yield", cards: (c) => !isFinanceCard(c), dryRun: true });
    expect(dry).toMatchObject({ panes: ["p:v"], cards: ["webapp-ui"] });
    expect(w.calls.some((c) => c[1] === "send-keys")).toBe(false);
    expect(cards[0]!.s).toBe("running");
    const r = await pause({ ...w, reason: "y", kind: "yield", cards: (c) => !isFinanceCard(c) });
    expect(r.cards).toEqual(["webapp-ui"]);
    expect(cards[1]!.s).toBe("running");
    const back = await resume({ ...w, prompt: true });
    expect(back).toMatchObject({ cards: ["webapp-ui"], prompted: ["p:v"] });
  });
});

describe("test allowlist (card pause-all-live-button-check)", () => {
  const { readTestAllowlist, allowlistFilter, testModeDecision } = require("../src/pauseall.ts") as typeof import("../src/pauseall.ts");
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const f = join(mkdtempSync(join(tmpdir(), "allow-")), "a.json");
  const now = Date.parse("2026-11-03T12:00:00Z");
  test("missing, broken, empty or expired file means normal mode", () => {
    expect(readTestAllowlist(f, now)).toBeNull();
    writeFileSync(f, "{bad");
    expect(readTestAllowlist(f, now)).toBeNull();
    writeFileSync(f, JSON.stringify({ cards: [], until: "2026-11-03T13:00:00Z" }));
    expect(readTestAllowlist(f, now)).toBeNull();
    writeFileSync(f, JSON.stringify({ cards: ["t1"], until: "2026-11-03T11:00:00Z" }));
    expect(readTestAllowlist(f, now)).toBeNull();
    writeFileSync(f, JSON.stringify({ cards: ["t1"] }));
    expect(readTestAllowlist(f, now)).toBeNull();
    writeFileSync(f, JSON.stringify({ cards: ["t1"], until: "2026-11-03T13:00:00Z" })); // no panes
    expect(readTestAllowlist(f, now)).toBeNull();
  });
  test("valid file scopes pause to listed cards and their panes only", async () => {
    writeFileSync(f, JSON.stringify({ cards: ["t1", 5, ""], panes: ["p-test"], until: "2026-11-03T13:00:00Z" }));
    const a = readTestAllowlist(f, now)!;
    expect(a.cards).toEqual(["t1"]);
    const sent: string[][] = [];
    const herdr = async (args: string[]) => {
      if (args[1] === "list" && args[0] === "pane") return { code: 0, out: JSON.stringify({ result: { panes: [
        { pane_id: "p-test", tab_id: "tab-test", agent: "omp", agent_status: "working" },
        { pane_id: "p-real", tab_id: "tab-real", agent: "omp", agent_status: "working" },
        { pane_id: "p-fm", tab_id: "tab-fm", agent: "omp", agent_status: "working" },
      ] } }) };
      if (args[1] === "list") return { code: 0, out: JSON.stringify({ result: { tabs: [{ tab_id: "tab-test", label: "test" }, { tab_id: "tab-real", label: "real" }, { tab_id: "tab-fm", label: "FIRSTMATE" }] } }) };
      sent.push(args);
      return { code: 0, out: "" };
    };
    const fmCalls: string[][] = [];
    const fm = async (args: string[]) => (fmCalls.push(args), { code: 0, out: "" });
    const cards: Card[] = [{ id: "t1", s: "running", job: "tab-test,real" }, { id: "real", s: "running", job: "tab-real" }];
    const r = await pause({ reason: "x", kind: "all", herdr, fm, tracker: () => cards, stateFile: join(mkdtempSync(join(tmpdir(), "st-")), "s.json"), cards: allowlistFilter(a), onlyPanes: a.panes, verifyMs: 0 });
    expect(r.cards).toEqual(["t1"]);
    expect(r.panes).toEqual(["p-test"]);
    expect(sent.map((s) => s[2])).toEqual(["p-test"]);
    expect(fmCalls.map((c) => c[1])).toEqual(["t1"]);
  });
  test("decision: broken/expired file refuses, saved test state resumes in test mode, real pause wins", () => {
    const allow = { cards: ["t1"], panes: ["p"], until: "x" };
    const base = { maintPaused: false, allowFileExists: false, allow: null, testStatePresent: false } as const;
    expect(testModeDecision({ ...base, action: "pause" })).toBe("normal");
    expect(testModeDecision({ ...base, action: "pause", allowFileExists: true })).toBe("refuse");
    expect(testModeDecision({ ...base, action: "resume", allowFileExists: true })).toBe("refuse");
    expect(testModeDecision({ ...base, action: "pause", allowFileExists: true, allow })).toBe("test");
    expect(testModeDecision({ ...base, action: "resume", testStatePresent: true })).toBe("test");
    expect(testModeDecision({ ...base, action: "pause", testStatePresent: true })).toBe("refuse");
    expect(testModeDecision({ ...base, action: "resume", maintPaused: true, testStatePresent: true, allowFileExists: true, allow })).toBe("normal");
  });
  test("resume after the allowlist expired restores the test cards from saved state", async () => {
    const st = join(mkdtempSync(join(tmpdir(), "st-")), "s.json");
    writeFileSync(st, JSON.stringify({ since: "x", reason: "t", kind: "all", cards: [{ id: "t1", job: "p-test" }], panes: ["p-test"] }));
    const fmCalls: string[][] = [];
    const herdr = async () => ({ code: 0, out: JSON.stringify({ result: { panes: [], tabs: [] } }) });
    const r = await resume({ herdr, fm: async (a: string[]) => (fmCalls.push(a), { code: 0, out: "" }), stateFile: st });
    expect(r.cards).toEqual(["t1"]);
    expect(readState(st)).toBeNull();
  });
});
