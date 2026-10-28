import { describe, expect, test } from "bun:test";
import { fitLines, pendingLine } from "../src/pending";

describe("pending restart line", () => {
  test("no waiter: no line", () => expect(pendingLine(null)).toBeNull());
  test("counts updates", () => {
    expect(pendingLine({ updates: 1 })).toContain("1 update ready");
    expect(pendingLine({ updates: 9 })).toContain("9 updates ready");
    expect(pendingLine({ updates: 0 })).toContain("no new code (reload only)");
    expect(pendingLine({ updates: 3 })).toContain("restarts when every queue is empty");
    const busy = pendingLine({ updates: 3 }, ["#off-book", "#off-book", "another channel"])!;
    expect(busy).toContain("Still busy: #off-book, another channel.");
    expect(busy).not.toContain("this queue");
  });
});

describe("fitLines", () => {
  test("keeps whole lines and marks the cut", () => {
    const link = "1. [msg](https://discord.com/channels/1/2/3)";
    const out = fitLines(Array(100).fill(link), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.split("\n").slice(0, -1).every((l) => l === link)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
  test("short boards are unchanged", () => expect(fitLines(["a", "b"])).toBe("a\nb"));
});

import { markRestarted } from "../src/pending";
test("markRestarted swaps only the pending line", () => {
  const b = "⏳ **Queue**\n🔄 **Restart pending:** 3 updates ready. The bot restarts when this queue is empty.\n🏁 **Finished**";
  const t = markRestarted(b, "abc1234");
  expect(t).toContain("✅ **Restarted:** the bot is running `abc1234`");
  expect(t).not.toContain("Restart pending");
  expect(t).toContain("🏁 **Finished**");
});

test("UX item 6: the drain line names the jobs that hold the restart", () => {
  const one = pendingLine({ updates: 2 }, [], true, ["#example-activity 🔗 [build the page](https://discord.com/channels/1/2/3) (running 12m)"])!;
  expect(one).toContain("New jobs wait until this job ends: #example-activity 🔗 [build the page](https://discord.com/channels/1/2/3) (running 12m)");
  expect(one).toContain("2 updates ready");
  const many = pendingLine(null, [], true, ["a", "b", "c", "d"])!;
  expect(many).toContain("these jobs end: a, b, c +1 more");
  expect(pendingLine(null, [], true)).toContain("the bot restarts when the running jobs end");
});
