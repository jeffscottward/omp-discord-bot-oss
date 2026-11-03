import { describe, expect, test } from "bun:test";
import { jobRouteClickAllowed, matchJob, openJobs, type OpenJob } from "./jobmatch.ts";
import type { FmCard } from "./masterqueue.ts";

const cards: FmCard[] = [
  { id: "webapp-adx-filter", t: "Webapp: test ADX as strategy filter + add Relative Volume at Time", s: "running", stack: "webapp", job: "wB:pYK" },
  { id: "ci-speed-audit", t: "CI speed audit: ExampleFactory, Webapp, Client Co", s: "partial", stack: "webapp", job: "CI audit" },
  { id: "webapp-done", t: "Webapp old job", s: "done", stack: "webapp", job: "wB:p1" },
  { id: "webapp-nochan", t: "Webapp no channel", s: "running", stack: "webapp", job: "gone" },
  { id: "infra-x", t: "Infra job", s: "running", stack: "infra", job: "wB:p2" },
];
const chans: Record<string, string> = { "wb:pyk": "c1", "ci audit": "c2", "wb:p1": "c3", "wb:p2": "c4" };
const channelFor = (t: string) => chans[t.toLowerCase()];

describe("openJobs", () => {
  test("keeps open cards of the stack with a mapped channel", () => {
    expect(openJobs(cards, "webapp", channelFor).map((j) => [j.id, j.channelId])).toEqual([
      ["webapp-adx-filter", "c1"],
      ["ci-speed-audit", "c2"],
    ]);
  });
  test("accepts a job list", () => {
    expect(openJobs([{ id: "a", s: "waiting", stack: "infra", job: ["nope", "wB:p2"] }], "infra", channelFor)[0]?.channelId).toBe("c4");
  });
});

describe("matchJob", () => {
  const jobs: OpenJob[] = openJobs(cards, "webapp", channelFor);
  test("no open job -> none", async () => {
    expect((await matchJob("anything about adx", [])).kind).toBe("none");
  });
  test("card id in the text -> match", async () => {
    const m = await matchJob("for ci-speed-audit also check the cache", jobs);
    expect(m.kind === "match" && m.job.id).toBe("ci-speed-audit");
  });
  test("clear keyword overlap -> match", async () => {
    const m = await matchJob("ADX filter results: also try relative volume at a 20 day window", jobs);
    expect(m.kind === "match" && m.job.id).toBe("webapp-adx-filter");
  });
  test("only the stack name/keywords shared -> none", async () => {
    expect((await matchJob("new webapp idea: momentum screener", jobs, undefined, 0.8, 4000, ["webapp"])).kind).toBe("none");
  });
  test("weak overlap, no judge -> unsure (menu)", async () => {
    const m = await matchJob("what about the ADX filter numbers", jobs);
    expect(m.kind).toBe("unsure");
    expect(m.kind !== "none" && m.job.id).toBe("webapp-adx-filter");
  });
  test("no overlap -> none (new job)", async () => {
    expect((await matchJob("build a momentum screener", jobs)).kind).toBe("none");
  });
  test("judge confident job -> match; confident new -> none; low -> unsure", async () => {
    const m1 = await matchJob("how is it going with that", jobs, async () => ({ choice: "ci-speed-audit", confidence: 0.9 }));
    expect(m1.kind === "match" && m1.job.id).toBe("ci-speed-audit");
    expect((await matchJob("build a momentum screener", jobs, async () => ({ choice: "new", confidence: 0.95 }))).kind).toBe("none");
    expect((await matchJob("build a momentum screener", jobs, async () => ({ choice: "ci-speed-audit", confidence: 0.5 }))).kind).toBe("unsure");
  });
  test("judge error falls back to keywords; financial text skips the judge", async () => {
    expect((await matchJob("ADX filter numbers", jobs, async () => { throw new Error("x"); })).kind).toBe("unsure");
    let called = false;
    await matchJob("pay 100 usd", jobs, async () => ((called = true), null));
    expect(called).toBe(false);
  });
});

describe("privacy and timeout", () => {
  const trade: FmCard[] = [{ id: "budget-batch", t: "Pay invoice batch 40 usd", s: "running", stack: "finance", job: "wB:pYK" }];
  test("finance card title never shown; keywords still match locally; no judge", async () => {
    const jobs = openJobs(trade, "finance", channelFor);
    expect(jobs[0]?.title).toBe("Finance card: budget-batch");
    let called = false;
    const m = await matchJob("about the budget invoice batch", jobs, async () => ((called = true), null));
    expect(called).toBe(false);
    expect(m.kind === "match" && m.job.id).toBe("budget-batch");
  });
  test("a hung judge times out to the keyword result", async () => {
    const jobs = openJobs(cards, "webapp", channelFor);
    const t0 = Date.now();
    const m = await matchJob("what about the ADX filter numbers", jobs, () => new Promise(() => {}), 0.8, 50);
    expect(m.kind).toBe("unsure");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("jobRouteClickAllowed", () => {
  test("owner on the bot's menu only", () => {
    expect(jobRouteClickAllowed("owner", "owner", "bot", "bot")).toBe(true);
    expect(jobRouteClickAllowed("someone", "owner", "bot", "bot")).toBe(false);
    expect(jobRouteClickAllowed("owner", "owner", "other", "bot")).toBe(false);
    expect(jobRouteClickAllowed("owner", "owner", "bot", undefined)).toBe(false);
  });
});
