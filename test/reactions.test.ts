// Owner 2026-10-23 (Discord UX item 9): fewer reaction calls; only state changes reach Discord.
import { describe, expect, jest, test } from "bun:test";
import { StatusReactions } from "../src/reactions.ts";

const msg = (id: string) => ({ id });

function setup() {
  const log: string[] = [];
  const r = new StatusReactions<{ id: string }>(async (m, e, on) => void log.push(`${m.id} ${on ? "+" : "-"}${e}`), 1_500, new Set(["✅", "❌"]));
  return { r, log };
}

/** Let the settle timer fire and the async apply loop finish. */
async function settle(ms = 1_600) {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  jest.advanceTimersByTime(1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("StatusReactions", () => {
  test("a job that starts at once never shows ⏳: one call for ⚙️, two for ✅", async () => {
    jest.useFakeTimers();
    try {
      const { r, log } = setup();
      void r.set(msg("a"), "⏳");
      void r.set(msg("a"), "⚙️");
      await settle();
      expect(log).toEqual(["a +⚙️"]);
      void r.set(msg("a"), "✅");
      await settle();
      expect(log).toEqual(["a +⚙️", "a -⚙️", "a +✅"]);
      expect(r.calls).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
  test("a fast failure goes straight to ❌", async () => {
    jest.useFakeTimers();
    try {
      const { r, log } = setup();
      void r.set(msg("b"), "⏳");
      void r.set(msg("b"), "⚙️");
      void r.set(msg("b"), "❌");
      await settle();
      expect(log).toEqual(["b +❌"]);
    } finally {
      jest.useRealTimers();
    }
  });
  test("a waiting job shows ⏳, then swaps it; a cancel removes it", async () => {
    jest.useFakeTimers();
    try {
      const { r, log } = setup();
      void r.set(msg("c"), "⏳");
      await settle();
      void r.set(msg("c"), "⚙️");
      await settle();
      void r.set(msg("d"), "⏳");
      await settle();
      void r.set(msg("d"), null);
      await settle();
      expect(log).toEqual(["c +⏳", "c -⏳", "c +⚙️", "d +⏳", "d -⏳"]);
    } finally {
      jest.useRealTimers();
    }
  });
  test("assume() replaces a ⏳ left by an earlier process; null on an unknown message does nothing", async () => {
    jest.useFakeTimers();
    try {
      const { r, log } = setup();
      r.assume(msg("e"), "⏳");
      void r.set(msg("e"), "⚙️");
      await r.set(msg("x"), null);
      await settle();
      expect(log).toEqual(["e -⏳", "e +⚙️"]);
    } finally {
      jest.useRealTimers();
    }
  });
  test("a final state applies at once (a restart right after the run cannot leave ⚙️)", async () => {
    jest.useFakeTimers();
    try {
      const { r, log } = setup();
      void r.set(msg("g"), "⚙️");
      await settle();
      const done = r.set(msg("g"), "✅");
      await done; // no timer advance needed
      expect(log).toEqual(["g +⚙️", "g -⚙️", "g +✅"]);
    } finally {
      jest.useRealTimers();
    }
  });
  test("an apply error does not stop later changes", async () => {
    jest.useFakeTimers();
    try {
      const seen: string[] = [];
      const r = new StatusReactions<{ id: string }>(async (_m, e, on) => {
        seen.push(`${on ? "+" : "-"}${e}`);
        if (e === "⚙️" && on) throw new Error("429");
      }, 1_500);
      void r.set(msg("f"), "⚙️");
      await settle();
      void r.set(msg("f"), "✅");
      await settle();
      expect(seen).toEqual(["+⚙️", "-⚙️", "+✅"]);
    } finally {
      jest.useRealTimers();
    }
  });
});
