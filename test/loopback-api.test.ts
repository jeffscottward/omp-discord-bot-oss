// Owner 2026-10-23 (Discord UX item 1 + ask option bug): /post returns ids/links, GET /messages, GET /asks,
// POST /asks/close, and an ask block that cannot become a menu is refused with a 400 naming the problem.
import { describe, expect, test } from "bun:test";
import { extractAsk } from "../src/ask.ts";
import { askBlockError, parseReplyTo, startHttp, type AskView, type MessageView } from "../src/http.ts";

const posted: string[] = [];
const closed: string[][] = [];
const view: MessageView = { id: "1", url: "https://discord.com/channels/g/c/1", ts: "2026-10-23T00:00:00.000Z", author: "OMP", bot: true, content: "hi", attachments: [], buttons: false };
const askView: AskView = { setId: "abc", channelId: "c", createdAt: 1, questions: [{ id: "q1", question: "Q?", answered: false, url: "https://discord.com/channels/g/c/2" }] };
const srv = startHttp(
  {
    post: async (_id, text) => {
      posted.push(text);
      return { id: "10", url: "https://discord.com/channels/g/c/10", messages: [{ id: "10", url: "https://discord.com/channels/g/c/10" }], attachments: [{ name: "a.pdf", url: "https://cdn/a.pdf" }] };
    },
    health: () => ({}),
    messages: async (ch, limit) => (ch === "100000000000000045" ? null : Array.from({ length: Math.min(limit, 3) }, () => view)),
    asks: (ch) => (ch && ch !== "100000000000000028" ? [] : [askView]),
    secretDrop: async (o) => (o.dest.startsWith("/home/") ? { id: "x".repeat(32), url: "https://main.ts.net/secret-drop/xxx", expiresAt: 1 } : { error: "dest must be under home" }),
    secretDropStatus: (id) => (id === "x".repeat(32) ? { state: "waiting" } : null),
    closeAsks: (ids) => {
      closed.push(ids);
      return ids.filter((x) => x === "abc");
    },
  },
  0, // OS-assigned: a fixed or random port in the ephemeral range can be taken (port clash 2026-10-23)
);
const base = `http://127.0.0.1:${srv.port}`;
const post = (path: string, body: unknown) => globalThis.fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => globalThis.fetch(`${base}${path}`);

const ASK = (opts: unknown) => `Pick one.\n\n\`\`\`ask\n${JSON.stringify({ questions: [{ id: "x", question: "Which?", options: opts }] })}\n\`\`\``;

describe("POST /post result", () => {
  test("returns id, url, messages and attachments", async () => {
    const r = await post("/post", { channel: "general-x", text: "hello" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.id).toBe("10");
    expect(j.url).toBe("https://discord.com/channels/g/c/10");
    expect(j.attachments).toEqual([{ name: "a.pdf", url: "https://cdn/a.pdf" }]);
  });
  test("refuses an ask block with bad options (400, names the problem)", async () => {
    const before = posted.length;
    const r = await post("/post", { channel: "general-x", text: ASK([{ name: "A" }, { name: "B" }]) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("option 1 is not a string or {label, description}");
    expect(posted.length).toBe(before);
  });
  test("accepts {label, description} options", async () => {
    const r = await post("/post", { channel: "general-x", text: ASK([{ label: "A", description: "first" }, { label: "B" }]) });
    expect(r.status).toBe(200);
  });
  test("refuses an unclosed ask fence", async () => {
    const r = await post("/post", { channel: "general-x", text: "x\n```ask\n{}" });
    expect(r.status).toBe(400);
  });
});

describe("GET /messages and /asks", () => {
  test("lists messages with a capped limit", async () => {
    const r = await get("/messages?channel=general-x&limit=2");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { messages: unknown[] }).messages.length).toBe(2);
  });
  test("rejects a missing channel, a bad limit and an unknown channel", async () => {
    expect((await get("/messages")).status).toBe(400);
    expect((await get("/messages?channel=general-x&limit=0")).status).toBe(400);
    expect((await get("/messages?channel=no-such")).status).toBe(400);
    expect((await get("/messages?channel=100000000000000045")).status).toBe(400);
  });
  test("lists open asks, optionally per channel", async () => {
    const all = (await (await get("/asks")).json()) as { asks: AskView[] };
    expect(all.asks[0]!.questions[0]!.url).toContain("discord.com/channels");
    expect((await get("/asks?channel=no-such")).status).toBe(400);
  });
  test("POST /asks/close validates ids and returns the closed ones", async () => {
    expect((await post("/asks/close", { setIds: ["../x"] })).status).toBe(400);
    const r = (await (await post("/asks/close", { setIds: ["abc", "zzz"], reason: "asked-again" })).json()) as { closed: string[] };
    expect(r.closed).toEqual(["abc"]);
  });
  test("still refuses a browser origin", async () => {
    const r = await globalThis.fetch(`${base}/messages?channel=general-x`, { headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("/post replyTo", () => {
  const ch = "100000000000000030";
  test("accepts an id or a same-channel link; refuses others", () => {
    expect(parseReplyTo(undefined, ch)).toBeUndefined();
    expect(parseReplyTo("100000000000000040", ch)).toEqual({ id: "100000000000000040" });
    expect(parseReplyTo(`https://discord.com/channels/100000000000000025/${ch}/100000000000000040`, ch)).toEqual({ id: "100000000000000040" });
    expect(parseReplyTo("https://discord.com/channels/1/100000000000000029/100000000000000040", ch)).toHaveProperty("error");
    expect(parseReplyTo("abc", ch)).toHaveProperty("error");
    expect(parseReplyTo(5, ch)).toHaveProperty("error");
  });
  test("a bad replyTo gets 400 before anything is posted", async () => {
    const before = posted.length;
    expect((await post("/post", { channel: "general-x", text: "x", replyTo: "nope" })).status).toBe(400);
    expect(posted.length).toBe(before);
    expect((await post("/post", { channel: "general-x", text: "x", replyTo: "100000000000000040" })).status).toBe(200);
  });
});

describe("secret drop loopback", () => {
  test("creates a drop and reports its state; bad bodies get 400", async () => {
    const ok = await post("/secret-drop", { name: "Example API", dest: "/home/u/.config/t/token" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { url: string }).url).toContain("/secret-drop/");
    expect((await post("/secret-drop", { name: "Example API", dest: "/etc/x" })).status).toBe(400);
    expect((await post("/secret-drop", { name: "Example API" })).status).toBe(400);
    expect((await post("/secret-drop", { name: "T", dest: "/home/u/.config/t", ttlMin: -1 })).status).toBe(400);
    expect(((await (await get(`/secret-drop/${"x".repeat(32)}`)).json()) as { state: string }).state).toBe("waiting");
    expect((await get(`/secret-drop/${"y".repeat(32)}`)).status).toBe(404);
  });
});

describe("ask options", () => {
  test("{label, description} objects become labels plus descriptions", () => {
    const a = extractAsk(ASK([{ label: "Alpha", description: "the first" }, { label: "Beta", recommended: true }, "Gamma"]));
    expect(a.error).toBeUndefined();
    expect(a.questions![0]!.options).toEqual(["Alpha", "Beta", "Gamma", "✏️ Other (type or dictate a reply)"]);
    expect(a.questions![0]!.descriptions).toEqual(["the first", "", "", ""]);
    expect(a.questions![0]!.recommended).toBe(1);
  });
  test("plain strings carry no descriptions", () => {
    expect(extractAsk(ASK(["A", "B"])).questions![0]!.descriptions).toBeUndefined();
  });
  test("other shapes give an error naming the option", () => {
    expect(extractAsk(ASK(["A", { text: "B" }])).error).toContain("option 2");
    expect(extractAsk(ASK(["A", { label: "B", description: 3 }])).error).toContain("description must be a string");
  });
  test("askBlockError is null for text without an ask block", () => {
    expect(askBlockError("plain text")).toBeNull();
  });
});

process.on("beforeExit", () => srv.stop(true));
