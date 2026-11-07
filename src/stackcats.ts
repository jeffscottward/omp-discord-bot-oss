/**
 * Owner 2026-10-30 (card bot-upgrades-1030): the full 🖥️ Main category is split by stack. Each main pane channel
 * goes to the category of its stack ("💹 finance"), with overflow categories per stack ("💹 finance 2").
 * config.json `mirror.stackCategories` maps stack name -> [category id, overflow ids...]; src/mirror.ts creates
 * a missing category (one at a time, with backoff) and moves channels. This file holds the pure parts.
 */
import { homedir } from "node:os";
import { keywordScores, type StackDef } from "./router.ts";
import { pickUniqueEmoji } from "./stackemoji.ts";

/** The FIRSTMATE card fields this file reads (items.json). */
export type StackCard = { id?: string; s?: string; job?: unknown; stack?: unknown; cts?: unknown };
/** The pane fields this file reads (LivePane or MirrorEntry). */
export type StackPane = { paneId: string; tabId?: string; tab: string; short?: string; name: string; cwd?: string };

/** A card `job` value as lower-case tags: "wB:pXA", "a,b" or ["a", "b"]. */
function jobTags(job: unknown): string[] {
  const list = Array.isArray(job) ? job : typeof job === "string" ? job.split(",") : [];
  return list.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** True when `dir` is `base` or inside it; a worktree `<base>-wt-<slug>` counts as inside (fm-spawn worktrees). */
function under(dir: string, base: string): boolean {
  return dir === base || dir.startsWith(`${base}/`) || dir.startsWith(`${base}-wt-`);
}

/**
 * The stack of a main pane, first rule wins:
 * 1. the word "webapp" in the tab (owner rule 2026-10-24: it beats every other rule); the FIRSTMATE tab is the
 *    FIRSTMATE general stack (many cards name FIRSTMATE as their job);
 * 2. a FIRSTMATE card whose `job` names the pane (Herdr pane id or tab label) and has a known `stack`
 *    (open cards before done cards, newest first);
 * 3. one clear keyword winner in the tab name;
 * 4. the deepest stack `cwd` that holds the pane's folder (stacks whose cwd is ~/Github or ~ are too broad);
 * 5. the fallback stack (FIRSTMATE general).
 */
export function paneStack(p: StackPane, cards: StackCard[], stacks: StackDef[], fallback = "firstmate"): string {
  const known = new Set(stacks.map((s) => s.name));
  const text = `${p.tab} ${p.short ?? ""}`.replace(/-/g, " ");
  if (/\bwebapp\b/i.test(text) && known.has("webapp")) return "webapp";
  if (p.tab.trim().toLowerCase() === "firstmate" && known.has(fallback)) return fallback;
  // Card jobs name a Herdr pane id, tab id or tab label (fm-autoclear job_state matches the same set).
  const names = new Set([p.paneId, p.tabId ?? "", p.tab, p.short ?? ""].map((x) => x.trim().toLowerCase()).filter(Boolean));
  const mine = cards
    .filter((c) => typeof c.stack === "string" && known.has(c.stack) && jobTags(c.job).some((t) => names.has(t)))
    .sort((a, b) => Number(a.s === "done") - Number(b.s === "done") || Number(b.cts ?? 0) - Number(a.cts ?? 0));
  if (mine[0]) return mine[0].stack as string;
  const scores = keywordScores(text, stacks);
  if (scores[0] && scores[0].score > (scores[1]?.score ?? 0)) return scores[0].stack;
  const home = homedir();
  const broad = new Set([home, `${home}/Github`]);
  const cwd = (p.cwd ?? "").replace(/\/+$/, "");
  const byDir = stacks
    .map((s) => ({ name: s.name, dir: s.cwd.replace(/\/+$/, "") }))
    .filter((s) => s.dir && !broad.has(s.dir) && cwd && under(cwd, s.dir))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (byDir) return byDir.name;
  return known.has(fallback) ? fallback : (stacks[0]?.name ?? fallback);
}

/** Category name for a stack: "💹 finance" for the first, "💹 finance 2" for the next overflow category. */
export function stackCategoryName(s: Pick<StackDef, "emoji" | "name">, existing: number): string {
  const base = `${s.emoji || pickUniqueEmoji({ name: s.name }, [])} ${s.name}`;
  return (existing > 0 ? `${base} ${existing + 1}` : base).slice(0, 100);
}

/** Parse config.json `mirror.stackCategories` (bad entries dropped): stack name -> category ids. */
export function parseStackCategories(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) continue;
    const ids = v.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x));
    if (ids.length) out[k] = ids;
  }
  return out;
}

/**
 * Category order for the server (owner 2026-10-30 review): the pane group (🖥️ Main, then the stack categories in
 * `group` order) stays together at the place of its first member; every other category keeps its relative order.
 * `cats`: all categories with their current position. Returns category ids in the wanted order.
 */
export function categoryOrder(cats: { id: string; position: number }[], group: string[]): string[] {
  // Same position: older first (snowflake ids: shorter is older, then lexical).
  const now = [...cats].sort((a, b) => a.position - b.position || a.id.length - b.id.length || (a.id < b.id ? -1 : 1)).map((c) => c.id);
  const inGroup = new Set(group.filter((id) => now.includes(id)));
  const at = now.findIndex((id) => inGroup.has(id));
  if (at < 0) return now;
  const rest = now.filter((id) => !inGroup.has(id));
  return [...rest.slice(0, at), ...group.filter((id) => inGroup.has(id)), ...rest.slice(at)];
}
