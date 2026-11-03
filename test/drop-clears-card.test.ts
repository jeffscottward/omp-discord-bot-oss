// Owner 2026-11-01 (card drop-clears-card): a received or expired secret drop clears the cards that wait on it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DROP_EXPIRED_NOTE, DROP_RECEIVED_NOTE, dropCardCommands } from "../src/dropcards.ts";
import { type Drop, SecretDrops } from "../src/secretdrop.ts";

const url = (m: string) => `https://discord.com/channels/1/2/${m}`;
const cards = [
  { id: "webapp", s: "waiting", q: url("100000000000000302") },
  { id: "busy", s: "running", q: url("100000000000000302") },
  { id: "other", s: "waiting", q: url("100000000000000305") },
  { id: "noq", s: "open" },
];

describe("drop outcome clears cards", () => {
  test("received: owner-state card → partial, q and action removed; running card keeps state", () => {
    expect(dropCardCommands(cards, "100000000000000302", "received")).toEqual([
      ["set", "webapp", "partial", DROP_RECEIVED_NOTE],
      ["q", "webapp", "-"],
      ["action", "webapp", "-"],
      ["q", "busy", "-"],
      ["action", "busy", "-"],
    ]);
  });
  test("expired note; unrelated message clears nothing", () => {
    expect(dropCardCommands(cards, "100000000000000305", "expired")[0]).toEqual(["set", "other", "partial", DROP_EXPIRED_NOTE]);
    expect(dropCardCommands(cards, "100000000000000306", "received")).toEqual([]);
  });
});

describe("fake drop lifecycle", () => {
  const home = mkdtempSync(join(tmpdir(), "drop-"));
  test("receive records the message id; expiry fires onExpired once", () => {
    const s = new SecretDrops(home);
    const expired: Drop[] = [];
    s.onExpired = (d) => expired.push(d);
    const t = 1_000_000;
    const a = s.create({ name: "key", dest: join(home, ".config", "x", "a") }, t) as Drop;
    const b = s.create({ name: "key2", dest: join(home, ".config", "x", "b") }, t) as Drop;
    s.setMessage(a.id, "100000000000000302");
    s.setMessage(b.id, "100000000000000305");
    const r = s.receive(a.id, "secret", t + 1);
    expect("drop" in r && r.drop.messageId).toBe("100000000000000302");
    expect(s.sweep(t + 16 * 60_000).map((d) => d.messageId)).toEqual(["100000000000000305"]);
    s.sweep(t + 17 * 60_000);
    expect(expired.map((d) => d.messageId)).toEqual(["100000000000000305"]);
  });
});
