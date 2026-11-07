import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { shortenLinks } from "../src/links.ts";
import { setMentionCheck } from "../src/mention.ts";

const G = "100000000000000054";
test("channel link becomes mention", () => {
  expect(shortenLinks(`see https://discord.com/channels/${G}/123456789012345678 now`)).toBe("see <#123456789012345678> now");
});
test("message link becomes mention + message jump", () => {
  const u = `https://discord.com/channels/${G}/123456789012345678/223456789012345678`;
  expect(shortenLinks(`x ${u}`)).toBe(`x <#123456789012345678> ([message ↗](<${u}>))`);
  expect(shortenLinks(`[${u}](<${u}>)`)).toBe(`<#123456789012345678> ([message ↗](<${u}>))`);
});
test("other links unchanged", () => {
  expect(shortenLinks("https://x.com/a")).toBe("[x.com/a ↗](<https://x.com/a>)");
});
test("lint: no source hard-codes a bare discord.com link label", () => {
  for (const dir of ["src", "scripts"]) for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (!/\.(ts|mjs|js)$/.test(f)) continue;
    const s = readFileSync(`${dir}/${f}`, "utf8");
    expect(`${dir}/${f}: ${/\[discord(app)?\.com[^\]]*↗\]/.test(s)}`).toBe(`${dir}/${f}: false`);
  }
});
test("closed channel keeps a labelled link, never #unknown", () => {
  setMentionCheck(() => false);
  const u = `https://discord.com/channels/${G}/123456789012345678`;
  expect(shortenLinks(u)).toBe(`[closed channel ↗](<${u}>)`);
  setMentionCheck(null);
});
