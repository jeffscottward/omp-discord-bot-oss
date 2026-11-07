import { describe, expect, test } from "bun:test";
import { botRows, healedJobs } from "../src/masterqueue.ts";
import { stackThreadName } from "../src/stackroute.ts";

// Card heal-failed-finished (owner 2026-11-07).
describe("failed/stopped jobs healed in Finished", () => {
  const now = 1_794_080_000_000;
  const done = [
    { id: 1962, title: "b2", channelId: "B", state: "done" as const, at: now - 1000 },
    { id: 1961, title: "b1", channelId: "B", state: "stopped" as const, at: now - 2000 },
    { id: 1960, title: "a2", channelId: "A", state: "done" as const, at: now - 3000 },
    { id: 1959, title: "a1", channelId: "A", state: "stopped" as const, at: now - 4000 },
    { id: 1950, title: "c1", channelId: "C", state: "failed" as const, at: now - 5000, link: "L-c1" },
    { id: 1940, title: "d1", channelId: "D", state: "failed" as const, at: now - 6000 },
  ];
  test("a later ok job or a live job in the same channel heals it", () => {
    const h = healedJobs([{ id: 1970, channelId: "C", link: "L-c1" }], done);
    expect([...h].sort()).toEqual([1950, 1959, 1961]);
  });
  test("an unrelated later message in the channel never hides a real failure", () => {
    expect(healedJobs([{ id: 1970, channelId: "C", link: "L-other" }], done).has(1950)).toBe(false);
    expect(healedJobs([], [{ id: 3, channelId: "X", state: "done", at: 3, link: "B" }, { id: 2, channelId: "X", state: "failed", at: 2, link: "A" }]).size).toBe(0);
  });
  test("an earlier ok job does not heal a later failure", () => {
    expect(healedJobs([], [{ id: 2, channelId: "X", state: "failed", at: 2 }, { id: 1, channelId: "X", state: "done", at: 1 }]).size).toBe(0);
  });
  test("botRows drops healed rows and keeps the unhealed failure", () => {
    const keys = botRows([], done, now).map((r) => r.key);
    expect(keys).toEqual(["job:1962", "job:1960", "job:1950", "job:1940"]);
  });
});

describe("stack thread names follow the stack emoji", () => {
  test("replaces only the leading emoji", () => {
    expect(stackThreadName("🧭 firstmate stack", { name: "firstmate", emoji: "🛟" })).toBe("🛟 firstmate stack");
    expect(stackThreadName("🛟 firstmate stack", { name: "firstmate", emoji: "🛟" })).toBe("🛟 firstmate stack");
    expect(stackThreadName("odd name", { name: "discord", emoji: "💬" })).toBe("💬 discord stack");
  });
});
