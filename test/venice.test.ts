import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalOmpChat, ompArgs, type Child } from "../src/localomp.ts";
import { isVeniceMessage, MODEL_ID, MODELS_YML, modelsYmlIsVenice, openRouterKey, PROVIDER, veniceProfile } from "../src/venice.ts";

const fakeDb = (rows: { provider: string; type: string; data: string; disabled?: string }[]) => {
  const f = join(mkdtempSync(join(tmpdir(), "venice-db-")), "agent.db");
  const db = new Database(f);
  db.run("CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)");
  for (const r of rows) db.run("INSERT INTO auth_credentials VALUES (?, ?, ?, ?)", [r.provider, r.type, r.data, r.disabled ?? null]);
  db.close();
  return f;
};

describe("venice profile", () => {
  test("models.yml has only OpenRouter with the Venice model; anything else fails", () => {
    expect(modelsYmlIsVenice(MODELS_YML)).toBe(true);
    expect(modelsYmlIsVenice(MODELS_YML.replace("https://openrouter.ai/api/v1", "https://api.anthropic.com"))).toBe(false);
    expect(modelsYmlIsVenice(MODELS_YML.replace(MODEL_ID, "anthropic/claude-opus-5"))).toBe(false);
    expect(modelsYmlIsVenice(`${MODELS_YML}  anthropic:\n    baseUrl: https://api.anthropic.com\n`)).toBe(false);
  });
  test("stream check accepts only the Venice model", () => {
    expect(isVeniceMessage({ provider: PROVIDER, model: MODEL_ID })).toBe(true);
    expect(isVeniceMessage({ provider: "anthropic", model: "claude-opus-5" })).toBe(false);
    expect(isVeniceMessage({ provider: "openrouter", model: MODEL_ID })).toBe(false);
  });
  test("no tools: --no-tools and the Venice model", () => {
    const p = veniceProfile(() => "k");
    const a = ompArgs({ prompt: "hi", tools: p.defaultTools, model: p.model, system: p.system });
    expect(a).toContain("--no-tools");
    expect(a).not.toContain("--tools");
    expect(a[a.indexOf("--model") + 1]).toBe(`${PROVIDER}/${MODEL_ID}`);
  });
  test("key comes from exactly one enabled openrouter api_key row", () => {
    const ok = fakeDb([
      { provider: "openrouter", type: "api_key", data: JSON.stringify({ key: " sk-or-test " }) },
      { provider: "anthropic", type: "oauth", data: "{}" },
    ]);
    expect(openRouterKey(ok)).toBe("sk-or-test");
    expect(openRouterKey(fakeDb([{ provider: "openrouter", type: "api_key", data: '{"key":"a"}', disabled: "x" }]))).toBeNull();
    expect(openRouterKey(fakeDb([{ provider: "openrouter", type: "api_key", data: '{"key":"a"}' }, { provider: "openrouter", type: "api_key", data: '{"key":"b"}' }]))).toBeNull();
    expect(openRouterKey("/nonexistent/agent.db")).toBeNull();
    expect(veniceProfile(() => null).env()).toBeNull();
    expect(veniceProfile(() => "k").env()).toEqual({ OPENROUTER_API_KEY: "k" });
  });
});

describe("venice channel turn", () => {
  const harness = (events: object[], key: string | null = "sk-test") => {
    const dir = mkdtempSync(join(tmpdir(), "venice-chat-"));
    const sent: string[] = [];
    const edits: string[] = [];
    let env: Record<string, string> = {};
    let argv: string[] = [];
    const chat = new LocalOmpChat({
      stateDir: dir,
      workDir: join(dir, "work"),
      key: "venice",
      label: "🔓 venice",
      profile: veniceProfile(() => key),
      ompBin: "/bin/true",
      editEveryMs: 0,
      send: async (t) => (sent.push(t), { edit: async (e) => void edits.push(e) }),
      spawn: (a, e): Child => {
        argv = a;
        env = e;
        return { stdout: (async function* () { for (const ev of events) yield new TextEncoder().encode(`${JSON.stringify(ev)}\n`); })(), kill: () => {}, exited: Promise.resolve(0) };
      },
    });
    return { chat, dir, sent, edits, env: () => env, argv: () => argv };
  };
  const msg = (provider: string, model: string, text: string) => ({ type: "message_end", message: { role: "assistant", provider, model, content: [{ type: "text", text }] } });

  test("runs without a health check, passes only the key env, writes the Venice config", async () => {
    const h = harness([{ type: "session", id: "s1" }, msg(PROVIDER, MODEL_ID, "hello")]);
    await h.chat.handle("hi");
    expect(h.edits.at(-1)).toContain("hello");
    expect(h.env().OPENROUTER_API_KEY).toBe("sk-test");
    expect(h.env().ANTHROPIC_API_KEY).toBeUndefined();
    expect(h.argv()).toContain("--no-tools");
    expect(readFileSync(join(h.chat.agentDir, "models.yml"), "utf8")).toBe(MODELS_YML);
    expect(h.chat.sessionId()).toBe("s1");
  });
  test("another model in the stream is refused", async () => {
    const h = harness([msg("anthropic", "claude-opus-5", "x")]);
    await h.chat.handle("hi");
    expect(h.edits.at(-1)).toContain("refused");
  });
  test("no key: nothing runs", async () => {
    const h = harness([msg(PROVIDER, MODEL_ID, "x")], null);
    await h.chat.handle("hi");
    expect(h.sent.at(-1)).toContain("no single enabled OpenRouter key");
    expect(h.argv()).toEqual([]);
  });
});
