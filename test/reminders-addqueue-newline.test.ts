// add-queue.txt must end with a newline after the server rewrites it, so later appends do not glue onto the last line.
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("POST /reminders keeps add-queue newline-terminated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rinbox-"));
  const q = join(dir, "add-queue.txt");
  writeFileSync(q, "A | 2026-11-01T00:00:00.000Z\nB | 2026-11-02T00:00:00.000Z\n");
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "kit", "reminders-inbox", "server.ts")], {
    env: { ...process.env, REMINDERS_DIR: dir, REMINDERS_PORT: String(port), REMINDERS_BIND: "127.0.0.1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let res: Response | undefined;
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/reminders`, { method: "POST", body: "A | done" }).catch(() => undefined);
      // Real delay: polling a separate server process until it listens; the server prints no ready signal.
      if (!res) await Bun.sleep(100);
    }
    expect(res?.ok).toBe(true);
    appendFileSync(q, "C\n");
    expect(readFileSync(q, "utf8").split("\n").filter(Boolean)).toEqual(["B | 2026-11-02T00:00:00.000Z", "C"]);
  } finally {
    proc.kill();
  }
});
