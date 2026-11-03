/**
 * Pause all that really stops work (owner 2026-11-03, card pause-all-unreliable). Before, ⏸️ Pause all only wrote the
 * omp-maintenance flag: new jobs waited, but running OMP panes kept working and their cards stayed "running" on the
 * master queue. Now pause-all also:
 *   1. sends Esc to every working OMP pane (the same as the owner pressing Escape there), except the FIRSTMATE tab;
 *   2. sets every running card to paused (`fm set <id> paused <reason>`: partial, job unlinked, spawn queue entry
 *      removed) and saves {id, job} so resume can restore them;
 *   3. checks for up to `verifyMs` that the panes stopped (one more Esc to panes that still work) and returns counts.
 * Resume sets the saved cards back to running with their job. The continue prompts come from `omp-maintenance resume`
 * (full pause) or from `resumeAll({ prompt: true })` (scoped pause / bank yield).
 *
 * bank priority yield (same card): an owner instruction about bank positions or the portfolio makes long non-finance
 * jobs yield at once (scoped pause of their panes and cards). `yieldResume` continues them later.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Herdr = (args: string[]) => Promise<{ code: number; out: string }>;
export type Fm = (args: string[]) => Promise<{ code: number; out: string }>;
export type Pane = { pane_id: string; tab_id?: string; agent?: string; agent_status?: string; label?: string };
export type Tab = { tab_id: string; label?: string };
export type Card = { id?: string; s?: string; t?: string; area?: string; stack?: string; job?: string };
export type PauseState = { since: string; reason: string; kind: "all" | "yield"; cards: { id: string; job: string }[]; panes: string[] };
export type PauseResult = { panes: string[]; stopped: string[]; stillWorking: string[]; cards: string[]; errors: string[] };

const SEND = (p: string) => ["pane", "send-keys", p, "esc"];

export async function herdrState(herdr: Herdr): Promise<{ panes: Pane[]; tabs: Tab[] }> {
  const [p, t] = await Promise.all([herdr(["pane", "list"]), herdr(["tab", "list"])]);
  if (p.code !== 0 || t.code !== 0) throw new Error("herdr pane/tab list failed");
  const panes = JSON.parse(p.out)?.result?.panes;
  const tabs = JSON.parse(t.out)?.result?.tabs;
  if (!Array.isArray(panes) || !Array.isArray(tabs)) throw new Error("herdr output has no panes/tabs");
  return { panes, tabs };
}

/** Tab ids labelled FIRSTMATE. Refuse to act when none exists: we must never interrupt the owner's FIRSTMATE pane. */
export function firstmateTabs(tabs: Tab[]): Set<string> {
  const s = new Set(tabs.filter((t) => (t.label ?? "").trim().toUpperCase() === "FIRSTMATE").map((t) => t.tab_id));
  if (!s.size) throw new Error("no tab labelled FIRSTMATE; refusing to guess which panes to skip");
  return s;
}

/** The panes a card's `job` field names: pane id, tab id or tab label (comma list). */
export function panesForJob(job: string, panes: Pane[], tabs: Tab[]): Pane[] {
  const tags = job.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const tabIds = new Set(tabs.filter((t) => tags.includes((t.label ?? "").trim().toLowerCase()) || tags.includes(t.tab_id.toLowerCase())).map((t) => t.tab_id));
  return panes.filter((p) => tags.includes(p.pane_id.toLowerCase()) || (p.tab_id && tabIds.has(p.tab_id)));
}

const isWorkingOmp = (p: Pane) => p.agent === "omp" && p.agent_status === "working";

/** Finance cards never yield to an bank request (they may be the request). */
export function isFinanceCard(c: Card): boolean {
  const k = `${c.area ?? ""} ${c.stack ?? ""}`.toLowerCase();
  return /financ|bank|budget|\bmarkets?\b|\boptions?\b|portfolio/.test(k);
}

/** Owner text that asks FIRSTMATE about bank positions/portfolio or an order. */
export function isFinanceInstruction(text: string): boolean {
  const t = text.toLowerCase();
  const verb = /\b(close|sell|buy|roll|hedge|trim|add|check|show|protect|order|exit|reduce)\b/.test(t);
  if (/\bbank\b|online banking/.test(t)) return verb && !/\b(card|bug|yield|test|code|pr|mr)\b/.test(t);
  return verb && /\b(my|our)\s+(positions?|portfolio|book)\b|\bthe\s+(positions?|portfolio)\b/.test(t);
}

export function readState(file: string): PauseState | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PauseState) : null;
  } catch {
    return null;
  }
}
function writeState(file: string, s: PauseState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 1));
  renameSync(`${file}.tmp`, file);
}

/**
 * Card pause-all-live-button-check: test-only allowlist. While the file exists and has not expired, the ⏸️/▶️
 * buttons act on the listed test cards (and their panes) only: no global maintenance flag, no bot-job stops.
 * File: {"cards":["id",...],"panes":["pane id",...],"until":"ISO time"}. Only the listed pane ids get Esc; a card
 * job that also names a real tab cannot reach that tab's panes. readTestAllowlist returns null for a broken, empty or
 * expired file; testModeDecision then refuses the button (never a fall-through to a real global pause).
 */
export type TestAllowlist = { cards: string[]; panes: string[]; until: string };
export function readTestAllowlist(file: string, now = Date.now()): TestAllowlist | null {
  try {
    if (!existsSync(file)) return null;
    const a = JSON.parse(readFileSync(file, "utf8")) as Partial<TestAllowlist>;
    const cards = Array.isArray(a.cards) ? a.cards.filter((c): c is string => typeof c === "string" && c.trim() !== "") : [];
    const panes = Array.isArray(a.panes) ? a.panes.filter((c): c is string => typeof c === "string" && c.trim() !== "") : [];
    const until = Date.parse(String(a.until ?? ""));
    if (!cards.length || !panes.length || !Number.isFinite(until) || until <= now) return null;
    return { cards, panes, until: new Date(until).toISOString() };
  } catch {
    return null;
  }
}
/**
 * Which path the ⏸️/▶️ button takes. A real maintenance pause always wins. Saved test state always resumes in test
 * mode (also after the allowlist expired). A present but unusable allowlist file refuses: no real global pause.
 */
export function testModeDecision(o: { action: "pause" | "resume"; maintPaused: boolean; allowFileExists: boolean; allow: TestAllowlist | null; testStatePresent: boolean }): "normal" | "test" | "refuse" {
  if (o.maintPaused) return "normal";
  if (o.action === "resume" && o.testStatePresent) return "test";
  if (o.allowFileExists) return o.allow ? "test" : "refuse";
  if (o.testStatePresent) return "refuse"; // test pause still saved: a real pause now would mix both states
  return "normal";
}
/** Card filter for a test allowlist: listed ids only. */
export function allowlistFilter(a: TestAllowlist): (c: Card) => boolean {
  const ids = new Set(a.cards);
  return (c) => ids.has(c.id ?? "");
}

type PauseOpts = {
  reason: string;
  kind: "all" | "yield";
  herdr: Herdr;
  fm: Fm;
  tracker: () => Card[];
  stateFile: string;
  /** Scoped pause: only these cards (and their panes). Omitted = every running card and every working OMP pane. */
  cards?: (c: Card) => boolean;
  /** When set, only these pane ids may get Esc (test allowlist). */
  onlyPanes?: string[];
  /** Panes never touched (for example the caller's own pane). */
  exclude?: string[];
  verifyMs?: number;
  pollMs?: number;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

/** Pause and resume on one state file run one at a time, so a resume never drops cards a newer pause saved. */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(file) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(file, next);
  return next;
}

export function pause(o: PauseOpts): Promise<PauseResult> {
  return o.dryRun ? pauseNow(o) : serial(o.stateFile, () => pauseNow(o));
}

async function pauseNow(o: PauseOpts): Promise<PauseResult> {
  const sleep = o.sleep ?? Bun.sleep;
  const errors: string[] = [];
  const { panes, tabs } = await herdrState(o.herdr);
  const fmTabs = firstmateTabs(tabs);
  const skip = new Set(o.exclude ?? []);
  const only = o.onlyPanes ? new Set(o.onlyPanes) : null;
  const allowed = (p: Pane) => (!only || only.has(p.pane_id)) && !skip.has(p.pane_id) && !(p.tab_id && fmTabs.has(p.tab_id));
  // A running card always has a job (fm requires it); a card without one could not be restored, so it is left alone.
  const running = o.tracker().filter((c) => c.s === "running" && c.id && c.job && (!o.cards || o.cards(c)));
  let targets: Pane[];
  if (o.cards) {
    const seen = new Map<string, Pane>();
    for (const c of running) for (const p of panesForJob(c.job ?? "", panes, tabs)) if (isWorkingOmp(p) && allowed(p)) seen.set(p.pane_id, p);
    targets = [...seen.values()];
  } else targets = panes.filter((p) => isWorkingOmp(p) && allowed(p));
  // Cards whose job names an excluded pane stay running (the caller is that job).
  const cards = running.filter((c) => !panesForJob(c.job ?? "", panes, tabs).some((p) => skip.has(p.pane_id) || (p.tab_id && fmTabs.has(p.tab_id))));
  const ids = targets.map((p) => p.pane_id);
  if (o.dryRun) return { panes: ids, stopped: [], stillWorking: [], cards: cards.map((c) => c.id!), errors };
  // Save first: a crash halfway still lets resume restore every card.
  const prev = readState(o.stateFile);
  const saved = new Map((prev?.cards ?? []).map((c) => [c.id, c.job]));
  for (const c of cards) saved.set(c.id!, c.job ?? "");
  writeState(o.stateFile, { since: prev?.since ?? new Date().toISOString(), reason: o.reason, kind: prev?.kind ?? o.kind, cards: [...saved].map(([id, job]) => ({ id, job })), panes: [...new Set([...(prev?.panes ?? []), ...ids])] });
  for (const id of ids) if ((await o.herdr(SEND(id))).code !== 0) errors.push(`esc to ${id} failed`);
  const paused: string[] = [];
  for (const c of cards) {
    const r = await o.fm(["set", c.id!, "paused", o.reason]);
    if (r.code === 0) paused.push(c.id!);
    else errors.push(`fm set ${c.id} paused failed`);
  }
  // Verify the interrupt. OMP may need a few seconds to end a tool call; resend Esc once to panes that still work.
  const verifyMs = o.verifyMs ?? 90_000, pollMs = o.pollMs ?? 5_000;
  let still = ids, resent = false;
  for (let t = 0; still.length && t < verifyMs; t += pollMs) {
    await sleep(pollMs);
    const now = await herdrState(o.herdr).catch(() => null);
    if (!now) continue;
    still = ids.filter((id) => now.panes.some((p) => p.pane_id === id && isWorkingOmp(p)));
    if (still.length && !resent && t + pollMs >= verifyMs / 3) {
      resent = true;
      for (const id of still) await o.herdr(SEND(id));
    }
  }
  return { panes: ids, stopped: ids.filter((i) => !still.includes(i)), stillWorking: still, cards: paused, errors };
}

export const CONTINUE_MSG = "Work was paused (pause-all or an bank priority request) and is resumed now. Continue your task from where you stopped.";

/** Restore the saved cards to running with their job; optionally prompt the paused panes to continue. */
type ResumeOpts = { herdr: Herdr; fm: Fm; stateFile: string; prompt?: boolean };
export function resume(o: ResumeOpts): Promise<{ cards: string[]; prompted: string[]; errors: string[] }> {
  return serial(o.stateFile, () => resumeNow(o));
}

async function resumeNow(o: ResumeOpts): Promise<{ cards: string[]; prompted: string[]; errors: string[] }> {
  const s = readState(o.stateFile);
  const errors: string[] = [], cards: string[] = [], prompted: string[] = [];
  if (!s) return { cards, prompted, errors };
  const failed: PauseState["cards"] = [];
  for (const c of s.cards) {
    // fm refuses "running" without a job, so the job comes first. A card without a saved job stays paused.
    const ok = !!c.job && (await o.fm(["field", c.id, "job", c.job, "--force"])).code === 0 && (await o.fm(["set", c.id, "running", "▶️ resumed after pause"])).code === 0;
    if (ok) cards.push(c.id);
    else { errors.push(`card ${c.id} not set running`); failed.push(c); }
  }
  if (o.prompt) {
    const live = await herdrState(o.herdr).catch(() => null);
    for (const id of s.panes) {
      const p = live?.panes.find((x) => x.pane_id === id);
      if (!p || p.agent !== "omp" || p.agent_status === "working") continue;
      if ((await o.herdr(["agent", "prompt", id, CONTINUE_MSG])).code === 0) prompted.push(id);
      else errors.push(`prompt to ${id} failed`);
    }
  }
  // Keep failed cards so a second resume can retry them.
  if (failed.length) writeState(o.stateFile, { ...s, cards: failed, panes: [] });
  else rmSync(o.stateFile, { force: true });
  return { cards, prompted, errors };
}

/** One owner-facing line for the confirmation message. */
export function pauseSummary(r: PauseResult, what = "Pause all"): string {
  const ok = r.stillWorking.length === 0 && r.errors.length === 0;
  return `${ok ? "✅" : "⚠️"} ${what}: ${r.stopped.length}/${r.panes.length} working pane(s) stopped, ${r.cards.length} card(s) set paused.`
    + (r.stillWorking.length ? ` Still working: ${r.stillWorking.map((p) => `\`${p}\``).join(", ")}.` : "")
    + (r.errors.length ? ` Errors: ${r.errors.slice(0, 5).join("; ")}.` : "");
}
