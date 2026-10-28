#!/usr/bin/env bun
/**
 * Add or update a FIRSTMATE router stack without a code change (owner 2026-10-24: stacks are as flexible as channels).
 * Usage: bun scripts/stack-add.ts --name 3d --emoji 🧊 --title "3D models" --keywords "blender,stl,3d print" [--areas "3d"] [--cwd ~/Github/fun] [--description "..."]
 * Writes router.stacks in ~/.config/omp-discord/config.json (backup first), then schedules restart-when-idle.sh.
 * The stack's Discord thread is created when the first message is routed to it.
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CONFIG_FILE } from "../src/config.ts";

const a = process.argv.slice(2);
const get = (k: string) => {
  const i = a.indexOf(`--${k}`);
  return i >= 0 ? a[i + 1] : undefined;
};
const list = (v?: string) => (v ? v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : undefined);
const name = get("name")?.trim().toLowerCase();
if (!name || !/^[a-z0-9-]{2,30}$/.test(name)) {
  console.error("stack-add: --name is required (2-30 chars: a-z, 0-9, -)");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { router?: { stacks?: Record<string, unknown>[] } };
raw.router ??= {};
raw.router.stacks ??= [];
const entry: Record<string, unknown> = { name };
for (const [k, v] of Object.entries({ emoji: get("emoji"), title: get("title"), description: get("description"), cwd: get("cwd"), keywords: list(get("keywords")), areas: list(get("areas")) })) if (v !== undefined) entry[k] = v;
const i = raw.router.stacks.findIndex((s) => s.name === name);
if (i >= 0) raw.router.stacks[i] = { ...raw.router.stacks[i], ...entry };
else raw.router.stacks.push(entry);
copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.before-stack-${name}-${Date.now()}`);
writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(raw, null, 2), { mode: 0o600 });
renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
console.log(`stack ${name} ${i >= 0 ? "updated" : "added"}: ${JSON.stringify(entry)}`);
if (!a.includes("--no-restart")) {
  const r = spawnSync("systemd-run", ["--user", "--collect", `${import.meta.dir}/restart-when-idle.sh`], { encoding: "utf8" });
  console.log(r.status === 0 ? "restart-when-idle scheduled" : `restart schedule failed: ${r.stderr}`);
}
