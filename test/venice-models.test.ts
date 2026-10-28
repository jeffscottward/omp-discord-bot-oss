import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allowedModel, pickModels, VENICE_MODELS } from "../src/models.ts";
import { isolatedTag, ompArgs, qwenSessionKey } from "../src/omp.ts";

// Owner 2026-10-20: Venice models in /models; they run isolated (own session, all roles Venice, no advisor).
test("Venice models are allowed and listed after Claude, within 25 options", () => {
  expect(allowedModel("venice/zai-org-glm-5-2")).toBe(true);
  expect(allowedModel("venice/claude-opus-5-5")).toBe(false);
  const cat = { models: [...Array.from({ length: 40 }, (_, i) => ({ selector: `anthropic/claude-x-${i}` })), { selector: "venice/zai-org-glm-5-2" }] };
  const list = pickModels(cat);
  expect(list.length).toBeLessThanOrEqual(24);
  for (const v of Object.keys(VENICE_MODELS)) expect(list).toContain(v);
});
test("Venice turns get their own session and a Venice-only overlay", () => {
  expect(isolatedTag("venice/zai-org-glm-5-2")).toBe("venice");
  expect(isolatedTag("anthropic/claude-opus-5-5")).toBeNull();
  expect(qwenSessionKey("ch1", "venice/gemma-4-uncensored")).toBe("ch1-venice");
  expect(qwenSessionKey("ch1", "unrestricted/qwen3.8-27b-uncensored")).toBe("ch1-qwen");
  const args = ompArgs("ch1-venice", "hi", false, undefined, "venice/zai-org-glm-5-2");
  const i = args.indexOf("--config");
  expect(i).toBeGreaterThan(-1);
  const overlay = readFileSync(args[i + 1]!, "utf8");
  expect(overlay).toContain("enabled: false");
  expect(overlay).toContain("advisor: venice/zai-org-glm-5-2");
  expect(overlay).not.toContain("anthropic");
  expect(overlay).not.toContain("typesafe"); // no fallback to the decisions-only judge model
  expect(overlay).toContain("judge: []");
  expect(args).toContain("--thinking");
});

test("Venice menu list is read fresh from models.yml (owner 2026-10-21)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { veniceModels } = await import("../src/models.ts");
  const f = join(mkdtempSync(join(tmpdir(), "vm-")), "models.yml");
  writeFileSync(f, "providers:\n  local-coder:\n    models:\n      - id: x\n  venice:\n    baseUrl: u\n    models:\n      - id: a-1\n        name: Model A (Venice)\n        reasoning: true\n      - id: b-2\n  other:\n    models:\n      - id: c\n");
  expect(veniceModels(f)).toEqual({ "venice/a-1": "Venice · Model A", "venice/b-2": "Venice · b-2" });
  writeFileSync(f, "providers:\n  venice:\n    models:\n      - id: a-1\n        name: A\n      - id: new-3\n        name: New (Venice)\n");
  expect(Object.keys(veniceModels(f))).toEqual(["venice/a-1", "venice/new-3"]);
});
