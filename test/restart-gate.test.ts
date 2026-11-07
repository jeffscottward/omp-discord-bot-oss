// scripts/restart-gate.sh on a small fake repo whose tests fail (card bot-gate-flake, 2026-11-03):
// the last line (the Discord notice text) names the failed tests, the full output goes to a log file,
// and only one gate runs at a time on the host (lock).
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const GATE = resolve(import.meta.dir, "../scripts/restart-gate.sh");
const WAITER = resolve(import.meta.dir, "../scripts/restart-when-idle.sh");
// Each gate run starts a nested `bun test` of the fake repo (about 0.5 s alone, more under load).
const NESTED_RUN_TIMEOUT = 60_000;

let repo = "";
let sha = "";
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "gate-repo-"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "test"));
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "scripts/ok.sh"), "#!/bin/sh\necho ok\n");
  writeFileSync(join(repo, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(repo, "test/a.test.ts"),
    [
      'import { describe, expect, test } from "bun:test";',
      'describe("grp", () => {',
      '  test("fails with `ticks`", () => { expect(1).toBe(2); });',
      // Real delay on purpose: the fake test must really pass bun's wall-clock per-test timeout (50 ms).
      '  test("times out", async () => { await Bun.sleep(2000); }, 50);',
      "});",
      'test("passes", () => {});',
    ].join("\n"),
  );
  writeFileSync(join(repo, "test/b.test.ts"), 'import { test } from "bun:test";\nthrow new Error("load boom");\ntest("never", () => {});\n');
  writeFileSync(join(repo, "test/c.test.ts"), 'import { expect, test } from "bun:test";\ntest("fourth", () => { expect(true).toBe(false); });\n');
  // bun prints a load error by its type ("TypeError: ..."), not "error: ..."; the next file's assertion must not be
  // taken for this file's load error.
  writeFileSync(join(repo, "test/d.test.ts"), 'import { test } from "bun:test";\nthrow new TypeError("load type");\ntest("never", () => {});\n');
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fake");
  sha = new TextDecoder().decode(git("rev-parse", "--short", "HEAD").stdout).trim();
});

function env(dir: string, extra: Record<string, string> = {}) {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), OMP_GATE_LOG_DIR: join(dir, "logs"), OMP_GATE_LOCK: join(dir, "gate.lock"), ...extra };
  delete e.OMP_GATE_LOCKED; // set when this suite itself runs inside the gate
  return e;
}

async function gate(dir: string, extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bash", GATE, repo], { env: env(dir, extra), stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return { code, lines: out.trim().split("\n") };
}

describe("restart-gate.sh", () => {
  test(
    "failed tests: last line names them and the log; the log holds the full output",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gate-"));
      const { code, lines } = await gate(dir);
      expect(code).toBe(1);
      const log = lines.at(-1)!.split("Full log: ")[1]!;
      // One log per run: gate-<sha>-<UTC time>-<pid>.log in the log dir.
      expect(log).toMatch(new RegExp(`^${join(dir, "logs")}/gate-${sha}-\\d{8}T\\d{6}Z-\\d+\\.log$`));
      // Sorted by file, test order kept; each name is in backticks, a backtick inside a name becomes a quote;
      // failures 4 and 5 (test/c.test.ts, test/d.test.ts) are counted as "+2 more".
      expect(lines.at(-1)!.replace(/\[[\d.]+ms\]/g, "[ms]")).toBe(
        `GATE FAIL at ${sha}: tests (bun test): 5 failed: ` +
          "`test/a.test.ts: grp > fails with 'ticks' [ms]`; `test/a.test.ts: grp > times out [ms] (timed out)`; " +
          `\`test/b.test.ts: unhandled error: load boom\`; +2 more. Full log: ${log}`,
      );
      const text = readFileSync(log, "utf8");
      expect(text).toContain("===== tests (bun test) (exit 1) =====");
      expect(text).toContain("error: load boom");
      expect(text).toContain(" 1 pass");
      // The log lists every failed test, not only the first 3.
      expect(text.replace(/\[[\d.]+ms\]/g, "[ms]")).toContain(
        [
          "===== failed tests (5) (exit 1) =====",
          "test/a.test.ts: grp > fails with `ticks` [ms]",
          "test/a.test.ts: grp > times out [ms] (timed out)",
          "test/b.test.ts: unhandled error: load boom",
          "test/c.test.ts: fourth [ms]",
          "test/d.test.ts: unhandled error: TypeError: load type",
        ].join("\n"),
      );
      expect(text).toMatch(/^gate at \w+ in .*, started .*, load [\d.]+ [\d.]+ [\d.]+\n/);
      // Renamed into place: no temp file is left. A second run at the same commit keeps the first run's log.
      expect(readdirSync(join(dir, "logs"))).toEqual([basename(log)]);
      const again = await gate(dir);
      const log2 = again.lines.at(-1)!.split("Full log: ")[1]!;
      expect(log2).not.toBe(log);
      expect(readdirSync(join(dir, "logs")).sort()).toEqual([basename(log), basename(log2)].sort());
    },
    NESTED_RUN_TIMEOUT,
  );

  test(
    "a held lock: the gate waits, then fails with a clear line",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gate-"));
      // One process holds the lock (sh execs sleep with the locked fd), so kill() releases it and leaves no child.
      // Ready signal: the holder prints once it has the lock.
      const holder = Bun.spawn(["sh", "-c", 'exec 9>"$1" && flock 9 && echo locked && exec sleep 30', "sh", join(dir, "gate.lock")], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
      try {
        const { code, lines } = await gate(dir, { OMP_GATE_LOCK_WAIT: "1" });
        expect(code).toBe(1);
        expect(lines.at(-1)).toBe(`GATE FAIL at ${sha}: another gate run held ${join(dir, "gate.lock")} for more than 1s`);
      } finally {
        holder.kill();
        await holder.exited;
      }
    },
    // A real 1 s lock wait plus bash, flock and git starts: more than bun's default 5 s is possible under load.
    NESTED_RUN_TIMEOUT,
  );

  test(
    "restart-when-idle.sh: the Restart skipped notice names the failed tests",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gate-"));
      const notes = join(dir, "notes");
      writeFileSync(join(dir, "notify"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${notes}\n`, { mode: 0o755 });
      const p = Bun.spawn(["bash", WAITER], {
        env: env(dir, {
          OMP_RESTART_GATE: `${GATE} ${repo}`,
          OMP_RESTART_NOTIFY: join(dir, "notify"),
          OMP_RESTART_LOCK: join(dir, "waiter.lock"),
          OMP_RESTART_HEAD: "echo aaaaaaaaaa",
          OMP_RESTART_SLEEP: "true",
        }),
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await p.exited).toBe(3);
      const note = readFileSync(notes, "utf8");
      expect(note).toContain("Restart skipped");
      expect(note).toContain("5 failed: `test/a.test.ts: grp > fails with 'ticks'");
      expect(note).toContain(`Full log: ${join(dir, "logs", `gate-${sha}-`)}`);
    },
    NESTED_RUN_TIMEOUT,
  );
});
