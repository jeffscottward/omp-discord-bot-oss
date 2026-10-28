/**
 * Owner 2026-10-15: extra main slash commands (/services /logs /disk /restart /panes /net /stream
 * /remind /nest /blinds /radio /updates /second). All read-only except /restart (asks first), /remind and /blinds.
 * Output is plain text built from local commands; process command lines are never shown.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG, commandEnabled } from "./config.ts";
import { collectGpu, bar } from "./rigstats.ts";
import { onCalendar, parseReminder } from "./remindparse.ts";

const run = promisify(execFile);
const HOME = homedir();
const sh = async (cmd: string, args: string[], timeout = 20_000) => {
  const r = await run(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string; message: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr || e.message }));
  return `${r.stdout ?? ""}`.trim() || `${r.stderr ?? ""}`.trim();
};
/** Like sh, but keeps the exit status, so commands that change state can report failures honestly. */
const exec = async (cmd: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string }> =>
  run(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }).then(
    (r) => ({ ok: true, out: `${r.stdout}`.trim() }),
    (e: { stdout?: string; stderr?: string; message: string }) => ({ ok: false, out: `${e.stderr || e.stdout || e.message}`.trim() }),
  );
const clip = (s: string, n = 1700) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
const block = (s: string) => `\`\`\`\n${clip(s.replace(/```/g, "ˋˋˋ"))}\n\`\`\``;

/** Services the owner watches: label → user unit. */
export const SERVICES: Record<string, string> = {
  bot: "omp-discord-bot.service",
  radio: "omp-lofi-radio.service",
  statusmon: "status-monitor.service",
  streamsrv: "stream-server.service",
  tts: "omp-tts.service",
  whisper: "omp-whisper.service",
  "claude-broker": "omp-procedura-broker.service",
  darkfactory: "darkfactory-omp-gateway.service",
  reminders: "reminders-inbox.service",
  "kb-chat": "kb-chat.service",
};
/** /restart targets. The Claude broker and DarkFactory gateway are excluded on purpose (AGENTS.md: ask first). */
export const RESTARTABLE = ["bot", "radio", "statusmon", "tts", "whisper", "reminders", "kb-chat"] as const;

export async function services(): Promise<string> {
  const lines = ["🖥️ **Services**", "———————————"];
  for (const [label, unit] of Object.entries(SERVICES)) {
    const state = await sh("systemctl", ["--user", "is-active", unit]);
    const since = await sh("systemctl", ["--user", "show", unit, "-p", "ActiveEnterTimestamp", "--value"]);
    const t = Date.parse(since) ? ` · since <t:${Math.floor(Date.parse(since) / 1000)}:R>` : "";
    lines.push(`${state === "active" ? "🟢" : state === "activating" ? "🟡" : "🔴"} **${label}** ${state}${state === "active" ? t : ""}`);
  }
  const failed = (await sh("systemctl", ["--user", "list-units", "--state=failed", "--no-legend", "--plain"])).split("\n").filter(Boolean);
  lines.push("", failed.length ? `⚠️ ${failed.length} failed unit(s): ${failed.map((l) => l.split(" ")[0]).join(", ")}` : "✅ No failed user units");
  const timers = (await sh("systemctl", ["--user", "list-timers", "--no-legend", "--plain"])).split("\n").filter(Boolean).length;
  lines.push(`⏲️ ${timers} active timer(s)`);
  return lines.join("\n");
}

export async function logs(label: string, redact: (s: string) => string): Promise<string> {
  const unit = SERVICES[label];
  if (!unit) return `❌ Unknown service: ${label}`;
  const out = await sh("journalctl", ["--user", "-u", unit, "-n", "20", "-o", "cat", "--no-pager"]);
  return `📜 **${label}** · last 20 lines\n${block(redact(out.split("\n").map((l) => l.slice(0, 160)).join("\n")) || "(no lines)")}`;
}

export async function disk(): Promise<string> {
  const out = await sh("df", ["-h", "-x", "tmpfs", "-x", "devtmpfs", "-x", "efivarfs", "-x", "overlay", "--output=source,target,size,used,avail,pcent"]);
  const rows = out.split("\n").slice(1).filter((l) => !/\/(boot|snap)/.test(l));
  const lines = ["💽 **Disk**", "———————————"];
  const seen = new Set<string>(); // btrfs subvolumes and bind mounts repeat the same device
  for (const r of rows) {
    const [source, target, size, used, avail, pc] = r.trim().split(/\s+/);
    if (!source || seen.has(source.replace(/\[.*$/, ""))) continue;
    seen.add(source.replace(/\[.*$/, ""));
    const p = Number(pc?.replace("%", "")) || 0;
    lines.push(`${p >= 90 ? "🔴" : p >= 75 ? "🟡" : "🟢"} ${bar(p)} **${pc}** \`${target}\` · ${used} / ${size} · ${avail} free`);
  }
  const big = await sh("bash", ["-c", "du -xhd1 \"$HOME\" 2>/dev/null | sort -rh | sed -n 2,6p"], 30_000);
  if (big) lines.push("", "📁 **Largest in ~**", ...big.split("\n").map((l) => { const [s, p] = l.split("\t"); return `• ${s} \`${(p ?? "").replace(HOME, "~")}\``; }));
  return lines.join("\n");
}

/** Restart after the owner confirms. The bot itself goes through restart-when-idle.sh (never mid-answer). */
export async function restartService(label: string, repoDir: string): Promise<string> {
  if (!(RESTARTABLE as readonly string[]).includes(label)) return `❌ ${label} can't be restarted from Discord.`;
  if (label === "bot") {
    const r = await exec("systemd-run", ["--user", `--unit=omp-discord-restart-${Math.floor(Date.now() / 1000)}`, "--collect", `--working-directory=${repoDir}`, "scripts/restart-when-idle.sh", "HEAD", "60"]);
    if (!r.ok) return `❌ **Bot restart not scheduled:** ${r.out.split("\n")[0]?.slice(0, 200)}`;
    return "🔄 **Bot restart scheduled.** It runs when the queue is empty; watch for the ✅ notice.";
  }
  const unit = SERVICES[label]!;
  const since = (u: string) => sh("systemctl", ["--user", "show", u, "-p", "ActiveEnterTimestampMonotonic", "--value"]);
  const before = await since(unit);
  const r = await exec("systemctl", ["--user", "restart", unit], 60_000);
  if (!r.ok) return `❌ **${label} restart failed:** ${r.out.split("\n")[0]?.slice(0, 200)}`;
  await new Promise((res) => setTimeout(res, 3000));
  const [state, after] = [await sh("systemctl", ["--user", "is-active", unit]), await since(unit)];
  // Only claim a restart when the unit really started again (its start time moved).
  const restarted = after !== before && after !== "0";
  return `${state === "active" && restarted ? "✅" : "❌"} **${label}** ${restarted ? "restarted" : "did not restart"} · now ${state}`;
}

export async function panes(): Promise<string> {
  const raw = await sh(join(HOME, ".local/bin/herdr"), ["tab", "list"]);
  let tabs: { label: string; pane_count: number; workspace_id: string; focused: boolean }[] = [];
  try {
    tabs = JSON.parse(raw).result.tabs;
  } catch {
    return `❌ Herdr didn't answer: ${raw.split("\n")[0]?.slice(0, 200)}`;
  }
  const by = new Map<string, typeof tabs>();
  for (const t of tabs) by.set(t.workspace_id, [...(by.get(t.workspace_id) ?? []), t]);
  const lines = ["🪟 **Herdr tabs** (main)", "———————————"];
  for (const [ws, list] of by) lines.push(`**${ws}** · ${list.map((t) => `${t.focused ? "👉 " : ""}${t.label} (${t.pane_count})`).join(" · ")}`);
  lines.push("", "ℹ️ Herdr's working/idle status is unreliable for OMP panes, so it isn't shown.");
  return clip(lines.join("\n"), 1900);
}

export async function net(): Promise<string> {
  const lines = ["🌐 **Network**", "———————————"];
  try {
    const st = JSON.parse(await sh("tailscale", ["status", "--json"])) as { Peer?: Record<string, { ExitNode?: boolean; HostName?: string; DNSName?: string; Online?: boolean }>; BackendState?: string };
    const exit = Object.values(st.Peer ?? {}).find((p) => p.ExitNode);
    lines.push(`🔒 Tailscale ${st.BackendState ?? "?"} · exit node ${exit ? (exit.DNSName ?? exit.HostName ?? "?").split(".")[0] : "none"}`);
  } catch {
    lines.push("🔒 Tailscale: no status");
  }
  try {
    const ip = (await (await fetch(process.env.EGRESS_LOOKUP_URL ?? "https://ipinfo.io/json", { signal: AbortSignal.timeout(6000) })).json()) as { city?: string; country?: string; ip?: string };
    lines.push(`🌍 Egress ${ip.city ?? "?"}, ${ip.country ?? "?"}${ip.ip ? ` (${ip.ip})` : ""}`);
  } catch {
    lines.push("🌍 Egress: lookup failed");
  }
  const peer = CONFIG.mirror.peers[0];
  const targets: [string, string][] = [
    ...(peer ? [[peer.machine, peer.ssh] as [string, string]] : []),
  ];
  for (const [name, host] of targets) {
    const out = await sh("ping", ["-c", "3", "-q", "-W", "2", host], 10_000);
    const avg = out.match(/= [\d.]+\/([\d.]+)\//)?.[1];
    lines.push(`📶 ${name}: ${avg ? `${Math.round(Number(avg))} ms` : "no reply"}`);
  }
  return lines.join("\n");
}

export async function stream(): Promise<string> {
  const unit = SERVICES.streamsrv!;
  const state = await sh("systemctl", ["--user", "is-active", unit]);
  const lines = ["🎮 **Stream (stream server)**", "———————————", `${state === "active" ? "🟢" : "🔴"} stream server ${state}`];
  try {
    const g = await collectGpu();
    const listed = g.procs.reduce((s, p) => s + p.value, 0);
    const un = Math.max(0, g.memUsedMiB - listed);
    lines.push(`🎞️ VRAM ${(g.memUsedMiB / 1024).toFixed(1)} / ${(g.memTotalMiB / 1024).toFixed(1)} GiB · not owned by any process: ${(un / 1024).toFixed(1)} GiB ${un > 2048 ? "⚠️ (leak sign)" : "🟢"}`);
  } catch (e) {
    lines.push(`❌ GPU: ${(e as Error).message.split("\n")[0]}`);
  }
  const mons = await sh("hyprctl", ["monitors", "-j"]);
  try {
    for (const m of JSON.parse(mons) as { name: string; dpmsStatus: boolean }[]) lines.push(`🖥️ ${m.name} ${m.dpmsStatus ? "on" : "off (DPMS)"}`);
  } catch {}
  return lines.join("\n");
}

/**
 * Owner 2026-10-15: /remind takes free text ("in 2 hours call mom", "tomorrow 9am pay rent").
 * It creates the same transient unit + message file as omarchy-reminder, but with a wall-clock
 * OnCalendar time, so `omarchy-reminder show/clear` still list and clear it. Report failure instead of a false "set".
 * Transient timers do not survive a reboot of the main host.
 */
export async function remind(input: string): Promise<string> {
  const r = parseReminder(input);
  if (!r.ok) return `❌ **Reminder not set:** ${r.error}`;
  const minutes = Math.max(1, Math.round((r.when.getTime() - Date.now()) / 60_000));
  const unit = `omarchy-reminder-${minutes}m-${Math.floor(Date.now() / 1000)}`;
  const dir = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "omarchy-reminders");
  const file = join(dir, `${unit}.message`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, r.message);
  const notify =
    'omarchy-notification-send -g \u{f088c} "Reminder" "$1"; rm -f "$2"; omarchy-shell -q omarchy.indicators refresh >/dev/null 2>&1 || true; ' +
    // Owner 2026-10-17: also ping Discord so the phone sees it wherever the owner is.
    `${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "..", "scripts", "notify-owner.ts"))} "⏰ Reminder: $1" || true`;
  // Promise.resolve().then(): a spawn that throws synchronously (e.g. E2BIG) also lands in the error branch.
  const args = ["--user", "--quiet", "--collect", `--on-calendar=${onCalendar(r.when)}`, `--unit=${unit}`, "bash", "-c", notify, "bash", r.message, file];
  const res = await Promise.resolve()
    .then(() => run("systemd-run", args, { timeout: 20_000 }))
    .then(
    () => ({ ok: true, out: "" }),
    (e: { stderr?: string; message: string }) => ({ ok: false, out: `${e.stderr || e.message}`.trim() }),
  );
  if (!res.ok) {
    rmSync(file, { force: true });
    return `❌ **Reminder not set:** ${res.out.split("\n")[0]?.slice(0, 200)}`;
  }
  await sh("omarchy-shell", ["-q", "omarchy.indicators", "refresh"]);
  // Owner 2026-10-17: queue for the iPhone Shortcut (GET /add-queue) so iOS Reminders, and via iCloud every Apple device, get it.
  const inbox = join(homedir(), ".local/share/reminders-inbox");
  mkdirSync(inbox, { recursive: true });
  appendFileSync(join(inbox, "add-queue.txt"), `${r.message.replace(/[|\n]/g, " ").trim()} | ${r.when.toISOString()}\n`);
  const list = await sh("omarchy-reminder", ["show", "--json"]); // plain `show` prints nothing when not on a terminal
  const seen = list.includes(unit);
  const ts = Math.floor(r.when.getTime() / 1000);
  return `⏰ **Reminder set** for <t:${ts}:F> (<t:${ts}:R>): ${r.message}${seen ? "" : "\n⚠️ It did not appear in `omarchy-reminder show`."}`;
}

export async function nest(): Promise<string> {
  const out = await sh("python3", [join(HOME, ".local/share/omp-integrations/nest/nest.py"), "status"], 30_000);
  return `🌡️ **Nest**\n———————————\n${out.split("\n").map((l) => `• ${l}`).join("\n")}`;
}

export async function radio(redact: (s: string) => string = (s) => s): Promise<string> {
  const state = await sh("systemctl", ["--user", "is-active", SERVICES.radio!]);
  const log = (await sh("journalctl", ["--user", "-u", SERVICES.radio!, "-n", "6", "-o", "cat", "--no-pager"])).split("\n").map((l) => l.slice(0, 140)).join("\n");
  return `📻 **Lofi Radio** ${state === "active" ? "🟢" : "🔴"} ${state}\n${block(redact(log))}`;
}

export async function updates(): Promise<string> {
  const repo = (await sh("checkupdates", [], 90_000)).split("\n").filter((l) => /^\S+ \S+ -> \S+$/.test(l));
  const aur = (await sh("yay", ["-Qua"], 90_000)).split("\n").filter((l) => /->/.test(l));
  const lines = ["⬆️ **Updates** (list only, nothing installed)", "———————————", `📦 Repo: ${repo.length} · AUR: ${aur.length}`];
  const show = [...repo, ...aur].slice(0, 25).map((l) => `• ${l}`);
  if (show.length) lines.push(...show);
  if (repo.length + aur.length > 25) lines.push(`… and ${repo.length + aur.length - 25} more`);
  return clip(lines.join("\n"), 1900);
}

export async function second(): Promise<string> {
  const peer = CONFIG.mirror.peers[0];
  if (!peer) return "🖥️ No peer machine in config.json (mirror.peers).";
  const out = await sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", peer.ssh, "hostname; uptime -p; cat /sys/class/power_supply/*/capacity 2>/dev/null | head -1; cat /sys/class/power_supply/*/status 2>/dev/null | head -1"], 15_000);
  const [host, up, cap, status] = out.split("\n");
  if (!host?.trim() || !up?.startsWith("up")) return `🔴 **second machine unreachable** · ${out.split("\n")[0]?.slice(0, 160)}`;
  return `🖥️ **second machine** 🟢 reachable\n⏱️ ${up}\n🔋 ${cap ?? "?"}% · ${status ?? "?"}`;
}

/** Owner 2026-10-15: /blinds (TaHoma local API via tahoma.py). Buttons send open/close/stop/position. */
export const BLINDS_PREFIX = "blind:";
/** Seconds a button press takes: open/close = 3 sends ~3 s apart plus the box confirming them. */
export const blindsEta = (action: string) => (action === "open" || action === "close" ? 12 : 5);
const TAHOMA = join(HOME, ".local/share/omp-integrations/tahoma/tahoma.py");
/** Allowed button actions → tahoma.py args (target appended). Anything else is rejected. */
export function blindsArgs(action: string, target: string): string[] | null {
  if (!/^[A-Za-z0-9][\w .'-]{0,59}$/.test(target)) return null;
  if (["open", "close", "stop", "my"].includes(action)) return [action, target];
  const m = action.match(/^set(\d{1,3})$/);
  if (m && Number(m[1]) <= 100) return ["set", target, m[1]!];
  return null;
}
export async function blinds(): Promise<string> {
  const r = await exec("python3", [TAHOMA, "devices"], 30_000);
  const body = r.ok ? r.out.split("\n").map((l) => l.replace(/^- /, "• ")).join("\n") || "No blinds found." : `❌ ${r.out.split("\n").pop()?.replace(/^tahoma: /, "").slice(0, 300)}`;
  return `🪟 **Blinds**\n———————————\n${body}`;
}
export async function blindsAct(action: string, target: string): Promise<string> {
  const args = blindsArgs(action, target);
  if (!args) return "❌ Unknown blinds action.";
  // open/close are sent 3x and confirmed by the box (~12 s), plus retries for failed sends (owner 2026-10-15).
  const r = await exec("python3", [TAHOMA, ...args], 180_000);
  const line = r.out.split("\n").filter(Boolean).pop()?.replace(/^tahoma: /, "").slice(0, 400) ?? "";
  return `${!r.ok ? "❌" : line.includes("FAILED") ? "⚠️" : "✅"} ${line}`;
}
