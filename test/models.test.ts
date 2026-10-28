import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelOverrides, UNRESTRICTED_MODEL, VENICE_MODELS, allowedModel, defaultModel, pickModels, resolveOverride } from "../src/models.ts";
import { QWEN_OVERLAY, ompArgs, qwenSessionKey, runOmp } from "../src/omp.ts";

describe("/models overrides", () => {
  test("persist across instances and clear with null", () => {
    const f = join(mkdtempSync(join(tmpdir(), "models-")), "o.json");
    new ModelOverrides(f).set("c1", "anthropic/claude-sonnet-5-5");
    expect(new ModelOverrides(f).get("c1")).toBe("anthropic/claude-sonnet-5-5");
    const o = new ModelOverrides(f);
    o.set("c1", null);
    expect(new ModelOverrides(f).get("c1")).toBeNull();
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({});
  });
  test("owner 2026-10-25: Codex/OpenRouter/local allowed; plain openai and unknown providers refused", () => {
    const o = new ModelOverrides(join(mkdtempSync(join(tmpdir(), "models-")), "o.json"));
    for (const m of ["openai-codex/gpt-6-astra", "openrouter/~anthropic/claude-opus-latest", "local-coder/local-coder"]) expect(allowedModel(m)).toBe(true);
    for (const m of ["openai/gpt-5", "evil/x"]) {
      expect(allowedModel(m)).toBe(false);
      expect(() => o.set("c", m)).toThrow();
    }
    expect(allowedModel(UNRESTRICTED_MODEL)).toBe(false); // owner 2026-10-20: unrestricted.sh dropped
  });
  test("menu list: Claude + the Venice models only (owner 2026-10-20; unrestricted.sh dropped), no dated duplicates", () => {
    const list = pickModels({
      models: [
        { provider: "anthropic", selector: "anthropic/claude-opus-5-5" },
        { provider: "anthropic", selector: "anthropic/claude-opus-4-20250514" },
        { provider: "openai-codex", selector: "openai-codex/gpt-5" },
        { provider: "openrouter", selector: "openrouter/a/b" },
        { provider: "unrestricted", selector: UNRESTRICTED_MODEL },
      ],
    });
    expect(list).toEqual(["anthropic/claude-opus-5-5", ...Object.keys(VENICE_MODELS)]);
  });
  test("default model from config.yml", () => {
    const f = join(mkdtempSync(join(tmpdir(), "models-")), "config.yml");
    require("node:fs").writeFileSync(f, "x: 1\nmodelRoles:\n  smol: a/b\n  default: anthropic/claude-opus-5-5\n");
    expect(defaultModel(f)).toBe("anthropic/claude-opus-5-5");
  });
});

describe("runOmp model", () => {
  test("argv includes --model only when set", () => {
    expect(ompArgs("1", "hi", false, undefined, "anthropic/claude-sonnet-5-5")).toEqual(expect.arrayContaining(["--model", "anthropic/claude-sonnet-5-5"]));
    expect(ompArgs("1", "hi", false)).not.toContain("--model");
  });
  test("unrestricted qwen: --model plus the Qwen-only overlay and thinking off (no advisor, no Claude roles)", () => {
    const args = ompArgs("1", "hi", false, undefined, UNRESTRICTED_MODEL);
    expect(args).toEqual(expect.arrayContaining(["--model", UNRESTRICTED_MODEL, "--config", QWEN_OVERLAY, "--thinking", "off"]));
    const overlay = readFileSync(QWEN_OVERLAY, "utf8");
    expect(overlay).toMatch(/advisor:\n {2}enabled: false/);
    expect(overlay).not.toMatch(/anthropic\//);
    expect(ompArgs("1", "hi", false, undefined, "anthropic/claude-opus-5-5")).not.toContain("--config");
  });
  test("Qwen and Claude never share a session (owner 2026-10-19)", async () => {
    expect(qwenSessionKey("mirror-123", UNRESTRICTED_MODEL)).toBe("mirror-123-qwen");
    expect(qwenSessionKey("mirror-123", "anthropic/claude-opus-5-5")).toBe("mirror-123");
    expect(qwenSessionKey("mirror-123", undefined)).toBe("mirror-123");
    await expect(runOmp("mirror-123", "/tmp", "hi", { channelId: "x", model: UNRESTRICTED_MODEL })).rejects.toThrow(/-qwen session/);
    await expect(runOmp("mirror-123-qwen", "/tmp", "hi", { channelId: "x", model: UNRESTRICTED_MODEL, resumeFile: "/tmp/pane.jsonl" })).rejects.toThrow(/-qwen session/);
  });
});

describe("/models routing decision", () => {
  // resolveOverride is what handle() calls: thread override first, then parent channel; every pick (qwen included) goes to runOmp.
  const decide = (o: ModelOverrides, ch: string, parent: string | null) => ({ runOmpModel: resolveOverride(o, ch, parent) });
  test("qwen and Claude both route to runOmp with --model, default clears", () => {
    const o = new ModelOverrides(join(mkdtempSync(join(tmpdir(), "models-")), "o.json"));
    o.set("chan", "venice/zai-org-glm-5-2");
    expect(decide(o, "chan", null)).toEqual({ runOmpModel: "venice/zai-org-glm-5-2" });
    expect(decide(o, "thread", "chan")).toEqual({ runOmpModel: "venice/zai-org-glm-5-2" });
    o.set("thread", "anthropic/claude-sonnet-5-5");
    expect(decide(o, "thread", "chan")).toEqual({ runOmpModel: "anthropic/claude-sonnet-5-5" });
    o.set("chan", null);
    expect(decide(o, "chan", null)).toEqual({ runOmpModel: undefined });
  });
});

test("two-tier picker groups models by provider (owner 2026-10-25)", async () => {
  const { groupModels } = await import("../src/models.ts");
  const g = groupModels({ models: [
    { provider: "anthropic", selector: "anthropic/claude-a" }, { provider: "anthropic", selector: "anthropic/claude-a-20250101" },
    { provider: "openai-codex", selector: "openai-codex/gpt-6-astra" },
    { provider: "openrouter", selector: "openrouter/x/y" }, { provider: "openrouter", selector: "openrouter/~x/y-latest" },
  ] });
  expect(g.anthropic).toEqual(["anthropic/claude-a"]);
  expect(g["openai-codex"]).toEqual(["openai-codex/gpt-6-astra"]);
  expect(g.openrouter).toEqual(["openrouter/~x/y-latest"]);
});

test("non-Anthropic picks run in their own session (owner 2026-10-25)", async () => {
  const { qwenSessionKey } = await import("../src/omp.ts");
  expect(qwenSessionKey("ch-1", "openai-codex/gpt-6-astra")).toBe("ch-1-codex");
  expect(qwenSessionKey("ch-1", "openrouter/~x/y-latest")).toBe("ch-1-openrouter");
  expect(qwenSessionKey("ch-1", "anthropic/claude-opus-5-5")).toBe("ch-1");
});
