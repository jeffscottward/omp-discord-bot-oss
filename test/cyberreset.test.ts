import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCyberRefusal, MIN_GAP_MS, refusalSince, resetFirstmate, resetNotice, type ResetDeps } from "../src/cyberreset.ts";

const T = Date.parse("2026-10-22T02:09:00Z");
const line = (ts: string, text: string) => JSON.stringify({ type: "message", timestamp: ts, message: { role: "toolResult", content: [{ type: "text", text }] } });
const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures", "editor", n), "utf8");
const EMPTY_BOX = fx("empty.txt");

describe("refusal detection", () => {
  test("only refusals at or after the run start count", () => {
    const old = line("2026-10-21T10:00:00Z", "Refusal (cyber): This request triggered restrictions on violative cyber content");
    const fresh = line("2026-10-22T02:09:43Z", "Refusal (cyber): This request triggered restrictions on violative cyber content");
    expect(refusalSince(old, T)).toBe(false);
    expect(refusalSince(`${old}\n${fresh}`, T)).toBe(true);
    expect(refusalSince(line("2026-10-22T02:09:43Z", "other error"), T)).toBe(false);
  });
  test("quoted refusals (grep output, discussion) and undated lines do not count", () => {
    const real = "Refusal (cyber): This request triggered restrictions on violative cyber content and was blocked";
    expect(refusalSince(line("2026-10-22T02:09:43Z", real), T)).toBe(true);
    expect(refusalSince(line("2026-10-22T02:09:43Z", `Tool call was not executed because the provider stream ended with an error before the tool could run: ${real}`), T)).toBe(true);
    expect(refusalSince(line("2026-10-22T02:09:43Z", `3169:{"type":"message"... ${real}`), T)).toBe(false);
    expect(refusalSince(line("2026-10-22T02:09:43Z", `The last failure was "${real}".`), T)).toBe(false);
    expect(refusalSince(JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: real }] } }), T)).toBe(false);
    expect(refusalSince(JSON.stringify({ type: "message", timestamp: "2026-10-22T02:09:43Z", message: { role: "user", content: [{ type: "text", text: real }] } }), T)).toBe(false);
    expect(isCyberRefusal({ output: `grep hit: ${real}`, sinceMs: T, files: [] })).toBe(false);
  });
  test("output text or a session file can carry it", () => {
    const d = mkdtempSync(join(tmpdir(), "cyber-"));
    const f = join(d, "s.jsonl");
    writeFileSync(f, `${line("2026-10-22T02:09:43Z", "Refusal (cyber): This request triggered restrictions on x")}\n`);
    expect(isCyberRefusal({ output: "", sinceMs: T, files: [null, f] })).toBe(true);
    expect(isCyberRefusal({ output: "error: Refusal (cyber): This request triggered restrictions", sinceMs: T, files: [] })).toBe(true);
    expect(isCyberRefusal({ output: "exit 1", sinceMs: T, files: [join(d, "missing.jsonl")] })).toBe(false);
  });
  test("the real 2026-10-21 FIRSTMATE refusal is detected", () => {
    const f = join(process.env.HOME!, ".local/share/omp-discord-bot/sessions/firstmate.old-20261021T221042/2026-10-19T19-20-45-690Z_01a1559b-f17a-73c3-9a8d-8e88698da64f.jsonl");
    if (!existsSync(f)) return;
    expect(isCyberRefusal({ output: "", sinceMs: Date.parse("2026-10-22T02:09:30Z"), files: [f] })).toBe(true);
    expect(isCyberRefusal({ output: "", sinceMs: Date.parse("2026-10-22T02:10:00Z"), files: [f] })).toBe(false);
  });
});

describe("reset", () => {
  const setup = (o: { box?: string; sideRuns?: number[]; stateAt?: number; fg?: string; noOmp?: boolean } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "cyber-reset-"));
    const sessionsDir = join(root, "sessions");
    mkdirSync(join(sessionsDir, "firstmate"), { recursive: true });
    const stateFile = join(root, "cyber-reset.json");
    if (o.stateAt !== undefined) writeFileSync(stateFile, JSON.stringify({ at: o.stateAt }));
    let kids = o.noOmp ? [] : [100];
    const calls: string[][] = [];
    const killed: number[] = [];
    const deps: ResetDeps = {
      sessionsDir, sideKey: "firstmate", pane: "wB:p3D", stateFile, log: () => {},
      now: () => T, sleep: async () => {}, sideRuns: () => o.sideRuns ?? [],
      children: () => kids, comm: () => "omp",
      kill: (pid) => { killed.push(pid); kids = []; return true; },
      run: (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "pane" && args[1] === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 5, foreground_processes: [{ name: o.fg ?? "omp" }] } } }) };
        if (args[0] === "agent" && args[1] === "read") return { code: 0, out: o.box ?? EMPTY_BOX };
        if (args[0] === "pane" && args[1] === "run") { kids = [200]; return { code: 0, out: "" }; }
        return { code: 1, out: "" };
      },
    };
    return { deps, sessionsDir, calls, killed };
  };
  test("archives the side session (rename) and restarts the pane omp", async () => {
    const s = setup();
    const r = await resetFirstmate(s.deps);
    expect(r).toMatchObject({ ok: true, pane: "restarted" });
    expect(existsSync(join(s.sessionsDir, "firstmate"))).toBe(false);
    expect(existsSync(r.archived!)).toBe(true);
    expect(s.killed).toEqual([100]);
    expect(s.calls.some((c) => c.join(" ") === "herdr pane run wB:p3D omp")).toBe(true);
    expect(resetNotice(r)).toContain("not** resent");
  });
  test("a typed draft in the pane: archive only, pane left alone", async () => {
    const s = setup({ box: fx("typed.txt") });
    const r = await resetFirstmate(s.deps);
    expect(r.pane).toBe("skipped");
    expect(s.killed).toEqual([]);
    expect(existsSync(join(s.sessionsDir, "firstmate"))).toBe(false);
  });
  test("no omp: types into the pane only when the foreground is a shell", async () => {
    const a = setup({ noOmp: true, fg: "vim" });
    expect((await resetFirstmate(a.deps)).pane).toBe("skipped");
    expect(a.calls.some((c) => c.includes("run"))).toBe(false);
    const b = setup({ noOmp: true, fg: "bash" });
    expect((await resetFirstmate(b.deps)).pane).toBe("restarted");
  });
  test("rate limit and active side runs block the reset", async () => {
    const a = setup({ stateAt: T - MIN_GAP_MS / 2 });
    expect((await resetFirstmate(a.deps)).ok).toBe(false);
    expect(existsSync(join(a.sessionsDir, "firstmate"))).toBe(true);
    const b = setup({ sideRuns: [42] });
    expect((await resetFirstmate(b.deps)).ok).toBe(false);
    expect(existsSync(join(b.sessionsDir, "firstmate"))).toBe(true);
  });
});
