/**
 * /models (owner 2026-10-19): per-channel model override, like OMP's /models.
 * - The override is saved in <state>/model-overrides.json (survives restarts). No override = the bot default
 *   (`modelRoles.default` in ~/.omp/agent/config.yml).
 * - The menu is two-tier (provider, then model); see PROVIDERS below (owner 2026-10-25).
 * - Picking qwen in /models runs it like any other model: the normal runOmp turn with `--model`, the trusted
 *   tools and ~/.omp/agent (owner 2026-10-19). The 🔓-unrestricted-qwen channel is trusted too, pinned to Qwen.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_ID, PROVIDER } from "./unrestricted.ts";

export const UNRESTRICTED_MODEL = `${PROVIDER}/${MODEL_ID}`;
export const PREFIX = "models:";
export const DEFAULT_VALUE = "__default__";
const MAX_OPTIONS = 25; // Discord select-menu limit (one slot is "default")

export const isUnrestrictedModel = (m: string | null | undefined) => m === UNRESTRICTED_MODEL;
/**
 * Owner 2026-10-21: the Venice models offered in /models are read fresh from the `venice` provider in
 * ~/.omp/agent/models.yml every time (add a model there and it appears; no code change or restart).
 * Only that curated list is offered, never Venice's ~130 auto-discovered models (they include Claude copies).
 */
export const MODELS_YML = join(homedir(), ".omp", "agent", "models.yml");
export function veniceModels(file = MODELS_YML): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const block = text.match(/^  venice:\n([\s\S]*?)(?=^  [A-Za-z][\w-]*:\s*$|(?![\s\S]))/m)?.[1] ?? "";
  for (const m of block.matchAll(/^\s+- id:\s*(\S+)\s*\n(?:\s+name:\s*(.+)\n)?/gm)) {
    out[`venice/${m[1]}`] = `Venice · ${(m[2] ?? m[1] ?? "").replace(/\s*\(Venice\)\s*$/, "").trim()}`.slice(0, 100);
  }
  return out;
}
/** Kept for callers/tests: the current curated Venice list (re-read on each access). */
export const VENICE_MODELS: Record<string, string> = new Proxy({}, {
  get: (_t, k) => veniceModels()[String(k)],
  has: (_t, k) => String(k) in veniceModels(),
  ownKeys: () => Reflect.ownKeys(veniceModels()),
  getOwnPropertyDescriptor: (_t, k) => {
    const v = veniceModels()[String(k)];
    return v === undefined ? undefined : { value: v, enumerable: true, configurable: true };
  },
});
export const isVeniceModel = (m: string | null | undefined) => !!m && m in veniceModels();
/** Description shown under a model in the /models menu. */
export const modelDescription = (m: string) => (isUnrestrictedModel(m) ? "unrestricted.sh, full tools like Claude" : VENICE_MODELS[m]);

/** Allowed selectors: anthropic/claude-*, venice/*, openai-codex/*, openrouter/* and local-coder/*. */
export function allowedModel(sel: string): boolean {
  // Owner 2026-10-25: every provider in the two-tier picker may be chosen per channel.
  if (/^(openai-codex|openrouter|local-coder)\/[A-Za-z0-9._~:\/-]+$/.test(sel)) return true;
  if (isVeniceModel(sel)) return true; // owner 2026-10-20: unrestricted.sh dropped, Venice replaces it
  return /^anthropic\/claude-[a-z0-9.-]+$/.test(sel);
}

/** Menu list from `omp models --json` output: allowed models only, dated duplicates dropped, newest first. */
export function pickModels(catalog: { models?: { provider?: string; selector?: string; kind?: string }[] }): string[] {
  const sels = (catalog.models ?? [])
    .filter((m) => (m.kind ?? "chat") === "chat" && typeof m.selector === "string")
    .map((m) => m.selector as string)
    .filter((s) => allowedModel(s) && /^(anthropic|venice)\//.test(s) && !/-\d{8}$/.test(s));
  const extra = Object.keys(VENICE_MODELS);
  const claude = [...new Set(sels.filter((s) => !extra.includes(s)))].reverse();
  return [...claude.slice(0, MAX_OPTIONS - 1 - extra.length), ...extra];
}

// Owner 2026-10-21: no cache; every /models re-queries what is available.
export function listModels(ompBin = join(homedir(), ".local", "bin", "omp")): string[] {
  const r = spawnSync(ompBin, ["models", "--json"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  let list: string[] = Object.keys(VENICE_MODELS);
  try {
    list = pickModels(JSON.parse(r.stdout));
  } catch {}
  return list;
}

/** The bot's default model: `modelRoles.default` in OMP's config.yml. */
export function defaultModel(file = join(homedir(), ".omp", "agent", "config.yml")): string {
  try {
    const m = readFileSync(file, "utf8").match(/^modelRoles:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:\s*(\S+)/m);
    if (m?.[1]) return m[1];
  } catch {}
  return "default";
}

export class ModelOverrides {
  private map: Record<string, string>;
  constructor(private file: string) {
    this.map = {};
    try {
      if (existsSync(file)) this.map = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  get(channelId: string | null | undefined): string | null {
    if (!channelId) return null;
    const v = this.map[channelId];
    return v && allowedModel(v) ? v : null;
  }
  /** null clears. Refuses models outside the allowed set. */
  set(channelId: string, model: string | null): void {
    if (model !== null && !allowedModel(model)) throw new Error(`model not allowed: ${model}`);
    if (model === null) delete this.map[channelId];
    else this.map[channelId] = model;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.map, null, 2));
    renameSync(tmp, this.file);
  }
}

/** The /models pick for a turn: the thread's own override, else its parent channel's; undefined = bot default. Qwen included. */
export function resolveOverride(o: Pick<ModelOverrides, "get">, channelId: string, parentId: string | null | undefined): string | undefined {
  return o.get(channelId) ?? o.get(parentId) ?? undefined;
}

/** Footer line for answers. */
export const modelFooter = (model: string) => `-# 🧠 ${model}`;

/**
 * Owner 2026-10-25: two-tier /models picker. Provider first, then a model of that provider.
 * Providers shown when OMP lists models for them. Each provider list is capped at 24 (Discord select limit, one slot
 * for "default"). OpenRouter shows its "~vendor/…-latest" aliases (a curated subset of 500+ models).
 */
export const PROVIDER_PREFIX = "models-p:";
export const PROVIDERS: { id: string; label: string; emoji: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", emoji: "🟠" },
  { id: "openai-codex", label: "OpenAI (Codex)", emoji: "🟢" },
  { id: "venice", label: "Venice", emoji: "🎭" },
  { id: "openrouter", label: "OpenRouter", emoji: "🔀" },
  { id: "local-coder", label: "Local (llama.cpp)", emoji: "🧠" },
];
export const providerOf = (sel: string) => sel.split("/")[0] ?? "";
export function groupModels(catalog: { models?: { provider?: string; selector?: string; kind?: string }[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const chat = (catalog.models ?? []).filter((m) => (m.kind ?? "chat") === "chat" && typeof m.selector === "string");
  for (const p of PROVIDERS) {
    let sels = chat.filter((m) => m.provider === p.id).map((m) => m.selector as string);
    if (p.id === "anthropic") sels = [...new Set(sels.filter((s) => !/-\d{8}$/.test(s)))].reverse();
    if (p.id === "venice") sels = Object.keys(veniceModels());
    if (p.id === "openrouter") sels = sels.filter((s) => s.startsWith("openrouter/~"));
    if (sels.length) out[p.id] = sels.slice(0, MAX_OPTIONS - 1);
  }
  return out;
}
export function listGrouped(ompBin = join(homedir(), ".local", "bin", "omp")): Record<string, string[]> {
  const r = spawnSync(ompBin, ["models", "--json"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  try {
    return groupModels(JSON.parse(r.stdout));
  } catch {
    return { venice: Object.keys(veniceModels()) };
  }
}
