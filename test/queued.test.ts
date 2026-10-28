import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hhmm, markQueued, matchCards, messageIdOf, parseCards, queuedNote, responseRefs, type Card } from "../src/queued.ts";

const G = "100000000000000002";
const CH = "100000000000000011";
const link = (m: string) => `https://discord.com/channels/${G}/${CH}/${m}`;

const cards: Card[] = [
  { id: "ask-card", s: "open", q: link("100000000000000017") },
  { id: "src-card", s: "waiting", src: link("100000000000000018") },
  { id: "chan-only", s: "waiting", src: `https://discord.com/channels/${G}/100000000000000019` },
  { id: "blocked-card", s: "blocked", src: link("100000000000000032") },
  { id: "busy", s: "running", q: link("100000000000000020") },
  { id: "gate-long-options", s: "waiting", src: link("100000000000000033") },
  { id: "timed", s: "waiting", until: "2026-10-20T09:30:00-04:00", src: link("100000000000000034") },
];

describe("queued: references", () => {
  test("messageIdOf reads only message links", () => {
    expect(messageIdOf(link("100000000000000017"))).toBe("100000000000000017");
    expect(messageIdOf(`https://discord.com/channels/${G}/100000000000000019`)).toBeUndefined();
    expect(messageIdOf(`https://discord.com/channels/@me/123456/7890123`)).toBe("7890123");
    expect(messageIdOf(undefined)).toBeUndefined();
  });

  test("responseRefs collects ids, message links, item tokens and dashboard item links", () => {
    const r = responseRefs(["100000000000000017", undefined, null, "not-an-id"], [
      `see ${link("100000000000000018")} and ⚓ item:blocked-card.`,
      "⚓ [FIRSTMATE dashboard](<https://dashboard.example.ts.net/reports/firstmate/?item=src-card#src-card>)",
    ]);
    expect(r.messageIds.sort()).toEqual(["100000000000000017", "100000000000000018"]);
    expect(r.itemIds.sort()).toEqual(["blocked-card", "src-card"]);
  });
});

describe("queued: matching", () => {
  test("menu message id matches q; replied-to id matches src", () => {
    expect(matchCards(cards, responseRefs(["100000000000000017"], []))).toEqual(["ask-card"]);
    expect(matchCards(cards, responseRefs(["100000000000000018"], []))).toEqual(["src-card"]);
    expect(matchCards(cards, responseRefs(["100000000000000032"], []))).toEqual(["blocked-card"]);
  });

  test("reply to a bot message with 'Still waiting' links marks only the replied-to card", () => {
    // main.ts passes the replied-to id + the owner's own text; the bot reply's links are not scanned.
    const botReply = { id: "100000000000000035" };
    const items: Card[] = [...cards, { id: "reply-card", s: "open", q: link(botReply.id) }];
    expect(matchCards(items, responseRefs(["100000000000000021", botReply.id], ["ok"]))).toEqual(["reply-card"]);
  });

  test("item token matches by id", () => {
    expect(matchCards(cards, responseRefs([], ["ok ⚓ item:src-card"]))).toEqual(["src-card"]);
  });

  test("never matches other states, time gates, channel-only links or no refs", () => {
    expect(matchCards(cards, responseRefs(["100000000000000020"], []))).toEqual([]);
    expect(matchCards(cards, responseRefs(["100000000000000033", "100000000000000034"], ["⚓ item:gate-long-options ⚓ item:timed ⚓ item:busy"]))).toEqual([]);
    expect(matchCards(cards, responseRefs(["100000000000000019"], []))).toEqual([]);
    expect(matchCards(cards, responseRefs([], []))).toEqual([]);
  });

  test("parseCards keeps string fields and skips junk", () => {
    const c = parseCards(JSON.stringify({ items: [{ id: "a", s: "open", q: 5, n: "x" }, "junk", null] }));
    expect(c).toEqual([{ id: "a", s: "open", q: undefined, src: undefined, until: undefined }]);
    expect(parseCards("{}")).toEqual([]);
  });

  test("note uses HH:MM", () => {
    const ms = new Date(2026, 9, 18, 7, 5).getTime();
    expect(hhmm(ms)).toBe("07:05");
    expect(queuedNote(ms)).toBe("📨 answered 07:05; working");
  });
});

describe("queued: fm writes", () => {
  test("fake fm: field queued first, then set partial, as owner:discord without FM_AUTO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queued-"));
    try {
      const items = join(dir, "items.json");
      writeFileSync(items, JSON.stringify({ items: cards }));
      const fm = join(dir, "fm");
      const calls = join(dir, "calls");
      writeFileSync(fm, `#!/bin/sh\necho "$FM_BY|\${FM_AUTO:-none}|$*" >> ${calls}\n`);
      chmodSync(fm, 0o755);
      process.env.FM_AUTO = "leak";
      const logs: string[] = [];
      const now = new Date(2026, 9, 18, 20, 5).getTime();
      const got = await markQueued(responseRefs(["100000000000000017"], ["⚓ item:src-card"]), { file: items, fm, now, log: (s) => logs.push(s) });
      delete process.env.FM_AUTO;
      expect(got.sort()).toEqual(["ask-card", "src-card"]);
      const lines = readFileSync(calls, "utf8").trim().split("\n");
      expect(lines).toEqual([
        `owner:discord|none|field ask-card queued ${now}`,
        "owner:discord|none|set ask-card partial 📨 answered 20:05; working",
        `owner:discord|none|field src-card queued ${now}`,
        "owner:discord|none|set src-card partial 📨 answered 20:05; working",
      ]);
      expect(logs.at(-1)).toContain("marked ask-card, src-card");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing tracker or failing fm never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queued-"));
    try {
      expect(await markQueued(responseRefs(["100000000000000017"], []), { file: join(dir, "none.json") })).toEqual([]);
      const items = join(dir, "items.json");
      writeFileSync(items, JSON.stringify({ items: cards }));
      const fm = join(dir, "fm");
      writeFileSync(fm, "#!/bin/sh\necho refused >&2\nexit 1\n");
      chmodSync(fm, 0o755);
      const logs: string[] = [];
      expect(await markQueued(responseRefs(["100000000000000017"], []), { file: items, fm, log: (s) => logs.push(s) })).toEqual([]);
      expect(logs[0]).toContain("refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Integration with the real tracker CLI, pointed at a temp copy of items.json.
  const realFm = join(import.meta.dir, "..", "kit", "bin", "fm");
  test.skipIf(!existsSync(realFm))("real fm: card becomes partial + queued + queuedFrom; fm-autoclear may not move it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queued-"));
    const prevItems = process.env.FM_ITEMS;
    try {
      const items = join(dir, "items.json");
      writeFileSync(items, JSON.stringify({ items: cards.map((c) => ({ ...c, t: c.id, area: "Tools", n: "old" })) }));
      // The tracker CLI reads FM_ITEMS before kit.env, so the test never touches a real tracker.
      process.env.FM_ITEMS = items;
      const fm = realFm;
      const now = Date.now();
      expect(await markQueued(responseRefs(["100000000000000018"], []), { file: items, fm, now })).toEqual(["src-card"]);
      const after = JSON.parse(readFileSync(items, "utf8")).items.find((c: Card) => c.id === "src-card");
      expect(after).toMatchObject({ s: "partial", queued: String(now), queuedFrom: "waiting", by: "owner:discord" });
      expect(after.n).toStartWith("📨 answered ");
      const r = Bun.spawnSync([fm, "set", "src-card", "waiting", "stale"], { env: { ...process.env, FM_AUTO: "R7 test" } });
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(readFileSync(items, "utf8")).items.find((c: Card) => c.id === "src-card").s).toBe("partial");
    } finally {
      if (prevItems === undefined) delete process.env.FM_ITEMS;
      else process.env.FM_ITEMS = prevItems;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
