import { expect, test } from "bun:test";
import { timeLimitContinue } from "../src/policy.ts";

// Owner 2026-10-19: only Qwen + Example Activity – dev get the automatic continue after the time limit.
const FX = "100000000000000037", QWEN_MIRROR = "100000000000000038", QWEN_PINNED = "100000000000000031", FM = "100000000000000029";
test("listed channels, their threads and 🔓-qwen continue; others do not", () => {
  const listed = [FX, QWEN_MIRROR];
  expect(timeLimitContinue(FX, null, listed, [QWEN_PINNED])).toBe(true);
  expect(timeLimitContinue("thread1", QWEN_MIRROR, listed, [QWEN_PINNED])).toBe(true);
  expect(timeLimitContinue(QWEN_PINNED, null, listed, [QWEN_PINNED])).toBe(true);
  expect(timeLimitContinue(FM, null, listed, [QWEN_PINNED])).toBe(false);
  expect(timeLimitContinue("t2", FM, listed, [QWEN_PINNED])).toBe(false);
});
