import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPLAY_MAX_AGE_MS, replayAllowed, takeReplays } from "../src/replay.ts";

test("takeReplays reads valid items once and deletes the file", () => {
  const f = join(mkdtempSync(join(tmpdir(), "rp-")), "replay.json");
  writeFileSync(f, JSON.stringify([{ channelId: "100000000000000401", messageId: "100000000000000402" }, { channelId: "x", messageId: "1" }, null]));
  expect(takeReplays(f)).toEqual([{ channelId: "100000000000000401", messageId: "100000000000000402" }]);
  expect(existsSync(f)).toBe(false);
  expect(takeReplays(f)).toEqual([]);
  writeFileSync(f, "{bad");
  expect(takeReplays(f)).toEqual([]);
});

test("replayAllowed: owner and recent only", () => {
  const now = 1_000_000_000_000;
  expect(replayAllowed({ authorId: "o", createdMs: now - 1000 }, "o", now)).toBe(true);
  expect(replayAllowed({ authorId: "x", createdMs: now - 1000 }, "o", now)).toBe(false);
  expect(replayAllowed({ authorId: "o", createdMs: now - REPLAY_MAX_AGE_MS - 1 }, "o", now)).toBe(false);
});
