import { describe, expect, test } from "bun:test";
import { blocked, command, detail, formatList, isFinance, parseCollect, pickRows, state, type Timer } from "../src/automations";

const now = 1_792_000_000_000;
const us = (ms: number) => ms * 1000;
const list = JSON.stringify([
  { unit: "example-bot.timer", activates: "example-bot.service", next: us(now + 60_000), last: us(now - 240_000) },
  { unit: "harness-watch.timer", activates: "harness-watch.service", next: us(now + 120_000), last: us(now - 60_000) },
  { unit: "weekly-update.timer", activates: "weekly-update.service", next: us(now + 86_400_000), last: null },
  { unit: "systemd-tmpfiles-clean.timer", activates: "systemd-tmpfiles-clean.service", next: us(now + 3_600_000), last: us(now - 3_600_000) },
]);
const show = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join("\n");
const timers = [
  show({ Id: "example-bot.timer", Description: "MW", UnitFileState: "enabled", ActiveState: "active", SubState: "waiting", Unit: "example-bot.service", FragmentPath: "/home/u/.config/systemd/user/example-bot.timer" }),
  show({ Id: "harness-watch.timer", UnitFileState: "enabled", ActiveState: "active", SubState: "waiting", Unit: "harness-watch.service", FragmentPath: "/home/u/.config/systemd/user/harness-watch.timer" }),
  show({ Id: "weekly-update.timer", UnitFileState: "enabled", ActiveState: "active", SubState: "waiting", Unit: "weekly-update.service", FragmentPath: "/home/u/.config/systemd/user/weekly-update.timer" }),
  show({ Id: "newsletter-sync-fast.timer", UnitFileState: "disabled", ActiveState: "inactive", SubState: "dead", Unit: "newsletter-sync-fast.service", FragmentPath: "/home/u/.config/systemd/user/newsletter-sync-fast.timer" }),
  show({ Id: "systemd-tmpfiles-clean.timer", UnitFileState: "static", ActiveState: "active", SubState: "waiting", Unit: "systemd-tmpfiles-clean.service", FragmentPath: "/usr/lib/systemd/user/systemd-tmpfiles-clean.timer" }),
].join("\n\n");
const svcs = [
  show({ Id: "example-bot.service", ActiveState: "inactive", Result: "success", ExecMainStatus: "0", ExecMainExitTimestamp: "Mon 2026-10-19 10:55:00 EDT" }),
  show({ Id: "harness-watch.service", ActiveState: "failed", Result: "exit-code", ExecMainStatus: "2" }),
  show({ Id: "weekly-update.service", ActiveState: "inactive", Result: "success", ExecMainStatus: "0", ExecMainExitTimestamp: "" }),
  show({ Id: "newsletter-sync-fast.service", ActiveState: "inactive", Result: "success", ExecMainStatus: "0" }),
  show({ Id: "systemd-tmpfiles-clean.service", ActiveState: "inactive", Result: "success", ExecMainStatus: "0" }),
].join("\n\n");
const out = `${list}\n\n@@@\n${timers}\n\n@@@\n${svcs}\n`;
const main = parseCollect("main", out);
const by = (n: string) => main.find((t) => t.timer === n)!;

describe("parseCollect", () => {
  test("reads every timer with service, times, result and OS flag", () => {
    expect(main.map((t) => t.timer)).toEqual(["example-bot.timer", "harness-watch.timer", "newsletter-sync-fast.timer", "systemd-tmpfiles-clean.timer", "weekly-update.timer"]);
    const mw = by("example-bot.timer");
    expect(mw).toMatchObject({ service: "example-bot.service", next: now + 60_000, last: now - 240_000, exit: 0, os: false });
    expect(by("systemd-tmpfiles-clean.timer").os).toBe(true);
    // A disabled timer that is not in list-timers still shows (so Resume is reachable).
    expect(by("newsletter-sync-fast.timer").next).toBeUndefined();
  });
  test("states", () => {
    expect(state(by("example-bot.timer"))).toBe("ok");
    expect(state(by("harness-watch.timer"))).toBe("failed");
    expect(state(by("newsletter-sync-fast.timer"))).toBe("paused");
    expect(state(by("weekly-update.timer"))).toBe("none");
  });
  test("survives broken list JSON", () => {
    expect(parseCollect("main", `nope\n@@@\n${timers}\n@@@\n${svcs}`)).toHaveLength(5);
  });
});

describe("safety", () => {
  test("finance units and everything on the remote host need a confirm", () => {
    expect(isFinance(by("example-bot.timer"))).toBe(true);
    expect(isFinance(by("newsletter-sync-fast.timer"))).toBe(true);
    expect(isFinance({ host: "main", timer: "ex-x.timer", service: "ex-x.service" })).toBe(true);
    expect(isFinance({ host: "main", timer: "rebalance-a.timer", service: "rebalance-a.service" })).toBe(true);
    expect(isFinance(by("harness-watch.timer"))).toBe(false);
    expect(isFinance({ host: "remote", timer: "webapp-status-collect.timer", service: "webapp-status-collect.service" })).toBe(true);
  });
  test("weekly-update never runs; OS timers are read-only; odd names are refused", () => {
    expect(blocked(by("weekly-update.timer"), "run")).toContain("real system update");
    expect(blocked(by("weekly-update.timer"), "pause")).toBeNull();
    expect(blocked(by("systemd-tmpfiles-clean.timer"), "pause")).toContain("OS");
    const odd: Timer = { ...by("harness-watch.timer"), service: "x; rm -rf ~" };
    expect(blocked(odd, "run")).toContain("unexpected");
    expect(blocked(by("harness-watch.timer"), "run")).toBeNull();
  });
  test("commands", () => {
    expect(command(by("harness-watch.timer"), "run")).toEqual(["start", "--no-block", "harness-watch.service"]);
    expect(command(by("harness-watch.timer"), "pause")).toEqual(["disable", "--now", "harness-watch.timer"]);
    expect(command(by("newsletter-sync-fast.timer"), "resume")).toEqual(["enable", "--now", "newsletter-sync-fast.timer"]);
    const noInstall: Timer = { ...by("harness-watch.timer"), timer: "x-static.timer", unitFile: "static" };
    expect(command(noInstall, "pause")).toEqual(["stop", "x-static.timer"]);
    expect(command(noInstall, "resume")).toEqual(["start", "x-static.timer"]);
  });
  test("transient (systemd-run) timers cannot be paused or resumed; Run now still works", () => {
    const transient: Timer = { ...by("harness-watch.timer"), timer: "omarchy-reminder-1m-1.timer", service: "omarchy-reminder-1m-1.service", unitFile: "transient" };
    expect(blocked(transient, "pause")).toContain("cannot be paused");
    expect(blocked(transient, "resume")).toContain("cannot be paused");
    expect(blocked(transient, "run")).toBeNull();
  });
});

describe("formatting", () => {
  test("list: one line per own timer, OS timers on one line, no tables, fits Discord", () => {
    const msgs = formatList([{ host: "main", timers: main }, { host: "remote", timers: [], error: "ssh: timeout" }], now);
    const all = msgs.join("\n");
    expect(all).toContain("❌ **harness-watch** · next <t:");
    expect(all).toContain("exit-code, exit 2");
    expect(all).toContain("⏸️ **newsletter-sync-fast** · paused");
    expect(all).toContain("🐧 OS timers (1, read-only): systemd-tmpfiles-clean");
    expect(all).toContain("⚠️ Could not read timers: ssh: timeout");
    expect(all).not.toContain("|");
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(1900);
  });
  test("long lists split into several messages", () => {
    const many = Array.from({ length: 60 }, (_, n) => ({ ...by("harness-watch.timer"), timer: `job-${n}-with-a-longer-name.timer` }));
    const msgs = formatList([{ host: "main", timers: many }], now);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(1900);
  });
  test("pick menus skip OS timers and hold 25 options each", () => {
    const many = Array.from({ length: 30 }, (_, n) => ({ ...by("harness-watch.timer"), timer: `job-${n}.timer` }));
    const rows = pickRows([{ host: "main", timers: [...many, by("systemd-tmpfiles-clean.timer")] }]);
    expect(rows).toHaveLength(2);
    const opts = rows.flatMap((r) => r.components[0]!.options);
    expect(opts).toHaveLength(30);
  });
  test("detail mentions the confirm for finance units and the weekly-update block", () => {
    expect(detail(by("example-bot.timer"))).toContain("Finance unit");
    expect(detail(by("weekly-update.timer"))).toContain("never starts from here");
  });
});
