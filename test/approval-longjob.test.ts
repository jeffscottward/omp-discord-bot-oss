import { afterEach, expect, test, vi } from "bun:test";
import { APPROVAL_RUN_TIMEOUT_MS, fmtMin, longjobExitCode, startHeartbeat } from "../gate/longjob.ts";

afterEach(() => vi.useRealTimers());

test("approved jobs may run 4 hours", () => {
  expect(APPROVAL_RUN_TIMEOUT_MS).toBe(4 * 60 * 60_000);
  expect(fmtMin(APPROVAL_RUN_TIMEOUT_MS)).toBe("4 h 0 min");
  expect(fmtMin(5 * 60_000)).toBe("5 min");
});

test("short job: no status lines and no final line", async () => {
  vi.useFakeTimers();
  const posts: string[] = [];
  const hb = startHeartbeat("job A", { post: async (t) => void posts.push(t) });
  vi.advanceTimersByTime(4 * 60_000);
  await hb.stop("exit 0");
  vi.advanceTimersByTime(60 * 60_000);
  expect(posts).toEqual([]);
});

test("long job: one status line per 5 minutes, then one final line; nothing after stop", async () => {
  vi.useFakeTimers();
  let clock = 0;
  const posts: string[] = [];
  const hb = startHeartbeat("job B", { post: async (t) => void posts.push(t), now: () => clock });
  for (let i = 0; i < 3; i++) {
    clock += 5 * 60_000;
    vi.advanceTimersByTime(5 * 60_000);
  }
  await hb.stop("exit 3");
  vi.advanceTimersByTime(60 * 60_000);
  expect(hb.beats).toBe(3);
  expect(posts).toHaveLength(4);
  expect(posts[0]).toBe("⏳ **Still running** (5 min; limit 4 h 0 min): job B");
  expect(posts[2]).toBe("⏳ **Still running** (15 min; limit 4 h 0 min): job B");
  expect(posts[3]).toBe("🏁 **Ended** after 15 min: job B — exit 3");
});

test("longjob exit code: planned stop is 0, timeout 124, real failures kept", () => {
  const e = (code: number | null, sig: string | null, stopSignal = "", timedOut = false) => longjobExitCode({ code, sig, stopSignal, timedOut });
  expect(e(null, "SIGTERM", "SIGTERM")).toBe(0);
  expect(e(143, null, "SIGTERM")).toBe(0);
  expect(e(130, null, "SIGINT")).toBe(0);
  expect(e(0, null, "SIGHUP")).toBe(0);
  expect(e(3, null, "SIGTERM")).toBe(3);
  expect(e(null, "SIGTERM", "", true)).toBe(124);
  expect(e(null, "SIGKILL")).toBe(128);
  expect(e(null, "SIGTERM")).toBe(143);
  expect(e(5, null)).toBe(5);
});

test("longjob CLI: SIGTERM to longjob exits 0", async () => {
  const p = Bun.spawn(["bun", "gate/longjob.ts", "--", "sleep", "30"], { env: { ...process.env, OMP_LONGJOB_DISABLE: "1" } });
  await Bun.sleep(700);
  p.kill("SIGTERM");
  expect(await p.exited).toBe(0);
  const q = Bun.spawn(["bun", "gate/longjob.ts", "--", "sh", "-c", "exit 3"], { env: { ...process.env, OMP_LONGJOB_DISABLE: "1" } });
  expect(await q.exited).toBe(3);
}, 15_000);
