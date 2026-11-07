// add-queue.txt must end with a newline after the server rewrites it, so later appends do not glue onto the last line.
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("POST /reminders keeps add-queue newline-terminated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rinbox-"));
  const q = join(dir, "add-queue.txt");
  writeFileSync(q, "A | 2026-11-01T00:00:00.000Z\nB | 2026-11-02T00:00:00.000Z\n");
  // Port 0: the kernel picks a free port. Card bot-gate-flake (2026-11-03): a random port in 40000-59999 is inside
  // the Linux ephemeral range, so listen() sometimes failed with EADDRINUSE, and the test polled a dead port until
  // bun's 5 s test timeout (restart gate failures).
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "kit", "reminders-inbox", "server.ts")], {
    env: { ...process.env, REMINDERS_DIR: dir, REMINDERS_PORT: "0", REMINDERS_BIND: "127.0.0.1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Ready signal: the server prints "reminders-inbox listening on <host>:<port>" after it binds. EOF first = it exited.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let port: number | undefined;
    while (port === undefined) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`reminders server exited ${await proc.exited} before listening: ${await new Response(proc.stderr).text()}`);
      text += decoder.decode(value, { stream: true });
      const m = /listening on \S+:(\d+)\n/.exec(text);
      if (m) port = Number(m[1]);
    }
    reader.releaseLock();
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/reminders`, { method: "POST", body: "A | done" });
    expect(res.ok).toBe(true);
    appendFileSync(q, "C\n");
    expect(readFileSync(q, "utf8").split("\n").filter(Boolean)).toEqual(["B | 2026-11-02T00:00:00.000Z", "C"]);
  } finally {
    proc.kill();
  }
});
