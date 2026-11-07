import { CHANNELS, DM_CWD, GUILD_ID, OWNER_ID } from "./config.ts";

export interface MsgInfo {
  authorId: string;
  authorIsBot: boolean;
  /** null for DMs */
  guildId: string | null;
  channelId: string;
  isDM: boolean;
  isThread: boolean;
  /** parent channel id when isThread */
  parentId: string | null;
}

export type Route =
  | { kind: "ignore"; reason: string }
  | { kind: "new-thread"; cwd: string; channelName: string }
  | { kind: "thread"; cwd: string; channelName: string }
  | { kind: "dm"; cwd: string };

/** Only the owner, never bots/webhooks. */
export function isAllowedAuthor(authorId: string, authorIsBot: boolean): boolean {
  return !authorIsBot && authorId === OWNER_ID;
}

export interface AuthorInfo {
  authorId: string;
  /** Discord `author.bot` */
  isBot: boolean;
  /** Message sent through a webhook (`message.webhookId` set) */
  isWebhook: boolean;
  /** Discord system message (`message.system`) or a non-default message type */
  isSystem: boolean;
  /** The bridge's own bot user id */
  botUserId: string | undefined;
}

/**
 * Real author classification. "owner": the owner's own account typed it (non-bot, non-webhook,
 * non-system). "bridge": the bridge itself (its bot user or a webhook, e.g. relay self-tests).
 * "other": everyone else. Only "owner" is ever routed to an agent as owner input.
 */
export function messageProvenance(a: AuthorInfo): "owner" | "bridge" | "other" {
  if (a.isWebhook || (a.botUserId !== undefined && a.authorId === a.botUserId)) return "bridge";
  if (a.isBot || a.isSystem) return "other";
  return a.authorId === OWNER_ID ? "owner" : "other";
}

export function route(m: MsgInfo): Route {
  if (m.authorIsBot) return { kind: "ignore", reason: "bot" };
  if (!isAllowedAuthor(m.authorId, m.authorIsBot)) return { kind: "ignore", reason: "not-owner" };
  if (m.isDM) return { kind: "dm", cwd: DM_CWD };
  if (m.guildId !== GUILD_ID) return { kind: "ignore", reason: "other-guild" };
  if (m.isThread) {
    const ch = m.parentId ? CHANNELS[m.parentId] : undefined;
    if (!ch) return { kind: "ignore", reason: "unmapped-thread-parent" };
    return { kind: "thread", cwd: ch.cwd, channelName: ch.name };
  }
  const ch = CHANNELS[m.channelId];
  if (!ch) return { kind: "ignore", reason: "unmapped-channel" };
  return { kind: "new-thread", cwd: ch.cwd, channelName: ch.name };
}

/**
 * 🔓-unrestricted-qwen channels (owner 2026-10-19): no sandbox. The owner's messages in the channel (or a thread
 * under it) run the normal trusted OMP turn in that channel/thread, cwd ~/Github, model pinned to Qwen by main.ts.
 * null = not such a channel (use route()).
 */
export function unrestrictedRoute(m: MsgInfo, ids: readonly string[]): Route | null {
  const id = m.isThread ? m.parentId : m.channelId;
  if (m.isDM || m.guildId !== GUILD_ID || !id || !ids.includes(id)) return null;
  if (m.authorIsBot) return { kind: "ignore", reason: "bot" };
  if (!isAllowedAuthor(m.authorId, m.authorIsBot)) return { kind: "ignore", reason: "not-owner" };
  return { kind: "thread", cwd: DM_CWD, channelName: "🔓-unrestricted-qwen" };
}

/** Thread name from the first URL's host (plus path hint) or the first words. Max 100 chars. */
export function threadName(content: string): string {
  const text = content.trim();
  const urlMatch = text.match(/https?:\/\/[^\s<>]+/i);
  const rest = text.replace(/<?https?:\/\/[^\s<>]+>?/gi, " ").replace(/\s+/g, " ").trim();
  let name = "";
  if (urlMatch) {
    try {
      const host = new URL(urlMatch[0]).hostname.replace(/^www\./, "");
      const words = rest.split(" ").filter(Boolean).slice(0, 6).join(" ");
      name = words ? `${host} – ${words}` : host;
    } catch {
      name = "";
    }
  }
  if (!name) name = text.replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ");
  name = name.replace(/[\r\n`*_~|]/g, "").trim();
  if (!name) name = "omp task";
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

/** Owner 2026-10-19: auto-"continue" after the time limit only in the listed channels, their threads, and 🔓-qwen. */
export function timeLimitContinue(channelId: string, parentId: string | null, listed: string[], unrestricted: string[]): boolean {
  const ids = new Set([...listed, ...unrestricted]);
  return ids.has(channelId) || (parentId != null && ids.has(parentId));
}

/** Text of the bridge's plain time-limit notice (no auto-continue happened). */
export const TIME_LIMIT_NOTICE = "⏱️ The run hit the ";
/**
 * Owner 2026-10-19 watchdog (every 10 s). `recent` = the channel's last messages, newest first. Finds the newest
 * plain time-limit notice; fires only if nothing after it shows new work or an owner action: no owner message, no
 * Working…/auto-continue/watchdog/Stop message. Board reprints and split chunks of the notice's partial output may
 * follow it. Returns the notice id to use (each notice once), or null.
 */
export function watchdogContinue(recent: { id: string; fromBot: boolean; content: string }[], busy: boolean, handled: Set<string>): string | null {
  if (busy) return null;
  for (const m of recent) {
    if (!m.fromBot) return null; // the owner wrote after the stop: their message decides
    if (m.content.startsWith(TIME_LIMIT_NOTICE)) {
      if (!m.content.includes("was stopped") || handled.has(m.id)) return null; // auto-continued, or already used
      return m.id;
    }
    if (/Working…|Continuing automatically|🛑 Stopped|Watchdog:/.test(m.content)) return null;
  }
  return null;
}
