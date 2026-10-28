// Long-running job status (owner decision 2026-10-16): approved jobs may run up to 4 h, and a job
// that is still running posts a "still running" line in #long-running-jobs every 5 minutes,
// plus one final line when it ends (only if it posted at least one status line).
// Posting goes directly to the Discord REST API with the bot token from bot.env, so it also works
// from the approval tab and while the bridge restarts. Failures are ignored: a status post must
// never stop or fail the job itself.
//
// CLI for any long job an agent starts (symlinked as ~/.local/bin/longjob):
//   longjob [--name TEXT] [--limit-min N] -- <command> [args…]
// Runs the command (argv, no shell) with inherited stdio and posts the status lines. It has no
// time limit unless --limit-min is given (then SIGTERM at the limit, exit 124). SIGTERM, SIGINT and
// SIGHUP sent to longjob are passed to the command, and the end line is still posted.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../src/config.ts";

/** Approved omp-approve jobs (Discord button and password tab) stop after this. */
export const APPROVAL_RUN_TIMEOUT_MS = 4 * 60 * 60_000;
/** #long-running-jobs, from config.json `longJobsChannelId` (empty: status lines are not posted). */
export const LONG_JOBS_CHANNEL_ID = CONFIG.longJobsChannelId;
export const HEARTBEAT_MS = Number(process.env.OMP_LONGJOB_INTERVAL_MS ?? 5 * 60_000);

export type PostFn = (text: string) => Promise<void>;

/** Direct REST post to #long-running-jobs. The token is read per call and never logged. */
export const postLongJobs: PostFn = async (text) => {
  if (process.env.OMP_LONGJOB_DISABLE === "1" || !LONG_JOBS_CHANNEL_ID) return;
  try {
    const env = readFileSync(join(homedir(), ".config", "omp-discord", "bot.env"), "utf8");
    const tok = env.match(/DISCORD_BOT_TOKEN=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!tok) return;
    await fetch(`https://discord.com/api/v10/channels/${LONG_JOBS_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {}
};

export const fmtMin = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/**
 * Start status posts for a job. Returns stop(summary): it clears the timer and, if at least one
 * "still running" line was posted, posts the final line.
 */
export function startHeartbeat(label: string, opts: { post?: PostFn; intervalMs?: number; limitMs?: number; now?: () => number } = {}) {
  const post = opts.post ?? postLongJobs;
  const every = opts.intervalMs ?? HEARTBEAT_MS;
  const limit = opts.limitMs ?? APPROVAL_RUN_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const start = now();
  let beats = 0;
  const timer = setInterval(() => {
    beats++;
    void post(`⏳ **Still running** (${fmtMin(now() - start)}; ${limit > 0 ? `limit ${fmtMin(limit)}` : "no time limit"}): ${label}`);
  }, every);
  timer.unref?.();
  return {
    get beats() {
      return beats;
    },
    async stop(result: string): Promise<void> {
      clearInterval(timer);
      if (beats > 0) await post(`🏁 **Ended** after ${fmtMin(now() - start)}: ${label} — ${result}`);
    },
  };
}

async function cli(argv: string[]): Promise<number> {
  let name = "";
  let limitMin = 0;
  const sep = argv.indexOf("--");
  const opts = sep >= 0 ? argv.slice(0, sep) : [];
  const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === "--name") name = opts[++i] ?? "";
    else if (opts[i] === "--limit-min") limitMin = Number(opts[++i]);
    else return usage(`unknown option ${opts[i]}`);
  }
  if (!cmd.length || cmd[0]!.startsWith("-") || !(limitMin >= 0)) return usage("missing command or bad --limit-min");
  const limitMs = limitMin * 60_000;
  const label = `${name || cmd.join(" ").slice(0, 120)} (${hostname()}, cwd ${process.cwd().replace(homedir(), "~")})`;
  const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
  const beat = startHeartbeat(label, { limitMs });
  let stopSignal = "";
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(sig, () => {
      stopSignal ||= sig;
      child.kill(sig);
    });
  let timedOut = false;
  const t = limitMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, limitMs)
    : undefined;
  const closed = Promise.withResolvers<{ code: number | null; sig: NodeJS.Signals | null }>();
  child.on("close", (code, sig) => closed.resolve({ code, sig }));
  child.on("error", () => closed.resolve({ code: 127, sig: null }));
  const end = await closed.promise;
  clearTimeout(t);
  const code = longjobExitCode({ ...end, stopSignal, timedOut });
  await beat.stop(timedOut ? `stopped at the ${fmtMin(limitMs)} limit` : stopSignal ? `stopped by ${stopSignal} (exit ${code})` : `exit ${code}`);
  return code;
}

const SIGNO: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * Exit code of longjob. --limit-min timeout: 124. A stop signal that longjob received and passed on
 * (systemctl stop, Ctrl-C) is a planned stop: exit 0 when the command ended from that signal
 * (killed by it, exit 128+signo, or exit 0), so systemd does not mark the unit failed. Otherwise the
 * command's own code (killed by an unexpected signal: 128+signo).
 */
export function longjobExitCode(e: { code: number | null; sig: string | null; stopSignal: string; timedOut: boolean }): number {
  if (e.timedOut) return 124;
  const got = e.code ?? (e.sig ? 128 + (SIGNO[e.sig] ?? 0) : 1);
  if (e.stopSignal) {
    const n = SIGNO[e.stopSignal]!;
    if (e.sig === e.stopSignal || got === 128 + n || got === 0) return 0;
  }
  return got;
}

function usage(why: string): number {
  console.error(`longjob: ${why}\nusage: longjob [--name TEXT] [--limit-min N] -- <command> [args…]`);
  return 64;
}

if (import.meta.main) process.exit(await cli(process.argv.slice(2)));
