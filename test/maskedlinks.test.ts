import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { badMaskedLabels, fixMaskedLinks } from "../src/maskedlinks.ts";
import { splitMessage } from "../src/split.ts";

test("emoji moves out of masked-link labels", () => {
  expect(fixMaskedLinks("a · [🗃️ Card](<https://x/?a=1&b=2>) b")).toBe("a · 🗃️ [Card](<https://x/?a=1&b=2>) b");
  expect(fixMaskedLinks("[Open 🔗](https://x)")).toBe("🔗 [Open](https://x)");
  expect(fixMaskedLinks("[🧩 Card ↗](<https://x>)")).toBe("🧩 [Card ↗](<https://x>)");
  expect(fixMaskedLinks("[↗ 🧩 Card](<u>)")).toBe("🧩 [↗ Card](<u>)");
  expect(fixMaskedLinks("[a ↗](u) [©](u)")).toBe("[a ↗](u) [©](u)");
  expect(fixMaskedLinks("[📎](<https://x>)")).toBe("📎 [link](<https://x>)");
  expect(fixMaskedLinks("[plain](<https://x>) 🗂️ [Dash](<https://y>)")).toBe("[plain](<https://x>) 🗂️ [Dash](<https://y>)");
});

test("splitMessage (bot answers) applies the guard", () => {
  expect(badMaskedLabels(splitMessage("see [🧩 Card](<https://x>)").join("\n"))).toEqual([]);
});

// Lint: no hard-coded masked link in src may put an emoji in its label (owner 2026-11-07, msg 100000000000000057).
test("no source literal has an emoji inside a masked-link label", () => {
  const dir = join(import.meta.dir, "../src");
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    readFileSync(join(dir, f), "utf8").split("\n").forEach((l, i) => {
      if (l.trimStart().startsWith("*") || l.trimStart().startsWith("//")) return;
      for (const b of badMaskedLabels(l.replace(/\$\{[^}]*\}/g, "x"))) bad.push(`${f}:${i + 1} [${b}]`);
    });
  }
  expect(bad).toEqual([]);
});
