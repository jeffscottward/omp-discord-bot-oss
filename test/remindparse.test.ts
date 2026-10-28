import { describe, expect, test } from "bun:test";
import { onCalendar, parseReminder } from "../src/remindparse.ts";

// Thu 2026-10-15 21:15:00 local time
const NOW = new Date(2026, 9, 15, 21, 15, 0);
const ok = (s: string) => {
  const r = parseReminder(s, NOW);
  if (!r.ok) throw new Error(r.error);
  return { at: onCalendar(r.when), msg: r.message };
};

describe("/remind free text (owner 2026-10-15)", () => {
  test("relative times keep the current clock time", () => {
    expect(ok("in 2 hours check the build")).toEqual({ at: "2026-10-15 23:15:00", msg: "Check the build" });
    expect(ok("check the build in 45 minutes")).toEqual({ at: "2026-10-15 22:00:00", msg: "Check the build" });
    expect(ok("in 1h30m stretch")).toEqual({ at: "2026-10-15 22:45:00", msg: "Stretch" });
    expect(ok("in 3 days renew certificate")).toEqual({ at: "2026-10-18 21:15:00", msg: "Renew certificate" });
    expect(ok("in 3 hours bot self-test")).toEqual({ at: "2026-10-16 00:15:00", msg: "Bot self-test" });
    expect(ok("in 2 weeks review repos").at).toBe("2026-10-29 21:15:00");
  });
  test("clock times and dates; a date alone means 09:00; past clock time means tomorrow", () => {
    expect(ok("remind me tomorrow at 9am to review the PR")).toEqual({ at: "2026-10-16 09:00:00", msg: "Review the PR" });
    expect(ok("tomorrow rotate logs")).toEqual({ at: "2026-10-16 09:00:00", msg: "Rotate logs" });
    expect(ok("at 5pm check deploy")).toEqual({ at: "2026-10-16 17:00:00", msg: "Check deploy" });
    expect(ok("next friday noon standup").at).toBe("2026-10-23 12:00:00");
    expect(ok("Oct 20 at 3:15pm tag the release")).toEqual({ at: "2026-10-20 15:15:00", msg: "Tag the release" });
  });
  test("no message gives a plain label; errors are explained", () => {
    expect(ok("in 10 minutes").msg).toBe("Reminder");
    const none = parseReminder("check the build", NOW);
    expect(none.ok).toBe(false);
    expect(parseReminder("in 2 years archive logs", NOW).ok).toBe(false);
    expect(parseReminder("   ", NOW).ok).toBe(false);
  });
});
