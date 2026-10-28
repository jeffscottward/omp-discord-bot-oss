import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHeartbeat } from "../src/heartbeat";
import { IDLE_TIMEOUT_MS, RUN_TIMEOUT_MS } from "../src/config";

// Owner 2026-10-19: runs stop after 10 min with no session-log change; the clock limit is only a 4 h safety cap.
const L = (o: object) => `${JSON.stringify(o)}\n`;
test("defaults: 10-min no-activity limit, 4 h cap", () => {
  expect(IDLE_TIMEOUT_MS).toBe(10 * 60_000);
  expect(RUN_TIMEOUT_MS).toBe(240 * 60_000);
});
test("activity() follows new log entries and subagent logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "idle-"));
  const f = join(dir, "s.jsonl");
  writeFileSync(f, L({ type: "session" }));
  const t0 = Date.now();
  const hb = new RunHeartbeat(t0, dir);
  expect(hb.activity(t0)).toBeGreaterThanOrEqual(t0); // nothing yet: the run start
  const ts = new Date(t0 + 5_000).toISOString();
  appendFileSync(f, L({ type: "message", timestamp: ts, message: { role: "assistant", content: [] } }));
  expect(hb.activity()).toBeGreaterThanOrEqual(t0 + 5_000);
  mkdirSync(join(dir, "s"));
  writeFileSync(join(dir, "s", "Scout.jsonl"), L({ type: "message", timestamp: new Date(t0 + 60_000).toISOString(), message: { role: "assistant", content: [] } }));
  expect(hb.activity()).toBeGreaterThanOrEqual(t0 + 60_000);
});
