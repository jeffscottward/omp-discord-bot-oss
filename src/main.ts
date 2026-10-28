import { spawnSync } from "node:child_process";
import { channelMention, mentionable, setMentionCheck } from "./mention.ts";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  StringSelectMenuBuilder,
  DiscordAPIError,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  type Interaction,
  ApplicationCommandOptionType,
  type ApplicationCommandDataResolvable,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  MessageType,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  Partials,
  type SendableChannels,
  ThreadAutoArchiveDuration,
  ApplicationCommandType,
  ChannelSelectMenuBuilder,
  type ChannelSelectMenuInteraction,
  type MessageContextMenuCommandInteraction,
  type Channel,
  type MessageReaction,
  type PartialMessageReaction,
} from "discord.js";
import { blockFromContent } from "./blocks.ts";
import { BUSY_TEXT, buttonAllowed, FIRSTMATE_PANE, FirstmateSender, SEND_BUTTON_ID } from "./firstmate.ts";
import { isCyberRefusal, newestJsonl, resetFirstmate, resetNotice } from "./cyberreset.ts";
import type { LinkButton } from "./heeler.ts";
import { Approvals, APPROVE_PREFIX } from "./approvals.ts";
import { activeButtonRuns } from "../gate/run.ts";
import { extractAttachments } from "./attach.ts";
import { isVoice, transcribe, transcribeFile } from "./voice.ts";
import { speakable, synthesize } from "./speech.ts";
import { ASK_PREFIX, AskStore, answersText, dropRepeatedQuestions, extractAsk, isOtherOption, lateHeader, menuTotal, recoverLine, TapBatcher, type AskQuestion, type AnswerVia, type LateKind } from "./ask.ts";
import { LocalModelChat, routeMessage } from "./localmodel.ts";
import { instanceFor, LocalOmpChat, routeMessage as routeLocalOmp } from "./localomp.ts";
import { LABEL as VENICE_LABEL, veniceProfile } from "./venice.ts";
import { DEFAULT_TOOLS as UNCENSORED_TOOLS, LABEL as UNCENSORED_LABEL, uncensoredProfile } from "./firstmate-uncensored.ts";
import { DoneFollowUps, followUpText, isDoneEmoji, isOwnerDone, markOwnerDone } from "./reactdone.ts";
import { ALERT_CHANNELS, BOT_ENV_FILE, CONFIG, CONFIG_FILE, commandEnabled, DASHBOARD_BASE_URL, DEV_CHANNEL_ID, FIRSTMATE_CHANNEL_ID, FIRSTMATE_SESSION, FM_DIR, LOCAL_MODEL_CHANNEL_ID, NEEDS_YOU_CHANNEL_ID, SESSIONS_DIR, STATE_DIR, CHANNELS, GUILD_ID, IDLE_TIMEOUT_MS, MAX_CONCURRENT, OMP_BIN, OWNER_ID, RUN_TIMEOUT_MS, trusted, VOICE_CHANNEL_ID, VOICE_FALLBACK_CHANNEL_ID, VOICE_TRANSCRIPT_CHANNEL_ID, WORKING_EMOJI } from "./config.ts";
import { NeedsYouBoard, type BoardChannel, type MenuSource } from "./needsyou.ts";
import { herdrPlace, isMasterBoard, MasterQueueBoard, TITLE_MAX, parseHerdrPanes, parseHerdrTabs, queueBoxAllowed, type HerdrPane, type HerdrTab, type JobPlace, type LiveJob } from "./masterqueue.ts";
import { cancelQueuedJob } from "./cancel.ts";
import { clearPause, HELD_FILE, holdAlert, parseDuration, pauseLine, pauseTransition, readPause, restoreHeld, resumeDigest, setPause, takeHeld } from "./alertpause.ts";
import { forcedStack, GENERAL, jevJudge, routerConfig, stackPreamble } from "./router.ts";
import { StackRouter, stackRouterFiles, stackSessionKey } from "./stackroute.ts";
import { parseSpokenNumbers, spokenIntent } from "./spoken.ts";
import { VoiceChat } from "./voicechat.ts";
import { resolveChannel, startHttp, type PostResult } from "./http.ts";
import { claimsMissingMenu, earlierExtras, runAnswers } from "./earlier.ts";
import { StatusReactions } from "./reactions.ts";
import { SECRET_DROP_PATH, SecretDrops, startSecretDropServer } from "./secretdrop.ts";
import { Triage, triagePrompt, type Incident } from "./triage.ts";
import { hasSession, isolatedTag, modelArgs, sessionDir, onApprovalRequest, qwenSessionKey, refreshDiscovery, resetSession, runHeartbeat, runOmp, stopRun, type RunResult } from "./omp.ts";
import { HEARTBEAT_MS, lastActivity } from "./heartbeat.ts";
import { refreshSecretValues } from "./secrets.ts";
import { prepareCopy, prepareOutbound } from "./outbound.ts";
import { renderTables, tableLineCount } from "./tablerender.ts";
import { attachTail, buildTail, isFinanceChannel } from "./replytail.ts";
import { messageProvenance, route, threadName, timeLimitContinue, unrestrictedRoute, watchdogContinue } from "./policy.ts";
import { ASK_BLOCK_RULE, buildPrompt, setOwnerInVoiceProbe, type PromptInput } from "./preamble.ts";
import { ARCHIVE_IDS, HOSTS, Mirror, oneLine, rejectLongChannelCreate, sh, sideSessionKey, type MirrorEntry, type WaitHandler } from "./mirror.ts";
import { choicesFor, closedCard, PaneInjector, QR_MODAL_PREFIX, QR_PREFIX, redactTerminal, SB_PREFIX, SCROLLBACK_LINES, scrollbackMessages, shellQuote, waitCard, MAX_TEXT, type Choice, type InjectTarget, type PaneWait } from "./quickreply.ts";
import { redactKnownSecrets } from "./secrets.ts";
import { MAX_CONTINUES, STALL_MS, type WatchAction } from "./stall.ts";
import { JobQueue, jobPreview } from "./queue.ts";
import { loadQueueState, saveQueueState, type SavedJob } from "./queuestate.ts";
import { redact } from "./redact.ts";
import { noteIsLate, showWorking } from "./working.ts";
import { rigReport, type StatKind } from "./rigstats.ts";
import { usageReport } from "./usage.ts";
import { setRgb } from "./rgb.ts";
import { fitLines, markRestarted, pendingLine, pendingRestart, recordPendingBoard, takePendingBoards } from "./pending.ts";
import { maskedLabelText } from "./links.ts";
import { dashboardLine, stripTokens } from "./dashlink.ts";
import { ASK_CANCEL_PREFIX, ASK_DELETE_PREFIX, askRows } from "./askrows.ts";
import { FM_BIN, ITEMS_FILE, markQueued, messageIdOf, parseCards, QUEUED_BY, responseRefs } from "./queued.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { AUTO_RETRY_DELAY_MS, classifyFailure, failureText, RetryLedger, shouldAutoRetry } from "./failcause.ts";
import { backLink, excerpt, logExcerpt, HANDOFF_MENU_NAME, HANDOFF_PREFIX, handoffCard, handoffPrompt, sourceLogs } from "./handoff.ts";
import { autoCheckQuietMs, CHECK_PREFIX, childProcs, formatCheck, waitReason } from "./diagnose.ts";
import { shortcutConfigured, startShortcutServer } from "./shortcut.ts";
import * as main from "./rigcmds.ts";
import { isPlanAnswer, PHASE1, PHASE2, PHASE3, PREFIX as SESSION_PREFIX, SessionCommands, type SessionCtx } from "./sessioncmds.ts";
import * as automations from "./automations.ts";
import * as models from "./models.ts";
import { LimitWatch, TICK_MS as LIMIT_TICK_MS } from "./limitwatch.ts";
const REPO_DIR = resolve(import.meta.dir, "..");

function loadToken(): string {
  const env = readFileSync(BOT_ENV_FILE, "utf8");
  const m = env.match(/^\s*DISCORD_BOT_TOKEN\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
  if (!m) throw new Error(`DISCORD_BOT_TOKEN missing in ${BOT_ENV_FILE}`);
  return m[1]!;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Plan P1: waiting jobs are saved to disk and queued again after a restart (src/queuestate.ts). */
const savedAtStart = loadQueueState(STATE_DIR);
const queue = new JobQueue<RunResult>(MAX_CONCURRENT, { startId: savedAtStart.nextId });
/** Waiting jobs that can be rebuilt after a restart, by job id. */
const savedJobs = new Map<number, SavedJob>();
/** Saved jobs from before the restart that are not queued again yet (they stay in the file until then). */
let toRestore: SavedJob[] = savedAtStart.jobs;
function saveQueue(): void {
  const waiting = new Set(queue.status().queued.map((q) => q.id));
  for (const id of savedJobs.keys()) if (!waiting.has(id)) savedJobs.delete(id);
  saveQueueState(STATE_DIR, { nextId: queue.peekNextId(), jobs: [...toRestore, ...savedJobs.values()] });
}
/**
 * FIRSTMATE fan-out router (owner 2026-10-23, card fm-router; src/router.ts, src/stackroute.ts): owner messages
 * in the FIRSTMATE channel go to a domain stack thread (one serial queue + one OMP session per stack); stacks run
 * in parallel, at most `router.maxParallelStacks` at once (queue group "stack").
 */
const stackRouter = new StackRouter(routerConfig(CONFIG.router), {
  ...stackRouterFiles(STATE_DIR),
  itemsFile: process.env.OMP_FM_ITEMS ?? join(FM_DIR, "items.json"),
  guildId: GUILD_ID,
  judge: jevJudge({ ompBin: OMP_BIN }),
  log: (s) => log(s),
});
queue.groupLimits = { stack: stackRouter.cfg.maxParallelStacks };
/** Stack name per queue job (board rows: `→ stack: <name>`). */
const jobStacks = new Map<number, string>();
queue.onChange = () => {
  saveQueue();
  masterQueue?.onQueueChange();
  const st = queue.status();
  stackRouter.sync(st.running.map((j) => j.id), st.queued.map((j) => j.id));
  const live = new Set([...st.running, ...st.queued].map((j) => j.id));
  for (const id of jobStacks.keys()) if (!live.has(id) && !stackRouter.tracker.get(String(id))) jobStacks.delete(id);
};
stackRouter.tracker.onChange = () => {
  if (FIRSTMATE_CHANNEL_ID && queueBoards.has(FIRSTMATE_CHANNEL_ID)) void editBoard(FIRSTMATE_CHANNEL_ID, "");
};
/** Drain default: the restart waiter renews it every 10 s, so a lost waiter cannot stop the queue for long. */
const DRAIN_TTL_DEFAULT_MS = 120_000;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions, // needs-you: an owner reaction marks alerts as seen
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  // Owner 2026-10-24: a channel create rate-limited for hours fails at once instead of stalling the mirror sync.
  rest: { rejectOnRateLimit: rejectLongChannelCreate },
});

/**
 * Owner 2026-10-26 (no-unknown-channel): `<#id>` only for channels/threads the bot can see. A cache miss shows the
 * plain-text fallback now and starts one background fetch, so the next board refresh can link it if it exists.
 */
const mentionFetching = new Set<string>();
const mentionGone = new Set<string>();
setMentionCheck((id) => {
  if (!client.isReady()) return false;
  const ch = client.channels.cache.get(id);
  if (ch) return mentionable(ch); // archived thread: plain text (Discord shows "#unknown"), no refetch loop
  if (!mentionGone.has(id) && !mentionFetching.has(id)) {
    mentionFetching.add(id);
    client.channels.fetch(id).then((c) => { if (!c) mentionGone.add(id); }).catch(() => mentionGone.add(id)).finally(() => mentionFetching.delete(id));
  }
  return false;
});
client.on(Events.ChannelDelete, (c) => { mentionGone.add(c.id); });
client.on(Events.ThreadDelete, (t) => { mentionGone.add(t.id); });

const NO_PINGS = { allowedMentions: { parse: [] as never[], repliedUser: false } }; // owner 2026-10-16: replies must not ping either (Working… pinged the iPad)
/** Owner 2026-10-15: only full answers notify. Status/progress posts are Discord silent messages. */
const QUIET = { ...NO_PINGS, flags: MessageFlags.SuppressNotifications as const };
const mirror = new Mirror(client);
/**
 * Owner alert pause (src/alertpause.ts): a new #omp-alerts message is held (alerts-held.jsonl) while paused.
 * Returns the pause end when held, else null. Every #omp-alerts sender goes through this.
 */
function alertHeld(channelId: string, text: string): { until: number } | null {
  if (channelId !== DEV_CHANNEL_ID) return null;
  const p = readPause();
  if (!p) return null;
  holdAlert(text);
  log(`alert held (paused until ${new Date(p.until).toISOString()}): ${text.slice(0, 80).replace(/\n/g, " ")}`);
  return { until: p.until };
}
mirror.alert = (text) => {
  if (alertHeld(DEV_CHANNEL_ID, text)) return;
  void privateChannel(DEV_CHANNEL_ID).then(async (ch) => { await ch?.send({ content: text, allowedMentions: { parse: [] } }); }).catch(() => undefined);
};
/** Plan P12: incident triage runs in #omp-alerts threads (src/triage.ts). */
const triage = new Triage(STATE_DIR);
// /models (owner 2026-10-19): per-channel model override, saved in the state dir.
const modelOverrides = new models.ModelOverrides(join(STATE_DIR, "model-overrides.json"));
const TRIAGE_CWD = join(homedir(), "Github");

/** Only the owner's private channels: the guild (incl. threads) or a DM with the owner. */
async function privateChannel(id: string): Promise<SendableChannels | null> {
  try {
    const ch = await client.channels.fetch(id);
    if (!ch?.isSendable()) return null;
    if ("guildId" in ch && ch.guildId === GUILD_ID) return ch;
    if (ch.type === ChannelType.DM && ch.recipientId === OWNER_ID) return ch;
  } catch {}
  return null;
}

const approvals = new Approvals({
  privateChannel,
  send: async (ch, text, links) => void (await sendText(ch, text, links)),
  sendApproval: async (ch, text, id) => {
    const out = prepareOutbound(text);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${APPROVE_PREFIX}${id}`).setStyle(ButtonStyle.Success).setLabel(`Approve ${id}`),
    );
    let url: string | undefined;
    for (const [i, m] of out.messages.entries()) {
      const last = i === out.messages.length - 1;
      const sent = await ch.send({ content: m.content, components: last ? [row] : [], ...NO_PINGS });
      if (last) url = sent.url;
    }
    return url;
  },
  log,
});
onApprovalRequest((e) => approvals.onRequest(e));
const firstmate = new FirstmateSender({ log });

/**
 * Outbound: privacy filter + split. Paste blocks go out as their own messages (only the fenced
 * block) with "Send to FIRSTMATE" + "Open FIRSTMATE in HEELER". `links` go on the last message.
 */
/**
 * Owner 2026-10-15: name the spoken reply after the request instead of "reply.ogg", e.g.
 * "rename-the-audio-file.ogg". Discord needs the .ogg extension to show its audio player.
 */
function audioName(prompt: string): string {
  const stop = new Set(["a", "an", "the", "is", "are", "to", "of", "and", "or", "for", "in", "on", "it", "that", "this", "can", "you", "we", "i", "me", "my", "please", "just", "so", "be", "do", "with", "there"]);
  const words = prompt.replace(/https?:\/\/\S+/g, " ").replace(/^\[[^\]]*\]\s*/, "").toLowerCase()
    .normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !stop.has(w));
  let slug = "";
  for (const w of words) {
    if ((slug ? slug.length + 1 : 0) + w.length > 48) break;
    slug = slug ? `${slug}-${w}` : w;
    if (slug.split("-").length >= 6) break;
  }
  return `REPLY-${slug || "omp"}.ogg`;
}

/** Owner 2026-10-23 (Discord UX item 1): what a send posted, so /post can return ids and links. */
interface SendSink {
  messages: Message[];
  asks: { setId: string; questions: AskQuestion[]; menus: Message[] }[];
}

async function sendText(target: SendableChannels, text: string, links?: LinkButton[], replyTo?: Message, voiceTurn = false, audio?: string, audioFile = "omp-reply.ogg", extraFiles: { path: string; name: string }[] = [], runStartMs?: number, runId?: string, attachFrom?: string[], model?: string, noDash = false, sink?: SendSink): Promise<Message | undefined> {
  const ask = extractAsk(text);
  // Owner 2026-10-23: a broken ask block is never posted silently as raw JSON: the answer says why no menu came.
  if (ask.error) log(`ask block ignored: ${ask.error}`);
  text = ask.error ? `${ask.text}\n\n⚠️ The menu above could not be shown (${ask.error}). Reply in text.` : ask.text;
  // Owner 2026-10-18: the dashboard link opens the card the reply names, else the cards changed in this run.
  // Owner 2026-10-22: alert channels (/post) carry no dashboard link.
  const dashLine = noDash ? "" : dashboardLine(text, runStartMs, runId);
  text = stripTokens(text);
  // Sandboxed pinned models attach only from their own work dir (owner 2026-10-19), even in trusted mode.
  const att = trusted() || attachFrom ? extractAttachments(text, undefined, undefined, attachFrom) : { text, files: [] as { path: string; name: string }[], notes: [] as string[] };
  att.files.push(...extraFiles.slice(0, Math.max(0, 10 - att.files.length)));
  // Owner 2026-10-21: tables become a PNG plus a web page (src/tablerender.ts); failures keep the text.
  // Owner 2026-10-21 (menu pick): finance channels get the same PNG + page as other channels; only text with account numbers stays image-only.
  const tbl = await renderTables([att.text, ...att.notes].filter(Boolean).join("\n\n"), { log });
  // Owner 2026-10-21: model + dashboard link form one bullet list after one blank line.
  const tailBlock = buildTail(model, dashLine || undefined);
  let followup: string | undefined;
  const out = prepareOutbound(tbl.text);
  if (Object.keys(out.hits).length) log(`redacted outbound: ${JSON.stringify(out.hits)}`);
  const tail = links ?? [];
  let first: Message | undefined;
  let last: Message | undefined;
  const tablePngs = [...tbl.files];
  for (const [i, m] of out.messages.entries()) {
    const files = m.file ? [new AttachmentBuilder(Buffer.from(m.file.data, "utf8"), { name: m.file.name })] : [];
    // Each table PNG rides on the message that holds its 📊 line; leftovers go on the last message.
    const pngCount = i === out.messages.length - 1 ? tablePngs.length : tableLineCount(m.content);
    for (const f of tablePngs.splice(0, Math.min(pngCount, 10 - files.length))) files.push(new AttachmentBuilder(f.path, { name: f.name }));
    const links = i === out.messages.length - 1 ? tail : [];
    const buttons = links.map((l) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(l.label).setURL(l.url));
    if (m.paste) buttons.unshift(new ButtonBuilder().setCustomId(SEND_BUTTON_ID).setStyle(ButtonStyle.Primary).setLabel("Send to FIRSTMATE"));
    const components = buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
    if (i === out.messages.length - 1) for (const f of att.files.slice(0, Math.max(0, 10 - files.length - (audio && i === 0 ? 1 : 0)))) files.push(new AttachmentBuilder(f.path, { name: f.name }));
    const reply = i === 0 && replyTo ? { reply: { messageReference: replyTo.id, failIfNotExists: false } } : {};
    // Owner 2026-10-15: the spoken audio rides on the first message (one message, one notification).
    const withAudio = i === 0 && audio && files.length < 10;
    if (withAudio) files.push(new AttachmentBuilder(audio, { name: audioFile }));
    let content = withAudio && m.content.length <= 1997 ? `🔊 ${m.content}` : m.content;
    // Owner 2026-10-18: a dashboard link right above the audio (or at the end when there is no audio).
    const dashHere = audio ? withAudio : i === out.messages.length - 1;
    const spacer = withAudio ? "\n\u200b" : ""; // owner 2026-10-19: spacer only above the audio player
    if (dashHere) ({ content, followup } = attachTail(content, tailBlock, spacer));
    const loud = audio ? withAudio : i === 0;
    const sent = own(await target.send({ content, files, components, ...reply, ...(loud ? NO_PINGS : QUIET) }));
    sink?.messages.push(sent);
    first ??= sent;
    last = sent;
    if (followup) {
      last = own(await target.send({ content: followup, ...QUIET }));
      sink?.messages.push(last);
    }
    followup = undefined;
  }
  for (const d of tbl.tmpDirs ?? []) rmSync(d, { recursive: true, force: true });
  // In voice mode the owner is offered the choice first (see offerQuestionsInVoice).
  // Owner 2026-10-27: a question whose menu is still open is not asked again; link the open menu instead.
  if (ask.questions) {
    const d = dropRepeatedQuestions(ask.questions, asks.openSets(target.id), asks.recentlyAnswered(target.id));
    if (d.repeated.length) {
      log(`ask: dropped ${d.repeated.length} repeated question(s) in ${target.id}`);
      const link = (r: { question: string; messageId?: string }) => (r.messageId ? `[${r.question.slice(0, 80)}](<https://discord.com/channels/${GUILD_ID}/${target.id}/${r.messageId}>)` : r.question.slice(0, 80));
      const waiting = d.repeated.filter((r) => !r.answered).map(link);
      if (waiting.length) last = (await target.send({ content: `⏳ Still waiting: ${waiting.join(" · ")}`.slice(0, 1900), flags: 4 | 4096, allowedMentions: { parse: [] } }).catch(() => undefined)) ?? last;
    }
    ask.questions = d.keep.length ? d.keep : null;
  }
  if (ask.questions) {
    if (voicechat.active && voiceTurn) await offerQuestionsInVoice(target, ask.questions);
    else last = (await sendQuestions(target, ask.questions, sink, replyTo?.id)) ?? last;
  }
  void first;
  return last;
}

const asks = new AskStore(STATE_DIR);

/**
 * Voice conversation mode (src/voicechat.ts). The owner joining "🎧 OMP Voice" turns it on and
 * leaving turns it off. Spoken messages are answered in the channel or thread the owner last
 * wrote in, exactly like a voice message attachment.
 */
const voicechat = new VoiceChat({
  guildId: GUILD_ID,
  channelId: VOICE_CHANNEL_ID,
  ownerId: OWNER_ID,
  onTranscript: (text) => onVoiceTranscript(text),
  log,
});
// Each run's question style follows the live voice state at its start (owner 2026-10-18). ownerInCall
// stays true while our voice connection reconnects; /health keeps `active`.
setOwnerInVoiceProbe(() => voicechat.ownerInCall);
let lastOwnerChannelId: string | null = null;

/** Questions waiting for a spoken answer. Only one set at a time, like the button flow. */
interface VoiceAsk {
  setId: string;
  channelId: string;
  questions: AskQuestion[];
  mode: "choose" | "answering";
  qi: number;
}
let voiceAsk: VoiceAsk | null = null;

/** In voice mode the buttons are not posted until the owner asks for them. */
async function offerQuestionsInVoice(target: SendableChannels, questions: AskQuestion[]): Promise<void> {
  const set = asks.create(target.id, questions);
  voiceAsk = { setId: set.setId, channelId: target.id, questions, mode: "choose", qi: 0 };
  const n = questions.length;
  const s = n === 1 ? "" : "s";
  await target.send({ content: `❓ ${n} question${s} — say **"read them out"** or **"post them"**.`, ...QUIET });
  await say(`I have ${n} question${s}. Read them out, or post them?`);
}

function spokenQuestion(a: VoiceAsk): string {
  const q = a.questions[a.qi]!;
  const head = a.questions.length > 1 ? `Question ${a.qi + 1} of ${a.questions.length}. ` : "";
  const opts = q.options.map((o, i) => `${i + 1}. ${o}`).join(". ");
  return `${head}${q.question} ${opts}.${q.multi ? " You can say more than one number." : ""}`;
}

/**
 * A spoken utterance while questions are open. True when it answered them (or chose how to get
 * them); anything else is left alone and becomes a normal free-text message.
 */
/** Which limit stopped a run: the no-activity limit (owner 2026-10-19) or the hard cap. */
function limitText(res: { idle?: boolean }): string {
  return res.idle ? `${Math.round(IDLE_TIMEOUT_MS / 60_000)}-minute no-activity limit (no log change)` : `${Math.round(RUN_TIMEOUT_MS / 60_000)}-minute limit`;
}

/** Owner 2026-10-19: time-limit auto-continues in a row, per answer channel/thread (reset by a normal finish or Stop). */
const autoContinues = new Map<string, number>();

async function handleVoiceAsk(text: string): Promise<boolean> {
  const a = voiceAsk;
  if (!a) return false;
  const target = await privateChannel(a.channelId);
  if (!target) {
    voiceAsk = null;
    return false;
  }
  if (a.mode === "choose") {
    const intent = spokenIntent(text);
    if (intent === "post") {
      voiceAsk = null;
      await sendQuestions(target, a.questions);
      await say("Posted.");
      return true;
    }
    if (intent !== "read") {
      voiceAsk = null;
      return false;
    }
    a.mode = "answering";
    a.qi = 0;
    await say(spokenQuestion(a));
    return true;
  }
  const q = a.questions[a.qi]!;
  const picks = parseSpokenNumbers(text);
  if (!picks || picks.some((n) => n > q.options.length) || (!q.multi && picks.length > 1)) {
    voiceAsk = null;
    return false;
  }
  const r = asks.answer(AskStore.customId(a.setId, a.qi), picks.map((n) => String(n - 1)));
  if (r === "unknown") {
    voiceAsk = null;
    return false;
  }
  const note = await target.send({ content: `🎙️ **${q.question}** → ${picks.map((n) => q.options[n - 1]).join(", ")}`, ...QUIET });
  if (r === "partial") {
    a.qi++;
    await say(spokenQuestion(a));
    return true;
  }
  voiceAsk = null;
  log(`ask ${r.setId}: answered by voice; sending as the owner's next turn`);
  await handle(note, { authorId: OWNER_ID, text: answersText(r) });
  return true;
}

/** A transcribed utterance from the voice channel, handled as the owner's typed message. */
/** Pre-encoded hold clips (.ogg files you place in $STATE/hold/). */
function holdTracks(): string[] {
  try {
    const dir = join(STATE_DIR, "hold");
    return readdirSync(dir).filter((f) => f.endsWith(".ogg") && !f.includes(".tmp") && !f.includes(".part")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Speak in the call and log it to the transcript. */
async function say(text: string): Promise<void> {
  void transcriptLog(`🤖 **OMP:** ${text}`);
  await voicechat.speak(text);
}

/** Append one turn to 📝 voice-transcript (best effort). */
async function transcriptLog(line: string): Promise<void> {
  const ch = await privateChannel(VOICE_TRANSCRIPT_CHANNEL_ID).catch(() => null);
  if (ch) await ch.send({ content: line.slice(0, 1900), ...QUIET }).catch((e) => log(`transcript log: ${(e as Error).message}`));
}

async function onVoiceTranscript(text: string): Promise<void> {
  if (await handleVoiceAsk(text)) return;
  const target = (lastOwnerChannelId ? await privateChannel(lastOwnerChannelId) : null) ?? (await privateChannel(VOICE_FALLBACK_CHANNEL_ID));
  if (!target) {
    log("voice: nowhere to answer");
    return;
  }
  const member = await client.guilds.cache.get(GUILD_ID)?.members.fetch(OWNER_ID).catch(() => null);
  const note = await target.send({ content: `🎙️ from **${member?.displayName ?? "the owner"}**: *${text.replace(/[*_`]/g, "")}*`, ...QUIET });
  void transcriptLog(`🎙️ **${member?.displayName ?? "Owner"}:** ${text}`);
  // Owner pick 2026-10-13: short acknowledgement so the thinking time is not dead air.
  // Then quiet hold music until the answer is spoken (stops automatically when speech starts).
  void voicechat.speak("One moment.").then(() => voicechat.startHold(holdTracks())).catch(() => {});
  voicechat.mark("turn-to-agent", { chars: text.length, channel: target.id });
  await handle(note, { authorId: OWNER_ID, text, fromVoice: true });
}

/**
 * One message per question. Options are written out in full as a numbered list (select menus cut
 * long labels off on phones), with one short number button each. Multi-select: buttons toggle,
 * then "✅ Done". Owner-only; see src/ask.ts.
 */
const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const CANCELLED_LINE = "🚫 Cancelled by the owner.";
const CANCEL_NOTE = "🚫 question cancelled by owner";
const CANCEL_STATES = new Set(["waiting", "open", "blocked"]);

/** 🚫 Cancel (owner 2026-10-25, card ask-cancel-button): close the set, edit every menu, clear linked cards, tell the run. */
async function handleAskCancel(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can cancel a question.", flags: MessageFlags.Ephemeral });
    return;
  }
  const setId = i.customId.slice(ASK_CANCEL_PREFIX.length);
  const before = asks.openSets().find((x) => x.setId === setId);
  const c = asks.cancel(setId);
  if (!c) {
    await i.reply({ content: "This question is no longer open.", flags: MessageFlags.Ephemeral });
    return;
  }
  const del = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${ASK_DELETE_PREFIX}${setId}`).setLabel("Delete message").setEmoji("🗑️").setStyle(ButtonStyle.Secondary));
  const mark = (t: string) => `${t.slice(0, 2000 - CANCELLED_LINE.length - 2)}\n\n${CANCELLED_LINE}`;
  await i.update({ content: mark(i.message.content), components: [del] });
  // Menus of questions already answered keep their ✅ line; only the open ones are marked.
  const answered = new Set(c.questions.flatMap((q, qi) => (before?.answers[q.id]?.length ? [String(qi)] : [])));
  const open = Object.entries(c.messageIds ?? {}).filter(([qi, id]) => !answered.has(qi) && id !== i.message.id).map(([, id]) => id);
  for (const mid of open) {
    const m = await i.channel?.messages.fetch(mid).catch(() => null);
    if (m) await m.edit({ content: mark(m.content), components: [del] }).catch((e: Error) => log(`cancel edit ${mid}: ${e.message}`));
  }
  log(`ask ${setId}: cancelled by the owner`);
  needsYou?.schedule(1_000);
  void clearCancelledCards([...Object.values(c.messageIds ?? {}), ...(c.partIds ?? [])]);
  const qs = c.questions.filter((_, qi) => !answered.has(String(qi))).map((q) => `"${q.question.slice(0, 200)}"`).join("; ");
  const given = c.questions.filter((_, qi) => answered.has(String(qi))).map((q) => `- ${q.question.slice(0, 200)} → ${before!.answers[q.id]!.join(", ")}`);
  const text = [`🚫 Owner cancelled question ${qs}. It no longer applies. This is not an answer; do not ask it again unless it becomes relevant.`, ...(given.length ? ["Answers already given in the same menu set:", ...given] : [])].join("\n");
  await handle(i.message, { authorId: i.user.id, text }).catch((e) => log(`ask ${setId}: cancel note to the run failed: ${(e as Error).message}`));
}

/** Cards whose q points at a cancelled menu: q removed, state partial "🚫 question cancelled by owner". */
async function clearCancelledCards(menuIds: string[]): Promise<void> {
  try {
    const ids = new Set(menuIds);
    const { FM_AUTO: _auto, ...base } = process.env;
    const env = { ...base, FM_BY: QUEUED_BY };
    for (const card of parseCards(readFileSync(ITEMS_FILE, "utf8"))) {
      const q = messageIdOf(card.q);
      // Only cards that still wait on the owner; running/done/partial cards keep their state.
      if (!card.id || !q || !ids.has(q) || !CANCEL_STATES.has(card.s ?? "")) continue;
      try {
        // partial first (fm refuses waiting/open without q), then drop q.
        await execFileAsync(FM_BIN, ["set", card.id, "partial", CANCEL_NOTE], { env, timeout: 10_000 });
        await execFileAsync(FM_BIN, ["q", card.id, "-"], { env, timeout: 10_000 });
        log(`ask cancel: card ${card.id} → partial (q removed)`);
      } catch (e) {
        log(`ask cancel: card ${card.id} update failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  } catch (e) {
    log(`ask cancel: card update failed: ${(e as Error).message}`);
  }
}

/** 🗑️ Delete message after 🚫 Cancel: remove every menu message of the set; the asks.json record stays. */
async function handleAskDelete(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can delete this.", flags: MessageFlags.Ephemeral });
    return;
  }
  const setId = i.customId.slice(ASK_DELETE_PREFIX.length);
  const c = asks.closedSet(setId);
  if (!c?.cancelled) {
    await i.reply({ content: "Only a cancelled question can be deleted here.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferUpdate();
  const mids = new Set([...(c.partIds ?? []), ...Object.values(c.messageIds ?? {}), i.message.id]);
  for (const mid of mids) {
    const m = await i.channel?.messages.fetch(mid).catch(() => null);
    if (m) await m.delete().catch((e: Error) => log(`ask delete ${mid}: ${e.message}`));
  }
  asks.markDeleted(setId);
  log(`ask ${setId}: cancelled menu deleted (${mids.size} message(s))`);
}

/** `replyToId` (owner 2026-10-23): each menu is a reply to the owner's request, so it shows what it belongs to. */
async function sendQuestions(target: SendableChannels, questions: AskQuestion[], sink?: SendSink, replyToId?: string): Promise<Message | undefined> {
  const set = asks.create(target.id, questions, Date.now(), replyToId);
  const reply = replyToId ? { reply: { messageReference: replyToId, failIfNotExists: false } } : {};
  const rec = sink ? { setId: set.setId, questions, menus: [] as Message[] } : null;
  if (rec) sink!.asks.push(rec);
  let lastQ: Message | undefined;
  for (const [qi, q] of questions.entries()) {
    const n = questions.length > 1 ? ` **Question ${qi + 1} of ${questions.length}**\n` : " ";
    // Owner 2026-10-23: {label, description} options show the description on the next line.
    const desc = (oi: number) => (q.descriptions?.[oi] ? `\n   ↳ *${q.descriptions[oi]!.replace(/[*_`]/g, "")}*` : "");
    const list = q.options.map((o, oi) => `${NUM[oi] ?? `**${oi + 1}.**`} ${isOtherOption(o) ? "✏️ Other (type or dictate a reply)" : o}${q.recommended === oi ? " **⭐ (Recommended)**" : ""}${desc(oi)}`).join("\n");
    const hint = q.multi ? "\n*Tap all that apply, then ✅ Done. Or type or dictate a reply.*" : "\n*Tap a number (✏️ opens a text box), or type or dictate a reply.*";
    // Owner 2026-10-23: a menu that names a pending approval links to the message with its Approve button.
    const approve = approvals.pendingLinks([q.question, ...q.options, ...(q.descriptions ?? [])].join("\n"))
      .map((l) => `\n🔐 Approve button for \`${l.id}\`: ${l.url}`).join("");
    const text = `❓${n}${q.question}\n\n${list}\n${approve}${hint}`;
    // Owner 2026-10-22: never cut a question or option off. A question longer than one Discord message
    // is split; the number buttons ride on the last part.
    const parts = prepareOutbound(text).messages.map((m) => m.content).filter(Boolean);
    if (!parts.length) parts.push(text.slice(0, 1900));
    for (const [pi, content] of parts.entries()) {
      const last = pi === parts.length - 1;
      lastQ = own(await target.send({ content, ...(pi === 0 ? reply : {}), ...(last ? { components: askRows(set.setId, qi, q) } : {}), ...QUIET }));
      sink?.messages.push(lastQ);
      asks.recordPart(set.setId, lastQ.id);
    }
    if (lastQ) asks.recordMessage(set.setId, qi, lastQ.id);
    if (rec && lastQ) rec.menus[qi] = lastQ;
  }
  return lastQ;
}

/** Reply for a button/modal of an unknown (expired) set; quotes the question if the message still has it. */
function expiredReply(content: string | undefined): string {
  const lines = (content ?? "").split("\n").map((l) => l.replace(/^❓/, "").replace(/\*\*Question \d+ of \d+\*\*/, "").trim());
  const q = lines.find(Boolean);
  return q ? `This question expired or is no longer open.\n> ${q.slice(0, 300)}` : "This question expired or is no longer open.";
}

/**
 * Owner 2026-10-16: a tap on a menu the bot no longer knows (lost in a restart) goes to the agent as the
 * owner's typed answer, recovered from the message text. Falls back to the expired reply if unreadable.
 */
/**
 * Owner 2026-10-23 (Discord UX item 3): taps on the questions of one unknown set within 60 s go to the agent
 * as ONE turn, with a header that says why the menu was not open (expired, closed, or lost in a restart).
 */
const lostTaps = new TapBatcher<{ msg: Message; authorId: string; kind: LateKind; ageMs?: number }>((key, lines, items) => {
  const first = items[0]!;
  log(`ask: ${lines.length} tap(s) on ${first.kind} menu set ${key}; sending them as one owner turn`);
  void handle(first.msg, { authorId: first.authorId, text: [lateHeader(first.kind, first.ageMs), ...lines].join("\n"), menuIds: [...new Set(items.map((x) => x.msg.id))] }).catch((e) =>
    log(`lost-tap handle: ${(e as Error).message}`),
  );
});

async function useLostTap(i: ButtonInteraction | ModalSubmitInteraction, pick: number | null, typed?: string): Promise<void> {
  const line = i.message ? recoverLine(i.message.content, pick, typed) : null;
  if (!line || !i.message) {
    await i.reply({ content: expiredReply(i.message?.content), flags: MessageFlags.Ephemeral });
    return;
  }
  const shown = typed ? `✏️ *${typed.replace(/[*_`]/g, "").slice(0, 300)}*` : `**${(pick ?? 0) + 1}**`;
  if (i.isButton()) await i.update({ content: `${i.message.content}\n\n✅ ${shown}`.slice(0, 2000), components: [] });
  else {
    await i.deferUpdate();
    await i.message.edit({ content: `${i.message.content}\n\n✅ ${shown}`.slice(0, 2000), components: [] });
  }
  const m = i.customId.match(/ask:([a-z0-9]+):(\d+)/);
  const setId = m?.[1] ?? `msg-${i.message.id}`;
  const late = (m ? asks.lateKind(setId) : null) ?? { kind: "lost" as const };
  lostTaps.add(setId, menuTotal(i.message.content), m?.[2] ?? i.message.id, line, { msg: i.message, authorId: i.user.id, kind: late.kind, ageMs: late.ageMs });
}

/** 🔁 Ask again on an expired menu (owner 2026-10-23, Discord UX item 3). */
const ASK_AGAIN_PREFIX = "askagain:";

/** Edit the menus of expired sets to "⌛ Expired · 🔁 Ask again" (buttons replaced). Runs every 10 min. */
async function editExpiredMenus(): Promise<void> {
  if (!client.isReady()) return;
  for (const c of asks.unedited()) {
    const ch = await privateChannel(c.channelId);
    if (!ch || !("messages" in ch)) continue; // channel not reachable now: retry on the next pass
    for (const mid of Object.values(c.messageIds ?? {})) {
      const msg = await ch.messages.fetch(mid).catch(() => null);
      if (!msg || !msg.components.length) continue; // deleted, or answered already
      const days = Math.max(1, Math.round((Date.now() - c.createdAt) / 86_400_000));
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${ASK_AGAIN_PREFIX}${c.setId}`).setLabel("Ask again").setEmoji("🔁").setStyle(ButtonStyle.Secondary));
      await msg.edit({ content: `${msg.content}\n\n⌛ Expired (asked ${days} day${days === 1 ? "" : "s"} ago, not answered) · tap 🔁 Ask again for a fresh menu.`.slice(0, 2000), components: [row] }).catch((e: Error) => log(`expired menu ${mid}: ${e.message}`));
    }
    asks.markEdited(c.setId);
    log(`ask ${c.setId}: expired; menus edited to Ask again`);
  }
}

async function handleAskAgain(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) return void (await i.reply({ content: "Only the owner can do this.", flags: MessageFlags.Ephemeral }));
  const setId = i.customId.slice(ASK_AGAIN_PREFIX.length);
  const c = asks.closedSet(setId);
  const done = i.message.content.replace(/\n\n⌛ Expired[^\n]*$/, "");
  if (!c || !i.channel?.isSendable()) {
    await i.update({ content: `${done}\n\n⌛ Expired. This menu can no longer be asked again; reply in text.`.slice(0, 2000), components: [] });
    return;
  }
  asks.forgetClosed(setId);
  await i.update({ content: `${done}\n\n🔁 Asked again below.`.slice(0, 2000), components: [] });
  // Other menus of the same set lose their Ask again button.
  for (const mid of Object.values(c.messageIds ?? {})) {
    if (mid === i.message.id) continue;
    const m = await i.channel.messages.fetch(mid).catch(() => null);
    if (m?.components.length) await m.edit({ content: `${m.content.replace(/\n\n⌛ Expired[^\n]*$/, "")}\n\n🔁 Asked again below.`.slice(0, 2000), components: [] }).catch(() => {});
  }
  log(`ask ${setId}: asked again by the owner`);
  await sendQuestions(i.channel, c.questions, undefined, c.sourceId);
}

async function handleAskButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can answer.", flags: MessageFlags.Ephemeral });
    return;
  }
  const m = i.customId.match(/^(ask:[a-z0-9]+:\d+):(\d+|done|other)$/);
  if (!m) return;
  if (m[2] === "other") {
    const q0 = asks.question(m[1]!);
    if (!q0) {
      // Lost menu: still open the text box; the modal handler recovers the question from the message.
      const input = new TextInputBuilder().setCustomId("text").setLabel("Your answer").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
      await i.showModal(new ModalBuilder().setCustomId(`askmodal:${m[1]}`).setTitle("Your answer").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      return;
    }
    const input = new TextInputBuilder().setCustomId("text").setLabel("Your answer").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    await i.showModal(new ModalBuilder().setCustomId(`askmodal:${m[1]}`).setTitle(q0.question.slice(0, 45)).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    return;
  }
  const qid = m[1]!;
  const pick = m[2]!;
  const [, setId = "", qiStr = "0"] = qid.split(":");
  const q = asks.question(qid);
  if (!q) {
    if (pick === "done") await i.reply({ content: expiredReply(i.message?.content), flags: MessageFlags.Ephemeral });
    else await useLostTap(i, Number(pick));
    return;
  }
  let values: number[];
  if (q.multi) {
    const sel = asks.picks(qid);
    if (pick !== "done") {
      const oi = Number(pick);
      sel.has(oi) ? sel.delete(oi) : sel.add(oi);
      asks.setPicks(qid, sel);
      await i.update({ components: askRows(setId, Number(qiStr), q, sel) });
      return;
    }
    if (!sel.size) {
      await i.reply({ content: "Pick at least one number first.", flags: MessageFlags.Ephemeral });
      return;
    }
    values = [...sel];
  } else values = [Number(pick)];
  const r = asks.answer(qid, values.map(String));
  if (r === "unknown") {
    await useLostTap(i, values.length === 1 ? values[0]! : null);
    return;
  }
  await i.update({ content: (`${i.message.content}\n\n✅ **${values.map((v) => v + 1).join(", ")}**`), components: [] });
  if (r === "partial") {
    void markQueued(responseRefs([i.message.id], []), { log }); // 📨 this question's card; the run waits for the rest
    return;
  }
  log(`ask ${r.setId}: all answered; sending as the owner's next turn`);
  await handle(i.message, { authorId: i.user.id, text: answersText(r), menuIds: Object.values(r.messageIds ?? {}) });
}

async function handleAskModal(i: ModalSubmitInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return;
  const qid = i.customId.slice("askmodal:".length);
  const text = i.fields.getTextInputValue("text");
  const q = asks.question(qid);
  // Multi-select: keep any numbers already ticked, add the typed answer.
  const ticked = q?.multi ? [...asks.picks(qid)].map(String) : [];
  const r = asks.answer(qid, ticked, Date.now(), text);
  if (r === "unknown" || !i.message) {
    await useLostTap(i, null, text);
    return;
  }
  await i.deferUpdate();
  await i.message.edit({ content: `${i.message.content}\n\n✅ ✏️ *${text.replace(/[*_`]/g, "").slice(0, 300)}*`, components: [] });
  if (r === "partial") {
    void markQueued(responseRefs([i.message.id], []), { log });
    return;
  }
  log(`ask ${r.setId}: all answered (with Other); sending as the owner's next turn`);
  await handle(i.message, { authorId: i.user.id, text: answersText(r), menuIds: Object.values(r.messageIds ?? {}) });
}

/** Discord CDN attachment of a long paste block (bridge's own message). */
async function attachmentText(url: string): Promise<string | null> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(u.hostname)) return null;
  const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const t = await r.text();
  return t.length <= 60_000 ? t : null;
}

/** "Send to FIRSTMATE": owner only; delivered only when FIRSTMATE is idle and its input box is empty. */
async function handleSendButton(i: ButtonInteraction): Promise<void> {
  const ok = buttonAllowed({
    userId: i.user.id,
    ownerId: OWNER_ID,
    guildId: i.guildId,
    ownGuildId: GUILD_ID,
    isDM: !i.inGuild(),
    messageAuthorId: i.message.author.id,
    botId: client.user?.id,
  });
  if (!ok) {
    log(`firstmate-send: refused button from ${i.user.id} (not owner or not a bridge message)`);
    await i.reply({ content: "Only the owner can use this button.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const first = firstmate.check();
  if (!first.ok) {
    log(`firstmate-send: msg=${i.message.id} refused (${first.reason})`);
    await i.editReply(`${BUSY_TEXT}\n-# ${first.reason}`);
    return;
  }
  const file = i.message.attachments.find((a) => /^paste-\d+\.txt$/.test(a.name));
  const block = file ? await attachmentText(file.url).catch(() => null) : blockFromContent(i.message.content);
  if (block === null) {
    await i.editReply("Could not read the block from this message. Nothing was sent.");
    return;
  }
  const r = firstmate.deliver(block, i.message.id); // re-checks idle + empty input right before sending
  await i.editReply(r.ok ? `✅ Sent to FIRSTMATE (\`${r.id}\`).` : `${BUSY_TEXT}\n-# ${r.reason}`);
}

/** Run herdr on a pane's host (main: local; second machine: over SSH). Arguments are shell-quoted. */
async function herdrOn(t: InjectTarget, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  const host = HOSTS.find((h) => h.machine === t.machine);
  if (!host) return { code: 1, out: "" };
  const r = await sh(host.ssh, `${host.herdr} ${args.map(shellQuote).join(" ")}`, timeoutMs);
  return { code: r.code, out: r.out.toString("utf8") };
}

/** Orca #2 (owner 2026-10-19): guarded quick replies into a waiting mirrored pane (src/quickreply.ts). */
const injector = new PaneInjector({ herdr: herdrOn, readTail: (t) => mirror.readTail(t), log });

/** Wait card buttons: up to 5 per row. */
function waitRows(w: PaneWait): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = choicesFor(w).map((c) =>
    new ButtonBuilder()
      .setCustomId(`${QR_PREFIX}${w.nonce}:${c.id}`)
      .setLabel(c.label)
      .setStyle(c.id === "r" ? ButtonStyle.Secondary : ButtonStyle.Primary),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let n = 0; n < buttons.length; n += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(n, n + 5)));
  return rows;
}

/** Mirror hook: post a silent wait card, or close one (buttons removed, note added). */
const onWait: WaitHandler = async (e, w, action) => {
  const ch = await mirror.channel(e.channelId);
  if (!ch) return undefined;
  if ("open" in action) {
    const content = prepareOutbound(waitCard(e.tab, w)).messages[0]?.content.slice(0, 2000) ?? "";
    const sent = own(await ch.send({ content, components: waitRows(w), ...QUIET }));
    log(`quick-reply: ${w.kind} card for ${e.machine}:${e.paneId} (${sent.id})`);
    return sent.id;
  }
  if (!w.msgId || !("messages" in ch)) return undefined;
  const old = await ch.messages.fetch(w.msgId).catch(() => null);
  if (old) await old.edit({ content: closedCard(old.content, action.close), components: [], ...NO_PINGS });
  return undefined;
};

function quickReplyAllowed(i: ButtonInteraction | ModalSubmitInteraction): boolean {
  return buttonAllowed({
    userId: i.user.id,
    ownerId: OWNER_ID,
    guildId: i.guildId,
    ownGuildId: GUILD_ID,
    isDM: !i.inGuild(),
    messageAuthorId: i.message?.author.id ?? "",
    botId: client.user?.id,
  });
}

/** The open wait of the card's channel, when the press belongs to it. */
function openWait(i: ButtonInteraction | ModalSubmitInteraction, nonce: string): { e: MirrorEntry; w: PaneWait } | null {
  const e = mirror.byChannel(i.channelId ?? "");
  const w = e?.wait;
  if (!e || e.archived || !w || w.nonce !== nonce || w.msgId !== i.message?.id) return null;
  return { e, w };
}

async function handleQuickReply(i: ButtonInteraction): Promise<void> {
  if (!quickReplyAllowed(i)) {
    log(`quick-reply: refused button from ${i.user.id} (not owner or not a bridge message)`);
    await i.reply({ content: "Only the owner can answer.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [nonce = "", cid = ""] = i.customId.slice(QR_PREFIX.length).split(":");
  const open = openWait(i, nonce);
  const choice = open ? choicesFor(open.w).find((c) => c.id === cid) : undefined;
  if (!open || !choice) {
    log(`quick-reply: refused ${i.customId} in ${i.channelId} (card is not the pane's open wait)`);
    await i.reply({ content: "This question is no longer open.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (choice.id === "r") {
    const label = open.w.kind === "ask" ? "Your answer (one line)" : "Your reply";
    const input = new TextInputBuilder().setCustomId("text").setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(MAX_TEXT);
    const title = (open.w.ask?.question ?? `Reply to ${open.e.tab}`).slice(0, 45);
    await i.showModal(new ModalBuilder().setCustomId(`${QR_MODAL_PREFIX}${nonce}`).setTitle(title).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    return;
  }
  await i.deferUpdate();
  await sendQuickReply(i, open.e, open.w, choice);
}

async function handleQuickReplyModal(i: ModalSubmitInteraction): Promise<void> {
  if (!quickReplyAllowed(i)) {
    log(`quick-reply: refused modal from ${i.user.id}`);
    await i.reply({ content: "Only the owner can answer.", flags: MessageFlags.Ephemeral });
    return;
  }
  const open = openWait(i, i.customId.slice(QR_MODAL_PREFIX.length));
  const choice = open ? choicesFor(open.w).find((c) => c.id === "r") : undefined;
  if (!open || !choice) {
    log(`quick-reply: refused ${i.customId} in ${i.channelId} (card is not the pane's open wait)`);
    await i.reply({ content: "This question is no longer open. Nothing was sent.", flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferUpdate();
  await sendQuickReply(i, open.e, open.w, choice, i.fields.getTextInputValue("text"));
}

/** Inject, then show the result: the card says what was sent; a refusal is a private note. */
async function sendQuickReply(i: ButtonInteraction | ModalSubmitInteraction, e: MirrorEntry, w: PaneWait, choice: Choice, typed?: string): Promise<void> {
  w.sending = true;
  const r = await injector.inject(e, w, choice, typed).finally(() => (w.sending = false));
  if (!r.ok) {
    await i.followUp({ content: `⚠️ Not sent: ${r.reason}.`, flags: MessageFlags.Ephemeral, ...NO_PINGS });
    return;
  }
  if (e.wait?.nonce === w.nonce) {
    e.wait = undefined;
    mirror.save();
  }
  const shown = redactKnownSecrets(redact(r.sent).text).text.replace(/[`*_~|<>@]/g, "").slice(0, 300);
  const note = `✅ You sent “${shown}” <t:${Math.floor(Date.now() / 1000)}:t>${r.confirmed ? "" : " · the pane did not confirm it yet"}`;
  await i.message?.edit({ content: closedCard(i.message.content, note), components: [], ...NO_PINGS });
}

/** Orca #4: the pane's last 40 lines, private to the owner, redacted and code-fenced. */
async function handleScrollback(i: ButtonInteraction): Promise<void> {
  if (!quickReplyAllowed(i)) {
    await i.reply({ content: "Only the owner can use this button.", flags: MessageFlags.Ephemeral });
    return;
  }
  const e = mirror.byChannel(i.channelId);
  if (!e || i.customId !== `${SB_PREFIX}${e.channelId}`) {
    await i.reply({ content: "This channel no longer mirrors a pane.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (e.archived) {
    await i.reply({ content: `The pane for **${e.tab}** is closed.`, flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await herdrOn(e, ["agent", "read", e.paneId, "--source", "recent", "--lines", String(SCROLLBACK_LINES)]);
  if (r.code !== 0) {
    await i.editReply(`Could not read the pane for **${e.tab}** (${e.machine} may be offline).`);
    return;
  }
  const msgs = scrollbackMessages(`📜 **${e.tab}** · last ${SCROLLBACK_LINES} lines`, r.out, (s) => redactKnownSecrets(redactTerminal(redact(s).text)).text);
  log(`scrollback: ${e.machine}:${e.paneId} for the owner (${msgs.length} message(s))`);
  await i.editReply({ content: msgs[0]!, ...NO_PINGS });
  for (const m of msgs.slice(1)) await i.followUp({ content: m, flags: MessageFlags.Ephemeral, ...NO_PINGS });
}

async function setReaction(msg: Message, emoji: string, on: boolean): Promise<void> {
  try {
    if (on) await msg.react(emoji);
    // Custom emojis are cached by id; unicode ones may be cached with or without U+FE0F.
    // Remove our own reaction over REST (the message cache can be stale). Custom emoji -> "name:id".
    else {
      const custom = emoji.match(/^<a?:(\w+):(\d+)>$/);
      const key = custom ? `${custom[1]}:${custom[2]}` : encodeURIComponent(emoji);
      await client.rest.delete(`/channels/${msg.channelId}/messages/${msg.id}/reactions/${key}/@me`);
    }
  } catch (e) {
    log(`reaction ${emoji} failed: ${(e as Error).message}`);
  }
}

function fmtAge(since: number): string {
  const s = Math.round((Date.now() - since) / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function statusText(): string {
  const st = queue.status();
  const lines = [`**omp bridge** — running ${st.running.length}/${st.max}, queued ${st.queued.length}${queue.draining() ? " (restart pending: new jobs wait)" : ""}`];
  for (const j of st.running) lines.push(`▶️ #${j.id} ${j.label} — ${fmtAge(j.since)} (${j.key.startsWith("dm-") ? "DM" : channelMention(j.key, "a closed channel")})`);
  for (const j of st.queued) lines.push(`⏸️ #${j.id} ${j.label} — waiting ${fmtAge(j.since)}`);
  return lines.join("\n");
}

/**
 * Discord → mirrored pane. Nothing is typed into the pane. If no omp process holds the pane's
 * session, the turn continues that session file in the sandbox (`omp -p --resume`). Otherwise it
 * runs in the linked side session, with a read-only excerpt of the pane's transcript as context.
 */
async function runMirrored(
  channelId: string,
  threadId: string | null,
  target: SendableChannels,
  p: Omit<PromptInput, "followUp" | "context">,
  paneOnly = false,
  runId?: string,
  model?: string,
): Promise<RunResult> {
  const d = await mirror.decide(channelId, threadId);
  if (!d) throw new Error("this channel is no longer mirrored");
  // P5 automatic continue: only the pane's own session, never a side session; never while a live omp holds it.
  if (paneOnly && d.mode !== "pane") throw new NotContinued(d.reason);
  // Owner 2026-10-19: Qwen never writes into the pane's own (Claude) session; it gets its own side session.
  if (isolatedTag(model)) {
    const key = qwenSessionKey(sideSessionKey(d.entry, threadId), model);
    log(`mirror: ${isolatedTag(model)} side session ${key} for ${d.entry.machine}:${d.entry.paneId}`);
    const prompt = buildPrompt({ ...p, where: `${p.where} (Qwen side session)`, followUp: hasSession(key), approvals: approvals.takeResults(key) });
    return runOmp(key, d.cwd, prompt, { channelId: target.id, runId, model });
  }
  if (d.mode === "pane") {
    log(`mirror: continuing pane session ${d.entry.machine}:${d.entry.paneId} (no live omp)`);
    mirror.busy.add(d.entry.channelId);
    try {
      return await runOmp(
        d.key,
        d.cwd,
        buildPrompt({ ...p, where: `${p.where} (continuing the pane's own session)`, followUp: true, approvals: approvals.takeResults(d.key) }),
        { channelId: target.id, resumeFile: d.sessionFile, runId, model },
      );
    } finally {
      await mirror.markConsumed(d.entry);
      mirror.busy.delete(d.entry.channelId);
    }
  }
  log(`mirror: side session ${d.key} for ${d.entry.machine}:${d.entry.paneId} (${d.reason})`);
  const context = d.context ? { title: `pane "${d.entry.tab}" session (${d.entry.machine})`, text: d.context } : undefined;
  const prompt = buildPrompt({ ...p, where: `${p.where} (side session)`, followUp: hasSession(d.key), context, approvals: approvals.takeResults(d.key) });
  return runOmp(d.key, d.cwd, prompt, { channelId: target.id, runId, model });
}

/**
 * `asOwner`: the owner's answer picked from an ask menu (the interaction user was already checked
 * against OWNER_ID); `msg` is then the bridge's own question message, used only for routing.
 */
/**
 * One live "queue board" per channel (owner request 2026-10-13): the first Queued notice is kept,
 * and later queue/start/finish events are appended to it instead of posting a new stack.
 */
/** One standalone, silent queue message per channel. */
const queueBoards = new Map<string, { msg: Message; text: string; recent: string[] }>();

/** 🔙 Undo (was ↩️; owner 2026-10-22: the ↩️ button emoji did not show on the phone, U+21A9 needs FE0F) after Stop (owner request 2026-10-14): a new run in the same session that reverts the stopped turn. */
const UNDO_PREFIX = "undo:";
const undoJobs = new Map<string, { msg: Message; startedAt: number; text: string }>();

async function handleUndoButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can undo.", flags: MessageFlags.Ephemeral });
    return;
  }
  const u = undoJobs.get(i.customId.slice(UNDO_PREFIX.length));
  if (!u) {
    await i.update({ components: [] }).catch(() => {});
    await i.followUp({ content: "Nothing to undo for this one any more (the bot restarted).", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  undoJobs.delete(i.customId.slice(UNDO_PREFIX.length));
  await i.update({ content: "🛑 Stopped. 🔙 Undo requested.", components: [] });
  const since = new Date(u.startedAt).toISOString();
  const quoted = u.text.replace(/\s+/g, " ").slice(0, 300);
  await handle(u.msg, {
    authorId: i.user.id,
    text: [
      `[Undo button] The owner stopped your previous turn (started ${since}, request: "${quoted}") and wants everything it changed reverted.`,
      "Restore files, git state (uncommitted edits and any commits made in that turn; never force-push), configs and services to how they were before that turn started.",
      "Do not redo the original request. Leave changes from earlier turns alone. If something cannot be undone (sent messages, orders, external effects), say exactly what. Then report briefly what you reverted.",
    ].join(" "),
  });
}

/** 🗑️ Remove after Stop (owner request 2026-10-21): red "Remove" → green "Confirm?" → deletes the 🛑 Stopped reply and
 * the stopped request message. Stateless (the request is the reply's reference), so it also works after a bot restart. */
const DUMP_PREFIX = "dump:";
const DUMP_OK_PREFIX = "dumpok:";
const DUMP_NO_PREFIX = "dumpno:";
function stoppedRow(id: string | number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${UNDO_PREFIX}${id}`).setLabel("Undo its changes").setEmoji("🔙").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${DUMP_PREFIX}${id}`).setLabel("Remove").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
  );
}

async function handleDumpButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can remove this.", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = i.customId.slice(i.customId.indexOf(":") + 1);
  if (i.customId.startsWith(DUMP_NO_PREFIX)) {
    await i.update({ components: [stoppedRow(id)] });
    return;
  }
  if (i.customId.startsWith(DUMP_PREFIX)) {
    const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DUMP_OK_PREFIX}${id}`).setLabel("Confirm remove?").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DUMP_NO_PREFIX}${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    await i.update({ components: [confirm] });
    return;
  }
  // Confirmed: delete the stopped request (the message this reply points to) and the 🛑 Stopped reply.
  await i.deferUpdate().catch(() => {});
  undoJobs.delete(id);
  const refId = i.message.reference?.messageId;
  if (refId && i.channel) await i.channel.messages.delete(refId).catch((e: Error) => log(`dump: request delete failed: ${e.message}`));
  await i.message.delete().catch((e: Error) => log(`dump: stopped-reply delete failed: ${e.message}`));
}

/** ❌ Stop / cancel (owner request 2026-10-13). */
const STOP_PREFIX = "stop:";
const workingMsgs = new Map<number, Message>();
const finishedJobs = new Set<number>();
/** Owner 2026-10-15: every 10 s the Working message shows a real liveness check (src/heartbeat.ts). */
const heartbeatTimers = new Map<number, NodeJS.Timeout>();
const jobKeys = new Map<number, string>();
/** Owner 2026-10-15: board rows link to the job's message (jump link), so no manual scrolling. */
const jobLinks = new Map<number, string>();
/** 📋 Master queue: each owner job's own message (its row links there, also after the job ended). */
const jobOwnerLinks = new Map<number, string>();
const boardItem = (id: number, text: string) => {
  const url = jobLinks.get(id);
  const t = maskedLabelText(text);
  const stack = jobStacks.get(id);
  // Owner 2026-10-24: same format as the 📋 Master queue: one short title line, the place on an indented second line.
  const short = t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
  const thread = stack ? stackRouter.tracker.threads[stack] : undefined;
  const where = stack ? channelMention(thread, `${stack} stack`) : "";
  return `${url ? `[${short}](<${url}>)` : short}${where ? `\n\u2003\u2003↳ ${where}` : ""}`;
};
/** Owner 2026-10-15: queue position as a number emoji on each waiting message (1️⃣ 2️⃣ 3️⃣ …). */
/** Owner 2026-10-15: animated spinning ⚙️ (Twemoji artwork, app emoji from scripts/make-spin-gear.ts) while a job runs. */
const WORKING = WORKING_EMOJI;
const queuedNotes = new Map<number, Message>();
const queuedMsgs = new Map<number, { msg: Message }>();
/**
 * Owner 2026-10-23 (Discord UX item 9): one status reaction per message (⏳ → ⚙️ → ✅/❌), settled for 1.5 s so
 * a job that starts at once never shows ⏳. Queue-number badges are gone: the queue board shows positions.
 */
const statusReact = new StatusReactions<Message>(setReaction, 1_500, new Set(["✅", "❌"]));
/** A queued job that left the queue without starting (cancelled) loses its ⏳. */
function syncBadges(): void {
  const st = queue.status();
  const live = new Set([...st.queued, ...st.running].map((q) => q.id));
  for (const [id, q] of queuedMsgs) {
    if (live.has(id)) continue;
    queuedMsgs.delete(id);
    void statusReact.set(q.msg, null); // started jobs leave queuedMsgs in onStart, so this is a cancel
  }
}
/** Cancel a queued job: forget its per-job state and redraw its channel's ⏳ Queue board (src/cancel.ts). */
function cancelQueued(id: number): boolean {
  return cancelQueuedJob(id, {
    cancel: (x) => queue.cancel(x),
    jobKeys,
    maps: [jobLinks, jobOwnerLinks, queuedNotes],
    cleanup: (x) => {
      syncBadges();
      closeTransientThread(x);
    },
    redraw: (ch) => void editBoard(ch, ""),
  });
}
const cancelRow = (id: number) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${STOP_PREFIX}${id}`).setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

async function handleRetryButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "Only the owner can retry.", flags: MessageFlags.Ephemeral }));
  const id = i.customId.slice(`${SESSION_PREFIX}retry:`.length);
  const job = retryJobs.get(id);
  // UX item 7: the button sits on the failure message; keep its cause line and output, drop only the button.
  if (!job) {
    await i.update({ components: [] }).catch(() => {});
    return void (await i.followUp({ content: "This retry is no longer available (it already ran, or the bot restarted). Send the message again if needed.", flags: MessageFlags.Ephemeral }).catch(() => {}));
  }
  retryJobs.delete(id);
  await i.update({ content: `${i.message.content}\n-# 🔁 Retrying…`.slice(0, 2000), components: [] });
  await handle(job.msg, { authorId: OWNER_ID, text: job.text, attachments: job.attachments, restored: true });
}

async function handleStopButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID || i.message.author.id !== client.user?.id) {
    await i.reply({ content: "Only the owner can stop a job.", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = Number(i.customId.slice(STOP_PREFIX.length));
  if (cancelQueued(id)) {
    await i.update({ content: "🛑 Cancelled before it started.", components: [] });
    return;
  }
  const key = jobKeys.get(id);
  if (key && stopRun(key)) {
    await i.update({ content: "🛑 Stopping…", components: [] });
    return;
  }
  await i.update({ components: [] }).catch(() => {});
  await i.followUp({ content: "That job already finished.", flags: MessageFlags.Ephemeral }).catch(() => {});
}

/**
 * Queue board (owner 2026-10-15): its own SILENT message (no notification), always the last message in the
 * channel while a queue exists. Reprinted below every new message (debounced), updated by edits.
 * Number buttons at the bottom cancel the matching waiting job, so no per-message "Queued." notes.
 */
const BOARD_RULE = "━━━━━━━━━━━━━━━━━━━━";
const SILENT = { flags: MessageFlags.SuppressNotifications as const };
function waitingFor(channelId: string) {
  return queue.status().queued.filter((q) => jobKeys.get(q.id) === channelId);
}
function renderBoard(channelId: string, recent: string[]): string {
  const st = queue.status();
  const mine = (id: number) => jobKeys.get(id) === channelId;
  const running = st.running.filter((r) => mine(r.id)).map((r) => `${WORKING} ${boardItem(r.id, r.preview ?? r.label)}`);
  const all = waitingFor(channelId).map((q, n) => `${n + 1}. ${boardItem(q.id, q.preview ?? q.label)}`);
  // Cut waiting rows (not the Restart pending / Finished lines) when the board would be too long.
  const budget = 1300;
  const waiting: string[] = [];
  let used = 0;
  for (const [n, l] of all.entries()) {
    if (used + l.length + 1 > budget) {
      waiting.push(`… ${all.length - n} more`);
      break;
    }
    waiting.push(l);
    used += l.length + 1;
  }
  const lines = [BOARD_RULE, "⏳ **Queue**", "———————————", ...running, ...waiting];
  // FIRSTMATE router: the stacks' jobs run in their own threads; list them here too.
  if (channelId === FIRSTMATE_CHANNEL_ID) {
    const stackLines = stackRouter.tracker.boardLines((j) => (j.link ? `[${maskedLabelText(j.preview)}](${j.link})` : maskedLabelText(j.preview)));
    if (stackLines.length) lines.push("\u200b", ...stackLines);
  }
  if (!running.length && !waiting.length) lines.push("*No messages waiting. (Herdr sessions may still be working.)*");
  // Other channels' jobs also hold the restart; name them (labels start with "#channel").
  const elsewhere = [...st.running, ...st.queued].filter((r) => !mine(r.id)).map((r) => r.label.match(/^#[\w-]+/)?.[0] ?? "another channel");
  const pending = pendingLine(pendingRestart(), elsewhere, queue.draining(), holdingJobs(channelId));
  if (pending) lines.push("\u200b", pending);
  if (recent.length) lines.push("\u200b", "🏁 **Finished**", "———————————", ...recent.slice(-5));
  return fitLines(lines);
}

/** UX item 6: while draining, the running jobs that hold the restart (linked to their Working… message). */
function holdingJobs(channelId: string): string[] {
  if (!queue.draining()) return [];
  // Only this channel's own jobs show their preview and link; other channels show just their #name.
  return queue.status().running.map((r) => `${jobKeys.get(r.id) === channelId ? boardItem(r.id, r.preview ?? r.label) : (r.label.match(/^#[\w-]+/)?.[0] ?? "another channel")} (running ${fmtAge(r.since)})`);
}

/** 🩺 Check (UX item 5): button on Working… and on the queue board; also posted by itself (quiet run, no start). */
const checkButton = (channelId: string) => new ButtonBuilder().setCustomId(`${CHECK_PREFIX}${channelId}`).setLabel("Check").setEmoji("🩺").setStyle(ButtonStyle.Secondary);
const checkRow = (channelId: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(checkButton(channelId));
/** Check reports per job, deleted when the job ends well (they only matter while it runs). */
const checkMsgs = new Map<number, Message[]>();
const autoChecked = new Set<number>();
/** Last "no Working… within 60 s" report per channel (at most one per 5 min). */
const noStartChecked = new Map<string, number>();

function buildCheck(channelId: string, reason: "button" | "quiet" | "no-start"): string {
  const now = Date.now();
  const st = queue.status();
  const run = st.running.find((r) => jobKeys.get(r.id) === channelId);
  const hb = run ? runHeartbeat(channelId) : undefined;
  const view = hb ? (hb.lastView && now - hb.lastView.now < 20_000 ? hb.lastView : hb.pid ? hb.sample(now) : null) : null;
  const holding = holdingJobs(channelId);
  const waiting = waitingFor(channelId);
  const p = pendingRestart();
  return formatCheck({
    now,
    reason,
    job: run ? { id: run.id, startedAt: run.since, preview: run.preview ?? run.label } : null,
    pid: hb?.pid ?? 0,
    view,
    children: hb ? childProcs(view, hb.pid) : [],
    recent: hb?.recent ?? [],
    sessionFile: hb?.sessionFile,
    idleLimitMs: IDLE_TIMEOUT_MS,
    restart: { pending: Boolean(p), updates: p?.updates ?? 0, draining: queue.draining(), holding },
    queue: {
      waitingHere: waiting.map((q) => q.preview ?? q.label),
      runningAll: st.running.length,
      queuedAll: st.queued.length,
      max: st.max,
      waitReason: waiting.length
        ? (waitReason({ draining: queue.draining(), sameChannelRunning: Boolean(run), running: st.running.length, max: st.max, holding, runningLabels: st.running.map((r) => r.label.match(/^#[\w-]+/)?.[0] ?? "another channel") }) ?? undefined)
        : undefined,
    },
  });
}

/** Post a check report in the channel (silent); remembered under the running job so a good finish removes it. */
async function postCheck(channelId: string, reason: "quiet" | "no-start", replyTo?: Message, jobId?: number): Promise<void> {
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch?.isSendable()) return;
  const content = buildCheck(channelId, reason);
  const opts = { content, components: [checkRow(channelId)], ...QUIET };
  const m = replyTo ? await replyTo.reply(opts).catch(() => null) : await ch.send(opts).catch(() => null);
  log(`check ${reason} ${channelId} posted=${Boolean(m)}`);
  fileCheck(channelId, m, jobId);
}

/** File a report under the job that ran when it was asked for; that job already ended: nothing to keep it for. */
function fileCheck(channelId: string, m: Message | null, jobId = queue.status().running.find((r) => jobKeys.get(r.id) === channelId)?.id): void {
  if (!m || jobId === undefined) return;
  if (queue.status().running.some((r) => r.id === jobId)) checkMsgs.set(jobId, [...(checkMsgs.get(jobId) ?? []), own(m)]);
}

async function handleCheckButton(i: ButtonInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "Only the owner can run a check.", flags: MessageFlags.Ephemeral }));
  const channelId = i.customId.slice(CHECK_PREFIX.length);
  const jobId = queue.status().running.find((r) => jobKeys.get(r.id) === channelId)?.id;
  await i.reply({ content: buildCheck(channelId, "button"), components: [checkRow(channelId)], ...QUIET });
  fileCheck(channelId, await i.fetchReply().catch(() => null), jobId);
  log(`check button ${channelId} job=${jobId ?? "none"}`);
}

/** ↪️ Handoff (UX item 8): `/handoff to:<channel> [note]` and the message action "Send to another channel". */
const HANDOFF_COMMANDS: (ApplicationCommandDataResolvable & { name: string })[] = [
  {
    name: "handoff",
    description: "Move this conversation to another channel (link, session log and a summary there)",
    options: [
      { type: ApplicationCommandOptionType.Channel, name: "to", description: "Destination channel or thread", required: true, channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildVoice] },
      { type: ApplicationCommandOptionType.String, name: "note", description: "What the agent there should do next (optional)", required: false, max_length: 400 },
    ],
  },
  { type: ApplicationCommandType.Message, name: HANDOFF_MENU_NAME },
];

/** The bridge answers the owner in this channel (mapped, mirrored or pinned-model channel, or a thread under one). */
function bridgeChannel(ch: Channel | null): ch is SendableChannels & { guildId: string } {
  if (!ch || ch.isDMBased() || !ch.isSendable() || !("guildId" in ch) || ch.guildId !== GUILD_ID) return false;
  const parentId = ch.isThread() ? ch.parentId : null;
  if (mirror.byChannel(parentId ?? ch.id)) return true;
  const info = { authorId: OWNER_ID, authorIsBot: false, guildId: ch.guildId, channelId: ch.id, isDM: false, isThread: ch.isThread(), parentId };
  return Boolean(unrestrictedRoute(info, CONFIG.unrestrictedChannelIds)) || route(info).kind !== "ignore";
}

async function doHandoff(srcId: string, destId: string, note: string | null, upToMessageId?: string): Promise<string> {
  if (srcId === destId) return "↪️ That is this channel. Pick another one.";
  const [src, dest] = await Promise.all([client.channels.fetch(srcId).catch(() => null), client.channels.fetch(destId).catch(() => null)]);
  if (!src?.isTextBased() || src.isDMBased()) return "❌ The source channel is not readable.";
  if (!bridgeChannel(dest)) return `❌ ${channelMention(destId, "That channel")} is not a channel the bot answers in (mapped, mirrored or a thread under one). Pick another one.`;
  const parentId = src.isThread() ? src.parentId : null;
  const entry = mirror.byChannel(parentId ?? srcId);
  const logs = sourceLogs({
    sessionsDir: SESSIONS_DIR,
    channelId: srcId,
    sideKey: entry ? sideSessionKey(entry, src.isThread() ? srcId : null) : null,
    paneSession: entry?.machine === "main" ? entry.sessionFile : null,
  });
  const fetched = await src.messages.fetch({ limit: 20, ...(upToMessageId ? { before: upToMessageId } : {}) }).catch(() => null);
  const list = [...(fetched?.values() ?? [])].reverse();
  if (upToMessageId) {
    const m = await src.messages.fetch(upToMessageId).catch(() => null);
    if (m) list.push(m);
  }
  const recent = excerpt(list.map((m) => ({ author: m.author.id === OWNER_ID ? "owner" : m.author.username, fromBot: m.author.id === client.user?.id, content: m.content })));
  const srcName = "name" in src && src.name ? `#${src.name}` : `channel ${srcId}`;
  const srcUrl = upToMessageId ? `https://discord.com/channels/${GUILD_ID}/${srcId}/${upToMessageId}` : `https://discord.com/channels/${GUILD_ID}/${srcId}`;
  const h = { srcName, srcMention: channelMention(srcId, srcName), srcUrl, logs, note, recent, transcript: logExcerpt(logs) };
  const card = own(await dest.send({ content: handoffCard(h), ...QUIET }).catch((e) => void log(`handoff card: ${(e as Error).message}`)));
  if (!card) return "❌ The bot could not post in that channel.";
  if (src.isSendable()) await src.send({ content: backLink(channelMention(destId, "the new channel"), card.url), ...QUIET }).catch(() => {});
  log(`handoff ${srcId} -> ${destId} logs=${logs.length} recent=${recent.length}`);
  void handle(card, { authorId: OWNER_ID, text: handoffPrompt(h), menuIds: [] }) // menuIds: [] = no card refs scanned in bot-written text.catch((e) => log(`handoff run ${destId}: ${(e as Error).message}`));
  return `↪️ Sent to ${channelMention(destId, "the new channel")}: [open the handoff](${card.url}). The agent there posts a summary first.`;
}

async function handleHandoffCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "Only the owner can move a conversation.", flags: MessageFlags.Ephemeral }));
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply({ content: await doHandoff(i.channelId, i.options.getChannel("to", true).id, i.options.getString("note")) });
}

async function handleHandoffMenu(i: MessageContextMenuCommandInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "Only the owner can move a conversation.", flags: MessageFlags.Ephemeral }));
  const pick = new ChannelSelectMenuBuilder()
    .setCustomId(`${HANDOFF_PREFIX}${i.channelId}:${i.targetId}`)
    .setPlaceholder("Send this conversation to…")
    .setChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildVoice);
  await i.reply({ content: "↪️ Pick the channel for this conversation (up to this message).", components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(pick)], flags: MessageFlags.Ephemeral });
}

async function handleHandoffPick(i: ChannelSelectMenuInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "Only the owner can move a conversation.", flags: MessageFlags.Ephemeral }));
  const [srcId = "", msgId] = i.customId.slice(HANDOFF_PREFIX.length).split(":");
  await i.update({ content: "↪️ Sending…", components: [] });
  await i.editReply({ content: await doHandoff(srcId, i.values[0] ?? "", null, msgId) });
}

/** Record an event (✅/❌/🛑 lines are kept as "finished") and re-render the board in place. */
async function editBoard(channelId: string, line: string): Promise<void> {
  const b = queueBoards.get(channelId);
  if (!b) return;
  if (/\*\*(Done|Stopped):\*\*/.test(line)) b.recent.push(line.trim().replace(/\*\*(Done|Stopped):\*\* /, ""));
  // Let the queue settle (the finished job is removed just before onDone).
  await new Promise((r) => setTimeout(r, 50));
  b.text = renderBoard(channelId, b.recent);
  await b.msg.edit({ content: b.text }).catch(() => {});
  if (b.text.includes("Restart pending")) recordPendingBoard(STATE_DIR, channelId, b.msg.id);
}

const isBoardText = (t: string) => t.startsWith("⏳ **Queue") || t.startsWith(`${BOARD_RULE}\n⏳ **Queue`);
const boardTimers = new Map<string, NodeJS.Timeout>();
const boardChains = new Map<string, Promise<void>>();
const boardFinal = new Set<string>();
/** Board reprints running now; with boardTimers, /health reports them so a restart never cuts the 🏁 Finished post. */
let boardInflight = 0;
/** First time a reprint was requested and not yet run: a steady stream of messages must not hold the board back. */
const boardPendingSince = new Map<string, number>();
const BOARD_MAX_WAIT_MS = 3000;
/** Debounced: reprint the board below the newest message. `final` (after the last answer) closes it. */
function keepBoardLast(channelId: string, delay = 1200, final = false): void {
  if (!queueBoards.has(channelId)) return;
  if (final) boardFinal.add(channelId);
  const now = Date.now();
  const since = boardPendingSince.get(channelId) ?? now;
  boardPendingSince.set(channelId, since);
  const wait = Math.max(0, Math.min(delay, since + BOARD_MAX_WAIT_MS - now));
  clearTimeout(boardTimers.get(channelId));
  boardTimers.set(channelId, setTimeout(() => {
    boardTimers.delete(channelId);
    const asked = boardPendingSince.get(channelId) ?? Date.now();
    boardPendingSince.delete(channelId);
    const close = boardFinal.delete(channelId);
    boardInflight++;
    const run = (boardChains.get(channelId) ?? Promise.resolve()).then(() => reprintBoard(channelId, close, asked)).catch((e) => log(`board reprint: ${(e as Error).message}`)).finally(() => boardInflight--);
    boardChains.set(channelId, run);
  }, wait));
}
async function reprintBoard(channelId: string, close: boolean, asked = Date.now()): Promise<void> {
  const t0 = Date.now();
  const b = queueBoards.get(channelId);
  if (!b || !b.msg.channel.isSendable()) return void log(`board reprint skipped: ${b ? "channel not sendable" : "no board"} close=${close}`);
  const ch = b.msg.channel;
  b.text = renderBoard(channelId, b.recent);
  const recent = await ch.messages.fetch({ limit: 30 }).catch((e) => (log(`board fetch: ${(e as Error).message}`), null));
  const tFetch = Date.now();
  let action = "edit";
  if (recent?.first()?.id === b.msg.id) await b.msg.edit({ content: b.text }).catch((e) => log(`board edit: ${(e as Error).message}`));
  else {
    action = "post";
    const fresh = await ch.send({ content: b.text, components: [checkRow(channelId)], ...QUIET }).catch((e) => (log(`board post: ${(e as Error).message}`), null));
    if (fresh) {
      await b.msg.delete().catch(() => {});
      b.msg = fresh;
    } else action = "post-failed";
  }
  const tSend = Date.now();
  let stale = 0;
  for (const m of recent?.values() ?? []) {
    if (m.id !== b.msg.id && m.author.id === client.user?.id && isBoardText(m.content)) {
      stale++;
      await m.delete().catch(() => {});
    }
  }
  const busy = [...queue.status().running, ...queue.status().queued].some((x) => jobKeys.get(x.id) === channelId);
  if (close && !busy) queueBoards.delete(channelId); // the 🏁 Finished board stays until the owner writes again
  if (b.text.includes("Restart pending")) recordPendingBoard(STATE_DIR, channelId, b.msg.id);
  log(`board ${action} ${b.msg.id} close=${close} final=${close && !busy} queuedMs=${t0 - asked} fetchMs=${tFetch - t0} sendMs=${tSend - tFetch} totalMs=${Date.now() - t0} staleDeleted=${stale}`);
}
/** After a job's answer is posted: board below it; after the last job, the final reprint closes it. */
async function boardToBottom(channelId: string): Promise<void> {
  keepBoardLast(channelId, 1500, true);
}

/**
 * A finished board (or one left by a restart or an older version) must not stay above new work: when the
 * owner writes and no queue is active, delete the bot's earlier boards and cut boards appended to answers.
 */
async function clearStaleBoards(msg: Message): Promise<void> {
  const older = await msg.channel.messages.fetch({ before: msg.id, limit: 30 }).catch(() => null);
  for (const m of older?.values() ?? []) {
    if (m.author.id !== client.user?.id || queueBoards.get(msg.channelId)?.msg.id === m.id) continue;
    if (isBoardText(m.content)) {
      await m.delete().catch((e) => log(`stale board delete: ${(e as Error).message}`));
      continue;
    }
    const at = m.content.indexOf(`\n\n${BOARD_RULE}\n⏳ **Queue`);
    if (at > 0) await m.edit({ content: m.content.slice(0, at) }).catch((e) => log(`stale board strip: ${(e as Error).message}`));
  }
}

/** Messages posted by the conversation flow (kept for callers; the board no longer lives inside them). */
const ownPosts = new Set<string>();
function own<T extends Message | null | undefined>(m: T): T {
  if (m) {
    ownPosts.add(m.id);
    if (ownPosts.size > 500) ownPosts.delete(ownPosts.values().next().value!);
  }
  return m;
}

/**
 * `asOwner.restored`: a job saved before a restart (src/queuestate.ts), queued again with its saved text
 * and attachments. The record comes from the bridge's own 0600 state file.
 */
async function handle(
  msg: Message,
  asOwner?: { authorId: string; text: string; fromVoice?: boolean; attachments?: { name: string; url: string }[]; restored?: boolean; menuIds?: string[] },
): Promise<void> {
  // Owner 2026-10-19: owner turns (menus, voice, Undo, restored jobs) in a pinned-model channel go to that model.
  if (asOwner && routePinned(msg.channel, asOwner.text)) return;
  // Provenance: only the owner's own account (not a bot, webhook or system message) is routed.
  // Messages the bridge itself produced (bot user, relay webhooks, self-tests) never are.
  const prov = asOwner ? "owner" : messageProvenance({
    authorId: msg.author.id,
    isBot: msg.author.bot,
    isWebhook: Boolean(msg.webhookId),
    isSystem: msg.system || (msg.type !== MessageType.Default && msg.type !== MessageType.Reply),
    botUserId: client.user?.id,
  });
  if (prov !== "owner") {
    if (prov === "other" && msg.author.id !== client.user?.id) log(`ignored message from ${msg.author.id} (not owner)`);
    return;
  }
  void noteOwnerAnswer(msg, asOwner);
  const isDM = msg.channel.type === ChannelType.DM;
  const isThread = msg.channel.isThread();
  const parentId = msg.channel.isThread() ? msg.channel.parentId : null;
  const authorId = asOwner?.authorId ?? msg.author.id;
  let text = asOwner ? asOwner.text : msg.content.trim();
  // 📨 Queued (src/queued.ts): the message the owner replied to; read here, before a voice swap replaces `msg`.
  const replyRef = asOwner ? undefined : msg.reference?.messageId;
  // Mirrored Herdr tab channels: never typed into the pane (see src/mirror.ts).
  const mirrored = msg.guildId === GUILD_ID ? mirror.byChannel(parentId ?? msg.channelId) : undefined;
  const threadId = isThread ? msg.channelId : null;
  // P12: the owner may reply in a triage thread under #omp-alerts (a post-only channel): the run continues there.
  const triageThread = isThread && msg.guildId === GUILD_ID && triage.isThread(msg.channelId);
  const msgInfo = {
    authorId,
    authorIsBot: asOwner ? false : msg.author.bot || Boolean(msg.webhookId),
    guildId: msg.guildId,
    channelId: msg.channelId,
    isDM,
    isThread,
    parentId,
  };
  // 🔓-unrestricted-qwen channels (owner 2026-10-19, "remove the sandbox there too"): trusted turns pinned to Qwen.
  const pinnedQwen = mirrored || triageThread ? null : unrestrictedRoute(msgInfo, CONFIG.unrestrictedChannelIds);
  const r = mirrored
    ? null
    : triageThread
    ? { kind: "thread" as const, cwd: TRIAGE_CWD, channelName: "omp-alerts" }
    : pinnedQwen ?? route(msgInfo);
  if (r?.kind === "ignore") {
    if (r.reason === "not-owner" || r.reason === "bot") log(`ignored message from ${msg.author.id} (${r.reason})`);
    return;
  }

  if (asOwner && !asOwner.restored && text.startsWith("!")) return;
  if (text === "/queue" || text === "!queue") {
    const ch = msg.channelId;
    const sent = await msg.reply({ content: renderBoard(ch, []), components: [checkRow(ch)], ...QUIET }).catch(() => null);
    if (sent) queueBoards.set(ch, { msg: sent, text: sent.content, recent: [] });
    return;
  }
  if (text === "!stacks") {
    await msg.reply({ content: stackRouter.statusText(), ...QUIET });
    return;
  }
  if (text === "!status") {
    await msg.reply({ content: statusText(), ...QUIET });
    return;
  }
  const deny = text.match(/^!deny\s+([a-z2-9]{8})$/i);
  if (deny) {
    const id = deny[1]!.toLowerCase();
    const r = approvals.deny(id, "the owner in Discord");
    const reply = {
      cancelled: "Cancelled. Nothing ran.",
      running: "Too late: it was already approved with the password and has started.",
      unknown: "No pending approval with that id.",
    }[r];
    await msg.reply({ content: `\`${id}\`: ${reply}`, ...QUIET });
    return;
  }

  let target: SendableChannels;
  let key: string;
  let threadUrl: string;
  let where: string;
  let transientThread: { id: string; archived: boolean | null; setArchived: (v: boolean, reason?: string) => Promise<unknown> } | undefined;
  let cwd: string;
  if (mirrored) {
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = threadId ?? `mirror-${mirrored.channelId}`; // queue key: one run per channel/thread at a time
    cwd = "";
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${msg.channelId}`;
    where = `#${mirrored.name}`;
    const stackOfThread = stackRouter.stackByThread(threadId);
    if (text === "!new" && stackOfThread) {
      const k = qwenSessionKey(stackSessionKey(stackOfThread.name), models.resolveOverride(modelOverrides, msg.channelId, parentId));
      resetSession(k);
      await msg.reply({ content: `Started a fresh session for the ${stackOfThread.emoji} ${stackOfThread.name} stack (\`${k}\`).`, ...QUIET });
      return;
    }
    if (text === "!new") {
      const side = sideSessionKey(mirrored, threadId);
      resetSession(side);
      await msg.reply({ content: `Started a fresh side session (\`${side}\`). The pane's own session is unchanged.`, ...QUIET });
      return;
    }
  } else if (!r) {
    return;
  } else if (r.kind === "new-thread" && msg.channel.type === ChannelType.GuildVoice) {
    // Owner 2026-10-21: a voice channel's text chat cannot hold threads (Discord), so a mapped
    // voice channel (e.g. 📺-fx-video) gets its replies directly in that chat, one run at a time.
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = `voice-${msg.channelId}`;
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${msg.channelId}`;
    where = `#${r.channelName}`;
    cwd = r.cwd;
  } else if (r.kind === "new-thread") {
    if (msg.channel.type !== ChannelType.GuildText) return;
    // A restored job (P1) already has its thread: use it again.
    const old = msg.hasThread ? await msg.channel.threads.fetch(msg.id).catch(() => null) : null;
    const thread =
      old ??
      (await msg.startThread({
        name: threadName(text || msg.attachments.first()?.name || "omp task"),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      }));
    target = thread;
    key = thread.id;
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${thread.id}`;
    // Owner 2026-10-23: reply threads in alert channels (#needs-you, alert feeds) are transient.
    if (msg.channelId === NEEDS_YOU_CHANNEL_ID || ALERT_CHANNELS[msg.channelId]) transientThread = thread;
    where = `#${r.channelName}`;
    cwd = r.cwd;
  } else if (r.kind === "thread") {
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = msg.channelId;
    threadUrl = `https://discord.com/channels/${GUILD_ID}/${msg.channelId}`;
    where = `#${r.channelName}`;
    cwd = r.cwd;
  } else {
    if (!msg.channel.isSendable()) return;
    target = msg.channel;
    key = `dm-${msg.channelId}`;
    threadUrl = `https://discord.com/channels/@me/${msg.channelId}`;
    where = "DM";
    cwd = r.cwd;
    if (text === "!new") {
      resetSession(key);
      await msg.reply({ content: "Started a fresh session for this DM.", ...QUIET });
      return;
    }
  }
  // Spoken messages are answered wherever the owner last wrote (src/voicechat.ts).
  // A routed copy in a stack thread (restored turn) does not move spoken turns away from FIRSTMATE.
  if (!(asOwner?.restored && threadId && stackRouter.stackByThread(threadId))) lastOwnerChannelId = target.id;

  if (!text && msg.attachments.size === 0) return;
  // Voice messages: transcribe locally, show the transcript, use it as the typed message.
  const voice = asOwner ? [] : [...msg.attachments.values()].filter((a) => isVoice(a));
  let spoken = "";
  for (const v of voice) {
    try {
      const t = await transcribe(v.url);
      spoken += (spoken ? "\n" : "") + t;
    } catch (e) {
      log(`voice: ${(e as Error).message}`);
      await target.send({ content: "⚠️ I couldn't transcribe that voice message. Please type it instead.", ...NO_PINGS });
      return;
    }
  }
  if (voice.length) {
    if (!spoken) {
      await target.send({ content: "🎙️ I couldn't hear any speech in that voice message.", ...QUIET });
      return;
    }
    // Owner 2026-10-15: swap the voice message for its transcript as soon as it is transcribed. The transcript
    // message then carries the ⏳/✅ reactions, ⚙️ Working, Stop/Undo and the answer's reply link.
    // Guild only (bots can't delete DM messages); only when the message is nothing but voice.
    const header = `🎙️ from **${msg.member?.displayName ?? msg.author.globalName ?? msg.author.username}**: *${spoken.replace(/[*_`]/g, "")}*`;
    if (voice.length === msg.attachments.size && !msg.content.trim() && msg.inGuild()) {
      const t = own(await target.send({ content: header, ...QUIET }));
      await msg.delete().catch((e) => log(`voice source delete: ${(e as Error).message}`));
      msg = t;
    } else await msg.reply({ content: header, ...QUIET });
    text = text ? `${text}\n${spoken}` : spoken;
  }
  const attachments = asOwner ? (asOwner.attachments ?? []) : [...msg.attachments.values()].filter((a) => !isVoice(a)).map((a) => ({ name: a.name, url: a.url }));
  // FIRSTMATE router (src/router.ts): a new owner message in the FIRSTMATE channel may go to a domain stack thread.
  if (mirrored && !threadId && mirrored.channelId === FIRSTMATE_CHANNEL_ID && (await routeFirstmate(msg, text, attachments, asOwner, replyRef, parentId))) return;
  // A stack thread under FIRSTMATE: the stack's own OMP session and work folder (never the pane's session).
  const stack = mirrored && threadId ? stackRouter.stackByThread(threadId) : undefined;
  const routed = stack ? stackRouter.routedFor(msg.id) : undefined;
  if (stack) {
    cwd = stack.cwd;
    where = `#${mirrored!.name} › ${stack.emoji} ${stack.name} stack`;
  }
  const source = { kind: "owner" as const, authorId };
  const label = `${where} ${threadName(text || "attachment").slice(0, 60)}`;
  // One id per owner run: OMP_GATE_RUN for the agent, `by: run:<id>` on cards it changes (fm), `&by=` in the dashboard link.
  const fmRun = randomBytes(6).toString("hex");
  // /models override: the thread's own, else its parent channel's. Qwen (unrestricted) runs here like any other
  // model: trusted tools, ~/.omp/agent (owner 2026-10-19). 🔓-unrestricted-qwen channels are always Qwen.
  const model = pinnedQwen ? models.UNRESTRICTED_MODEL : models.resolveOverride(modelOverrides, msg.channelId, parentId);
  // Qwen turns use their own session, so a later Claude turn never loads Qwen's transcript (protects the Claude login).
  const sessKey = qwenSessionKey(stack ? stackSessionKey(stack.name) : key, model);
  const followUp = hasSession(sessKey);
  let planRun = false; // /mode plan was on for this run: its answer gets Approve/Reject buttons
  const stackHeader = stack ? stackPreamble(stack, routed?.decision ?? { stack: stack.name, by: "inherit", confidence: 1, detail: "typed in the stack thread" }, routed?.sourceUrl ?? threadUrl) : "";
  const run = mirrored && !stack
    ? () => runMirrored(mirrored.channelId, threadId, target, { source, content: text, threadUrl, messageUrl: routed?.sourceUrl ?? msg.url, where, attachments }, false, fmRun, model)
    : () => {
        // /resume pin, /new and /mode settings of this session (src/sessioncmds.ts).
        const st = sessionCmds.runSettings(sessKey, Boolean(isolatedTag(model)));
        planRun = st.plan;
        const prompt = buildPrompt({ source, content: `${st.preamble}${stackHeader}${text}`, threadUrl, messageUrl: routed?.sourceUrl ?? msg.url, where, followUp: followUp && !st.fresh, attachments, approvals: approvals.takeResults(sessKey) });
        return runOmp(sessKey, cwd, prompt, { channelId: target.id, runId: fmRun, model, extraArgs: st.extraArgs, resumeFile: st.resumeFile, fresh: st.fresh }).finally(() => sessionCmds.afterRun(sessKey));
      };

  // A job restored after a restart may already carry our ⏳ from the old process.
  if (msg.reactions.cache.some((r) => r.me && r.emoji.name === "⏳")) statusReact.assume(msg, "⏳");
  void statusReact.set(msg, "⏳");
  // Owner 2026-10-18: mark the cards this response answers as 📨 Queued before the run starts (no double submits).
  // Refs: the menu / replied-to message ids, plus links and `⚓ item:` tokens in the OWNER's text only. The replied-to
  // bot message is not scanned: its "Still waiting" links and item tokens name cards the owner did not answer.
  // A job restored after a restart was marked when it first arrived. markQueued never throws.
  // Ask answers (menuIds) carry bot-written question text, so only the owner's own words are scanned.
  if (!asOwner?.restored) await markQueued(responseRefs(asOwner ? [msg.id, ...(asOwner.menuIds ?? [])] : [msg.id, replyRef], asOwner?.menuIds ? [] : [text]), { log });
  const preview = jobPreview(text);
  let startedAt: number | undefined;
  const { id, position } = queue.enqueue({
    key,
    label,
    preview,
    run,
    ...(stack ? { group: "stack" } : {}),
    onStart: () => {
      queuedMsgs.delete(id);
      // Owner 2026-10-15: ⏳ = waiting in the queue, ⚙️ = being worked on now.
      void statusReact.set(msg, WORKING);
      // Owner 2026-10-15: turn this job's ⏳ Queued. note into Working… in place, so the order stays
      // ✅ done → ⚙️ Working (Stop) → ⏳ waiting (Cancel). No note (started at once): post at the bottom.
      const note = queuedNotes.get(id);
      queuedNotes.delete(id);
      startedAt = Date.now();
      log(`job start key=${key} cwd=${cwd || "(mirror)"} followUp=${followUp}`);
      // One board edit per job start (owner 2026-10-15): the refresh after Working… posts below covers it.
      const stop = new ButtonBuilder().setCustomId(`${STOP_PREFIX}${id}`).setLabel("Stop").setEmoji("❌").setStyle(ButtonStyle.Danger);
      const working = { content: `${WORKING} Working…`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(stop, checkButton(target.id))], ...QUIET };
      const post = () => msg.reply(working);
      void showWorking(note, { content: working.content, components: working.components, ...NO_PINGS }, post)
        .then((m) => {
          if (finishedJobs.delete(id)) return void m.delete().catch(() => {});
          workingMsgs.set(id, own(m));
          jobLinks.set(id, m.url); // board "Now" links to the Working… message with Stop
          void editBoard(target.id, ""); // refresh now so the Now link points at Working… at once
          let editing = false;
          // Owner 2026-10-15: first heartbeat after ~2 s (the run is registered by then), then every 10 s.
          // One edit per 10 s stays far below Discord's edit rate limit (5 per 5 s per channel).
          const tick = () => {
            const hb = runHeartbeat(target.id);
            if (!hb || editing || !workingMsgs.has(id)) return;
            editing = true;
            let content: string;
            try {
              content = hb.tick();
              // UX item 5: a run quiet for ~10 min (before the idle stop) gets ONE check report by itself.
              const v = hb.lastView;
              if (v?.tree.alive && !autoChecked.has(id) && Date.now() - lastActivity(v) >= autoCheckQuietMs(IDLE_TIMEOUT_MS)) {
                autoChecked.add(id);
                void postCheck(target.id, "quiet", m, id).catch((e) => log(`check quiet ${id}: ${(e as Error).message}`));
              }
            } catch (e) {
              editing = false;
              return void log(`heartbeat ${id}: ${(e as Error).message}`);
            }
            m.edit({ content, ...NO_PINGS })
              .catch((e) => {
                log(`heartbeat edit ${id}: ${(e as Error).message}`);
                if (e instanceof DiscordAPIError && e.code === 10008) clearInterval(heartbeatTimers.get(id)); // message deleted
              })
              .finally(() => (editing = false));
          };
          heartbeatTimers.set(id, setInterval(tick, HEARTBEAT_MS));
          setTimeout(tick, 2_000);
        })
        .catch(() => void editBoard(target.id, "")); // Working… failed: still refresh the board
    },
    onDone: async (res, err) => {
      let answer: Message | undefined;
      try {
      // Owner 2026-10-15: delete the ⚙️ Working… message when the job ends (it cluttered the chat).
      clearInterval(heartbeatTimers.get(id));
      heartbeatTimers.delete(id);
      // 🩺 Check reports only matter while the job runs: a good finish removes them; a failure keeps them as evidence.
      const checks = checkMsgs.get(id) ?? [];
      checkMsgs.delete(id);
      autoChecked.delete(id);
      if (res?.ok) for (const c of checks) void c.delete().catch(() => {});
      const wm = workingMsgs.get(id);
      if (wm) void wm.delete().catch(() => {});
      else finishedJobs.add(id); // reply not posted yet: delete it when it lands
      workingMsgs.delete(id);
      jobKeys.delete(id);
      jobLinks.delete(id);
      if (res?.cancelled) {
        autoContinues.delete(target.id);
        if (asOwner?.fromVoice) void voicechat.stopHold();
        void statusReact.set(msg, null);
        undoJobs.set(String(id), { msg, startedAt: startedAt ?? Date.now(), text });
        const row = stoppedRow(id);
        answer = (await msg.reply({ content: "🛑 Stopped. To steer, just type or dictate a correction. To go back to before this message, tap 🔙 Undo. To clear this out, tap 🗑️ Remove.", components: [row], ...QUIET }).catch(() => null)) ?? undefined;
        void editBoard(target.id, `\n🛑 **Stopped:** ${maskedLabelText(preview)}`);
        return;
      }
      void editBoard(target.id, `\n${res?.ok ? "✅" : "❌"} **Done:** ${maskedLabelText(preview)}`);
      if (!res?.timedOut) autoContinues.delete(target.id); // the chain ends with any normal finish
      log(`job ${id} done key=${key} ok=${res?.ok ?? false} code=${res?.code ?? "n/a"} timedOut=${res?.timedOut ?? false} ms=${res?.durationMs ?? 0}`);
      void statusReact.set(msg, res?.ok ? "✅" : "❌");
      if (res?.ok) {
        // Owner 2026-10-15: wait for the speech (fast on the GPU), then send ONE message with text + audio.
        // If speech takes over 45 s or fails, the text goes out alone (the audio follows as a 🔊 reply if it arrives).
        const spokenSource = prepareOutbound(extractAsk(res.stdout).text).messages.filter((m) => !m.paste).map((m) => m.content).join("\n");
        const audio = synthesize(spokenSource).catch(() => null);
        const ready = await Promise.race([audio, new Promise<"late">((r) => setTimeout(() => r("late"), 45_000))]);
        // Same call for the late-audio path (audio undefined): the link then ends the text, right above the 🔊 reply.
        answer = await sendText(target, res.stdout, undefined, msg, asOwner?.fromVoice === true, typeof ready === "string" && ready !== "late" ? ready : undefined, audioName(text), [], startedAt, fmRun, undefined, res.model ?? models.defaultModel());
        if (planRun && isPlanAnswer(res.stdout)) await target.send({ content: "📝 Plan ready.", components: [sessionCmds.planRow()], ...QUIET }).catch(() => {});
        answer = (await postEarlierExtras(target, res, msg).catch((e) => void log(`earlier extras: ${(e as Error).message}`))) ?? answer;
        const file = await audio;
        if (!file && asOwner?.fromVoice) void voicechat.stopHold();
        if (file) {
          if (ready === "late") {
            log("tts late: posting audio separately");
            const ref = { reply: { messageReference: msg.id, failIfNotExists: false } };
            await target.send({ content: "🔊", files: [new AttachmentBuilder(file, { name: audioName(text) })], ...ref, ...QUIET }).catch((e) => log(`tts post: ${(e as Error).message}`));
          }
          // Same speakable text, played in the voice channel while the owner is in it.
          // Phone-call rule (owner 2026-10-13): only answers to what was SAID in the call are spoken.
          if (asOwner?.fromVoice) {
            // Owner 2026-10-13: no length cap in the call (they can stop it any time).
            await voicechat.speakFile(file).catch((e) => log(`voice say: ${(e as Error).message}`));
            void transcriptLog(`🤖 **OMP:** ${speakable(spokenSource)}`);
          }
          rmSync(dirname(file), { recursive: true, force: true });
        }
        return;
      }
      if (asOwner?.fromVoice) void voicechat.stopHold();
      if (res?.timedOut && !res.cancelled && timeLimitContinue(msg.channelId, parentId, CONFIG.timeLimitContinueChannelIds, CONFIG.unrestrictedChannelIds)) {
        // Owner 2026-10-19 (Qwen + Example Activity – dev): continue the same session after the time limit; ❌ Stop ends the loop.
        const n = (autoContinues.get(target.id) ?? 0) + 1;
        autoContinues.set(target.id, n);
        log(`time-limit auto-continue ${target.id} #${n}`);
        answer = await sendText(target, `⏱️ The run hit the ${limitText(res)}. 🔁 Continuing automatically (#${n}). Tap ❌ Stop on the next Working… message to end it.`, undefined, undefined, false, undefined, undefined, [], startedAt, fmRun);
        void handle(msg, { authorId, text: "continue", attachments: [], restored: true }).catch((e) => log(`auto-continue ${target.id}: ${(e as Error).message}`));
        return;
      }
      if (res?.timedOut) {
        answer = await sendText(
          target,
          `⏱️ The run hit the ${limitText(res)} and was stopped. The session is kept — reply here to continue.${res.stdout ? `\n\nPartial output:\n${res.stdout}` : ""}`,
          undefined, undefined, false, undefined, undefined, [], startedAt, fmRun,
        );
        return;
      }
      // Owner 2026-10-21: a cyber refusal in the FIRSTMATE channel resets FIRSTMATE automatically (src/cyberreset.ts).
      if (FIRSTMATE_CHANNEL_ID && key === `mirror-${FIRSTMATE_CHANNEL_ID}` && res && !res.cancelled) {
        const sideDir = join(SESSIONS_DIR, FIRSTMATE_SESSION.key);
        const files = [newestJsonl(sideDir), mirror.byChannel(FIRSTMATE_CHANNEL_ID)?.sessionFile];
        if (isCyberRefusal({ output: `${res.stderrTail}\n${res.stdout}`, sinceMs: startedAt ?? Date.now() - RUN_TIMEOUT_MS, files })) {
          log("cyber-reset: refusal detected in FIRSTMATE run");
          const r = await resetFirstmate({ sessionsDir: SESSIONS_DIR, sideKey: FIRSTMATE_SESSION.key, pane: FIRSTMATE_PANE, stateFile: join(STATE_DIR, "cyber-reset.json"), log }).catch((e) => ({ ok: false, pane: "failed" as const, reason: (e as Error).message }));
          log(`cyber-reset: ok=${r.ok} pane=${r.pane}${r.reason ? ` (${r.reason})` : ""}`);
          answer = await sendText(target, resetNotice(r), undefined, undefined, false, undefined, undefined, [], startedAt, fmRun);
          return;
        }
      }
      // Owner pick 2026-10-23 (UX item 7): plain cause line + 🔁 Retry on the same message; ONE automatic retry
      // for a quick transient provider error (src/failcause.ts).
      const errOut = `${err ? (err as Error).message : ""}\n${res?.stderrTail ?? ""}`;
      let cause = classifyFailure(errOut, res?.code);
      if (cause.kind === "unknown" && res?.stdout && /Refusal \(/.test(res.stdout)) cause = classifyFailure("Refusal (", res.code); // answer text may quote codes; only a refusal counts
      const detail = err ? (err as Error).message : (res?.stderrTail || res?.stdout || "no output").slice(-800);
      const auto = shouldAutoRetry(cause, res?.durationMs ?? 0, autoRetried.has(msg.id), res?.toolCalls);
      log(`job ${id} failure cause=${cause.kind} transient=${cause.transient} autoRetry=${auto}`);
      retryJobs.set(String(id), { msg, text, attachments });
      // sendText keeps the reply's dashboard link; the 🔁 Retry button is then added to that same message.
      answer = await sendText(target, failureText(cause, redact(detail).text, auto ? AUTO_RETRY_DELAY_MS / 1000 : undefined), undefined, undefined, false, undefined, undefined, [], startedAt, fmRun);
      if (answer) await answer.edit({ components: [SessionCommands.retryRow(id)] }).catch((e) => log(`retry button ${id}: ${(e as Error).message}`));
      else await target.send({ content: "🔁 Run it again?", components: [SessionCommands.retryRow(id)], ...QUIET }).catch(() => {});
      if (auto) {
        autoRetried.add(msg.id);
        const failMsg = answer;
        setTimeout(() => {
          const job = retryJobs.get(String(id));
          if (!job) return; // the owner tapped 🔁 Retry first
          retryJobs.delete(String(id));
          void failMsg?.edit({ content: failMsg.content.replace(/🔁 Retrying once by itself in \d+ s\./, "🔁 Retried once automatically (see below)."), components: [] }).catch(() => {});
          void handle(job.msg, { authorId: OWNER_ID, text: job.text, attachments: job.attachments, restored: true }).catch((e) => log(`auto-retry ${id}: ${(e as Error).message}`));
        }, AUTO_RETRY_DELAY_MS);
      }
      } finally {
        // Owner 2026-10-15: when the queue is done, the board moves below the last answer.
        void boardToBottom(target.id);
      }
    },
  });
  jobKeys.set(id, target.id);
  jobOwnerLinks.set(id, msg.url);
  if (transientThread) transientThreads.set(id, transientThread);
  // Board tag: the routed stack, FIRSTMATE general, or the stack of a mapped topic channel.
  const tagged = stack ?? (mirrored?.channelId === FIRSTMATE_CHANNEL_ID && !threadId ? stackRouter.stack(GENERAL) : stackRouter.stackByChannel(msg.channelId, parentId));
  if (tagged) jobStacks.set(id, tagged.name);
  // Stack status (FIRSTMATE board 🧭 section, stacks.json, /health): stack-thread jobs only, never topic-channel text.
  if (stack) stackRouter.track(id, stack, preview, msg.url, msg.id, queue.status().running.some((r) => r.id === id));
  jobLinks.set(id, msg.url);
  // UX item 5: no Working… within 60 s and no normal reason (it is not behind this channel's own job): post a check.
  setTimeout(() => {
    const st = queue.status();
    const started = st.running.some((r) => r.id === id);
    const waiting = st.queued.some((q) => q.id === id);
    const behindOwn = st.running.some((r) => jobKeys.get(r.id) === target.id && r.id !== id);
    const noWorking = started && !workingMsgs.has(id) && !finishedJobs.has(id);
    if (!noWorking && !(waiting && !behindOwn)) return;
    if (Date.now() - (noStartChecked.get(target.id) ?? 0) < 5 * 60_000) return; // one per channel per 5 min
    noStartChecked.set(target.id, Date.now());
    void postCheck(target.id, "no-start", msg).catch((e) => log(`check no-start ${id}: ${(e as Error).message}`));
  }, 60_000);
  if (position > 0) {
    // P1: save the waiting job so a restart does not lose it.
    savedJobs.set(id, { id, channelId: msg.channelId, messageId: msg.id, authorId, text, fromVoice: asOwner?.fromVoice, attachments, enqueuedAt: Date.now() });
    saveQueue();
    queuedMsgs.set(id, { msg });
    void syncBadges();
    // Owner 2026-10-15: each queued message gets a silent "⏳ Queued." note with its own Cancel button.
    const note = await msg.reply({ content: "⏳ Queued.", components: [cancelRow(id)], ...QUIET }).catch(() => null);
    // Race: the job can start (or be cancelled) while this reply is in flight. Then onStart found no note and
    // posted Working… at the bottom; a late note must not keep a Cancel button for a running job.
    if (note && noteIsLate(id, queue.status().queued.map((q) => q.id))) void note.delete().catch(() => {});
    else if (note) {
      queuedNotes.set(id, note);
      jobLinks.set(id, note.url); // owner 2026-10-15: board links go to the note with Cancel
      const saved = savedJobs.get(id);
      if (saved) {
        saved.noteId = note.id;
        saveQueue();
      }
    }
    const place = queue.status().queued.findIndex((q) => q.id === id) + 1 || position;
    if (queueBoards.has(target.id)) await editBoard(target.id, `\n➕ **Queued:** ${maskedLabelText(preview)} (#${place} in line)`);
    else if (queueBoxAllowed(target.id, FIRSTMATE_CHANNEL_ID)) {
      const text = renderBoard(target.id, []);
      const sent = await target.send({ content: text, components: [checkRow(target.id)], ...QUIET }).catch(() => null);
      if (sent) queueBoards.set(target.id, { msg: sent, text, recent: [] });
    }
    if (queueBoxAllowed(target.id, FIRSTMATE_CHANNEL_ID)) keepBoardLast(target.id);
  }
}

/**
 * Plan P12: start one triage run for an incident from harness-watch, in a new thread under #omp-alerts.
 * Dedupe (one run per key per 6 h) and one run at a time: src/triage.ts.
 */
async function startTriage(i: Incident): Promise<{ started: boolean; reason?: string }> {
  if (!client.isReady()) return { started: false, reason: "gateway not ready" };
  const ok = triage.admit(i.key);
  if (!ok.start) return { started: false, reason: ok.reason };
  try {
    const alerts = await privateChannel(resolveChannel("omp-alerts") ?? "");
    if (!alerts || alerts.type !== ChannelType.GuildText) throw new Error("#omp-alerts is not available");
    const head = prepareOutbound(`🚨 **Incident triage:** \`${i.key}\`\n${oneLine(i.detail, 300)}\nAn agent investigates read-only and proposes a fix in this thread. Changes wait for your Approve button.`).messages[0]?.content.slice(0, 2000);
    const start = await alerts.send({ content: head ?? `🚨 Incident triage: ${i.key}`, ...QUIET });
    const thread = await start.startThread({ name: threadName(`triage ${i.key}`), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    triage.addThread(thread.id);
    const threadUrl = `https://discord.com/channels/${GUILD_ID}/${thread.id}`;
    const { id } = queue.enqueue({
      key: thread.id,
      label: `#omp-alerts triage ${i.key}`,
      preview: `triage ${i.key}`,
      // The prompt is built when the queued run starts, so the voice rule reflects the state at that moment.
      run: () =>
        runOmp(
          thread.id,
          TRIAGE_CWD,
          buildPrompt({
            source: { kind: "bridge", reason: `incident triage for harness-watch key ${i.key}; owner decision 2026-10-16 lets agents start agents to investigate new problems` },
            content: triagePrompt(i),
            threadUrl,
            where: "#omp-alerts",
            followUp: false,
          }),
          { channelId: thread.id },
        ),
      onDone: async (res, err) => {
        triage.finish(i.key);
        jobKeys.delete(id);
        log(`triage ${i.key} done ok=${res?.ok ?? false} code=${res?.code ?? "n/a"}`);
        if (err) return void (await sendText(thread, `❌ Triage run failed: ${redact((err as Error).message).text.slice(0, 300)}`));
        if (res?.cancelled) return void (await sendText(thread, "🛑 Triage run stopped."));
        if (res?.ok) return void (await sendText(thread, res.stdout));
        await sendText(thread, `❌ Triage run ended with exit ${res?.code ?? "n/a"}${res?.timedOut ? " (time limit)" : ""}.`);
      },
    });
    jobKeys.set(id, thread.id);
    log(`triage ${i.key}: started in thread ${thread.id} (job ${id})`);
    return { started: true };
  } catch (e) {
    triage.release(i.key);
    log(`triage ${i.key}: start failed: ${(e as Error).message}`);
    return { started: false, reason: `start failed: ${(e as Error).message}` };
  }
}

/** P5: the automatic continue did not run (a live omp holds the session, or no pane session). */
class NotContinued extends Error {}

/**
 * Plan P5 (src/stall.ts): stall lines, "resumed" lines and automatic continues for mirrored panes.
 * v2, owner decision 2026-10-16 (stopped agents may continue on their own): a turn that stopped on a transient
 * provider error is continued through the same safe resume path as a Discord message in the channel
 * (`omp -p --resume` of the pane's session, through the queue), only when no live omp holds the session.
 */
async function onWatch(e: MirrorEntry, a: WatchAction): Promise<void> {
  const ch = await mirror.channel(e.channelId);
  if (!ch) return;
  const say = async (text: string) => {
    const content = prepareOutbound(text).messages[0]?.content.slice(0, 2000);
    if (content) await ch.send({ content, ...QUIET });
  };
  if (a.kind === "stall") {
    const what = `${a.tool}${a.intent ? ` (${a.intent})` : ""}`;
    return say(`⏳ **${e.tab}** · waiting on ${what} since <t:${Math.floor(a.since / 1000)}:t> (no session activity for ${Math.round(STALL_MS / 60_000)}+ min)`);
  }
  if (a.kind === "resumed") return say(`▶️ **${e.tab}** · resumed: the session is active again`);
  const msg = oneLine(a.message, 160);
  if (a.kind === "limit")
    return say(`⏸️ **${e.tab}** · the turn stopped on a transient error (${msg}). Not continued: ${MAX_CONTINUES} automatic continues in the last hour already.`);
  log(`mirror: auto-continue ${e.machine}:${e.paneId} attempt ${a.attempt} (${msg})`);
  await say(`🔁 **${e.tab}** · the turn stopped on a transient error (${msg}). Continuing it automatically (attempt ${a.attempt} of ${MAX_CONTINUES} per hour).`);
  const where = `#${e.name}`;
  const { id } = queue.enqueue({
    key: `mirror-${e.channelId}`, // same key as Discord messages in this channel: never two runs at once
    label: `${where} automatic continue`,
    preview: "automatic continue",
    run: () =>
      runMirrored(
        e.channelId,
        null,
        ch,
        {
          source: { kind: "bridge", reason: "automatic continue after a transient provider error; owner decision 2026-10-16 lets stopped agents continue on their own" },
          content: `Continue: the previous turn stopped on a transient error (${msg}).`,
          threadUrl: `https://discord.com/channels/${GUILD_ID}/${e.channelId}`,
          where,
        },
        true,
      ),
    onDone: async (res, err) => {
      jobKeys.delete(id);
      if (err instanceof NotContinued) {
        e.watch?.continues?.pop(); // nothing ran: it does not count
        mirror.save();
        return say(`⏸️ **${e.tab}** · not continued: ${err.message}.`);
      }
      if (err) return say(`❌ **${e.tab}** · automatic continue failed: ${redact((err as Error).message).text.slice(0, 300)}`);
      if (res?.ok) {
        await sendText(ch, `🔁 **${e.tab}** · automatic continue\n${res.stdout}`);
        return;
      }
      await say(`❌ **${e.tab}** · automatic continue ended with exit ${res?.code ?? "n/a"}${res?.timedOut ? " (time limit)" : ""}.`);
    },
  });
  jobKeys.set(id, ch.id);
}

/** P1: queue the jobs saved before the restart again, in their old order. */
async function restoreQueue(): Promise<void> {
  const jobs = toRestore.slice();
  if (!jobs.length) return;
  log(`queue: restoring ${jobs.length} waiting job(s) from before the restart`);
  for (const j of jobs) {
    try {
      const ch = await client.channels.fetch(j.channelId).catch(() => null);
      const msg = ch?.isTextBased() ? await ch.messages.fetch(j.messageId).catch(() => null) : null;
      // The old "⏳ Queued." note has a Cancel button for the old job id: remove it (a new note follows).
      if (j.noteId && ch?.isTextBased()) void ch.messages.fetch(j.noteId).then((n) => n.delete()).catch(() => {});
      toRestore = toRestore.filter((x) => x !== j);
      if (!msg) {
        log(`queue: saved job ${j.id} dropped (message ${j.messageId} not found)`);
        saveQueue();
        continue;
      }
      await handle(msg, { authorId: j.authorId, text: j.text, fromVoice: j.fromVoice, attachments: j.attachments ?? [], restored: true });
      log(`queue: saved job ${j.id} queued again`);
    } catch (e) {
      toRestore = toRestore.filter((x) => x !== j);
      log(`queue: saved job ${j.id} restore failed: ${(e as Error).message}`);
    }
  }
  saveQueue();
}

// discord.js waits out 429s silently; log them so stalls (for example board reprints) are visible.
client.rest.on("rateLimited", (i) => log(`rate limited ${i.method} ${i.route} wait=${i.timeToReset}ms global=${i.global}`));

client.once(Events.ClientReady, () => {
  // Owner 2026-10-26 (no-unknown-channel): drop dead stack thread ids at startup and every 5 min; the next routed
  // message recreates the thread (StackRouter.thread). Boards never keep a dead id.
  const validate = () => void stackRouter.pruneGone((id) => client.channels.fetch(id), log).catch((e) => log(`router: prune: ${(e as Error).message}`));
  validate();
  setInterval(validate, 5 * 60_000);
});
client.once(Events.ClientReady, (c) => {
  // Keep the ~1.5 s home-directory walk off the main thread: prime now, refresh every 50 s.
  void refreshDiscovery();
  void refreshSecretValues();
  setInterval(() => { void refreshDiscovery(); void refreshSecretValues(); }, 50_000);
  log(`READY as ${c.user.tag} (${c.user.id}); guilds=${c.guilds.cache.size}`);
  log(`mirror: ${mirror.entries.filter((e) => !e.archived).length} channels; messages never type into panes (quick-reply buttons do, guarded)`);
  const post = async (channelId: string, text: string) => {
    const ch = await mirror.channel(channelId);
    if (ch) await sendText(ch, text);
  };
  // Owner 2026-10-15: one silent status message per pane turn, edited in place (privacy filter applied).
  // Orca #4 (owner 2026-10-19): it carries a "📜 Last 40 lines" button (edits add it to older messages too).
  const status = async (channelId: string, text: string, msgId?: string): Promise<string | undefined> => {
    const ch = await mirror.channel(channelId);
    if (!ch) return msgId;
    const content = prepareOutbound(text).messages[0]?.content.slice(0, 2000) ?? "";
    const scroll = new ButtonBuilder().setCustomId(`${SB_PREFIX}${channelId}`).setLabel(`Last ${SCROLLBACK_LINES} lines`).setEmoji("📜").setStyle(ButtonStyle.Secondary);
    const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(scroll)];
    if (msgId && "messages" in ch) {
      const old = await ch.messages.fetch(msgId).catch(() => null);
      if (old) {
        await old.edit({ content, components, ...NO_PINGS });
        return msgId;
      }
    }
    return own(await ch.send({ content, components, ...QUIET })).id;
  };
  void mirror.sync().then(() => mirror.tail(post, status, onWatch, Date.now, onWait));
  setInterval(() => void mirror.sync(), 15_000); // new/closed tabs (was 60 s)
  setInterval(() => void mirror.tail(post, status, onWatch, Date.now, onWait).catch((e) => log(`tail error: ${(e as Error).message}`)), 1_000); // owner 2026-10-13: near-instant (was 5 s); tail() skips overlapping runs
  setTimeout(() => void limitWatch.tick().catch((e) => log(`limitwatch: ${(e as Error).message}`)), 20_000);
  setInterval(() => void limitWatch.tick().catch((e) => log(`limitwatch: ${(e as Error).message}`)), LIMIT_TICK_MS);
  setInterval(() => void approvals.tick().catch((e) => log(`approvals error: ${(e as Error).message}`)), 2_000);
  // P1: a drain ends by itself when the restart waiter stops renewing it; then start the waiting jobs.
  setInterval(() => queue.kick(), 5_000);
  // Owner 2026-10-23 (Discord UX item 3): expired menus become "⌛ Expired · 🔁 Ask again".
  setTimeout(() => void editExpiredMenus().catch((e) => log(`expired menus: ${(e as Error).message}`)), 60_000);
  setInterval(() => void editExpiredMenus().catch((e) => log(`expired menus: ${(e as Error).message}`)), 10 * 60_000);
  void restoreQueue().catch((e) => log(`queue restore: ${(e as Error).message}`));
  // The bot sits in 🎧 OMP Voice all the time; voice mode is on while the owner is there too.
  void (async () => {
    const ch = await c.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (ch?.isVoiceBased()) await voicechat.stay(ch);
    const member = await c.guilds.cache.get(GUILD_ID)?.members.fetch(OWNER_ID).catch(() => null);
    if (member?.voice.channelId === VOICE_CHANNEL_ID) voicechat.ownerJoined();
  })().catch((e) => log(`voice join: ${(e as Error).message}`));
});
const localModel = new LocalModelChat({
  stateDir: STATE_DIR,
  log,
  send: async (text) => {
    const ch = await client.channels.fetch(LOCAL_MODEL_CHANNEL_ID);
    if (!ch?.isSendable()) throw new Error("🧠-local-model channel is not sendable");
    const m = await ch.send({ content: text, allowedMentions: { parse: [] } });
    return { edit: async (t: string) => void (await m.edit({ content: t, allowedMentions: { parse: [] } })) };
  },
});
/**
 * Owner 2026-10-19: pinned-model channels (🔓 qwen, Venice, local OMP) get the same Discord experience as Claude:
 * a ⚙️ Working… status with a Stop button and live elapsed time, messages during a run queue and run next, and the
 * answer goes through sendText (ask menus, dashboard link, attachments, copy blocks). The sandbox is unchanged.
 */
const LOSTOP_PREFIX = "lostop:";
function harnessDeps(channelId: string, workDir: string) {
  const fetchCh = async () => {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isSendable()) throw new Error(`channel ${channelId} is not sendable`);
    return ch;
  };
  const stopRow = () => [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${LOSTOP_PREFIX}${channelId}`).setLabel("Stop").setEmoji("❌").setStyle(ButtonStyle.Danger))];
  return {
    send: async (text: string, o?: { progress?: boolean }) => {
      const ch = await fetchCh();
      const m = await ch.send({ content: text, components: o?.progress ? stopRow() : [], ...(o?.progress ? QUIET : NO_PINGS) });
      return { edit: async (t: string, final?: boolean) => void (await m.edit({ content: t, components: o?.progress && !final ? stopRow() : [], allowedMentions: { parse: [] } })) };
    },
    deliver: async (answer: string, runStartMs: number) => void (await sendText(await fetchCh(), answer, undefined, undefined, false, undefined, undefined, [], runStartMs, undefined, [workDir])),
    extraSystem: [
      "Discord bridge rules (you answer in the owner's private Discord channel):",
      ASK_BLOCK_RULE,
      `- To upload a file with your answer, write it under ${workDir} and put a line \`📎 attach: <absolute path>\` in the answer (max 10 MB each, up to 10 files).`,
      "- Keep answers concise and mobile-friendly Markdown. The owner can tap Stop at any time; messages sent during your turn run after it.",
    ].join("\n"),
  };
}
// 🧠-local-omp channels (config localOmpChannelIds): one LocalOmpChat per channel, each with its own session and work dir.
const localOmps = new Map(
  CONFIG.localOmpChannelIds.map((id, i) => [
    id,
    new LocalOmpChat({
      stateDir: STATE_DIR,
      ...instanceFor(i),
      tools: CONFIG.localOmpTools,
      log,
      ...harnessDeps(id, instanceFor(i).workDir),
    }),
  ]),
);
// 🔓-openrouter-venice channels (owner 2026-10-19): same sandboxed turn, pinned to Venice Uncensored on OpenRouter.
CONFIG.veniceChannelIds.forEach((id, i) => {
  if (localOmps.has(id)) return;
  const suffix = i === 0 ? "" : `-${i + 1}`;
  localOmps.set(
    id,
    new LocalOmpChat({
      stateDir: STATE_DIR,
      key: `venice${suffix}`,
      workDir: join(homedir(), "discord-scratch", `venice${suffix}`),
      label: `${VENICE_LABEL}${suffix}`,
      profile: veniceProfile(),
      log,
      ...harnessDeps(id, join(homedir(), "discord-scratch", `venice${suffix}`)),
    }),
  );
});
// 🔓 FIRSTMATE uncensored channels (owner 2026-10-22): a coordinator session on Venice Uncensored 1.2.
// Own history and work dir; every role is that one model, so no Claude turn can happen here.
CONFIG.uncensoredChannelIds.forEach((id, i) => {
  if (localOmps.has(id)) return;
  const suffix = i === 0 ? "" : `-${i + 1}`;
  const workDir = join(homedir(), "discord-scratch", `uncensored${suffix}`);
  localOmps.set(
    id,
    new LocalOmpChat({
      stateDir: STATE_DIR,
      key: `uncensored${suffix}`,
      workDir,
      label: `${UNCENSORED_LABEL}${suffix}`,
      profile: uncensoredProfile(),
      tools: UNCENSORED_TOOLS,
      log,
      ...harnessDeps(id, workDir),
    }),
  );
});
/** The sandboxed chat that owns this channel: a pinned 🧠/Venice channel. null = the normal trusted OMP path (any /models pick and the 🔓-unrestricted-qwen channel). */
function pinnedChatFor(channelId: string, parentId: string | null = null): LocalOmpChat | null {
  if (parentId && localOmps.has(parentId)) return null; // threads under a pinned channel are ignored
  return localOmps.get(channelId) ?? null;
}
/**
 * Owner text from a button, menu, voice answer or restored job in a pinned-model channel (or a thread of one):
 * hand it to that model. True = handled (never a Claude turn). Same decision as the MessageCreate routing.
 */
function routePinned(channel: Message["channel"], text: string): boolean {
  const parentId = channel.isThread() ? channel.parentId : null;
  if (parentId && localOmps.has(parentId)) return true; // threads under a pinned channel are ignored
  const lo = pinnedChatFor(channel.id, parentId);
  if (!lo) return false;
  if (text.trim()) lo.handle(text).catch((e) => log(`pinned owner turn: ${(e as Error).message}`));
  return true;
}
/** Open question menus: ONE source for the 🔔 Needs-you board and the 📋 Master queue (owner 2026-10-24, card mq-needs-menus). */
const needsMenuSource: MenuSource = {
  asksFile: join(STATE_DIR, "asks.json"),
  guildId: GUILD_ID,
  chanInfo: async (id) => {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || ch.isDMBased()) return null;
    const name = "name" in ch && ch.name ? ch.name : "";
    const parent = ch.isThread() ? ch.parent : null;
    const pid = parent ? parent.parentId : "parentId" in ch ? ch.parentId : null;
    const archived = ARCHIVE_IDS.includes(pid ?? "") || (!!parent && ARCHIVE_IDS.includes(parent.id));
    return { name, archived, finance: isFinanceChannel(id, [name, parent?.name]) };
  },
};
/** 🔔-needs-you board (owner 2026-10-22, card needs-you-channel): kept as the channel's last message. */
const needsYou = NEEDS_YOU_CHANNEL_ID
  ? new NeedsYouBoard({
      getChannel: async () => {
        const ch = await client.channels.fetch(NEEDS_YOU_CHANNEL_ID).catch(() => null);
        // discord.js TextChannel satisfies the BoardChannel subset; the structural types differ in overloads.
        return ch?.isSendable() && "messages" in ch ? (ch as unknown as BoardChannel) : null;
      },
      botId: () => client.user?.id,
      itemsFile: process.env.OMP_FM_ITEMS ?? join(FM_DIR, "items.json"),
      stateFile: join(STATE_DIR, "needs-you-state.json"),
      dash: DASHBOARD_BASE_URL,
      log,
      ...needsMenuSource,
      ownerId: OWNER_ID,
      notice: () => pauseLine(readPause()),
      paused: () => !!readPause(),
    })
  : null;
/**
 * 📋 Master queue (owner 2026-10-23): every job (bot runs in all channels + FIRSTMATE cards with a job) in one
 * live board in the FIRSTMATE channel, kept at the bottom (only the ⏳ Queue box may sit below it).
 */
function masterJobView(id: number, label: string, preview: string | undefined): Omit<LiveJob, "running" | "since"> {
  const channelId = jobKeys.get(id) ?? "";
  const name = CHANNELS[channelId]?.name ?? label.split(" ", 1)[0]?.replace(/^#/, "");
  // Finance channels: no message text on the FIRSTMATE board (it can carry positions or account data).
  const title = isFinanceChannel(channelId, [name]) ? `Finance job #${id}` : preview || label;
  const link = jobOwnerLinks.get(id) ?? jobLinks.get(id);
  const stack = jobStacks.get(id);
  return { id, title, channelId, ...(link ? { link } : {}), ...(stack ? { stack } : {}) };
}
/** Card `job` (Herdr pane/tab id or tab label) -> its mirrored Discord channel or tab name (agents.json, cached 30 s). */
let agentsCache: { at: number; list: Array<{ machine?: string; paneId?: string; tabId?: string; tab?: string; channelId?: string; archived?: boolean }> } = { at: 0, list: [] };
/** Live main Herdr panes/tabs (cached 30 s); null when Herdr did not answer. */
let herdrCache: { at: number; snap: { panes: HerdrPane[]; tabs: HerdrTab[] } | null } = { at: 0, snap: null };
function herdrSnapshot(): { panes: HerdrPane[]; tabs: HerdrTab[] } | null {
  if (Date.now() - herdrCache.at < 30_000) return herdrCache.snap;
  const run = (what: "pane" | "tab") => {
    const r = spawnSync("herdr", [what, "list"], { encoding: "utf8", timeout: 5_000 });
    return r.status === 0 ? r.stdout : "";
  };
  const panes = parseHerdrPanes(run("pane"));
  const tabs = panes ? parseHerdrTabs(run("tab")) : null;
  herdrCache = { at: Date.now(), snap: panes && tabs ? { panes, tabs } : null };
  return herdrCache.snap;
}
function masterJobPlace(job: string): JobPlace | undefined {
  if (Date.now() - agentsCache.at > 30_000) {
    try {
      agentsCache = { at: Date.now(), list: JSON.parse(readFileSync(join(STATE_DIR, "agents.json"), "utf8")) };
    } catch {
      agentsCache = { at: Date.now(), list: [] };
    }
  }
  // Herdr ids are per host: a second machine pane can share a short id with a main pane; card jobs are main panes.
  const a = agentsCache.list.find((x) => (x.machine ?? "main") === "main" && (x.paneId === job || x.tabId === job || x.tab === job));
  // Owner 2026-10-24: a live pane without a mirror entry still names its tab; "closed tab" only when Herdr confirms it.
  const snap = herdrSnapshot();
  const live = snap ? herdrPlace(job, snap.panes, snap.tabs) : undefined;
  if (!a) return live;
  return {
    ...(a.channelId && !a.archived ? { channelId: a.channelId } : {}),
    ...(a.tab ? { tab: a.tab } : live?.tab ? { tab: live.tab } : {}),
    ...(live?.session ? { session: live.session } : {}),
  };
}
const masterQueue = FIRSTMATE_CHANNEL_ID
  ? new MasterQueueBoard({
      getChannel: async () => {
        const ch = await client.channels.fetch(FIRSTMATE_CHANNEL_ID).catch(() => null);
        return ch?.isSendable() && "messages" in ch ? (ch as unknown as BoardChannel) : null;
      },
      botId: () => client.user?.id,
      jobs: () => {
        const st = queue.status();
        return [
          ...st.running.map((j) => ({ ...masterJobView(j.id, j.label, j.preview), running: true, since: j.since })),
          ...st.queued.map((j) => ({ ...masterJobView(j.id, j.label, j.preview), running: false, since: j.since })),
        ];
      },
      mayBeBelow: (m) => isBoardText(m.content),
      notice: () => pauseLine(readPause()),
      itemsFile: process.env.OMP_FM_ITEMS ?? join(FM_DIR, "items.json"),
      receiptsDir: join(FM_DIR, "receipts"),
      stateFile: join(STATE_DIR, "master-queue.json"),
      dash: DASHBOARD_BASE_URL,
      log,
      menus: needsMenuSource,
      resolvers: {
        stackChannel: (s) => stackRouter.tracker.threads[s],
        job: (job) => masterJobPlace(job),
        areaStack: (area) => {
          const a = area.toLowerCase().trim();
          const pre = a.split(":")[0]!.trim();
          return stackRouter.cfg.stacks.find((s) => [a, pre].some((x) => x && (x === s.name || s.areas.some((y) => y.toLowerCase() === x))))?.name;
        },
      },
    })
  : null;
/** Job id -> its reply thread in an alert channel; archived 90 s after its last job ends (owner 2026-10-23). */
const transientThreads = new Map<number, { id: string; archived: boolean | null; setArchived: (v: boolean, reason?: string) => Promise<unknown> }>();
/**
 * Owner 2026-10-24: alert-channel threads must not sit there. Every 2 min, archive each active thread in #needs-you and
 * alert channels that has no queued/running job and no message in the last 2 min (covers restarts and paths that
 * never registered the thread, e.g. triage and voice notes).
 */
setInterval(() => {
  const parents = new Set([NEEDS_YOU_CHANNEL_ID, ...Object.keys(ALERT_CHANNELS)].filter(Boolean));
  if (!parents.size || !client.isReady()) return;
  void (async () => {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    const act = await guild?.channels.fetchActiveThreads().catch(() => null);
    if (!act) return;
    const st = queue.status();
    const busy = new Set([...st.running, ...st.queued].map((j) => jobKeys.get(j.id)).filter(Boolean));
    const withMenu = asks.openChannels();
    for (const t of act.threads.values()) {
      if (!t.parentId || !parents.has(t.parentId) || busy.has(t.id) || withMenu.has(t.id) || t.archived) continue;
      const last = t.lastMessageId ? Number((BigInt(t.lastMessageId) >> 22n) + 1420070400000n) : (t.createdTimestamp ?? 0);
      if (Date.now() - last < 120_000) continue;
      await t.setArchived(true, "idle alert-channel thread").then(() => log(`archived idle alert thread ${t.id}`), (e) => log(`archive idle thread ${t.id}: ${(e as Error).message}`));
    }
  })();
}, 120_000).unref();
function closeTransientThread(jobId: number): void {
  const th = transientThreads.get(jobId);
  transientThreads.delete(jobId);
  if (!th) return;
  setTimeout(() => {
    if ([...transientThreads.values()].some((x) => x.id === th.id) || th.archived) return;
    th.setArchived(true, "alert-channel reply finished").then(() => log(`archived finished alert thread ${th.id}`), (e) => log(`archive alert thread ${th.id}: ${(e as Error).message}`));
  }, 90_000);
}
queue.onSettled = (j, res, err) => {
  closeTransientThread(j.id);
  masterQueue?.finished(j.id, err ? "failed" : res?.cancelled ? "stopped" : res?.ok ? "done" : "failed", masterJobView(j.id, j.label, j.preview));
  jobOwnerLinks.delete(j.id);
  stackRouter.ended(j.id, res?.cancelled ? undefined : Boolean(res?.ok && !err));
  jobStacks.delete(j.id);
};

/**
 * Route one new owner message in the FIRSTMATE channel. True: it went to a stack thread (the copy there runs
 * as the owner's turn). False: it stays with FIRSTMATE (general stack, router off, command, reply/menu answer
 * to a FIRSTMATE message, pinned /models channel).
 */
async function routeFirstmate(
  msg: Message,
  text: string,
  attachments: { name: string; url: string }[],
  asOwner: { authorId: string; fromVoice?: boolean; restored?: boolean; menuIds?: string[] } | undefined,
  replyRef: string | undefined,
  parentId: string | null,
): Promise<boolean> {
  if (!stackRouter.cfg.enabled || msg.channel.type !== ChannelType.GuildText) return false;
  // Bot-written owner turns (Undo, handoff, menu answers, restored jobs) stay with FIRSTMATE; spoken call turns route.
  if (asOwner && !(asOwner.fromVoice && !asOwner.restored && asOwner.menuIds === undefined)) return false;
  if (!text.trim() || text.startsWith("!") || text.startsWith("/")) return false;
  if (models.resolveOverride(modelOverrides, msg.channelId, parentId)) return false; // a pinned model keeps FIRSTMATE's own session
  // A reply or a menu answer follows the message it answers: its stack if routed, else FIRSTMATE.
  const ids = [msg.id, replyRef, msg.reference?.messageId];
  if (replyRef) {
    const ref = await msg.fetchReference().catch(() => null);
    if (ref?.reference?.messageId) ids.push(ref.reference.messageId);
  }
  const inherited = stackRouter.inherited(ids);
  const answering = Boolean(replyRef || asOwner?.menuIds?.length);
  if (answering && !inherited && !forcedStack(text, stackRouter.cfg.stacks)) return false;
  const refs = responseRefs([replyRef], [text]);
  const d = await stackRouter.decide(text, { channelId: msg.channelId, parentId, inherited, cardAreas: stackRouter.cardAreas(refs.itemIds, refs.messageIds) });
  const s = stackRouter.stack(d.stack);
  if (!s || s.name === GENERAL) {
    stackRouter.remember([msg.id], GENERAL);
    return false;
  }
  const body = forcedStack(text, stackRouter.cfg.stacks)?.rest || text;
  let copy: Message;
  try {
    copy = own(await stackRouter.forward(msg, msg.channel, s, d, body));
  } catch (e) {
    log(`router: forward to ${s.name} failed, FIRSTMATE keeps it: ${(e as Error).message}`);
    return false;
  }
  void msg.react("🧭").catch(() => {});
  await markQueued(responseRefs(asOwner ? [msg.id, ...(asOwner.menuIds ?? [])] : [msg.id, replyRef], asOwner?.menuIds ? [] : [text]), { log });
  void handle(copy, { authorId: asOwner?.authorId ?? msg.author.id, text: body, fromVoice: asOwner?.fromVoice, attachments, restored: true }).catch((e) => log(`router: stack ${s.name} handle: ${(e as Error).message}`));
  lastOwnerChannelId = msg.channelId; // spoken turns keep going to FIRSTMATE (the router), not the stack thread
  return true;
}
client.once(Events.ClientReady, () => {
  if (masterQueue) {
    log(`master queue board: channel ${FIRSTMATE_CHANNEL_ID}`);
    masterQueue.start();
  }
  if (needsYou) {
    log(`needs-you board: channel ${NEEDS_YOU_CHANNEL_ID}`);
    needsYou.start();
  }
  // Owner alert pause: the boards show the 🔕 line; the pause end posts one digest of the held alerts.
  // Held alerts but no pause (it ended while the bot was down): start as "paused", so the first check posts the digest.
  pauseUntil = readPause()?.until ?? (existsSync(HELD_FILE) ? 1 : 0);
  setInterval(() => void checkAlertPause(), 30_000);
});
let pauseUntil = 0;
let pauseChecking = false;
async function checkAlertPause(): Promise<void> {
  if (pauseChecking) return;
  pauseChecking = true;
  try {
    const t = pauseTransition(pauseUntil);
    pauseUntil = t.until;
    if (!t.event) return;
    log(`alert pause: ${t.event}${t.until ? ` until ${new Date(t.until).toISOString()}` : ""}`);
    masterQueue?.schedule(0, true);
    needsYou?.schedule(0, true);
    if (t.event !== "resumed") return;
    const ch = await privateChannel(DEV_CHANNEL_ID);
    // pauseUntil = 1: "still paused" for the next check, so the digest is tried again (it is never dropped).
    if (!ch) return void ((pauseUntil = 1), log("alert pause: #omp-alerts unavailable; digest retried in 30 s"));
    const { held, saved } = takeHeld();
    // Held texts never went through prepareOutbound: redact them like every other post.
    const clean = held.map((h) => ({ ...h, text: redactKnownSecrets(redact(h.text).text).text }));
    try {
      await ch.send({ content: resumeDigest(clean, saved), ...NO_PINGS });
    } catch (e) {
      if (saved) restoreHeld(saved);
      pauseUntil = 1;
      throw e;
    }
  } catch (e) {
    log(`alert pause check: ${(e as Error).message}`);
  } finally {
    pauseChecking = false;
  }
}
/** `/alerts` (owner alert pause switch). The state change itself is picked up by checkAlertPause. */
function alertsCommand(action: string, reason: string): string {
  if (action === "status") {
    const p = readPause();
    return p ? pauseLine(p) : "🔔 Owner alerts are on.";
  }
  if (action === "resume") {
    const was = clearPause();
    void checkAlertPause();
    return was ? "🔔 Owner alerts resumed. The held alerts follow in #omp-alerts as one message." : "🔔 Owner alerts were not paused.";
  }
  const ms = parseDuration(action);
  if (!ms) return `⚠️ Unknown action "${action}".`;
  const p = setPause(ms, reason, "discord:/alerts");
  void checkAlertPause();
  return `${pauseLine(p)}\nNew #omp-alerts posts are held and sent as one digest when the pause ends. Sign-in and password waits still notify.`;
}
/**
 * Owner 2026-10-25 (card answered-clears-needs): the instant the owner answers a menu, any way, it leaves the
 * Needs-you lists: the ask set is marked answered (boards hide it) and its linked cards move to partial
 * "📨 answered HH:MM; working" (markQueued), even when the work is not done.
 */
function noteMenuAnswer(messageIds: (string | undefined)[], via: AnswerVia): void {
  const ids = asks.markAnswered(messageIds, via);
  if (!ids.length) return;
  log(`ask: owner answered (${via}) ${ids.join(", ")}`);
  const menuIds = ids.flatMap((id) => Object.values(asks.openSets().find((s) => s.setId === id)?.messageIds ?? asks.closedSet(id)?.messageIds ?? {}));
  void markQueued(responseRefs(menuIds, []), { log });
  needsYou?.schedule(1_000);
}
async function noteOwnerAnswer(msg: Message, asOwner: { restored?: boolean; menuIds?: string[] } | undefined): Promise<void> {
  try {
    if (asOwner) {
      // Bot-written owner turns: only late taps / ✏️ answers carry menuIds (button picks are recorded in asks.answer).
      if (asOwner.menuIds?.length && !asOwner.restored) noteMenuAnswer(asOwner.menuIds, "late");
      return;
    }
    const replyRef = msg.reference?.messageId;
    if (!replyRef) return; // typed text without a reply names no menu (one channel holds menus of many topics)
    // One hop up too: a reply in a stack thread to the copy/answer that itself points at the menu.
    const ref = await msg.fetchReference().catch(() => null);
    const stack = stackRouter.stackByThread(msg.channel.isThread() ? msg.channelId : null);
    noteMenuAnswer([replyRef, ref?.reference?.messageId], stack ? "stack-thread" : "reply");
  } catch (e) {
    log(`ask: answer mark failed: ${(e as Error).message}`);
  }
}
// Owner ✅ reaction on a bot message = "I did it" (src/reactdone.ts, owner 2026-10-23).
const doneFollowUps = new DoneFollowUps((messageId) => void startDoneFollowUp(messageId));
const doneChannels = new Map<string, string>();
async function startDoneFollowUp(messageId: string): Promise<void> {
  const channelId = doneChannels.get(messageId);
  doneChannels.delete(messageId);
  if (!channelId) return;
  await markOwnerDone(messageId, { log }); // after the cancel window, so a removed ✅ changes nothing
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased() || !("send" in ch)) return;
    const guildPart = "guildId" in ch && ch.guildId ? ch.guildId : "@me";
    const link = `https://discord.com/channels/${guildPart}/${channelId}/${messageId}`;
    const text = followUpText(link);
    const note = await ch.send({ content: text, reply: { messageReference: messageId, failIfNotExists: false }, ...QUIET });
    log(`react-done: follow-up turn for ${messageId}`);
    await handle(note, { authorId: OWNER_ID, text });
  } catch (e) {
    log(`react-done: follow-up failed: ${(e as Error).message}`);
  }
}
async function ownerDoneReaction(r: MessageReaction | PartialMessageReaction, userId: string, added: boolean): Promise<void> {
  if (userId !== OWNER_ID || !isDoneEmoji(r.emoji.name)) return;
  if (!added) {
    if (doneFollowUps.remove(r.message.id)) {
      doneChannels.delete(r.message.id);
      log(`react-done: owner removed ✅ on ${r.message.id}; follow-up cancelled`);
    }
    return;
  }
  if (r.partial) r = await r.fetch();
  const msg = r.message.partial ? await r.message.fetch() : r.message;
  if (!isOwnerDone({ emoji: r.emoji.name, reactorId: userId, ownerId: OWNER_ID, messageAuthorId: msg.author?.id, botId: client.user?.id })) return;
  doneChannels.set(msg.id, msg.channelId);
  noteMenuAnswer([msg.id], "reaction");
  if (doneFollowUps.add(msg.id)) log(`react-done: owner ✅ on ${msg.id}; follow-up queued`);
}
client.on(Events.MessageReactionAdd, (r, user) => {
  if (needsYou && r.message.channelId === NEEDS_YOU_CHANNEL_ID) needsYou.onReaction(user.id);
  void ownerDoneReaction(r, user.id, true).catch((e) => log(`react-done: ${(e as Error).message}`));
});
client.on(Events.MessageReactionRemove, (r, user) => {
  void ownerDoneReaction(r, user.id, false).catch((e) => log(`react-done: ${(e as Error).message}`));
});
client.on(Events.MessageCreate, (msg) => {
  if (needsYou && msg.channelId === NEEDS_YOU_CHANNEL_ID) needsYou.onMessage(msg);
  if (masterQueue && msg.channelId === FIRSTMATE_CHANNEL_ID) masterQueue.onMessage(msg);
  // 🧠-local-omp channels: never reach Claude. Owner → one local-model OMP turn; everyone else is ignored.
  // Threads under a local-omp channel never reach the mirror or Claude: they are ignored.
  const loParent = msg.channel.isThread() ? msg.channel.parentId : null;
  if (loParent && localOmps.has(loParent)) return;
  const lo = localOmps.get(msg.channelId);
  if (lo) {
    const ompRoute = routeLocalOmp({ channelId: msg.channelId, authorId: msg.author.id, bot: msg.author.bot }, msg.channelId, OWNER_ID);
    if (ompRoute === "local-omp" && msg.content.trim()) lo.handle(msg.content).catch((e) => log(`local-omp: ${(e as Error).message}`));
    return;
  }
  // 🧠-local-model: this channel never reaches OMP/Claude. Owner → local model; everyone else is ignored.
  const route = routeMessage({ channelId: msg.channelId, authorId: msg.author.id, bot: msg.author.bot }, LOCAL_MODEL_CHANNEL_ID, OWNER_ID);
  if (route !== "other") {
    if (route === "local" && msg.content.trim()) localModel.handle(msg.content).catch((e) => log(`local-model: ${(e as Error).message}`));
    return;
  }
  if (!(msg.author.id === client.user?.id && (isBoardText(msg.content) || isMasterBoard(msg.content)))) keepBoardLast(msg.channelId);
  if (msg.author.id === OWNER_ID && !queueBoards.has(msg.channelId)) void clearStaleBoards(msg);
  handle(msg).catch((e) => log(`handler error: ${(e as Error).message}`));
});
/** Owner joins "🎧 OMP Voice" = voice mode on; owner leaves = off. Nobody else can turn it on. */
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.id !== OWNER_ID || newState.guild.id !== GUILD_ID) return;
  if (newState.channelId === oldState.channelId) return;
  if (newState.channelId === VOICE_CHANNEL_ID && newState.channel) {
    voicechat.ownerJoined();
    void voicechat.stay(newState.channel).catch((e) => log(`voice join: ${(e as Error).message}`)); // no-op when already connected
    return;
  }
  if (oldState.channelId === VOICE_CHANNEL_ID) voicechat.ownerLeft();
});
async function handleApproveButton(i: ButtonInteraction): Promise<void> {
  const ok = buttonAllowed({
    userId: i.user.id,
    ownerId: OWNER_ID,
    guildId: i.guildId,
    ownGuildId: GUILD_ID,
    isDM: !i.inGuild(),
    messageAuthorId: i.message.author.id,
    botId: client.user?.id,
  });
  if (!ok) {
    log(`approve-button: refused from ${i.user.id}`);
    await i.reply({ content: "Only the owner can approve.", flags: MessageFlags.Ephemeral });
    return;
  }
  const id = i.customId.slice(APPROVE_PREFIX.length);
  const r = approvals.approveButton(id, "the owner");
  log(`approve-button: ${id} -> ${r}`);
  const text = {
    started: `▶️ \`${id}\` approved — running. The result follows here.`,
    gone: `\`${id}\` is no longer pending (already ran, denied or expired).`,
    changed: `\`${id}\` changed after it was posted. Nothing ran.`,
    expired: `\`${id}\` expired. Nothing ran.`,
    unknown: `\`${id}\` is not a pending approval I posted.`,
    off: "Trusted mode is off, so the button is disabled. Use the HEELER approval tab.",
  }[r];
  await i.update({ components: [] }).catch(() => {});
  await i.followUp({ content: text, ...QUIET });
}

// OMP session commands (card omp-discord-commands-build, owner pick 2026-10-21). Phases are switched on one by
// one after their live test (SESSION_PHASES); src/sessioncmds.ts holds the commands, docs/omp-commands.md the routes.
const SESSION_PHASES = 3;
const SESSION_COMMANDS = [PHASE1, PHASE2, PHASE3].slice(0, SESSION_PHASES).flat();
const SESSION_NAMES = new Set(SESSION_COMMANDS.map((c) => c.name));
/** The OMP session a Discord channel/thread uses for normal turns (same key logic as handle()). */
function sessionCtxFor(channel: Interaction["channel"], channelId: string): SessionCtx | string {
  if (!channel) return "I can't see this channel.";
  const isThread = channel.isThread();
  const parentId = isThread ? channel.parentId : null;
  const threadId = isThread ? channelId : null;
  const model = models.resolveOverride(modelOverrides, channelId, parentId);
  const ctx = (key: string, cwd: string): SessionCtx => {
    const k = qwenSessionKey(key, model);
    return { key: k, dir: sessionDir(k), cwd, channelId, model, isolatedArgs: isolatedTag(model) ? modelArgs(model) : [] };
  };
  const sk = stackRouter.stackByThread(threadId);
  if (sk) return ctx(stackSessionKey(sk.name), sk.cwd);
  const m = mirror.byChannel(parentId ?? channelId);
  if (m) {
    // Mirrored Herdr channels: turns may continue the pane's own session file, and FIRSTMATE must never be
    // compacted/cleared/branched from here. Only read-only views work (WRITE_ACTIONS are refused).
    const c = ctx(sideSessionKey(m, threadId), m.cwd && existsSync(m.cwd) ? m.cwd : join(homedir(), "Github"));
    return { ...c, protectedReason: `#${m.name} mirrors a Herdr pane${c.key === FIRSTMATE_SESSION.key ? " (FIRSTMATE)" : ""}. Only read-only views work here; change that session in the pane itself.` };
  }
  const isDM = channel.type === ChannelType.DM;
  const r = route({ authorId: OWNER_ID, authorIsBot: false, guildId: isDM ? null : GUILD_ID, channelId, isDM, isThread, parentId });
  if (r.kind === "ignore") return "This channel has no OMP session.";
  if (r.kind === "dm") return ctx(`dm-${channelId}`, r.cwd);
  if (r.kind === "thread") return ctx(channelId, r.cwd);
  if (channel.type === ChannelType.GuildVoice) return ctx(`voice-${channelId}`, r.cwd);
  return "Each task thread here has its own session. Use this command inside the thread.";
}
const sessionCmds = new SessionCommands({
  ownerId: OWNER_ID,
  ompBin: OMP_BIN,
  stateFile: join(STATE_DIR, "session-commands.json"),
  overlayDir: join(STATE_DIR, "mode-overlays"),
  resolve: sessionCtxFor,
  busy: (channelId) => [...queue.status().running, ...queue.status().queued].some((x) => jobKeys.get(x.id) === channelId),
  runTurn: async (channel, text) => {
    const note = own(await channel.send({ content: text, ...QUIET }));
    await handle(note, { authorId: OWNER_ID, text });
  },
  jobs: () => {
    const st = queue.status();
    return [
      ...st.running.map((j) => ({ id: j.id, label: j.preview || j.label, channelId: jobKeys.get(j.id) ?? "", since: j.since, running: true })),
      ...st.queued.map((j) => ({ id: j.id, label: j.preview || j.label, channelId: jobKeys.get(j.id) ?? "", since: j.since, running: false })),
    ];
  },
  stopJob: (id) => {
    if (cancelQueued(id)) {
      return "🛑 Cancelled before it started.";
    }
    const key = jobKeys.get(id);
    if (key && stopRun(key)) return "🛑 Stopping…";
    return "That job already finished.";
  },
  sessionDirFor: (key) => sessionDir(key),
  log,
});
/** 🔁 Retry under a failed run: job id -> the message and text to run again. */
const retryJobs = new Map<string, { msg: Message; text: string; attachments: { name: string; url: string }[] }>();
/** UX item 7: owner messages that already had their one automatic retry. */
const autoRetried = new RetryLedger();

// Owner 2026-10-15: /cpu, /gpu, /memory and /stats report the main host's usage; /usage shows AI provider limits
// like `omp usage`; /rgb toggles the main host lights (state:on|off sets them). Guild commands (they appear at once).
const STAT_COMMANDS: (ApplicationCommandDataResolvable & { name: string })[] = [
  { name: "cpu", description: "Main CPU usage, load, temperature and top programs" },
  { name: "gpu", description: "Main GPU load, VRAM, temperature, power and top programs" },
  { name: "memory", description: "Main memory and swap usage and top programs" },
  { name: "stats", description: "Main CPU, GPU and memory in one report" },
  { name: "usage", description: "AI provider usage limits for every account (like omp usage)" },
  {
    name: "rgb",
    description: "Toggle all main lights, or set them on or off",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "state",
        description: "on or off (leave empty to toggle)",
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
        ],
      },
    ],
  },
  ...(() => {
    const svc = (list: readonly string[], desc: string) => ({
      type: ApplicationCommandOptionType.String as const,
      name: "service",
      description: desc,
      required: true,
      choices: list.map((s) => ({ name: s, value: s })),
    });
    return [
      { name: "services", description: "Status of the bot, radio, account monitor, stream server and other services" },
      { name: "logs", description: "Last 20 log lines of one service", options: [svc(Object.keys(main.SERVICES), "Which service")] },
      { name: "disk", description: "Free space per drive and the largest folders in ~" },
      { name: "restart", description: "Restart one service (asks first)", options: [svc(main.RESTARTABLE, "Which service")] },
      { name: "panes", description: "Herdr tabs on the main host" },
      { name: "net", description: "Tailscale exit node, egress location, ping to the peer machine" },
      { name: "stream", description: "stream server status, monitor power and VRAM leak check" },
      {
        name: "remind",
        description: "Set an Omarchy reminder on the main host, in plain words",
        options: [
          { type: ApplicationCommandOptionType.String as const, name: "what", description: "When and what, e.g. in 2 hours call mom · tomorrow 9am pay rent", required: true, max_length: 300 },
        ],
      },
      { name: "nest", description: "Nest thermostat temperatures and modes" },
      {
        name: "blinds",
        description: "TaHoma blinds: list plus open/stop/close/My buttons",
        options: [{ type: ApplicationCommandOptionType.String as const, name: "blind", description: "Blind or room, e.g. office, living room, master bedroom 2 (default: all)", required: false, max_length: 60 }],
      },
      { name: "radio", description: "Lofi Radio status and recent log" },
      { name: "updates", description: "Pending repo and AUR updates (list only)" },
      { name: "second", description: "Is the peer machine reachable, uptime and battery" },
      { name: "automations", description: "All timers (main + remote host): next/last run, result; Run now / Pause / Resume" },
    ];
  })(),
  { name: "models", description: "Show or switch the model used in this channel" },
  { name: "model", description: "Show or switch the model used in this channel (same as /models)" },
  {
    name: "alerts",
    description: "Pause or resume owner alerts (#omp-alerts, Needs-you pings, OMP notices); every pause ends by itself",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "action",
        description: "Pause for how long, resume now, or show the state",
        required: true,
        choices: ["1h", "4h", "8h", "24h", "resume", "status"].map((v) => ({ name: /^\d/.test(v) ? `pause ${v}` : v, value: v })),
      },
      { type: ApplicationCommandOptionType.String, name: "reason", description: "Shown on the boards (optional)", required: false },
    ],
  },
  { name: "help", description: "List the bot's slash commands" },
];
/** /help text: every registered command with its description and options. */
function helpText(): string {
  const lines = ["📖 **Slash commands**", "———————————"];
  for (const c of STAT_COMMANDS.filter((x) => commandEnabled(x.name))) {
    const opts = "options" in c && Array.isArray(c.options) ? (c.options as { name: string; choices?: { name: string }[] }[]) : [];
    const args = opts.map((o) => ` [${o.name}:${o.choices?.map((x) => x.name).join("|") ?? "…"}]`).join("");
    lines.push(`\`/${c.name}${args}\` · ${"description" in c ? c.description : ""}`);
  }
  for (const c of SESSION_COMMANDS) lines.push(`\`/${c.name}\` · ${"description" in c ? c.description : ""}`);
  lines.push("`/handoff to:<channel> [note]` · Move this conversation to another channel (also: long-press a message → Apps → Send to another channel)");
  lines.push("", "💬 Anything else: just write a message here.");
  return lines.join("\n");
}
// Owner 2026-10-19 watchdog: every 10 s, a listed channel whose last message is a plain time-limit stop and that
// has no running/queued job gets "continue" (a stop the in-run auto-continue missed, e.g. right before a restart).
const watchdogHandled = new Set<string>();
client.once(Events.ClientReady, () => {
  const ids = [...new Set([...CONFIG.timeLimitContinueChannelIds, ...CONFIG.unrestrictedChannelIds])];
  if (!ids.length) return;
  log(`continue watchdog: ${ids.length} channel(s), every 10 s`);
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const id of ids) {
        const ch = await client.channels.fetch(id).catch(() => null);
        if (!ch || !ch.isTextBased() || ch.isDMBased()) continue;
        // Newest first; 10 messages, because board reprints and split partial output can follow the notice.
        const recent = [...((await ch.messages.fetch({ limit: 10 }).catch(() => null))?.values() ?? [])];
        const busy = [...jobKeys.values()].includes(id);
        const hit = watchdogContinue(recent.map((m) => ({ id: m.id, fromBot: m.author.id === client.user?.id, content: m.content })), busy, watchdogHandled);
        const last = hit ? recent.find((m) => m.id === hit) : undefined;
        if (!hit || !last) continue;
        watchdogHandled.add(hit);
        log(`continue watchdog: ${id} stopped at the time limit; sending continue`);
        await ch.send({ content: "🔁 Watchdog: the last turn stopped at the time limit. Continuing automatically.", ...QUIET }).catch(() => {});
        void handle(last, { authorId: OWNER_ID, text: "continue", attachments: [], restored: true }).catch((e) => log(`continue watchdog ${id}: ${(e as Error).message}`));
      }
    } finally {
      running = false;
    }
  }, 10_000);
});
client.once(Events.ClientReady, (c) => {
  // Owner 2026-10-15: swap the old board's "Restart pending" line for "Restarted".
  const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_DIR, encoding: "utf8" }).stdout.trim();
  for (const [chId, msgId] of Object.entries(takePendingBoards(STATE_DIR))) {
    void (async () => {
      const ch = await c.channels.fetch(chId).catch(() => null);
      if (!ch?.isTextBased()) return;
      const m = await ch.messages.fetch(msgId).catch(() => null);
      if (!m) return void log(`restarted: board ${msgId} gone`);
      const text = markRestarted(m.content, rev);
      if (text !== m.content) await m.edit({ content: text }).then(() => log(`board ${msgId}: marked restarted`)).catch((e) => log(`restarted edit: ${(e as Error).message}`));
    })();
  }
  const guild = c.guilds.cache.get(GUILD_ID);
  if (!guild) return void log("slash commands: guild not in cache");
  guild.commands
    .set([...STAT_COMMANDS.filter((x) => commandEnabled(x.name)), ...SESSION_COMMANDS, ...HANDOFF_COMMANDS])
    .then((set) => log(`slash commands registered: ${[...set.values()].map((x) => `/${x.name}`).join(" ")}`))
    .catch((e) => log(`slash commands: ${(e as Error).message}`));
});
async function handleStatCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (i.user.id !== OWNER_ID) return void (await i.reply({ content: "These commands are for the owner only.", flags: MessageFlags.Ephemeral }));
  if (!commandEnabled(i.commandName)) return void (await i.reply({ content: `/${i.commandName} is turned off (config.json optionalCommands).`, flags: MessageFlags.Ephemeral }));
  if (i.commandName === "restart") {
    // Ask first: a private confirm button; the restart runs only after the owner presses it.
    const svc = i.options.getString("service", true);
    const yes = new ButtonBuilder().setCustomId(`${RSVC_PREFIX}${svc}`).setLabel(`Restart ${svc}`).setEmoji("🔄").setStyle(ButtonStyle.Danger);
    return void (await i.reply({ content: `🔄 Restart **${svc}**?`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(yes)], flags: MessageFlags.Ephemeral }));
  }
  if (i.commandName === "automations") return void (await automations.handleCommand(i, AUTOMATIONS));
  if (i.commandName === "models" || i.commandName === "model") return void (await i.reply({ ...modelsMenu(i.channelId), flags: MessageFlags.Ephemeral }));
  if (i.commandName === "blinds") {
    await i.deferReply();
    const target = (i.options.getString("blind") ?? "all").trim() || "all";
    const text = await main.blinds().catch((e) => `❌ ${(e as Error).message.split("\n")[0]}`);
    return void (await i.editReply({ content: `${text}\n🎯 Buttons act on: **${target}**`, components: blindsRows(target), allowedMentions: { parse: [] } }));
  }
  await i.deferReply();
  let text: string;
  try {
    const name = i.commandName;
    text =
      name === "help" ? helpText()
      : name === "alerts" ? alertsCommand(i.options.getString("action", true), i.options.getString("reason") ?? "")
      : name === "usage" ? await usageReport(OMP_BIN)
      : name === "rgb" ? await setRgb((i.options.getString("state") as "on" | "off" | null) ?? "toggle")
      : name === "services" ? await main.services()
      : name === "logs" ? await main.logs(i.options.getString("service", true), (s) => redact(s).text)
      : name === "disk" ? await main.disk()
      : name === "panes" ? await main.panes()
      : name === "net" ? await main.net()
      : name === "stream" ? await main.stream()
      : name === "remind" ? await main.remind(i.options.getString("what", true))
      : name === "nest" ? await main.nest()
      : name === "radio" ? await main.radio((s) => redact(s).text)
      : name === "updates" ? await main.updates()
      : name === "second" ? await main.second()
      : await rigReport(name as StatKind);
  } catch (e) {
    // Never leave "is thinking…" hanging: answer with the error's first line.
    text = `⚠️ **/${i.commandName} failed:** ${(e as Error).message.split("\n")[0]?.slice(0, 300)}`;
    log(`/${i.commandName} error: ${(e as Error).message}`);
  }
  await i.editReply({ content: text, allowedMentions: { parse: [] } });
}
const RSVC_PREFIX = "rsvc:";
/** Orca #6 (owner 2026-10-19): /automations buttons and menus; every action goes to automations-actions.jsonl. */
const AUTOMATIONS: automations.AutoDeps = { ownerId: OWNER_ID, logFile: join(STATE_DIR, "automations-actions.jsonl"), log };
/** Orca #5 (owner 2026-10-19): Claude plan-limit watch: pinned countdowns + 80 %/95 % alerts in #omp-alerts. */
const limitWatch = new LimitWatch({
  ompBin: OMP_BIN,
  stateFile: join(STATE_DIR, "limitwatch.json"),
  dashboardFile: join(homedir(), "Documents", "reports", "web", "firstmate", "limits.json"),
  alert: async (text) => {
    const ch = await privateChannel(resolveChannel("omp-alerts") ?? "");
    if (!ch) throw new Error("#omp-alerts is not available");
    if (alertHeld(ch.id, text)) return;
    // Threshold alerts notify; reset/recovery notices (✅) are silent.
    await ch.send({ content: text, ...(text.startsWith("✅") ? QUIET : NO_PINGS) });
  },
  pin: async (text, where) => {
    const ch = await privateChannel(where.channel ?? resolveChannel("omp-alerts") ?? "");
    if (!ch || !("messages" in ch)) return null;
    const old = where.message ? await ch.messages.fetch(where.message).catch(() => null) : null;
    if (old) {
      if (old.content !== text) await old.edit({ content: text, ...NO_PINGS });
      return { channel: ch.id, message: old.id };
    }
    const m = own(await ch.send({ content: text, ...QUIET }));
    await m.pin().catch((e) => log(`limitwatch: pin failed: ${(e as Error).message}`));
    return { channel: ch.id, message: m.id };
  },
  log,
});
/** /blinds buttons: row 1 open/stop/close, row 2 positions (percent open). customId = blind:<action>:<target>. */
function blindsRows(target: string): ActionRowBuilder<ButtonBuilder>[] {
  const b = (action: string, label: string, emoji?: string, style = ButtonStyle.Secondary) => {
    const x = new ButtonBuilder().setCustomId(`${main.BLINDS_PREFIX}${action}:${target}`.slice(0, 100)).setLabel(label).setStyle(style);
    return emoji ? x.setEmoji(emoji) : x;
  };
  return [
    // The owner's blinds are one-way RTS motors: no position feedback and no % moves, so no position row.
    new ActionRowBuilder<ButtonBuilder>().addComponents(b("open", "Open", "⬆️", ButtonStyle.Primary), b("stop", "Stop", "⏹️"), b("close", "Close", "⬇️", ButtonStyle.Primary), b("my", "My", "⭐")),
  ];
}
/** Provider picked in the first /models dropdown, per channel (memory only; defaults to the current model's provider). */
const modelsProvider = new Map<string, string>();
/** /models reply (owner 2026-10-25): two dropdowns. 1) provider, 2) a model of that provider (+ "default"). */
function modelsMenu(channelId: string): { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] } {
  const def = models.defaultModel();
  if (localOmps.has(channelId)) return { content: "📌 This channel is pinned to its own sandboxed model; /models cannot change it.", components: [] };
  if (CONFIG.unrestrictedChannelIds.includes(channelId)) return { content: `📌 This channel is pinned to **${models.UNRESTRICTED_MODEL}** (full tools, no sandbox); /models cannot change it.`, components: [] };
  const cur = modelOverrides.get(channelId);
  const grouped = models.listGrouped();
  const provs = models.PROVIDERS.filter((p) => grouped[p.id]?.length);
  const pick = modelsProvider.get(channelId) ?? models.providerOf(cur ?? def);
  const prov = provs.some((p) => p.id === pick) ? pick : (provs[0]?.id ?? "anthropic");
  const provMenu = new StringSelectMenuBuilder()
    .setCustomId(`${models.PROVIDER_PREFIX}${channelId}`)
    .setPlaceholder("1. Pick a provider")
    .addOptions(provs.map((p) => ({ label: `${p.label} (${grouped[p.id]!.length})`.slice(0, 100), value: p.id, emoji: p.emoji, default: p.id === prov })));
  const modelMenu = new StringSelectMenuBuilder()
    .setCustomId(`${models.PREFIX}${channelId}`)
    .setPlaceholder("2. Pick a model")
    .addOptions(
      { label: `default (${def})`.slice(0, 100), value: models.DEFAULT_VALUE, default: !cur },
      ...(grouped[prov] ?? []).map((m) => ({ label: m.slice(0, 100), value: m, default: m === cur, ...(models.modelDescription(m) ? { description: models.modelDescription(m)!.slice(0, 100) } : {}) })),
    );
  return {
    content: cur ? `🧠 Model in this channel: **${cur}**` : `🧠 Model in this channel: **${def}** (default)`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(provMenu), new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelMenu)],
  };
}
client.on(Events.InteractionCreate, (i) => {
  if (i.isChatInputCommand() && i.commandName === "handoff") {
    void handleHandoffCommand(i).catch((e) => log(`handoff error: ${(e as Error).message}`));
    return;
  }
  if (i.isMessageContextMenuCommand() && i.commandName === HANDOFF_MENU_NAME) {
    void handleHandoffMenu(i).catch((e) => log(`handoff menu error: ${(e as Error).message}`));
    return;
  }
  if (i.isChannelSelectMenu() && i.customId.startsWith(HANDOFF_PREFIX)) {
    void handleHandoffPick(i).catch((e) => log(`handoff pick error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(`${SESSION_PREFIX}retry:`)) {
    void handleRetryButton(i).catch((e) => log(`retry error: ${(e as Error).message}`));
    return;
  }
  if (sessionCmds.owns(i) && (!i.isChatInputCommand() || SESSION_NAMES.has(i.commandName))) {
    sessionCmds.handle(i).catch((e) => log(`session command error: ${(e as Error).message}`));
    return;
  }
  if (i.isStringSelectMenu() && i.customId.startsWith(models.PROVIDER_PREFIX)) {
    if (i.user.id !== OWNER_ID) return;
    const ch = i.customId.slice(models.PROVIDER_PREFIX.length);
    modelsProvider.set(ch, i.values[0] ?? "anthropic");
    void i.update(modelsMenu(ch)).catch((e) => log(`models-provider error: ${(e as Error).message}`));
    return;
  }
  if (i.isStringSelectMenu() && i.customId.startsWith(models.PREFIX)) {
    if (i.user.id !== OWNER_ID) return;
    const ch = i.customId.slice(models.PREFIX.length);
    const v = i.values[0] ?? models.DEFAULT_VALUE;
    void (async () => {
      if (localOmps.has(ch)) return void (await i.update(modelsMenu(ch)));
      modelOverrides.set(ch, v === models.DEFAULT_VALUE ? null : v);
      log(`/models ${ch}: ${v}`);
      await i.update(modelsMenu(ch));
    })().catch((e) => log(`models-select error: ${(e as Error).message}`));
    return;
  }
  if (i.isChatInputCommand() && STAT_COMMANDS.some((s) => s.name === i.commandName)) {
    handleStatCommand(i).catch((e) => log(`/${i.commandName} error: ${(e as Error).message}`));
    return;
  }
  if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith(automations.PREFIX)) {
    automations.handleInteraction(i, AUTOMATIONS).catch((e) => log(`automations error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(RSVC_PREFIX)) {
    if (i.user.id !== OWNER_ID) return;
    const svc = i.customId.slice(RSVC_PREFIX.length);
    void (async () => {
      await i.update({ content: `🔄 Restarting **${svc}**…`, components: [] });
      const text = await main.restartService(svc, REPO_DIR).catch((e) => `❌ ${(e as Error).message.split("\n")[0]}`);
      await i.editReply({ content: text });
      log(`/restart ${svc}: ${text}`);
    })().catch((e) => log(`restart-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(main.BLINDS_PREFIX)) {
    if (i.user.id !== OWNER_ID) return;
    const [action = "", ...rest] = i.customId.slice(main.BLINDS_PREFIX.length).split(":");
    const target = rest.join(":");
    void (async () => {
      await i.deferUpdate();
      const head = `${await main.blinds()}\n🎯 Buttons act on: **${target}**`;
      // Owner 2026-10-15: signals don't always get through the walls, so open/close are sent 3x and checked.
      const reps = action === "open" || action === "close" ? " 3×" : "";
      await i.editReply({ content: `${head}\n⏳ Sending **${action}**${reps} and waiting for the box (~${main.blindsEta(action)} s)…`, components: [], allowedMentions: { parse: [] } });
      const result = await main.blindsAct(action, target);
      log(`/blinds ${action} ${target}: ${result}`);
      const note = "\n📻 One-way radio: the box can't see whether a blind moved. If one didn't, press again.";
      await i.editReply({ content: `${head}\n${result}${note}`, components: blindsRows(target), allowedMentions: { parse: [] } });
    })().catch((e) => log(`blinds-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(UNDO_PREFIX)) {
    handleUndoButton(i).catch((e) => log(`undo-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && [DUMP_PREFIX, DUMP_OK_PREFIX, DUMP_NO_PREFIX].some((p) => i.customId.startsWith(p))) {
    handleDumpButton(i).catch((e) => log(`dump-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(LOSTOP_PREFIX)) {
    const cid = i.customId.slice(LOSTOP_PREFIX.length);
    const lo = localOmps.get(cid);
    if (i.user.id !== OWNER_ID) void i.reply({ content: "Only the owner can stop a run.", flags: MessageFlags.Ephemeral }).catch(() => {});
    else if (lo?.stop()) void i.reply({ content: "🛑 Stopping. Queued messages run next.", flags: MessageFlags.Ephemeral }).catch(() => {});
    else void i.reply({ content: "Nothing is running.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (i.isButton() && i.customId.startsWith(CHECK_PREFIX)) {
    handleCheckButton(i).catch((e) => log(`check-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(STOP_PREFIX)) {
    handleStopButton(i).catch((e) => log(`stop-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(QR_PREFIX)) {
    handleQuickReply(i).catch((e) => log(`quick-reply error: ${(e as Error).message}`));
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith(QR_MODAL_PREFIX)) {
    handleQuickReplyModal(i).catch((e) => log(`quick-reply modal error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(SB_PREFIX)) {
    handleScrollback(i).catch((e) => log(`scrollback error: ${(e as Error).message}`));
    return;
  }
  if (i.isModalSubmit() && i.customId.startsWith("askmodal:")) {
    handleAskModal(i).catch((e) => log(`ask-modal error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(ASK_CANCEL_PREFIX)) {
    handleAskCancel(i).catch((e) => log(`ask-cancel error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(ASK_DELETE_PREFIX)) {
    handleAskDelete(i).catch((e) => log(`ask-delete error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(ASK_AGAIN_PREFIX)) {
    handleAskAgain(i).catch((e) => log(`ask-again error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(ASK_PREFIX)) {
    handleAskButton(i).catch((e) => log(`ask-button error: ${(e as Error).message}`));
    return;
  }
  if (i.isButton() && i.customId.startsWith(APPROVE_PREFIX)) {
    handleApproveButton(i).catch((e) => log(`approve-button error: ${(e as Error).message}`));
    return;
  }
  if (!i.isButton() || i.customId !== SEND_BUTTON_ID) return;
  handleSendButton(i).catch((e) => {
    log(`firstmate-send error: ${(e as Error).message}`);
    const reply = { content: "Something went wrong. Nothing was sent.", flags: MessageFlags.Ephemeral } as const;
    void (i.deferred || i.replied ? i.editReply(reply.content) : i.reply(reply)).catch(() => {});
  });
});
client.on(Events.ChannelDelete, (ch) => {
  void mirror
    .closeDeleted(ch.id)
    .then(async (r) => {
      if (!r) return;
      const note = {
        closed: `🗑️ Channel for **${r.tab}** was deleted, so its idle Herdr tab was closed.`,
        busy: `⚠️ Channel for **${r.tab}** was deleted, but its agent is working or waiting for input, so the tab stays open. The channel will be recreated.`,
        unknown: `⚠️ Channel for **${r.tab}** was deleted, but I could not read the tab's state, so it stays open. The channel will be recreated.`,
        failed: `⚠️ Channel for **${r.tab}** was deleted, but closing the Herdr tab failed. It stays open.`,
      }[r.result];
      if (alertHeld(DEV_CHANNEL_ID, note)) return;
      const alerts = await privateChannel(DEV_CHANNEL_ID);
      if (alerts) await alerts.send({ content: note, ...NO_PINGS });
    })
    .catch((e) => log(`channel-delete: ${(e as Error).message}`));
});
client.on(Events.ShardDisconnect, (_e, id) => log(`shard ${id} disconnected`));
client.on(Events.ShardResume, (id) => log(`shard ${id} resumed`));
client.on(Events.Error, (e) => log(`client error: ${e.message}`));

const secretDrops = new SecretDrops();
/** Tailnet origin of the secret form (same host as the dashboard: tailnet-only HTTPS, not the Funnel port). */
const SECRET_DROP_ORIGIN = (() => {
  try {
    return DASHBOARD_BASE_URL ? new URL(DASHBOARD_BASE_URL).origin : "";
  } catch {
    return "";
  }
})();
const mirrorChannel = (ref: string) => {
  const e = mirror.entries.find((x) => !x.archived && (x.channelId === ref || x.name === ref));
  return e ? { id: e.channelId, name: e.name } : null;
};
const server = startHttp({
  health: () => ({ ready: client.isReady(), voice: voicechat.active, boards: boardTimers.size + boardInflight, approvals: activeButtonRuns(), drain: queue.drainInfo(), restoring: toRestore.length, stacks: stackRouter.tracker.status(), ...queue.status() }),
  incident: startTriage,
  drain: (on, ttlMs) => {
    const was = queue.draining();
    const r = queue.drain(on ? (ttlMs ?? DRAIN_TTL_DEFAULT_MS) : 0);
    if (r.draining !== was) {
      log(`drain ${r.draining ? "on: new jobs wait for the restart" : "off"}`);
      for (const ch of queueBoards.keys()) void editBoard(ch, "");
    }
    return r;
  },
  resolveExtra: mirrorChannel,
  holdAlert: alertHeld,
  post: async (channelId, text, files = [], opts) => {
    if (!client.isReady()) throw new Error("gateway not ready");
    if (!CHANNELS[channelId] && !ALERT_CHANNELS[channelId] && !mirrorChannel(channelId)) throw new Error("channel not sendable");
    const ch = await privateChannel(channelId);
    if (!ch) throw new Error("channel not sendable");
    // Owner 2026-10-23: `replyTo` (the owner's request) makes the post and its menus Discord replies to it.
    let replyTo: Message | undefined;
    if (opts?.replyTo) {
      replyTo = ("messages" in ch ? await ch.messages.fetch(opts.replyTo).catch(() => null) : null) ?? undefined;
      if (!replyTo) throw new Error("replyTo message not found in that channel");
    }
    if (opts?.copy) {
      // Owner 2026-10-19: a copy-ready message holds ONLY the text to copy (privacy filter still applies).
      const out = prepareCopy(text);
      if ("error" in out) throw new Error(out.error);
      if (Object.keys(out.hits).length) log(`redacted outbound (copy): ${JSON.stringify(out.hits)}`);
      // SuppressEmbeds: no link preview card under the copy text.
      const m = own(await ch.send({ content: out.content, flags: MessageFlags.SuppressEmbeds, ...NO_PINGS }));
      return postResult({ messages: [m], asks: [] });
    }
    // Owner 2026-10-22: alert channels get no dashboard tail.
    const alert = !!ALERT_CHANNELS[channelId];
    const chName = (ch as { name?: string }).name;
    const sink: SendSink = { messages: [], asks: [] };
    await sendText(ch, text, undefined, replyTo, false, undefined, undefined, files, undefined, undefined, undefined, undefined, alert, sink);
    return postResult(sink);
  },
  messages: async (channelId, limit, before) => {
    if (!client.isReady()) throw new Error("gateway not ready");
    const ch = await privateChannel(channelId);
    if (!ch || !("messages" in ch)) return null;
    const got = await ch.messages.fetch({ limit, ...(before ? { before } : {}) });
    const clean = (s: string) => redactKnownSecrets(redact(s).text).text;
    return [...got.values()].map((m) => ({
      id: m.id,
      url: m.url,
      ts: m.createdAt.toISOString(),
      author: m.member?.displayName ?? m.author.globalName ?? m.author.username,
      bot: m.author.bot,
      content: clean(m.content),
      attachments: [...m.attachments.values()].map((a) => a.name),
      buttons: m.components.length > 0,
      ...(m.reference?.messageId ? { replyTo: m.reference.messageId } : {}),
    }));
  },
  asks: (channelId) => asks.openSets(channelId).map((s) => ({
    setId: s.setId,
    channelId: s.channelId,
    createdAt: s.createdAt,
    questions: s.questions.map((q, qi) => {
      const mid = s.messageIds?.[String(qi)];
      return { id: q.id, question: q.question, answered: !!s.answers[q.id]?.length, url: mid ? `https://discord.com/channels/${GUILD_ID}/${s.channelId}/${mid}` : null };
    }),
  })),
  secretDrop: async (o) => {
    if (!client.isReady()) throw new Error("gateway not ready");
    if (!SECRET_DROP_ORIGIN || !sdServer) return { error: "secret drop is not available (no dashboardUrl or the form server did not start)" };
    const channelId = o.channelId ?? FIRSTMATE_CHANNEL_ID;
    const ch = await privateChannel(channelId);
    if (!ch) return { error: "channel not sendable" };
    const d = secretDrops.create({ ...o, channelId });
    if ("error" in d) return d;
    const url = `${SECRET_DROP_ORIGIN}${SECRET_DROP_PATH}/${d.id}`;
    const mins = Math.round((d.expiresAt - Date.now()) / 60_000);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`Open the secret form (${mins} min)`).setEmoji("🔐").setURL(url));
    // Owner 2026-10-23: the value never goes through Discord; this message holds only the one-time link.
    const m = own(await ch.send({ content: `🔐 **Secret needed: ${d.name}.** Tap the button and paste it there (tailnet only, works once). It is saved on the main host as a 0600 file; do not paste it in Discord.`, components: [row], ...NO_PINGS }));
    log(`secret-drop: link for "${d.name}" → ${d.dest} (expires in ${mins} min)`);
    return { id: d.id, url, expiresAt: d.expiresAt, message: m.url };
  },
  secretDropStatus: (id) => secretDrops.status(id),
  closeAsks: (setIds, reason) => {
    const done = asks.close(setIds, reason === "asked-again" ? "asked-again" : "closed");
    if (done.length) log(`asks closed by request (${reason}): ${done.join(", ")}`);
    return done;
  },
});

/**
 * Owner 2026-10-23 (Discord UX item 4): post ask blocks and 📎 attach lines from earlier answers of the run that
 * the final answer (the only one in stdout) does not carry. Flag a final answer that points at a menu that is
 * not there.
 */
async function postEarlierExtras(target: SendableChannels, res: RunResult, replyTo: Message): Promise<Message | undefined> {
  if (!res.sessionFile || !res.startedAt) return undefined;
  const extra = earlierExtras(await runAnswers(res.sessionFile, res.startedAt), res.stdout);
  let last: Message | undefined;
  if (extra) {
    log(`earlier answer extras: ask=${extra.ask} files=${extra.files} (posted after the final answer)`);
    last = await sendText(target, extra.text, undefined, replyTo, false, undefined, undefined, [], undefined, undefined, undefined, undefined, true);
  }
  if (!extra?.ask && !extractAsk(res.stdout).questions && claimsMissingMenu(res.stdout, asks.openSets(target.id).length > 0)) {
    log("final answer points at a menu, but none is open in this channel");
    last = own(await target.send({ content: "⚠️ This answer refers to a menu, but no question menu is open in this channel. Reply in text, or ask the agent to post the menu again.", ...QUIET }));
  }
  return last;
}

/** /post reply body (owner 2026-10-23, Discord UX item 1). */
function postResult(sink: SendSink): PostResult {
  const first = sink.messages[0];
  if (!first) throw new Error("nothing was posted");
  return {
    id: first.id,
    url: first.url,
    messages: sink.messages.map((m) => ({ id: m.id, url: m.url })),
    attachments: sink.messages.flatMap((m) => [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url }))),
    ...(sink.asks.length ? { asks: sink.asks.map((a) => ({ setId: a.setId, questions: a.questions.map((q, qi) => ({ id: q.id, question: q.question, url: a.menus[qi]?.url ?? "" })) })) } : {}),
  };
}
log(`http listening on http://${server.hostname}:${server.port}`);
// Owner 2026-10-23 (Discord UX item 2): one-time secret form, tailnet-only via `tailscale serve` path /secret-drop.
let sdServer: ReturnType<typeof startSecretDropServer> | null = null;
try {
  sdServer = startSecretDropServer({
    drops: secretDrops,
    log,
    onReceived: (d) => {
      if (!d.channelId) return;
      void privateChannel(d.channelId)
        .then(async (ch) => void (await ch?.send({ content: `🔐 Received **${d.name}** (${d.chars} characters). Saved on the main host (0600).`, ...QUIET })))
        .catch((e) => log(`secret-drop notice: ${(e as Error).message}`));
    },
  });
  log(`secret-drop listening on http://${sdServer.hostname}:${sdServer.port}${SECRET_DROP_PATH}`);
} catch (e) {
  log(`secret-drop server not started: ${(e as Error).message}`); // the bot keeps running without it
}
// Owner 2026-10-15: iOS Shortcut → FIRSTMATE (tailnet-only via `tailscale serve`; see src/shortcut.ts).
if (shortcutConfigured()) {
  const sc = startShortcutServer({
    log,
    transcribe: transcribeFile,
    submit: async (text, _via, voice) => {
      if (!client.isReady()) throw new Error("gateway not ready");
      const target = await privateChannel(VOICE_FALLBACK_CHANNEL_ID); // #main-github-firstmate
      if (!target) throw new Error("FIRSTMATE channel not sendable");
      const note = await target.send({ content: `${voice ? "📱🎙️" : "📱"} from **Shortcut**: ${text.replace(/[*_`]/g, "").slice(0, 1800)}`, ...QUIET });
      void handle(note, { authorId: OWNER_ID, text }).catch((e) => log(`shortcut handle: ${(e as Error).message}`));
      await new Promise((r) => setTimeout(r, 300)); // let it enqueue
      const busy = queue.status().running.some((r) => jobKeys.get(r.id) === target.id);
      return { position: busy ? waitingFor(target.id).length + 1 : 1 };
    },
  });
  log(`shortcut listening on http://${sc.hostname}:${sc.port}`);
}

const shutdown = (sig: string) => {
  log(`${sig}: shutting down`);
  server.stop(true);
  sdServer?.stop(true);
  voicechat.leave();
  void client.destroy().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A missing or incomplete config.json would give a bot that ignores every message without an error.
if (!OWNER_ID || !GUILD_ID || Object.keys(CHANNELS).length === 0) {
  log(`config incomplete: ownerId, guildId and channels are required in ${CONFIG_FILE} (see config.example.json)`);
  process.exit(1);
}
await client.login(loadToken());
