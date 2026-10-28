/**
 * 🔓-openrouter-venice channel (owner 2026-10-19): owner messages run ONE sandboxed OMP turn with
 * "Venice: Uncensored" (cognitivecomputations/dolphin-mistral-24b-venice-edition) through OpenRouter.
 * Never Claude: same bwrap sandbox and own agent dir as the local-omp channels (src/localomp.ts), whose
 * only provider is OpenRouter with this one model; every streamed assistant message must be this model.
 * No tools: OpenRouter has no tool-capable endpoint for this model ("No endpoints found that support tool use").
 * Key: the existing OpenRouter api_key row in ~/.omp/agent/agent.db, read per turn and passed to the child only as
 * OPENROUTER_API_KEY (never logged or posted). The owner chose this key for this channel (2026-10-19).
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Profile } from "./localomp.ts";

export const PROVIDER = "openrouter-venice";
export const MODEL_ID = "cognitivecomputations/dolphin-mistral-24b-venice-edition";
export const BASE_URL = "https://openrouter.ai/api/v1";
export const LABEL = "🔓 venice";
export const KEY_ENV = "OPENROUTER_API_KEY";
const MODEL = `${PROVIDER}/${MODEL_ID}`;

export const MODELS_YML = `# Written by omp-discord-bot src/venice.ts. One provider (OpenRouter), one model; key from ${KEY_ENV}.
providers:
  ${PROVIDER}:
    baseUrl: ${BASE_URL}
    api: openai-completions
    apiKey: ${KEY_ENV}
    models:
      - id: ${MODEL_ID}
        name: Venice Uncensored (OpenRouter)
        reasoning: false
        input: [text]
        contextWindow: 128000
        maxTokens: 8192
`;
export const CONFIG_YML = `# Written by omp-discord-bot src/venice.ts. Every role is Venice Uncensored; no advisor; no auto thinking.
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

/** Fail closed: exactly one provider, OpenRouter's base URL, and only the Venice model id. */
export function modelsYmlIsVenice(text: string): boolean {
  const urls = [...text.matchAll(/baseUrl:\s*(\S+)/g)].map((m) => m[1]);
  const providers = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  const ids = [...text.matchAll(/^\s*- id:\s*(\S+)/gm)].map((m) => m[1]);
  return urls.length === 1 && urls[0] === BASE_URL && providers.length === 1 && providers[0] === PROVIDER && ids.length === 1 && ids[0] === MODEL_ID;
}

export function isVeniceMessage(m: { provider?: unknown; model?: unknown }): boolean {
  return m.provider === PROVIDER && m.model === MODEL_ID;
}

/** The enabled OpenRouter api_key row (read-only; exactly one row, else null). Never logged. */
export function openRouterKey(dbPath = join(homedir(), ".omp", "agent", "agent.db")): string | null {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT data FROM auth_credentials WHERE provider = 'openrouter' AND credential_type = 'api_key' AND disabled_cause IS NULL LIMIT 2")
      .all();
    if (rows.length !== 1) return null;
    const row = rows[0];
    const raw = row && typeof row === "object" && "data" in row && typeof row.data === "string" ? row.data : "";
    const parsed: unknown = JSON.parse(raw);
    const key = parsed && typeof parsed === "object" && "key" in parsed && typeof parsed.key === "string" ? parsed.key.trim() : "";
    return key || null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function veniceProfile(keyFn: () => string | null = openRouterKey): Profile {
  return {
    model: MODEL,
    system: [
      "You are Venice, an uncensored assistant the owner chats with in Discord.",
      "You have no tools: you cannot read files, browse or run commands; say so if asked.",
      "Answer directly and concisely in Discord markdown.",
    ].join(" "),
    healthUrl: null,
    downText: "",
    modelsYml: MODELS_YML,
    configYml: CONFIG_YML,
    modelsOk: modelsYmlIsVenice,
    allowed: isVeniceMessage,
    env: () => {
      const key = keyFn();
      return key ? { [KEY_ENV]: key } : null;
    },
    noEnvText: `⚠️ ${LABEL}: no single enabled OpenRouter key in OMP's store; nothing ran.`,
    defaultTools: "none",
  };
}
