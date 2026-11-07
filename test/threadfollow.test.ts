import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { IDLE_LEAVE_MS, ThreadFollow, activeStacks, planFollow } from "../src/threadfollow.ts";

const known = new Set(["bot", "discord", "webapp"]);
describe("planFollow", () => {
  test("owner 2026-11-07: adds every stack thread the owner is not in (active or not); skips members", () => {
    const p = planFollow(new Set(["bot", "webapp"]), known, { member: { webapp: true, discord: false }, lastActive: {} }, 0);
    expect(p).toEqual({ add: ["bot", "discord"], remove: [] });
  });
  test("with leave on (old mode), only active non-members are added", () => {
    const p = planFollow(new Set(["bot", "webapp"]), known, { member: { webapp: true, discord: false }, lastActive: {} }, 0, true);
    expect(p.add).toEqual(["bot"]);
  });
  test("removes only after 30 idle min", () => {
    const st = { member: { bot: true }, lastActive: { bot: 1000 } };
    expect(planFollow(new Set(), new Set(["bot"]), st, 1000 + IDLE_LEAVE_MS - 1, true).remove).toEqual([]);
    expect(planFollow(new Set(), new Set(["bot"]), st, 1000 + IDLE_LEAVE_MS, true).remove).toEqual(["bot"]);
  });
  test("ignores stacks without a thread", () => {
    expect(planFollow(new Set(["kb"]), new Set(["bot"]), { member: { bot: true }, lastActive: {} }, 0).add).toEqual([]);
  });
});

describe("ThreadFollow", () => {
  test("one call per change; restart grace; leave after idle", async () => {
    const calls: string[] = [];
    const f = new ThreadFollow({ join: async (id) => void calls.push(`+${id}`), leave: async (id) => void calls.push(`-${id}`) });
    const th = { bot: "T1", discord: "T2" };
    await f.tick(new Set(["bot"]), th, 0);
    await f.tick(new Set(["bot"]), th, 60_000);
    expect(calls).toEqual(["+T1", "+T2"]); // every stack thread once, active or not
    await f.tick(new Set(), th, 3 * IDLE_LEAVE_MS);
    expect(calls).toEqual(["+T1", "+T2"]); // leave is off: no remove line
    await f.tick(new Set(["bot"]), th, 4 * IDLE_LEAVE_MS);
    expect(calls).toEqual(["+T1", "+T2"]); // still a member: no second add line
  });
  test("activeStacks counts running/queued only", () => {
    expect([...activeStacks([{ stack: "a", state: "running" }, { stack: "b", state: "done" }, { stack: "c", state: "queued" }, { state: "running" }])]).toEqual(["a", "c"]);
  });
});

describe("ThreadFollow persistence", () => {
  test("a restart keeps lastActive and membership: idle timer is not reset", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tf-")), "thread-follow.json");
    const calls: string[] = [];
    const api = { join: async (id: string) => void calls.push(`+${id}`), leave: async (id: string) => void calls.push(`-${id}`) };
    const th = { bot: "T1" };
    await new ThreadFollow(api, () => {}, file).tick(new Set(["bot"]), th, 0);
    const b = new ThreadFollow(api, () => {}, file); // restart
    await b.tick(new Set(), th, 20 * 60_000);
    await b.tick(new Set(["bot"]), th, IDLE_LEAVE_MS);
    expect(calls).toEqual(["+T1"]); // saved membership: no repeat add after restart
  });
});

describe("ThreadFollow review fixes", () => {
  test("recreated thread is joined again; failed join backs off", async () => {
    const calls: string[] = [];
    let fail = true;
    const f = new ThreadFollow({ join: async (id) => { calls.push(`+${id}`); if (fail) throw new Error("x"); }, leave: async () => {} });
    await f.tick(new Set(["bot"]), { bot: "T1" }, 0);
    await f.tick(new Set(["bot"]), { bot: "T1" }, 60_000);
    expect(calls).toEqual(["+T1"]); // backoff: no call each refresh
    fail = false;
    await f.tick(new Set(["bot"]), { bot: "T1" }, 31 * 60_000);
    await f.tick(new Set(["bot"]), { bot: "T2" }, 32 * 60_000);
    expect(calls).toEqual(["+T1", "+T1", "+T2"]);
  });
});

test("idle archived thread: join deferred, not counted as member (owner 2026-11-07)", async () => {
  const calls: string[] = [];
  const f = new ThreadFollow({ join: async (id, active) => { calls.push(`${id}:${active}`); return active; }, leave: async () => {} });
  await f.tick(new Set(), { fun: "T9" }, 0);
  await f.tick(new Set(["fun"]), { fun: "T9" }, 60_000);
  expect(calls).toEqual(["T9:false", "T9:true"]);
});
