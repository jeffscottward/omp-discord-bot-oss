import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RouterConfigInput } from "./router.ts";

const HOME = homedir();

/**
 * Per-install settings (Discord ids, channels, dashboard URL, host labels). They live in an untracked
 * JSON file so the repo has no personal values: `~/.config/omp-discord/config.json`, or the file in
 * `OMP_BOT_CONFIG`. `config.example.json` in the repo lists every key. Secrets stay in bot.env.
 */
export const CONFIG_FILE = process.env.OMP_BOT_CONFIG ?? join(HOME, ".config", "omp-discord", "config.json");

export type BotConfig = {
  ownerId: string;
  guildId: string;
  /** Text channel id → { name, cwd }. Only these channels start agent runs. `cwd` may start with `~/`. */
  channels: Record<string, { name: string; cwd: string }>;
  /** Post-only channels reachable through the loopback /post endpoint (never start runs). */
  alertChannels: Record<string, { name: string }>;
  /** #omp-alerts: self-tests, limit alerts, sandbox approvals. */
  alertsChannelId: string;
  /** FIRSTMATE (mirrored channel of the main coordinating session). */
  firstmateChannelId: string;
  voiceChannelId: string;
  voiceTranscriptChannelId: string;
  longJobsChannelId: string;
  /** 🔔-needs-you (owner 2026-10-22): post-only channel with the live ✍️ Needs you board at the bottom (src/needsyou.ts). Empty: off. */
  needsYouChannelId: string;
  radioChannelId: string;
  /** 🧠-local-model (optional): owner messages there go only to a local llama.cpp model (src/localmodel.ts). */
  localModelChannelId: string;
  /** 🧠-local-omp (optional): owner messages there run one OMP turn with the local model and tools (src/localomp.ts). */
  localOmpChannelId: string;
  /** All local-omp channels (owner 2026-10-19). Each gets its own session and work dir; the first is the main one. Default: [localOmpChannelId]. */
  localOmpChannelIds: string[];
  /** Tools for the local-omp channels (comma list). Default read,grep,glob,write,edit; add ",bash" to allow commands (still sandboxed). */
  localOmpTools: string;
  /** 🔓-openrouter-venice channels (owner 2026-10-19): OMP turns with Venice Uncensored via OpenRouter only (src/venice.ts). */
  veniceChannelIds: string[];
  /** 🔓 FIRSTMATE uncensored channels (owner 2026-10-22): a firstmate-style coordinator session on
   *  Venice Uncensored 1.2, own history, advisor and auto thinking off (src/firstmate-uncensored.ts). */
  uncensoredChannelIds: string[];
  /** Standing channels (owner 2026-10-22): never auto-archived by channel cleanup, their tabs never auto-closed. */
  keepChannelIds: string[];
  /** 🔓-unrestricted-qwen channels (owner 2026-10-19): trusted OMP turns (no sandbox, cwd ~/Github) pinned to qwen3.8-27b-uncensored (policy.unrestrictedRoute). */
  unrestrictedChannelIds: string[];
  /** Owner 2026-10-19: channels (and their threads) where a turn stopped by the time limit gets an automatic
   * "continue", with no limit (❌ Stop ends it). 🔓-unrestricted-qwen channels are always included. */
  timeLimitContinueChannelIds: string[];
  /** Unused since the 🔓 channel became trusted (2026-10-19); kept so old config files still load. */
  unrestrictedTools: string;
  mirror: {
    /** Category ids: local host panes, peer host panes, archive for closed panes. */
    categories: { local: string; peer: string; archive: string };
    /** More archive categories, used in order when 📦 Archive holds 50 channels (Discord's per-category limit). */
    archives: string[];
    /** Optional (proposed 2026-10-24; the owner has not chosen it yet): more categories for this machine's live pane
     * channels, used in order when the local category holds 50 channels. Empty: a full category gets no new channel. */
    overflow: string[];
    /** Extra machines whose Herdr panes are mirrored (over ssh). Empty: only this machine. */
    peers: { machine: string; ssh: string; herdr: string }[];
  };
  /** FIRSTMATE dashboard base URL (ends with /). Empty: replies carry no dashboard link. */
  dashboardUrl: string;
  /** Name of this machine in messages ("runs on <hostLabel>"). */
  hostLabel: string;
  /** Working indicator; a custom animated emoji such as `<a:spin_gear:123…>` or a plain emoji. */
  workingEmoji: string;
  /** FIRSTMATE dashboard folder (items.json, web files). `~/` allowed. */
  fmDir: string;
  /** HEELER (iOS Herdr app) deep links: host name saved in Heeler, and an https redirect page (empty: no buttons). */
  heeler: { host: string; redirect: string };
  /** Optional slash commands that need owner-specific hardware or accounts (see docs/FEATURES.md). */
  optionalCommands: string[];
  /** Owner-only integrations (all off by default). */
  features: { newsletterLogin: boolean };
  /** Sandboxed runs: extra public IPs the egress proxy refuses (for example a finance remote host). */
  sandbox: { denyIps: string[] };
  /** FIRSTMATE fan-out router (src/router.ts): stacks, judge, parallel cap. Omitted: defaults (on). */
  router?: RouterConfigInput;
};

export const DEFAULT_CONFIG: BotConfig = {
  ownerId: "",
  guildId: "",
  channels: {},
  alertChannels: {},
  alertsChannelId: "",
  firstmateChannelId: "",
  voiceChannelId: "",
  voiceTranscriptChannelId: "",
  longJobsChannelId: "",
  needsYouChannelId: "",
  radioChannelId: "",
  localModelChannelId: "",
  localOmpChannelId: "",
  localOmpChannelIds: [],
  localOmpTools: "read,grep,glob,write,edit",
  veniceChannelIds: [],
  uncensoredChannelIds: [],
  keepChannelIds: [],
  unrestrictedChannelIds: [],
  timeLimitContinueChannelIds: [],
  unrestrictedTools: "",
  mirror: { categories: { local: "", peer: "", archive: "" }, archives: [], overflow: [], peers: [] },
  dashboardUrl: "",
  hostLabel: "this machine",
  workingEmoji: "⚙️",
  fmDir: "~/.local/share/omp-discord/reports-web/firstmate",
  heeler: { host: "", redirect: "" },
  optionalCommands: [],
  features: { newsletterLogin: false },
  sandbox: { denyIps: [] },
};

/** Optional slash commands; every other command is always registered. */
export const OPTIONAL_COMMANDS = ["rgb", "nest", "blinds", "stream", "second"] as const;

function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return isAbsolute(p) ? p : join(HOME, p);
}

/** Reads and merges a config file over the defaults. Missing file: defaults (the bot then ignores everyone). */
export function loadConfig(file = CONFIG_FILE): BotConfig {
  let raw: Partial<BotConfig> = {};
  let text: string | undefined;
  try {
    if (existsSync(file)) text = readFileSync(file, "utf8");
  } catch {
    text = undefined; // unreadable (for example masked inside a sandboxed run): use the defaults
  }
  if (text !== undefined) {
    try {
      raw = JSON.parse(text) as Partial<BotConfig>;
    } catch (e) {
      throw new Error(`config: ${file} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const c: BotConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    mirror: {
      categories: { ...DEFAULT_CONFIG.mirror.categories, ...raw.mirror?.categories },
      peers: raw.mirror?.peers ?? [],
      archives: raw.mirror?.archives ?? [],
      overflow: raw.mirror?.overflow ?? [],
    },
    features: { ...DEFAULT_CONFIG.features, ...raw.features },
    heeler: { ...DEFAULT_CONFIG.heeler, ...raw.heeler },
    sandbox: { denyIps: raw.sandbox?.denyIps ?? [] },
  };
  c.fmDir = expandHome(c.fmDir);
  c.channels = Object.fromEntries(Object.entries(c.channels).map(([id, v]) => [id, { name: v.name, cwd: expandHome(v.cwd) }]));
  if (c.dashboardUrl && !c.dashboardUrl.endsWith("/")) c.dashboardUrl += "/";
  c.localOmpChannelIds = [...new Set([c.localOmpChannelId, ...(c.localOmpChannelIds ?? [])].filter(Boolean))];
  c.uncensoredChannelIds = [...new Set((c.uncensoredChannelIds ?? []).filter(Boolean))];
  c.keepChannelIds = [...new Set((c.keepChannelIds ?? []).filter(Boolean))];
  return c;
}

export const CONFIG = loadConfig();

export const OWNER_ID = CONFIG.ownerId;
export const GUILD_ID = CONFIG.guildId;

/** Text channel id → { name, cwd }. Only these channels start agent runs. */
export const CHANNELS: Record<string, { name: string; cwd: string }> = CONFIG.channels;

/**
 * Post-only alert channels (owner decision 2026-10-13: Discord replaces ntfy). Reachable through
 * the loopback /post endpoint; messages there never start agent runs.
 */
export const ALERT_CHANNELS: Record<string, { name: string }> = CONFIG.alertChannels;

/** DMs have no channel mapping; they run in ~/Github. */
export const DM_CWD = join(HOME, "Github");

/**
 * Voice conversation mode (owner request 2026-10-13): "🎧 OMP Voice". The owner joining it turns
 * voice mode on; leaving turns it off.
 */
export const VOICE_CHANNEL_ID = CONFIG.voiceChannelId;
/** 📝 voice-transcript: log of every voice-call turn; also where spoken turns go when the owner has not written anywhere yet. */
export const VOICE_TRANSCRIPT_CHANNEL_ID = CONFIG.voiceTranscriptChannelId;
/** Where spoken turns run when the owner has not written anywhere since the bot started. Must be a channel
 * that starts runs (the transcript channel is post-only, so turns sent there were silently dropped). */
export const VOICE_FALLBACK_CHANNEL_ID = CONFIG.firstmateChannelId;

/** Self-tests and sandbox-cli approvals post to #omp-alerts. */
export const DEV_CHANNEL_ID = CONFIG.alertsChannelId;
export const FIRSTMATE_CHANNEL_ID = CONFIG.firstmateChannelId;
/** 🧠-local-model in 🔔 Alerts (owner 2026-10-19): owner messages go ONLY to the local llama.cpp model (src/localmodel.ts). Empty: off. */
export const LOCAL_MODEL_CHANNEL_ID = CONFIG.localModelChannelId;
/** 🧠-local-omp (owner 2026-10-19, card local-omp-channel): OMP turns with the local model only. Empty: off. */
export const LOCAL_OMP_CHANNEL_ID = CONFIG.localOmpChannelId;
export const NEEDS_YOU_CHANNEL_ID = CONFIG.needsYouChannelId;
export const DASHBOARD_BASE_URL = CONFIG.dashboardUrl;
export const HOST_LABEL = CONFIG.hostLabel;
export const FM_DIR = process.env.FM_DIR ?? CONFIG.fmDir;
export const WORKING_EMOJI = process.env.OMP_WORKING_EMOJI ?? CONFIG.workingEmoji;
export function commandEnabled(name: string): boolean {
  return !(OPTIONAL_COMMANDS as readonly string[]).includes(name) || CONFIG.optionalCommands.includes(name);
}

export const MAX_CONCURRENT = Number(process.env.OMP_BOT_MAX_CONCURRENT ?? 2);
/** Hard cap per run (safety net only). Owner 2026-10-19: runs end on inactivity (IDLE_TIMEOUT_MS), not on a 30-min clock. */
export const RUN_TIMEOUT_MS = Number(process.env.OMP_BOT_TIMEOUT_MIN ?? 240) * 60_000;
/**
 * Owner 2026-10-19: a run is stopped when its session log (main or subagent) has not changed for this long.
 * Measured 2026-10-19 over 105 bot sessions (14 days): model gaps p99.9 = 0.8 min; tool gaps p99.9 = 3.6 min,
 * longer gaps were almost all `wait` (max 20.8 min), one `read` 10.6 min, one `eval` 7.3 min.
 */
export const IDLE_TIMEOUT_MS = Number(process.env.OMP_BOT_IDLE_MIN ?? 10) * 60_000;

export const STATE_DIR =
  process.env.OMP_BOT_STATE_DIR ?? join(HOME, ".local", "share", "omp-discord-bot");
export const SESSIONS_DIR = join(STATE_DIR, "sessions");
/** Per-session writable scratch dirs, mounted at ~/discord-scratch inside the sandbox. */
export const SCRATCH_DIR = join(STATE_DIR, "scratch");
/** Persistent cache mounted at ~/.cache inside runs (uv, bun, npm caches). */
export const CACHE_DIR = join(STATE_DIR, "cache");
/** Password-gated approval queue (bridge-owned; hidden from runs). */
export const QUEUE_DIR = join(STATE_DIR, "approvals");
/** Herdr workspace (label) where approval tabs are created. */
export const APPROVAL_WORKSPACE = process.env.OMP_BOT_APPROVAL_WORKSPACE ?? "Github";

/**
 * #main-github-firstmate: its own persistent headless session (cwd ~/Github). It never types
 * into the interactive FIRSTMATE Herdr pane.
 */
export const FIRSTMATE_SESSION = { key: "firstmate", cwd: join(HOME, "Github"), channelName: "main-github-firstmate" };

export const OMP_BIN =
  process.env.OMP_BOT_OMP_BIN ?? join(HOME, ".local", "share", "mise", "shims", "omp");

export const HTTP_HOST = "127.0.0.1";
export const HTTP_PORT = Number(process.env.OMP_BOT_HTTP_PORT ?? 47821);

/** Outputs longer than this are attached as a .md file instead of many messages. */
export const ATTACH_THRESHOLD = 8000;

export const BOT_ENV_FILE = join(HOME, ".config", "omp-discord", "bot.env");

/**
 * Trusted mode (owner decision 2026-10-13): runs are not sandboxed, approvals are a Discord button
 * (no password), and answers can attach files. On while this flag file exists; checked per run, so
 * `rm ~/.config/omp-discord/trusted` restores the sandboxed model for the next run.
 */
export const TRUSTED_FLAG = join(HOME, ".config", "omp-discord", "trusted");
export function trusted(): boolean {
  return existsSync(TRUSTED_FLAG);
}
/** Largest file an answer may attach (Discord's default upload limit for bots). */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
