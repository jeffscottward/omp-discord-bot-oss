/**
 * Automatic FIRSTMATE reset after a cyber refusal (owner 2026-10-21). When a FIRSTMATE channel run fails and the
 * run's output or session log shows Anthropic's "Refusal (cyber)", the bridge does the same reset the owner used to
 * ask for by hand: archive the Discord side session (rename, never delete) and give the Herdr FIRSTMATE pane a
 * fresh omp. The refused message is NOT resent; the owner decides whether and how to send it again.
 * Guards: at most one reset per 10 minutes; no reset while a FIRSTMATE side-session omp still runs; the pane omp is
 * only restarted when its input box is empty (the owner may be typing there).
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorEmpty } from "./firstmate.ts";

export const REFUSAL_MARK = "Refusal (cyber)";
export const MIN_GAP_MS = 10 * 60_000;
const TAIL_BYTES = 512 * 1024;

/**
 * The provider's refusal text. A quote of it inside other text (grep output, a discussion of past refusals) does not
 * match: it must START the message text, optionally after OMP's "tool call was not executed" prefix.
 */
export const REFUSAL_RE = /^(?:Tool call was not executed because the provider stream ended with an error before the tool could run: )?Refusal \(cyber\): This request triggered restrictions/;

/** True when a session JSONL entry dated at or after `sinceMs` is an assistant/toolResult refusal (shape above). */
export function refusalSince(text: string, sinceMs: number): boolean {
  for (const line of text.split("\n")) {
    if (!line.includes(REFUSAL_MARK)) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // the first line of a tail read may be cut
    }
    if (!e || typeof e !== "object" || !("timestamp" in e) || typeof e.timestamp !== "string" || !("message" in e)) continue;
    const at = Date.parse(e.timestamp);
    const m = e.message;
    if (Number.isNaN(at) || at < sinceMs || !m || typeof m !== "object" || !("role" in m)) continue;
    if (m.role !== "assistant" && m.role !== "toolResult") continue;
    const texts: string[] = [];
    if ("errorMessage" in m && typeof m.errorMessage === "string") texts.push(m.errorMessage);
    if ("content" in m && Array.isArray(m.content)) {
      for (const c of m.content) if (c && typeof c === "object" && "text" in c && typeof c.text === "string") texts.push(c.text);
    }
    if (texts.some((t) => REFUSAL_RE.test(t.trimStart()))) return true;
  }
  return false;
}

/** Last TAIL_BYTES of a file ("" if unreadable). */
export function tail(file: string): string {
  try {
    const size = statSync(file).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/** Newest .jsonl directly in `dir` (null if none). */
export function newestJsonl(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

export interface RefusalCheck {
  output: string;
  sinceMs: number;
  /** Session logs the run may have written (side session dir's newest file, the pane's session file). */
  files: (string | null | undefined)[];
}
export function isCyberRefusal(c: RefusalCheck): boolean {
  if (c.output.split("\n").some((l) => REFUSAL_RE.test(l.replace(/^\s*(?:error:?\s*)?/i, "")))) return true;
  return c.files.some((f) => !!f && refusalSince(tail(f), c.sinceMs));
}

type Run = (cmd: string, args: string[]) => { code: number; out: string };
const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
};

export interface ResetDeps {
  sessionsDir: string;
  sideKey: string;
  pane: string;
  stateFile: string;
  log(s: string): void;
  run?: Run;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** pids of processes whose command line has `--session-dir <sessionsDir>/<sideKey>`. */
  sideRuns?(): number[];
  children?(pid: number): number[];
  comm?(pid: number): string;
  kill?(pid: number, sig: NodeJS.Signals): boolean;
}
export interface ResetResult {
  ok: boolean;
  archived?: string;
  pane: "restarted" | "skipped" | "failed";
  reason?: string;
}

function procChildren(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
function procComm(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}
function procSideRuns(sessionsDir: string, sideKey: string): number[] {
  const want = `--session-dir\0${join(sessionsDir, sideKey)}\0`;
  const out: number[] = [];
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    try {
      if (`${readFileSync(`/proc/${n}/cmdline`, "utf8")}\0`.includes(want)) out.push(Number(n));
    } catch {}
  }
  return out;
}

export async function resetFirstmate(d: ResetDeps): Promise<ResetResult> {
  const run = d.run ?? defaultRun;
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const children = d.children ?? procChildren;
  const comm = d.comm ?? procComm;
  const kill = d.kill ?? ((pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); return true; } catch { return false; } });
  try {
    const last = Number(JSON.parse(readFileSync(d.stateFile, "utf8")).at);
    if (now() - last < MIN_GAP_MS) return { ok: false, pane: "skipped", reason: "another automatic reset ran less than 10 minutes ago" };
  } catch {}
  if ((d.sideRuns ?? (() => procSideRuns(d.sessionsDir, d.sideKey)))().length) return { ok: false, pane: "skipped", reason: "a FIRSTMATE side-session run is still active" };

  const src = join(d.sessionsDir, d.sideKey);
  let archived: string | undefined;
  if (existsSync(src)) {
    const ts = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    archived = `${src}.old-${ts}`;
    renameSync(src, archived);
  }
  mkdirSync(join(d.stateFile, ".."), { recursive: true });
  writeFileSync(d.stateFile, JSON.stringify({ at: now(), archived }));
  d.log(`cyber-reset: archived ${archived ?? "(no side session)"}`);

  // Pane: restart its omp only when the input box is empty.
  let info: { shell_pid?: number; foreground_processes?: { name?: string }[] };
  try {
    info = JSON.parse(run("herdr", ["pane", "process-info", "--pane", d.pane]).out).result.process_info;
  } catch {
    return { ok: true, archived, pane: "failed", reason: "pane not found" };
  }
  const shell = Number(info.shell_pid);
  const omp = children(shell).find((p) => comm(p) === "omp");
  if (omp) {
    const screen = run("herdr", ["agent", "read", d.pane, "--source", "visible", "--lines", "6"]);
    const empty = screen.code === 0 ? editorEmpty(screen.out) : { ok: false, reason: "input box unreadable" };
    if (!empty.ok) return { ok: true, archived, pane: "skipped", reason: empty.reason };
    kill(omp, "SIGTERM");
    for (let i = 0; i < 20 && children(shell).includes(omp); i++) await sleep(500);
    if (children(shell).includes(omp)) return { ok: true, archived, pane: "failed", reason: "old omp did not exit" };
  }
  else {
    // No omp: type into the pane only when its foreground process is the plain shell (no other program reads input).
    const fg = info.foreground_processes?.[0]?.name ?? "";
    if (!/^(?:bash|zsh|fish|sh)$/.test(fg)) return { ok: true, archived, pane: "skipped", reason: `pane runs ${fg || "an unknown program"}, not a shell` };
  }
  if (run("herdr", ["pane", "run", d.pane, "omp"]).code !== 0) return { ok: true, archived, pane: "failed", reason: "herdr pane run failed" };
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (children(shell).some((p) => comm(p) === "omp")) {
      d.log(`cyber-reset: fresh omp in ${d.pane}`);
      return { ok: true, archived, pane: "restarted" };
    }
  }
  return { ok: true, archived, pane: "failed", reason: "new omp did not start within 20 s" };
}

/** The Discord notice after an automatic reset. */
export function resetNotice(r: ResetResult): string {
  if (!r.ok) return `⚠️ Cyber refusal detected, but the automatic FIRSTMATE reset did not run: ${r.reason}.`;
  const pane = r.pane === "restarted" ? "fresh omp in the Herdr FIRSTMATE tab" : `Herdr pane not restarted (${r.reason})`;
  return [
    "🔄 **Cyber refusal detected → FIRSTMATE reset automatically.**",
    `• Discord session archived (nothing deleted); ${pane}.`,
    "• Your last message was **not** resent. Rephrase it before sending again, or it will likely be refused again.",
  ].join("\n");
}
