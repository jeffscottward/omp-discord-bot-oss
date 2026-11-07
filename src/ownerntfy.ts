/**
 * Owner 2026-10-30 (card needs-you-ntfy): one ntfy push for every new item that needs the owner
 * (ask menu, Approve button, secret-drop form). The Discord post stays; ntfy is in addition.
 *
 * Dedupe: one push per key (`ask:<setId>`, `approval:<id>`, `secret:<id>`). Sent keys are kept in
 * ~/.local/state/omp-notify/needs-you-sent.json, so a restart never repeats a push. Keys older
 * than 30 days are pruned. Cards (waiting/open) are pushed by fm (`fm-needs-ntfy`), keyed `card:`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type OwnerKind = "input" | "approval" | "authentication";

export const SENT_FILE = process.env.OMP_NEEDS_YOU_SENT ?? join(process.env.HOME ?? "", ".local", "state", "omp-notify", "needs-you-sent.json");
const KEEP_MS = 30 * 24 * 3_600_000;

/** Short, single-line text without account-like digit runs. */
export function cleanSummary(s: string, max = 200): string {
  const t = s.replace(/[*_`~>|]/g, "").replace(/\s+/g, " ").replace(/\d{6,}/g, "…").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function readSent(file: string): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Marks the key as sent. Returns false when it was already sent (no push then). */
export function claimKey(key: string, file = SENT_FILE, now = Date.now()): boolean {
  const sent = readSent(file);
  if (sent[key]) return false;
  for (const [k, t] of Object.entries(sent)) if (now - t > KEEP_MS) delete sent[k];
  sent[key] = now;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(sent), { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

export interface OwnerNtfyDeps {
  file?: string;
  bin?: string;
  run?: (bin: string, args: string[]) => void;
  log?: (s: string) => void;
}

/** Push once per key. Never throws; a failed push does not block the Discord flow. */
export function ownerNtfy(key: string, kind: OwnerKind, summary: string, action: string | undefined, deps: OwnerNtfyDeps = {}): boolean {
  // Tests never reach the real notifier or the live state file (bun test sets NODE_ENV=test).
  if (process.env.NODE_ENV === "test" && (!deps.run || !deps.file)) return false;
  try {
    if (!claimKey(key, deps.file)) return false;
    // fm-needs-ntfy skips a card whose q is a message the bot already pushed (one push per item).
    if (action) claimKey(`url:${action}`, deps.file);
    const args = ["--kind", kind, "--summary", cleanSummary(summary) || "Something needs you", "--action", (action || "Open Discord and answer it").slice(0, 240)];
    const bin = deps.bin ?? join(process.env.HOME ?? "", ".local", "bin", "omp-notify");
    const run = deps.run ?? ((b, a) => {
      if (!existsSync(b)) return deps.log?.(`needs-you ntfy: ${b} missing`);
      const p = spawn(b, a, { env: { ...process.env, OMP_NOTIFY_TRANSPORT: "ntfy" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout?.on("data", (d) => (out += d));
      p.on("close", (c) => deps.log?.(`needs-you ntfy ${key}: exit ${c} ${out.trim().slice(0, 120)}`));
      p.on("error", (e) => deps.log?.(`needs-you ntfy ${key}: ${e.message}`));
    });
    run(bin, args);
    return true;
  } catch (e) {
    deps.log?.(`needs-you ntfy ${key}: ${(e as Error).message}`);
    return false;
  }
}
