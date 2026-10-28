import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CACHE_DIR, IDLE_TIMEOUT_MS, OMP_BIN, QUEUE_DIR, RUN_TIMEOUT_MS, SCRATCH_DIR, SESSIONS_DIR, STATE_DIR, trusted } from "./config.ts";
import { startEgressProxy } from "./egress.ts";
import { startHostExec, type RunContext } from "./hostexec.ts";
import { discover, discoverAsync, OMP_RW_DIRS, runEnv, sandboxCommand, serviceRepos, type Discovery, type SandboxSpec } from "./sandbox.ts";
import { RunHeartbeat } from "./heartbeat.ts";
import { startStatusMonitorProxy, startTcpTunnel } from "./tunnels.ts";
import type { Entry } from "../gate/queue.ts";
import { waitSessionFree } from "./ompsession.ts";
import { newestSessionFile } from "./earlier.ts";

export interface RunResult {
  ok: boolean;
  timedOut: boolean;
  /** Owner 2026-10-19: stopped because the session log did not change for IDLE_TIMEOUT_MS (timedOut is also true). */
  idle?: boolean;
  /** Stopped by the owner (❌ button). */
  cancelled?: boolean;
  code: number | null;
  stdout: string;
  stderrTail: string;
  durationMs: number;
  /** Tool calls the main session made in this run (UX item 7: only runs without any retry by themselves). */
  toolCalls?: number;
  /** `--model` passed to this run (per-channel /models override); absent = bot default. */
  model?: string;
  /** Owner 2026-10-23 (Discord UX item 4): the session log this run wrote (resume file or newest in its dir). */
  sessionFile?: string;
  /** Run start (ms), to find this run's answers in the session log. */
  startedAt?: number;
}

/** Session keys come from Discord snowflakes ("123…" or "dm-123…"). */
export function sessionDir(key: string): string {
  if (!/^[a-z0-9-]+$/i.test(key)) throw new Error("bad session key");
  return join(SESSIONS_DIR, key);
}

export function hasSession(key: string): boolean {
  const dir = sessionDir(key);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"));
}

/** Archive the session directory so the next run starts fresh. */
export function resetSession(key: string): void {
  const dir = sessionDir(key);
  if (existsSync(dir)) renameSync(dir, `${dir}.old-${Date.now()}`);
}

/** Qwen-only overlay for unrestricted/* models: all roles Qwen, no advisor, no auto thinking (see the file). */
export const QWEN_OVERLAY = resolve(import.meta.dir, "..", "config", "qwen-trusted-overlay.yml");

/** Session key for a turn: unrestricted/* (Qwen) gets `<key>-qwen`, so Claude and Qwen never share a session file. */
export function qwenSessionKey(key: string, model: string | null | undefined): string {
  const tag = isolatedTag(model);
  return tag ? `${key}-${tag}` : key;
}
/**
 * Owner 2026-10-20: non-Claude providers run isolated (own session, every role on the picked model, no advisor):
 * unrestricted/* -> "qwen", venice/* -> "venice". null = a normal (Claude) turn.
 */
export function isolatedTag(model: string | null | undefined): string | null {
  if (model?.startsWith("unrestricted/")) return "qwen";
  if (model?.startsWith("venice/")) return "venice";
  // Owner 2026-10-25: Codex/OpenRouter/local picks get their own session too (Claude thinking blocks and Codex
  // reasoning items do not carry across providers in one resumed session).
  if (model?.startsWith("openai-codex/")) return "codex";
  if (model?.startsWith("openrouter/")) return "openrouter";
  if (model?.startsWith("local-coder/")) return "local";
  return null;
}
/** Overlay for a venice/* model: every role is that model, advisor off, no auto thinking (written to STATE_DIR). */
export function veniceOverlay(model: string): string {
  const dir = join(STATE_DIR, "overlays");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${model.replace(/[^A-Za-z0-9.-]+/g, "_")}.yml`);
  const roles = ["default", "smol", "slow", "plan", "commit", "title", "judge", "advisor"].map((r) => `  ${r}: ${model}`).join("\n");
  // retry.fallbackChains.judge (typesafe/jev-latest, a decisions-only API) must not apply: when Venice failed (e.g. 402 no
  // credit), OMP switched the turn to it and showed "Unhandled API in mapOptionsForApi: typesafe" instead of the real error.
  writeFileSync(file, `# Written by omp-discord-bot src/omp.ts (owner 2026-10-20): Venice turns never use Claude.\ndefaultThinkingLevel: "off"\nadvisor:\n  enabled: false\nretry:\n  fallbackChains:\n    judge: []\nmodelRoles:\n${roles}\n`);
  return file;
}

/** modelRoles.default from ~/.omp/agent/config.yml (shown in the Working message until the log names the model). */
export function defaultModel(file = join(homedir(), ".omp", "agent", "config.yml")): string | undefined {
  try {
    const roles = readFileSync(file, "utf8").match(/^modelRoles:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? "";
    return roles.match(/^[ \t]+default:[ \t]*["']?([^"'\s#]+)/m)?.[1];
  } catch {
    return undefined;
  }
}

/** --model plus the isolation overlay for Qwen/Venice (also used by session-command RPC processes). */
export function modelArgs(model?: string): string[] {
  if (!model) return [];
  // Owner 2026-10-19: Qwen never shares a turn with Claude (advisor/judge/subagents), so no Qwen transcript reaches Anthropic.
  if (model.startsWith("unrestricted/")) return ["--model", model, "--config", QWEN_OVERLAY, "--thinking", "off"];
  if (model.startsWith("venice/")) return ["--model", model, "--config", veniceOverlay(model), "--thinking", "off"];
  return ["--model", model];
}

/** resumeFile: continue a mirrored pane's session file (bound writable at its own path). extraArgs: /mode flags. fresh: /new. */
export function ompArgs(key: string, prompt: string, cont: boolean, resumeFile?: string, model?: string, extraArgs: string[] = [], fresh = false): string[] {
  const args = ["-p", "--session-dir", sessionDir(key), "--max-time", `${Math.ceil(RUN_TIMEOUT_MS / 60_000)}m`];
  args.push(...modelArgs(model), ...extraArgs);
  if (resumeFile) args.push("--resume", resumeFile);
  else if (cont && !fresh) args.push("--continue");
  args.push(prompt);
  return args;
}

const REPO_DIR = resolve(import.meta.dir, "..");
let approvalListener: (e: Entry) => void = () => {};
/** The bridge's approval manager registers here; every run's `omp-approve` request is announced. */
export function onApprovalRequest(fn: (e: Entry) => void): void {
  approvalListener = fn;
}

let discoveryCache: { at: number; d: Discovery } | null = null;
let discoveryRefresh: Promise<void> | null = null;
/** Refresh the discovery cache off the main thread (no audio stalls). */
export function refreshDiscovery(home = homedir()): Promise<void> {
  discoveryRefresh ??= discoverAsync(home)
    .then((d) => void (discoveryCache = { at: Date.now(), d }))
    .catch(() => {})
    .finally(() => void (discoveryRefresh = null));
  return discoveryRefresh;
}
function cachedDiscovery(home: string): Discovery {
  if (!discoveryCache) discoveryCache = { at: Date.now(), d: discover(home) }; // first run only, if not primed
  else if (Date.now() - discoveryCache.at > 60_000) void refreshDiscovery(home); // stale: serve old, refresh in background
  return discoveryCache.d;
}

export interface RunTarget {
  /** Discord channel/thread where approval requests from this run are posted. */
  channelId: string;
  /** Mirrored pane session file to continue. */
  resumeFile?: string;
  /** Run id chosen by the caller (OMP_GATE_RUN); `fm` records it as `by: run:<id>` for the dashboard's ?by= filter. */
  runId?: string;
  /** Per-channel /models override (`provider/model`). */
  model?: string;
  /** /mode flags for this channel (src/ompsession.ts modeArgs). */
  extraArgs?: string[];
  /** /new: start a new session file in the session folder (no --continue). */
  fresh?: boolean;
}

/** Remove per-run socket dirs left by bridge/test processes that are gone. */
function cleanStaleRunDirs(root: string): void {
  try {
    for (const f of readdirSync(root)) {
      const pid = Number(f.split("-")[0]);
      if (Number.isFinite(pid) && !existsSync(`/proc/${pid}`)) rmSync(join(root, f), { recursive: true, force: true });
    }
  } catch {}
}

/**
 * Spawn a command inside the capability sandbox with this run's bridge sockets (egress proxy,
 * status-monitor, host-exec broker). Sockets are closed when the process exits.
 */
export function spawnSandboxed(key: string, cwd: string, cmd: string[], target: RunTarget): ChildProcess {
  const home = homedir();
  const runId = target.runId && /^[0-9a-f]{6,32}$/.test(target.runId) ? target.runId : randomBytes(6).toString("hex");
  const runsRoot = join(STATE_DIR, "run");
  mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  cleanStaleRunDirs(runsRoot);
  const sockDir = join(runsRoot, `${process.pid}-${runId}`);
  mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  chmodSync(sockDir, 0o700);
  const scratchDir = join(SCRATCH_DIR, key);
  for (const d of [scratchDir, CACHE_DIR, sessionDir(key), join(home, "discord-scratch")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const d of OMP_RW_DIRS) mkdirSync(join(home, d), { recursive: true });
  const discovery = cachedDiscovery(home);
  const protectedTrees = serviceRepos(discovery.trees, home);
  const isUnder = (p: string, root: string) => p === root || p.startsWith(root + sep);
  const writableTrees = discovery.trees.filter((t) => !protectedTrees.some((p) => isUnder(t, p)));
  const ctx: RunContext = {
    runId,
    sessionKey: key,
    channelId: target.channelId,
    home,
    scratchDir,
    writableTrees,
    trees: discovery.trees,
    queueDir: QUEUE_DIR,
    onApprovalRequest: (e) => approvalListener(e),
  };
  if (trusted()) return spawnTrusted(key, cwd, cmd, { ...ctx, trusted: true }, sockDir, home);
  const servers = [
    startEgressProxy(join(sockDir, "egress.sock")),
    startHostExec(join(sockDir, "hostexec.sock"), ctx),
  ];
  const broker = startStatusMonitorProxy(join(sockDir, "status.sock"));
  const spec: SandboxSpec = {
    home,
    cwd,
    sessionDir: sessionDir(key),
    sockDir,
    bunBin: process.execPath,
    repoDir: REPO_DIR,
    scratchDir,
    cacheDir: CACHE_DIR,
    discovery,
    protectedTrees,
    paneSession: target.resumeFile ? { file: target.resumeFile, artifacts: target.resumeFile.replace(/\.jsonl$/, "") } : undefined,
  };
  const { file, args } = sandboxCommand(spec, cmd);
  const child = spawn(file, args, {
    cwd,
    env: runEnv(process.env, { home, repoDir: REPO_DIR, gate: { OMP_GATE_SESSION: key, OMP_GATE_RUN: runId } }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.on("close", () => {
    for (const s of servers) s.close();
    broker.stop(true);
    rmSync(sockDir, { recursive: true, force: true });
  });
  return child;
}

/**
 * Trusted mode: the run is a normal process of the user (no bwrap, no proxy, real git/gh/ssh/sudo).
 * Only the host-exec socket stays, so `omp-approve` (the Discord Approve button) still works.
 */
function spawnTrusted(key: string, cwd: string, cmd: string[], ctx: RunContext, sockDir: string, home: string): ChildProcess {
  const sock = join(sockDir, "hostexec.sock");
  const server = startHostExec(sock, ctx);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^DISCORD/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home,
    PATH: [join(REPO_DIR, "gate", "bin-trusted"), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
    TERM: "dumb",
    OMP_DISCORD_BRIDGE: "1",
    OMP_DISCORD_SANDBOX: "off",
    OMP_GATE_BUN: process.execPath,
    OMP_GATE_HOME: join(REPO_DIR, "gate"),
    OMP_GATE_SOCKET: sock,
    OMP_GATE_SESSION: key,
    OMP_GATE_RUN: ctx.runId,
    GIT_TERMINAL_PROMPT: "0",
  });
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.on("close", () => {
    server.close();
    rmSync(sockDir, { recursive: true, force: true });
  });
  return child;
}

/**
 * Run `omp -p` for one message inside the capability sandbox. Session per Discord thread/channel
 * via --session-dir; follow-ups use --continue. Own process group so a timeout kills the whole tree.
 */
/** Running agent processes by Discord channel/thread id (one run per channel at a time), so the owner can stop one (❌ button). */
const active = new Map<string, () => void>();
const stopped = new Set<string>();
/** Heartbeat state of the running agent per channel/thread (src/heartbeat.ts; the Working message shows it). */
const heartbeats = new Map<string, RunHeartbeat>();

export function runHeartbeat(channelId: string): RunHeartbeat | undefined {
  return heartbeats.get(channelId);
}

/** Stop the run for `key` (SIGTERM, then SIGKILL). True if something was running. */
export function stopRun(channelId: string): boolean {
  const kill = active.get(channelId);
  if (!kill) return false;
  stopped.add(channelId);
  kill();
  return true;
}

export async function runOmp(key: string, cwd: string, prompt: string, target: RunTarget): Promise<RunResult> {
  // /qwen, Venice: see isolatedTag. Claude and isolated models never share a session file.
  const tag = isolatedTag(target.model);
  if (tag && (target.resumeFile || !key.endsWith(`-${tag}`))) throw new Error(`${tag} turns run only in their own -${tag} session`);
  // A Discord session command (/compact, /branch ...) may hold this session: start after it (src/ompsession.ts).
  await waitSessionFree(key);
  const cont = hasSession(key);
  const started = Date.now();
  const { promise, resolve: done } = Promise.withResolvers<RunResult>();
  // Created before spawn so it records the session file sizes this run starts from.
  const hb = new RunHeartbeat(started, sessionDir(key), target.resumeFile, target.model ?? defaultModel());
  const child = spawnSandboxed(key, cwd, [OMP_BIN, ...ompArgs(key, prompt, cont, target.resumeFile, target.model, target.extraArgs, target.fresh)], target);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let finished = false;
  child.stdout!.on("data", (d: Buffer) => {
    if (stdout.length < 2_000_000) stdout += d.toString();
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {}
  };
  if (child.pid) {
    hb.pid = child.pid;
    heartbeats.set(target.channelId, hb);
  }
  active.set(target.channelId, () => {
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 5_000).unref();
  });
  // Hard backstop in case --max-time does not end the process.
  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 10_000).unref();
  }, RUN_TIMEOUT_MS + 30_000);
  // Owner 2026-10-19: stop the run when its session log has not changed for IDLE_TIMEOUT_MS.
  let idle = false;
  const idleTimer = setInterval(() => {
    let last = started;
    try {
      last = hb.activity();
    } catch {}
    if (Date.now() - last < IDLE_TIMEOUT_MS) return;
    idle = true;
    timedOut = true;
    clearInterval(idleTimer);
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 10_000).unref();
  }, 15_000);
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearInterval(idleTimer);
    active.delete(target.channelId);
    heartbeats.delete(target.channelId);
    const cancelled = stopped.delete(target.channelId);
    const durationMs = Date.now() - started;
    // --max-time ends the session itself; a run that hit the limit counts as a timeout.
    if (durationMs >= RUN_TIMEOUT_MS) timedOut = true;
    let toolCalls: number | undefined;
    try {
      hb.activity(); // reads the last log lines
      toolCalls = hb.toolCalls;
    } catch {}
    const sessionFile = target.resumeFile ?? newestSessionFile(sessionDir(key)) ?? undefined;
    done({ ok: code === 0 && !timedOut && !cancelled, timedOut, idle: idle && !cancelled, cancelled, code, stdout: stdout.trim(), stderrTail: stderr.trim(), durationMs, model: target.model, toolCalls, sessionFile, startedAt: started });
  };
  child.on("error", (e) => {
    stderr += `\nspawn error: ${e.message}`;
    finish(null);
  });
  child.on("close", (code) => finish(code));
  return promise;
}
