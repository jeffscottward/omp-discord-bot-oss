// Owner rule 2026-11-01 (card discord-archive-near-limit): never archive, move or delete channels of a category
// unless that category holds >= CATEGORY_LIMIT - 10 (40 of 50) channels. Near the limit, take the oldest closed
// channels first, and only enough to get the category back under 40. Below 40, closed channels stay in place.

/** Discord's per-category channel limit. */
export const CATEGORY_LIMIT = 50;
/** Archive starts at this channel count (40). */
export const ARCHIVE_AT = CATEGORY_LIMIT - 10;

/** True when a category with `count` channels may have channels archived. */
export function mayArchive(count: number): boolean {
  return count >= ARCHIVE_AT;
}

/**
 * Closed-channel candidates to archive: per category, oldest first (smallest `age` key = oldest), only enough to bring
 * the category count under ARCHIVE_AT. `count(cat)` = channels in the category now. Returns the chosen keys.
 */
export function pickToArchive<K>(cands: { key: K; cat: string; oldest: number }[], count: (cat: string) => number): Set<K> {
  const out = new Set<K>();
  const byCat = new Map<string, typeof cands>();
  for (const c of cands) byCat.set(c.cat, [...(byCat.get(c.cat) ?? []), c]);
  for (const [cat, list] of byCat) {
    const n = count(cat);
    if (!mayArchive(n)) continue;
    const need = n - (ARCHIVE_AT - 1);
    for (const c of [...list].sort((a, b) => a.oldest - b.oldest).slice(0, need)) out.add(c.key);
  }
  return out;
}
