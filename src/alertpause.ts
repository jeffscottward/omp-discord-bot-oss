/**
 * Owner alert pause switch (pstack audit item 6, owner 2026-10-25 "one job for all").
 *
 * One state file, shared by the bot and `~/.local/share/omp-notify/notify.mjs`:
 *   ~/.local/state/omp-notify/alerts-pause.json  {"until": <epoch ms>, "reason": "…", "setAt": <epoch ms>, "by": "…"}
 * Every pause has an expiry (max 7 days). A missing, invalid or expired file means "not paused".
 *
 * While paused:
 * - New posts to #omp-alerts (loopback /post and the bot's own alert lines) are held in alerts-held.jsonl.
 *   A /post with `"urgent": true` (sign-in/password waits) still goes out.
 * - notify.mjs returns {status: "paused"} for every kind except `test` and `authentication`.
 * - The 🔔 Needs-you alert lines are not sent (the board still lists the cards).
 * - The master queue and Needs-you boards show one 🔕 line with the end time.
 * When the pause ends (expiry or `off`), the bot posts one digest of the held alerts in #omp-alerts.
 *
 * Switch: Discord `/alerts` or `bun scripts/alerts-pause.ts <30m|2h|1d|off|status> [reason]`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PAUSE_DIR = process.env.OMP_ALERT_PAUSE_DIR ?? join(process.env.HOME ?? "", ".local", "state", "omp-notify");
export const PAUSE_FILE = join(PAUSE_DIR, "alerts-pause.json");
export const HELD_FILE = join(PAUSE_DIR, "alerts-held.jsonl");
export const MIN_PAUSE_MS = 60_000;
export const MAX_PAUSE_MS = 7 * 24 * 3600_000;

export interface Pause {
  until: number;
  reason: string;
  setAt: number;
  by: string;
}

export interface Held {
  ts: number;
  text: string;
}

/** The active pause, or null (no file, bad JSON, bad fields, or expired). */
export function readPause(now = Date.now(), file = PAUSE_FILE): Pause | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<Pause>;
  if (typeof p.until !== "number" || !Number.isFinite(p.until) || p.until <= now) return null;
  // A file that claims more than the maximum (hand-edited) is capped, so a pause can never be endless.
  const setAt = typeof p.setAt === "number" && Number.isFinite(p.setAt) ? p.setAt : now;
  return { until: Math.min(p.until, setAt + MAX_PAUSE_MS), reason: typeof p.reason === "string" ? p.reason.slice(0, 200) : "", setAt, by: typeof p.by === "string" ? p.by.slice(0, 80) : "" };
}

/** "30m", "2h", "1d", "90" (minutes) → ms, or null. */
export function parseDuration(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m")[0];
  const ms = n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Start or replace a pause. Throws on a duration outside 1 min … 7 days. */
export function setPause(ms: number, reason: string, by: string, now = Date.now(), file = PAUSE_FILE): Pause {
  if (!(ms >= MIN_PAUSE_MS && ms <= MAX_PAUSE_MS)) throw new Error("pause must be between 1 minute and 7 days");
  const p: Pause = { until: now + ms, reason: reason.trim().slice(0, 200), setAt: now, by: by.slice(0, 80) };
  writeAtomic(file, `${JSON.stringify(p)}\n`);
  return p;
}

/** End the pause now. Returns true when a pause file was removed. */
export function clearPause(file = PAUSE_FILE): boolean {
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function holdAlert(text: string, now = Date.now(), file = HELD_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now, text: text.slice(0, 4000) } satisfies Held)}\n`, { mode: 0o600 });
}

/** Move the held alerts out (renamed to alerts-held-<ts>.jsonl, kept as the record) and return them. */
export function takeHeld(now = Date.now(), file = HELD_FILE): { held: Held[]; saved: string | null } {
  if (!existsSync(file)) return { held: [], saved: null };
  const saved = file.replace(/\.jsonl$/, `-${now}.jsonl`);
  renameSync(file, saved);
  const held: Held[] = [];
  for (const line of readFileSync(saved, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const h = JSON.parse(line) as Held;
      if (typeof h.ts === "number" && typeof h.text === "string") held.push(h);
    } catch {}
  }
  return { held, saved };
}

/** Undo takeHeld (the digest post failed): the saved alerts go back in front of any alert held since. */
export function restoreHeld(saved: string, file = HELD_FILE): void {
  const back = readFileSync(saved, "utf8");
  const since = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeAtomic(file, back + since);
  unlinkSync(saved);
}

const ts = (ms: number) => Math.floor(ms / 1000);

/** One board line while paused ("" when not paused). */
export function pauseLine(p: Pause | null): string {
  if (!p) return "";
  return `🔕 **Owner alerts paused** until <t:${ts(p.until)}:t> (<t:${ts(p.until)}:R>)${p.reason ? ` · ${p.reason}` : ""} · \`/alerts resume\` ends it`;
}

/** The one message posted when a pause ends. */
export function resumeDigest(held: Held[], saved: string | null, limit = 1900): string {
  const head = held.length ? `🔔 **Owner alerts resumed.** ${held.length} alert${held.length === 1 ? " was" : "s were"} held during the pause:` : "🔔 **Owner alerts resumed.** No alerts were held during the pause.";
  const lines = [head];
  let shown = 0;
  for (const h of held) {
    const first = h.text.replace(/\s+/g, " ").trim();
    const row = `• <t:${ts(h.ts)}:t> ${first.length > 160 ? `${first.slice(0, 159)}…` : first}`;
    if ([...lines, row].join("\n").length > limit - 120) break;
    lines.push(row);
    shown++;
  }
  if (shown < held.length) lines.push(`➕ ${held.length - shown} more in \`${saved?.replace(process.env.HOME ?? "\0", "~") ?? "alerts-held"}\``);
  return lines.join("\n");
}

/**
 * Pause state changes for the bot's tick: "paused" / "resumed" when the state flipped since `prev`.
 * `prev` is the previous `until` (0 = not paused); the new value is returned for the next call.
 */
export function pauseTransition(prev: number, now = Date.now(), file = PAUSE_FILE): { until: number; event: "paused" | "resumed" | "changed" | null } {
  const p = readPause(now, file);
  const until = p?.until ?? 0;
  if (!prev && until) return { until, event: "paused" };
  if (prev && !until) return { until, event: "resumed" };
  if (prev !== until) return { until, event: "changed" };
  return { until, event: null };
}
