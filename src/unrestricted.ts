/**
 * RETIRED 2026-10-19 (owner): the 🔓 channel and /models Qwen now run trusted turns (policy.unrestrictedRoute,
 * config/qwen-trusted-overlay.yml). Only MODEL_ID/PROVIDER are still used; the sandbox profile below is unused.
 * 🔓-unrestricted-qwen channel (owner 2026-10-19): owner messages run ONE sandboxed OMP turn with
 * qwen3.8-27b-uncensored on unrestricted.sh. Never Claude: same bwrap sandbox and own agent dir as the
 * local-omp channels (src/localomp.ts); the only provider is unrestricted.sh with this one model, and every
 * streamed assistant message must be this model.
 * Key: ~/.config/unrestricted/api-key (0600, written by ~/Github/tools/unrestricted-sh/save-key.sh), read per
 * turn and passed to the child only as UNRESTRICTED_API_KEY (never logged or posted). No key: nothing runs.
 * Tools: read,grep,glob,write,edit inside the sandbox (the site says the model works in coding agents;
 * tool calling is not verified yet). Set config.json `unrestrictedTools` to "none" for chat only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "./localomp.ts";

export const PROVIDER = "unrestricted";
export const MODEL_ID = "qwen3.8-27b-uncensored";
export const BASE_URL = "https://api.unrestricted.sh/v1";
export const LABEL = "🔓 qwen";
export const KEY_ENV = "UNRESTRICTED_API_KEY";
export const KEY_FILE = join(homedir(), ".config", "unrestricted", "api-key");
const MODEL = `${PROVIDER}/${MODEL_ID}`;

export const MODELS_YML = `# Written by omp-discord-bot src/unrestricted.ts. One provider (unrestricted.sh), one model; key from ${KEY_ENV}.
providers:
  ${PROVIDER}:
    baseUrl: ${BASE_URL}
    api: openai-completions
    apiKey: ${KEY_ENV}
    models:
      - id: ${MODEL_ID}
        name: Qwen3.8 27B Uncensored (unrestricted.sh)
        reasoning: false
        input: [text]
        contextWindow: 262144
        maxTokens: 8192
`;
export const CONFIG_YML = `# Written by omp-discord-bot src/unrestricted.ts. Every role is Qwen3.8 27B Uncensored; no advisor; no auto thinking.
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
startup:
  quiet: true
`;

/** Fail closed: exactly one provider, the unrestricted.sh base URL, and only the Qwen model id. */
export function modelsYmlIsUnrestricted(text: string): boolean {
  const urls = [...text.matchAll(/baseUrl:\s*(\S+)/g)].map((m) => m[1]);
  const providers = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  const ids = [...text.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1]);
  return urls.length === 1 && urls[0] === BASE_URL && providers.length === 1 && providers[0] === PROVIDER && ids.length === 1 && ids[0] === MODEL_ID;
}

export function isUnrestrictedMessage(m: { provider?: unknown; model?: unknown }): boolean {
  return m.provider === PROVIDER && m.model === MODEL_ID;
}

/** The saved key: one `unr_sk_` token, no repeats; else null. Never logged. */
export function unrestrictedKey(file = KEY_FILE): string | null {
  try {
    const key = readFileSync(file, "utf8").trim();
    return /^unr_sk_\S+$/.test(key) && !key.slice(7).includes("unr_sk_") ? key : null;
  } catch {
    return null;
  }
}

export function unrestrictedProfile(keyFn: () => string | null = unrestrictedKey): Profile {
  return {
    model: MODEL,
    system: [
      "You are Qwen, an uncensored assistant the owner chats with in Discord, running on his main with a few tools.",
      "Use the read tool to read files and web pages (pass a URL as the path).",
      "Your working directory is the only place you can write; write files there with relative paths.",
      "Answer directly and concisely in Discord markdown.",
    ].join(" "),
    healthUrl: null,
    downText: "",
    modelsYml: MODELS_YML,
    configYml: CONFIG_YML,
    modelsOk: modelsYmlIsUnrestricted,
    allowed: isUnrestrictedMessage,
    env: () => {
      const key = keyFn();
      return key ? { [KEY_ENV]: key } : null;
    },
    noEnvText: `⚠️ ${LABEL}: no unrestricted.sh API key saved yet (~/.config/unrestricted/api-key); nothing ran. Top up, create a key, then ask for the key-entry pane.`,
    defaultTools: "read,grep,glob,write,edit",
  };
}
