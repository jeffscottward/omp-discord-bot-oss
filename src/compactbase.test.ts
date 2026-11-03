import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineLine, baselines, newBaselines } from "./compactbase.ts";

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

test("posts a new compaction once; first run seeds without posting", () => {
  const st = join(mkdtempSync(join(tmpdir(), "cb-")), "s.json");
  const four = fixture.split("\n").slice(0, 20).join("\n");
  expect(newBaselines(four, st)).toEqual([]);
  const fresh = newBaselines(fixture, st);
  expect(fresh.map((b) => baselineLine(b))).toEqual(["🧠 FIRSTMATE compacted: baseline 78k (8% of 1M) — fixed 27k + summary 51k; before compaction 847k"]);
  expect(newBaselines(fixture, st)).toEqual([]);
});

test("compaction without a following call waits", () => {
  expect(baselines([use(1, 800_000, 0), comp("x", 800_001)].join("\n"))).toEqual([]);
});
