// Card test-tmp-leak (2026-11-01): Chrome wrote its own temp files (.com.google.Chrome.*, *_url_fetcher_*) to /tmp
// on every table render and never removed them. renderPng now starts Chrome with TMPDIR = its render folder,
// unless Chrome's lock socket path under it would pass the 107-byte limit.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeTmpDir } from "../src/tablerender.ts";

test("chromeTmpDir: the render folder, unless Chrome's socket path under it would pass 107 bytes", () => {
  expect(chromeTmpDir("/tmp/omp-table-AbCdEf")).toBe("/tmp/omp-table-AbCdEf");
  const max = `/${"x".repeat(107 - 46 - 1)}`; // 46 = "/.org.chromium.Chromium.XXXXXX/SingletonSocket"
  expect(chromeTmpDir(max)).toBe(max);
  expect(chromeTmpDir(`${max}y`)).toBeNull();
  expect(chromeTmpDir(`/${"é".repeat(31)}`)).toBeNull(); // bytes, not characters: 63 bytes
});

test("renderPng starts Chrome with TMPDIR inside its render folder (when short enough), and the folder is removed", () => {
  const base = mkdtempSync(join(tmpdir(), "t-")); // short: the render folder should stay under the socket limit
  try {
    const out = join(base, "tmpdirs.txt");
    const fake = join(base, "fake-chrome");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$TMPDIR" >> "${out}"\nexit 3\n`);
    chmodSync(fake, 0o755);
    // A child process: CHROME is read when src/tablerender.ts loads, and other test files may load it first.
    const js = `import { renderPng } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tablerender.ts"))};
await renderPng({ start: 0, end: 3, header: ["a"], align: [""], rows: [["1"]] }, ${JSON.stringify(join(base, "t.png"))}).then(() => console.log("rendered"), (e) => console.log(String(e)));`;
    const r = Bun.spawnSync(["bun", "-e", js], { env: { ...process.env, TMPDIR: base, OMP_TABLES_CHROME: fake } });
    expect(r.stdout.toString()).toContain("chrome measure failed (exit 3)");
    const seen = readFileSync(out, "utf8").trim().split("\n");
    expect(seen.length).toBe(1);
    // A long system TMPDIR makes the render folder too deep for Chrome's socket: Chrome then keeps the inherited TMPDIR.
    if (chromeTmpDir(join(base, "omp-table-XXXXXX"))) {
      expect(seen[0]!.startsWith(join(base, "omp-table-"))).toBe(true);
      expect(existsSync(seen[0]!)).toBe(false);
    } else expect(seen[0]).toBe(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
