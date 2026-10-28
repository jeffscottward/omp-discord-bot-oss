import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DOWN_TEXT, LocalOmpChat, MODELS_YML, isLocalMessage, modelsYmlIsLocal, ompArgs, routeMessage, sandboxArgv } from "../src/localomp.ts";

const CH = "chan", OWNER = "owner";

describe("routing", () => {
  test("only the owner in the local-omp channel runs; bots and others are ignored", () => {
    expect(routeMessage({ channelId: CH, authorId: OWNER, bot: false }, CH, OWNER)).toBe("local-omp");
    expect(routeMessage({ channelId: CH, authorId: "someone", bot: false }, CH, OWNER)).toBe("ignore");
    expect(routeMessage({ channelId: CH, authorId: OWNER, bot: true }, CH, OWNER)).toBe("ignore");
    expect(routeMessage({ channelId: "other", authorId: OWNER, bot: false }, CH, OWNER)).toBe("other");
    expect(routeMessage({ channelId: "", authorId: OWNER, bot: false }, "", OWNER)).toBe("other"); // unset id: off
  });
});

describe("model pin", () => {
  test("generated models.yml is local-only; cloud providers fail", () => {
    expect(modelsYmlIsLocal(MODELS_YML)).toBe(true);
    expect(modelsYmlIsLocal(MODELS_YML.replace("http://127.0.0.1:8091/v1", "https://api.anthropic.com/v1"))).toBe(false);
    expect(modelsYmlIsLocal(`${MODELS_YML}  anthropic:\n    baseUrl: https://api.anthropic.com\n`)).toBe(false);
  });
  test("args pin the local model, thinking off, no extensions, no bash by default", () => {
    const a = ompArgs({ prompt: "hi", tools: "read,grep,glob,write,edit" });
    expect(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2)).toEqual(["--model", "local-coder/local-coder"]);
    expect(a).toContain("--no-extensions");
    expect(a[a.indexOf("--thinking") + 1]).toBe("off");
    expect(a[a.indexOf("--tools") + 1]).not.toContain("bash");
    expect(ompArgs({ prompt: "x", tools: "read", resume: "abc" })).toContain("--resume");
  });
  test("stream check rejects any non-local model", () => {
    expect(isLocalMessage({ provider: "local-coder", model: "local-coder" })).toBe(true);
    expect(isLocalMessage({ provider: "anthropic", model: "claude-opus-5-5" })).toBe(false);
  });
  test("sandbox: home is read-only tmpfs; only work + agent dirs writable", () => {
    const v = sandboxArgv({ home: "/h", ompBin: "/b/omp", agentDir: "/h/a", workDir: "/h/w", args: ["-p"] });
    expect(v[0]).toBe("bwrap");
    expect(v.join(" ")).toContain("--tmpfs /h");
    expect(v.join(" ")).toContain("--remount-ro /h");
    expect(v.join(" ")).toContain("--tmpfs /run");
    expect(v.join(" ")).toContain("--bind /h/w /h/w");
  });
});

function jsonl(events: object[]): string { return events.map((e) => JSON.stringify(e)).join("\n") + "\n"; }
function harness(opts: { healthy?: boolean; events?: object[]; code?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "lomp-"));
  const sent: string[] = [];
  const edits: string[] = [];
  const spawned: string[][] = [];
  let killed = "";
  const chat = new LocalOmpChat({
    stateDir: dir, workDir: join(dir, "work"), ompBin: process.execPath, editEveryMs: 0,
    fetch: (async () => { if (opts.healthy === false) throw new Error("ECONNREFUSED"); return new Response("{}"); }) as unknown as typeof fetch,
    send: async (t) => { sent.push(t); return { edit: async (e) => void edits.push(e) }; },
    spawn: (argv) => { spawned.push(argv); return { stdout: Readable.from([jsonl(opts.events ?? [])]), stderr: null, kill: (s) => { killed = s ?? "SIGTERM"; }, exited: Promise.resolve(opts.code ?? 0) }; },
  });
  return { chat, sent, edits, spawned, killed: () => killed };
}
const local = { provider: "local-coder", model: "local-coder" };

describe("turns", () => {
  test("server down: one clear message, nothing spawned", async () => {
    const h = harness({ healthy: false });
    await h.chat.handle("hello");
    expect(h.sent).toEqual([DOWN_TEXT]);
    expect(h.spawned.length).toBe(0);
  });
  test("tool lines + answer shown; session resumed on the next turn; reset clears it", async () => {
    const events = [
      { type: "session", id: "sess-1" },
      { type: "message_start", message: { role: "assistant", ...local, content: [] } },
      { type: "tool_execution_start", toolName: "read", args: { path: "https://en.wikipedia.org/wiki/X" } },
      { type: "message_end", message: { role: "assistant", ...local, content: [{ type: "text", text: "Summary here." }] } },
    ];
    const h = harness({ events });
    await h.chat.handle("summarize");
    const final = h.edits.at(-1)!;
    expect(final).toContain("🔧 read");
    expect(final).toContain("Summary here.");
    expect(h.chat.sessionId()).toBe("sess-1");
    await h.chat.handle("again");
    expect(h.spawned[1]).toContain("--resume");
    await h.chat.handle("reset");
    expect(h.chat.sessionId()).toBeNull();
  });
  test("a cloud model in the stream kills the run and keeps no session", async () => {
    const h = harness({ events: [{ type: "session", id: "s" }, { type: "message_start", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", content: [] } }] });
    await h.chat.handle("x");
    expect(h.killed()).toBe("SIGKILL");
    expect(h.edits.at(-1)).toContain("refused");
    expect(h.chat.sessionId()).toBeNull();
  });
});

describe("per-channel instances", () => {
  test("channel 0 keeps the original state; later channels get their own key, work dir and label", async () => {
    const { instanceFor } = await import("../src/localomp.ts");
    expect(instanceFor(0).key).toBe("local-omp");
    const b = instanceFor(1);
    expect(b.key).toBe("local-omp-2");
    expect(b.workDir.endsWith("/discord-scratch/local-omp-2")).toBe(true);
    expect(b.label).toBe("🧠 local-omp-b");
    const dir = mkdtempSync(join(tmpdir(), "lo-inst-"));
    const chat = new LocalOmpChat({ stateDir: dir, ...b, send: async () => ({ edit: async () => {} }) });
    expect(chat.agentDir).toBe(join(dir, "local-omp-2-agent"));
  });
});

describe("harness mode (owner 2026-10-19: same experience as Claude)", () => {
  const local = { provider: "local-coder", model: "local-coder" };
  const answerEvents = (text: string) => [
    { type: "session", id: "s-h" },
    { type: "message_start", message: { role: "assistant", ...local, content: [] } },
    { type: "tool_execution_start", toolName: "read", args: { path: "a.txt" } },
    { type: "message_end", message: { role: "assistant", ...local, content: [{ type: "text", text }] } },
  ];
  function hh(opts: { gate?: Promise<void> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "lomp-h-"));
    const sent: { text: string; progress?: boolean }[] = [];
    const edits: { text: string; final?: boolean }[] = [];
    const delivered: string[] = [];
    const prompts: string[] = [];
    let kills = 0;
    const chat = new LocalOmpChat({
      stateDir: dir, workDir: join(dir, "work"), ompBin: process.execPath, editEveryMs: 0, label: "🔓 qwen",
      extraSystem: "ASK RULE",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      send: async (text, o) => { sent.push({ text, progress: o?.progress }); return { edit: async (t, final) => void edits.push({ text: t, final }) }; },
      deliver: async (a) => void delivered.push(a),
      spawn: (argv) => {
        const prompt = argv.at(-1)!;
        prompts.push(prompt);
        const n = prompts.length;
        async function* out() { if (opts.gate && n === 1) await opts.gate; yield jsonl(answerEvents(`answer to ${prompt}`)); }
        return { stdout: Readable.from(out()), stderr: null, kill: () => { kills++; }, exited: Promise.resolve(0) };
      },
    });
    return { chat, sent, edits, delivered, prompts, kills: () => kills };
  }
  test("answer goes through deliver (ask menus, dashboard link); progress shows status only and ends final", async () => {
    const h = hh();
    await h.chat.handle("hi");
    expect(h.delivered).toEqual(["answer to hi"]);
    expect(h.sent[0]!.progress).toBe(true);
    expect(h.sent[0]!.text).toContain("⚙️ Working…");
    const last = h.edits.at(-1)!;
    expect(last.final).toBe(true);
    expect(last.text).toContain("✅ Done in");
    expect(last.text).not.toContain("answer to hi");
  });
  test("bridge rules are appended to the system prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lomp-s-"));
    let argv: string[] = [];
    const chat = new LocalOmpChat({
      stateDir: dir, workDir: join(dir, "work"), ompBin: process.execPath, editEveryMs: 0, extraSystem: "ASK RULE",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      send: async () => ({ edit: async () => {} }), deliver: async () => {},
      spawn: (a) => { argv = a; return { stdout: Readable.from([jsonl(answerEvents("x"))]), stderr: null, kill: () => {}, exited: Promise.resolve(0) }; },
    });
    await chat.handle("x");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("ASK RULE");
  });
  test("a message during a run is queued and runs next; stop ends the current turn", async () => {
    let open!: () => void;
    const h = hh({ gate: new Promise<void>((r) => { open = r; }) });
    const first = h.chat.handle("first");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.chat.busy).toBe(true);
    await h.chat.handle("second");
    expect(h.sent.some((m) => m.text.includes("📨 queued"))).toBe(true);
    expect(h.chat.stop()).toBe(true);
    expect(h.kills()).toBe(1);
    open();
    await first;
    expect(h.prompts).toEqual(["first", "second"]);
    expect(h.delivered.at(-1)).toBe("answer to second");
    expect(h.edits.some((e) => e.final && e.text.includes("🛑 Stopped."))).toBe(true);
  });
});
