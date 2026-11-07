// Card test-tmp-leak (2026-11-01): test runs left about 56,000 temp dirs in /tmp and the tmpfs reached 99% inodes.
// Every test run now gets one private temp root, /tmp/omp-bt-<pid>-XXXXXX ("omp bot test"; a short name, because
// Chrome and other unix sockets under it must stay below the 107-byte socket path limit). TMPDIR points into it, so
// os.tmpdir() and every mkdtempSync(join(tmpdir(), ...)) in the tests and in the code under test write there.
// Removal: a detached watcher process removes the root when the run's process is gone: after a pass or a failure,
// after `--rerun-each`, and after a kill (SIGKILL, timeout). `bun test` emits no process "exit" event, and a preload
// afterAll also runs between `--rerun-each` passes, so neither can remove the root safely. Plain `bun --preload`
// runs also remove it in the "exit" hook. If the watcher itself is killed, a later run removes the root when its
// process is gone and the root is more than 1 hour old.
// Limit: Bun.spawn without an `env` option does not pass this TMPDIR to the child. Spawn with
// `env: { ...process.env }` to give the child the root.
// Loaded first by test/setup.ts (bunfig.toml preload), before any module that reads tmpdir().
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TMP_ROOT_PREFIX = "omp-bt-";
const ROOT_NAME = /^omp-bt-(\d+)-[^/]+$/;
const STALE_MS = 60 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove roots in `base` whose run process is gone and that are older than 1 hour. Returns the removed paths. */
export function sweepStaleRoots(base: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = ROOT_NAME.exec(name);
    if (!m) continue;
    const p = join(base, name);
    try {
      if (alive(Number(m[1])) || now - statSync(p).mtimeMs < STALE_MS) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // Removed by another run, or not readable: leave it.
    }
  }
  return removed;
}

const base = tmpdir();
sweepStaleRoots(base);
export const TMP_ROOT = mkdtempSync(join(base, `${TMP_ROOT_PREFIX}${process.pid}-`));
process.env.TMPDIR = TMP_ROOT;
// Own session (detached): Ctrl-C or a timeout that stops the test run's process group does not stop the watcher.
spawn("sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; rm -rf -- "$2"', "sh", String(process.pid), TMP_ROOT], {
  detached: true,
  stdio: "ignore",
}).unref();
process.on("exit", () => rmSync(TMP_ROOT, { recursive: true, force: true }));
