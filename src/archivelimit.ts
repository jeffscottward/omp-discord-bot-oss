// The 2026-11-01 40-channel gate (card discord-archive-near-limit: archive or delete only in a category with >= 40
// channels) is superseded by the owner rule of 2026-11-05 (msg 100000000000000053): a finished channel idle for 7
// days is deleted in any category (scripts/purge-archive.py), and finished tabs close in any category
// (scripts/channel-cleanup.ts). Card channel-purge-stuck (2026-11-07) removed the gate; only the limit stays.

/** Discord's per-category channel limit. */
export const CATEGORY_LIMIT = 50;
