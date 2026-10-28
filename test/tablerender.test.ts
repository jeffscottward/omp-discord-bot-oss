import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellHtml, findTables, PNG_CARD_W, pngHtml, pruneTables, renderPng, renderTables, splitRow, tableLineCount, type Table } from "../src/tablerender.ts";

const T = "| Name | Qty |\n|---|---:|\n| a | 1 |\n| b | 2 |";

describe("table detection (card discord-table-render)", () => {
  test("finds a plain table with alignment and rows", () => {
    const [t] = findTables(`Intro\n\n${T}\n\nAfter`);
    expect(t).toMatchObject({ start: 2, end: 6, header: ["Name", "Qty"], align: ["", "right"], rows: [["a", "1"], ["b", "2"]] });
    expect(t!.fenceOpen).toBeUndefined();
  });
  test("finds a table inside a bare or language fence", () => {
    expect(findTables("```\n" + T + "\n```")[0]).toMatchObject({ fenceOpen: 0, start: 1, end: 5 });
    expect(findTables("~~~md\n" + T + "\n~~~")).toHaveLength(1);
  });
  test("skips paste blocks and unclosed fences", () => {
    expect(findTables("```text\n" + T + "\n```")).toHaveLength(0);
    expect(findTables("```\n" + T)).toHaveLength(0);
  });
  test("pipes inside inline code and escaped pipes do not split cells", () => {
    expect(splitRow("| `a|b` | c \\| d | e |")).toEqual(["`a|b`", "c | d", "e"]);
    const [t] = findTables("| cmd | note |\n|--|--|\n| `x || y` | ok |");
    expect(t!.rows).toEqual([["`x || y`", "ok"]]);
  });
  test("no false positives on single pipe lines", () => {
    expect(findTables("a | b\nsome text")).toHaveLength(0);
    expect(findTables("a | b\n---\nmore")).toHaveLength(0); // setext heading / rule, not a table
    expect(findTables("Use `a | b` here.\n| alone |")).toHaveLength(0);
    expect(findTables("| x |\n|---|\n| 1 |")).toHaveLength(0); // one column: not worth an image
    expect(findTables("a | b\n--|-x")).toHaveLength(0);
  });
  test("separator column count must match the header", () => {
    expect(findTables("| a | b | c |\n|---|---|\n| 1 | 2 | 3 |")).toHaveLength(0);
  });
  test("table without outer pipes and short rows are padded", () => {
    const [t] = findTables("a | b\n--|--\n1 |");
    expect(t!.rows).toEqual([["1", ""]]);
  });
  test("a blank line ends the table body", () => {
    const [t] = findTables(`${T}\n\n| x | y |`);
    expect(t!.rows).toHaveLength(2);
  });
});

describe("renderTables replacement", () => {
  const fake = async (_t: Table, png: string) => Bun.write(png, Buffer.alloc(200, 1)).then(() => {});
  const opts = () => ({ dir: mkdtempSync(join(tmpdir(), "tbl-")), baseUrl: "https://h/reports/tables", render: fake });

  test("replaces the table with a link line, writes the page, keeps other text", async () => {
    const o = opts();
    const r = await renderTables(`Before\n\n${T}\n\nAfter`, o);
    expect(r.text).toMatch(/^Before\n\n📊 Table: \[full table, 2 rows ↗\]\(<https:\/\/h\/reports\/tables\/[\w-]+\/>\)\n\nAfter$/);
    expect(r.files).toHaveLength(1);
    const id = r.text.match(/tables\/([\w-]+)\//)![1]!;
    const page = readFileSync(join(o.dir, id, "index.html"), "utf8");
    expect(page).toContain('id="q"');
    expect(page).toContain("position:sticky");
    expect(tableLineCount(r.text)).toBe(1);
  });
  test("a table inside a fence splits the fence; code around it stays fenced", async () => {
    const r = await renderTables("```\nbefore\n" + T + "\nafter\n```", opts());
    const lines = r.text.split("\n");
    expect(lines.slice(0, 3)).toEqual(["```", "before", "```"]);
    expect(lines[3]).toStartWith("📊 Table:");
    expect(lines.slice(4)).toEqual(["```", "after", "```"]);
  });
  test("a fence holding only a table becomes just the link line", async () => {
    const r = await renderTables("x\n```\n" + T + "\n```\ny", opts());
    expect(r.text.split("\n")).toHaveLength(3);
  });
  test("render failure keeps the original table text and logs", async () => {
    const logs: string[] = [];
    const text = `A\n${T}\nB`;
    const r = await renderTables(text, { ...opts(), render: async () => { throw new Error("boom"); }, log: (s) => logs.push(s) });
    expect(r.text).toBe(text);
    expect(r.files).toHaveLength(0);
    expect(logs[0]).toContain("boom");
  });
  test("a renderer that never finishes hits the deadline; the text is kept and the call returns", async () => {
    const logs: string[] = [];
    const text = `A\n${T}\nB\n\n${T}`;
    const t0 = Date.now();
    const r = await renderTables(text, { ...opts(), render: () => new Promise<void>(() => {}), deadlineMs: 150, log: (s) => logs.push(s) });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.text).toBe(text);
    expect(r.files).toHaveLength(0);
    expect(logs.every((l) => l.includes("deadline"))).toBe(true);
    expect(logs).toHaveLength(2);
  });
  test("account numbers: image only, no web page", async () => {
    const o = opts();
    const r = await renderTables(`Account U1234567\n${T}`, o);
    expect(r.text).toContain("no web page");
    expect(r.text).not.toContain("https://");
    expect(r.files).toHaveLength(1);
  });
  test("secrets in cells are redacted before the page is written", async () => {
    const o = opts();
    const tok = "ghp_" + "a".repeat(36);
    const r = await renderTables(`| k | v |\n|---|---|\n| t | ${tok} |`, o);
    const id = r.text.match(/tables\/([\w-]+)\//)![1]!;
    expect(readFileSync(join(o.dir, id, "index.html"), "utf8")).not.toContain(tok);
  });
  test("OMP_TABLES_RENDER=0 turns it off", async () => {
    process.env.OMP_TABLES_RENDER = "0";
    try {
      expect((await renderTables(T, opts())).text).toBe(T);
    } finally {
      delete process.env.OMP_TABLES_RENDER;
    }
  });
  test("prune deletes folders older than 30 days only", () => {
    const dir = mkdtempSync(join(tmpdir(), "tbl-"));
    mkdirSync(join(dir, "old"));
    mkdirSync(join(dir, "new"));
    const past = (Date.now() - 31 * 86400_000) / 1000;
    utimesSync(join(dir, "old"), past, past);
    expect(pruneTables(dir)).toBe(1);
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(existsSync(join(dir, "new"))).toBe(true);
  });
  test("cell HTML escapes markup and renders code, bold and links", () => {
    expect(cellHtml("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(cellHtml("**hi** `a<b` [d](https://e.com/x)")).toBe('<b>hi</b> <code>a&lt;b</code> <a href="https://e.com/x">d</a>');
  });
});

describe("renderPng (real headless Chrome)", () => {
  test("produces a PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tbl-png-"));
    const png = join(dir, "t.png");
    const [t] = findTables(
      "| Item | Size | Date | Ratio | Cost | Note |\n|---|--:|---|--:|--:|---|\n" +
        Array.from({ length: 8 }, (_, i) => `| item${i} | ${500 + i * 5} | 2026-12-18 | 0.${30 + i} | $${(4.1 + i).toFixed(2)} | row ${i + 1} with a longer note that should wrap inside its cell ✅ |`).join("\n"),
    );
    await renderPng(t!, png);
    const head = readFileSync(png).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Wide table -> phone cards: 390 CSS px at scale 3 = 1170 px wide, taller than wide (owner 2026-10-21).
    expect(head.length).toBe(8);
    const ihdr = readFileSync(png).subarray(16, 24);
    const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
    expect(w).toBe(PNG_CARD_W * 3);
    expect(h).toBeGreaterThan(w);
    console.log(`png: ${png}`);
  }, 30_000);

  test("a narrow table stays a grid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tbl-png-"));
    const png = join(dir, "t.png");
    const [t] = findTables(T);
    await renderPng(t!, png);
    const w = readFileSync(png).subarray(16, 20).readUInt32BE(0);
    expect(w).toBeLessThan(PNG_CARD_W * 3);
  }, 30_000);
});

describe("pngHtml cards", () => {
  test("one card per row, first cell as title, Header: value lines, empty cells skipped", () => {
    const [t] = findTables("| Option | Why | Remote |\n|---|---|---|\n| Server A | Fast | SSH |\n| Pi 5 | Open |  |");
    const h = pngHtml(t!, "cards");
    expect(h.match(/class="card"/g)?.length).toBe(2);
    expect(h).toContain('<div class="t">Server A</div>');
    expect(h).toContain('<span class="k">Why</span> <span class="v">Fast</span>');
    expect(h.match(/class="k">Remote</g)?.length).toBe(1);
  });
});
