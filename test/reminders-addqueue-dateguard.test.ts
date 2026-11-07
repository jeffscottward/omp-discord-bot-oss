// Card reminder-queue-date-guard (2026-11-05): one add-queue line without a date stopped the whole iPhone Shortcut run
// ("Shortcuts couldn't convert from Text to Date"). GET /add-queue must serve only lines with a valid date.
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneAlerted, recordReject, splitAddQueue, unseenRejects, validAddLine } from "../kit/reminders-inbox/addqueue.ts";

test("validAddLine accepts what remind() writes and rejects dateless or broken lines", () => {
  expect(validAddLine(`Call Bob | ${new Date("2026-11-06T14:00:00Z").toISOString()}`)).toBe(true);
  expect(validAddLine("Call Bob | 2026-11-06T09:00:00-05:00")).toBe(true);
  expect(validAddLine("Install DemoApp 2 VR https://example.test/reports/demoapp2-vr/")).toBe(false);
  expect(validAddLine("Call Bob |")).toBe(false);
  expect(validAddLine(" | 2026-11-06T14:00:00.000Z")).toBe(false); // remind() with an empty or "|"-only message
  expect(validAddLine("Call Bob | tomorrow 9am")).toBe(false);
  expect(validAddLine("Call Bob | 2026-11-06")).toBe(false); // no time and no zone: the Shortcut would guess
  expect(validAddLine("Call Bob | 2026-13-45T99:00:00.000Z")).toBe(false);
});

test("unseenRejects returns each bad line until recordReject saves it", () => {
  const f = join(mkdtempSync(join(tmpdir(), "rinbox-")), "add-queue.alerted.txt");
  expect(unseenRejects(f, ["X", "X", "Y"])).toEqual(["X", "Y"]);
  recordReject(f, "X");
  expect(unseenRejects(f, ["X", "Y"])).toEqual(["Y"]);
  expect(readFileSync(f, "utf8")).toBe("X\n");
  recordReject(f, "Y");
  pruneAlerted(f, ["Y"]); // X was fixed or removed from the queue: forget it, so the same text alerts again
  expect(readFileSync(f, "utf8")).toBe("Y\n");
  expect(splitAddQueue(["A | 2026-11-01T00:00:00.000Z", "B"])).toEqual({ ok: ["A | 2026-11-01T00:00:00.000Z"], bad: ["B"] });
});

async function startServer(dir: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "kit", "reminders-inbox", "server.ts")], {
    env: { ...process.env, REMINDERS_DIR: dir, REMINDERS_PORT: "0", REMINDERS_BIND: "127.0.0.1", OMP_KIT_ENV: "/nonexistent", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`reminders server exited ${await proc.exited} before listening: ${await new Response(proc.stderr).text()}`);
    text += decoder.decode(value, { stream: true });
    const m = /listening on \S+:(\d+)\n/.exec(text);
    if (m) {
      reader.releaseLock();
      // Server log (stderr), collected in the background so tests can wait for a logged event.
      const log = { text: "" };
      void (async () => {
        const errDecoder = new TextDecoder();
        for await (const chunk of proc.stderr) log.text += errDecoder.decode(chunk, { stream: true });
      })();
      return { proc, port: Number(m[1]), log };
    }
  }
}

const A = "A | 2026-11-01T00:00:00.000Z", B = "B | 2026-11-02T00:00:00.000Z", C = "C | 2026-11-03T00:00:00.000Z";
const BAD = "Install DemoApp 2 VR https://example.test/x/";

test("GET /add-queue skips a dateless line; POST /reminders keeps it queued for repair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rinbox-"));
  const q = join(dir, "add-queue.txt");
  writeFileSync(q, `${A}\n${BAD}\n${B}\n`);
  const { proc, port } = await startServer(dir, { REMINDERS_NO_ALERT: "1" });
  try {
    const get = async () => (await fetch(`http://127.0.0.1:${port}/add-queue`)).text();
    expect(await get()).toBe(`${A}\n${B}`);
    appendFileSync(q, `${C}\n`); // a valid line after the bad one is still served
    expect(await get()).toBe(`${A}\n${B}\n${C}`);
    expect(readFileSync(join(dir, "add-queue.alerted.txt"), "utf8")).toBe(`${BAD}\n`); // once, after two reads
    expect((await fetch(`http://127.0.0.1:${port}/reminders`, { method: "POST", body: "A | done" })).ok).toBe(true);
    expect(readFileSync(q, "utf8")).toBe(`${BAD}\n${B}\n${C}\n`);
  } finally {
    proc.kill();
  }
});

test("a failed alert is tried again on the next read; a sent alert is not repeated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rinbox-"));
  writeFileSync(join(dir, "add-queue.txt"), `${BAD}\n${A}\n`);
  // Stub bot repo: notify-owner.ts fails on its first call and succeeds after that; every call is counted.
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const calls = join(dir, "calls.txt");
  writeFileSync(
    join(repo, "scripts", "notify-owner.ts"),
    `import { appendFileSync, existsSync } from "node:fs";\nconst first = !existsSync(${JSON.stringify(calls)});\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(first ? 1 : 0);\n`,
  );
  const { proc, port, log } = await startServer(dir, { OMP_BOT_REPO: repo });
  const alerted = join(dir, "add-queue.alerted.txt");
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(50);
    expect(ok()).toBe(true);
  };
  const count = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    const get = async () => (await fetch(`http://127.0.0.1:${port}/add-queue`)).text();
    expect(await get()).toBe(A);
    await waitFor(() => log.text.includes("alert failed"));
    expect(count()).toBe(1);
    expect(existsSync(alerted)).toBe(false); // first alert failed: not recorded
    expect(await get()).toBe(A);
    await waitFor(() => existsSync(alerted));
    expect(readFileSync(calls, "utf8")).toContain("--alerts");
    expect(await get()).toBe(A);
    // Absence check: no event marks "no alert started", so give a third alert (a subprocess) a short real-time chance.
    await Bun.sleep(200);
    expect(count()).toBe(2);
    expect(log.text.split("skipped line without a valid date").length - 1).toBe(2);
  } finally {
    proc.kill();
  }
});
