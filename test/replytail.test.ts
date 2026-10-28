import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachTail, buildTail, isFinanceChannel } from "../src/replytail.ts";
import { renderTables } from "../src/tablerender.ts";

const dash = "⚓ [FIRSTMATE dashboard ↗](<https://x/reports/firstmate/>)";
const tail = buildTail("anthropic/claude-opus-5-5", dash);

test("tail is a bullet list, model first", () => {
  expect(tail).toBe(`- 🧠 anthropic/claude-opus-5-5\n- ${dash}`);
  expect(buildTail("m", "")).toBe("- 🧠 m");
  expect(buildTail(undefined, "")).toBe("");
});

test("exactly one blank line, with or without trailing newlines", () => {
  for (const c of ["Hello", "Hello\n", "Hello\n\n\n  "]) expect(attachTail(c, tail).content).toBe(`Hello\n\n${tail}`);
});

test("trailing code fence keeps one blank line", () => {
  expect(attachTail("```\nx\n```\n", tail).content).toBe(`\`\`\`\nx\n\`\`\`\n\n${tail}`);
});

test("no dash link: only the 🧠 line", () => {
  expect(attachTail("Hi", buildTail("m", "")).content).toBe("Hi\n\n- 🧠 m");
});

test("audio: spacer after the whole tail", () => {
  expect(attachTail("🔊 Hi", tail, "\n\u200b").content).toBe(`🔊 Hi\n\n${tail}\n\u200b`);
});

test("near 2000: tail moves to a follow-up, never dropped", () => {
  const big = "a".repeat(1990);
  const r = attachTail(big, tail);
  expect(r.content).toBe(big);
  expect(r.followup).toBe(tail);
  const fits = "a".repeat(2000 - tail.length - 2);
  expect(attachTail(fits, tail).content.length).toBe(2000);
});

test("finance channel detection", () => {
  expect(isFinanceChannel("1", ["newsletter-digest"], new Set())).toBe(true);
  expect(isFinanceChannel("1", ["general", "📈 Finance"], new Set())).toBe(true);
  expect(isFinanceChannel("1", ["main-github-firstmate", "Github"], new Set())).toBe(false);
  expect(isFinanceChannel("42", ["general"], new Set(["42"]))).toBe(true);
});

test("imageOnly: PNG, no page directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbl-"));
  const r = await renderTables("| a | b |\n|---|---|\n| 1 | 2 |", { dir, imageOnly: true, render: async (_t, p) => Bun.write(p, "png").then(() => {}) });
  expect(r.files.length).toBe(1);
  expect(r.text).toContain("no web page: finance channel");
  expect(readdirSync(dir)).toEqual([]);
  expect(r.files[0]!.path.startsWith(dir)).toBe(false);
  expect(existsSync(r.files[0]!.path)).toBe(true);
  for (const d of r.tmpDirs ?? []) rmSync(d, { recursive: true, force: true });
});
