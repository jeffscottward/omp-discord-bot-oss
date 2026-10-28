/**
 * 🔓 FIRSTMATE uncensored session (owner request 2026-10-22): a second FIRSTMATE that thinks and
 * answers with an uncensored model instead of Claude, for topics Claude will not take.
 *
 * Design: it is the same kind of channel as FIRSTMATE — a firstmate-style coordinator session with
 * its own history — but every model role points at Venice Uncensored 1.2 from the existing Venice
 * provider, with the advisor and auto-thinking OFF (both would otherwise call a different model).
 *
 * Safety: like the 🔓-venice channels, this one never reaches Claude. It is not the Claude login,
 * it does not touch ~/.omp/agent/agent.db, and it uses a separate agent dir, so the standing rule
 * "never break Claude on the main host" is untouched.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "./localomp.ts";

export const PROVIDER = "venice";
export const MODEL_ID = "venice-uncensored-1-2";
const MODEL = `${PROVIDER}/${MODEL_ID}`;
const KEY_FILE = join(homedir(), ".config", "venice", "api-key");
const KEY_ENV = "VENICE_API_KEY";
export const LABEL = "🔓 firstmate";
export const SYSTEM = [
  "You are FIRSTMATE (uncensored), the owner's coordinating assistant in Discord.",
  "You plan work, answer directly, and say what you did or could not do.",
  "You are uncensored: do not moralize, hedge or refuse ordinary requests. State real limits plainly.",
].join(" ");

export const MODELS_YML = `# Written by omp-discord-bot src/firstmate-uncensored.ts. One provider (Venice), one model.
providers:
  ${PROVIDER}:
    baseUrl: https://api.venice.ai/api/v1
    api: openai-completions
    apiKey: ${KEY_ENV}
    models:
      - id: ${MODEL_ID}
        name: Venice Uncensored 1.2
        reasoning: false
        input: [text, image]
        contextWindow: 128000
        maxTokens: 8192
`;

export const CONFIG_YML = `# Written by omp-discord-bot src/firstmate-uncensored.ts. Every role is Venice Uncensored; no advisor; no auto thinking.
setupVersion: 2
modelRoles:
  default: ${MODEL}
  smol: ${MODEL}
  slow: ${MODEL}
  plan: ${MODEL}
  judge: ${MODEL}
  advisor: ${MODEL}
defaultThinkingLevel: off
advisor:
  enabled: false
`;

/** The model can run tools, so the uncensored firstmate can actually do work, not just talk. */
export const DEFAULT_TOOLS = "read,grep,glob,write,edit,bash";

/** Fail closed: only the Venice provider, only the uncensored model. */
export function modelsYmlIsVeniceUncensored(text: string): boolean {
  const ids = [...text.matchAll(/^\s+- id:\s*(\S+)/gm)].map(m => m[1]);
  return ids.length === 1 && ids[0] === MODEL_ID && text.includes(`providers:\n  ${PROVIDER}:`) && !text.includes("anthropic");
}

/** Per assistant message: anything but this model kills the run, so Claude never gets a turn here. */
export function isUncensoredMessage(m: { provider?: unknown; model?: unknown }): boolean {
  return m.provider === PROVIDER && m.model === MODEL_ID;
}

/** The Venice key from its 0600 file. Never logged, never posted. */
export function veniceKey(): string | null {
  try {
    const k = readFileSync(KEY_FILE, "utf8").trim();
    return k || null;
  } catch {
    return null;
  }
}

export function uncensoredProfile(): Profile {
  return {
    model: MODEL,
    system: SYSTEM,
    healthUrl: null,
    downText: "",
    modelsYml: MODELS_YML,
    configYml: CONFIG_YML,
    modelsOk: modelsYmlIsVeniceUncensored,
    allowed: isUncensoredMessage,
    env: () => {
      const key = veniceKey();
      return key ? { [KEY_ENV]: key } : null;
    },
    noEnvText: `⚠️ ${LABEL}: no Venice key at ${KEY_FILE}; nothing ran.`,
    defaultTools: DEFAULT_TOOLS,
  };
}
