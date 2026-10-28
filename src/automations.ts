/**
 * Owner 2026-10-19 (Orca #6): /automations lists every systemd timer on the main host (user timers) and on the
 * remote host (system timers, read over ssh) with next run, last run and last result. Pick a timer in the menu
 * to get Run now / Pause / Resume buttons.
 * - Run now = `systemctl start --no-block <service>`; Pause = `disable --now <timer>`; Resume = `enable --now <timer>`.
 * - Finance units (example-watch*, ex-*, newsletter*, rebalance*, long-options*, and everything on the remote host) ask for a
 *   confirm before Run now and Pause.
 * - weekly-update.service is never started (it runs a real system update). OS-provided timers are read-only.
 * - Only the owner's own button presses act; every action is logged to automations-actions.jsonl.
 * Parsing and formatting are pure, so they can be tested.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

export type Host = "main" | "remote";
export const HOSTS: Host[] = ["main", "remote"];
export const PREFIX = "auto:";
const HOST_LABEL: Record<Host, string> = { main: "🖥️ main", remote: "☁️ remote host" };

export interface Timer {
  host: Host;
  timer: string;
  service: string;
  description: string;
  /** Epoch ms of the next and last trigger (list-timers). */
  next?: number;
  last?: number;
  unitFile: string;
  active: string;
  sub: string;
  svcActive: string;
  svcResult: string;
  exit?: number;
  /** ms when the last run ended (since the unit was loaded). */
  exited?: number;
  /** Shipped by the OS (unit file under /usr or /lib): read-only here. */
  os: boolean;
}

/** Collector script: list-timers JSON, then `show` for every timer unit file and for the units they start. */
export const COLLECT_SCRIPT = `S="$1"
P=Id,Description,UnitFileState,ActiveState,SubState,Result,ExecMainStatus,ExecMainExitTimestampMonotonic,ExecMainExitTimestamp,FragmentPath,Unit
systemctl $S list-timers --all --output=json
echo; echo @@@
T=$( { systemctl $S list-unit-files --type=timer --no-legend --plain | awk '$1 !~ /@\\./ {print $1}'; systemctl $S list-units --type=timer --all --no-legend --plain | awk '{print $1}'; } | sort -u)
systemctl $S show $T -p $P
echo; echo @@@
U=$(systemctl $S show $T -p Unit --value | sort -u)
systemctl $S show $U -p $P
`;

type Props = Record<string, string>;
/** `systemctl show` output: blocks of key=value lines separated by blank lines. */
export function parseShow(text: string): Props[] {
  const out: Props[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const p: Props = {};
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) p[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (p.Id) out.push(p);
  }
  return out;
}

interface ListEntry { unit?: string; activates?: string; next?: number | null; last?: number | null }
/** list-timers JSON uses microseconds; 0 or null means "none". */
const usToMs = (v?: number | null) => (v && v > 0 ? Math.floor(v / 1000) : undefined);

export function parseCollect(host: Host, out: string): Timer[] {
  const [listPart = "[]", timerPart = "", svcPart = ""] = out.split(/^@@@$/m);
  let list: ListEntry[] = [];
  try {
    list = JSON.parse(listPart.trim() || "[]") as ListEntry[];
  } catch {}
  const byUnit = new Map(list.filter((e) => e.unit).map((e) => [e.unit!, e]));
  const svcs = new Map(parseShow(svcPart).map((p) => [p.Id!, p]));
  const timers: Timer[] = [];
  for (const p of parseShow(timerPart)) {
    const id = p.Id!;
    if (!id.endsWith(".timer") || p.LoadState === "not-found") continue;
    const e = byUnit.get(id);
    const service = p.Unit || e?.activates || id.replace(/\.timer$/, ".service");
    const s = svcs.get(service) ?? {};
    const exit = s.ExecMainStatus !== undefined && s.ExecMainStatus !== "" ? Number(s.ExecMainStatus) : undefined;
    const exited = s.ExecMainExitTimestamp ? Date.parse(s.ExecMainExitTimestamp) : NaN;
    const frag = p.FragmentPath ?? "";
    timers.push({
      host,
      timer: id,
      service,
      description: p.Description ?? "",
      next: usToMs(e?.next),
      last: usToMs(e?.last),
      unitFile: p.UnitFileState ?? "",
      active: p.ActiveState ?? "",
      sub: p.SubState ?? "",
      svcActive: s.ActiveState ?? "",
      svcResult: s.Result ?? "",
      exit: Number.isFinite(exit) ? exit : undefined,
      exited: Number.isFinite(exited) && exited > 0 ? exited : undefined,
      os: /^\/(usr\/)?lib\//.test(frag),
    });
  }
  return timers.sort((a, b) => a.timer.localeCompare(b.timer));
}

/** Finance units ask for a confirm before Run now and Pause. Everything on the remote host counts as finance. */
export function isFinance(t: Pick<Timer, "host" | "timer" | "service">): boolean {
  if (t.host === "remote") return true;
  return [t.timer, t.service].some((u) => /^(example-watch|example-bot|ex-|newsletter|rebalance)/i.test(u));
}

export type Action = "run" | "pause" | "resume";
/** Why an action is blocked, or null when it is allowed. */
export function blocked(t: Timer, a: Action): string | null {
  const unitOk = /^[\w@.:-]+$/;
  if (!unitOk.test(t.timer) || !unitOk.test(t.service)) return "the unit name has unexpected characters";
  if (t.os) return "this timer comes with the OS; it is read-only here";
  if (a !== "run" && t.unitFile === "transient")
    return "this is a one-off systemd-run timer (for example a reminder); stopping it deletes it, so it cannot be paused";
  if (a === "run" && [t.timer, t.service].some((u) => /^weekly-update\./.test(u)))
    return "weekly-update.service runs a real system update; it never starts from here";
  return null;
}

/** Which systemctl verb and unit an action uses. Transient/static timers have no unit file to enable. */
export function command(t: Timer, a: Action): [string, string] | [string, string, string] {
  const hasFile = /^(enabled|disabled|linked)/.test(t.unitFile);
  if (a === "run") return ["start", "--no-block", t.service];
  if (a === "pause") return hasFile ? ["disable", "--now", t.timer] : ["stop", t.timer];
  return hasFile ? ["enable", "--now", t.timer] : ["start", t.timer];
}

export type State = "paused" | "running" | "failed" | "ok" | "none";
export function state(t: Timer): State {
  if (t.active !== "active") return "paused";
  if (t.svcActive === "active" || t.svcActive === "activating" || t.svcActive === "reloading") return "running";
  if (t.svcResult && t.svcResult !== "success") return "failed";
  if (t.exit !== undefined && t.exit !== 0) return "failed";
  if (!t.last && !t.exited) return "none";
  return "ok";
}
const ICON: Record<State, string> = { paused: "⏸️", running: "⚙️", failed: "❌", ok: "✅", none: "⚪" };
const ts = (ms: number, s: "R" | "f") => `<t:${Math.floor(ms / 1000)}:${s}>`;
const short = (t: Timer) => t.timer.replace(/\.timer$/, "");

function resultText(t: Timer): string {
  const st = state(t);
  if (st === "running") return "running now";
  if (st === "failed") return `${t.svcResult && t.svcResult !== "success" ? t.svcResult : "failed"}${t.exit ? `, exit ${t.exit}` : ""}`;
  if (st === "none") return "no run recorded";
  return t.exit === undefined ? "ok" : `ok, exit ${t.exit}`;
}

export function line(t: Timer, now = Date.now()): string {
  const st = state(t);
  const parts = [`${ICON[st]} **${short(t)}**`];
  if (st === "paused") parts.push("paused");
  else parts.push(t.next && t.next > now ? `next ${ts(t.next, "R")}` : "no next run");
  if (t.last) parts.push(`last ${ts(t.last, "R")}`);
  if (st === "failed" || st === "running") parts.push(resultText(t));
  return parts.join(" · ");
}

/** The /automations list, split into Discord-sized messages (no tables). */
export function formatList(data: { host: Host; timers: Timer[]; error?: string }[], now = Date.now()): string[] {
  const total = data.map((d) => `${HOST_LABEL[d.host]} ${d.timers.length}`).join(" · ");
  const lines = [`⏱️ **Automations** · ${total}`, "✅ last run ok · ❌ failed · ⚙️ running · ⏸️ paused · ⚪ no run recorded"];
  for (const d of data) {
    lines.push("", `**${HOST_LABEL[d.host]}**${d.host === "remote" ? " (read over ssh; actions ask first)" : ""}`);
    if (d.error) lines.push(`⚠️ Could not read timers: ${d.error.slice(0, 200)}`);
    const own = d.timers.filter((t) => !t.os);
    const os = d.timers.filter((t) => t.os);
    for (const t of own) lines.push(line(t, now));
    if (os.length) {
      const bad = os.filter((t) => state(t) === "failed").map(short);
      lines.push(`🐧 OS timers (${os.length}, read-only): ${os.map(short).join(", ")}${bad.length ? ` · ❌ failed: ${bad.join(", ")}` : ""}`);
    }
  }
  lines.push("", "👇 Pick a timer for Run now / Pause / Resume.");
  const msgs: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > 1900) {
      msgs.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) msgs.push(cur);
  return msgs;
}

export function detail(t: Timer): string {
  const st = state(t);
  const l = [`⏱️ **${short(t)}** · ${HOST_LABEL[t.host]}`];
  if (t.description) l.push(`📝 ${t.description}`);
  l.push(`▶️ Starts \`${t.service}\``);
  l.push(st === "paused" ? "🕐 Next: none (paused)" : t.next ? `🕐 Next: ${ts(t.next, "f")} (${ts(t.next, "R")})` : "🕐 Next: none");
  l.push(`🕑 Last: ${t.last ? `${ts(t.last, "f")} (${ts(t.last, "R")})` : "none recorded"} · ${ICON[st]} ${resultText(t)}`);
  l.push(`📌 Timer: ${t.unitFile || "unknown"} · ${t.active}${t.sub ? ` (${t.sub})` : ""}`);
  if (isFinance(t)) l.push("⚠️ Finance unit: Run now and Pause ask you to confirm.");
  const runBlock = blocked(t, "run");
  if (runBlock) l.push(`🚫 ${runBlock}.`);
  return l.join("\n");
}

export const hashOf = (timer: string) => createHash("sha1").update(timer).digest("hex").slice(0, 10);
const cid = (act: string, t: Pick<Timer, "host" | "timer">) => `${PREFIX}${act}:${t.host}:${hashOf(t.timer)}`;

export function detailRows(t: Timer): ActionRowBuilder<ButtonBuilder>[] {
  const paused = state(t) === "paused";
  const b = (act: string, label: string, style: ButtonStyle, disabled: boolean) =>
    new ButtonBuilder().setCustomId(cid(act, t)).setLabel(label).setStyle(style).setDisabled(disabled);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b("run", "▶️ Run now", ButtonStyle.Primary, blocked(t, "run") !== null),
      b("pause", "⏸️ Pause", ButtonStyle.Secondary, paused || blocked(t, "pause") !== null),
      b("resume", "⏯️ Resume", ButtonStyle.Success, !paused || blocked(t, "resume") !== null),
      b("refresh", "🔄 Refresh", ButtonStyle.Secondary, false),
    ),
  ];
}

export function pickRows(data: { host: Host; timers: Timer[] }[]): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const all = data.flatMap((d) => d.timers.filter((t) => !t.os));
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let n = 0; n < all.length && rows.length < 5; n += 25) {
    const chunk = all.slice(n, n + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}pick:${rows.length}`)
      .setPlaceholder(`Pick a timer (${n + 1}–${n + chunk.length} of ${all.length})`)
      .addOptions(
        chunk.map((t) => ({
          label: `${ICON[state(t)]} ${short(t)}`.slice(0, 100),
          description: `${HOST_LABEL[t.host].replace(/^\S+ /, "")} · ${resultText(t)}`.slice(0, 100),
          value: `${t.host}:${hashOf(t.timer)}`,
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  return rows;
}

/** Run argv on a host: locally (user scope) or on the remote host over ssh (system scope, key auth only). */
function onHost(host: Host, argv: string[], stdin?: string, timeout = 30_000): Promise<{ ok: boolean; out: string }> {
  const [cmd, args] =
    host === "main"
      ? [argv[0]!, argv.slice(1)]
      : ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "remote", ...argv]];
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string }>();
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: "/tmp" });
  let out = "";
  let err = "";
  const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
  p.stdout.on("data", (d: Buffer) => (out += d));
  p.stderr.on("data", (d: Buffer) => (err += d));
  p.on("error", (e) => (err += e.message));
  p.on("close", (code) => {
    clearTimeout(timer);
    resolve({ ok: code === 0, out: code === 0 ? out : (err || out).trim() || `exit ${code}` });
  });
  p.stdin.end(stdin ?? "");
  return promise;
}

export async function collect(host: Host): Promise<{ host: Host; timers: Timer[]; error?: string }> {
  const scope = host === "main" ? "--user" : "";
  const r = await onHost(host, ["bash", "-s", "--", scope], COLLECT_SCRIPT);
  // `show` exits non-zero when one unit is missing; the list is still usable if it parsed.
  const timers = parseCollect(host, r.out);
  return timers.length || r.ok ? { host, timers } : { host, timers, error: r.out.split("\n")[0] ?? "failed" };
}

export interface AutoDeps {
  ownerId: string;
  logFile: string;
  log: (s: string) => void;
}

function audit(d: AutoDeps, entry: Record<string, unknown>) {
  d.log(`automations: ${JSON.stringify(entry)}`);
  try {
    appendFileSync(d.logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (e) {
    d.log(`automations log write: ${(e as Error).message}`);
  }
}

async function find(host: Host, hash: string): Promise<Timer | null> {
  const { timers } = await collect(host);
  return timers.find((t) => hashOf(t.timer) === hash) ?? null;
}

export async function handleCommand(i: ChatInputCommandInteraction, d: AutoDeps): Promise<void> {
  if (i.user.id !== d.ownerId) return void (await i.reply({ content: "These commands are for the owner only.", flags: MessageFlags.Ephemeral }));
  await i.deferReply();
  const data = await Promise.all(HOSTS.map(collect));
  const msgs = formatList(data);
  const rows = pickRows(data);
  audit(d, { action: "list", user: i.user.id, counts: data.map((x) => `${x.host}:${x.timers.length}${x.error ? "!" : ""}`) });
  for (const [n, text] of msgs.entries()) {
    const last = n === msgs.length - 1;
    const payload = { content: text, components: last ? rows : [], allowedMentions: { parse: [] } };
    if (n === 0) await i.editReply(payload);
    else await i.followUp(payload);
  }
}

export async function handleInteraction(i: ButtonInteraction | StringSelectMenuInteraction, d: AutoDeps): Promise<void> {
  if (i.user.id !== d.ownerId) {
    audit(d, { action: "refused", user: i.user.id, id: i.customId });
    return void (await i.reply({ content: "Only the owner can use these buttons.", flags: MessageFlags.Ephemeral }));
  }
  if (i.isStringSelectMenu()) {
    const [host, hash] = (i.values[0] ?? "").split(":") as [Host, string];
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const t = HOSTS.includes(host) ? await find(host, hash) : null;
    if (!t) return void (await i.editReply({ content: "⚠️ That timer is gone. Run /automations again." }));
    return void (await i.editReply({ content: detail(t), components: detailRows(t), allowedMentions: { parse: [] } }));
  }
  const [act = "", host = "", hash = ""] = i.customId.slice(PREFIX.length).split(":");
  if (!HOSTS.includes(host as Host)) return;
  await i.deferUpdate();
  const t = await find(host as Host, hash);
  if (!t) return void (await i.editReply({ content: "⚠️ That timer is gone. Run /automations again.", components: [] }));
  if (act === "refresh" || act === "cancel") return void (await i.editReply({ content: detail(t), components: detailRows(t), allowedMentions: { parse: [] } }));
  const confirmed = act.startsWith("c");
  const action = (confirmed ? act.slice(1) : act) as Action;
  if (!["run", "pause", "resume"].includes(action)) return;
  const why = blocked(t, action);
  if (why) {
    audit(d, { action, host, timer: t.timer, ok: false, blocked: why, user: i.user.id });
    return void (await i.editReply({ content: `${detail(t)}\n\n🚫 Not done: ${why}.`, components: detailRows(t), allowedMentions: { parse: [] } }));
  }
  const argv = command(t, action);
  if (action !== "resume" && isFinance(t) && !confirmed) {
    audit(d, { action: `${action}-confirm-asked`, host, timer: t.timer, user: i.user.id });
    const yes = new ButtonBuilder().setCustomId(cid(`c${action}`, t)).setLabel(action === "run" ? "✅ Yes, run now" : "✅ Yes, pause").setStyle(ButtonStyle.Danger);
    const no = new ButtonBuilder().setCustomId(cid("cancel", t)).setLabel("Cancel").setStyle(ButtonStyle.Secondary);
    return void (await i.editReply({
      content: `${detail(t)}\n\n⚠️ **Confirm:** \`systemctl ${argv.join(" ")}\` on ${HOST_LABEL[t.host]}? This is a finance unit.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(yes, no)],
      allowedMentions: { parse: [] },
    }));
  }
  const scope = t.host === "main" ? ["--user"] : [];
  const r = await onHost(t.host, ["systemctl", ...scope, ...argv]);
  audit(d, { action, host, timer: t.timer, unit: argv[argv.length - 1], argv, ok: r.ok, out: r.out.slice(0, 300), confirmed, user: i.user.id });
  if (action === "run") await Bun.sleep(1_500);
  const after = (await find(t.host, hash)) ?? t;
  const verb = action === "run" ? `Started \`${t.service}\`` : action === "pause" ? `Paused \`${t.timer}\`` : `Resumed \`${t.timer}\``;
  const result = r.ok ? `✅ ${verb}.` : `❌ ${verb} failed: ${r.out.split("\n")[0]?.slice(0, 300)}`;
  await i.editReply({ content: `${detail(after)}\n\n${result}`, components: detailRows(after), allowedMentions: { parse: [] } });
}
