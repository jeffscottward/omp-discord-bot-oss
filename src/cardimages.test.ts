import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkRows, pngHtml, renderTables } from "./tablerender";

test("7 cards -> 3 groups (3,3,1), order kept", () => {
  const g = chunkRows([1, 2, 3, 4, 5, 6, 7]);
  expect(g.map((x) => x.length)).toEqual([3, 3, 1]);
  expect(g.flat()).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("label shown in card image", () => {
  expect(pngHtml({ header: ["a", "b"], rows: [["x", "y"]] } as any, "cards", "2/3")).toContain('class="lab">2/3<');
});

test("renderTables keeps all parts of a split table on one entry", async () => {
  const text = "| id | note |\n|---|---|\n" + Array.from({ length: 7 }, (_, i) => `| c${i} | n${i} |`).join("\n");
  const r = await renderTables(text, {
    dir: mkdtempSync(join(tmpdir(), "ci3-")),
    render: async (_t, p) => [1, 2, 3].map((i) => p.replace(/\.png$/, `-${i}.png`)),
  });
  expect(r.files.length).toBe(1);
  expect(r.files[0]!.parts?.map((f) => f.name)).toEqual(["table-1of3.png", "table-2of3.png", "table-3of3.png"]);
});

test.skipIf(!process.env.CI3_LIVE)("real chrome: 7 wide cards -> 3 images", async () => {
  const { renderPng } = await import("./tablerender");
  const long = "word ".repeat(60);
  const t = { header: ["Card", "State", "Note", "More"], align: [], rows: Array.from({ length: Number(process.env.CI3_N ?? 7) }, (_, i) => [`card-${i}`, "running", long, long]) } as any;
  const out = await renderPng(t, "/tmp/ci3/t.png");
  expect(out?.length).toBe(Math.ceil(Number(process.env.CI3_N ?? 7) / 3));
  for (const p of out!) expect(existsSync(p)).toBe(true);
}, 60000);
