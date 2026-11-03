import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaselineWatch, baselineLine, baselines } from "./compactbase.ts";

const use = (input: number, cacheRead: number, cacheWrite: number) => JSON.stringify({ type: "message", message: { role: "assistant", model: "claude-opus-5-5", usage: { input, output: 300, cacheRead, cacheWrite } } });
const comp = (id: string, before: number) => JSON.stringify({ type: "compaction", id, timestamp: "2026-11-03T09:56:11.950Z", summary: "s", tokensBefore: before });
// Verified FIRSTMATE values (10-23 .. 11-03): after = 99k, 97k, 101k, 59k, 78k; before 835k .. 847k.
const real: [string, number, [number, number, number]][] = [
  ["6aa301a6", 834_986, [4, 14_805, 84_157]],
  ["bf99eae7", 842_965, [2, 14_864, 81_993]],
  ["00effa72", 851_104, [2, 14_864, 86_540]],
  ["e05cc84a", 851_748, [2, 14_864, 44_594]],
  ["63cb2865", 847_237, [4, 26_973, 50_565]],
];
const fixture = real.flatMap(([id, before, u]) => [use(2, before - 2000, 2000), comp(id, before), JSON.stringify({ type: "message", message: { role: "user" } }), use(...u), use(1, 120_000, 500)]).join("\n") + "\n";

test("baseline line for each compaction", () => {
  const b = baselines(fixture);
  expect(b.map((x) => Math.round(x.total / 1000))).toEqual([99, 97, 101, 59, 78]);
  expect(baselineLine(b[4]!)).toBe("🧠 FIRSTMATE compacted: baseline 78k (8% of 1M) — fixed 27k + summary 51k; before compaction 847k");
});

test("tail watch: seeds, posts a new compaction once, retries until done", () => {
  const d = mkdtempSync(join(tmpdir(), "cb-"));
  const st = join(d, "s.json");
  const f = join(d, "f.jsonl");
  const lines = fixture.split("\n");
  writeFileSync(f, lines.slice(0, 22).join("\n") + "\n"); // 4 done + the 5th compaction without its call
  expect(new BaselineWatch(st).poll(f)).toEqual([]);
  appendFileSync(f, lines.slice(22).join("\n"));
  const w = new BaselineWatch(st); // restart keeps the offset and seen ids
  const a = w.poll(f);
  expect(a.map((b) => baselineLine(b))).toEqual(["🧠 FIRSTMATE compacted: baseline 78k (8% of 1M) — fixed 27k + summary 51k; before compaction 847k"]);
  expect(w.poll(f).length).toBe(1); // not posted yet: still offered
  expect(new BaselineWatch(st).poll(f).length).toBe(1); // and after a restart
  w.done(a[0]!.id);
  expect(w.poll(f)).toEqual([]);
  appendFileSync(f, lines.slice(0, 3).join("\n") + "\n"); // same id again later: not posted twice
  expect(new BaselineWatch(st).poll(f)).toEqual([]);
});

test("compaction without a following call waits", () => {
  expect(baselines([use(1, 800_000, 0), comp("x", 800_001)].join("\n"))).toEqual([]);
});
