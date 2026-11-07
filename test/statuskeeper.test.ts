import { describe, expect, test, vi } from "bun:test";
import { applyEvent, renderProgress, type Progress } from "../src/mirror.ts";
import { type CardMsg, isStatusCard, moveCard, StatusKeeper } from "../src/statuskeeper.ts";

describe("job-status-last", () => {
  test("second turn reuses the card", () => {
    const done: Progress = { startTs: 1, lastTs: 2, count: 3, steps: [], state: "done", msgId: "m1" };
    const r = applyEvent(done, { kind: "turn", ts: 10, text: "next" } as never);
    expect(r.p?.msgId).toBe("m1");
    expect(r.p?.state).toBe("working");
    const t = applyEvent(done, { kind: "step", ts: 10, label: "bash", callId: "c" } as never);
    expect(t.p?.msgId).toBe("m1");
  });

  test("a turn without tool steps keeps the reused card quiet", () => {
    const w: Progress = { startTs: 1, lastTs: 2, count: 0, steps: [], state: "working", msgId: "m1" };
    const r = applyEvent(w, { kind: "reply", ts: 5, text: "hi" } as never);
    expect(r.urgent).toBe(false);
    expect(r.p?.state).toBe("done");
    expect(r.p?.msgId).toBe("m1");
  });

  test("detects status card text", () => {
    const p: Progress = { startTs: 1000, lastTs: 2000, count: 2, steps: [], state: "done" };
    expect(isStatusCard(renderProgress("tab", p))).toBe(true);
    expect(isStatusCard(renderProgress("tab", { ...p, state: "working" }))).toBe(true);
    expect(isStatusCard(renderProgress("tab", { ...p, state: "stopped", reason: "x" }))).toBe(true);
    expect(isStatusCard("🖥️ **tab** · terminal reply\nhi")).toBe(false);
  });

  test("burst -> one move after the quiet window; own card posts do not move", async () => {
    vi.useFakeTimers();
    try {
      const moves: string[] = [];
      const k = new StatusKeeper({ move: async (c) => void moves.push(c), log: () => {}, now: () => Date.now() });
      const card = renderProgress("tab", { startTs: 1, lastTs: 2, count: 1, steps: [], state: "done" });
      k.onMessage("c1", card, true);
      vi.advanceTimersByTime(60_000);
      expect(moves).toEqual([]);
      k.onMessage("c1", "reply 1", true);
      vi.advanceTimersByTime(5_000);
      k.onMessage("c1", "owner", false);
      vi.advanceTimersByTime(5_000);
      k.onMessage("c1", "reply 2", true);
      vi.advanceTimersByTime(7_000);
      expect(moves).toEqual([]);
      vi.advanceTimersByTime(2_000);
      await k.idle("c1");
      expect(moves).toEqual(["c1"]);
      vi.advanceTimersByTime(60_000);
      expect(moves).toEqual(["c1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("lock serializes status writes and moves per channel", async () => {
    const k = new StatusKeeper({ move: async () => {}, log: () => {} });
    const order: string[] = [];
    const a = k.lock("c", async () => {
      await Promise.resolve();
      order.push("a");
    });
    const b = k.lock("c", async () => void order.push("b"));
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    await expect(k.lock("c", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await k.lock("c", async () => 7)).toBe(7); // a failed write does not block later ones
  });

  test("moveCard: finds a card older than 50 messages, deletes stray cards, skips when last", async () => {
    const deleted: string[] = [];
    const sent: object[] = [];
    const msg = (id: string, content: string, author = "bot"): CardMsg => ({ id, content, author: { id: author }, components: [], delete: async () => void deleted.push(id) });
    const card = renderProgress("t", { startTs: 1, lastTs: 2, count: 1, steps: [], state: "done" });
    const old = msg("5", card);
    const recent = new Map<string, CardMsg>([["100", msg("100", "reply")], ["90", msg("90", card)], ["80", msg("80", "owner", "o")]]);
    const ch = { messages: { fetch: async (q: unknown) => (typeof q === "string" ? old : recent) }, send: async (o: object) => (sent.push(o), { id: "101" }) } as never;
    expect(await moveCard(ch, "bot", "5", (m) => m as CardMsg, { flags: 4096 })).toBe("101");
    expect(deleted).toEqual(["90", "5"]);
    expect(sent[0]).toMatchObject({ content: card, flags: 4096 });
    const last = new Map<string, CardMsg>([["101", msg("101", card)]]);
    const ch2 = { messages: { fetch: async () => last }, send: async () => ({ id: "x" }) } as never;
    expect(await moveCard(ch2, "bot", "101", (m) => m as CardMsg, {})).toBeUndefined();
    expect(await moveCard(ch2, "bot", undefined, (m) => m as CardMsg, {})).toBeUndefined();
  });
});
