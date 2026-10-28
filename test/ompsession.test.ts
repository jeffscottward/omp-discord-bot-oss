import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedSlash,
  currentFile,
  forkFile,
  listSessions,
  modeArgs,
  modeOverlay,
  modePreamble,
  PLAN_TOOLS,
  promptPreview,
  rpcArgs,
  sessionLocked,
  StateStore,
  trashFile,
  waitSessionFree,
  withSessionLock,
} from "../src/ompsession.ts";
import { COMMANDS, NAMES, PHASE1 } from "../src/sessioncmds.ts";

function sessionFile(dir: string, name: string, user: string): string {
  const f = join(dir, `${name}.jsonl`);
  const lines = [
    { type: "session", cwd: "/tmp/x", timestamp: "2026-10-22T10:00:00Z" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: `--- owner message ---\n${user}\n--- end owner message ---` }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "read" }] } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

describe("session commands: RPC routing", () => {
  test("only listed read-only slash commands pass", () => {
    expect(allowedSlash("/context")).toBe(true);
    expect(allowedSlash("/mcp list")).toBe(true);
    expect(allowedSlash("/fast on")).toBe(true);
    expect(allowedSlash("/context now")).toBe(false);
    expect(allowedSlash("/login")).toBe(false);
    expect(allowedSlash("/logout anthropic")).toBe(false);
    expect(allowedSlash("hello")).toBe(false);
  });
  test("rpc args continue the newest file or a pinned one", () => {
    expect(rpcArgs({ bin: "omp", sessionDir: "/s", cwd: "/" })).toEqual(["--mode", "rpc", "--no-ui", "--session-dir", "/s", "--continue"]);
    expect(rpcArgs({ bin: "omp", sessionDir: "/s", cwd: "/", resumeFile: "/s/a.jsonl" }).slice(-2)).toEqual(["--resume", "/s/a.jsonl"]);
  });
  test("no auth or account command is registered", () => {
    for (const bad of ["login", "logout", "setup", "share", "computer", "browser"]) expect(NAMES.has(bad)).toBe(false);
    expect(PHASE1.map((c) => c.name)).toEqual(["session", "context", "resume", "compact"]);
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });
});

describe("session files", () => {
  test("list, title from the owner's words, current file and pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-test-"));
    const a = sessionFile(dir, "2026-10-20_a", "first task");
    const b = sessionFile(dir, "2026-10-21_b", "second task");
    utimesSync(a, new Date(1_000_000), new Date(1_000_000));
    const list = listSessions(dir);
    expect(list.map((s) => s.file)).toEqual([b, a]);
    expect(list[0]!.title).toBe("second task");
    expect(list[0]!.userMessages).toBe(1);
    expect(list[0]!.toolCalls).toBe(1);
    expect(currentFile(dir)).toBe(b);
    expect(currentFile(dir, { file: a })).toBe(a);
    expect(currentFile(dir, { fresh: true })).toBeUndefined();
  });
  test("fork copies, trash moves", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-test-"));
    const a = sessionFile(dir, "s1", "x");
    const dest = forkFile(a, join(dir, "fork"));
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(a, "utf8"));
    trashFile(a);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(dir, ".trash", "s1.jsonl"))).toBe(true);
  });
  test("preview keeps only the owner's words", () => {
    expect(promptPreview("bridge rules\n--- owner message ---\nfix  the\nbug\n--- end owner message ---")).toBe("fix the bug");
  });
});

describe("channel mode", () => {
  test("flags, overlay and preamble", () => {
    expect(modeArgs(undefined, undefined, false)).toEqual([]);
    expect(modeArgs({ effort: "high", advisor: true, plan: true }, "/o.yml", false)).toEqual(["--thinking", "high", "--advisor", "--config", "/o.yml", "--tools", PLAN_TOOLS]);
    // Isolated Venice/Qwen turns keep their own thinking/advisor settings.
    expect(modeArgs({ effort: "high", advisor: true }, "/o.yml", true)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "oc-test-"));
    expect(modeOverlay(dir, "k", { effort: "low" })).toBeUndefined();
    const f = modeOverlay(dir, "k", { advisor: false })!;
    expect(readFileSync(f, "utf8")).toContain("enabled: false");
    expect(modePreamble({ goal: "ship it", plan: true })).toContain("ship it");
    expect(modePreamble({})).toBe("");
  });
  test("state store persists and drops empty entries", () => {
    const file = join(mkdtempSync(join(tmpdir(), "oc-test-")), "s.json");
    const st = new StateStore(file);
    st.update("k", (s) => ({ ...s, pin: { fresh: true } }));
    expect(new StateStore(file).get("k").pin?.fresh).toBe(true);
    st.update("k", (s) => ({ ...s, pin: undefined }));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });
});

describe("session lock", () => {
  test("a turn waits until the session command ends", async () => {
    const order: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const cmd = withSessionLock("k", async () => {
      order.push("cmd start");
      await promise;
      order.push("cmd end");
    });
    expect(sessionLocked("k")).toBe(true);
    const turn = waitSessionFree("k").then(() => order.push("turn"));
    await Promise.resolve();
    expect(order).toEqual(["cmd start"]);
    resolve();
    await Promise.all([cmd, turn]);
    expect(order).toEqual(["cmd start", "cmd end", "turn"]);
    expect(sessionLocked("k")).toBe(false);
  });
});

describe("protected sessions (FIRSTMATE, mirrored panes)", () => {
  const { guardWrite, WRITE_ACTIONS } = require("../src/sessioncmds.ts") as typeof import("../src/sessioncmds.ts");
  test("every writing action is refused, read-only views pass", () => {
    const c = { protectedReason: "mirrors a Herdr pane" };
    for (const a of ["compact", "do-clear", "do-new", "do-delete", "handoff", "shake", "m-rename", "pick-resume", "pick-branch", "t-fast", "effort"]) {
      expect(WRITE_ACTIONS.has(a)).toBe(true);
      expect(() => guardWrite(c, a)).toThrow("mirrors a Herdr pane");
    }
    for (const a of ["session", "context", "export", "tools", "jobs", "todo"]) expect(() => guardWrite(c, a)).not.toThrow();
    expect(() => guardWrite({}, "compact")).not.toThrow();
  });
});

describe("bounded /loop", () => {
  const { runBoundedLoop, LOOP_MAX_TURNS } = require("../src/sessioncmds.ts") as typeof import("../src/sessioncmds.ts");
  const mk = (count: number, limitMs: number) => ({ id: 1, channelId: "c", prompt: "p", count, limitMs, started: 0, done: 0, stopped: false });
  test("count is capped at the maximum", async () => {
    const run = mk(1000, 60 * 60_000);
    let turns = 0;
    expect(await runBoundedLoop(run, { now: () => 0, turn: async () => void turns++ })).toBe(`finished ${LOOP_MAX_TURNS}/${LOOP_MAX_TURNS} turns`);
    expect(turns).toBe(LOOP_MAX_TURNS);
  });
  test("time limit ends the loop (fake clock, capped at 2 h)", async () => {
    let t = 0;
    const run = mk(10, 99 * 60 * 60_000);
    const r = await runBoundedLoop(run, { now: () => t, turn: async () => void (t += 50 * 60_000) });
    expect(r).toBe("time limit reached after 3/10 turns");
  });
  test("Stop ends it before the next turn", async () => {
    const run = mk(10, 60 * 60_000);
    const r = await runBoundedLoop(run, { now: () => 0, turn: async (n) => void (n === 2 && (run.stopped = true)) });
    expect(r).toBe("stopped after 2/10 turns");
  });
});
