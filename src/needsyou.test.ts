import { expect, test } from "bun:test";

test("needs-you board: master style bars, no empty header when no row fits", async () => {
  const { renderNeedsYou, isNeedsYouBoard } = await import("./needsyou.ts");
  const now = Date.now();
  const items = [{ id: "x", t: "A".repeat(300), s: "waiting", q: "https://discord.com/channels/1/2/3", cts: now }] as never;
  const t = renderNeedsYou(items, now, "", 120);
  expect(isNeedsYouBoard(t)).toBe(true);
  expect(t.startsWith("━")).toBe(true);
  expect(t.trimEnd().endsWith("━━━━━━━━━━━━━━━━━━━━")).toBe(true);
  expect(t).not.toContain("Waiting on you");
});
