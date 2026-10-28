// In-sandbox client for the bridge's host-exec broker (src/hostexec.ts). Invoked by the wrappers
// in gate/bin as `cli.ts <name> <args…>`:
// - git: push/fetch/pull/clone/ls-remote go to the broker; everything else runs the real git here.
// - gh, systemctl, herdr, op: always brokered (validated read/allowed commands only).
// - omp-approve [--wait] [--reason TEXT] [--] <command…>: queue a command for the owner's
//   password-gated approval (orders, money, sudo, secret values, deletions outside repos, …).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const SOCKET = process.env.OMP_GATE_SOCKET ?? "/tmp/.omp-discord-sandbox/sock/hostexec.sock";
const GIT_BROKER = ["push", "fetch", "pull", "clone", "ls-remote"];
const WAIT_MAX_MS = 29 * 60_000;

function request(req: unknown): Promise<Record<string, unknown>> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
  const c = connect(SOCKET);
  let buf = "";
  c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
  c.on("data", (d) => (buf += d.toString()));
  c.on("end", () => {
    try {
      resolve(JSON.parse(buf));
    } catch {
      resolve({ error: "bad response from bridge" });
    }
  });
  c.on("error", (e) => resolve({ error: `bridge broker unavailable (${e.message})` }));
  return promise;
}

/** Run the real binary (this wrapper directory removed from PATH). */
function execReal(name: string, args: string[]): number {
  const self = realpathSync(join(dirname(realpathSync(process.argv[1]!)), "bin"));
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((d) => {
      try {
        return realpathSync(d) !== self;
      } catch {
        return true;
      }
    })
    .join(":");
  const r = spawnSync(name, args, { stdio: "inherit", env: { ...process.env, PATH: path } });
  return r.status ?? 1;
}

async function brokerExec(argv: string[]): Promise<number> {
  const r = await request({ type: "exec", argv, cwd: process.cwd() });
  if (typeof r.error === "string") {
    process.stderr.write(`${argv[0]}: ${r.error}\n`);
    return 1;
  }
  process.stdout.write(String(r.stdout ?? ""));
  process.stderr.write(String(r.stderr ?? ""));
  return Number(r.code ?? 1);
}

/** First git subcommand after global options. */
export function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

export const APPROVE_USAGE = [
  "usage: omp-approve [--wait] [--reason TEXT] [--] '<exact command>'",
  "       omp-approve --status <id>      show the receipt of an earlier request",
  "       omp-approve --wait-id <id>     wait up to 29 min for an earlier request",
  "       omp-approve -h | --help        show this help (queues nothing)",
  "Queues the exact command for the owner's approval. Nothing runs until the owner approves it.",
  "Options must come before the command. A command that starts with '-' is refused, also after '--'.",
].join("\n");

export type ApproveArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "status"; id: string }
  | { kind: "wait-id"; id: string }
  | { kind: "request"; wait: boolean; reason: string; command: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parse omp-approve arguments. Strict on purpose: any unknown option before the command is an
 * error, so `omp-approve --help` (or a typo such as `--wiat`) never queues a bogus approval
 * request. Incident 2026-10-13/15/16: `--help` was queued three times and approved once.
 */
export function parseApproveArgs(args: string[]): ApproveArgs {
  if (args[0] === "--status" || args[0] === "--wait-id") {
    const id = args[1];
    if (!id || !ID_RE.test(id) || id.startsWith("-") || args.length > 2) return { kind: "error", message: `${args[0]} needs exactly one approval id (nothing was queued)` };
    return { kind: args[0] === "--status" ? "status" : "wait-id", id };
  }
  let wait = false;
  let reason = "";
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") return { kind: "help" };
    if (a === "--wait") wait = true;
    else if (a === "--reason") {
      const v = args[i + 1];
      if (v === undefined || v === "--") return { kind: "error", message: "--reason needs a text value" };
      reason = v;
      i++;
    } else if (a.startsWith("--reason=")) reason = a.slice("--reason=".length);
    else if (a === "--") {
      i++;
      break;
    } else if (a.startsWith("-")) return { kind: "error", message: `unknown option ${a} (nothing was queued)` };
    else break;
  }
  const command = args.slice(i).join(" ").trim();
  if (!command) return { kind: "error", message: "no command given (nothing was queued)" };
  // Plan P4: a command never starts with '-', not even after '--' (it would be an option, not a command).
  if (command.startsWith("-")) return { kind: "error", message: `the command may not start with '-' (${command.split(/\s+/)[0]}; nothing was queued)` };
  return { kind: "request", wait, reason, command };
}

async function approve(p: { wait: boolean; reason: string; command: string }): Promise<number> {
  const { wait, reason, command } = p;
  const r = await request({ type: "approve", command, cwd: process.cwd(), reason });
  if (typeof r.error === "string") {
    console.error(`omp-approve: ${r.error}`);
    return 1;
  }
  const id = String(r.id);
  console.log(
    process.env.OMP_DISCORD_SANDBOX === "off"
      ? `Queued for the owner's approval as ${id}. The bridge posts the exact command in this Discord thread with an Approve button; it runs on ${hostname()} only after the owner taps it. Nothing has run yet.`
      : `Queued for the owner's approval as ${id}. The bridge posts the exact command in this Discord thread and opens an "Approve ${id}" tab on ${hostname()}; it runs only after the owner's login password. Nothing has run yet.`,
  );
  if (!wait) {
    console.log(`Check later with: omp-approve --status ${id}   (or wait: omp-approve --wait-id ${id})`);
    return 0;
  }
  return waitFor(id);
}

async function waitFor(id: string): Promise<number> {
  const until = Date.now() + WAIT_MAX_MS;
  while (Date.now() < until) {
    const r = await request({ type: "receipt", id });
    if (typeof r.error === "string") {
      console.error(`omp-approve: ${r.error}`);
      return 1;
    }
    const rc = r.receipt as { status: string; exitCode?: number | null; output?: string; detail: string } | null;
    if (rc) {
      console.log(`Approval ${id}: ${rc.status} — ${rc.detail}`);
      if (rc.output) console.log(rc.output);
      return rc.status === "ran" ? Number(rc.exitCode ?? 1) : 1;
    }
    await Bun.sleep(3000);
  }
  console.log(`Approval ${id} is still pending or running (approved jobs may run up to 4 h; status in #long-running-jobs). The result will be posted in Discord and given to you with the next message; check with: omp-approve --status ${id}`);
  return 1;
}

async function main(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  if (!name) return 2;
  if (name === "omp-approve") {
    const p = parseApproveArgs(args);
    if (p.kind === "help") {
      console.log(APPROVE_USAGE);
      return 0;
    }
    if (p.kind === "error") {
      console.error(`omp-approve: ${p.message}\n${APPROVE_USAGE}`);
      return 2;
    }
    if (p.kind === "status") {
      const r = await request({ type: "receipt", id: p.id });
      console.log(JSON.stringify(r, null, 2));
      return r.error ? 1 : 0;
    }
    if (p.kind === "wait-id") return waitFor(p.id);
    return approve(p);
  }
  if (name === "git" && !GIT_BROKER.includes(gitSubcommand(args) ?? "")) return execReal("git", args);
  return brokerExec([name, ...args]);
}

if (import.meta.main) process.exit(await main());
