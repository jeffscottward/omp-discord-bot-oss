import { describe, expect, test } from "bun:test";
import { askLinkLine, jobAskChannel, needsAskLink } from "../src/asklink.ts";
import { startHttp } from "../src/http.ts";

const FM = "100000000000000001";
const JOB = "100000000000000002";
const THREAD = "100000000000000003";
const MAC_JOB = "100000000000000004";
// Same pane id on both machines (Herdr ids repeat per host).
const entries = [
  { machine: "main", paneId: "wF:p1", name: "main-firstmate", channelId: FM, archived: false },
  { machine: "main", paneId: "wB:p1FW", tabId: "wB:t2", name: "main-asks", channelId: JOB, archived: false },
  { machine: "second", paneId: "wB:p1FW", tabId: "wB:t2", name: "second-other", channelId: MAC_JOB, archived: false },
  { machine: "main", paneId: "wC:p9", name: "old", channelId: "100000000000000009", archived: true },
];
// Stand-in for mirror.byJob: main entries only, not archived.
const byJob = (t: string) => entries.find((e) => e.machine === "main" && !e.archived && [e.paneId, e.tabId, e.name].includes(t))?.channelId;
const cards = [
  { id: "c-job", job: "wB:t2", stack: "discord" },
  { id: "c-stack", stack: "discord" },
  { id: "c-none" },
  { id: "c-list", job: "wZ:p0, wB:t2", stack: "discord" },
  { id: "c-arr", job: ["wZ:p0", "wB:p1FW"], stack: "discord" },
];
const d = { byJob, cards, threads: { discord: THREAD }, firstmateId: FM };

describe("jobAskChannel", () => {
  test("pane → its mirrored channel", () => expect(jobAskChannel({ pane: "wB:p1FW" }, d)).toBe(JOB));
  test("card job (tab id) → job channel", () => expect(jobAskChannel({ card: "c-job" }, d)).toBe(JOB));
  test("card without job → stack thread", () => expect(jobAskChannel({ card: "c-stack" }, d)).toBe(THREAD));
  test("card job as a comma list or array: first token that resolves", () => {
    expect(jobAskChannel({ card: "c-list" }, d)).toBe(JOB);
    expect(jobAskChannel({ card: "c-arr" }, d)).toBe(JOB);
  });
  test("a Second caller's pane is never matched to the main pane with the same id", () => {
    expect(jobAskChannel({ pane: "wB:p1FW", machine: "second" }, d)).toBeNull();
    expect(jobAskChannel({ pane: "wB:p1FW", machine: "main" }, d)).toBe(JOB);
  });
  test("a named pane that does not resolve stays in FIRSTMATE (no card fallback to another session)", () => {
    expect(jobAskChannel({ pane: "wB:p1FW", machine: "second", card: "c-stack" }, d)).toBeNull();
    expect(jobAskChannel({ pane: "wQ:p7", card: "c-job" }, d)).toBeNull();
  });
  test("FIRSTMATE's own asks stay (its pane, no card, unknown)", () => {
    expect(jobAskChannel({ pane: "wF:p1" }, d)).toBeNull();
    expect(jobAskChannel({}, d)).toBeNull();
    expect(jobAskChannel({ card: "c-none" }, d)).toBeNull();
    expect(jobAskChannel({ pane: "wC:p9" }, d)).toBeNull();
  });
});

describe("FIRSTMATE link line", () => {
  test("one terse line, title ≤ 60 chars, no options", () => {
    const l = askLinkLine(JOB, "**Which** retry shape should the bot use for the GitLab mirror when pushes fail twice?", "https://x/y");
    expect(l.split("\n").length).toBe(1);
    expect(l).toStartWith(`❓ Open question in <#${JOB}>: Which retry`);
    expect(l).toEndWith("… → https://x/y");
    expect(l.split(": ")[1]!.split(" → ")[0]!.length).toBeLessThanOrEqual(60);
  });
  test("only job channels / threads in them / stack threads get a link", () => {
    const base = { firstmateId: FM, dm: false, detached: false, stackThread: false, mirrorChannelId: undefined as string | undefined };
    expect(needsAskLink({ ...base, channelId: JOB, mirrorChannelId: JOB })).toBe(true);
    expect(needsAskLink({ ...base, channelId: "300", mirrorChannelId: JOB })).toBe(true); // thread in a job channel
    expect(needsAskLink({ ...base, channelId: THREAD, stackThread: true, mirrorChannelId: FM })).toBe(true);
    expect(needsAskLink({ ...base, channelId: FM, mirrorChannelId: FM })).toBe(false);
    expect(needsAskLink({ ...base, channelId: "301", mirrorChannelId: FM })).toBe(false); // FIRSTMATE's own thread
    expect(needsAskLink({ ...base, channelId: "200" })).toBe(false); // configured channel, not mirrored
    expect(needsAskLink({ ...base, channelId: "400", dm: true })).toBe(false);
    expect(needsAskLink({ ...base, channelId: "500", detached: true, mirrorChannelId: "500" })).toBe(false);
  });
});

describe("POST /post ask reroute", () => {
  const sent: { id: string; text: string }[] = [];
  const srv = startHttp({
    post: async (id, text) => void sent.push({ id, text }),
    health: () => ({}),
    askReroute: ({ targetId, ...who }) => (targetId === FM ? jobAskChannel(who, d) : null),
  }, 0);
  const post = (body: unknown) =>
    globalThis.fetch(`http://127.0.0.1:${srv.port}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ask = 'Q?\n```ask\n{"questions":[{"id":"a","question":"Pick?","options":["A","B","✏️ Other (type or dictate a reply)"]}]}\n```';
  test("a job ask aimed at FIRSTMATE lands in the job channel", async () => {
    const r = await post({ channel: FM, text: ask, pane: "wB:p1FW", card: "c-job", replyTo: "123456789012345678" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { rerouted?: string }).rerouted).toBe(JOB);
    expect(sent.at(-1)?.id).toBe(JOB);
  });
  test("FIRSTMATE's own ask (no pane/card) and plain text stay", async () => {
    await post({ channel: FM, text: ask });
    expect(sent.at(-1)?.id).toBe(FM);
    await post({ channel: FM, text: "plain note", pane: "wB:p1FW" });
    expect(sent.at(-1)?.id).toBe(FM);
  });
  test("a Second caller with a main-looking pane id stays in FIRSTMATE", async () => {
    const r = await post({ channel: FM, text: ask, pane: "wB:p1FW", machine: "second" });
    expect(r.status).toBe(200);
    expect(sent.at(-1)?.id).toBe(FM);
  });
  test("bad pane or machine is refused", async () => {
    expect((await post({ channel: FM, text: ask, pane: "nope" })).status).toBe(400);
    expect((await post({ channel: FM, text: ask, pane: "wB:p1FW", machine: "pc" })).status).toBe(400);
    srv.stop(true);
  });
});

describe("POST /post: a gone job channel falls back to FIRSTMATE", () => {
  const sent: string[] = [];
  const srv = startHttp({
    post: async (id) => {
      if (id === JOB) throw new Error("channel not sendable");
      sent.push(id);
    },
    health: () => ({}),
    askReroute: ({ targetId, ...who }) => (targetId === FM ? jobAskChannel(who, d) : null),
  }, 0);
  test("menu lands in FIRSTMATE, no rerouted field", async () => {
    const ask = 'Q?\n```ask\n{"questions":[{"id":"a","question":"Pick?","options":["A","B","✏️ Other (type or dictate a reply)"]}]}\n```';
    const r = await globalThis.fetch(`http://127.0.0.1:${srv.port}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: FM, text: ask, pane: "wB:p1FW" }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { rerouted?: string }).rerouted).toBeUndefined();
    expect(sent).toEqual([FM]);
    srv.stop(true);
  });
});
