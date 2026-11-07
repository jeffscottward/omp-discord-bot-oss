/**
 * The stack catalog (owner 2026-10-28, card stack-catalog): ONE file that lists every FIRSTMATE router stack.
 * The bot's router (src/router.ts) and fm-spawn (scripts/fm-spawn) both read it; scripts/stack-add.ts and
 * fm-spawn's auto-create write it. Every request goes to a stack; a topic with no stack gets a new one here.
 *
 * File: `~/.config/omp-discord/stacks.json` (or `OMP_BOT_STACKS`): `{ "version": 1, "stacks": [StackDef...] }`.
 * An entry overrides the code default of the same name (src/router.ts DEFAULT_STACKS); a new name adds a stack.
 * The bot re-reads the file when its mtime changes (StackRouter.refresh), so a new stack needs no restart.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_STACKS } from "./router.ts";
import { pickUniqueEmoji } from "./stackemoji.ts";

/** One catalog entry. Every field except `name` is optional (missing fields keep the code default). */
export type CatalogStack = {
  name: string;
  emoji?: string;
  title?: string;
  description?: string;
  cwd?: string;
  keywords?: string[];
  areas?: string[];
  channelIds?: string[];
  /** Who added it: "seed", "stack-add", "fm-spawn auto" … (informational). */
  addedBy?: string;
  addedAt?: string;
};
export type Catalog = { version: 1; stacks: CatalogStack[] };

export const STACKS_FILE = process.env.OMP_BOT_STACKS ?? join(homedir(), ".config", "omp-discord", "stacks.json");

/** Stack slug rule (queue/session name `stack-<name>`, thread name, `stack:<name>` prefix). */
export const STACK_NAME_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;

/** A topic or area text as a stack slug: "Client Co: web" -> "client-co-web". Null when nothing usable is left. */
export function stackSlug(text: string): string | null {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return STACK_NAME_RE.test(s) ? s : null;
}

/** Parse catalog JSON (pure). Bad entries are dropped, never thrown: a broken entry must not stop routing. */
export function parseCatalog(raw: unknown): Catalog {
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "stacks" in raw && Array.isArray(raw.stacks) ? raw.stacks : [];
  const out: CatalogStack[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    // Parsed JSON object: every field below is checked with typeof/Array.isArray before use.
    const o = r as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().toLowerCase() : "";
    if (!STACK_NAME_RE.test(name) || out.some((s) => s.name === name)) continue;
    const e: CatalogStack = { name };
    for (const k of ["emoji", "title", "description", "cwd", "addedBy", "addedAt"] as const) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) e[k] = v.trim();
    }
    for (const k of ["keywords", "areas", "channelIds"] as const) {
      const v = o[k];
      if (!Array.isArray(v)) continue;
      const l = v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      e[k] = k === "channelIds" ? l : l.map((x) => x.toLowerCase());
    }
    out.push(e);
  }
  return { version: 1, stacks: out };
}

/** Read the catalog; a missing or unreadable file is an empty catalog (code defaults still apply). */
export function loadCatalog(file = STACKS_FILE): Catalog {
  try {
    return parseCatalog(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { version: 1, stacks: [] };
  }
}

/**
 * Raw entry objects of an existing catalog file, for read-modify-write. Throws when the file exists but is not a
 * valid catalog, so a corrupt file is never replaced by a one-entry catalog (review 2026-10-28). Missing file: [].
 */
export function readCatalogEntries(file = STACKS_FILE): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const raw: unknown = JSON.parse(readFileSync(file, "utf8")); // throws on a syntax error
  const list: unknown = Array.isArray(raw) ? raw : raw && typeof raw === "object" && "stacks" in raw ? raw.stacks : undefined;
  if (!Array.isArray(list)) throw new Error(`${file} has no "stacks" list`);
  // Parsed JSON objects; each entry keeps every field (also ones this version does not know).
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

export function catalogMtime(file = STACKS_FILE): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Exclusive lock for read-modify-write (lock file created with O_EXCL; stale after 10 s). */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > until) throw new Error(`stack catalog busy (${lock})`);
      Bun.sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Backups kept next to the catalog (`stacks.json.before-<ms>`); older ones are removed. */
const KEEP_BACKUPS = 10;

function writeEntries(stacks: object[], file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.before-${Date.now()}`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, stacks }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  const prefix = `${basename(file)}.before-`;
  const old = readdirSync(dirname(file)).filter((f) => f.startsWith(prefix)).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const f of old.slice(KEEP_BACKUPS)) rmSync(join(dirname(file), f), { force: true });
}

/**
 * Add a stack, or merge fields into the existing one of that name. Returns the stored entry and whether it was new.
 * `onlyIfMissing`: keep an existing entry as it is (fm-spawn auto-create must not overwrite a curated stack).
 * The file is backed up (`stacks.json.before-<ms>`) before each write; a corrupt file makes this throw.
 */
export function upsertStack(entry: CatalogStack, opts: { file?: string; onlyIfMissing?: boolean } = {}): { entry: CatalogStack; added: boolean } {
  const file = opts.file ?? STACKS_FILE;
  if (!STACK_NAME_RE.test(entry.name)) throw new Error(`bad stack name "${entry.name}" (2-30 chars: a-z, 0-9, -)`);
  return withLock(file, () => {
    const entries = readCatalogEntries(file);
    const i = entries.findIndex((s) => typeof s.name === "string" && s.name.trim().toLowerCase() === entry.name);
    if (i >= 0 && opts.onlyIfMissing) return { entry: parseCatalog([entries[i]]).stacks[0] ?? entry, added: false };
    const clean = parseCatalog([entry]).stacks[0]!;
    // Owner 2026-11-07: never reuse an emoji. Pick an unused one (name/keyword hints) when missing or taken by
    // another catalog entry or another code-default stack; a default stack keeps its own default emoji.
    const def = DEFAULT_STACKS.find((s) => s.name === clean.name);
    const used = parseCatalog(entries.filter((_, j) => j !== i)).stacks.map((s) => s.emoji ?? "")
      .concat(DEFAULT_STACKS.filter((s) => s.name !== clean.name).map((s) => s.emoji));
    const prior = i >= 0 ? parseCatalog([entries[i]]).stacks[0] : undefined;
    const want = clean.emoji ?? prior?.emoji ?? def?.emoji;
    const emoji = pickUniqueEmoji({ name: clean.name, keywords: clean.keywords ?? prior?.keywords, emoji: want }, used);
    if (emoji !== want || clean.emoji) clean.emoji = emoji;
    const next = i >= 0 ? { ...entries[i]!, ...clean } : { addedAt: new Date().toISOString(), ...clean };
    if (i >= 0) entries[i] = next;
    else entries.push(next);
    writeEntries(entries, file);
    return { entry: parseCatalog([next]).stacks[0]!, added: i < 0 };
  });
}
