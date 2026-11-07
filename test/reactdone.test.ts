import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoneFollowUps, followUpText, isDoneEmoji, isOwnerDone, markOwnerDone } from "../src/reactdone.ts";

const OWNER = "1";
const BOT = "2";
const link = (m: string) => `https://discord.com/channels/100000000000000002/100000000000000011/${m}`;

describe("isOwnerDone", () => {
  const base = { emoji: "✅", reactorId: OWNER, ownerId: OWNER, messageAuthorId: BOT, botId: BOT };
  test("owner ✅ / ✔️ / ☑️ on a bot message counts", () => {
    for (const emoji of ["✅", "✔️", "☑️"]) expect(isOwnerDone({ ...base, emoji })).toBe(true);
  });
  test("other emoji, other users, the bot itself, and non-bot messages do not count", () => {
    expect(isOwnerDone({ ...base, emoji: "❤️" })).toBe(false);
    expect(isOwnerDone({ ...base, reactorId: "9" })).toBe(false);
    expect(isOwnerDone({ ...base, reactorId: BOT })).toBe(false);
    expect(isOwnerDone({ ...base, messageAuthorId: OWNER })).toBe(false);
    expect(isOwnerDone({ ...base, botId: undefined })).toBe(false);
    expect(isDoneEmoji(null)).toBe(false);
  });
  test("follow-up text", () => {
    expect(followUpText("L")).toBe("✅ (owner reaction) The step in L is done. Continue.");
  });
});

describe("markOwnerDone", () => {
  test("clears q and sets partial on cards linking the message; skips others", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reactdone-"));
    const items = join(dir, "items.json");
    writeFileSync(items, JSON.stringify({ items: [
      { id: "a", s: "waiting", q: link("100000000000000017") },
      { id: "b", s: "open", src: link("100000000000000017") },
      { id: "c", s: "running", q: link("100000000000000017") },
      { id: "d", s: "waiting", q: link("100000000000000022") },
    ] }));
    const calls = join(dir, "calls");
    const fm = join(dir, "fm");
    writeFileSync(fm, `#!/bin/sh\necho "$FM_BY $*" >> ${calls}\n`);
    chmodSync(fm, 0o755);
    const ids = await markOwnerDone("100000000000000017", { file: items, fm, now: new Date(2026, 9, 23, 9, 5).getTime() });
    expect(ids).toEqual(["a", "b"]);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "owner:discord q a -",
      "owner:discord set a partial ✅ Owner marked done 09:05",
      "owner:discord q b -",
      "owner:discord set b partial ✅ Owner marked done 09:05",
    ]);
  });
  test("unreadable tracker returns []", async () => {
    expect(await markOwnerDone("1", { file: "/nonexistent/items.json" })).toEqual([]);
  });
});

describe("DoneFollowUps", () => {
  test("one follow-up per message, starts after grace", async () => {
    const started: string[] = [];
    const f = new DoneFollowUps((m) => started.push(m), 20);
    expect(f.add("m")).toBe(true);
    expect(f.add("m")).toBe(false);
    await Bun.sleep(40);
    expect(started).toEqual(["m"]);
    expect(f.add("m")).toBe(false);
  });
  test("removal within the window cancels; after start it does nothing", async () => {
    const started: string[] = [];
    const f = new DoneFollowUps((m) => started.push(m), 20);
    f.add("x");
    expect(f.remove("x")).toBe(true);
    await Bun.sleep(40);
    expect(started).toEqual([]);
    f.add("y");
    await Bun.sleep(40);
    expect(f.remove("y")).toBe(false);
    expect(started).toEqual(["y"]);
  });
  test("removal after the cancel window does not cancel", () => {
    let t = 0;
    const f = new DoneFollowUps(() => {}, 1_000_000, 60_000, () => t);
    f.add("z");
    t = 61_000;
    expect(f.remove("z")).toBe(false);
  });
});
