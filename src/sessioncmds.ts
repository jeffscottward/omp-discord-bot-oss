/**
 * OMP session commands as Discord slash commands (card omp-discord-commands-build, owner pick 2026-10-21;
 * spec ~/Documents/reports/web/omp-discord-commands/report.md, route notes in docs/omp-commands.md).
 *
 * Every command and button is owner-only and acts on the session of the channel/thread where it is used.
 * Commands that write the session (compact, rename, handoff, branch ...) refuse while a turn runs or waits in
 * that channel; runOmp also waits for the session lock, so a turn never overlaps a session command.
 * Replies are ephemeral (only the owner sees them), except /todo and /btw.
 */
import { channelMention } from "./mention.ts";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ApplicationCommandDataResolvable,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type SendableChannels,
  type StringSelectMenuInteraction,
  ApplicationCommandOptionType,
} from "discord.js";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startHeartbeat } from "../gate/longjob.ts";
import {
  ago,
  bar,
  clip,
  currentFile,
  EFFORTS,
  forkFile,
  isRecord,
  kTokens,
  listSessions,
  modeArgs,
  modeOverlay,
  modePreamble,
  promptPreview,
  readTodos,
  rpcData,
  StateStore,
  summarizeSession,
  trashFile,
  withRpc,
  withSessionLock,
  type ChannelMode,
  type Effort,
  type RpcSession,
} from "./ompsession.ts";

export const PREFIX = "oc:";

/** Bounded loops (task rule 2026-10-21): every /loop has a turn cap AND a time limit. */
export const LOOP_MAX_TURNS = 20;
export const LOOP_MAX_MIN = 120;

export interface LoopRun {
  id: number;
  channelId: string;
  prompt: string;
  count: number;
  limitMs: number;
  started: number;
  done: number;
  stopped: boolean;
}

export interface LoopIo {
  /** Queue one turn and resolve when it has finished (or failed). */
  turn(n: number): Promise<void>;
  now(): number;
}

/**
 * Run at most `run.count` turns, one after another, until the time limit passes or Stop is pressed.
 * Never unbounded: count and limitMs are capped by LOOP_MAX_TURNS / LOOP_MAX_MIN. Returns the end reason.
 */
export async function runBoundedLoop(run: LoopRun, io: LoopIo): Promise<string> {
  const count = Math.min(Math.max(1, run.count), LOOP_MAX_TURNS);
  const limit = Math.min(Math.max(60_000, run.limitMs), LOOP_MAX_MIN * 60_000);
  for (let n = 1; n <= count; n++) {
    if (run.stopped) return `stopped after ${run.done}/${count} turns`;
    if (io.now() - run.started >= limit) return `time limit reached after ${run.done}/${count} turns`;
    await io.turn(n);
    run.done = n;
  }
  return run.stopped ? `stopped after ${run.done}/${count} turns` : `finished ${count}/${count} turns`;
}

/** The session a Discord channel/thread maps to. */
export interface SessionCtx {
  /** Session key (folder name under SESSIONS_DIR), already suffixed for Venice/Qwen. */
  key: string;
  dir: string;
  cwd: string;
  /** Discord channel/thread id (runs are tracked by it). */
  channelId: string;
  /** /models override; isolated models need their own RPC args. */
  model?: string;
  /** Extra RPC args for isolated (Venice/Qwen) sessions. */
  isolatedArgs: string[];
  /** Set for sessions that only read-only views may touch (FIRSTMATE, mirrored Herdr panes): the reason shown. */
  protectedReason?: string;
}

/**
 * Commands, buttons, selects and modals that change a session file, the file a turn uses, or the channel's run
 * settings. They are refused on protected sessions (SessionCtx.protectedReason).
 */
export const WRITE_ACTIONS = new Set([
  // slash commands
  "compact", "resume", "mode", "branch", "goal", "loop", "fork", "btw",
  // buttons / selects / modals
  "new", "clear", "delete", "do-new", "do-clear", "do-delete", "shake", "rename", "m-rename", "handoff",
  "t-plan", "t-fast", "t-advisor", "t-ext", "goal-clear", "plan-ok", "plan-no", "effort", "pick-resume", "pick-branch", "pick-seance",
]);

/** Throws the protected reason when `action` would change a protected session. */
export function guardWrite(c: Pick<SessionCtx, "protectedReason">, action: string): void {
  if (c.protectedReason && WRITE_ACTIONS.has(action)) throw new Error(c.protectedReason);
}

export interface JobInfo {
  id: number;
  label: string;
  channelId: string;
  since: number;
  running: boolean;
}

export interface Deps {
  ownerId: string;
  ompBin: string;
  stateFile: string;
  overlayDir: string;
  /** Session of the interaction's channel, or a short refusal text. */
  resolve(channel: Interaction["channel"], channelId: string): SessionCtx | string;
  /** A turn runs or waits in this Discord channel/thread. */
  busy(channelId: string): boolean;
  /** Queue a normal owner turn in `channel` with `text` (posted first as a bot note so it shows in the chat). */
  runTurn(channel: SendableChannels, text: string): Promise<void>;
  jobs(): JobInfo[];
  /** Stop a running job or cancel a queued one; returns a one-line result. */
  stopJob(id: number): string;
  /** Session folder for a new thread key (for /fork). */
  sessionDirFor(key: string): string;
  log(s: string): void;
}

/** Reply body with a select menu (and buttons). */
export interface PickerView {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
}

const EPH = MessageFlags.Ephemeral;
const opt = ApplicationCommandOptionType;

// ---------------------------------------------------------------------------
// Command list
// ---------------------------------------------------------------------------

export const PHASE1: (ApplicationCommandDataResolvable & { name: string })[] = [
  { name: "session", description: "This channel's OMP session: info + New/Resume/Compact/Clear/Rename/Export/Handoff" },
  { name: "context", description: "Context window use of this channel's session (+ Shake, Compact)" },
  { name: "resume", description: "Pick another OMP session of this channel for the next turn" },
  {
    name: "compact",
    description: "Compact this channel's session context",
    options: [{ type: opt.String, name: "focus", description: "What the summary must keep (optional)", required: false, max_length: 300 }],
  },
];

export const PHASE2: (ApplicationCommandDataResolvable & { name: string })[] = [
  { name: "mode", description: "Run settings for this channel: effort, plan mode, fast, advisor, extended context" },
  { name: "todo", description: "Todo list of this channel's session (stays visible, updates while a run works)" },
  { name: "jobs", description: "Running and queued bot jobs, with Stop" },
  { name: "tools", description: "Tools the OMP session can use" },
  { name: "mcp", description: "MCP servers (read-only status)" },
  { name: "changelog", description: "OMP changelog (newest version)" },
];

export const PHASE3: (ApplicationCommandDataResolvable & { name: string })[] = [
  { name: "branch", description: "Rewind this session to before an earlier message of yours" },
  { name: "tree", description: "Session tree: branch points of this session (read-only)" },
  { name: "fork", description: "Copy this session into a new thread (both go on separately)" },
  {
    name: "btw",
    description: "Side question about this session; the answer goes into a new thread, the session is unchanged",
    options: [{ type: opt.String, name: "question", description: "Your question", required: true, max_length: 1500 }],
  },
  {
    name: "goal",
    description: "Set or clear a goal that is added to every turn in this channel",
    options: [{ type: opt.String, name: "goal", description: "The goal (leave empty to see/clear it)", required: false, max_length: 500 }],
  },
  {
    name: "loop",
    description: "Run the same prompt several times in a row in this channel",
    options: [
      { type: opt.String, name: "prompt", description: "Prompt for each turn", required: true, max_length: 1500 },
      { type: opt.Integer, name: "count", description: `How many turns (1-${LOOP_MAX_TURNS}, default ${LOOP_MAX_TURNS})`, required: false, min_value: 1, max_value: LOOP_MAX_TURNS },
      { type: opt.Integer, name: "minutes", description: `Time limit in minutes (1-${LOOP_MAX_MIN}, default ${LOOP_MAX_MIN})`, required: false, min_value: 1, max_value: LOOP_MAX_MIN },
    ],
  },
  { name: "modelpreset", description: "Saved OMP model presets (read-only)" },
  { name: "ompmemory", description: "OMP memory payload (read-only view)" },
  {
    name: "seance",
    description: "Ask about an older session of this channel (read-only)",
    options: [{ type: opt.String, name: "question", description: "What to find out", required: true, max_length: 1000 }],
  },
];

export const COMMANDS = [...PHASE1, ...PHASE2, ...PHASE3];
export const NAMES = new Set(COMMANDS.map((c) => c.name));

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class SessionCommands {
  readonly state: StateStore;
  /** Pending /resume and /seance choices: short id -> file (custom ids are limited to 100 chars). */
  private picks = new Map<string, string>();
  private todoWatch = new Map<string, ReturnType<typeof setInterval>>();
  /** Running /loop runs; /jobs and the loop's own Stop button reach them. */
  readonly loops = new Map<number, LoopRun>();
  private loopSeq = 0;

  constructor(private d: Deps) {
    this.state = new StateStore(d.stateFile);
  }

  // ----- run integration (main.ts handle()) -----

  /** Flags, resume file and prompt preamble for the next turn of `key`. */
  runSettings(key: string, isolated: boolean): { extraArgs: string[]; resumeFile?: string; fresh: boolean; preamble: string; plan: boolean } {
    const s = this.state.get(key);
    const m = s.mode;
    const overlay = m ? modeOverlay(this.d.overlayDir, key, m) : undefined;
    const file = s.pin?.file && existsSync(s.pin.file) ? s.pin.file : undefined;
    return { extraArgs: modeArgs(m, overlay, isolated), resumeFile: file, fresh: Boolean(s.pin?.fresh) && !file, preamble: modePreamble(m), plan: Boolean(m?.plan) };
  }

  /** After a turn: a /new pin is used up (the new file is now the newest). */
  afterRun(key: string): void {
    const s = this.state.get(key);
    if (s.pin?.fresh) this.state.update(key, (x) => ({ ...x, pin: undefined }));
  }

  /** Approve/Reject row under a plan-mode answer. */
  planRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      btn("plan-ok", "Approve plan", "✅", ButtonStyle.Success),
      btn("plan-no", "Reject", "✏️", ButtonStyle.Secondary),
    );
  }

  /** 🔁 Retry row under a failed run (main.ts keeps the original message). */
  static retryRow(jobId: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${PREFIX}retry:${jobId}`).setLabel("Retry").setEmoji("🔁").setStyle(ButtonStyle.Primary));
  }

  // ----- dispatch -----

  owns(i: Interaction): boolean {
    if (i.isChatInputCommand()) return NAMES.has(i.commandName);
    if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) return i.customId.startsWith(PREFIX) && !i.customId.startsWith(`${PREFIX}retry:`);
    return false;
  }

  async handle(i: Interaction): Promise<void> {
    if (!(i.isChatInputCommand() || i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return;
    if (i.user.id !== this.d.ownerId) return void (await i.reply({ content: "These commands are for the owner only.", flags: EPH }).catch(() => {}));
    try {
      if (i.isChatInputCommand()) await this.command(i);
      else if (i.isButton()) await this.button(i);
      else if (i.isStringSelectMenu()) await this.select(i);
      else await this.modal(i);
    } catch (e) {
      const text = `⚠️ ${(e as Error).message.split("\n")[0]?.slice(0, 300)}`;
      this.d.log(`sessioncmds: ${text}`);
      if (i.deferred || i.replied) await i.editReply({ content: text, embeds: [], components: [] }).catch(() => {});
      else await i.reply({ content: text, flags: EPH }).catch(() => {});
    }
  }

  private ctx(i: Interaction): SessionCtx {
    const r = this.d.resolve(i.channel, i.channelId ?? "");
    if (typeof r === "string") throw new Error(r);
    return r;
  }

  private assertIdle(c: SessionCtx): void {
    if (this.d.busy(c.channelId)) throw new Error("A turn is running or waiting in this channel. Try again when it is done (or tap ❌ Stop).");
  }

  /** Run an RPC operation on the channel session under its lock. */
  private rpc<T>(c: SessionCtx, fn: (s: RpcSession) => Promise<T>): Promise<T> {
    this.assertIdle(c);
    const pin = this.state.get(c.key).pin;
    const file = currentFile(c.dir, pin);
    return withSessionLock(c.key, () => withRpc({ bin: this.d.ompBin, sessionDir: c.dir, cwd: c.cwd, resumeFile: file, extraArgs: c.isolatedArgs }, fn));
  }

  private requireSession(c: SessionCtx): string {
    const f = currentFile(c.dir, this.state.get(c.key).pin);
    if (!f) throw new Error("This channel has no OMP session yet (or /new was just used). Send a message first.");
    return f;
  }

  // ----- slash commands -----

  private async command(i: ChatInputCommandInteraction): Promise<void> {
    const n = i.commandName;
    if (n === "jobs") return void (await i.reply({ ...this.jobsView(), flags: EPH }));
    const c = this.ctx(i);
    guardWrite(c, n);
    switch (n) {
      case "session":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply(await this.sessionView(c)));
      case "context":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply(await this.contextView(c)));
      case "resume":
        return void (await i.reply({ ...this.resumeView(c), flags: EPH }));
      case "compact":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply({ content: await this.compact(c, i.options.getString("focus") ?? undefined) }));
      case "mode":
        return void (await i.reply({ ...this.modeView(c), flags: EPH }));
      case "todo":
        return void (await this.todo(i, c));
      case "tools":
      case "mcp":
      case "changelog":
      case "modelpreset":
      case "ompmemory": {
        await i.deferReply({ flags: EPH });
        const slash = { tools: "/tools", mcp: "/mcp list", changelog: "/changelog", modelpreset: "/modelpreset", ompmemory: "/memory view" }[n];
        let out = await this.readOnlySlash(c, slash);
        if (n === "changelog") out = out.split(/\n(?=## \[)/)[0] ?? out;
        if (n === "tools") out = out.split("\n").filter((l) => l.startsWith("*")).map((l) => l.slice(2)).join(" · ") + "\n(only enabled tools)";
        return void (await i.editReply({ content: `**/${n}**\n\`\`\`\n${clip(out.replace(/```/g, "ˋˋˋ"), 1850)}\n\`\`\`` }));
      }
      case "branch":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply(await this.branchView(c)));
      case "tree":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply({ content: await this.treeText(c) }));
      case "fork":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply({ content: await this.fork(i, c) }));
      case "btw":
        return void (await this.btw(i, c, i.options.getString("question", true)));
      case "goal":
        return void (await this.goal(i, c, i.options.getString("goal")));
      case "loop":
        return void (await this.loop(i, c, i.options.getString("prompt", true), i.options.getInteger("count") ?? LOOP_MAX_TURNS, i.options.getInteger("minutes") ?? LOOP_MAX_MIN));
      case "seance":
        return void (await i.reply({ ...this.seanceView(c, i.options.getString("question", true)), flags: EPH }));
    }
  }

  // ----- views -----

  async sessionView(c: SessionCtx): Promise<{ content?: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
    const pin = this.state.get(c.key).pin;
    const file = currentFile(c.dir, pin);
    const e = new EmbedBuilder().setTitle("🧵 Session for this channel").setColor(0x5865f2);
    if (!file) e.setDescription(pin?.fresh ? "🆕 The next message starts a new session." : "No session yet. Send a message to start one.");
    else {
      const s = summarizeSession(file);
      const m = this.state.get(c.key).mode;
      let ctxLine = "run active: see /context later";
      if (!this.d.busy(c.channelId)) {
        const st = await this.rpc(c, async (r) => rpcData(await r.call({ type: "get_session_stats" }))).catch(() => null);
        const u = isRecord(st) && isRecord(st.contextUsage) ? st.contextUsage : null;
        if (u && typeof u.tokens === "number" && typeof u.contextWindow === "number") ctxLine = `${Math.round((u.tokens / u.contextWindow) * 100)} % of ${kTokens(u.contextWindow)}`;
      }
      e.addFields(
        { name: "Title", value: s.title.slice(0, 200) },
        { name: "Model", value: `${(c.model ?? s.model ?? "default").replace(/^anthropic\//, "")}${m?.effort ? ` · effort ${m.effort}` : ""}`, inline: true },
        { name: "Messages", value: `${s.userMessages + s.assistantMessages} (${s.toolCalls} tool calls)`, inline: true },
        { name: "Context", value: ctxLine, inline: true },
        { name: "Folder", value: `\`${(s.cwd || c.cwd).replace(process.env.HOME ?? "~", "~")}\``, inline: true },
        { name: "Started", value: `<t:${Math.round(s.created / 1000)}:R>`, inline: true },
      );
      if (pin?.file) e.setFooter({ text: "📌 Pinned with /resume or /branch" });
    }
    const rows = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn("new", "New", "🆕", ButtonStyle.Primary),
        btn("resume", "Resume…", "📂"),
        btn("compact", "Compact", "🗜️"),
        btn("clear", "Clear", "🧹"),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(btn("branch", "Branch…", "🌿"), btn("rename", "Rename", "✏️"), btn("export", "Export", "📤"), btn("handoff", "Handoff", "🤝")),
      new ActionRowBuilder<ButtonBuilder>().addComponents(btn("context", "Context", "📊"), btn("delete", "Delete", "🗑️", ButtonStyle.Danger)),
    ];
    return { embeds: [e], components: file ? rows : [rows[0]!] };
  }

  async contextView(c: SessionCtx): Promise<{ content: string; components: ActionRowBuilder<ButtonBuilder>[] }> {
    this.requireSession(c);
    const out = await this.rpc(c, (r) => r.slash("/context"));
    const pct = Number(out.match(/\((\d+(?:\.\d+)?)% used\)/)?.[1] ?? NaN);
    const head = Number.isFinite(pct) ? `📊 **Context: ${pct} % used**\n\`${bar(pct)}\`` : "📊 **Context**";
    // Keep the per-category lines; drop the TUI bar row (the bar above replaces it).
    const lines = out.split("\n").filter((l) => !/^Context window:/.test(l)).map((l) => l.replace(/[░█▓▒■□]+/g, "").replace(/\s+\[\s*\]\s*/, " ").trimEnd());
    return {
      content: clip(`${head}\n\`\`\`\n${lines.join("\n").trim()}\n\`\`\``, 1900),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn("shake", "Shake (drop tool results)", "🫨", ButtonStyle.Primary), btn("compact", "Compact", "🗜️"))],
    };
  }

  resumeView(c: SessionCtx, purpose: "resume" | "seance" = "resume", question?: string): PickerView {
    const list = listSessions(c.dir, 25);
    if (!list.length) return { content: "No sessions in this channel yet.", components: [] };
    const cur = currentFile(c.dir, this.state.get(c.key).pin);
    const qid = question ? this.remember(question) : "";
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}${purpose === "resume" ? "pick-resume" : `pick-seance:${qid}`}`)
      .setPlaceholder(purpose === "resume" ? "📂 Sessions in this channel" : "🔮 Pick the older session")
      .addOptions(
        list.map((s) => ({
          label: `${s.file === cur ? "📌 " : ""}${s.title}`.slice(0, 100),
          description: `${ago(s.modified)} · ${s.userMessages + s.assistantMessages} msgs · ${kTokens(s.bytes)}B`.slice(0, 100),
          value: this.remember(s.file),
        })),
      );
    const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
    return {
      content: purpose === "resume" ? "Pick a session for this channel. The next message continues it." : "🔮 Seance: pick the older session to read (read-only). The current session answers in a normal turn.",
      components: rows,
    };
  }

  modeView(c: SessionCtx): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
    const m = this.state.get(c.key).mode ?? {};
    const isolated = c.isolatedArgs.length > 0;
    const onoff = (v: boolean | undefined, dflt: string) => (v === undefined ? dflt : v ? "on" : "off");
    const e = new EmbedBuilder()
      .setTitle("⚙️ Run settings for this channel")
      .setColor(0x5865f2)
      .addFields(
        { name: "Model", value: (c.model ?? "bot default").replace(/^anthropic\//, ""), inline: true },
        { name: "Effort", value: m.effort ?? "default", inline: true },
        { name: "Plan mode", value: m.plan ? "on" : "off", inline: true },
        { name: "Fast mode", value: onoff(m.fast, "session default"), inline: true },
        { name: "Advisor", value: onoff(m.advisor, "config default"), inline: true },
        { name: "Extended context", value: onoff(m.extendedContext, "config default"), inline: true },
      );
    if (isolated) e.setFooter({ text: "Venice/Qwen channel: effort, advisor and extended context stay off here." });
    const effort = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}effort`)
      .setPlaceholder(`🧠 Effort: ${m.effort ?? "default"}`)
      .addOptions([{ label: "default (config)", value: "default", default: !m.effort }, ...EFFORTS.map((x) => ({ label: x, value: x, default: m.effort === x }))]);
    const tog = (id: string, label: string, emoji: string, v: boolean | undefined) => btn(id, `${label}: ${v ? "on" : "off"}`, emoji, v ? ButtonStyle.Success : ButtonStyle.Secondary);
    return {
      embeds: [e],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effort),
        new ActionRowBuilder<ButtonBuilder>().addComponents(tog("t-plan", "Plan mode", "📝", m.plan), tog("t-fast", "Fast", "⚡", m.fast)),
        new ActionRowBuilder<ButtonBuilder>().addComponents(tog("t-advisor", "Advisor", "🧑‍🏫", m.advisor), tog("t-ext", "Extended context", "📏", m.extendedContext)),
      ],
    };
  }

  todoView(c: SessionCtx): { content?: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const file = currentFile(c.dir, this.state.get(c.key).pin);
    const t = file ? readTodos(file) : null;
    const e = new EmbedBuilder().setColor(0x57f287);
    if (!t || !t.items.length) e.setTitle("📋 Todo").setDescription("No todo list in this session.");
    else {
      const done = t.items.filter((x) => x.done).length;
      e.setTitle(`📋 Todo · ${done} of ${t.items.length} done`);
      const lines: string[] = [];
      let phase = "";
      for (const it of t.items) {
        if (it.phase && it.phase !== phase) lines.push(`**${(phase = it.phase)}**`);
        lines.push(`${it.done ? "✅" : it.active ? "🔄" : "⬜"} ${it.text}`);
      }
      e.setDescription(clip(lines.join("\n"), 3900));
    }
    const live = this.d.busy(c.channelId);
    e.setFooter({ text: live ? "🔄 Updates while the run works" : `Updated ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` });
    return { embeds: [e], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn("todo-refresh", "Refresh", "🔄"))] };
  }

  jobsView(): { content: string; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
    const jobs = this.d.jobs();
    const loops = [...this.loops.values()];
    const loopLines = loops.map((l) => `🔁 \`L${l.id}\` /loop ${l.done}/${l.count} · ${ago(l.started).replace(" ago", "")} · ${channelMention(l.channelId)}`);
    const loopOpts = loops.map((l) => ({ label: `L${l.id} /loop ${l.prompt}`.slice(0, 100), description: "loop: stop it (no more turns)", value: `loop:${l.id}` }));
    if (!jobs.length && !loops.length) return { content: "🧰 No bot jobs are running or waiting.", components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn("jobs-refresh", "Refresh", "🔄"))] };
    const lines = [...loopLines, ...jobs.map((j) => `${j.running ? "▶️" : "⏸️"} \`#${j.id}\` ${j.label.slice(0, 50)} · ${j.running ? "running" : "waiting"} ${ago(j.since).replace(" ago", "")} · ${channelMention(j.channelId)}`)];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}stop-job`)
      .setPlaceholder("🟥 Pick a job to stop…")
      .addOptions([...loopOpts, ...jobs.map((j) => ({ label: `#${j.id} ${j.label}`.slice(0, 100), description: j.running ? "running: stop it" : "waiting: cancel it", value: String(j.id) }))].slice(0, 25));
    return {
      content: clip(`🧰 **Bot jobs (${jobs.length}${loops.length ? ` + ${loops.length} loop` : ""})**\n${lines.join("\n")}`, 1900),
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), new ActionRowBuilder<ButtonBuilder>().addComponents(btn("jobs-refresh", "Refresh", "🔄"))],
    };
  }

  async branchView(c: SessionCtx): Promise<{ content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] }> {
    this.requireSession(c);
    const data = await this.rpc(c, async (r) => rpcData(await r.call({ type: "get_branch_messages" })));
    const msgs = isRecord(data) && Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
    const items = msgs
      .map((m) => ({ id: typeof m.entryId === "string" ? m.entryId : "", text: typeof m.text === "string" ? m.text : "" }))
      .filter((m) => m.id)
      .slice(-25)
      .reverse();
    if (!items.length) return { content: "No earlier messages to branch from.", components: [] };
            const menu = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}pick-branch`)
      .setPlaceholder("🌿 Rewind to before…")
      .addOptions(items.map((m, n) => ({ label: `${n + 1}. ${promptPreview(m.text) || "(attachment)"}`.slice(0, 100), value: m.id.slice(0, 100) })));
    return { content: "🌿 Pick one of your messages. The session goes back to just before it (newest first). The old path stays in /tree.", components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
  }

  async treeText(c: SessionCtx): Promise<string> {
    this.requireSession(c);
    const data = await this.rpc(c, async (r) => rpcData(await r.call({ type: "get_tree" })));
    if (!isRecord(data)) return "No tree.";
    const leaf = typeof data.leafId === "string" ? data.leafId : "";
    const lines: string[] = [];
    let branches = 0;
    const walk = (nodes: unknown, depth: number) => {
      if (!Array.isArray(nodes)) return;
      if (nodes.length > 1) branches++;
      for (const n of nodes) {
        if (!isRecord(n)) continue;
        const entry = isRecord(n.entry) ? n.entry : n;
        const msg = isRecord(entry.message) ? entry.message : null;
        const kids = n.children;
        if (msg?.role === "user" && lines.length < 40) {
          const raw = Array.isArray(msg.content) ? msg.content.map((x) => (isRecord(x) && typeof x.text === "string" ? x.text : "")).join("") : typeof msg.content === "string" ? msg.content : "";
          const preview = raw.match(/--- owner message ---\n([\s\S]*?)\n--- end /)?.[1] ?? raw;
          lines.push(`${"  ".repeat(Math.min(depth, 6))}${entry.id === leaf ? "📍" : "•"} ${preview.replace(/\s+/g, " ").slice(0, 60)}`);
        }
        walk(kids, Array.isArray(kids) && kids.length > 1 ? depth + 1 : depth);
      }
    };
    walk(data.tree, 0);
    return clip(`🌳 **Session tree** · ${branches} branch point(s); your messages only\n\`\`\`\n${lines.join("\n") || "(empty)"}\n\`\`\``, 1900);
  }

  seanceView(c: SessionCtx, question: string): PickerView {
    return this.resumeView(c, "seance", question);
  }

  // ----- actions -----

  async compact(c: SessionCtx, focus?: string): Promise<string> {
    this.requireSession(c);
    const t = Date.now();
    const data = await this.rpc(c, async (r) => rpcData(await r.call({ type: "compact", ...(focus ? { customInstructions: focus } : {}) })));
    const before = isRecord(data) && typeof data.tokensBefore === "number" ? ` (was ${kTokens(data.tokensBefore)} tokens)` : "";
    return `🗜️ Compacted${before} in ${Math.round((Date.now() - t) / 1000)} s. The next turn continues from the summary.`;
  }

  private async readOnlySlash(c: SessionCtx, slash: string): Promise<string> {
    // Read-only commands may run during a turn on a throwaway session (they read config, not the transcript).
    if (this.d.busy(c.channelId) || !currentFile(c.dir, this.state.get(c.key).pin)) {
      const dir = mkdtempSync(join(tmpdir(), "omp-ro-"));
      return withRpc({ bin: this.d.ompBin, sessionDir: dir, cwd: c.cwd, extraArgs: c.isolatedArgs }, (r) => r.slash(slash));
    }
    return this.rpc(c, (r) => r.slash(slash));
  }

  private async todo(i: ChatInputCommandInteraction | ButtonInteraction, c: SessionCtx): Promise<void> {
    const view = this.todoView(c);
    if (i.isButton()) return void (await i.update(view));
    await i.reply(view);
    // Live: while a run works here, refresh every 15 s (max 30 min); one watcher per channel.
    if (!this.d.busy(c.channelId)) return;
    const msg = await i.fetchReply();
    clearInterval(this.todoWatch.get(c.channelId));
    const until = Date.now() + 30 * 60_000;
    const t = setInterval(() => {
      const busy = this.d.busy(c.channelId);
      void msg.edit(this.todoView(c)).catch(() => {});
      if (!busy || Date.now() > until) {
        clearInterval(t);
        this.todoWatch.delete(c.channelId);
      }
    }, 15_000);
    this.todoWatch.set(c.channelId, t);
  }

  private async fork(i: ChatInputCommandInteraction, c: SessionCtx): Promise<string> {
    const file = this.requireSession(c);
    this.assertIdle(c);
    const ch = i.channel;
    const parent = ch?.isThread() ? ch.parent : null;
    if (!parent || parent.type !== ChannelType.GuildText) throw new Error("/fork works inside a thread of a mapped channel.");
    const s = summarizeSession(file);
    const starter = await parent.send({ content: `🍴 Fork of ${channelMention(c.channelId, "a channel")}: **${s.title.slice(0, 80)}**`, allowedMentions: { parse: [] } });
    const thread = await starter.startThread({ name: `🍴 ${s.title}`.slice(0, 100) });
    await withSessionLock(c.key, async () => void forkFile(file, this.d.sessionDirFor(thread.id)));
    await thread.send({ content: `🍴 This thread continues a copy of the session from ${channelMention(c.channelId, "the source channel")}. Write here to go on; the original stays unchanged.`, allowedMentions: { parse: [] } });
    return `🍴 Forked into ${channelMention(thread.id, "a new thread")}.`;
  }

  private async btw(i: ChatInputCommandInteraction, c: SessionCtx, question: string): Promise<void> {
    this.requireSession(c);
    this.assertIdle(c);
    await i.deferReply();
    const data = await this.rpc(c, async (r) => rpcData(await r.call({ type: "btw", question })));
    const rec = isRecord(data) && isRecord(data.record) ? data.record : {};
    const answer = typeof rec.answer === "string" ? rec.answer : typeof rec.response === "string" ? rec.response : typeof rec.text === "string" ? rec.text : JSON.stringify(rec).slice(0, 1500);
    const head = await i.editReply({ content: `💬 **btw:** ${question.slice(0, 300)}` });
    const thread = await head.startThread({ name: `💬 ${question}`.slice(0, 100) }).catch(() => null);
    const out = clip(answer, 1900);
    if (thread) await thread.send({ content: out, allowedMentions: { parse: [] } });
    else await i.followUp({ content: out, allowedMentions: { parse: [] } });
  }

  private async goal(i: ChatInputCommandInteraction, c: SessionCtx, goal: string | null): Promise<void> {
    if (goal?.trim()) {
      this.setMode(c.key, { goal: goal.trim() });
      return void (await i.reply({ content: `🎯 Goal set. Every turn in this channel now starts with it:\n> ${goal.trim()}`, flags: EPH }));
    }
    const cur = this.state.get(c.key).mode?.goal;
    if (!cur) return void (await i.reply({ content: "🎯 No goal set. Use `/goal goal:<text>` to set one.", flags: EPH }));
    await i.reply({ content: `🎯 Current goal:\n> ${cur}`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn("goal-clear", "Clear goal", "🧹", ButtonStyle.Danger))], flags: EPH });
  }

  private async loop(i: ChatInputCommandInteraction, c: SessionCtx, prompt: string, count: number, minutes: number): Promise<void> {
    const ch = i.channel;
    if (!ch?.isSendable()) throw new Error("This channel cannot take messages.");
    if ([...this.loops.values()].some((l) => l.channelId === c.channelId)) throw new Error("A /loop already runs in this channel. Stop it first (/jobs).");
    const run: LoopRun = { id: ++this.loopSeq, channelId: c.channelId, prompt, count: Math.min(count, LOOP_MAX_TURNS), limitMs: Math.min(minutes, LOOP_MAX_MIN) * 60_000, started: Date.now(), done: 0, stopped: false };
    this.loops.set(run.id, run);
    const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(btn(`loop-stop:${run.id}`, "Stop loop", "🟥", ButtonStyle.Danger));
    await i.reply({ content: `🔁 /loop L${run.id}: up to ${run.count} turns, limit ${Math.round(run.limitMs / 60_000)} min.\n> ${prompt.slice(0, 200)}`, components: [stopRow] });
    const label = `/loop L${run.id} in ${channelMention(c.channelId, "a channel")} (max ${run.count} turns): ${prompt.slice(0, 80)}`;
    const hb = startHeartbeat(label, { limitMs: run.limitMs });
    this.d.log(`/loop L${run.id} start ${run.count}x ${minutes} min in ${c.channelId}`);
    let reason = "";
    try {
      reason = await runBoundedLoop(run, {
        now: Date.now,
        turn: async (n) => {
          await this.d.runTurn(ch, `[🔁 /loop L${run.id} ${n}/${run.count}] ${prompt}`);
          // Wait for that turn (and anything queued before it) to finish, within the loop's time limit.
          while (this.d.busy(c.channelId) && !run.stopped && Date.now() - run.started < run.limitMs) await new Promise((r) => setTimeout(r, 3_000));
        },
      });
    } catch (e) {
      reason = `failed: ${(e as Error).message.slice(0, 200)}`;
    } finally {
      this.loops.delete(run.id);
      await hb.stop(reason || "ended");
    }
    this.d.log(`/loop L${run.id} end: ${reason}`);
    await ch.send({ content: `🔁 /loop L${run.id} ${reason}.`, flags: MessageFlags.SuppressNotifications }).catch(() => {});
  }

  /** Stop a /loop: no further turns start; the running turn is stopped too. */
  stopLoop(id: number): string {
    const run = this.loops.get(id);
    if (!run) return "That loop already ended.";
    run.stopped = true;
    const running = this.d.jobs().find((j) => j.running && j.channelId === run.channelId);
    if (running) this.d.stopJob(running.id);
    for (const j of this.d.jobs()) if (!j.running && j.channelId === run.channelId && j.label.includes(`/loop L${id} `)) this.d.stopJob(j.id);
    return `🟥 Loop L${id} stopped after ${run.done} turn(s).`;
  }

  setMode(key: string, patch: Partial<ChannelMode>): ChannelMode {
    const next = this.state.update(key, (s) => {
      const m: ChannelMode = { ...(s.mode ?? {}), ...patch };
      for (const k of Object.keys(m) as (keyof ChannelMode)[]) if (m[k] === undefined) delete m[k];
      return { ...s, mode: Object.keys(m).length ? m : undefined };
    });
    return next.mode ?? {};
  }

  private remember(v: string): string {
    const id = Math.random().toString(36).slice(2, 10);
    this.picks.set(id, v);
    if (this.picks.size > 500) this.picks.delete(this.picks.keys().next().value!);
    return id;
  }

  // ----- buttons -----

  private async button(i: ButtonInteraction): Promise<void> {
    const [action = "", arg = ""] = i.customId.slice(PREFIX.length).split(":");
    if (action === "jobs-refresh") return void (await i.update(this.jobsView()));
    if (action === "loop-stop") return void (await i.update({ content: this.stopLoop(Number(arg)), components: [] }));
    const c = this.ctx(i);
    guardWrite(c, action);
    switch (action) {
      case "new":
      case "clear":
      case "delete": {
        const what = { new: "Start a new session", clear: "Clear the context (new session; the old one stays in /resume)", delete: "Delete this session (moved to .trash) and start new" }[action];
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(btn(`do-${action}`, "Yes, do it", action === "delete" ? "🗑️" : "✅", action === "delete" ? ButtonStyle.Danger : ButtonStyle.Primary), btn("cancel", "Cancel", "✖️"));
        return void (await i.reply({ content: `${what}?`, components: [row], flags: EPH }));
      }
      case "do-new":
      case "do-clear":
      case "do-delete": {
        this.assertIdle(c);
        if (action === "do-delete") {
          const f = this.requireSession(c);
          await withSessionLock(c.key, async () => trashFile(f));
        }
        this.state.update(c.key, (s) => ({ ...s, pin: { fresh: true } }));
        return void (await i.update({ content: action === "do-delete" ? "🗑️ Deleted. The next message starts a new session." : "🆕 Done. The next message starts a new session. Older sessions stay in /resume.", components: [] }));
      }
      case "cancel":
        return void (await i.update({ content: "✖️ Cancelled.", components: [] }));
      case "resume":
        return void (await i.reply({ ...this.resumeView(c), flags: EPH }));
      case "context":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply(await this.contextView(c)));
      case "compact":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply({ content: await this.compact(c) }));
      case "shake": {
        await i.deferReply({ flags: EPH });
        const out = await this.rpc(c, (r) => r.slash("/shake"));
        return void (await i.editReply({ content: `🫨 ${clip(out || "Done.", 1800)}` }));
      }
      case "rename": {
        const f = this.requireSession(c);
        const input = new TextInputBuilder().setCustomId("title").setLabel("New title").setStyle(TextInputStyle.Short).setMaxLength(100).setValue(summarizeSession(f).title.slice(0, 100));
        return void (await i.showModal(new ModalBuilder().setCustomId(`${PREFIX}m-rename`).setTitle("Rename session").addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))));
      }
      case "export": {
        this.requireSession(c);
        await i.deferReply({ flags: EPH });
        const out = join(mkdtempSync(join(tmpdir(), "omp-export-")), "session.html");
        const data = await this.rpc(c, async (r) => rpcData(await r.call({ type: "export_html", outputPath: out })));
        const path = isRecord(data) && typeof data.path === "string" ? data.path : out;
        if (statSync(path).size > 24 * 1024 * 1024) return void (await i.editReply({ content: `📤 Exported, but the file is too big for Discord: \`${path}\`` }));
        return void (await i.editReply({ content: "📤 Session export (HTML).", files: [new AttachmentBuilder(path, { name: `session-${basename(c.dir)}.html` })] }));
      }
      case "handoff": {
        this.requireSession(c);
        await i.deferReply({ flags: EPH });
        const data = await this.rpc(c, async (r) => rpcData(await r.call({ type: "handoff" })));
        const p = isRecord(data) && typeof data.savedPath === "string" ? data.savedPath : "";
        return void (await i.editReply({ content: `🤝 Handoff written; the session continues from it.${p ? "" : " (no file path returned)"}`, files: p && existsSync(p) ? [new AttachmentBuilder(p, { name: basename(p) })] : [] }));
      }
      case "branch":
        await i.deferReply({ flags: EPH });
        return void (await i.editReply(await this.branchView(c)));
      case "todo-refresh":
        return void (await this.todo(i, c));
      case "t-plan":
      case "t-fast":
      case "t-advisor":
      case "t-ext": {
        const m = this.state.get(c.key).mode ?? {};
        if (action === "t-fast") {
          const next = !m.fast;
          await i.deferUpdate();
          // Fast mode is a session setting in OMP (service tier entry), so it is set through RPC.
          if (currentFile(c.dir, this.state.get(c.key).pin)) {
            const out = await this.rpc(c, (r) => r.slash(`/fast ${next ? "on" : "off"}`));
            if (/unavailable|no service-tier/i.test(out)) throw new Error(out);
          }
          this.setMode(c.key, { fast: next });
          return void (await i.editReply(this.modeView(c)));
        }
        const field = { "t-plan": "plan", "t-advisor": "advisor", "t-ext": "extendedContext" }[action] as "plan" | "advisor" | "extendedContext";
        this.setMode(c.key, { [field]: !m[field] });
        return void (await i.update(this.modeView(c)));
      }
      case "goal-clear":
        this.setMode(c.key, { goal: undefined });
        return void (await i.update({ content: "🎯 Goal cleared.", components: [] }));
      case "plan-ok":
      case "plan-no": {
        const ch = i.channel;
        if (!ch?.isSendable()) return;
        if (action === "plan-no") return void (await i.reply({ content: "✏️ Write what to change in the plan as a normal message. Plan mode stays on.", flags: EPH }));
        this.setMode(c.key, { plan: undefined });
        await i.update({ components: [] });
        await this.d.runTurn(ch, "The plan above is approved (plan mode is now off). Implement it now.");
        return;
      }
    }
  }

  // ----- selects -----

  private async select(i: StringSelectMenuInteraction): Promise<void> {
    const [action = "", arg = ""] = i.customId.slice(PREFIX.length).split(":");
    const v = i.values[0] ?? "";
    if (action === "stop-job") return void (await i.update({ content: v.startsWith("loop:") ? this.stopLoop(Number(v.slice(5))) : this.d.stopJob(Number(v)), components: [] }));
    const c = this.ctx(i);
    guardWrite(c, action);
    switch (action) {
      case "effort":
        this.setMode(c.key, { effort: v === "default" ? undefined : (v as Effort) }); // value comes from our own EFFORTS list
        return void (await i.update(this.modeView(c)));
      case "pick-resume": {
        const file = this.picks.get(v);
        if (!file || !existsSync(file) || !file.startsWith(`${c.dir}/`)) throw new Error("That choice expired. Run /resume again.");
        this.assertIdle(c);
        this.state.update(c.key, (s) => ({ ...s, pin: { file } }));
        return void (await i.update({ content: `📂 The next message continues **${summarizeSession(file).title.slice(0, 120)}**.`, components: [] }));
      }
      case "pick-seance": {
        const file = this.picks.get(v);
        const q = this.picks.get(arg);
        if (!file || !q || !file.startsWith(`${c.dir}/`)) throw new Error("That choice expired. Run /seance again.");
        const ch = i.channel;
        if (!ch?.isSendable()) return;
        await i.update({ content: `🔮 Asking about **${summarizeSession(file).title.slice(0, 100)}**…`, components: [] });
        await this.d.runTurn(ch, `🔮 Seance (read-only): read the older session file ${file} with targeted grep/read (never load it whole, never resume it, never edit it) and answer: ${q}`);
        return;
      }
      case "pick-branch": {
        await i.deferUpdate();
        const data = await this.rpc(c, async (r) => {
          const b = rpcData(await r.call({ type: "branch", entryId: v }));
          const st = rpcData(await r.call({ type: "get_state" }));
          return { b, file: isRecord(st) && typeof st.sessionFile === "string" ? st.sessionFile : "" };
        });
        if (isRecord(data.b) && data.b.cancelled === true) throw new Error("OMP cancelled the branch.");
        if (data.file) this.state.update(c.key, (s) => ({ ...s, pin: { file: data.file } }));
        const text = isRecord(data.b) && typeof data.b.text === "string" ? data.b.text : "";
                    return void (await i.editReply({ content: `🌿 Rewound to before: “${promptPreview(text).slice(0, 150)}”. The next message continues from there.`, components: [] }));
      }
    }
  }

  // ----- modals -----

  private async modal(i: ModalSubmitInteraction): Promise<void> {
    const action = i.customId.slice(PREFIX.length);
    const c = this.ctx(i);
    guardWrite(c, action);
    if (action === "m-rename") {
      const name = i.fields.getTextInputValue("title").trim();
      await i.deferReply({ flags: EPH });
      await this.rpc(c, async (r) => rpcData(await r.call({ type: "set_session_name", name })));
      await i.editReply({ content: `✏️ Renamed to **${name.slice(0, 100)}**.` });
    }
  }
}

function btn(id: string, label: string, emoji: string, style = ButtonStyle.Secondary): ButtonBuilder {
  return new ButtonBuilder().setCustomId(`${PREFIX}${id}`).setLabel(label).setEmoji(emoji).setStyle(style);
}

/** True when `m` is a bot reply that should carry the plan buttons (plan mode was on for its run). */
export function isPlanAnswer(text: string): boolean {
  return /##\s*Plan\b/i.test(text);
}

export type { Message };
