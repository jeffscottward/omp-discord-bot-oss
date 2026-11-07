#!/usr/bin/env bun
/**
 * Add or update a FIRSTMATE router stack in the stack catalog (owner 2026-10-24: stacks are as flexible as channels;
 * owner 2026-10-28: ONE catalog file, src/stackcatalog.ts, read by the router and fm-spawn).
 * Usage: bun scripts/stack-add.ts --name 3d --emoji 🧊 --title "3D models" --keywords "blender,stl,3d print"
 *          [--areas "3d"] [--cwd ~/Github/fun] [--description "..."] [--only-if-missing] [--by "fm-spawn auto"]
 * Writes ~/.config/omp-discord/stacks.json (OMP_BOT_STACKS). The bot re-reads it within 10 s; no restart.
 * The stack's Discord thread is created when the first message or job is routed to it.
 * Prints one JSON line: {name, added, entry}.
 */
import { STACKS_FILE, upsertStack, type CatalogStack } from "../src/stackcatalog.ts";

const a = process.argv.slice(2);
const get = (k: string) => {
  const i = a.indexOf(`--${k}`);
  return i >= 0 ? a[i + 1] : undefined;
};
const list = (v?: string) => (v ? v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : undefined);
const name = get("name")?.trim().toLowerCase() ?? "";
const entry: CatalogStack = { name, addedBy: get("by") ?? "stack-add" };
for (const [k, v] of Object.entries({ emoji: get("emoji"), title: get("title"), description: get("description"), cwd: get("cwd"), keywords: list(get("keywords")), areas: list(get("areas")) }))
  if (v !== undefined) Object.assign(entry, { [k]: v });
try {
  const r = upsertStack(entry, { onlyIfMissing: a.includes("--only-if-missing") });
  console.log(JSON.stringify({ name, added: r.added, file: STACKS_FILE, entry: r.entry }));
} catch (e) {
  console.error(`stack-add: ${(e as Error).message}`);
  process.exit(2);
}
