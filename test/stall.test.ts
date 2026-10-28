// Plan P5: stall detector (v1) and automatic continue after a transient error (v2). The clock is injected.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror, sessionEvents, type MirrorEntry, type SessionEvent } from "../src/mirror.ts";
import { CONTINUE_DELAYS_MS, freshWatch, isTransientError, MAX_ERROR_AGE_MS, STALL_MS, watchCheck, watchEvents, type WatchAction } from "../src/stall.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-17T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const msg = (ms: number, message: object) => ({ type: "message", timestamp: at(ms), message });
const call = (ms: number, id: string, name: string, i: string) => msg(ms, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: { i } }] });
const result = (ms: number, id: string) => msg(ms, { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });
const errorStop = (ms: number, errorMessage: string) => msg(ms, { role: "assistant", stopReason: "error", errorMessage, content: [] });
const user = (ms: number, text: string) => msg(ms, { role: "user", content: [{ type: "text", text }] });
const jsonl = (...lines: object[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
const events = (...lines: object[]) => sessionEvents(Buffer.from(jsonl(...lines))).events;

describe("transient error classes", () => {
  test("transient: transport and server errors", () => {
    for (const m of [
      "The socket connection was closed unexpectedly before the response completed",
      "server_error: stream closed with reason: error",
      "ECONNRESET: The socket connection was closed unexpectedly.",
      "529 overloaded_error: Overloaded",
      "503 Service Unavailable",
      "upstream connect error or disconnect/reset before headers. reset reason: connection timeout",
      "Codex error event: Unable to verify model access right now. Please retry. (code=service_unavailable_error)",
      "OpenAI Codex SSE stream stalled while waiting for the next event",
    ])
      expect(isTransientError(m)).toBe(true);
  });
  test("not transient: used-up usage limit, auth, bad request, user abort, unknown", () => {
    for (const m of [
      "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
      "You have hit your ChatGPT usage limit (pro plan). Try again in ~7057 min.",
      "No API key for provider: anthropic",
      '401 {"error":"unauthorized"}',
      "404 This model is unavailable for free.",
      "aborted",
      "The operation was aborted",
      "something odd happened",
      "",
    ])
      expect(isTransientError(m)).toBe(false);
  });
});

describe("stall detector (v1)", () => {
  test("open call + no growth for 15 min: one stall line, then one resumed line", () => {
    const w = freshWatch(T0);
    watchEvents(w, events(call(0, "c1", "bash", "build the app")), 100, T0);
    expect(watchCheck(w, T0 + STALL_MS)).toEqual([]); // not more than 15 min yet
    expect(watchCheck(w, T0 + STALL_MS + 1)).toEqual([{ kind: "stall", tool: "bash", intent: "build the app", since: T0 }]);
    // Once per stall.
    expect(watchCheck(w, T0 + 30 * MIN)).toEqual([]);
    // The file grows again: resumed.
    watchEvents(w, [], 200, T0 + 31 * MIN);
    expect(watchCheck(w, T0 + 31 * MIN)).toEqual([{ kind: "resumed", since: T0 }]);
    expect(watchCheck(w, T0 + 32 * MIN)).toEqual([]);
  });
  test("a finished call or a growing file is no stall", () => {
    const w = freshWatch(T0);
    watchEvents(w, events(call(0, "c1", "read", "x"), result(1, "c1")), 100, T0);
    expect(watchCheck(w, T0 + 60 * MIN)).toEqual([]);
    const g = freshWatch(T0);
    watchEvents(g, events(call(0, "c2", "bash", "long")), 100, T0);
    watchEvents(g, [], 150, T0 + 14 * MIN); // e.g. a subagent writes progress
    expect(watchCheck(g, T0 + 20 * MIN)).toEqual([]);
  });
});

describe("automatic continue (v2)", () => {
  const SOCKET = "The socket connection was closed unexpectedly before the response completed";
  test("after 2 min, then after 8 min, at most 2 per hour", () => {
    const w = freshWatch(T0);
    watchEvents(w, events(errorStop(0, SOCKET)), 100, T0);
    expect(watchCheck(w, T0 + CONTINUE_DELAYS_MS[0]! - 1)).toEqual([]);
    expect(watchCheck(w, T0 + 2 * MIN)).toEqual([{ kind: "continue", message: SOCKET, attempt: 1 }]);
    expect(watchCheck(w, T0 + 3 * MIN)).toEqual([]); // once per error
    // The continue run stops on the same error again at 5 min: second try 8 min later.
    watchEvents(w, events(user(4 * MIN, "Continue"), errorStop(5 * MIN, SOCKET)), 300, T0 + 5 * MIN);
    expect(watchCheck(w, T0 + 12 * MIN)).toEqual([]);
    expect(watchCheck(w, T0 + 13 * MIN)).toEqual([{ kind: "continue", message: SOCKET, attempt: 2 }]);
    // Third error in the same hour: limit line, no continue.
    watchEvents(w, events(user(14 * MIN, "Continue"), errorStop(15 * MIN, SOCKET)), 400, T0 + 15 * MIN);
    expect(watchCheck(w, T0 + 40 * MIN)).toEqual([{ kind: "limit", message: SOCKET }]);
    // An hour after the first continue only the second counts: a new error gets one more try, after 8 min.
    watchEvents(w, events(user(61 * MIN, "x"), errorStop(62 * MIN, SOCKET)), 500, T0 + 62 * MIN);
    expect(watchCheck(w, T0 + 69 * MIN)).toEqual([]);
    expect(watchCheck(w, T0 + 70 * MIN)).toEqual([{ kind: "continue", message: SOCKET, attempt: 2 }]);
  });
  test("no continue for a non-transient error, an error followed by activity, or a very old error", () => {
    const a = freshWatch(T0);
    watchEvents(a, events(errorStop(0, "Codex error event: The usage limit has been reached (code=usage_limit_reached)")), 100, T0);
    expect(watchCheck(a, T0 + 30 * MIN)).toEqual([]);
    const b = freshWatch(T0);
    watchEvents(b, events(errorStop(0, SOCKET), user(MIN, "try again")), 100, T0);
    expect(watchCheck(b, T0 + 30 * MIN)).toEqual([]);
    const c = freshWatch(T0);
    watchEvents(c, events(errorStop(0, SOCKET)), 100, T0 + MAX_ERROR_AGE_MS + MIN);
    expect(watchCheck(c, T0 + MAX_ERROR_AGE_MS + MIN)).toEqual([]);
  });
});

describe("Mirror.tail with the watch", () => {
  test("posts the stall action once and the continue action for a transient stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-"));
    const session = join(dir, "s.jsonl");
    writeFileSync(session, "");
    const m = new Mirror(null, join(dir, "agents.json"));
    const e: MirrorEntry = { machine: "main", paneId: "w:p1", tabId: "w:t1", workspace: "w", tab: "Demo", name: "demo", channelId: "C1", archived: false, sessionFile: session };
    m.entries = [e];
    const seen: WatchAction["kind"][] = [];
    const onWatch = async (_e: MirrorEntry, a: WatchAction) => void seen.push(a.kind);
    let now = T0;
    const clock = () => now;
    const post = async () => {};
    await m.tail(post, undefined, onWatch, clock); // first sight
    appendFileSync(session, jsonl(call(0, "c1", "bash", "deploy")));
    await m.tail(post, undefined, onWatch, clock);
    now = T0 + 16 * MIN;
    await m.tail(post, undefined, onWatch, clock);
    await m.tail(post, undefined, onWatch, clock);
    expect(seen).toEqual(["stall"]);
    now = T0 + 17 * MIN;
    appendFileSync(session, jsonl(result(17 * MIN, "c1"), errorStop(17 * MIN, "503 Service Unavailable")));
    await m.tail(post, undefined, onWatch, clock);
    expect(seen).toEqual(["stall", "resumed"]);
    now = T0 + 19 * MIN;
    await m.tail(post, undefined, onWatch, clock);
    expect(seen).toEqual(["stall", "resumed", "continue"]);
    // The state is saved with the entry (a bot restart keeps the per-hour count).
    const again = new Mirror(null, join(dir, "agents.json"));
    expect(again.entries[0]!.watch?.continues).toEqual([T0 + 19 * MIN]);
  });
  test("stopped events carry the provider error text", () => {
    const ev = events(errorStop(0, "boom 502")) as SessionEvent[];
    expect(ev).toEqual([{ kind: "stopped", ts: T0, reason: "error", error: "boom 502" }]);
  });
});
