import { expect, test } from "bun:test";
import { watchdogContinue } from "../src/policy.ts";

// Owner 2026-10-19: a 10 s watchdog sends "continue" when a listed channel ends on a plain time-limit stop.
const stop = { id: "n", fromBot: true, content: "⏱️ The run hit the 30-minute limit and was stopped. The session is kept — reply here to continue.\n\nPartial output:\nabc" };
const bot = (id: string, content: string) => ({ id, fromBot: true, content });
test("plain stop as last message: continue once", () => {
  const h = new Set<string>();
  expect(watchdogContinue([stop], false, h)).toBe("n");
  h.add("n");
  expect(watchdogContinue([stop], false, h)).toBeNull();
});
test("board reprint and split partial output after the notice still fire", () => {
  expect(watchdogContinue([bot("b", "📋 **Queue** · nothing waiting"), bot("c", "…rest of the partial output"), stop], false, new Set())).toBe("n");
});
test("no continue: job running, owner wrote after, auto-continue, Stop, Working, no notice", () => {
  const h = new Set<string>();
  expect(watchdogContinue([stop], true, h)).toBeNull();
  expect(watchdogContinue([{ id: "o", fromBot: false, content: "hi" }, stop], false, h)).toBeNull();
  expect(watchdogContinue([bot("a", "⏱️ The run hit the 30-minute limit. 🔁 Continuing automatically (#1).")], false, h)).toBeNull();
  expect(watchdogContinue([bot("s", "🛑 Stopped. To steer, just type"), stop], false, h)).toBeNull();
  expect(watchdogContinue([bot("w", "⚙️ Working… 1m"), stop], false, h)).toBeNull();
  expect(watchdogContinue([bot("x", "a normal reply")], false, h)).toBeNull();
});
