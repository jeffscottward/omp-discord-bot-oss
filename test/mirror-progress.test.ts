import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, gitNotes, Mirror, PROGRESS_STEPS, renderProgress, sessionEvents, stepLabel, type MirrorEntry } from "../src/mirror.ts";

const T0 = Date.parse("2026-10-15T22:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const user = (s: number, text: string) => ({ type: "message", timestamp: at(s), message: { role: "user", content: [{ type: "text", text }] } });
const tools = (s: number, ...calls: [string, Record<string, unknown>][]) => ({
  type: "message",
  timestamp: at(s),
  message: { role: "assistant", stopReason: "toolUse", content: calls.map(([name, args]) => ({ type: "toolCall", name, arguments: args })) },
});
const final = (s: number, text: string, stopReason = "stop") => ({ type: "message", timestamp: at(s), message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
const jsonl = (...lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

afterEach(() => setSystemTime());

describe("mirror live progress (owner 2026-10-15)", () => {
  test("step labels: tool name plus intent only, one line, no markdown or mentions", () => {
    expect(stepLabel("bash", { command: "cat ~/.secret", i: "run  diagnostics\non CPU" })).toBe("bash · run diagnostics on CPU");
    expect(stepLabel("read", { path: "/x" })).toBe("read");
    expect(stepLabel("edit", { i: "fix `x` @everyone <t:1:R>" })).toBe("edit · fix x everyone t:1:R");
    expect(stepLabel(42, null)).toBe("tool");
  });

  test("events in order; partial last line left for later", () => {
    const body = jsonl(user(0, "go"), tools(5, ["bash", { i: "a" }], ["read", { i: "b" }]), final(9, "Done"), final(10, "", "aborted"));
    const { events, consumed } = sessionEvents(Buffer.from(`${body}{"type":"mess`));
    expect(consumed).toBe(Buffer.byteLength(body));
    expect(events.map((e) => e.kind)).toEqual(["turn", "step", "step", "reply", "stopped"]);
    expect(events[1]).toEqual({ kind: "step", ts: T0 + 5000, label: "bash · a", tool: "bash", intent: "a" });
  });

  test("state: steps keep only the latest few; finish is urgent; steering keeps the turn", () => {
    let p = applyEvent(undefined, { kind: "turn", ts: T0 }).p;
    for (let i = 0; i < PROGRESS_STEPS + 3; i++) p = applyEvent(p, { kind: "step", ts: T0 + i, label: `s${i}` }).p;
    expect(p!.count).toBe(PROGRESS_STEPS + 3);
    expect(p!.steps.length).toBe(PROGRESS_STEPS);
    expect(applyEvent(p, { kind: "turn", ts: T0 + 99 }).p).toBe(p);
    const done = applyEvent(p, { kind: "reply", ts: T0 + 600_000, text: "ok" });
    expect(done.urgent).toBe(true);
    expect(renderProgress("OFF-BOOK", done.p!)).toBe(`✅ **OFF-BOOK** · turn finished <t:${(T0 + 600_000) / 1000}:R> · ${PROGRESS_STEPS + 3} steps in 10 min`);
    const stopped = applyEvent(p, { kind: "stopped", ts: T0 + 60_000, reason: "aborted" }).p!;
    expect(renderProgress("X", stopped)).toContain("⏹️ **X** · turn stopped (aborted)");
    // A reply with no tool steps needs no status message.
    expect(applyEvent(applyEvent(undefined, { kind: "turn", ts: T0 }).p, { kind: "reply", ts: T0, text: "hi" })).toEqual({ p: undefined, urgent: false });
  });

  test("tail: one status message created, throttled edits, finished before the reply posts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "progress-"));
    const session = join(dir, "s.jsonl");
    writeFileSync(session, "");
    const m = new Mirror(null, join(dir, "agents.json"));
    const e: MirrorEntry = { machine: "main", paneId: "wB:p5S", tabId: "wB:t2Y", workspace: "wB", tab: "OFF-BOOK", name: "off", channelId: "C1", archived: false, sessionFile: session };
    m.entries = [e];
    const log: string[] = [];
    const post = async (_c: string, text: string) => void log.push(`post ${text.split("\n")[1]}`);
    const status = async (_c: string, text: string, msgId?: string) => {
      log.push(`${msgId ? "edit" : "send"} ${text.split("\n")[0]}`);
      return msgId ?? "M1";
    };

    setSystemTime(new Date(T0));
    await m.tail(post, status); // first sight: start from the current end
    appendFileSync(session, jsonl(user(0, "go"), tools(1, ["bash", { i: "build" }], ["read", { i: "docs" }])));
    await m.tail(post, status);
    expect(log).toEqual([`send ⚙️ **OFF-BOOK** · working · started <t:${T0 / 1000}:R> · 2 steps · last step <t:${T0 / 1000 + 1}:R>`]);
    expect(e.progress?.msgId).toBe("M1");

    appendFileSync(session, jsonl(tools(2, ["grep", { i: "find" }])));
    await m.tail(post, status); // inside the throttle window: no edit yet
    expect(log.length).toBe(1);
    setSystemTime(new Date(T0 + 5_000));
    await m.tail(post, status); // nothing new read, but the pending edit goes out
    expect(log[1]).toContain("edit ⚙️ **OFF-BOOK** · working");
    expect(log[1]).toContain("3 steps");

    appendFileSync(session, jsonl(tools(3, ["bash", { i: "test" }]), final(4, "All done")));
    await m.tail(post, status);
    expect(log.slice(2)).toEqual([`edit ✅ **OFF-BOOK** · turn finished <t:${T0 / 1000 + 4}:R> · 4 steps in 0 min`, "post All done"]);
    // The progress survives a bot restart (persisted with the entry).
    expect(new Mirror(null, join(dir, "agents.json")).entries[0]?.progress).toMatchObject({ msgId: "M1", state: "done", count: 4 });

    // Next turn without tools: reply only, the old status message stays as it is.
    appendFileSync(session, jsonl(user(10, "thanks"), final(11, "You're welcome")));
    await m.tail(post, status);
    expect(log.slice(4)).toEqual(["post You're welcome"]);

    // Next turn with tools: a NEW status message at the bottom.
    appendFileSync(session, jsonl(user(20, "more"), tools(21, ["bash", { i: "again" }])));
    await m.tail(post, status);
    expect(log[5]).toStartWith("send ⚙️ **OFF-BOOK** · working");
  });
});

test("progress shows the task, eval titles and the agent's narration (owner 2026-10-15)", async () => {
  const { sessionEvents, applyEvent, renderProgress } = await import("../src/mirror.ts");
  const lines = [
    { type: "message", timestamp: "2026-10-15T23:00:00Z", message: { role: "user", content: "rules…\n--- owner message ---\nTranscribe the profile\n--- end owner message ---" } },
    { type: "message", timestamp: "2026-10-15T23:00:05Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Now I'll list the posts." }, { type: "toolCall", name: "eval", arguments: { title: "Harvest shortcodes", code: "secret()" } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  let p: any;
  for (const ev of sessionEvents(Buffer.from(lines)).events) p = applyEvent(p, ev).p;
  const t = renderProgress("tab", p);
  expect(t).toContain("📝 **Task:** Transcribe the profile");
  expect(t).not.toContain("rules");
  expect(t).toContain("💬 Now I'll list the posts.");
  expect(t).toContain("eval · Harvest shortcodes");
  expect(t).not.toContain("secret()");
  expect(t).toContain("1 step ");
});

describe("git notes in the status (owner 2026-10-15)", () => {
  const call = (s: number, id: string, command: string) => ({
    type: "message",
    timestamp: at(s),
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash", arguments: { command, i: "git" } }] },
  });
  const result = (s: number, id: string, text: string, isError = false) => ({
    type: "message",
    timestamp: at(s),
    message: { role: "toolResult", toolCallId: id, toolName: "bash", isError, content: [{ type: "text", text }] },
  });

  test("gitNotes: commit, push, PR; failures and no-ops give nothing", () => {
    expect(gitNotes("git commit -qm 'docs: add x'", "")).toEqual(["📝 Committed: docs: add x"]);
    expect(gitNotes("git commit -m x", "[main 1a2b3c4d] docs: add notes\n 1 file changed")).toEqual(["📝 Committed 1a2b3c4 on main: docs: add notes"]);
    expect(gitNotes("git commit -m x", "nothing to commit, working tree clean")).toEqual([]);
    expect(gitNotes("git push -u origin feat/a_b", "To github.com:Org/repo.git\n * [new branch]      feat/a_b -> feat/a_b")).toEqual(["⬆️ Pushed feat/a_b to Org/repo"]);
    expect(gitNotes("git push -q -u origin docs/x 2>&1 | tail -3", "")).toEqual(["⬆️ Pushed docs/x"]);
    expect(gitNotes("git push", "Everything up-to-date")).toEqual([]);
    expect(gitNotes("git push origin main", " ! [rejected]        main -> main (fetch first)\nerror: failed to push")).toEqual([]);
    expect(gitNotes("git stash push", "")).toEqual([]);
    expect(gitNotes("gh pr create --fill", "https://github.com/example-org/example-app/pull/2\n")).toEqual(["🔀 Opened PR example-org/example-app#2"]);
    expect(gitNotes("git log --oneline", "abc commit")).toEqual([]);
    expect(gitNotes("cat > /tmp/b.md <<'EOF'\nThen git push and git commit -m x\nEOF\ngh pr view 2", "")).toEqual([]);
    expect(gitNotes("echo run git push later", "")).toEqual([]);
  });

  test("call and result in separate chunks; error results ignored; notes survive the finished status", () => {
    const a = sessionEvents(Buffer.from(jsonl(user(0, "ship it"), call(1, "c1", "git push origin main"))));
    const b = sessionEvents(Buffer.from(jsonl(result(2, "c1", ""), call(3, "c2", "gh pr create"), result(4, "c2", "boom", true), final(5, "Done"))));
    const events = [...a.events, ...b.events];
    // Plan P5: every tool result is an event too (it closes the open call).
    expect(events.map((e) => e.kind)).toEqual(["turn", "step", "result", "git", "step", "result", "reply"]);
    let p: ReturnType<typeof applyEvent>["p"];
    for (const e of events) p = applyEvent(p, e).p;
    expect(p!.state).toBe("done");
    const text = renderProgress("tab", p!);
    expect(text.split("\n")[1]).toStartWith("⬆️ Pushed main · <t:");
  });
});

test("channel titles get a topic emoji (owner 2026-10-17)", async () => {
  const { channelTitle } = await import("../src/mirror.ts");
  expect(channelTitle("primary-github-firstmate", "primary")).toBe("👷‍♂️-primary-github-firstmate");
  expect(channelTitle("primary-github-kb-notes", "primary")).toBe("📚-primary-github-kb-notes");
  expect(channelTitle("primary-github-example-app", "primary")).toBe("🧩-primary-github-example-app");
  expect(channelTitle("peer-home-misc", "peer")).toBe("💻-peer-home-misc");
  expect(channelTitle("primary-github-harness-dev", "primary")).toBe("🧰-primary-github-harness-dev");
});

test("channels sort by emoji group, then name (owner 2026-10-17)", async () => {
  const { channelTitle, sortKey } = await import("../src/mirror.ts");
  const names = ["primary-github-example-app", "primary-github-firstmate", "primary-github-kb-notes", "primary-github-harness", "primary-github-zzz"];
  const sorted = names.map((n) => channelTitle(n, "primary")).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  expect(sorted).toEqual(["👷‍♂️-primary-github-firstmate", "📚-primary-github-kb-notes", "🧩-primary-github-example-app", "🧰-primary-github-harness", "🤖-primary-github-zzz"]);
});
