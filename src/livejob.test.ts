import { expect, test } from "bun:test";
import { busyReply, liveJobBusy } from "./mirror.ts";

const G = "/home/u/Github";
const base = { machine: "main", cwd: `${G}/tools/wt-demo-ideas`, github: G, live: true, firstmate: false };

test("live job pane in a project folder: busy, no new run", () => {
  expect(liveJobBusy(base)).toBe(true);
});
test("no live job: run starts", () => {
  expect(liveJobBusy({ ...base, live: false })).toBe(false);
});
test("FIRSTMATE, archived, ~/Github root and Mac panes are not blocked", () => {
  expect(liveJobBusy({ ...base, firstmate: true })).toBe(false);
  expect(liveJobBusy({ ...base, archived: true })).toBe(false);
  expect(liveJobBusy({ ...base, cwd: G })).toBe(false);
  expect(liveJobBusy({ ...base, machine: "mac" })).toBe(false);
});
test("refusal reply names the live job", () => {
  const r = busyReply("demo-ideas", "wB:tNK", `${G}/tools/wt-demo-ideas`);
  expect(r).toContain("wB:tNK");
  expect(r).toContain("demo-ideas");
  expect(r).toContain("Not started");
});
