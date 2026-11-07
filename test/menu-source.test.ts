// Owner 2026-10-23: a menu replies to the owner's request, and the needs-you board links that request.
import { expect, test } from "bun:test";
import { AskStore } from "../src/ask.ts";
import { openMenus, renderNeedsYou, type ChanInfo } from "../src/needsyou.ts";

test("a set remembers the request it answers, also after it expires", () => {
  const t0 = Date.now();
  const s = new AskStore(undefined, t0);
  const set = s.create("1", [{ id: "x", question: "How should your friend get it?", options: ["Zip", "Repo"], multi: false }], t0, "777");
  expect(set.sourceId).toBe("777");
  expect(s.openSets()[0]!.sourceId).toBe("777");
  s.close([set.setId], "closed", t0);
  expect(s.closedSet(set.setId)!.sourceId).toBe("777");
});

test("needs-you menu rows link the source request", () => {
  const chans = new Map<string, ChanInfo>([["1", { name: "👷‍♂️-firstmate", archived: false, finance: false }]]);
  const sets = [
    { setId: "a", channelId: "1", questions: [{ id: "x", question: "Bot handoff kit: how should your friend get it?" }], createdAt: 1000, messageIds: { "0": "11" }, sourceId: "10" },
    { setId: "b", channelId: "1", questions: [{ id: "y", question: "No source" }], createdAt: 900, messageIds: { "0": "12" } },
  ];
  const rows = openMenus(sets, [], chans, "9");
  expect(rows[0]!.source).toBe("https://discord.com/channels/9/1/10");
  expect(rows[1]!.source).toBeUndefined();
  const text = renderNeedsYou([], 10_000, "", 1900, rows);
  expect(text).toContain("↩️ [request](<https://discord.com/channels/9/1/10>)");
  expect(text.split("\n").find((l) => l.includes("No source"))).not.toContain("request");
});
