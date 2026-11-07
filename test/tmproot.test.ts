// Card test-tmp-leak (2026-11-01): test runs filled /tmp (tmpfs, 99% inodes) with temp dirs they never removed.
// test/tmproot.ts gives each run a private temp root and removes it; these tests run real child processes.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sweepStaleRoots, TMP_ROOT, TMP_ROOT_PREFIX } from "./tmproot.ts";

const SETUP = join(import.meta.dir, "setup.ts");
const TMPROOT = join(import.meta.dir, "tmproot.ts");
const PROBE_IMPORTS = `import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";`;
// Makes a temp dir with a file, and records the root and the dir (one JSON line per call).
const PROBE_BODY = `const d = mkdtempSync(join(tmpdir(), "probe-")); writeFileSync(join(d, "f"), "x");
appendFileSync(process.env.PROBE_OUT!, JSON.stringify({ root: process.env.TMPDIR, d }) + "\\n");`;

function withBase(fn: (base: string) => void | Promise<void>): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "tmproot-base-"));
  return Promise.resolve(fn(base)).finally(() => rmSync(base, { recursive: true, force: true }));
}

/** The watcher is a real `sh` process that polls once per second (no fake clock reaches it): wait up to 5 s. */
async function gone(p: string): Promise<boolean> {
  for (let i = 0; i < 50 && existsSync(p); i++) await Bun.sleep(100);
  return !existsSync(p);
}

async function checkRemoved(base: string, out: string, calls = 1): Promise<void> {
  const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { root: string; d: string });
  expect(lines.length).toBe(calls);
  const root = lines[0]!.root;
  expect(root.startsWith(join(base, TMP_ROOT_PREFIX))).toBe(true);
  for (const l of lines) expect(l.root === root && l.d.startsWith(`${root}/probe-`)).toBe(true);
  expect(await gone(root)).toBe(true);
  expect(readdirSync(base).filter((n) => n.startsWith(TMP_ROOT_PREFIX))).toEqual([]);
}

test("this run writes temp dirs into its own root", () => {
  expect(tmpdir()).toBe(TMP_ROOT);
  expect(basename(TMP_ROOT).startsWith(`${TMP_ROOT_PREFIX}${process.pid}-`)).toBe(true);
});

for (const [name, extra, pass, calls] of [
  ["passes", [], true, 1],
  ["fails", [], false, 1],
  // --rerun-each: the root (and the config copy in it) must stay until the last pass ends.
  ["reruns each file twice", ["--rerun-each", "2"], true, 2],
] as const) {
  test(`bun test: the root and its temp dirs are removed when the run ${name}`, () =>
    withBase(async (base) => {
      const out = join(base, "out.json");
      const t = join(base, "probe.test.ts");
      writeFileSync(t, `${PROBE_IMPORTS}\nimport { expect, test } from "bun:test";\ntest("probe", () => {\n${PROBE_BODY}\nexpect(existsSync(process.env.OMP_BOT_CONFIG!) && ${pass}).toBe(true);\n});\n`);
      // cwd = base: no bunfig.toml there, so only the preload given here runs.
      const r = Bun.spawnSync(["bun", "test", "--preload", SETUP, ...extra, t], { cwd: base, env: { ...process.env, TMPDIR: base, PROBE_OUT: out } });
      expect(r.exitCode).toBe(pass ? 0 : 1);
      await checkRemoved(base, out, calls);
    }), 30_000);
}

test("bun --preload tmproot.ts: the root is removed when the script exits", () =>
  withBase(async (base) => {
    const out = join(base, "out.json");
    const s = join(base, "probe.ts");
    writeFileSync(s, `${PROBE_IMPORTS}\n${PROBE_BODY}\n`);
    const r = Bun.spawnSync(["bun", "--preload", TMPROOT, s], { cwd: base, env: { ...process.env, TMPDIR: base, PROBE_OUT: out } });
    expect(r.exitCode).toBe(0);
    await checkRemoved(base, out);
  }), 30_000);

test("a killed run (SIGKILL) still has its root removed", () =>
  withBase(async (base) => {
    const out = join(base, "out.json");
    const s = join(base, "probe.ts");
    writeFileSync(s, `${PROBE_IMPORTS}\n${PROBE_BODY}\nsetInterval(() => {}, 1000);\n`);
    const p = Bun.spawn(["bun", "--preload", TMPROOT, s], { cwd: base, env: { ...process.env, TMPDIR: base, PROBE_OUT: out }, stdio: ["ignore", "ignore", "ignore"] });
    // Real child process: wait for its first write (the signal that the root exists), then kill it.
    for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(100);
    p.kill("SIGKILL");
    await p.exited;
    await checkRemoved(base, out);
  }), 30_000);

test("sweepStaleRoots removes only roots of gone runs that are over 1 hour old", () =>
  withBase((base) => {
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    const mk = (name: string, mtime?: number): string => {
      const p = join(base, name);
      mkdirSync(join(p, "x"), { recursive: true });
      if (mtime) utimesSync(p, mtime, mtime);
      return p;
    };
    const goneRun = 999_999_999; // above the Linux pid_max limit: never a live process
    const stale = mk(`${TMP_ROOT_PREFIX}${goneRun}-AAAAAA`, old);
    const fresh = mk(`${TMP_ROOT_PREFIX}${goneRun}-BBBBBB`);
    const live = mk(`${TMP_ROOT_PREFIX}${process.pid}-CCCCCC`, old);
    const other = mk(`other-${goneRun}-DDDDDD`, old);
    expect(sweepStaleRoots(base)).toEqual([stale]);
    expect([stale, fresh, live, other].map((p) => existsSync(p))).toEqual([false, true, true, true]);
  }));
