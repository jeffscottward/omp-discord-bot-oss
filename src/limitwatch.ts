/**
 * Owner 2026-10-19 (Orca #5): Claude plan-limit watch.
 * Every 5 minutes it reads `omp usage --json --redact` (OMP's supported usage command; it never reads the
 * credential data itself) and keeps three things current:
 * - one pinned message in #omp-alerts with each Anthropic window (5 hour, 7 day …), its use and a live reset countdown,
 * - limits.json for the FIRSTMATE dashboard header,
 * - one alert per window at 80 % and at 95 %, plus one reset notice when an alerted window resets.
 * The decision logic (evaluate) is pure, so it can be tested.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { bar } from "./rigstats.ts";

const run = promisify(execFile);

export const THRESHOLDS = [0.8, 0.95] as const;
export const TICK_MS = 5 * 60_000;
/** After this many failed reads in a row, post one alert; post a recovery notice when reads work again. */
export const FAIL_ALERT_AFTER = 3;

interface UsageLimit {
  id?: string;
  label?: string;
  status?: string;
  scope?: { windowId?: string; tier?: string; shared?: boolean };
  window?: { id?: string; label?: string; durationMs?: number; resetsAt?: number };
  amount?: { usedFraction?: number };
}
interface UsageReport {
  provider: string;
  fetchedAt?: number;
  metadata?: { accountId?: string; email?: string };
  resetCredits?: { availableCount?: number; credits?: { status?: string; remainingCount?: number; expiresAt?: string }[] };
  limits?: UsageLimit[];
}
export interface UsageJson {
  generatedAt?: number;
  reports?: UsageReport[];
}

/** One Anthropic usage window for one account. */
export interface Window {
  key: string;
  label: string;
  fraction: number;
  resetsAt?: number;
  status?: string;
}
export interface WindowState {
  resetsAt?: number;
  fraction: number;
  /** Highest threshold already alerted in this window (0 = none). */
  alerted: number;
}
export interface WatchState {
  windows: Record<string, WindowState>;
  pinnedChannel?: string;
  pinnedMessage?: string;
  failures?: number;
  failAlerted?: boolean;
}

export interface Snapshot {
  windows: Window[];
  banked: number;
  bankedExpires?: number;
  fetchedAt?: number;
}

/** Anthropic windows from the usage JSON. Several accounts get an account number in the label. */
export function snapshot(u: UsageJson): Snapshot {
  const reports = (u.reports ?? []).filter((r) => r.provider === "anthropic");
  const windows: Window[] = [];
  let banked = 0;
  let bankedExpires: number | undefined;
  reports.forEach((r, n) => {
    const acct = r.metadata?.accountId ?? r.metadata?.email ?? String(n);
    const prefix = reports.length > 1 ? `#${n + 1} ` : "";
    for (const l of r.limits ?? []) {
      // A limit without a numeric use (partial read, error status) is skipped: reading it as 0 % would look like a reset.
      const used = l.amount?.usedFraction;
      if (typeof used !== "number" || !Number.isFinite(used)) continue;
      const id = l.id ?? `${l.scope?.windowId ?? l.window?.id ?? "limit"}${l.scope?.tier ? `:${l.scope.tier}` : ""}`;
      const label = (l.label ?? id).replace(/^Claude /, "");
      windows.push({
        key: `${acct}|${id}`,
        label: `${prefix}${label}`,
        fraction: Math.max(0, Math.min(1, used)),
        resetsAt: l.window?.resetsAt,
        status: l.status,
      });
    }
    banked += r.resetCredits?.availableCount ?? 0;
    for (const c of r.resetCredits?.credits ?? []) {
      const t = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
      if (c.status === "available" && Number.isFinite(t)) bankedExpires = bankedExpires === undefined ? t : Math.min(bankedExpires, t);
    }
  });
  const fetched = reports.map((r) => r.fetchedAt ?? 0).filter(Boolean);
  return { windows, banked, bankedExpires, fetchedAt: fetched.length ? Math.min(...fetched) : undefined };
}

const pct = (f: number) => `${Math.round(f * 100)}%`;
const t = (ms: number, style: "R" | "t" | "f" | "D") => `<t:${Math.floor(ms / 1000)}:${style}>`;
const dot = (f: number, status?: string) => (status && status !== "ok" ? "🔴" : f >= 0.95 ? "🔴" : f >= 0.8 ? "🟠" : f >= 0.6 ? "🟡" : "🟢");

function bankedLine(s: Snapshot, autoRedeem: string): string {
  const exp = s.bankedExpires ? ` (expires ${t(s.bankedExpires, "D")})` : "";
  const redeem = autoRedeem === "yes" ? "OMP uses it by itself when a limit is hit (claudeResets.autoRedeem: yes)" : `claudeResets.autoRedeem: ${autoRedeem || "unknown"}`;
  return s.banked > 0 ? `✦ ${s.banked} banked reset${s.banked === 1 ? "" : "s"}${exp} · ${redeem}` : `✦ No banked resets · ${redeem}`;
}

/** A new window: the reset time moved, or use fell a lot (a banked reset was used). */
function isNewWindow(prev: WindowState, w: Window): boolean {
  if (prev.resetsAt && w.resetsAt && Math.abs(w.resetsAt - prev.resetsAt) > 60_000) return true;
  return prev.fraction - w.fraction >= 0.25;
}

export interface Evaluation {
  state: WatchState;
  /** Messages to post in #omp-alerts, in order. */
  alerts: string[];
}

/** Pure: compare the new snapshot with the saved state; return the alerts to post and the new state. */
export function evaluate(prev: WatchState, s: Snapshot, autoRedeem: string): Evaluation {
  const alerts: string[] = [];
  // Windows missing from this poll keep their state, so one partial read never re-arms an alert.
  const windows: Record<string, WindowState> = { ...prev.windows };
  for (const w of s.windows) {
    const old = prev.windows[w.key];
    let alerted = old?.alerted ?? 0;
    if (old && isNewWindow(old, w)) {
      if (old.alerted > 0) {
        const next = w.resetsAt ? ` · next reset ${t(w.resetsAt, "R")}` : "";
        alerts.push(`✅ **Claude ${w.label} reset** · now ${pct(w.fraction)} used${next}`);
      }
      alerted = 0;
    }
    // Only the highest new threshold is posted (a jump from 70 % to 96 % gives one 95 % alert).
    const crossed = THRESHOLDS.filter((x) => w.fraction >= x && x > alerted);
    if (crossed.length) {
      const level = crossed[crossed.length - 1]!;
      const reset = w.resetsAt ? ` · resets ${t(w.resetsAt, "R")} (${t(w.resetsAt, "t")})` : "";
      const icon = level >= 0.95 ? "🔴" : "🟠";
      alerts.push(`${icon} **Claude ${w.label} at ${pct(w.fraction)}** (${pct(level)} alert)${reset}\n${bankedLine(s, autoRedeem)}`);
      alerted = level;
    }
    windows[w.key] = { resetsAt: w.resetsAt, fraction: w.fraction, alerted };
  }
  return { state: { ...prev, windows }, alerts };
}

/** The pinned message: one line per window with a live Discord countdown to its reset. */
export function pinnedText(s: Snapshot, autoRedeem: string, now = Date.now()): string {
  const lines = [`📊 **Claude plan limits** · updated ${t(now, "R")}`];
  for (const w of s.windows) {
    const reset = w.resetsAt && w.resetsAt > now ? ` · resets ${t(w.resetsAt, "R")}` : "";
    lines.push(`${dot(w.fraction, w.status)} ${bar(w.fraction * 100)} **${pct(w.fraction)}** ${w.label}${reset}`);
  }
  if (!s.windows.length) lines.push("⚠️ OMP returned no Anthropic usage.");
  lines.push(bankedLine(s, autoRedeem));
  lines.push("🔔 One alert per window at 80% and 95%, and a notice when it resets. `/usage` shows all accounts.");
  return lines.join("\n");
}

/** limits.json for the FIRSTMATE dashboard header (no account names). */
export function dashboardJson(s: Snapshot, autoRedeem: string, now = Date.now()) {
  return {
    updatedAt: now,
    fetchedAt: s.fetchedAt,
    windows: s.windows.map((w) => ({ label: w.label, pct: Math.round(w.fraction * 100), resetsAt: w.resetsAt ?? null, status: w.status ?? "ok" })),
    banked: s.banked,
    bankedExpires: s.bankedExpires ?? null,
    autoRedeem,
  };
}

/** Failure bookkeeping: alert once after FAIL_ALERT_AFTER failures in a row, recover once. */
export function onReadResult(prev: WatchState, ok: boolean, error = ""): { state: WatchState; alert?: string } {
  if (ok) {
    const alert = prev.failAlerted ? "✅ **Claude limit watch recovered** · OMP usage reads work again." : undefined;
    return { state: { ...prev, failures: 0, failAlerted: false }, alert };
  }
  const failures = (prev.failures ?? 0) + 1;
  if (failures >= FAIL_ALERT_AFTER && !prev.failAlerted)
    return { state: { ...prev, failures, failAlerted: true }, alert: `⚠️ **Claude limit watch: ${failures} failed reads in a row** · ${error.slice(0, 200)}` };
  return { state: { ...prev, failures } };
}

export interface WatchDeps {
  ompBin: string;
  stateFile: string;
  dashboardFile: string;
  /** Post one alert in #omp-alerts. */
  alert: (text: string) => Promise<void>;
  /** Create or edit the pinned status message; returns its channel and message id. */
  pin: (text: string, where: { channel?: string; message?: string }) => Promise<{ channel: string; message: string } | null>;
  log: (s: string) => void;
}

export class LimitWatch {
  private busy = false;
  constructor(private d: WatchDeps) {}

  private load(): WatchState {
    try {
      const saved = JSON.parse(readFileSync(this.d.stateFile, "utf8")) as Partial<WatchState>;
      return { ...saved, windows: saved.windows ?? {} };
    } catch {
      return { windows: {} };
    }
  }
  private save(s: WatchState) {
    writeAtomic(this.d.stateFile, `${JSON.stringify(s, null, 1)}\n`);
  }

  async read(): Promise<{ usage: UsageJson; autoRedeem: string }> {
    const opts = { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, cwd: "/tmp" };
    const { stdout } = await run(this.d.ompBin, ["usage", "--json", "--redact"], opts);
    const redeem = await run(this.d.ompBin, ["config", "get", "claudeResets.autoRedeem"], { ...opts, timeout: 20_000 }).then(
      (r) => `${r.stdout}`.trim().split("\n")[0] ?? "",
      () => "unknown",
    );
    return { usage: JSON.parse(stdout) as UsageJson, autoRedeem: redeem };
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      let state = this.load();
      let got: { usage: UsageJson; autoRedeem: string };
      try {
        got = await this.read();
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0] ?? "";
        const r = onReadResult(state, false, msg);
        this.save(r.state);
        this.d.log(`limitwatch: read failed (${r.state.failures}): ${msg}`);
        if (r.alert) await this.d.alert(r.alert);
        return;
      }
      const ok = onReadResult(state, true);
      state = ok.state;
      if (ok.alert) await this.d.alert(ok.alert);
      const snap = snapshot(got.usage);
      const ev = evaluate(state, snap, got.autoRedeem);
      state = ev.state;
      // Save before posting, so a crash never posts the same alert twice.
      this.save(state);
      for (const a of ev.alerts) {
        this.d.log(`limitwatch alert: ${a.split("\n")[0]}`);
        await this.d.alert(a);
      }
      writeAtomic(this.d.dashboardFile, `${JSON.stringify(dashboardJson(snap, got.autoRedeem))}\n`);
      const where = await this.d.pin(pinnedText(snap, got.autoRedeem), { channel: state.pinnedChannel, message: state.pinnedMessage });
      if (where && (where.channel !== state.pinnedChannel || where.message !== state.pinnedMessage)) {
        this.save({ ...state, pinnedChannel: where.channel, pinnedMessage: where.message });
      }
    } finally {
      this.busy = false;
    }
  }
}

function writeAtomic(file: string, text: string) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
