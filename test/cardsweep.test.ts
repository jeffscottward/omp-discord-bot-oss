import { describe, expect, test } from "bun:test";
import { askSetId, discordLink, menuQuestion, staleCards, staleMenus } from "../src/cardsweep.ts";

const H = 3_600_000;
describe("card sweep: question menus (owner 2026-10-22)", () => {
  test("parses question and set id", () => {
    expect(menuQuestion("❓ **Question 1 of 3**\nDo the board know?\n\n1️⃣ Yes")).toBe("do the board know?");
    expect(menuQuestion("❓ Keep the card?\n\n1️⃣ Keep")).toBe("keep the card?");
    expect(askSetId("ask:mvjmbrp01:0:0")).toBe("mvjmbrp01");
    expect(askSetId("stop:593")).toBeNull();
  });
  test("closes lost duplicates and expired menus; never open sets", () => {
    const now = 100 * H;
    const msgs = [
      { id: "old-dup", ts: now - 1 * H, setId: "a", question: "q1" },
      { id: "newer", ts: now - 0.5 * H, setId: "b", question: "q1" },
      { id: "expired", ts: now - 30 * H, setId: "c", question: "q2" },
      { id: "recent-lost", ts: now - 2 * H, setId: "d", question: "q3" },
      { id: "open-old", ts: now - 30 * H, setId: "e", question: "q4" },
    ];
    expect(staleMenus(msgs, new Set(["b", "e"]), now, 24 * H).sort()).toEqual(["expired", "old-dup"]);
  });
  test("two unreadable menus (empty question) are not duplicates of each other", () => {
    const now = 100 * H;
    const msgs = [
      { id: "m1", ts: now - 2 * H, setId: "a", question: "" },
      { id: "m2", ts: now - 1 * H, setId: "b", question: "" },
    ];
    expect(staleMenus(msgs, new Set(), now, 24 * H)).toEqual([]);
  });
});

describe("card sweep: dashboard cards", () => {
  const chan = (id: string) => (id === "9" ? "archived" : id === "8" ? "gone" : "live") as "live" | "archived" | "gone";
  const url = (c: string, m?: string) => `https://discord.com/channels/1/${c}${m ? `/${m}` : ""}`;
  test("links", () => expect(discordLink(url("5", "6"))).toEqual({ channel: "5", message: "6" }));
  test("flags cards on archived/gone channels or closed menus; skips finance, done, parked, already flagged", () => {
    const cards = [
      { id: "a", s: "waiting", src: url("9") },
      { id: "b", s: "partial", q: url("8", "1") },
      { id: "c", s: "open", q: url("5", "77") },
      { id: "d", s: "done", src: url("9") },
      { id: "e", s: "backlog", src: url("9") },
      { id: "f", s: "waiting", area: "finance", src: url("9") },
      { id: "g", s: "waiting", t: "account auth", src: url("9") },
      { id: "h", s: "waiting", n: "🧹 Card sweep: x", src: url("9") },
      { id: "i", s: "waiting", src: url("5") },
    ];
    expect(staleCards(cards, chan, new Set(["77"])).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
