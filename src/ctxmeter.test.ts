import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardCtxLines, ctxLine, ctxOfFile, ctxSuffix, parseModels } from "./ctxmeter.ts";

const line = (u: object, model = "claude-opus-5-5") => JSON.stringify({ type: "message", message: { role: "assistant", model, usage: u } });
const win = (m: string) => (m === "claude-opus-5-5" ? 1_000_000 : undefined);

test("percent from the last assistant usage of a fixture session", () => {
  const d = mkdtempSync(join(tmpdir(), "ctx-"));
  const f = join(d, "s.jsonl");
  writeFileSync(f, [line({ input: 5, cacheRead: 100, cacheWrite: 0 }), JSON.stringify({ type: "message", message: { role: "user" } }), line({ input: 2, output: 711, cacheRead: 825_000, cacheWrite: 1514 })].join("\n") + "\n");
  const c = ctxOfFile(f, win)!;
  expect(c.used).toBe(826_516);
  expect(c.pct).toBe(83);
  expect(ctxLine("FIRSTMATE", c)).toBe("⚠️ FIRSTMATE context: 83% (827k / 1M) · compacts at 85%");
  expect(ctxSuffix(c)).toBe(" · ctx 83% ⚠️");
  expect(ctxSuffix({ ...c, pct: 40 })).toBe(" · ctx 40%");
  expect(ctxSuffix(undefined)).toBe("");
});

test("board lines: FIRSTMATE plus recent stacks", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxr-"));
  for (const [k, n] of [["firstmate", 900_000], ["stack-ai", 410_000]] as const) {
    mkdirSync(join(root, k));
    writeFileSync(join(root, k, "a.jsonl"), line({ input: n, cacheRead: 0, cacheWrite: 0 }) + "\n");
  }
  expect(boardCtxLines(root, Date.now(), win)).toBe("🔴 FIRSTMATE context: 90% (900k / 1M) · compacts at 85%\n🧵 Stacks context: ai 41%");
});

test("omp models table", () => {
  const m = parseModels("│ model │ context │ max-out │\n│ claude-opus-5-5            │      1M │    128K │\n│ x │ 200K │ 8K │");
  expect(m.get("claude-opus-5-5")).toBe(1_000_000);
  expect(m.get("x")).toBe(200_000);
});
