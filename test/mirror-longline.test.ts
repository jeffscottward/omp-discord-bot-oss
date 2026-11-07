import { expect, test } from "bun:test";
import { sessionEvents, tailOffset } from "../src/mirror.ts";

test("tail offset: a full window with no newline is skipped, a short partial line waits", () => {
  const MAX = 1024 * 1024;
  const huge = Buffer.alloc(MAX, 0x61); // one line longer than the read window
  const r = sessionEvents(huge);
  expect(r.consumed).toBe(0);
  expect(tailOffset(500, huge.length, r.consumed)).toBe(500 + MAX);
  // Its tail (no valid JSON) is dropped; the next line parses again.
  const next = Buffer.from(`aaaa"}\n${JSON.stringify({ type: "message", timestamp: new Date(0).toISOString(), message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`);
  const n = sessionEvents(next);
  expect(n.consumed).toBe(next.length);
  expect(n.events.length).toBe(1);
  expect(tailOffset(0, 10, 0)).toBeNull();
  expect(tailOffset(7, 100, 40)).toBe(47);
});
