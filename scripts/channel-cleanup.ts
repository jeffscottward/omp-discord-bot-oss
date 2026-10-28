// Idle channel/tab cleanup (owner 2026-10-18). Default is a dry run; --apply acts.
//   bun scripts/channel-cleanup.ts [--apply] [--threshold-h N] [--no-ask]
// Finished channels (final report, no open question, agent idle, nothing running): close the Herdr
// tab, then move the channel to 📦 Archive (never delete). Unsure channels: ONE batched ask block in
// #main-github-firstmate via the bot's loopback /post, at most once per channel per week.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, FIRSTMATE_CHANNEL_ID, FM_DIR, GUILD_ID, HTTP_PORT, OWNER_ID, STATE_DIR } from "../src/config.ts";
import { ARCHIVE_IDS, CATEGORY_IDS, DETACHED_CHANNEL_IDS, HOSTS, pickArchive, sh, type MirrorEntry } from "../src/mirror.ts";
import { classify, discord, dueForAsk, fetchMessages, loadToken, paneBusy, sessionEnded, trackerOpen, type Verdict } from "../src/cleanup.ts";
import { askedAgainOpen, askSetId, CLOSED_LINE, discordLink, menuQuestion, staleCards, staleMenus, type Card, type ChannelState, type MenuMsg } from "../src/cardsweep.ts";
import { ASK_TTL_MS } from "../src/ask.ts";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const noAsk = args.includes("--no-ask");
const thIdx = args.indexOf("--threshold-h");
const thresholdH = thIdx >= 0 ? Number(args[thIdx + 1]) : Number(process.env.CLEANUP_THRESHOLD_H ?? 48);
const thresholdMs = thresholdH * 3_600_000;
const ASK_STATE = join(STATE_DIR, "cleanup-asks.json");
const now = Date.now();
const log = (...a: unknown[]) => console.log(...a);
// Owner rule 2026-10-15: alert once after 3 consecutive failures, then post a recovery notice.
const FAIL_STATE = join(STATE_DIR, "cleanup-failures.json");
const alert = (text: string) =>
  fetch(`http://127.0.0.1:${HTTP_PORT}/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "omp-alerts", text }) }).catch(() => {});
const fails: { n: number; alerted: boolean } = existsSync(FAIL_STATE) ? JSON.parse(readFileSync(FAIL_STATE, "utf8")) : { n: 0, alerted: false };
process.on("unhandledRejection", async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  fails.n++;
  console.error(`channel-cleanup failed: ${msg}`);
  if (fails.n >= 3 && !fails.alerted && apply) {
    await alert(`⚠️ channel-cleanup.timer failed ${fails.n} runs in a row: ${msg}`);
    fails.alerted = true;
  }
  writeFileSync(FAIL_STATE, JSON.stringify(fails));
  process.exit(1);
});

const TRACKER = join(FM_DIR, "items.json");
const trackerItems: { s?: string }[] = existsSync(TRACKER) ? JSON.parse(readFileSync(TRACKER, "utf8")).items ?? [] : [];
const token = loadToken();
const entries: MirrorEntry[] = JSON.parse(readFileSync(join(STATE_DIR, "agents.json"), "utf8"));
const chans = (await discord(token, `/guilds/${GUILD_ID}/channels`)) as { id: string; name: string; parent_id: string | null; type: number }[];
const chanById = new Map(chans.map((c) => [c.id, c]));

type Pane = { pane_id: string; tab_id: string; agent?: string | null; agent_status?: string };
const panesByHost = new Map<string, Pane[] | null>();
for (const h of HOSTS) {
  const r = await sh(h.ssh, `${h.herdr} pane list`);
  try { panesByHost.set(h.machine, JSON.parse(r.out.toString("utf8")).result.panes); } catch { panesByHost.set(h.machine, null); }
}

async function tabBusy(e: MirrorEntry, panes: Pane[]): Promise<boolean> {
  const host = HOSTS.find((h) => h.machine === e.machine)!;
  for (const p of panes.filter((x) => x.tab_id === e.tabId)) {
    const id = p.pane_id.replace(/[^A-Za-z0-9:_-]/g, "");
    const r = await sh(host.ssh, `${host.herdr} pane process-info --pane '${id}'; printf '\\n@@\\n'; ps -eo pid=,ppid=,comm=,args=`);
    if (r.code !== 0) return true;
    const [info = "", ps = ""] = r.out.toString("utf8").split("\n@@\n");
    if (paneBusy(info, ps)) return true;
  }
  return false;
}

async function sessionTail(e: MirrorEntry): Promise<string> {
  if (!e.sessionFile) return "";
  const host = HOSTS.find((h) => h.machine === e.machine)!;
  const r = await sh(host.ssh, `tail -c 200000 ${JSON.stringify(e.sessionFile)} 2>/dev/null`);
  return r.out.toString("utf8");
}

const results: { e: MirrorEntry; v: Verdict; idleH: number; tabPanes: Pane[] }[] = [];
const seen = new Set<string>();
for (const e of entries) {
  if (e.archived || seen.has(e.channelId) || DETACHED_CHANNEL_IDS.has(e.channelId) || CONFIG.keepChannelIds.includes(e.channelId)) continue; // keep: standing channels (owner 2026-10-22)
  seen.add(e.channelId);
  const ch = chanById.get(e.channelId);
  if (!ch || (ch.parent_id !== CATEGORY_IDS.main && ch.parent_id !== CATEGORY_IDS.second)) continue; // pinned/archived/other: leave
  const panes = panesByHost.get(e.machine);
  if (!panes) { log(`skip ${ch.name}: ${e.machine} unreadable`); continue; }
  const msgs = await fetchMessages(token, e.channelId, 20).catch(() => []);
  const last = msgs.at(-1);
  const idleMs = last ? now - last.ts : now - Number(BigInt(e.channelId) >> 22n) - 1420070400000;
  const tabPanes = panes.filter((p) => p.tab_id === e.tabId);
  const pane = panes.find((p) => p.pane_id === e.paneId);
  let busy = false;
  let ended: boolean | null = null;
  const cheap = classify({ name: e.name, idleMs, thresholdMs, lastFromOwner: false, lastText: "x", agentStatus: "idle", busy: false, ended: true });
  if (cheap.kind === "finished") {
    busy = await tabBusy(e, tabPanes);
    ended = sessionEnded(await sessionTail(e));
  }
  const otherWorking = tabPanes.some((p) => p.pane_id !== e.paneId && (p.agent_status === "working" || p.agent_status === "blocked"));
  const v = classify({
    name: e.name, idleMs, thresholdMs,
    lastFromOwner: last?.authorId === OWNER_ID, lastText: [...msgs].reverse().find((m) => m.content.trim())?.content ?? "",
    agentStatus: otherWorking ? "working" : (pane?.agent_status ?? null), busy, ended,
    openTrackerItem: trackerOpen(trackerItems, e.name, e.channelId),
  });
  results.push({ e: { ...e, name: ch.name }, v, idleH: idleMs / 3_600_000, tabPanes });
}

log(`${apply ? "APPLY" : "DRY RUN"} threshold ${thresholdH} h, ${results.length} live channels`);
for (const r of results.sort((a, b) => b.idleH - a.idleH))
  log(`${r.v.kind.padEnd(9)} ${r.idleH.toFixed(1).padStart(6)} h  ${r.e.machine}  #${r.e.name}  (${r.v.reason})`);

const archived: string[] = [];
for (const r of results.filter((x) => x.v.kind === "finished")) {
  // A tab is closable only when every live channel mapped to it is finished.
  const sharing = results.filter((x) => x.e.machine === r.e.machine && (x.e.tabId === r.e.tabId || x.e.paneId === r.e.paneId));
  if (sharing.some((x) => x.v.kind !== "finished")) { log(`skip #${r.e.name}: its tab also maps to a channel that is not finished`); continue; }
  if (!apply) { log(`would archive #${r.e.name} (${r.e.channelId}) and close ${r.e.machine} tab ${r.e.tabId}`); continue; }
  const host = HOSTS.find((h) => h.machine === r.e.machine)!;
  // Re-check right before closing: state may have changed during the scan.
  const fresh = await sh(host.ssh, `${host.herdr} pane list`);
  let panes: Pane[] = [];
  try { panes = JSON.parse(fresh.out.toString("utf8")).result.panes; } catch { log(`skip #${r.e.name}: pane list unreadable`); continue; }
  const tp = panes.filter((p) => p.tab_id === r.e.tabId);
  if (!tp.length || tp.some((p) => !!p.agent && p.agent_status !== "idle") || (await tabBusy(r.e, tp))) { log(`skip #${r.e.name}: no longer idle`); continue; }
  const c = await sh(host.ssh, `${host.herdr} tab close ${JSON.stringify(r.e.tabId)}`);
  if (c.code !== 0) { log(`skip #${r.e.name}: tab close failed`); continue; }
  // Owner 2026-10-23: no move. The bot sync marks the closed pane's channel archived; scripts/purge-archive.py
  // deletes it once daily-skill-bot has processed its OMP logs (OMP logs stay as the record).
  archived.push(r.e.name);
  log(`closed ${r.e.machine} tab for #${r.e.name} (channel deleted after learners); closed ${r.e.machine} tab ${r.e.tabId}`);
}

/** POST /asks/close on the bot's loopback API; the set ids it closed (empty when the bot is unreachable). */
async function closeAsksInBot(setIds: string[]): Promise<Set<string>> {
  const port = Number(process.env.OMP_BOT_HTTP_PORT ?? 47821);
  try {
    const r = await globalThis.fetch(`http://127.0.0.1:${port}/asks/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setIds, reason: "asked-again" }), signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { closed?: string[] };
    return new Set(r.ok ? (j.closed ?? []) : []);
  } catch (e) {
    log(`asks/close failed: ${(e as Error).message}`);
    return new Set();
  }
}

// Card sweep (owner 2026-10-22): every channel sweep also sweeps the cards (src/cardsweep.ts).
// 1. Stale Discord question menus in every non-archived text channel.
const me = (await discord(token, "/users/@me")) as { id: string };
// Read-only parse (never AskStore: its constructor saves the bot's live file). Expired sets do not count as open.
const ASK_TTL = Number(process.env.CARDSWEEP_TTL_H ?? 0) > 0 ? Number(process.env.CARDSWEEP_TTL_H) * 3_600_000 : ASK_TTL_MS;
const askSets = existsSync(join(STATE_DIR, "asks.json")) ? ((JSON.parse(readFileSync(join(STATE_DIR, "asks.json"), "utf8")) as { sets?: { setId: string; createdAt: number }[] }).sets ?? []) : [];
const openSets = new Set<string>(askSets.filter((s) => now - s.createdAt < ASK_TTL).map((s) => s.setId));
let scanned = 0, menusFound = 0, fetchErrors = 0;
type RawMsg = { id: string; author: { id: string }; timestamp: string; content: string; components?: { components?: { custom_id?: string }[] }[] };
const closedMenus = new Set<string>();
for (const c of chans.filter((c) => c.type === 0 && !ARCHIVE_IDS.includes(c.parent_id ?? ""))) {
  const raw = (await discord(token, `/channels/${c.id}/messages?limit=50`).then((x) => { scanned++; return x; }, (err: Error) => { fetchErrors++; log(`menu scan #${c.name}: ${err.message}`); return []; })) as RawMsg[];
  const menus: (MenuMsg & { content: string })[] = [];
  for (const m of raw) {
    if (m.author.id !== me.id) continue;
    const setId = (m.components ?? []).flatMap((r) => r.components ?? []).map((x) => askSetId(x.custom_id ?? "")).find(Boolean);
    if (setId) menusFound++;
    if (setId) menus.push({ id: m.id, ts: Date.parse(m.timestamp), setId, question: menuQuestion(m.content), content: m.content });
  }
  for (const id of staleMenus(menus, openSets, now, ASK_TTL)) {
    const m = menus.find((x) => x.id === id)!;
    if (!apply) { log(`would close question menu ${id} in #${c.name}: ${m.question.slice(0, 60)}`); closedMenus.add(id); continue; }
    const ok = await discord(token, `/channels/${c.id}/messages/${id}`, { method: "PATCH", body: JSON.stringify({ content: `${m.content}\n${CLOSED_LINE}`.slice(0, 2000), components: [] }) })
      .then(() => true, (err: Error) => { log(`close menu ${id} failed: ${err.message}`); return false; });
    if (ok) { closedMenus.add(id); log(`closed question menu ${id} in #${c.name}: ${m.question.slice(0, 60)}`); }
  }
  // Owner 2026-10-23: sets stay open 7 days in the bot, so an open menu asked again later is closed through
  // the bot first (it forgets the set), then edited like the others. Bot unreachable: left alone.
  const again = askedAgainOpen(menus, openSets);
  if (again.length) {
    if (!apply) for (const m of again) { log(`would close open question menu ${m.id} in #${c.name} (asked again later): ${m.question.slice(0, 60)}`); closedMenus.add(m.id); }
    else {
      const setIds = [...new Set(again.map((m) => m.setId))];
      const closedSets = await closeAsksInBot(setIds);
      // The bot forgets the whole set, so every menu of it loses its buttons (not only the repeated question).
      for (const m of menus.filter((x) => closedSets.has(x.setId) && !closedMenus.has(x.id))) {
        const full = menus.find((x) => x.id === m.id)!;
        const ok = await discord(token, `/channels/${c.id}/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ content: `${full.content}\n${CLOSED_LINE}`.slice(0, 2000), components: [] }) })
          .then(() => true, (err: Error) => { log(`close menu ${m.id} failed: ${err.message}`); return false; });
        if (ok) { closedMenus.add(m.id); log(`closed open question menu ${m.id} in #${c.name} (asked again later): ${m.question.slice(0, 60)}`); }
      }
    }
  }
}
// 2. Dashboard cards linked to archived/deleted channels or to a closed question menu.
// The guild channel list has no threads: look up unknown ids (threads, other guild) before calling them gone.
const extra = new Map<string, { parent_id: string | null } | null>();
const unknownIds = new Set(
  (existsSync(TRACKER) ? (JSON.parse(readFileSync(TRACKER, "utf8")).items ?? []) as Card[] : [])
    .flatMap((c) => [discordLink(c.q)?.channel, discordLink(c.src)?.channel])
    .filter((x): x is string => !!x && !chanById.has(x)),
);
for (const id of unknownIds) {
  const ch = (await discord(token, `/channels/${id}`).catch((err: Error) => (/-> 404$/.test(err.message) ? null : undefined))) as { parent_id: string | null } | null | undefined;
  if (ch !== undefined) extra.set(id, ch); // undefined = lookup error: the card is left alone
}
const chanState = (id: string): ChannelState => {
  if (!chanById.has(id) && !extra.has(id)) return "live"; // unknown after a failed lookup: never flag
  const c = chanById.get(id) ?? extra.get(id);
  if (!c) return "gone";
  const parent = c.parent_id ? chanById.get(c.parent_id) : undefined; // a thread: judge its parent channel
  const cat = parent && !ARCHIVE_IDS.includes(c.parent_id ?? "") ? parent.parent_id : c.parent_id;
  return ARCHIVE_IDS.includes(cat ?? "") ? "archived" : "live";
};
const cards = (existsSync(TRACKER) ? JSON.parse(readFileSync(TRACKER, "utf8")).items ?? [] : []) as Card[];
const flagged = staleCards(cards, chanState, closedMenus);
for (const f of flagged) {
  const card = cards.find((c) => c.id === f.id)!;
  const note = `🧹 Card sweep: ${f.reason}; needs check.${card.n ? ` ${card.n}` : ""}`;
  if (!apply) { log(`would flag card ${f.id}: ${f.reason}`); continue; }
  const r = spawnSync("fm", ["set", f.id, "partial", note], { env: { ...process.env, FM_BY: "cardsweep" }, encoding: "utf8" });
  log(r.status === 0 ? `flagged card ${f.id}: ${f.reason}` : `flag card ${f.id} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}
const linked = cards.filter((c) => discordLink(c.q) || discordLink(c.src));
log(`CARDS channels_scanned=${scanned} fetch_errors=${fetchErrors} menus_with_buttons=${menusFound} open_sets=${openSets.size} menus_closed=${closedMenus.size} cards_linked=${linked.length} cards_live=${linked.filter((c) => [discordLink(c.q)?.channel, discordLink(c.src)?.channel].every((x) => !x || chanState(x) === "live")).length} cards_flagged=${flagged.length}`);

const askState: Record<string, number> = existsSync(ASK_STATE) ? JSON.parse(readFileSync(ASK_STATE, "utf8")) : {};
const toAsk = results.filter((x) => x.v.kind === "unsure" && dueForAsk(askState[x.e.channelId], now)).slice(0, 24);
if (toAsk.length && !noAsk) {
  const link = (id: string) => `https://discord.com/channels/${GUILD_ID}/${id}`;
  const lines = toAsk.map((r) => `- ${link(r.e.channelId)} (${r.e.machine}, quiet ${Math.round(r.idleH)} h: ${r.v.reason})`);
  const block = {
    questions: [{
      id: "idle-archive",
      question: "Which of these idle channels may I archive (and close their Herdr tabs when idle)?",
      options: [...toAsk.map((r) => r.e.name.slice(0, 90)), "None, keep all"],
      multi: true,
    }],
  };
  const text = `🧹 Idle channel cleanup: ${toAsk.length} channel(s) quiet over ${thresholdH} h, but not clearly finished.\n${lines.join("\n")}\n\n\`\`\`ask\n${JSON.stringify(block)}\n\`\`\``;
  if (apply) {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: FIRSTMATE_CHANNEL_ID, text }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (j.ok) {
      for (const x of toAsk) askState[x.e.channelId] = now;
      writeFileSync(ASK_STATE, JSON.stringify(askState, null, 2));
      log(`asked owner about ${toAsk.length} channel(s)`);
    } else log(`ask post failed: ${j.error ?? r.status}`);
  } else log(`would ask:\n${text}`);
}
log(`SUMMARY archived=${archived.length} asked=${apply && !noAsk ? toAsk.length : 0} finished=${results.filter((x) => x.v.kind === "finished").length} unsure=${results.filter((x) => x.v.kind === "unsure").length}`);
if (apply) {
  if (fails.alerted) await alert("✅ channel-cleanup.timer recovered.");
  writeFileSync(FAIL_STATE, JSON.stringify({ n: 0, alerted: false }));
}
process.exit(0);
