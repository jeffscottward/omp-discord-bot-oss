import { describe, expect, test } from "bun:test";
import { prepareCopy } from "../src/outbound.ts";

describe("prepareCopy (owner 2026-10-19 copy-ready messages)", () => {
  test("keeps URLs exactly as written (no [host ↗](<url>) rewrite)", () => {
    const t = "/watch url:https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4";
    expect(prepareCopy(t)).toEqual({ content: t, hits: {} });
  });
  test("still redacts secrets", () => {
    const r = prepareCopy("token ghp_" + "a".repeat(36));
    expect("content" in r && r.content.includes("a".repeat(36))).toBe(false);
  });
  test("rejects empty or too-long text", () => {
    expect(prepareCopy("   ")).toHaveProperty("error");
    expect(prepareCopy("x".repeat(2001))).toHaveProperty("error");
  });
});
