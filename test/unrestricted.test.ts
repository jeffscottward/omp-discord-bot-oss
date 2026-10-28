import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalOmpChat, ompArgs, type Child } from "../src/localomp.ts";
import { isUnrestrictedMessage, MODEL_ID, MODELS_YML, modelsYmlIsUnrestricted, PROVIDER, unrestrictedKey, unrestrictedProfile } from "../src/unrestricted.ts";

describe("unrestricted profile", () => {
  test("models.yml has only unrestricted.sh with the Qwen model; anything else fails", () => {
    expect(modelsYmlIsUnrestricted(MODELS_YML)).toBe(true);
    expect(modelsYmlIsUnrestricted(MODELS_YML.replace("https://api.unrestricted.sh/v1", "https://api.anthropic.com"))).toBe(false);
    expect(modelsYmlIsUnrestricted(MODELS_YML.replace(MODEL_ID, "claude-opus-5"))).toBe(false);
    expect(modelsYmlIsUnrestricted(`${MODELS_YML}  anthropic:\n    baseUrl: https://api.anthropic.com\n`)).toBe(false);
  });
  test("stream check accepts only the Qwen model", () => {
    expect(isUnrestrictedMessage({ provider: PROVIDER, model: MODEL_ID })).toBe(true);
    expect(isUnrestrictedMessage({ provider: "anthropic", model: "claude-opus-5" })).toBe(false);
  });
  test("default tools; 'none' gives --no-tools", () => {
    const p = unrestrictedProfile(() => "k");
    expect(ompArgs({ prompt: "x", tools: p.defaultTools, model: p.model })).toContain("read,grep,glob,write,edit");
    expect(ompArgs({ prompt: "x", tools: "none", model: p.model })).toContain("--no-tools");
  });
  test("key file: one unr_sk_ token; missing, wrong prefix or repeated paste is refused", () => {
    const d = mkdtempSync(join(tmpdir(), "unr-key-"));
    const f = (v: string) => (writeFileSync(join(d, "k"), v), join(d, "k"));
    expect(unrestrictedKey(f("unr_sk_abc123\n"))).toBe("unr_sk_abc123");
    expect(unrestrictedKey(f("sk-abc"))).toBeNull();
    expect(unrestrictedKey(f("unr_sk_abcunr_sk_abc"))).toBeNull();
    expect(unrestrictedKey(join(d, "missing"))).toBeNull();
  });
});

describe("unrestricted channel turn", () => {
  const harness = (events: object[], key: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "unr-chat-"));
    const sent: string[] = [];
    const edits: string[] = [];
    let env: Record<string, string> = {};
    let argv: string[] = [];
    const chat = new LocalOmpChat({
      stateDir: dir,
      workDir: join(dir, "work"),
      key: "unrestricted",
      label: "🔓 qwen",
      profile: unrestrictedProfile(() => key),
      tools: "",
      ompBin: "/bin/true",
      editEveryMs: 0,
      send: async (t) => (sent.push(t), { edit: async (e) => void edits.push(e) }),
      spawn: (a, e): Child => {
        argv = a;
        env = e;
        return { stdout: (async function* () { for (const ev of events) yield new TextEncoder().encode(`${JSON.stringify(ev)}\n`); })(), kill: () => {}, exited: Promise.resolve(0) };
      },
    });
    return { chat, sent, edits, env: () => env, argv: () => argv };
  };
  const msg = (provider: string, model: string, text: string) => ({ type: "message_end", message: { role: "assistant", provider, model, content: [{ type: "text", text }] } });

  test("runs with tools, passes only the key env, writes the Qwen config", async () => {
    const h = harness([msg(PROVIDER, MODEL_ID, "pong")], "unr_sk_test");
    await h.chat.handle("ping");
    expect(h.edits.at(-1)).toContain("pong");
    expect(h.env().UNRESTRICTED_API_KEY).toBe("unr_sk_test");
    expect(h.argv()).toContain("read,grep,glob,write,edit");
    expect(readFileSync(join(h.chat.agentDir, "models.yml"), "utf8")).toBe(MODELS_YML);
  });
  test("another model in the stream is refused", async () => {
    const h = harness([msg("anthropic", "claude-opus-5", "x")], "unr_sk_test");
    await h.chat.handle("ping");
    expect(h.edits.at(-1)).toContain("refused");
  });
  test("no key: nothing runs, and the owner is told why", async () => {
    const h = harness([msg(PROVIDER, MODEL_ID, "x")], null);
    await h.chat.handle("ping");
    expect(h.sent.at(-1)).toContain("no unrestricted.sh API key saved yet");
    expect(h.argv()).toEqual([]);
  });
});
