import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApiFallback, usedApiFallback } from "../src/apifallback.ts";

const T = Date.parse("2026-11-01T20:00:00Z");
const msg = (provider: string, model: string, ts = "2026-11-01T20:05:00Z") =>
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", provider, model, content: [] } });

test("detects only OpenRouter Claude assistant messages after the run start", () => {
  expect(usedApiFallback(msg("openrouter", "anthropic/claude-opus-5.5"), T)).toBe(true);
  expect(usedApiFallback(msg("anthropic", "claude-opus-5-5"), T)).toBe(false);
  expect(usedApiFallback(msg("openrouter", "anthropic/claude-opus-5.5", "2026-11-01T19:00:00Z"), T)).toBe(false);
  expect(usedApiFallback(msg("openrouter", "cognitivecomputations/dolphin"), T)).toBe(false);
  expect(usedApiFallback(JSON.stringify({ type: "message", timestamp: "2026-11-01T20:05:00Z", message: { role: "toolResult", content: [{ type: "text", text: '"openrouter" claude' }] } }), T)).toBe(false);
});

test("posts once per window and pushes ntfy once", async () => {
  const d = mkdtempSync(join(tmpdir(), "apifb-"));
  const f = join(d, "s.jsonl");
  writeFileSync(f, `${msg("openrouter", "anthropic/claude-opus-5.5")}\n`);
  const posts: string[] = [];
  let pushes = 0;
  const run = () => checkApiFallback({ sessionFile: f, startedAt: T, channelLabel: "#x", log: () => {}, post: async (t) => posts.push(t), now: T + 60_000, stateFile: join(d, "sent.json"), ntfy: () => (pushes++, true) });
  expect(await run()).toBe(true);
  expect(await run()).toBe(false);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("OpenRouter API");
  expect(pushes).toBe(1);
});
