import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoCheckQuietMs, childProcs, formatCheck, procSummary, waitReason, type CheckInput } from "../src/diagnose.ts";
import { SessionTail, type HeartbeatView } from "../src/heartbeat.ts";

const now = 1_800_000_000_000;
const view = (o: Partial<HeartbeatView> = {}): HeartbeatView => ({
  now,
  startedAt: now - 14 * 60_000,
  tree: { alive: true, procs: 3, ticks: new Map([[100, 5], [101, 1], [102, 0]]), ioBytes: 0 },
  cpuPct: 0,
  childCpuPct: 0,
  ioBps: 0,
  lastWrite: now - 7 * 60_000,
  toolCalls: 4,
  pending: [{ name: "bash", intent: "run the tests", since: now - 7 * 60_000, id: "t1" }],
  lastKind: "tool",
  subagents: [],
  ...o,
});
const base = (o: Partial<CheckInput> = {}): CheckInput => ({
  now,
  reason: "button",
  job: { id: 12, startedAt: now - 14 * 60_000, preview: "fix the build" },
  pid: 100,
  view: view(),
  children: [
    { pid: 101, comm: "bash", state: "S" },
    { pid: 102, comm: "bun", state: "D" },
  ],
  recent: [
    { at: now - 8 * 60_000, kind: "result", name: "read", intent: "" },
    { at: now - 7 * 60_000, kind: "call", name: "bash", intent: "run the tests" },
  ],
  sessionFile: "/home/someone/.local/share/omp-discord-bot/sessions/x/a.jsonl",
  idleLimitMs: 10 * 60_000,
  restart: { pending: false, updates: 0, draining: false, holding: [] },
  queue: { waitingHere: [], runningAll: 1, queuedAll: 0, max: 4 },
  ...o,
});

describe("🩺 Check report (UX item 5)", () => {
  test("running job: state, process, children, tool since, log entries, idle stop, queue, restart", () => {
    const t = formatCheck(base());
    expect(t).toContain("🩺 **Check**");
    expect(t).toContain("**Job #12:** fix the build");
    expect(t).toContain("🟡 quiet, still running · last activity 7m 0s ago");
    expect(t).toContain("pid 100");
    expect(t).toContain("bash (sleeping), bun (disk wait ⚠️)");
    expect(t).toContain("**Current tool:** `bash`: run the tests · since");
    expect(t).toContain("(in about 3m 0s)");
    expect(t).toContain("📜 **Last 2 log entries:**");
    expect(t).toContain("🔧 called `bash`: run the tests");
    expect(t).toContain("`~/.local/share/omp-discord-bot/sessions/x/a.jsonl`");
    expect(t).toContain("nothing waiting here · all channels: 1/4 running, 0 waiting");
    expect(t).toContain("🔄 **Restart:** none pending");
    expect(t.length).toBeLessThan(2000);
  });

  test("auto report says why it was posted", () => {
    expect(formatCheck(base({ reason: "quiet" }))).toContain("posted by itself: the run has been quiet");
    expect(formatCheck(base({ reason: "no-start", job: null }))).toContain("got no Working… within 60 s");
  });

  test("no running job: waiting reason and drain holder", () => {
    const t = formatCheck(base({ job: null, restart: { pending: true, updates: 2, draining: true, holding: ["#dev build"] }, queue: { waitingHere: ["hello"], runningAll: 1, queuedAll: 1, max: 4, waitReason: "a restart" } }));
    expect(t).toContain("No job runs in this channel now");
    expect(t).toContain("1 waiting here (next: hello)");
    expect(t).toContain("❓ **Why it waits:** a restart");
    expect(t).toContain("pending (2 updates); new jobs wait for #dev build");
  });

  test("job not spawned yet", () => {
    expect(formatCheck(base({ pid: 0, view: null }))).toContain("not started yet");
  });

  test("never shows secrets in tool intents", () => {
    const t = formatCheck(base({ view: view({ pending: [{ name: "bash", intent: "use token ghp_abcdefghijklmnopqrstuvwxyz0123456789", since: now }] }) }));
    expect(t).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

test("procSummary groups by name and state", () => {
  expect(procSummary([])).toBe("none");
  expect(procSummary([{ pid: 1, comm: "bash", state: "S" }, { pid: 2, comm: "bash", state: "S" }, { pid: 3, comm: "rg", state: "R" }])).toBe("bash ×2 (sleeping), rg (running)");
});

test("childProcs reads comm and state from /proc, skips the root", () => {
  const dir = mkdtempSync("/tmp/diag-proc-");
  for (const [pid, comm, st] of [[100, "omp", "S"], [101, "my tool)x", "D"]] as const) {
    mkdirSync(join(dir, String(pid)));
    writeFileSync(join(dir, String(pid), "stat"), `${pid} (${comm}) ${st} 1 1 1 0 -1 0 0 0 0 0 5 1 0`);
  }
  expect(childProcs(view(), 100, dir)).toEqual([{ pid: 101, comm: "my tool)x", state: "D" }]);
});

test("waitReason", () => {
  const o = { draining: false, sameChannelRunning: false, running: 1, max: 4, holding: [], runningLabels: [] };
  expect(waitReason({ ...o, sameChannelRunning: true })).toBeNull();
  expect(waitReason({ ...o, draining: true, holding: ["#a job"] })).toContain("until #a job ends");
  expect(waitReason({ ...o, running: 4, runningLabels: ["#a", "#b", "#c", "#d"] })).toContain("all 4 run slots are busy (#a, #b, #c +1)");
  expect(waitReason(o)).toContain("no known reason");
});

test("auto check fires before the idle stop", () => {
  expect(autoCheckQuietMs(10 * 60_000)).toBe(8 * 60_000);
  expect(autoCheckQuietMs(30 * 60_000)).toBe(10 * 60_000);
});

test("SessionTail keeps the last 5 entries in short form", () => {
  const t = new SessionTail("/nonexistent");
  const ts = (s: number) => new Date(now + s * 1000).toISOString();
  const lines = [
    { type: "message", timestamp: ts(0), message: { role: "user", content: "secret text" } },
    { type: "message", timestamp: ts(1), message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", intent: "read config" }] } },
    { type: "message", timestamp: ts(2), message: { role: "toolResult", toolCallId: "a", isError: true, content: "boom" } },
    { type: "message", timestamp: ts(3), message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    { type: "message", timestamp: ts(4), message: { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", intent: "x" }] } },
    { type: "message", timestamp: ts(5), message: { role: "toolResult", toolCallId: "b", content: "ok" } },
  ];
  t.ingest(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  expect(t.recent.map((e) => `${e.kind}:${e.name}`)).toEqual(["call:read", "error:read", "text:", "call:bash", "result:bash"]);
  expect(JSON.stringify(t.recent)).not.toContain("secret text");
});
