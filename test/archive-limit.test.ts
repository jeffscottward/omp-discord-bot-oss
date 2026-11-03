import { expect, test } from "bun:test";
import { join } from "node:path";
import { ARCHIVE_AT, mayArchive, pickToArchive } from "../src/archivelimit.ts";

// Owner rule 2026-11-01 (card discord-archive-near-limit).
const cands = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, cat: "A", oldest: i }));

test("below 40 channels: nothing is archived", () => {
  expect(ARCHIVE_AT).toBe(40);
  expect(mayArchive(39)).toBe(false);
  expect(pickToArchive(cands(10), () => 39).size).toBe(0);
  expect(pickToArchive(cands(10), () => 0).size).toBe(0);
});

test("40+ channels: oldest closed first, only until under 40", () => {
  expect([...pickToArchive(cands(10), () => 40)]).toEqual(["c0"]);
  expect([...pickToArchive([...cands(10)].reverse(), () => 43)]).toEqual(["c0", "c1", "c2", "c3"]);
  expect(pickToArchive(cands(3), () => 50).size).toBe(3); // not enough closed: take all of them
  const mixed = [...cands(3), { key: "b0", cat: "B", oldest: 0 }];
  expect([...pickToArchive(mixed, (c) => (c === "A" ? 41 : 12))].sort()).toEqual(["c0", "c1"]);
});

test("purge-archive.py uses the same rule", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const py = `
import importlib.util
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
c = [{"key": f"c{i}", "cat": "A", "oldest": i} for i in range(9, -1, -1)]
assert pa.ARCHIVE_AT == 40
assert pa.pick_to_archive(c, lambda _: 39) == set()
assert pa.pick_to_archive(c, lambda _: 42) == {"c0", "c1", "c2"}, pa.pick_to_archive(c, lambda _: 42)
print("OK")
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("OK");
});
