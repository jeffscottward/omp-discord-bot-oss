import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, upsertStack } from "../src/stackcatalog.ts";
import { mergeStacks } from "../src/router.ts";
import { emojiKey } from "../src/stackemoji.ts";
import { ChannelType, type Guild } from "discord.js";
import { Mirror } from "../src/mirror.ts";

const keys = (xs: (string | undefined)[]) => xs.map((e) => emojiKey(e ?? ""));
const unique = (xs: (string | undefined)[]) => new Set(keys(xs)).size === xs.length && !keys(xs).includes("");

describe("stack emojis are unique (owner 2026-11-07)", () => {
  test("merged catalog (defaults + live stacks.json) has unique emojis, no 🧩", () => {
    const merged = mergeStacks(loadCatalog().stacks);
    expect(unique(merged.map((s) => s.emoji))).toBe(true);
    expect(merged.some((s) => s.emoji === "🧩")).toBe(false);
  });

  test("fixed category emojis (🖥️ Main, 💻 Second …) are never given to a stack", () => {
    const m = mergeStacks([{ name: "boxes", emoji: "🖥️" }, { name: "macs", emoji: "💻" }]);
    expect(m.some((s) => s.emoji === "🖥️" || s.emoji === "💻")).toBe(false);
  });

  test("merge re-picks missing and duplicate emojis", () => {
    const merged = mergeStacks([{ name: "a1" }, { name: "b2" }, { name: "c3", emoji: "💹" }, { name: "d4", emoji: "💹" }]);
    expect(unique(merged.map((s) => s.emoji))).toBe(true);
  });

  test("adding 30 stacks via upsert keeps them unique, also merged with defaults", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stackemoji-")), "stacks.json");
    for (let n = 0; n < 30; n++) upsertStack({ name: `stack-${n}`, keywords: n % 3 ? ["dev"] : [] }, { file });
    upsertStack({ name: "dupe", emoji: loadCatalog(file).stacks[0]!.emoji }, { file });
    const stored = loadCatalog(file).stacks;
    expect(stored.length).toBe(31);
    expect(unique(stored.map((s) => s.emoji))).toBe(true);
    expect(unique(mergeStacks(stored).map((s) => s.emoji))).toBe(true);
  });

  test("upsert refuses a code-default stack's emoji; a default stack keeps its own", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stackemoji-")), "stacks.json");
    const { entry } = upsertStack({ name: "newone", emoji: "💹" }, { file });
    expect(entry.emoji).not.toBe("💹");
    upsertStack({ name: "finance", keywords: ["x"] }, { file });
    expect(loadCatalog(file).stacks.find((s) => s.name === "finance")?.emoji).toBeUndefined();
    expect(upsertStack({ name: "finance", emoji: "💹" }, { file }).entry.emoji).toBe("💹");
  });

  test("orderCategories renames a stack category whose emoji changed", async () => {
    const m = new Mirror(null, join(mkdtempSync(join(tmpdir(), "mirror-")), "m.json"), new Set());
    m.stackCats = { dev: ["11", "12"], finance: ["13"] };
    m.stacks = () => mergeStacks([{ name: "dev", emoji: "⌨️" }]);
    const edits: string[] = [];
    const cat = (id: string, name: string, position: number) => ({ id, name, position, type: ChannelType.GuildCategory, edit: async (o: { name: string }) => { edits.push(`${id}:${o.name}`); } });
    const cache = new Map([["10", cat("10", "🖥️ Main", 0)], ["11", cat("11", "🧩 dev", 1)], ["12", cat("12", "🧩 dev 2", 2)], ["13", cat("13", "💹 finance", 3)]]);
    const guild = { channels: { cache, setPositions: async () => {} } };
    await m.orderCategories(guild as unknown as Guild, "10");
    expect(edits).toEqual(["11:⌨️ dev", "12:⌨️ dev 2"]);
  });
});
