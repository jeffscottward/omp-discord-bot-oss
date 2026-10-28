import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHeartbeat, SessionTail } from "../src/heartbeat";
import { defaultModel } from "../src/omp";

// Owner 2026-10-19: the Working message names the model, not only "Model is thinking".
const base = { startedAt: 0, now: 5_000, tree: { alive: true, procs: 3, ticks: new Map<number, number>(), ioBytes: 0, rootTicks: 0 }, cpuPct: 0, ioBps: 0, lastWrite: 1_000, toolCalls: 0, pending: [], lastKind: "model" as const, subagents: [] };
const L = (o: object) => `${JSON.stringify(o)}\n`;

test("model and thinking level from the session log", () => {
  const t = new SessionTail("/nonexistent");
  t.ingest(L({ type: "model_change", model: "anthropic/claude-opus-5-5" }) + L({ type: "thinking_level_change", thinkingLevel: "low", configured: "auto" }));
  expect(t.model).toBe("anthropic/claude-opus-5-5");
  expect(t.thinking).toBe("low (auto)");
  t.ingest(L({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "unrestricted", model: "qwen3.8-27b-uncensored", content: [] } }));
  expect(t.model).toBe("unrestricted/qwen3.8-27b-uncensored");
});
test("continued session: model read from before the run's start offset", () => {
  const f = join(mkdtempSync(join(tmpdir(), "hbm-")), "s.jsonl");
  const old = L({ type: "model_change", model: "unrestricted/qwen3.8-27b-uncensored" });
  writeFileSync(f, old);
  expect(new SessionTail(f, Buffer.byteLength(old)).model).toBe("unrestricted/qwen3.8-27b-uncensored");
});
test("Working text names the model", () => {
  const s = formatHeartbeat({ ...base, model: "anthropic/claude-opus-5-5", thinking: "low (auto)" });
  expect(s).toContain("🤖 Model: `anthropic/claude-opus-5-5` · thinking low (auto)");
  expect(s).not.toContain("is thinking or writing"); // owner 2026-10-19: line removed
  expect(formatHeartbeat(base)).not.toContain("🧠");
});
test("subagent lines show their model", () => {
  const s = formatHeartbeat({ ...base, subagents: [{ name: "Scout", lastWrite: 4_000, toolCalls: 2, pending: [], lastTool: null, done: false, model: "anthropic/claude-sonnet-5" }] });
  expect(s).toContain("**Scout** (claude-sonnet-5)");
  const same = formatHeartbeat({ ...base, model: "anthropic/claude-sonnet-5", subagents: [{ name: "Scout", lastWrite: 4_000, toolCalls: 2, pending: [], lastTool: null, done: false, model: "anthropic/claude-sonnet-5" }] });
  expect(same).toContain("**Scout**:");
});
test("defaultModel reads modelRoles.default", () => {
  const f = join(mkdtempSync(join(tmpdir(), "hbc-")), "config.yml");
  writeFileSync(f, "x: 1\nmodelRoles:\n  judge: a/b\n  default: anthropic/claude-opus-5-5\nother: 2\n");
  expect(defaultModel(f)).toBe("anthropic/claude-opus-5-5");
});
test("last line is always the latest tool call with a clear description", () => {
  const t = new SessionTail("/nonexistent");
  const ts = new Date(2_000).toISOString();
  t.ingest(L({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", intent: "git status", arguments: { command: "secret-arg" } }] } }));
  const run = formatHeartbeat({ ...base, lastTool: t.lastTool, lastToolRunning: t.pending.has("c1") });
  expect(run.split("\n").at(-1)).toBe("🛠️ **Last tool:** `bash`: git status · running 3s");
  expect(run).not.toContain("secret-arg");
  t.ingest(L({ type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: "c1" } }));
  const done = formatHeartbeat({ ...base, lastTool: { ...t.lastTool!, intent: "check repo state" }, lastToolRunning: t.pending.has("c1") });
  expect(done.split("\n").at(-1)).toBe("🛠️ **Last tool:** `bash`: check repo state · done · called 3s ago");
  expect(formatHeartbeat(base).split("\n").at(-1)).toBe("🛠️ **Last tool:** none yet");
});
test("a token cut by the length limit is still redacted (redact before truncate)", () => {
  const tok = ["MTU2MTgzMjU5MzQ0NjUzNTI2OQ", "GEaXVp", "Fley82ip5lJyWbruH_Q5mNqcsO-nXW4ek9TfWM"].join(".");
  const s = formatHeartbeat({ ...base, lastTool: { name: "bash", intent: `${"x".repeat(80)} ${tok}`, since: 0 }, lastToolRunning: false });
  expect(s).not.toContain("MTU2MTgz");
});
