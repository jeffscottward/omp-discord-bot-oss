import { afterEach, expect, test } from "bun:test";
import { channelMention, mentionable, safeTitle, setMentionCheck } from "../src/mention.ts";
import { botRows, cardRows, renderMasterPages, rowLine } from "../src/masterqueue.ts";
import { StackRouter } from "../src/stackroute.ts";

const LIVE = "100000000000000023";
const DEAD = "100000000000000049";
afterEach(() => setMentionCheck(null));

test("channelMention: dead or bad id -> plain-text fallback, never <#id>", () => {
  setMentionCheck((id) => id === LIVE);
  expect(channelMention(LIVE)).toBe(`<#${LIVE}>`);
  expect(channelMention(DEAD, "📈 finance stack")).toBe("📈 finance stack");
  expect(channelMention("", "x")).toBe("x");
  expect(channelMention("unknown", "x")).toBe("x");
});

test("safeTitle never returns a placeholder", () => {
  expect(safeTitle("card", "example-data-source")).toBe("example-data-source");
  expect(safeTitle("", "card", "job:7")).toBe("job:7");
  expect(safeTitle("Real title")).toBe("Real title");
});

test("Master queue with a dead stack thread and dead job channel: no unknown mention, no 'card' title", () => {
  setMentionCheck((id) => id === LIVE);
  const now = Date.now();
  const res = { stackChannel: (s: string) => (s === "finance" ? DEAD : LIVE), areaStack: (a: string) => a, job: () => ({ channelId: DEAD, tab: "dataload" }) };
  const rows = [
    ...cardRows([{ id: "example-data-source", area: "finance", s: "partial", job: "wB:pV1", cts: now }, { id: "x1", t: "card", stack: "general", s: "running", job: "wB:pV2", cts: now }], new Map(), now, "https://d/", res),
    ...botRows([{ id: 5, title: "card", channelId: DEAD, running: true, since: now, stack: "finance" }], [], now, res),
  ];
  const text = renderMasterPages(rows, now, "https://d/").join("\n") + rows.map((r) => rowLine(r, now)).join("\n");
  expect(text).not.toContain(`<#${DEAD}>`);
  expect(text).not.toMatch(/<#(?!\d+>)/);
  for (const r of rows) expect(rowLine(r, now)).not.toMatch(/^\S+ card ·/);
  expect(text).toContain(`<#${LIVE}>`);
});

test("StackRouter.pruneGone drops gone thread ids only", async () => {
  const r = Object.create(StackRouter.prototype) as any;
  r.st = { threads: { finance: DEAD, kb: LIVE, net: "100000000000000044" }, msgs: {} };
  r.live = new Map(); r.tracker = { threads: {} }; r.opts = { stateFile: "/tmp/nu-router-test.json" };
  const dropped = await r.pruneGone(async (id: string) => {
    if (id === DEAD) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
    if (id === "100000000000000044") throw Object.assign(new Error("502"), { code: 0 });
    return {};
  });
  expect(dropped).toEqual(["finance"]);
  expect(r.st.threads).toEqual({ kb: LIVE, net: "100000000000000044" });
});

test("grep check: no raw <#${ outside mention.ts", () => {
  const p = Bun.spawnSync(["bash", "scripts/check-mentions.sh"]);
  expect(p.exitCode).toBe(0);
});

test("archived threads are not mentionable (verified cause 2026-10-26)", () => {
  expect(mentionable({ isThread: () => true, archived: true })).toBe(false);
  expect(mentionable({ isThread: () => true, archived: false })).toBe(true);
  expect(mentionable({ isThread: () => false })).toBe(true);
  expect(mentionable({ deleted: true })).toBe(false);
  expect(mentionable(undefined)).toBe(false);
});
