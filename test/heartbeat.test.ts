import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpuPercent, formatHeartbeat, HUNG_MS, RunHeartbeat, sampleTree, SessionTail, verdict, type HeartbeatView, type TreeSample } from "../src/heartbeat.ts";

const T0 = Date.parse("2026-10-15T17:00:00Z");
const entry = (ts: number, message: object) => JSON.stringify({ type: "message", timestamp: new Date(ts).toISOString(), message }) + "\n";
const call = (ts: number, id: string, name: string, intent: string) => entry(ts, { role: "assistant", content: [{ type: "thinking" }, { type: "toolCall", id, name, intent, arguments: { command: "secret-arg" } }] });
const result = (ts: number, id: string) => entry(ts, { role: "toolResult", toolCallId: id, content: [] });
const exit = (ts: number) => JSON.stringify({ type: "custom", customType: "session_exit", timestamp: new Date(ts).toISOString() }) + "\n";
const tree = (ticks: [number, number][] = []): TreeSample => ({ alive: true, procs: ticks.length || 3, ticks: new Map(ticks), ioBytes: 0 });
const view = (o: Partial<HeartbeatView>): HeartbeatView => ({
  now: T0 + 120_000,
  startedAt: T0,
  tree: tree(),
  cpuPct: 0,
  ioBps: 0,
  lastWrite: T0 + 115_000,
  toolCalls: 4,
  pending: [],
  lastKind: "model",
  subagents: [],
  ...o,
});
const bash = { name: "bash", intent: "x", since: T0 };

describe("session tail", () => {
  test("tracks pending tool calls across partial reads", () => {
    const t = new SessionTail("/nonexistent");
    const text = call(T0 + 1000, "a", "bash", "run tests") + result(T0 + 2000, "a") + call(T0 + 3000, "b", "wait", "wait for build");
    t.ingest(text.slice(0, 50));
    t.ingest(text.slice(50));
    expect(t.toolCalls).toBe(2);
    expect([...t.pending.values()]).toEqual([{ name: "wait", intent: "wait for build", since: T0 + 3000, id: "b" }]);
    expect(t.lastKind).toBe("tool");
    t.ingest(result(T0 + 9000, "b"));
    expect(t.pending.size).toBe(0);
    expect(t.lastKind).toBe("model");
    expect(t.lastEntryAt).toBe(T0 + 9000);
  });
  test("a replaced (shorter) file drops the old half line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    const f = join(dir, "s.jsonl");
    const first = call(T0 + 1000, "a", "bash", "run tests") + result(T0 + 2000, "a");
    writeFileSync(f, first + call(T0 + 3000, "x", "bash", "half").slice(0, 40));
    const t = new SessionTail(f);
    t.poll();
    expect(t.toolCalls).toBe(1);
    writeFileSync(f, call(T0 + 4000, "b", "read", "read file"));
    t.poll();
    expect(t.toolCalls).toBe(2);
    expect([...t.pending.values()].map((p) => p.id)).toEqual(["b"]);
  });
});

describe("verdict and text", () => {
  test("recent log write is alive; old quiet with a tool is waiting; old quiet without one is stuck", () => {
    expect(verdict(view({}))).toBe("alive");
    expect(verdict(view({ lastWrite: T0, now: T0 + 6 * 60_000, pending: [bash] }))).toBe("waiting");
    expect(verdict(view({ lastWrite: T0, now: T0 + 6 * 60_000 }))).toBe("stuck");
    expect(verdict(view({ lastWrite: T0, now: T0 + 6 * 60_000, cpuPct: 40 }))).toBe("alive");
    expect(verdict(view({ tree: { alive: false, procs: 0, ticks: new Map(), ioBytes: 0 } }))).toBe("gone");
  });
  test("a long model turn streaming over the API stays alive (I/O), not stuck", () => {
    expect(verdict(view({ lastWrite: T0, now: T0 + 8 * 60_000, ioBps: 400 }))).toBe("alive");
  });
  test("a tool with no CPU, I/O or subagent writes for 10 min is flagged hung", () => {
    const quiet = { lastWrite: T0, now: T0 + HUNG_MS + 1000, pending: [bash] };
    expect(verdict(view(quiet))).toBe("hung");
    expect(formatHeartbeat(view(quiet))).toContain("🟠 **The running tool may be hung:** no CPU, no I/O and no log writes for 10m 1s");
    expect(verdict(view({ ...quiet, childCpuPct: 50 }))).toBe("alive"); // e.g. a long ffmpeg
    // Root CPU/I/O (advisor stream, MCP traffic) does not hide a hung tool.
    expect(verdict(view({ ...quiet, cpuPct: 50, ioBps: 5000 }))).toBe("hung");
    // A wait on a subagent that is still writing is not hung.
    const sub = { name: "Scrub", lastWrite: T0 + HUNG_MS - 3 * 60_000, toolCalls: 9, pending: [], lastTool: null, done: false };
    expect(verdict(view({ ...quiet, pending: [{ name: "wait", intent: "w", since: T0 }], subagents: [sub] }))).toBe("waiting");
  });
  test("shows each subagent's tool and last activity; finished ones sort last", () => {
    const s = formatHeartbeat(
      view({
        pending: [{ name: "wait", intent: "wait for scrub", since: T0 + 10_000 }],
        subagents: [
          { name: "Old", lastWrite: T0 + 100_000, toolCalls: 3, pending: [], lastTool: null, done: true },
          { name: "Scrub", lastWrite: T0 + 110_000, toolCalls: 12, pending: [{ name: "grep", intent: "find personal terms", since: T0 + 105_000 }], lastTool: null, done: false },
          { name: "Thinker", lastWrite: T0 + 90_000, toolCalls: 2, pending: [], lastTool: { name: "read", intent: "read config", since: T0 + 80_000 }, done: false },
        ],
      }),
    );
    const lines = s.split("\n").filter((l) => l.includes("↳"));
    expect(lines).toEqual([
      "  ↳ 🤖 **Scrub**: 🔧 `grep`: find personal terms (15s) · log 10s ago · 12 calls",
      "  ↳ 🤖 **Thinker**: 🧠 thinking · last `read`: read config (40s) · log 30s ago · 2 calls",
      "  ↳ 🤖 **Old**: ✅ finished · log 20s ago · 3 calls",
    ]);
  });
  test("CPU uses per-process deltas, so an exited child does not read as 0 %", () => {
    const a = tree([[1, 100], [2, 500]]);
    const b = tree([[1, 150]]); // child 2 exited; root used 50 ticks = 0.5 s
    expect(cpuPercent(a, b, 10_000)).toBe(5);
    expect(cpuPercent(a, tree([[1, 100], [3, 20]]), 10_000)).toBe(2); // new child counts from 0
  });
  test("shows the tool name and intent, never its arguments", () => {
    const s = formatHeartbeat(view({ pending: [{ name: "bash", intent: "run `tests` now", since: T0 + 60_000 }], lastKind: "tool" }));
    expect(s).toContain("Working… 2m 0s");
    expect(s).toContain("🟢 **Alive** · checked <t:");
    expect(s).toContain("🔧 Running `bash`: run tests now (1m 0s)");
    expect(s).not.toContain("secret-arg");
    expect(formatHeartbeat(view({ lastWrite: T0, now: T0 + 6 * 60_000 }))).toContain("🔴 **No activity for 6m 0s");
  });
});

describe("live run", () => {
  test("samples this process tree and reads only the run's new session entries", () => {
    const tree = sampleTree(process.pid);
    expect(tree.alive).toBe(true);
    expect(tree.procs).toBeGreaterThanOrEqual(1);
    expect(sampleTree(2 ** 30).alive).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, call(T0 - 60_000, "old", "read", "earlier run")); // previous run: not counted
    mkdirSync(join(dir, "s", "Scrub"), { recursive: true });
    writeFileSync(join(dir, "s", "__advisor.jsonl"), call(T0 + 500, "adv", "read", "advisor"));
    const hb = new RunHeartbeat(T0, dir);
    hb.pid = process.pid;
    appendFileSync(f, call(T0 + 1000, "n", "task", "scrub copy"));
    writeFileSync(join(dir, "s", "Scrub.jsonl"), call(T0 + 2000, "s1", "grep", "find terms"));
    writeFileSync(join(dir, "s", "Scrub", "Scrub.Child.jsonl"), call(T0 + 3000, "c1", "read", "read file") + result(T0 + 4000, "c1") + exit(T0 + 4000));
    const s = hb.tick(T0 + 20_000);
    expect(s).toContain("🔧 Running `task`: scrub copy (19s)");
    expect(s).toContain("1 tool calls");
    expect(s).toContain("🤖 **Scrub**: 🔧 `grep`: find terms (18s)");
    expect(s).toContain("🤖 **Scrub.Child**: ✅ finished");
    expect(s).not.toContain("earlier run");
    expect(s).not.toContain("advisor");
    expect(s).toMatch(/I\/O \d+/);
  });
  test("a real idle tool process with old logs shows 🟠 hung", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-hung-"));
    const f = join(dir, "s.jsonl");
    const started = Date.now() - HUNG_MS - 120_000;
    const hb = new RunHeartbeat(started, dir);
    writeFileSync(f, call(started + 1000, "h", "bash", "fetch stream"));
    const old = new Date(started + 1000);
    utimesSync(f, old, old);
    const child = spawn("bash", ["-c", "sleep 30; true"], { stdio: "ignore" }); // bash root + idle sleep child
    try {
      hb.pid = child.pid!;
      await Bun.sleep(300);
      hb.tick();
      await Bun.sleep(1000);
      const s = hb.tick();
      expect(s).toContain("🟠 **The running tool may be hung:**");
      expect(s).toContain("🔧 Running `bash`: fetch stream");
    } finally {
      child.kill();
    }
  });
});
