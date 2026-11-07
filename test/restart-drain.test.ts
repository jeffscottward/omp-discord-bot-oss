// Plan P1: restart without starvation. Queue drain, saved queue, POST /drain and the restart waiter script.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHttp } from "../src/http.ts";
import { pendingLine } from "../src/pending.ts";
import { JobQueue } from "../src/queue.ts";
import { loadQueueState, queueFile, saveQueueState, type SavedJob } from "../src/queuestate.ts";

// Time budget for this file only (card bot-gate-flake, 2026-11-03): the restart-when-idle.sh tests run the real
// waiter for up to ~30 polls (curl and jq each). Alone the slowest takes about 0.6 s; in full-suite runs at host load
// 60-100 the give-up tests passed bun's 5 s default and failed. A hung waiter still fails at 20 s.
setDefaultTimeout(20_000);

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("JobQueue drain", () => {
  test("no new job starts while draining; running jobs finish; kick resumes after the drain ends", async () => {
    let now = 1_000;
    const q = new JobQueue<number>(2, { now: () => now });
    const order: string[] = [];
    const gates: Record<string, () => void> = {};
    const mk = (name: string, key: string) => {
      const { promise, resolve } = Promise.withResolvers<number>();
      gates[name] = () => resolve(1);
      return { key, label: name, run: () => (order.push(name), promise), onDone: () => {} };
    };
    q.enqueue(mk("a", "k1"));
    await tick();
    expect(q.drain(60_000)).toEqual({ draining: true, since: 1_000, until: 61_000 });
    q.enqueue(mk("b", "k2"));
    await tick();
    expect(order).toEqual(["a"]);
    gates.a!();
    await tick();
    expect(q.status().running).toEqual([]);
    expect(q.status().queued.map((j) => j.label)).toEqual(["b"]);
    // Renewing keeps the first start time.
    now = 30_000;
    expect(q.drain(60_000).since).toBe(1_000);
    now = 90_001;
    expect(q.draining()).toBe(false);
    expect(q.drainInfo()).toEqual({ draining: false, since: 0, until: 0 });
    q.kick();
    await tick();
    expect(order).toEqual(["a", "b"]);
  });

  test("drain(0) ends the drain and starts waiting jobs at once", async () => {
    const q = new JobQueue<number>(1, { now: () => 5 });
    const order: string[] = [];
    q.drain(1_000);
    q.enqueue({ key: "k", label: "x", run: async () => (order.push("x"), 1), onDone: () => {} });
    await tick();
    expect(order).toEqual([]);
    q.drain(0);
    await tick();
    expect(order).toEqual(["x"]);
  });

  test("startId and onChange (enqueue, start, cancel)", () => {
    const q = new JobQueue<number>(1, { startId: 41 });
    let changes = 0;
    q.onChange = () => changes++;
    const never = () => new Promise<number>(() => {});
    const a = q.enqueue({ key: "a", label: "a", run: never, onDone: () => {} });
    const b = q.enqueue({ key: "b", label: "b", run: never, onDone: () => {} });
    expect([a.id, b.id]).toEqual([41, 42]);
    expect(q.peekNextId()).toBe(43);
    expect(q.cancel(b.id)).toBe(true);
    // a: start + enqueue; b: enqueue; cancel.
    expect(changes).toBe(4);
  });
});

describe("saved queue (queue.json)", () => {
  const job = (id: number, at: number): SavedJob => ({ id, channelId: "123", messageId: String(900 + id), authorId: "7", text: `job ${id}`, enqueuedAt: at });
  test("round trip, sorted by time, mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "queuestate-"));
    expect(saveQueueState(dir, { nextId: 9, jobs: [job(2, 20), job(1, 10)] })).toBe(true);
    expect(statSync(queueFile(dir)).mode & 0o777).toBe(0o600);
    const s = loadQueueState(dir);
    expect(s.nextId).toBe(9);
    expect(s.jobs.map((j) => j.id)).toEqual([1, 2]);
  });
  test("missing or bad file: empty queue; bad records dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "queuestate-"));
    expect(loadQueueState(dir)).toEqual({ nextId: 1, jobs: [] });
    writeFileSync(queueFile(dir), "{not json");
    expect(loadQueueState(dir)).toEqual({ nextId: 1, jobs: [] });
    writeFileSync(queueFile(dir), JSON.stringify({ nextId: 3, jobs: [job(1, 1), { id: 2, channelId: "../x", messageId: "1", authorId: "7", text: "t", enqueuedAt: 2 }, null] }));
    expect(loadQueueState(dir).jobs.map((j) => j.id)).toEqual([1]);
  });
});

describe("board line while draining", () => {
  test("says new jobs wait and run after the restart", () => {
    const l = pendingLine({ updates: 2 }, ["#dev"], true)!;
    expect(l).toContain("Restart pending");
    expect(l).toContain("New jobs wait");
    expect(l).not.toContain("Still busy");
    expect(pendingLine(null, [], true)).toContain("no new code");
  });
});

describe("POST /drain", () => {
  const calls: [boolean, number | undefined][] = [];
  const srv = startHttp(
    { post: async () => {}, health: () => ({}), drain: (on, ttl) => (calls.push([on, ttl]), { draining: on, since: 1, until: on ? 2 : 0 }) },
    0, // OS-assigned (port clash 2026-10-23)
  );
  const post = (body: unknown, type = "application/json") =>
    globalThis.fetch(`http://127.0.0.1:${srv.port}/drain`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  test("on/off with a capped ttl; bad bodies rejected", async () => {
    expect(await (await post({ on: true, ttlSec: 120 })).json()).toEqual({ ok: true, draining: true, since: 1, until: 2 });
    await post({ on: true, ttlSec: 99_999 });
    await post({ on: false });
    expect(calls).toEqual([[true, 120_000], [true, 1_800_000], [false, undefined]]);
    expect((await post({ on: "yes" })).status).toBe(400);
    expect((await post({ on: true, ttlSec: -1 })).status).toBe(400);
    expect((await post({ on: true }, "text/plain")).status).toBe(415);
    expect(calls.length).toBe(3);
    srv.stop(true);
  });
});

/**
 * The waiter script against a fake bot API. Sleeps are a no-op (OMP_RESTART_SLEEP=true), so the
 * script's own counter is the clock: each poll adds 10 s.
 */
describe("restart-when-idle.sh", () => {
  const SCRIPT = resolve(import.meta.dir, "../scripts/restart-when-idle.sh");
  async function run(opts: { ciFails?: boolean; gateFails?: boolean; giveUpAfter?: number; headMoves?: boolean; health: (n: number, drained: boolean) => object }) {
    const dir = mkdtempSync(join(tmpdir(), "rwi-"));
    const notes = join(dir, "notes");
    const safeLog = join(dir, "safe.log");
    // The fake notify logs the channel and args and answers like notify-owner.ts ("posted <id>").
    writeFileSync(join(dir, "notify"), `#!/bin/sh\nn=$(( $(cat ${dir}/cnt 2>/dev/null || echo 0) + 1 )); echo $n > ${dir}/cnt\nprintf 'ch=%s %s\\n---\\n' "\${OMP_NOTIFY_CHANNEL:-default}" "$*" >> ${notes}\necho "posted 90$n"\n`, { mode: 0o755 });
    writeFileSync(join(dir, "safe"), `#!/bin/sh\necho called >> ${safeLog}\necho "OK: healthy at abc"\n`, { mode: 0o755 });
    writeFileSync(join(dir, "gate"), opts.gateFails ? "#!/bin/sh\necho 'GATE FAIL at abc: tests (bun test)'\nexit 1\n" : "#!/bin/sh\necho 'GATE OK at abc'\n", { mode: 0o755 });
    writeFileSync(join(dir, "ci"), opts.ciFails ? `#!/bin/sh\necho "$1 $2" >> ${dir}/ci.log\necho 'CI NOT GREEN at aaaaaaa: pipeline none'\nexit 2\n` : `#!/bin/sh\necho "$1 $2" >> ${dir}/ci.log\necho 'CI GREEN at aaaaaaa'\n`, { mode: 0o755 });
    // Fake HEAD: the first call (before the gate) prints sha A; later calls print B when headMoves.
    writeFileSync(join(dir, "head"), `#!/bin/sh\nn=$(( $(cat ${dir}/hcnt 2>/dev/null || echo 0) + 1 )); echo $n > ${dir}/hcnt\nif [ $n -gt 1 ] && [ "${opts.headMoves ? 1 : 0}" = 1 ]; then echo bbbbbbbbbb; else echo aaaaaaaaaa; fi\n`, { mode: 0o755 });
    let polls = 0;
    let drained = false;
    const drains: { on: boolean; ttlSec: number }[] = [];
    const posts: { channel: string; text: string }[] = [];
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") return Response.json(opts.health(polls++, drained));
        if (url.pathname === "/drain") {
          const b = (await req.json()) as { on: boolean; ttlSec: number };
          drains.push(b);
          drained = b.on;
          return Response.json({ ok: true, draining: b.on });
        }
        if (url.pathname === "/post") {
          posts.push((await req.json()) as { channel: string; text: string });
          return Response.json({ ok: true, channel: "omp-alerts" });
        }
        return new Response("no", { status: 404 });
      },
    });
    const p = Bun.spawn(["bash", SCRIPT], {
      env: {
        ...process.env,
        OMP_BOT_HTTP_PORT: String(srv.port),
        OMP_RESTART_SLEEP: "true",
        OMP_RESTART_SAFE: join(dir, "safe"),
        OMP_RESTART_GATE: join(dir, "gate"),
        OMP_RESTART_NOTIFY: join(dir, "notify"),
        OMP_RESTART_LOCK: join(dir, "lock"),
        OMP_RESTART_HEAD: join(dir, "head"),
        OMP_RESTART_CI: join(dir, "ci"),
        OMP_RESTART_DRAIN_AFTER: "30",
        ...(opts.giveUpAfter ? { OMP_RESTART_GIVE_UP_AFTER: String(opts.giveUpAfter) } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    srv.stop(true);
    const read = (f: string) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    };
    return { code, drains, posts, polls, notes: read(notes), safeCalls: read(safeLog).split("\n").filter(Boolean).length, ciLog: read(join(dir, "ci.log")) };
  }
  const busy = { ready: true, voice: false, running: [{ id: 1 }], queued: [{ id: 2, key: "mirror-123" }], finishing: 0, boards: 0, approvals: 0 };

  test("starved queue: drains after the limit, restarts with jobs still queued", async () => {
    // Without a drain the channel never becomes idle; with it, the running job ends.
    const r = await run({ health: (_n, drained) => (drained ? { ...busy, running: [], drain: { draining: true } } : busy) });
    expect(r.code).toBe(0);
    expect(r.safeCalls).toBe(1);
    expect(r.drains[0]).toEqual({ on: true, ttlSec: 120 });
    // Held for the restart checks; not turned off after a good restart (the bot restarted).
    expect(r.drains.at(-1)).toEqual({ on: true, ttlSec: 1800 });
    // UX item 6: no drain notice in the owner channel; Restarting + Done only where the job waited (channel 123),
    // and the Restarting post is deleted when Restart done is posted.
    expect(r.notes).not.toContain("ch=default");
    expect(r.notes).not.toContain("New jobs now wait");
    const notes = r.notes.split("\n---\n").filter(Boolean);
    expect(notes.length).toBe(3);
    expect(notes[0]).toContain("ch=123");
    expect(notes[0]).toContain("Restarting the bot now");
    expect(notes[1]).toBe("ch=123 --delete 901");
    expect(notes[2]).toContain("ch=123");
    expect(notes[2]).toContain("Restart done");
  });

  test("quiet restart (nothing waits): no notice at all", async () => {
    const r = await run({ health: () => ({ ...busy, running: [], queued: [] }) });
    expect(r.code).toBe(0);
    expect(r.safeCalls).toBe(1);
    expect(r.notes).toBe("");
  });

  test("gate failure: no wait, no restart, the reason is posted", async () => {
    const r = await run({ gateFails: true, health: () => busy });
    expect(r.code).toBe(3);
    expect(r.safeCalls).toBe(0);
    expect(r.drains).toEqual([]);
    expect(r.notes).toContain("Restart skipped");
    expect(r.notes).toContain("tests (bun test)");
  });

  test("voice call: never drains; the drain is turned off when the owner joins", async () => {
    // Polls 0-5 busy without voice (drain starts at 30 s), 6-8 voice (drain must end), then idle.
    const r = await run({
      health: (n) => (n < 6 ? busy : n < 9 ? { ...busy, voice: true } : { ...busy, running: [], queued: [] }),
    });
    expect(r.code).toBe(0);
    const firstOff = r.drains.findIndex((d) => !d.on);
    expect(r.drains[0]!.on).toBe(true);
    expect(firstOff).toBeGreaterThan(0);
  });

  test("give-up: after the limit busy, the restart is dropped with ONE #omp-alerts notice", async () => {
    const stuck = { ...busy, running: [{ id: 1, label: "#dev long build" }], approvals: 1 };
    const r = await run({ giveUpAfter: 120, health: () => stuck });
    expect(r.code).toBe(4);
    expect(r.safeCalls).toBe(0);
    // The drain was on (after 30 s) and is turned off again, so queued jobs run.
    expect(r.drains[0]).toEqual({ on: true, ttlSec: 120 });
    expect(r.drains.at(-1)!.on).toBe(false);
    expect(r.posts.length).toBe(1);
    expect(r.posts[0]!.channel).toBe("omp-alerts");
    expect(r.posts[0]!.text).toContain("Bot restart abandoned");
    expect(r.posts[0]!.text).toContain("2 min");
    expect(r.posts[0]!.text).toContain("1 running job(s), 1 queued job(s), 1 approved command(s)");
    expect(r.posts[0]!.text).toContain("#dev long build");
    expect(r.notes).not.toContain("Restarting the bot now");
    // 12 busy polls of 10 s reach 120 s.
    expect(r.polls).toBe(12);
  });

  test("give-up: time in the voice call does not count", async () => {
    // 6 busy polls, 20 voice polls (200 s > limit), then 3 busy, then idle: no give-up.
    const r = await run({
      giveUpAfter: 100,
      health: (n) => (n < 6 || (n >= 26 && n < 29) ? busy : n < 26 ? { ...busy, voice: true } : { ...busy, running: [], queued: [] }),
    });
    expect(r.code).toBe(0);
    expect(r.posts).toEqual([]);
    expect(r.safeCalls).toBe(1);
  });

  test("quiet router stacks in /health do not make a busy bot look idle", async () => {
    // /health carries stacks[] with their own empty running/queued lists; only the top-level lists count.
    const quietStacks = { stacks: [{ stack: "infra", running: [], queued: [], done: 0, failed: 0 }] };
    const r = await run({ giveUpAfter: 60, health: () => ({ ...busy, ...quietStacks, queued: [] }) });
    expect(r.code).toBe(4);
    expect(r.safeCalls).toBe(0);
  });

  test("give-up limit is 2 h by default", () => {
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/^GIVE_UP_AFTER_DEFAULT=7200\b/m);
  });

  test("HEAD moves during the gate/wait: no restart at the unchecked commit, ONE #omp-alerts notice", async () => {
    const r = await run({ headMoves: true, health: () => ({ ...busy, running: [], queued: [] }) });
    expect(r.code).toBe(5);
    expect(r.safeCalls).toBe(0);
    expect(r.posts.length).toBe(1);
    expect(r.posts[0]!.channel).toBe("omp-alerts");
    expect(r.posts[0]!.text).toContain("aaaaaaa");
    expect(r.posts[0]!.text).toContain("bbbbbbb");
    expect(r.notes).not.toContain("Restarting the bot now");
  });

  test("CI not green for the gated SHA: no drain, no restart, the reason is posted", async () => {
    const r = await run({ ciFails: true, health: () => ({ ...busy, running: [], queued: [] }) });
    expect(r.code).toBe(6);
    expect(r.safeCalls).toBe(0);
    expect(r.drains).toEqual([]);
    expect(r.ciLog).toBe("aaaaaaaaaa 1800\n");
    expect(r.notes).toContain("no green GitLab pipeline");
    expect(r.notes).toContain("aaaaaaa");
  });

  test("green CI: the CI check runs on the gated SHA before the restart", async () => {
    const r = await run({ health: () => ({ ...busy, running: [], queued: [] }) });
    expect(r.code).toBe(0);
    expect(r.ciLog).toBe("aaaaaaaaaa 1800\n");
    expect(r.safeCalls).toBe(1);
  });

  test("safe-restart.sh checks CI for the exact loaded SHA inside the lock, after the HEAD check", () => {
    const src = readFileSync(resolve(import.meta.dir, "../scripts/safe-restart.sh"), "utf8");
    const ci = src.indexOf('scripts/ci-green.sh} "$NOW" 0');
    expect(ci).toBeGreaterThan(src.indexOf('[ "$NOW" != "$GATED" ]'));
    expect(ci).toBeLessThan(src.indexOf('systemctl --user restart "$UNIT"'));
  });

  test("safe-restart.sh re-checks HEAD after its own gate", () => {
    const src = readFileSync(resolve(import.meta.dir, "../scripts/safe-restart.sh"), "utf8");
    expect(src.indexOf('GATED="$(git rev-parse HEAD)"')).toBeLessThan(src.indexOf("scripts/restart-gate.sh 2>&1"));
    expect(src.indexOf("git diff --quiet HEAD")).toBeLessThan(src.indexOf('GATED="$(git rev-parse HEAD)"'));
    expect(src.indexOf("flock -w 30 8")).toBeLessThan(src.indexOf('NOW="$(git rev-parse HEAD)"'));
    expect(src.indexOf('[ "$NOW" != "$GATED" ]')).toBeLessThan(src.indexOf('systemctl --user restart "$UNIT"'));
  });
});

/** scripts/ci-green.sh against a fake GitLab pipelines API. */
describe("ci-green.sh", () => {
  const SCRIPT = resolve(import.meta.dir, "../scripts/ci-green.sh");
  async function ci(statuses: string[][], wait = 0) {
    const dir = mkdtempSync(join(tmpdir(), "cig-"));
    writeFileSync(join(dir, "tok"), "t0k\n");
    let n = 0;
    const seen: string[] = [];
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        seen.push(`${u.searchParams.get("sha")} ${req.headers.get("private-token")}`);
        const list = statuses[Math.min(n++, statuses.length - 1)]!;
        return Response.json(list.map((status, i) => ({ id: 100 - i, status })));
      },
    });
    const p = Bun.spawn(["bash", SCRIPT, "abcdef1234", String(wait)], {
      env: { ...process.env, OMP_GITLAB_API: `http://127.0.0.1:${srv.port}`, OMP_GITLAB_TOKEN_FILE: join(dir, "tok"), OMP_CI_SLEEP: "true", OMP_CI_POLL: "10" },
      stdout: "pipe",
    });
    const code = await p.exited;
    const out = await new Response(p.stdout).text();
    srv.stop(true);
    return { code, out, seen };
  }
  test("success for the exact SHA = 0; token sent as header, never printed", async () => {
    const r = await ci([["success"]]);
    expect(r.code).toBe(0);
    expect(r.seen[0]).toBe("abcdef1234 t0k");
    expect(r.out).not.toContain("t0k");
  });
  test("no pipeline = 2; failed = 1; a retried success after a failure = 0", async () => {
    expect((await ci([[]])).code).toBe(2);
    expect((await ci([["failed"]])).code).toBe(1);
    expect((await ci([["failed", "success"]])).code).toBe(0);
  });
  test("pending is awaited up to the limit", async () => {
    expect((await ci([["running"], ["running"], ["success"]], 60)).code).toBe(0);
    const r = await ci([["pending"]], 30);
    expect(r.code).toBe(2);
    expect(r.seen.length).toBe(4);
  });
});
