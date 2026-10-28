import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backLink, excerpt, handoffCard, handoffPrompt, sourceLogs } from "../src/handoff.ts";

test("sourceLogs: pane session first, then the newest log of each matching session dir", () => {
  const dir = mkdtempSync("/tmp/handoff-");
  for (const k of ["side-1", "1", "dm-1"]) mkdirSync(join(dir, k));
  writeFileSync(join(dir, "side-1", "old.jsonl"), "");
  utimesSync(join(dir, "side-1", "old.jsonl"), 1, 1);
  writeFileSync(join(dir, "side-1", "new.jsonl"), "");
  writeFileSync(join(dir, "1", "a.jsonl"), "");
  const pane = join(dir, "pane.jsonl");
  writeFileSync(pane, "");
  const logs = sourceLogs({ sessionsDir: dir, channelId: "1", sideKey: "side-1", paneSession: pane });
  expect(logs).toEqual([pane, join(dir, "side-1", "new.jsonl"), join(dir, "1", "a.jsonl")]);
  expect(sourceLogs({ sessionsDir: dir, channelId: "9", paneSession: "/nope.jsonl" })).toEqual([]);
});

test("excerpt drops bot status posts, keeps the last messages oldest first, redacts", () => {
  const out = excerpt([
    { author: "owner", fromBot: false, content: "first" },
    { author: "bot", fromBot: true, content: "━━━━\n⏳ **Queue**" },
    { author: "bot", fromBot: true, content: "🩺 **Check** · now" },
    { author: "bot", fromBot: true, content: "Here is the plan" },
    { author: "owner", fromBot: false, content: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please" },
  ], 3);
  expect(out.length).toBe(3);
  expect(out[0]).toBe("👤 owner: first");
  expect(out[1]).toBe("🤖 bot: Here is the plan");
  expect(out[2]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
});

test("card and prompt", () => {
  const h = { srcName: "#example-activity", srcMention: "<#1>", srcUrl: "https://discord.com/channels/g/1", logs: ["/home/u/.local/share/x/a.jsonl"], note: "continue the deploy", recent: ["👤 owner: hi"] };
  const card = handoffCard(h);
  expect(card).toContain("↪️ **Handoff from <#1>** · [open the source](https://discord.com/channels/g/1)");
  expect(card).toContain("📝 continue the deploy");
  expect(card).toContain("`~/.local/share/x/a.jsonl`");
  const p = handoffPrompt(h);
  expect(p).toContain("from #example-activity (https://discord.com/channels/g/1)");
  expect(p).toContain("Owner's note: continue the deploy");
  expect(p).toContain("never load a whole log");
  expect(p).toContain("👤 owner: hi");
  expect(p).toContain("short summary (3-5 bullets)");
  expect(handoffPrompt({ ...h, logs: [], note: null, recent: [] })).toContain("No session log was found");
  expect(backLink("<#2>", "https://x/y")).toBe("↪️ **Moved to <#2>** · [open the handoff](https://x/y)");
});

import { logExcerpt } from "../src/handoff.ts";
test("logExcerpt: the bot reads the newest log itself (sandboxed runs cannot), prompt carries it", () => {
  const dir = mkdtempSync("/tmp/handoff-x-");
  const line = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, stopReason: "stop", content: [{ type: "text", text }] } });
  const old = join(dir, "old.jsonl");
  const cur = join(dir, "cur.jsonl");
  writeFileSync(old, `${line("user", "old topic")}\n`);
  utimesSync(old, 1, 1);
  writeFileSync(cur, `${line("user", "deploy the page")}\n${line("assistant", "Deployed to staging.")}\n`);
  const t = logExcerpt([old, cur]);
  expect(t).toContain("USER: deploy the page");
  expect(t).toContain("ASSISTANT: Deployed to staging.");
  expect(t).not.toContain("old topic");
  expect(logExcerpt(["/nope.jsonl"])).toBe("");
  const p = handoffPrompt({ srcName: "#a", srcUrl: "u", logs: [cur], recent: [], transcript: t });
  expect(p).toContain("read-only excerpt");
  expect(p).toContain("A sandboxed run cannot open them");
});
