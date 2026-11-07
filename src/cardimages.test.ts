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

test("more than 30 cards still get images (follow-up message past 10 images)", async () => {
  const { PNG_MAX_CARDS } = await import("./tablerender");
  expect(chunkRows(Array.from({ length: PNG_MAX_CARDS }, (_, i) => i)).length).toBeGreaterThan(10);
});

test("20 images with audio: 9 on the answer (audio keeps its slot), 11 go to follow-up messages (10 + 1)", async () => {
  const { splitImages } = await import("./tablerender");
  const imgs = Array.from({ length: 20 }, (_, i) => i + 1);
  const r = splitImages(imgs, 0, 1);
  expect(r.here).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(r.overflow[0]).toBe(10);
  expect(r.overflow.length).toBe(11);
  expect(splitImages(imgs, 0, 0).here.length).toBe(10);
  expect(splitImages([1, 2], 9, 3)).toEqual({ here: [], overflow: [1, 2] });
});
