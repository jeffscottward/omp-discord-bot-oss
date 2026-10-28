// Plan P4: gate/approve.ts runCommand stops the whole process group (grandchildren too) at the time limit.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APPROVE = join(import.meta.dir, "../gate/approve.ts");

/** Run runCommand in a child bun with no terminal on stdin (so the test never touches this terminal). */
async function runInChild(command: string, timeoutMs: number, graceMs: number) {
  const code = `import { runCommand } from ${JSON.stringify(APPROVE)};
const r = await runCommand({ command: ${JSON.stringify(command)}, cwd: ${JSON.stringify(tmpdir())} }, false, { timeoutMs: ${timeoutMs}, graceMs: ${graceMs} });
console.log("RESULT " + JSON.stringify(r));`;
  // `timeout` is a guard for a hung child, not a wait.
  const p = Bun.spawn([process.execPath, "-e", code], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  return line ? (JSON.parse(line.slice(7)) as { code: number | null; output: string; timedOut: boolean }) : null;
}

/** A pid that is gone or a zombie no longer runs. */
function running(pid: number): boolean {
  if (!existsSync(`/proc/${pid}/stat`)) return false;
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return !/^\d+ \(.*\) Z /.test(stat);
}

describe("approve runCommand process group", () => {
  test("normal command: exit code and output", async () => {
    const r = await runInChild("echo hi; exit 3", 10_000, 100);
    expect(r).toEqual({ code: 3, output: "hi\n", timedOut: false });
  });

  // Integration test of real signals in a real process tree: the 300 ms limits run in the child process
  // (fake timers cannot drive another process). No wait in this test process.
  test("time limit: a grandchild that ignores SIGTERM is killed with the group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "procgroup-"));
    const pidFile = join(dir, "grandchild.pid");
    // The grandchild ignores SIGTERM and holds stdout open; only a group SIGKILL ends it.
    const cmd = `bash -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done' & wait`;
    const r = await runInChild(cmd, 300, 300);
    expect(r?.timedOut).toBe(true);
    const gpid = Number(readFileSync(pidFile, "utf8").trim());
    expect(gpid).toBeGreaterThan(1);
    // runCommand returns only after its SIGKILL step, and the child bun has exited since: the grandchild is gone.
    expect(running(gpid)).toBe(false);
  });
});
