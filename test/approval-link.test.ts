// Owner 2026-10-23: a menu that asks the owner to tap Approve links to the message with the button.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalLinks, Approvals, postRetryDelayMs } from "../src/approvals.ts";
import { cancelEntry, createEntry, writePosted } from "../gate/queue.ts";
import { prepareOutbound } from "../src/outbound.ts";

const URL = "https://discord.com/channels/100000000000000025/100000000000000041/100000000000000042";

describe("approvalLinks", () => {
  const posted = [{ id: "vtinc8ie", hash: "h", url: URL }, { id: "dcyh7uab", hash: "h" }];
  test("links a named, pending approval that has a button URL", () => {
    expect(approvalLinks("Apply the fix (approval vtinc8ie)?", posted, () => true)).toEqual([{ id: "vtinc8ie", url: URL }]);
  });
  test("finds an id after a long word or in backticks, but not inside a longer token", () => {
    expect(approvalLinks("approvals:vtinc8ie", posted, () => true)).toHaveLength(1);
    expect(approvalLinks("abcdefghijk `vtinc8ie`", posted, () => true)).toHaveLength(1);
    expect(approvalLinks("xvtinc8iex", posted, () => true)).toEqual([]);
  });
  test("skips ids that are not named, not pending, or have no URL", () => {
    expect(approvalLinks("Apply the fix?", posted, () => true)).toEqual([]);
    expect(approvalLinks("Approve vtinc8ie", posted, () => false)).toEqual([]);
    expect(approvalLinks("Approve dcyh7uab", posted, () => true)).toEqual([]);
  });
});

describe("Approvals.pendingLinks", () => {
  test("uses the stored button URL while the entry is pending, not after it closes", () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-link-"));
    try {
      const e = createEntry(dir, { command: "true", cwd: "/tmp", reason: "r", channelId: "c", sessionKey: "s", runId: "r" });
      writePosted(dir, { id: e.id, hash: "h", url: URL });
      const mgr = new Approvals({ queueDir: dir, log: () => {}, send: async () => {}, privateChannel: async () => null, herdr: () => ({ code: 1, out: "" }) });
      expect(mgr.pendingLinks(`Approve ${e.id} (tap its Approve button)`)).toEqual([{ id: e.id, url: URL }]);
      cancelEntry(dir, e.id, "expired", "test");
      expect(mgr.pendingLinks(`Approve ${e.id}`)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the outbound filter keeps the Discord message link intact", () => {
  const line = `🔐 Approve button for \`vtinc8ie\`: ${URL}`;
  expect(prepareOutbound(line).messages.map((m) => m.content).join("\n")).toContain(URL);
});

test("a failed first post is retried by the next tick (the request is not left known and unseen)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-post-"));
  try {
    const e = createEntry(dir, { command: "true", cwd: "/tmp", reason: "r", channelId: "c", sessionKey: "s", runId: "r" });
    let fail = true;
    let sent = 0;
    const out = async () => {
      if (fail) throw new Error("discord down");
      sent++;
      return undefined;
    };
    let clock = 1_000_000;
    const logs: string[] = [];
    const mgr = new Approvals({ queueDir: dir, log: (...a) => logs.push(a.join(" ")), send: out as never, sendApproval: out as never, privateChannel: async () => ({}) as never, herdr: () => ({ code: 1, out: "" }), now: () => clock });
    await mgr.tick(); // a failed post does not throw out of tick (later entries and receipts still run)
    expect(sent).toBe(0);
    expect(logs.some((l) => l.includes("post failed (try 1), next try in 10 s"))).toBe(true);
    expect(new Approvals({ queueDir: dir, log: () => {}, send: async () => {}, privateChannel: async () => null }).pendingLinks(e.id)).toEqual([]);
    fail = false;
    await mgr.tick(); // inside the backoff window: no retry yet
    expect(sent).toBe(0);
    clock += postRetryDelayMs(1);
    await mgr.tick();
    expect(sent).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
