import { describe, expect, test } from "bun:test";
import { voiceHeaderParts } from "./voicehead.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ").slice(0, n);

describe("voiceHeaderParts", () => {
  test("short transcript stays one message", () => {
    expect(voiceHeaderParts("Owner", "hello there")).toEqual(["🎙️ from **Owner**: *hello there*"]);
  });
  for (const len of [2073, 6000]) {
    test(`${len}-char transcript splits into <=2000-char parts without losing words`, () => {
      const text = words(len);
      const parts = voiceHeaderParts("Owner", text);
      expect(parts.length).toBeGreaterThan(1);
      for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
      expect(parts[0]!.startsWith("🎙️ from **Owner**: *")).toBe(true);
      const joined = parts.map((p) => p.replace(/^🎙️ from \*\*Owner\*\*: /, "").replace(/ \(\d+\/\d+\)$/, "").replace(/^\*|\*$/g, "")).join(" ");
      expect(joined.split(/\s+/)).toEqual(text.trim().split(/\s+/));
    });
  }
  test("one huge word is hard-cut", () => {
    const parts = voiceHeaderParts("J", "x".repeat(4500));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
    expect(parts.join("").replace(/[^x]/g, "").length).toBe(4500);
  });
});

import { postVoiceHeader } from "./voicehead.ts";

describe("postVoiceHeader", () => {
  test("send failure: no throw, one notice, null (caller keeps the run text)", async () => {
    const notices: string[] = [];
    const logs: string[] = [];
    const r = await postVoiceHeader(voiceHeaderParts("J", "a ".repeat(3000)), {
      first: async () => {
        throw new Error("Invalid Form Body BASE_TYPE_MAX_LENGTH");
      },
      rest: async () => {},
      notice: async (c) => void notices.push(c),
      log: (l) => void logs.push(l),
    });
    expect(r).toBeNull();
    expect(notices.length).toBe(1);
    expect(logs[0]).toContain("BASE_TYPE_MAX_LENGTH");
  });
  test("notice failure is swallowed too", async () => {
    const r = await postVoiceHeader(["x"], { first: async () => Promise.reject(new Error("a")), rest: async () => {}, notice: async () => Promise.reject(new Error("b")), log: () => {} });
    expect(r).toBeNull();
  });
  test("success posts every part in order", async () => {
    const sent: string[] = [];
    const r = await postVoiceHeader(["p1", "p2", "p3"], { first: async (c) => (sent.push(c), "M"), rest: async (c) => void sent.push(c), notice: async () => {}, log: () => {} });
    expect(r).toBe("M");
    expect(sent).toEqual(["p1", "p2", "p3"]);
  });
});
