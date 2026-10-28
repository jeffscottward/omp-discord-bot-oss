// The uncensored firstmate must never route a turn to Claude, and must never run without its key.
import { describe, expect, test } from "bun:test";
import {
  CONFIG_YML, MODELS_YML, MODEL_ID, PROVIDER,
  isUncensoredMessage, modelsYmlIsVeniceUncensored, uncensoredProfile,
} from "./src/firstmate-uncensored.ts";

describe("models.yml written for the channel", () => {
  test("has exactly the one Venice model and no Anthropic provider", () => {
    expect(modelsYmlIsVeniceUncensored(MODELS_YML)).toBe(true);
    expect(MODELS_YML).not.toContain("anthropic");
  });

  test("rejects a second model (would allow a fallback)", () => {
    const two = MODELS_YML.replace("        maxTokens: 8192", "        maxTokens: 8192\n      - id: another-model\n        name: x\n        reasoning: false\n        input: [text]\n        contextWindow: 1000\n        maxTokens: 100");
    expect(modelsYmlIsVeniceUncensored(two)).toBe(false);
  });

  test("rejects a Claude provider in the file", () => {
    expect(modelsYmlIsVeniceUncensored(MODELS_YML + "\n  anthropic:\n    api: anthropic\n")).toBe(false);
  });

  test("rejects an empty file", () => {
    expect(modelsYmlIsVeniceUncensored("")).toBe(false);
  });
});

describe("config.yml", () => {
  test("every role is the uncensored model, advisor off, thinking off", () => {
    for (const role of ["default", "smol", "slow", "plan", "judge", "advisor"]) {
      expect(CONFIG_YML).toContain(`  ${role}: ${PROVIDER}/${MODEL_ID}`);
    }
    expect(CONFIG_YML).toContain("enabled: false");
    expect(CONFIG_YML).toContain("defaultThinkingLevel: off");
  });
});

describe("isUncensoredMessage kills the run for any other model", () => {
  test("accepts only Venice Uncensored 1.2", () => {
    expect(isUncensoredMessage({ provider: PROVIDER, model: MODEL_ID })).toBe(true);
  });

  test("rejects Claude, other Venice models and a missing model", () => {
    expect(isUncensoredMessage({ provider: "anthropic", model: "claude-opus-5-5" })).toBe(false);
    expect(isUncensoredMessage({ provider: "venice", model: "zai-org-glm-5-2" })).toBe(false);
    expect(isUncensoredMessage({})).toBe(false);
    expect(isUncensoredMessage({ provider: PROVIDER })).toBe(false);
  });
});

describe("profile", () => {
  test("is pinned to the model and uses tools", () => {
    const p = uncensoredProfile();
    expect(p.model).toBe(`${PROVIDER}/${MODEL_ID}`);
    expect(p.defaultTools).toContain("bash");
    expect(p.system).toContain("uncensored");
  });

  test("refuses to run with no key (fail closed, never falls back)", () => {
    const p = uncensoredProfile();
    expect(p.noEnvText).toContain("nothing ran");
    const env = p.env();
    // With a key file present it returns the variable; either way there is no other credential path.
    if (env) expect(Object.keys(env)).toEqual(["VENICE_API_KEY"]);
  });
});
