import { expect, test } from "bun:test";
import { applyEvent, renderProgress, sessionEvents, type Progress } from "../src/mirror.ts";

// Owner 2026-10-19: Herdr-tab channels show the same 🤖 Model and 🛠️ Last tool lines as the Working message.
const L = (o: object) => `${JSON.stringify(o)}\n`;
const ts = (n: number) => new Date(1_792_000_000_000 + n * 1000).toISOString();

test("progress shows the model and ends with the latest tool call", () => {
  const raw = L({ type: "model_change", timestamp: ts(0), model: "anthropic/claude-opus-5-5" })
    + L({ type: "message", timestamp: ts(1), message: { role: "user", content: [{ type: "text", text: "build it" }] } })
    + L({ type: "message", timestamp: ts(2), message: { role: "assistant", provider: "unrestricted", model: "qwen3.8-27b-uncensored", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "secret-arg", i: "run the tests" } }] } });
  let p: Progress | undefined;
  for (const ev of sessionEvents(Buffer.from(raw)).events) p = applyEvent(p, ev).p;
  let text = renderProgress("random", p!);
  expect(text).toContain("🤖 Model: `unrestricted/qwen3.8-27b-uncensored`");
  expect(text.split("\n").at(-1)).toMatch(/^🛠️ \*\*Last tool:\*\* `bash`: run the tests · running · called <t:\d+:R>$/);
  expect(text).not.toContain("secret-arg");
  const res = L({ type: "message", timestamp: ts(3), message: { role: "toolResult", toolCallId: "c1", content: [] } });
  for (const ev of sessionEvents(Buffer.from(res)).events) p = applyEvent(p, ev).p;
  text = renderProgress("random", p!);
  expect(text.split("\n").at(-1)).toContain("· done · called");
});
test("model carries over to the next turn", () => {
  let p: Progress | undefined = { startTs: 0, lastTs: 0, count: 1, steps: [], state: "done", model: "anthropic/claude-opus-5-5" };
  p = applyEvent(p, { kind: "turn", ts: 5, text: "next" }).p;
  expect(renderProgress("t", p!)).toContain("🤖 Model: `anthropic/claude-opus-5-5`");
  expect(renderProgress("t", p!).split("\n").at(-1)).toBe("🛠️ **Last tool:** none yet");
});
test("thinking level from thinking_level_change shows after the model (card reply-thinking-level)", () => {
  const raw = L({ type: "message", timestamp: ts(1), message: { role: "user", content: [{ type: "text", text: "go" }] } })
    + L({ type: "thinking_level_change", timestamp: ts(2), thinkingLevel: "low", configured: "auto" })
    + L({ type: "message", timestamp: ts(3), message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x" } }] } });
  const evs = sessionEvents(Buffer.from(raw)).events;
  expect(evs).toContainEqual({ kind: "thinking", ts: Date.parse(ts(2)), level: "low (auto)" });
  let p: Progress | undefined;
  for (const ev of evs) p = applyEvent(p, ev).p;
  expect(renderProgress("t", p!)).toContain("🤖 Model: `anthropic/claude-opus-5-5`\n🧠 Reasoning: low (auto)");
  const fixed = sessionEvents(Buffer.from(L({ type: "thinking_level_change", thinkingLevel: "high" }))).events[0];
  expect(fixed).toMatchObject({ kind: "thinking", level: "high" });
  p = applyEvent(p, fixed!).p;
  expect(renderProgress("t", p!)).toContain("\n🧠 Reasoning: high");
  expect(renderProgress("t", p!)).not.toContain("🧩");
  p = applyEvent({ ...p!, state: "done" }, { kind: "turn", ts: 9 }).p;
  expect(p!.thinking).toBe("high");
});
