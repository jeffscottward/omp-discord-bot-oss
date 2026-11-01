/**
 * Maintenance pause (owner 2026-10-30, card omp-pause-button). `omp-maintenance pause` writes
 * ~/.local/state/omp-maintenance/paused.json; while it exists the bot starts no new queued job (running jobs finish),
 * the 📋 Master queue shows a ⏸️ line, and fm-spawn / firstmate-sweep start nothing. `omp-maintenance resume`
 * removes the flag and continues the saved sessions.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MaintPause = { since: string; reason: string };

const HOME = process.env.HOME ?? "";
export const MAINT_FILE = process.env.OMP_MAINT_PAUSED ?? join(process.env.XDG_STATE_HOME ?? join(HOME, ".local/state"), "omp-maintenance", "paused.json");
export const MAINT_BIN = process.env.OMP_MAINT_BIN ?? join(HOME, "Github/tools/self-healing-harness/bin/omp-maintenance");
export const MAINT_PREFIX = "maint:";

/** The pause flag, or null when work is not paused. An unreadable flag still counts as paused (fail safe). */
export function readMaintPause(file = MAINT_FILE): MaintPause | null {
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Partial<MaintPause>;
    return { since: typeof d.since === "string" ? d.since : "", reason: typeof d.reason === "string" && d.reason.trim() ? d.reason.trim() : "maintenance" };
  } catch {
    return { since: "", reason: "maintenance" };
  }
}

/** One board line: "⏸️ Paused: <reason> (since <t:…:R>) …" or "" when not paused. */
export function maintLine(p: MaintPause | null): string {
  if (!p) return "";
  const t = Date.parse(p.since);
  const since = Number.isFinite(t) ? ` (since <t:${Math.floor(t / 1000)}:R>)` : "";
  return `⏸️ **Paused**: ${p.reason.replace(/[\r\n]+/g, " ").slice(0, 200)}${since}. New jobs wait; running jobs finish. Tap ▶️ Resume or use /resume-work.`;
}

/** The single button below the master board: ⏸️ Pause when running, ▶️ Resume when paused. */
export function maintButton(paused: boolean): { customId: string; label: string; emoji: string } {
  return paused ? { customId: `${MAINT_PREFIX}resume`, label: "Resume all", emoji: "▶️" } : { customId: `${MAINT_PREFIX}pause`, label: "Pause all", emoji: "⏸️" };
}
