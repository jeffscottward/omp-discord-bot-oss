import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOWN_TEXT, LocalModelChat, routeMessage, trimHistory, type Turn } from "../src/localmodel.ts";

const CH = "chan", OWNER = "owner";

describe("routing", () => {
  test("only the owner in the local channel goes local", () => {
    expect(routeMessage({ channelId: CH, authorId: OWNER, bot: false }, CH, OWNER)).toBe("local");
    expect(routeMessage({ channelId: CH, authorId: "someone", bot: false }, CH, OWNER)).toBe("ignore");
    expect(routeMessage({ channelId: CH, authorId: OWNER, bot: true }, CH, OWNER)).toBe("ignore");
    expect(routeMessage({ channelId: "other", authorId: OWNER, bot: false }, CH, OWNER)).toBe("other");
  });
});

describe("history trimming", () => {
  test("drops oldest turns to fit; keeps newest; starts with user", () => {
    const h: Turn[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(350) }));
    const t = trimHistory(h, 500);
    expect(t.length).toBeLessThan(h.length);
    expect(t.at(-1)).toBe(h.at(-1)!);
    expect(t[0]!.role).toBe("user");
  });
  test("keeps everything when it fits", () => {
    const h: Turn[] = [{ role: "user", content: "hi" }];
    expect(trimHistory(h, 1000)).toEqual(h);
  });
});

function harness(f: typeof fetch, idleMs?: number) {
  const sent: string[] = [];
  const chat = new LocalModelChat({
    stateDir: mkdtempSync(join(tmpdir(), "lm-")),
    fetch: f,
    editEveryMs: 0,
    idleMs,
    send: async (t) => {
      const i = sent.push(t) - 1;
      return { edit: async (x) => void (sent[i] = x) };
    },
  });
  return { sent, chat };
}

describe("server handling", () => {
  test("server down: one clear message, one attempt", async () => {
    let calls = 0;
    const { sent, chat } = harness((async () => { calls++; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    await chat.handle("hello");
    expect(sent).toEqual([DOWN_TEXT]);
    expect(calls).toBe(1);
  });

  test("streams a reply, persists history, reset clears it", async () => {
    const sse = ['data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}', 'data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}', "data: [DONE]", ""].join("\n");
    const f = (async (url: string) =>
      String(url).endsWith("/props") ? Response.json({ default_generation_settings: { n_ctx: 8192 } }) : new Response(sse)) as unknown as typeof fetch;
    const { sent, chat } = harness(f);
    await chat.handle("hi");
    expect(sent.at(-1)).toBe("🧠 local-coder\nHello");
    expect(chat.load()).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }]);
    await chat.handle("reset");
    expect(chat.load()).toEqual([]);
  });

  test("long replies are split at 2000 chars", async () => {
    const big = "y".repeat(4500);
    const f = (async (url: string) =>
      String(url).endsWith("/props") ? Response.json({ default_generation_settings: { n_ctx: 8192 } }) : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: big } }] })}\n`)) as unknown as typeof fetch;
    const { sent, chat } = harness(f);
    await chat.handle("long");
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.every((s) => s.length <= 2000)).toBe(true);
  });

  test("stalled stream is aborted and the channel is free again", async () => {
    const f = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/props")) return Response.json({ default_generation_settings: { n_ctx: 8192 } });
      const sig = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"part"}}]}\n'));
          sig?.addEventListener("abort", () => c.error(sig.reason));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    const { sent, chat } = harness(f, 50);
    await chat.handle("stall");
    expect(sent.at(-1)).toContain("stream ended early");
    await chat.handle("reset");
    expect(sent.at(-1)).toContain("history cleared");
  });
});

import { cleanToolMarkup, NO_TOOLS_NOTE } from "../src/localmodel.ts";
test("raw tool-call markup is removed and replaced by a chat-only note", () => {
  const raw = 'Let me pull the site.\n\n<|tool_call_start|>[skill run x url="https://example.com/"]<|tool_call_end|>';
  const out = cleanToolMarkup(raw);
  expect(out).not.toContain("<|tool_call_start|>");
  expect(out).toContain("Let me pull the site.");
  expect(out).toContain(NO_TOOLS_NOTE);
  expect(cleanToolMarkup("<|tool_call_start|>[partial")).toBe(NO_TOOLS_NOTE);
  expect(cleanToolMarkup("plain answer")).toBe("plain answer");
});
