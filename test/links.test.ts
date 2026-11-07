import { expect, test } from "bun:test";
import { shortenLinks } from "../src/links.ts";

test("long URLs become short masked links; code is untouched", () => {
  const out = shortenLinks("a https://cdn.discordapp.com/x/y/IMG.png?ex=1&hm=2 b\n[https://x.com/u/status/123456789012](https://x.com/u/status/123456789012)\n`https://k.io/i`\n```\nhttps://k.io/f\n```");
  expect(out).toContain("[cdn.discordapp.com/IMG.png ↗](<https://cdn.discordapp.com/x/y/IMG.png?ex=1&hm=2>)");
  expect(out).toContain("[x.com ↗](<https://x.com/u/status/123456789012>)");
  expect(out).toContain("`https://k.io/i`");
  expect(out).toContain("```\nhttps://k.io/f\n```");
});

test("queue-row link labels contain no URL or domain-like word (Discord would show raw markdown and open the domain)", async () => {
  const { maskedLabelText } = await import("../src/links.ts");
  const domainish = /\b[\w-]+\.[\w-]{2,}\b/;
  const t = maskedLabelText("https://github.com/waveformeng/off-book back to the off book…");
  expect(t).toBe("🌐 Github link back to the off book…");
  expect(maskedLabelText("see https://www.instagram.com/example_user?obrf=MXN4 now")).toBe("see 🌐 Instagram link now");
  // Owner 2026-10-16: a 60-char preview cuts the URL mid-way and ends in "…".
  const cut = maskedLabelText("https://www.instagram.com/example.page?vrfl=MWYzYzE0bDI3czFrM…");
  expect(cut).toBe("🌐 Instagram link");
  expect(maskedLabelText("cut https://exa…")).not.toContain("http");
  expect(maskedLabelText("check go.fixnotes and topic-map.md please")).toBe("check go·fixnotes and topic-map·md please");
  for (const s of [t, cut, maskedLabelText("open example.org/x then v1.2")]) expect(s).not.toMatch(domainish);
  expect(maskedLabelText("a [b] c")).toBe("a b c");
  expect(maskedLabelText("plain words. Next sentence")).toBe("plain words. Next sentence");
});

test("no double arrow when the text already has ↗ after a link (owner 2026-10-22)", () => {
  const out = shortenLinks("Report: https://main-host.example.net/reports/discord-ux-review/ ↗ (PDF attached)");
  expect(out).toBe("Report: [main-host.example.net/discord-ux-review ↗](<https://main-host.example.net/reports/discord-ux-review/>) (PDF attached)");
  expect(shortenLinks("[x.com ↗](<https://x.com>)↗ ok")).toBe("[x.com ↗](<https://x.com>) ok");
  expect(shortenLinks("[Card: a ↗](<https://x.com/a>)")).toBe("[Card: a ↗](<https://x.com/a>)");
});
