// ↪️ Send a conversation to another channel (owner pick 2026-10-23, UX review item 8: "pull in the context from
// that channel", 5 requests). Two entry points: `/handoff to:<channel> [note]` and the message action
// "Send to another channel" (then a channel picker). The bot posts a card in the destination with the source
// link and session log paths, links back from the source, and starts a run in the destination whose prompt
// names the source logs and quotes the last messages. No LLM runs in the bot; the destination agent summarizes.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { newestJsonl } from "./heartbeat.ts";
import { transcriptExcerpt } from "./mirror.ts";
import { redact } from "./redact.ts";

export const HANDOFF_PREFIX = "handoff:";
export const HANDOFF_MENU_NAME = "Send to another channel";

/** The session logs that may hold a channel's conversation (newest file of each session dir, plus a pane's own). */
export function sourceLogs(o: { sessionsDir: string; channelId: string; sideKey?: string | null; paneSession?: string | null }): string[] {
  const keys = [o.sideKey, o.channelId, `dm-${o.channelId}`, `voice-${o.channelId}`, `${o.channelId}-qwen`, `${o.channelId}-venice`].filter((k): k is string => Boolean(k));
  const out: string[] = [];
  if (o.paneSession && existsSync(o.paneSession)) out.push(o.paneSession);
  for (const k of [...new Set(keys)]) {
    const f = newestJsonl(join(o.sessionsDir, k));
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * Recent user/assistant text of the newest source log, read by the bot itself: sandboxed runs cannot see the
 * session folders (sandbox HIDE_DIRS), so the prompt carries this excerpt instead of only the paths.
 */
export function logExcerpt(logs: string[], maxChars = 6000, tailBytes = 256 * 1024): string {
  let newest: { f: string; mtime: number; size: number } | null = null;
  for (const f of logs) {
    try {
      const st = statSync(f);
      if (!newest || st.mtimeMs > newest.mtime) newest = { f, mtime: st.mtimeMs, size: st.size };
    } catch {}
  }
  if (!newest) return "";
  const len = Math.min(newest.size, tailBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(newest.f, "r");
  try {
    readSync(fd, buf, 0, len, newest.size - len);
  } finally {
    closeSync(fd);
  }
  return redact(transcriptExcerpt(buf, maxChars)).text;
}

export interface SourceMessage {
  author: string;
  fromBot: boolean;
  content: string;
}

/** Bot status posts that carry no conversation (board, Working…, checks, restarts, queued notes). */
const NOISE = /^(━━━|⏳ \*\*Queue|⏳ Queued|<a?:\w+:\d+> Working…|⚙️ Working…|🩺 \*\*Check|🔁 Run it again|🛑 Stop)/;

/** The last `max` conversation messages, oldest first, each cut and redacted. */
export function excerpt(msgs: SourceMessage[], max = 6, chars = 300): string[] {
  return msgs
    .filter((m) => m.content.trim() && !(m.fromBot && NOISE.test(m.content.trim())))
    .slice(-max)
    .map((m) => `${m.fromBot ? "🤖 bot" : `👤 ${m.author}`}: ${redact(m.content.replace(/\s+/g, " ").trim()).text.slice(0, chars)}`);
}

const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

export interface HandoffInput {
  /** "#channel-name" (prompt) and "<#id>" (card; Discord renders it as a link). */
  srcName: string;
  srcMention?: string;
  srcUrl: string;
  logs: string[];
  note?: string | null;
  recent: string[];
  /** logExcerpt() of the source (the run may not be able to open the log files). */
  transcript?: string;
}

/** The visible card in the destination channel (short; the prompt carries the rest). */
export function handoffCard(h: HandoffInput): string {
  const lines = [`↪️ **Handoff from ${h.srcMention ?? h.srcName}** · [open the source](${h.srcUrl})`];
  if (h.note?.trim()) lines.push(`📝 ${redact(h.note.trim()).text.slice(0, 400)}`);
  lines.push(h.logs.length ? `🗂️ Session log${h.logs.length > 1 ? "s" : ""}: ${h.logs.map((l) => `\`${tilde(l)}\``).join(", ")}` : "🗂️ No session log found for the source channel.");
  lines.push("-# The agent here reads the source and posts a short summary first.");
  return lines.join("\n");
}

/** The prompt for the destination run (the owner's request; the bot never summarizes by itself). */
export function handoffPrompt(h: HandoffInput): string {
  return [
    `[Handoff] The owner moved a conversation here from ${h.srcName} (${h.srcUrl}) and wants you to continue it in this channel.`,
    h.note?.trim() ? `Owner's note: ${h.note.trim()}` : "",
    h.transcript ? `Recent conversation from the newest source session log (read-only excerpt, oldest first):\n${h.transcript}` : "",
    h.logs.length
      ? `Source session log(s): ${h.logs.map(tilde).join(", ")}. If you need more than the excerpt and can open them, read only the END (tail or a targeted grep; never load a whole log into context, never --resume it). A sandboxed run cannot open them; then use the excerpt.`
      : "No session log was found for the source channel; use the messages below.",
    h.recent.length ? `Last messages in the source channel (oldest first):\n${h.recent.join("\n")}` : "",
    "First reply with a short summary (3-5 bullets) of where that conversation stands: the goal, what is done, what is open, and the next step. Then continue with the owner's note if there is one; otherwise ask what to do next. Do not post in the source channel.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The back-link left in the source channel. */
export const backLink = (destName: string, cardUrl: string) => `↪️ **Moved to ${destName}** · [open the handoff](${cardUrl})`;
