import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVERED_NOTE, PaneJobQueue, queuedPrompt, type QueuedItem } from "../src/jobqueue.ts";

const SESS = join(process.env.HOME ?? "/home/x", ".omp", "agent", "sessions", "a", "s.jsonl");
const PANE = "w1:p1";
const IDLE_TAIL = `${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } })}\n`;
const SCREEN = "\ue0b6 ~/x \ue0b0\n╰─\n";

function setup(o: { live?: boolean; status?: string; focused?: boolean; file?: string } = {}) {
  const file = o.file ?? join(mkdtempSync(join(tmpdir(), "jq-")), "q.json");
  const s = { live: o.live ?? true, status: o.status ?? "working", focused: o.focused ?? false, size: 100, prompts: [] as string[], runs: [] as QueuedItem[], edits: [] as string[] };
  const herdr = async (a: string[]) => {
    if (a[0] === "agent" && a[1] === "get") return { code: 0, out: JSON.stringify({ result: { agent: { pane_id: PANE, agent: "omp", agent_status: s.status, agent_session: { kind: "path", value: SESS }, tab_id: "t" } } }) };
    if (a[0] === "pane" && a[1] === "list") return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: PANE, agent: "omp", agent_session: { kind: "path", value: SESS }, focused: s.focused }] } }) };
    if (a[0] === "agent" && a[1] === "read") return { code: 0, out: SCREEN };
    if (a[0] === "agent" && a[1] === "prompt") {
      s.prompts.push(a[3]!);
      s.size += 50;
      return { code: 0, out: "" };
    }
    return { code: 1, out: "" };
  };
  const q = new PaneJobQueue({
    file,
    herdr,
    readTail: () => IDLE_TAIL,
    fileSize: () => s.size,
    jobLive: async () => s.live,
    editNote: async (_c, n, t) => void s.edits.push(`${n}:${t}`),
    latestAfter: async () => "https://discord.com/channels/g/c/reply",
    runNormally: async (it) => void s.runs.push(it),
  });
  return { q, s, file };
}
const item = (n: number) => ({ messageId: `m${n}`, channelId: "c", noteId: `n${n}`, url: `https://d/m${n}`, text: `hello ${n}` });

test("busy pane: messages wait, nothing is sent and no normal run starts", async () => {
  const { q, s } = setup();
  q.add(PANE, item(1));
  await q.tick();
  expect(s.prompts).toEqual([]);
  expect(s.runs).toEqual([]);
  expect(q.queues.get(PANE)!.items.length).toBe(1);
});

test("focused pane: keeps waiting even when idle", async () => {
  const { q, s } = setup({ status: "idle", focused: true });
  q.add(PANE, item(1));
  await q.tick();
  expect(s.prompts).toEqual([]);
});

test("job ended: each message runs the normal way", async () => {
  const { q, s } = setup({ live: false });
  q.add(PANE, item(1));
  q.add(PANE, item(2));
  await q.tick();
  expect(s.runs.map((x) => x.messageId)).toEqual(["m1", "m2"]);
  expect(s.prompts).toEqual([]);
  expect(q.queues.size).toBe(0);
});

test("restart keeps the queue", () => {
  const { q, file } = setup();
  q.add(PANE, item(1));
  const again = setup({ file }).q;
  expect(again.queues.get(PANE)!.items.map((x) => x.messageId)).toEqual(["m1"]);
});

test("prompt keeps the order of several messages", () => {
  const p = queuedPrompt([item(1), item(2)].map((x) => ({ ...x, at: 0 })));
  expect(p.indexOf("hello 1")).toBeLessThan(p.indexOf("hello 2"));
  expect(p).toContain("Message 2 of 2");
});

test("idle pane: delivered once as one prompt, then linked to the reply", async () => {
  const { q, s } = setup({ status: "idle" });
  q.add(PANE, item(1));
  q.add(PANE, item(2));
  await q.tick();
  await q.tick();
  if (s.prompts.length === 0) throw new Error("not delivered: check SCREEN layout vs editorEmpty");
  expect(s.prompts.length).toBe(1);
  expect(s.edits.some((e) => e.startsWith("n1:") && e.includes(DELIVERED_NOTE))).toBe(true);
  expect(s.edits.some((e) => e.includes("reply"))).toBe(true);
});

test("job ended: a message queued during the fallback run is kept", async () => {
  const { q, s } = setup({ live: false });
  q.add(PANE, item(1));
  (q as unknown as { d: { runNormally: (it: QueuedItem) => Promise<void> } }).d.runNormally = async (it) => {
    s.runs.push(it);
    if (it.messageId === "m1") q.add(PANE, item(2));
  };
  await q.tick();
  expect(q.queues.get(PANE)?.items.map((x) => x.messageId)).toEqual(["m2"]);
});
