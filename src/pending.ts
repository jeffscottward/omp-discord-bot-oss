/**
 * Owner 2026-10-15: the queue board says when a bot restart is waiting for the queue to clear.
 * A restart is scheduled while an omp-discord-restart-* user unit (scripts/restart-when-idle.sh) is active. The number of new commits comes from git (boot commit → HEAD).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_DIR = resolve(import.meta.dir, "..");
const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO_DIR, encoding: "utf8", timeout: 2000 }).stdout?.trim() ?? "";
const BOOT_REV = git("rev-parse", "HEAD");

export interface PendingRestart {
  updates: number;
}

let cache: { at: number; value: PendingRestart | null } = { at: 0, value: null };

/** A restart waiter is active (it holds the lock). Cached for 5 s; boards re-render often. */
export function pendingRestart(now = Date.now()): PendingRestart | null {
  if (now - cache.at < 5000) return cache.value;
  // Never probe with flock: taking the lock even briefly could make a starting waiter exit and drop the
  // restart. An active omp-discord-restart-* unit is the waiter.
  const units = spawnSync("systemctl", ["--user", "list-units", "omp-discord-restart-*", "--state=active", "--no-legend", "--plain"], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
  const held = units.trim().length > 0;
  const updates = held && BOOT_REV ? Number(git("rev-list", "--count", `${BOOT_REV}..HEAD`)) || 0 : 0;
  cache = { at: now, value: held ? { updates } : null };
  return cache.value;
}

/**
 * `elsewhere`: channels with a running or waiting job other than this board's channel. The restart waits for
 * EVERY channel (owner 2026-10-15: "this queue is empty" was wrong when another channel was still busy).
 * `draining` (P1): the waiter stopped new jobs; only running jobs hold the restart, waiting jobs run after it.
 * `holding` (owner 2026-10-21/23, UX item 6): the running jobs that hold the drain, as linked board items, so
 * the line says which job it waits for ("waiting for such and such a job").
 */
export function pendingLine(p: PendingRestart | null, elsewhere: string[] = [], draining = false, holding: string[] = []): string | null {
  if (!p && !draining) return null;
  // 0 = the restart reloads the commit already running (no new code).
  const n = p?.updates ?? 0;
  const what = n === 1 ? "1 update ready" : n > 1 ? `${n} updates ready` : "no new code (reload only)";
  if (draining) {
    if (!holding.length) return `🔄 **Restart pending:** ${what}. New jobs wait; the bot restarts when the running jobs end, then the waiting jobs start.`;
    const more = holding.length > 3 ? ` +${holding.length - 3} more` : "";
    return `🔄 **Restart pending:** ${what}. New jobs wait until ${holding.length === 1 ? "this job ends" : "these jobs end"}: ${holding.slice(0, 3).join(", ")}${more}. Then the bot restarts and the waiting jobs start.`;
  }
  const names = [...new Set(elsewhere)];
  const when = names.length
    ? `The bot restarts when no channel has a job. Still busy: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}.`
    : "The bot restarts when every queue is empty.";
  return `🔄 **Restart pending:** ${what}. ${when}`;
}

/** Keep whole lines so a cut never breaks a jump link's markdown. */
export function fitLines(lines: string[], max = 1900): string {
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > max) {
      out.push("…");
      break;
    }
    out.push(l);
    len += l.length + 1;
  }
  return out.join("\n");
}

/** Owner 2026-10-15: after the restart, the board that said "Restart pending" is edited to say restarted. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const pendingFile = (stateDir: string) => `${stateDir}/pending-boards.json`;
export function recordPendingBoard(stateDir: string, channelId: string, messageId: string): void {
  let m: Record<string, string> = {};
  try {
    if (existsSync(pendingFile(stateDir))) m = JSON.parse(readFileSync(pendingFile(stateDir), "utf8"));
  } catch {}
  if (m[channelId] === messageId) return;
  m[channelId] = messageId;
  writeFileSync(pendingFile(stateDir), JSON.stringify(m));
}
export function takePendingBoards(stateDir: string): Record<string, string> {
  try {
    const m = JSON.parse(readFileSync(pendingFile(stateDir), "utf8")) as Record<string, string>;
    rmSync(pendingFile(stateDir), { force: true });
    return m;
  } catch {
    return {};
  }
}
export const restartedLine = (rev: string) => `✅ **Restarted:** the bot is running \`${rev}\` with all updates.`;
export const markRestarted = (text: string, rev: string) => text.replace(/^🔄 \*\*Restart pending:\*\*.*$/m, restartedLine(rev));
