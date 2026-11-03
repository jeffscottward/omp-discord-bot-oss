import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTail } from "../src/heartbeat.ts";
import { renderProgress, renderSubagents, scanSubagents, type Progress } from "../src/mirror.ts";

describe("job subagents line", () => {
  test("renderProgress lists subagents after the model lines, running first, capped", () => {
    const subs = Array.from({ length: 7 }, (_, i) => ({ name: `Sub${i}`, done: i > 0, calls: i, lastWrite: i, ...(i === 0 ? { lastTool: "bash", running: true, model: "anthropic/claude-x" } : {}) }));
    const p: Progress = { startTs: 1e12, lastTs: 1e12, count: 2, steps: [], state: "working", model: "a/main", thinking: "low", subagents: subs };
    const lines = renderProgress("tab", p).split("\n");
    const i = lines.findIndex((l) => l.startsWith("🤝 **Subagents:** 1 running · 6 finished"));
    expect(i).toBe(3);
    expect(lines[i + 1]).toBe("  ↳ 🤖 **Sub0** (claude-x): 🔧 running `bash` · 0 calls");
    expect(lines[i + 2]).toContain("✅ finished");
    expect(lines).toContain("  ↳ +2 more subagents");
    expect(renderSubagents(undefined)).toEqual([]);
  });

  test("scanSubagents reads subagent files under the session artifact dir", () => {
    const d = mkdtempSync(join(tmpdir(), "subs-"));
    const sess = join(d, "s.jsonl");
    writeFileSync(sess, "");
    mkdirSync(join(d, "s"));
    writeFileSync(join(d, "s", "__advisor.jsonl"), "");
    const ts = new Date().toISOString();
    writeFileSync(join(d, "s", "Scout.jsonl"), JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "grep", arguments: {} }] } }) + "\n");
    const subs = scanSubagents(sess, 0, new Map<string, SessionTail>());
    expect(subs.map((x) => x.name)).toEqual(["Scout"]);
    expect(subs[0]!.done).toBe(false);
    const tails = new Map<string, SessionTail>();
    scanSubagents(sess, 0, tails);
    expect(scanSubagents(sess, Date.now() + 60_000, tails)).toEqual([]); // a later turn drops it
    expect(tails.size).toBe(0);
  });
});
