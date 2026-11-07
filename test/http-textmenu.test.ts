
import { askBlockError as abe, looksLikeTextMenu } from "../src/http.ts";
import { test as tq, expect as eq } from "bun:test";
tq("numbered text menus are refused on /post (owner 2026-10-23)", () => {
  const t = "☁️ Cloudflare\n✍️ Choose one:\n1. Remove now (recommended)\n2. Wait\n✏️ Other";
  eq(looksLikeTextMenu(t)).toBe(true);
  eq(abe(t)).toContain("ask JSON block");
  eq(looksLikeTextMenu("Steps:\n1. build\n2. test")).toBe(false);
  eq(looksLikeTextMenu("x\n```ask\n{}\n```")).toBe(false);
});
