/**
 * Dependency tracks for blocked cards (owner 2026-10-23, card blocker-tracks): follow each card's blockedBy chain
 * (cycle-safe) to its root leaves and classify each leaf:
 *   owner    = waiting/open, or blocked with an owner link (q/src), WITH a non-empty `action` and not queued (owner 2026-10-25)
 *   bot      = an answered (queued) owner card, running, or a card with a job, or a ref naming a unit/CI/agent (".timer", ".service", "ci:", "job:", "unit:")
 *   external = a ref "ext:<what>" / "time:<when>", or a card with area/field ext
 *   unknown  = a missing card or a leaf with no link and no job (flag it)
 * Same rules as `fm why` (kit/bin/fm) and the dashboard (app.js rootsOf).
 */
export type RootClass = "owner" | "bot" | "external" | "unknown";
export type BItem = { id: string; t?: string; s?: string; q?: string; src?: string; job?: string; blockedBy?: string | string[]; blocks?: string | string[]; ext?: string; until?: string; action?: string; queued?: unknown };
export type Leaf = { cls: RootClass; id: string; item?: BItem; chain: string[] };


export function refClass(ref: string): RootClass | null {
  if (/^(ext|time):/i.test(ref)) return "external";
  if (/^(ci|job|unit|agent|pane):/i.test(ref) || /\.(timer|service)$/.test(ref)) return "bot";
  return null;
}

const list = (v?: string | string[]) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);
/** Done, or a passed time gate (`until`), as in the dashboard's cleared(). */
export const cleared = (it: BItem, now = Date.now()) => it.s === "done" || (!!it.until && Date.parse(it.until) <= now);

export function leafClass(it: BItem, now = Date.now()): RootClass {
  // Owner 2026-10-25 (needs-you-action-gate): "on the owner" only with a named owner action and not answered/queued.
  const act = typeof it.action === "string" && it.action.trim() !== "" && !it.queued;
  if (act && (it.s === "waiting" || it.s === "open")) return "owner";
  if (act && it.s === "blocked" && (it.q || it.src)) return "owner";
  // Answered (📨 queued) owner cards wait on the agent that took the answer, not on the owner.
  if (it.queued && it.s !== "done") return "bot";
  if (it.ext || (it.until && Date.parse(it.until) > now)) return "external";
  if (it.s === "running" || it.job) return "bot";
  return "unknown";
}

/** Blocker refs per card, resolved like the dashboard: id or card title (case-insensitive), plus reverse `blocks` edges. */
function edges(items: BItem[]): Map<string, string[]> {
  const byTitle = new Map(items.filter((i) => i.t).map((i) => [i.t!.toLowerCase(), i.id]));
  const ids = new Set(items.map((i) => i.id));
  const resolve = (r: string) => (ids.has(r) ? r : byTitle.get(r.toLowerCase()) ?? r);
  const m = new Map<string, string[]>(items.map((i) => [i.id, list(i.blockedBy).map(resolve).filter((r) => r !== i.id)]));
  for (const i of items) for (const d of list(i.blocks).map(resolve)) if (d !== i.id && m.has(d) && !m.get(d)!.includes(i.id)) m.get(d)!.push(i.id);
  return m;
}

/** Open blockers of a card (refs to uncleared cards, or non-card refs). */
export function openRefs(it: BItem, byId: Map<string, BItem>, now = Date.now(), e = edges([...byId.values()])): string[] {
  return (e.get(it.id) ?? []).filter((r) => { const b = byId.get(r); return !b || !cleared(b, now); });
}

/** Every root leaf of `id`'s chain (deduplicated by leaf id). A card without open blockers is its own leaf. */
export function roots(id: string, byId: Map<string, BItem>, now = Date.now()): Leaf[] {
  const out = new Map<string, Leaf>();
  const e = edges([...byId.values()]);
  const walk = (cur: string, chain: string[], seen: Set<string>) => {
    const it = byId.get(cur);
    if (!it) {
      const c = refClass(cur) ?? "unknown";
      if (!out.has(cur)) out.set(cur, { cls: c, id: cur, chain });
      return;
    }
    const next = openRefs(it, byId, now, e);
    // A card with its own owner question (or time gate) is a leaf too, even when it also waits on other cards.
    const own = leafClass(it, now);
    if (!next.length || own === "owner" || own === "external") { if (!out.has(cur)) out.set(cur, { cls: own, id: cur, item: it, chain }); if (!next.length) return; }
    for (const r of next) {
      if (seen.has(r)) { if (!out.has(r)) out.set(r, { cls: "unknown", id: r, item: byId.get(r), chain: [...chain, r] }); continue; } // cycle
      walk(r, [...chain, r], new Set([...seen, r]));
    }
  };
  walk(id, [id], new Set([id]));
  return [...out.values()];
}

/** Cards blocked by another card or ref (open blockers), with their roots. */
export function blockedTracks(items: BItem[], now = Date.now()): { item: BItem; roots: Leaf[] }[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const e = edges(items);
  return items.filter((i) => i.s !== "done" && openRefs(i, byId, now, e).length).map((i) => ({ item: i, roots: roots(i.id, byId, now).filter((l) => l.chain.length > 1) }));
}

/** Owner root → cards it unblocks (directly or through a chain). */
export function ownerRoots(items: BItem[]): { root: BItem; unblocks: BItem[] }[] {
  const m = new Map<string, { root: BItem; unblocks: BItem[] }>();
  for (const t of blockedTracks(items)) for (const l of t.roots) if (l.cls === "owner" && l.item) {
    const e = m.get(l.id) ?? { root: l.item, unblocks: [] };
    if (!e.unblocks.includes(t.item)) e.unblocks.push(t.item);
    m.set(l.id, e);
  }
  return [...m.values()];
}
