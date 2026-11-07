import { readFileSync } from "node:fs";
import { DASHBOARD_BASE_URL } from "./config.ts";
import { ITEMS_FILE } from "./queued.ts";
/**
 * "show tag X" (card fm-card-tags, owner 2026-11-05): the owner asks for every card with a theme tag; the bot answers
 * at once from items.json (no Claude turn) with a card list and a dashboard link filtered by that tag (`?tag=`).
 * Cards keep theme tags in `tags` (fm tag <id> +x -y).
 */
const ASK = /^\s*(?:show|list|find)\s+(?:me\s+)?(?:(?:the|all)\s+)?(?:cards?\s+)?(?:with\s+)?(?:the\s+)?tag(?:ged)?(?:\s*[:=]\s*|\s+)#?([a-z0-9][a-z0-9_-]*(?:\s[a-z0-9][a-z0-9_-]*)?)(?:\s+cards?)?\s*[.?!]?\s*$/i;

/** The tag slug the owner asks for, or undefined when the text is no "show tag X" request. */
export function parseTagAsk(text: string): string | undefined {
  const m = String(text || "").match(ASK);
  if (!m?.[1]) return undefined;
  const t = m[1].trim().toLowerCase().replace(/[\s_]+/g, "-");
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(t) ? t : undefined;
}

type Card = { id?: string; t?: string; s?: string; tags?: unknown; q?: string; src?: string };
const E: Record<string, string> = { waiting: "✍️", open: "⚠️", blocked: "⛔", running: "⚙️", partial: "🔧", planned: "🗓️", backlog: "📦", done: "✅" };

function dashUrl(base: string, q: Record<string, string>): string {
  if (!base) return "";
  const u = base.replace(/\/?$/, "/");
  return u + "?" + new URLSearchParams(q).toString();
}

/** Reply text for one tag: unfinished cards first (max 15), done cards counted; each card links to the dashboard.
 * Undefined when no card has the tag, so a normal message that only looks like "show tag X" still reaches Claude. */
export function tagReply(items: Card[], tag: string, base = DASHBOARD_BASE_URL): string | undefined {
  const hit = items.filter((i) => Array.isArray(i.tags) && i.tags.includes(tag) && i.id);
  const open = hit.filter((i) => i.s !== "done"), done = hit.length - open.length;
  const all = dashUrl(base, { tag });
  if (!hit.length) return undefined;
  const lines = open.slice(0, 15).map((i) => {
    const u = dashUrl(base, { item: String(i.id) });
    const name = `${E[String(i.s)] || "•"} ${String(i.t || i.id).slice(0, 90)}`;
    return u ? `- [${name}](<${u}>)` : `- ${name} (\`${i.id}\`)`;
  });
  if (open.length > 15) lines.push(`- … ${open.length - 15} more`);
  return [
    `🏷️ #${tag}: ${open.length} open card${open.length === 1 ? "" : "s"}${done ? `, ${done} done` : ""}.`,
    ...lines,
    ...(all ? [`🔗 [All #${tag} cards on the dashboard](<${all}>)`] : []),
  ].join("\n");
}

/** Reads items.json now; undefined when it cannot be read or no card has the tag. */
export function tagReplyFromDisk(tag: string): string | undefined {
  try {
    const d = JSON.parse(readFileSync(ITEMS_FILE, "utf8")) as { items?: Card[] };
    return tagReply(d.items || [], tag);
  } catch {
    return undefined;
  }
}
