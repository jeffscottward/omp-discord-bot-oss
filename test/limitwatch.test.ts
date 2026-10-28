import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardJson, evaluate, LimitWatch, onReadResult, pinnedText, snapshot, type UsageJson, type WatchState } from "../src/limitwatch";

const H = 3_600_000;
const now = 1_792_000_000_000;
const usage = (f5: number, f7: number, reset5 = now + 2 * H, reset7 = now + 50 * H): UsageJson => ({
  generatedAt: now,
  reports: [
    { provider: "openai-codex", limits: [{ id: "codex:7d", label: "7 days", amount: { usedFraction: 0.99 } }] },
    {
      provider: "anthropic",
      fetchedAt: now,
      metadata: { accountId: "acct-1" },
      resetCredits: { availableCount: 1, credits: [{ status: "available", expiresAt: "2026-10-22T16:00:00.000Z" }] },
      limits: [
        { id: "anthropic:5h", label: "Claude 5 Hour", status: "ok", window: { resetsAt: reset5 }, amount: { usedFraction: f5 } },
        { id: "anthropic:7d", label: "Claude 7 Day", status: "ok", window: { resetsAt: reset7 }, amount: { usedFraction: f7 } },
      ],
    },
  ],
});
const empty: WatchState = { windows: {} };

describe("snapshot", () => {
  test("keeps only Anthropic windows and banked resets", () => {
    const s = snapshot(usage(0.1, 0.5));
    expect(s.windows.map((w) => w.label)).toEqual(["5 Hour", "7 Day"]);
    expect(s.banked).toBe(1);
    expect(s.bankedExpires).toBe(Date.parse("2026-10-22T16:00:00.000Z"));
  });
});

describe("evaluate", () => {
  test("no alert below 80%", () => {
    expect(evaluate(empty, snapshot(usage(0.79, 0.5)), "yes").alerts).toEqual([]);
  });
  test("one alert at 80%, not repeated in the same window", () => {
    const a = evaluate(empty, snapshot(usage(0.81, 0.5)), "yes");
    expect(a.alerts).toHaveLength(1);
    expect(a.alerts[0]).toContain("Claude 5 Hour at 81%");
    expect(a.alerts[0]).toContain("(80% alert)");
    expect(a.alerts[0]).toContain("1 banked reset");
    expect(a.alerts[0]).toContain("claudeResets.autoRedeem: yes");
    const b = evaluate(a.state, snapshot(usage(0.85, 0.5)), "yes");
    expect(b.alerts).toEqual([]);
  });
  test("95% after 80% gives a second alert; a jump past both gives only the 95% one", () => {
    const a = evaluate(empty, snapshot(usage(0.82, 0.5)), "yes");
    const b = evaluate(a.state, snapshot(usage(0.96, 0.5)), "yes");
    expect(b.alerts).toHaveLength(1);
    expect(b.alerts[0]).toContain("(95% alert)");
    const jump = evaluate(empty, snapshot(usage(0.1, 0.97)), "yes");
    expect(jump.alerts).toHaveLength(1);
    expect(jump.alerts[0]).toContain("Claude 7 Day at 97% (95% alert)".replace(" (", "** ("));
  });
  test("reset notice when an alerted window resets; quiet reset when it never alerted", () => {
    const a = evaluate(empty, snapshot(usage(0.9, 0.3)), "yes");
    const b = evaluate(a.state, snapshot(usage(0.02, 0.3, now + 7 * H)), "yes");
    expect(b.alerts).toHaveLength(1);
    expect(b.alerts[0]).toContain("Claude 5 Hour reset");
    expect(b.state.windows["acct-1|anthropic:5h"]!.alerted).toBe(0);
    // The 7 day window moved too but never alerted: no notice.
    const c = evaluate(b.state, snapshot(usage(0.03, 0.31, now + 7 * H, now + 200 * H)), "yes");
    expect(c.alerts).toEqual([]);
  });
  test("a banked reset (use drops, same reset time) counts as a new window", () => {
    const a = evaluate(empty, snapshot(usage(0.96, 0.3)), "yes");
    const b = evaluate(a.state, snapshot(usage(0.0, 0.3)), "yes");
    expect(b.alerts[0]).toContain("reset");
    const c = evaluate(b.state, snapshot(usage(0.81, 0.3)), "yes");
    expect(c.alerts[0]).toContain("(80% alert)");
  });
});

describe("partial reads", () => {
  test("a limit without usedFraction is skipped, so it causes no false reset or repeat alert", () => {
    const a = evaluate(empty, snapshot(usage(0.85, 0.3)), "yes");
    const partial = usage(0.85, 0.3);
    delete (partial.reports![1]!.limits![0] as { amount?: unknown }).amount;
    const s = snapshot(partial);
    expect(s.windows.map((w) => w.label)).toEqual(["7 Day"]);
    const b = evaluate(a.state, s, "yes");
    expect(b.alerts).toEqual([]);
    expect(b.state.windows["acct-1|anthropic:5h"]!.alerted).toBe(0.8);
    const c = evaluate(b.state, snapshot(usage(0.86, 0.3)), "yes");
    expect(c.alerts).toEqual([]);
  });
  test("a window missing from one poll keeps its alert state", () => {
    const a = evaluate(empty, snapshot(usage(0.9, 0.3)), "yes");
    const gone = usage(0.9, 0.3);
    gone.reports![1]!.limits = gone.reports![1]!.limits!.slice(1);
    const b = evaluate(a.state, snapshot(gone), "yes");
    expect(b.state.windows["acct-1|anthropic:5h"]!.alerted).toBe(0.8);
    expect(evaluate(b.state, snapshot(usage(0.91, 0.3)), "yes").alerts).toEqual([]);
  });
});

describe("pinned text and dashboard", () => {
  test("pinned message has a countdown per window and the banked line", () => {
    const t = pinnedText(snapshot(usage(0.11, 0.52)), "yes", now);
    expect(t).toContain("**11%** 5 Hour · resets <t:");
    expect(t).toContain(":R>");
    expect(t).toContain("✦ 1 banked reset");
    expect(t).not.toContain("acct-1");
    expect(t.length).toBeLessThan(2000);
  });
  test("dashboard JSON has no account ids", () => {
    const j = dashboardJson(snapshot(usage(0.11, 0.52)), "yes", now);
    expect(JSON.stringify(j)).not.toContain("acct-1");
    expect(j.windows[0]).toEqual({ label: "5 Hour", pct: 11, resetsAt: now + 2 * H, status: "ok" });
  });
});

describe("failure alerts", () => {
  test("alert once after 3 failures, recover once", () => {
    let s: WatchState = empty;
    const alerts: (string | undefined)[] = [];
    for (let n = 0; n < 5; n++) {
      const r = onReadResult(s, false, "boom");
      s = r.state;
      alerts.push(r.alert);
    }
    expect(alerts.filter(Boolean)).toHaveLength(1);
    expect(alerts[2]).toContain("3 failed reads");
    const ok = onReadResult(s, true);
    expect(ok.alert).toContain("recovered");
    expect(onReadResult(ok.state, true).alert).toBeUndefined();
  });
});

describe("LimitWatch.tick", () => {
  test("posts each alert once across ticks and keeps the pinned message id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limitwatch-"));
    const posted: string[] = [];
    const pins: { text: string; where: { channel?: string; message?: string } }[] = [];
    let current = usage(0.85, 0.4);
    const w = new LimitWatch({
      ompBin: "/bin/false",
      stateFile: join(dir, "state.json"),
      dashboardFile: join(dir, "web", "limits.json"),
      alert: async (t) => void posted.push(t),
      pin: async (text, where) => (pins.push({ text, where }), { channel: "c1", message: where.message ?? "m1" }),
      log: () => {},
    });
    w.read = async () => ({ usage: current, autoRedeem: "yes" });
    await w.tick();
    await w.tick();
    expect(posted).toHaveLength(1);
    expect(pins[1]!.where).toEqual({ channel: "c1", message: "m1" });
    current = usage(0.97, 0.4);
    await w.tick();
    expect(posted).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, "web", "limits.json"), "utf8")).windows[0].pct).toBe(97);
  });
});
