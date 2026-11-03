import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Card sma-fm-set-cas (state-machine-audit finding #7): automated writers decide from a snapshot read outside the
// tracker lock. `fm set --from <state>` is the compare-and-set guard: fm writes only when the card is still in the
// state the writer read, and exits 3 ("card moved") otherwise.
const KIT = join(import.meta.dir, "..", "kit", "bin");
const FM = join(KIT, "fm");
const MOVED = 3;
let dir = "";
let env: Record<string, string> = {};

function items(list: object[]) {
  writeFileSync(join(dir, "items.json"), JSON.stringify({ updated: "", items: list }));
}
function card(id: string) {
  return JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items.find((i: { id: string }) => i.id === id);
}
function fm(...args: string[]) {
  const r = Bun.spawnSync(["python3", "-B", FM, ...args], { env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
// An fm stand-in that lets another writer change the card first (the race window), then runs the real fm.
function racer(id: string, state: string, note: string) {
  const p = join(dir, "racer-fm");
  writeFileSync(p, `#!/bin/sh\nFM_AUTO= FM_BY=other python3 -B '${FM}' set '${id}' '${state}' '${note}' >/dev/null\nexec python3 -B '${FM}' "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fm-cas-"));
  mkdirSync(join(dir, "home"));
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(dir, "home"),
    OMP_KIT_ENV: "/nonexistent",
    FM_DIR: dir,
    REPORTS_WEB_DIR: dir,
    FM_ITEMS: join(dir, "items.json"),
    FM_SPAWN_STATE: join(dir, "spawn"),
    FM_SPAWN_PATH: "/nonexistent",
    OMP_BOT_ENV: join(dir, "no-bot.env"),
    FM_AUTOCLEAR_POST_URL: "http://127.0.0.1:9/post",
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reproduction: without --from an older snapshot overwrites a newer state", () => {
  items([{ id: "c", t: "C", s: "running", job: "tab" }]);
  // prwatch read "running" and closes the card; the overseer read "running" earlier and still writes partial.
  expect(fm("set", "c", "done", "PR merged").code).toBe(0);
  expect(fm("set", "c", "partial", "needs check").code).toBe(0);
  expect(card("c").s).toBe("partial"); // the done state is lost: this is the bug the guard prevents
});

test("fm set --from refuses when the card moved, writes nothing, exits 3", () => {
  items([{ id: "c", t: "C", s: "running", job: "tab" }]);
  expect(fm("set", "c", "done", "PR merged", "--from", "running").code).toBe(0);
  const r = fm("set", "c", "partial", "needs check", "--from", "running");
  expect(r.code).toBe(MOVED);
  expect(r.err).toContain("card moved: c is done");
  expect(card("c").s).toBe("done");
  expect(card("c").n).toBe("PR merged");
});

test("fm set --from accepts a state list; manual fm set without --from still works", () => {
  items([{ id: "c", t: "C", s: "partial" }]);
  expect(fm("set", "c", "planned", "x", "--from", "running,partial").code).toBe(0);
  expect(card("c").s).toBe("planned");
  const m = fm("set", "c", "done", "manual close");
  expect(m.code).toBe(0);
  expect(card("c")).toMatchObject({ s: "done", n: "manual close" });
});

test("fm set --from rejects an unknown or empty state", () => {
  items([{ id: "c", t: "C", s: "partial" }]);
  expect(fm("set", "c", "done", "--from", "runing").code).toBe(1);
  expect(fm("set", "c", "done", "--from").code).toBe(1);
  expect(card("c").s).toBe("partial");
});

test("fm stop --from keeps the reason text clean and honours the guard", () => {
  items([{ id: "c", t: "C", s: "done" }]);
  expect(fm("stop", "c", "owner", "--from", "running").code).toBe(MOVED);
  expect(card("c").s).toBe("done");
  items([{ id: "d", t: "D", s: "running", job: "tab" }]);
  expect(fm("stop", "d", "owner", "--from", "running").code).toBe(0);
  expect(card("d").n).toBe("⏹️ Stopped: owner");
});

test("fm-prwatch passes --from and skips a card that moved after its read", () => {
  items([{ id: "c", t: "C", s: "partial", l: "https://github.com/o/r/pull/1" }]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","mergeCommit":{"oid":"abcdef1"}}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const log = join(dir, "prwatch.log");
  const r = Bun.spawnSync(["python3", "-B", join(KIT, "fm-prwatch")], {
    env: {
      ...env, PATH: `${bin}:${env.PATH}`, FM_BIN: racer("c", "planned", "moved by owner"), FM_PRWATCH_LOG: log,
      FM_PRWATCH_STATE: join(dir, "prw-state.json"), FM_PRWATCH_RUNNING: join(dir, "running.json"),
    },
  });
  expect(r.exitCode).toBe(0);
  expect(readFileSync(log, "utf8")).toContain("c: card moved since the read");
  expect(card("c")).toMatchObject({ s: "planned", n: "moved by owner" });
});

test("fm-prwatch closes the card when it did not move", () => {
  items([{ id: "c", t: "C", s: "partial", l: "https://github.com/o/r/pull/1" }]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","mergeCommit":{"oid":"abcdef1"}}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const r = Bun.spawnSync(["python3", "-B", join(KIT, "fm-prwatch")], {
    env: {
      ...env, PATH: `${bin}:${env.PATH}`, FM_BIN: FM, FM_PRWATCH_LOG: join(dir, "prwatch.log"),
      FM_PRWATCH_STATE: join(dir, "prw-state.json"), FM_PRWATCH_RUNNING: join(dir, "running.json"),
    },
  });
  expect(r.exitCode).toBe(0);
  expect(card("c").s).toBe("done");
});

test("fm-autoclear passes --from and skips the rest of a card's actions when it moved", () => {
  // R7: a waiting card without a q/src link gets the "no owner link" flag. Another writer moves it first.
  items([{ id: "w", t: "W", s: "waiting", action: "do it", area: "x" }]);
  const r = Bun.spawnSync(["python3", "-B", join(KIT, "fm-autoclear")], {
    env: { ...env, FM_BIN: racer("w", "partial", "owner answered") },
  });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(out).toContain("R7 no owner link");
  const log = readFileSync(join(dir, "autoclear.log"), "utf8");
  expect(log).toContain("SKIPPED: card moved");
  expect(card("w")).toMatchObject({ s: "partial", n: "owner answered" });
});
