import { expect, test } from "bun:test";
import { queueBoxAllowed } from "../src/masterqueue.ts";

test("no per-message Queue box in the FIRSTMATE channel; other channels keep it", () => {
  expect(queueBoxAllowed("100000000000000029", "100000000000000029")).toBe(false);
  expect(queueBoxAllowed("123", "100000000000000029")).toBe(true);
  expect(queueBoxAllowed("123", undefined)).toBe(true);
});
