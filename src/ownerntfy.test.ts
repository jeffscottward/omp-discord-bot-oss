import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSummary, ownerNtfy } from "./ownerntfy.ts";

test("one push per key, persisted across calls (restart)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ntfy-")), "sent.json");
  const calls: string[][] = [];
  const run = (_b: string, a: string[]) => void calls.push(a);
  expect(ownerNtfy("ask:1", "input", "Pick a plan?", "https://discord.com/channels/1/2/3", { file, run })).toBe(true);
  expect(ownerNtfy("ask:1", "input", "Pick a plan?", undefined, { file, run })).toBe(false);
  expect(ownerNtfy("approval:x", "approval", "Approve x", undefined, { file, run })).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]).toEqual(["--kind", "input", "--summary", "Pick a plan?", "--action", "https://discord.com/channels/1/2/3"]);
  expect(calls[1]).toContain("Open Discord and answer it"); // the sender requires --action for input/approval
});

test("summary is one short line without long digit runs", () => {
  expect(cleanSummary("**Acct** 123456789\n next")).toBe("Acct … next");
  expect(cleanSummary("a".repeat(300)).length).toBe(200);
});

test("under bun test, no push without an injected runner and file", () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(ownerNtfy("ask:guard", "input", "x", undefined)).toBe(false);
});
