import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_BASE_URL, FM_DIR } from "./config.ts";
/**
 * FIRSTMATE dashboard link under each reply (owner 2026-10-18).
 * Contract: kit/dashboard/deeplink-contract.md (installed into the dashboard folder).
 * - The reply names a card (a dashboard `?item=<id>` link or a `⚓ item:<id>` token): link to the first one.
 * - Otherwise: `?since=<run start epoch ms>&by=run:<run id>`, so the page highlights only the cards this run changed
 *   (`fm` records `by: run:<OMP_GATE_RUN>`; fm-autoclear edits carry `by: autoclear` and are not shown).
 * - No run start (notices outside a run): the plain dashboard link.
 */
/** From config.json `dashboardUrl`; empty turns the reply link off. */
export const DASHBOARD_URL = DASHBOARD_BASE_URL;

const ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
// A dashboard URL with an item parameter, e.g. …/reports/firstmate/?tab=all&item=foo or …/firstmate?item=foo.
const ITEM_LINK = new RegExp(`/reports/firstmate/?\\?(?:[^\\s<>)\\]#]*&)?item=(${ID})`, "g");
const ITEM_TOKEN = new RegExp(`⚓\\s*item:\\s*\`?(${ID})`, "gu");
const REPORT_TOKEN = /⚓\s*report:\s*`?([\w./-]+?)`?(?=\s|$)/u;
/** Whole token lines (`⚓ item:<id>` / `⚓ report:<path>`): hints for the bot, never shown to the owner. */
const TOKEN_LINE = /^[ \t]*⚓\s*(?:item|report):\s*`?[\w./-]+`?[ \t]*$/gmu;

/** Remove hint tokens from the visible reply text (owner 2026-10-18: they showed as plain text). */
export function stripTokens(text: string): string {
  return text.replace(TOKEN_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Report path named by a `⚓ report:<path>` token (relative to /reports/), if any. */
export function reportPath(text: string): string | undefined {
  return text.match(REPORT_TOKEN)?.[1]?.replace(/^\/?reports\//, "");
}

/** First card id the reply text names, by position in the text; undefined when there is none. */
export function firstItemId(text: string): string | undefined {
  let best: { at: number; id: string } | undefined;
  for (const re of [ITEM_LINK, ITEM_TOKEN]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m?.[1] && (!best || m.index < best.at)) best = { at: m.index, id: m[1].replace(/[._-]+$/, "") };
  }
  return best?.id || undefined;
}

export function dashboardUrl(text: string, runStartMs?: number, runId?: string): string {
  const id = firstItemId(text);
  // `#<id>` also opens the card on today's page (app.js jumps to the hash on load) until it reads ?item=.
  if (id) return `${DASHBOARD_URL}?item=${encodeURIComponent(id)}`;
  const rep = reportPath(text);
  if (rep) return `${DASHBOARD_URL}?tab=reports&report=${encodeURIComponent(rep)}`;
  if (runStartMs !== undefined && Number.isFinite(runStartMs) && runStartMs > 0) return `${DASHBOARD_URL}?since=${Math.floor(runStartMs)}${runId && /^[0-9a-f]{6,32}$/.test(runId) ? `&by=run:${runId}` : ""}`;
  return DASHBOARD_URL;
}

const ITEMS_FILE = process.env.OMP_FM_ITEMS ?? join(FM_DIR, "items.json");

/** Card title for an id from the tracker file; undefined when the file or card is missing. */
export function cardTitle(id: string, file = ITEMS_FILE): string | undefined {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { items?: { id?: string; t?: string }[] };
    return doc.items?.find((i) => i.id === id)?.t;
  } catch {
    return undefined;
  }
}

/**
 * The Markdown line posted right above the spoken audio (or at the end without audio).
 * Owner 2026-10-18: the label names the target (card title, or "cards changed in this reply").
 * Owner 2026-10-19: main.ts adds one spacer line after it only above the audio player (tap safety).
 */
export function dashboardLine(text: string, runStartMs?: number, runId?: string, file = ITEMS_FILE): string {
  if (!DASHBOARD_URL) return "";
  const url = dashboardUrl(text, runStartMs, runId);
  const id = firstItemId(text);
  const title = id ? cardTitle(id, file) : undefined;
  const rep = id ? undefined : reportPath(text);
  // Owner 2026-10-21: short labels with the ↗ arrow (same style as Discord message links), no "Open …" wording.
  const raw = id ? `Card: ${title ?? id}` : rep ? `Report: ${rep}` : url.includes("since=") ? "Cards changed in this reply" : "FIRSTMATE dashboard";
  const label = raw.replace(/[^\p{L}\p{N} :.,+&'()/-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 90);
  return `⚓ [${label} ↗](<${url}>)`;
}
