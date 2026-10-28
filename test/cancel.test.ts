import { expect, test } from "bun:test";
import { cancelQueuedJob } from "../src/cancel.ts";

// A cancelled queued job must leave its channel's ⏳ Queue board at once.
function setup(queued: number[]) {
  const q = new Set(queued);
  const jobKeys = new Map([[1, "chanA"], [2, "chanB"]]);
  const links = new Map([[1, "https://discord.com/x"]]);
  const owner = new Map([[1, "https://discord.com/y"]]);
  const redrawn: string[] = [];
  const cleaned: number[] = [];
  const deps = {
    cancel: (id: number) => q.delete(id),
    jobKeys,
    maps: [links, owner],
    cleanup: (id: number) => void cleaned.push(id),
    redraw: (ch: string) => void redrawn.push(ch),
  };
  return { deps, jobKeys, links, owner, redrawn, cleaned };
}

test("cancel redraws the job's own channel board and forgets every per-job entry", () => {
  const s = setup([1, 2]);
  expect(cancelQueuedJob(1, s.deps)).toBe(true);
  expect(s.redrawn).toEqual(["chanA"]); // the channel is read before the key is deleted
  expect(s.jobKeys.has(1)).toBe(false);
  expect(s.links.has(1)).toBe(false);
  expect(s.owner.has(1)).toBe(false);
  expect(s.cleaned).toEqual([1]);
  expect(s.jobKeys.get(2)).toBe("chanB");
});

test("a job that is not queued (running or done) changes nothing", () => {
  const s = setup([2]);
  expect(cancelQueuedJob(1, s.deps)).toBe(false);
  expect(s.redrawn).toEqual([]);
  expect(s.jobKeys.get(1)).toBe("chanA");
  expect(s.cleaned).toEqual([]);
});
