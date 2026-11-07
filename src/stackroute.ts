/**
 * Discord side of the FIRSTMATE router (src/router.ts): stack threads, routed message ids, router notes.
 *
 * Each stack gets ONE persistent thread under the FIRSTMATE channel. The bridge's run registries
 * (src/omp.ts `active`/`heartbeats`, ❌ Stop, 🩺 Check) are keyed by channel/thread id, so giving every
 * stack its own thread keeps parallel stack runs apart without changing that lifecycle code.
 */
import { emojiKey } from "./stackemoji.ts";
import { channelMention } from "./mention.ts";
import type { FinalJobState, JobState } from "./jobstate.ts";
import { ChannelType, MessageFlags, ThreadAutoArchiveDuration, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import { join } from "node:path";
import { readCards } from "./masterqueue.ts";
import {
  cardAreasFor,
  GENERAL,
  keywordScores,
  mergeStacks,
  loadRouterState,
  routeMessage,
  routeNote,
  saveRouterState,
  StackTracker,
  type Judge,
  type RouteContext,
  type RouteDecision,
  type RouterConfig,
  type RouterState,
  type StackDef,
} from "./router.ts";
import { catalogMtime, parseCatalog, readCatalogEntries } from "./stackcatalog.ts";

const QUIET = { flags: MessageFlags.SuppressNotifications as const, allowedMentions: { parse: [] as [] } };

export const stackSessionKey = (name: string) => `stack-${name}`;

export type Routed = { decision: RouteDecision; note?: Message; sourceUrl: string; copyUrl?: string };

/** Link to one message in a channel or thread (owner 2026-11-02: "→ stack" links open the routed copy itself). */
export function messageLink(guildId: string, channelId: string, messageId?: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""}`;
}

/** A stack thread's name with the stack's current emoji: replaces the leading emoji, keeps the rest. */
export function stackThreadName(current: string, s: { name: string; emoji: string }): string {
  const tail = ` ${s.name} stack`;
  const at = current.indexOf(tail);
  const rest = at >= 0 ? current.slice(at) : tail;
  return `${s.emoji}${rest}`.slice(0, 100);
}

/** Discord API codes that mean a saved stack thread can no longer be used: Unknown Channel, Missing Access. */
const THREAD_GONE = new Set([10003, 50001]);

export class StackRouter {
  readonly tracker: StackTracker;
  private readonly st: RouterState;
  private readonly creating = new Map<string, Promise<ThreadChannel>>();
  /** Copy message id in a stack thread → the decision and the FIRSTMATE note to edit. In memory only. */
  private readonly routed = new Map<string, Routed>();

  constructor(
    readonly cfg: RouterConfig,
    private readonly opts: {
      stateFile: string;
      statusFile: string;
      itemsFile: string;
      guildId: string;
      judge?: Judge;
      log: (s: string) => void;
      /** The stack catalog (src/stackcatalog.ts): re-read by refresh() when it changes. */
      catalogFile?: string;
      /** Legacy config.json `router.stacks`, merged under the catalog. */
      legacyStacks?: Partial<StackDef>[];
    },
  ) {
    this.st = loadRouterState(opts.stateFile);
    this.tracker = new StackTracker(cfg, opts.statusFile);
    this.tracker.threads = this.st.threads;
    this.refresh();
  }

  private catalogAt = -1;
  /**
   * Owner 2026-10-28: re-read the stack catalog when its file changed (scripts/stack-add.ts or fm-spawn's
   * auto-create added a stack), so a new stack routes at once without a bot restart. Mutates cfg.stacks in place
   * (StackTracker and main share this cfg object). Returns true when the stacks were reloaded.
   */
  refresh(): boolean {
    const file = this.opts.catalogFile;
    if (!file) return false;
    const at = catalogMtime(file);
    if (at === this.catalogAt) return false;
    this.catalogAt = at;
    const before = this.cfg.stacks.length;
    let entries: Record<string, unknown>[];
    try {
      entries = readCatalogEntries(file);
    } catch (e) {
      // A broken hand-edit must not drop the routing to the code defaults: keep the stacks we have.
      this.opts.log(`router: stack catalog ${file} unreadable, keeping ${before} stacks: ${(e as Error).message}`);
      return false;
    }
    this.cfg.stacks = mergeStacks([...(this.opts.legacyStacks ?? []), ...parseCatalog(entries).stacks]);
    this.opts.log(`router: stack catalog loaded: ${this.cfg.stacks.length} stacks (was ${before})`);
    return true;
  }

  stack(name: string): StackDef | undefined {
    this.refresh();
    return this.cfg.stacks.find((s) => s.name === name);
  }
  stackByThread(threadId: string | null | undefined): StackDef | undefined {
    if (!threadId) return undefined;
    const name = Object.entries(this.st.threads).find(([, id]) => id === threadId)?.[0];
    return name ? this.stack(name) : undefined;
  }
  /** Stack of a mapped topic channel (its messages keep their own queue; the board tags them). */
  stackByChannel(channelId: string, parentId: string | null): StackDef | undefined {
    return this.cfg.stacks.find((s) => s.channelIds.includes(channelId) || (parentId !== null && s.channelIds.includes(parentId)));
  }
  /**
   * Owner 2026-11-03 (card stack-coverage): every job has a stack. Mapped channel first, then the best keyword
   * match on the channel name and message text, else the general FIRSTMATE stack. Never undefined while a
   * general stack exists.
   */
  stackForJob(channelId: string, parentId: string | null, channelName = "", text = ""): StackDef | undefined {
    const mapped = this.stackByChannel(channelId, parentId);
    if (mapped) return mapped;
    // A clear winner only (no tie): a tie or no hit goes to the general stack (review finding, card stack-coverage).
    const clear = (t: string) => {
      const sc = keywordScores(t, this.cfg.stacks);
      return sc[0] && sc[0].score > (sc[1]?.score ?? 0) ? sc[0].stack : undefined;
    };
    const name = clear(channelName.replace(/[-_]+/g, " ")) ?? clear(text.slice(0, 2000));
    return (name && this.cfg.stacks.find((s) => s.name === name)) || this.cfg.stacks.find((s) => s.name === GENERAL);
  }
  /** First routed stack among these message ids (a reply's target, a menu's source message). */
  inherited(ids: (string | null | undefined)[]): string | undefined {
    for (const id of ids) if (id && this.st.msgs[id]) return this.st.msgs[id]!.stack;
    return undefined;
  }
  remember(ids: (string | null | undefined)[], stack: string): void {
    const at = Date.now();
    for (const id of ids) if (id) this.st.msgs[id] = { stack, at };
    saveRouterState(this.opts.stateFile, this.st);
  }

  cardAreas(itemIds: string[], messageIds: string[]): string[] {
    if (!itemIds.length && !messageIds.length) return [];
    return cardAreasFor(readCards(this.opts.itemsFile) ?? [], itemIds, messageIds);
  }

  async decide(text: string, ctx: RouteContext): Promise<RouteDecision> {
    this.refresh();
    const t0 = Date.now();
    const d = await routeMessage(text, ctx, this.cfg, this.opts.judge);
    this.opts.log(`router: → ${d.stack} by=${d.by} conf=${d.confidence.toFixed(2)} (${d.detail}) ms=${Date.now() - t0}`);
    return d;
  }

  /** The stack's persistent thread under the FIRSTMATE channel: reused, unarchived, or created once. */
  async thread(parent: TextChannel, s: StackDef): Promise<ThreadChannel> {
    const busy = this.creating.get(s.name);
    if (busy) return busy;
    const p = (async () => {
      const id = this.st.threads[s.name];
      // Only "gone" (Unknown Channel / Missing Access) makes a new thread. A network blip or a 5xx must not create a
      // duplicate stack thread and drop the old one from the state (the caller then keeps the message in FIRSTMATE).
      const old = id
        ? await parent.threads.fetch(id).catch((e: unknown) => {
            if (THREAD_GONE.has((e as { code?: unknown })?.code as number)) return null;
            throw e;
          })
        : null;
      if (old) {
        this.live.set(s.name, old);
        if (old.autoArchiveDuration !== ThreadAutoArchiveDuration.OneHour) await old.setAutoArchiveDuration?.(ThreadAutoArchiveDuration.OneHour).catch(() => {});
        if (old.archived) await old.setArchived(false).catch((e) => this.opts.log(`router: unarchive ${s.name}: ${(e as Error).message}`));
        return old;
      }
      const t = await parent.threads.create({ name: `${s.emoji} ${s.name} stack`, autoArchiveDuration: ThreadAutoArchiveDuration.OneHour, type: ChannelType.PublicThread, reason: "FIRSTMATE router stack" });
      this.st.threads[s.name] = t.id;
      this.live.set(s.name, t);
      this.tracker.threads = this.st.threads;
      saveRouterState(this.opts.stateFile, this.st);
      this.opts.log(`router: created thread ${t.id} for stack ${s.name}`);
      return t;
    })().finally(() => this.creating.delete(s.name));
    this.creating.set(s.name, p);
    return p;
  }

  /**
   * Owner 2026-11-07 (card heal-failed-finished): every stack thread under FIRSTMATE carries its stack's current
   * unique emoji (same source as the categories). Renames only threads whose name is off; returns the renames.
   */
  async renameThreads(parent: TextChannel): Promise<string[]> {
    this.refresh();
    const done: string[] = [];
    for (const s of this.cfg.stacks) {
      const id = this.st.threads[s.name];
      if (!id) continue;
      const t = this.live.get(s.name) ?? (await parent.threads.fetch(id).catch(() => null));
      if (!t) continue;
      const want = stackThreadName(t.name, s);
      // FE0F-insensitive (emojiKey): Discord may store the name without the variation selector; no rename loop.
      if (emojiKey(want) === emojiKey(t.name)) continue;
      const before = t.name;
      const wasArchived = t.archived === true;
      try {
        // An archived thread cannot be renamed: unarchive in the same edit, archive it again after.
        await t.edit({ name: want, ...(wasArchived ? { archived: false } : {}), reason: "unique stack emoji" });
        if (wasArchived) await t.setArchived(true).catch(() => {});
        done.push(`${before} -> ${want}`);
        this.opts.log(`router: renamed thread ${before} -> ${want}`);
      } catch (e) {
        this.opts.log(`router: rename thread ${s.name}: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /**
   * Route one FIRSTMATE message to a stack thread: post the silent router note under the owner's message,
   * post the message copy in the thread and return it. The caller runs that copy as an owner turn.
   */
  async forward(msg: Message, parent: TextChannel, s: StackDef, d: RouteDecision, text: string): Promise<Message> {
    const t = await this.thread(parent, s);
    const body = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;
    // The copy posts first so the FIRSTMATE note links the exact routed message, not the thread top.
    const copy = await t.send({ content: `📨 **From FIRSTMATE** · [source](<${msg.url}>)\n${body || "(attachment)"}`, ...QUIET });
    const copyUrl = messageLink(this.opts.guildId, t.id, copy.id);
    const note = await msg.reply({ content: routeNote(s, d, "queued", copyUrl), ...QUIET }).catch(() => null);
    this.remember([msg.id, note?.id, copy.id], s.name);
    this.routed.set(copy.id, { decision: d, note: note ?? undefined, sourceUrl: msg.url, copyUrl });
    return copy;
  }

  routedFor(copyId: string): Routed | undefined {
    return this.routed.get(copyId);
  }

  /** Queue job id → routed copy message id (to edit its FIRSTMATE note). */
  private readonly jobCopy = new Map<number, string>();

  /** A queued bot job that belongs to a stack (routed, a stack thread, a mapped channel, or FIRSTMATE general). */
  track(id: number, s: StackDef, preview: string, link: string, copyId: string, running: boolean): void {
    const r = this.routed.get(copyId);
    if (r) this.jobCopy.set(id, copyId);
    this.tracker.add({ id: String(id), stack: s.name, preview, link: r?.sourceUrl ?? link, by: r?.decision.by ?? "channel", detail: r?.decision.detail ?? "" });
    if (running) this.started(id);
  }
  private started(id: number): void {
    const j = this.tracker.get(String(id));
    if (!j || j.state !== "queued") return;
    this.tracker.start(String(id));
    const c = this.jobCopy.get(id);
    if (c) void this.noteState(c, "running");
  }
  /** After each queue change: start running jobs; queued jobs that left without starting were cancelled ("stopped"). */
  sync(running: number[], queued: number[]): void {
    for (const id of running) this.started(id);
    const waiting = new Set(queued);
    for (const s of this.tracker.status())
      for (const j of s.queued) {
        const id = Number(j.id);
        if (waiting.has(id) || running.includes(id)) continue;
        this.ended(id, "stopped"); // jobTransition("queued", cancel)
      }
  }
  /** Stack threads seen this process (to archive them when the stack is empty). */
  private readonly live = new Map<string, ThreadChannel>();
  private readonly closing = new Map<string, NodeJS.Timeout>();
  /** Grace before an empty stack's thread is archived (the last answer must post first). */
  archiveGraceMs = 90_000;
  /**
   * Owner 2026-10-23: stack threads are transient. When a stack has no running or queued jobs, archive its thread
   * (it leaves the channel list); the next routed message reopens it.
   */
  private closeIfEmpty(stack: string): void {
    clearTimeout(this.closing.get(stack));
    this.closing.set(stack, setTimeout(() => {
      this.closing.delete(stack);
      const st = this.tracker.status().find((x) => x.stack === stack);
      if (st && (st.running.length || st.queued.length)) return;
      const t = this.live.get(stack);
      if (!t || t.archived) return;
      void t.setArchived(true, "stack empty").then(() => this.opts.log(`router: archived empty ${stack} thread`), (e) => this.opts.log(`router: archive ${stack}: ${(e as Error).message}`));
    }, this.archiveGraceMs));
  }

  /** The job reached a final state (src/jobstate.ts): the queue's onSettled state, or "stopped" for a cancelled waiting job. */
  ended(id: number, state: FinalJobState): void {
    const job = this.tracker.get(String(id));
    if (!job) return;
    this.tracker.finish(String(id), state);
    this.closeIfEmpty(job.stack);
    const c = this.jobCopy.get(id);
    this.jobCopy.delete(id);
    if (c) void this.noteState(c, state);
  }

  /** Edit the FIRSTMATE note as the job moves; the job's tracker state follows. */
  async noteState(copyId: string, state: JobState): Promise<void> {
    const r = this.routed.get(copyId);
    const s = r ? this.stack(r.decision.stack) : undefined;
    if (state !== "running") this.routed.delete(copyId);
    if (!r?.note || !s) return;
    const url = r.copyUrl ?? messageLink(this.opts.guildId, this.st.threads[s.name] ?? "");
    await r.note.edit({ content: routeNote(s, r.decision, state, url) }).catch((e) => this.opts.log(`router: note edit: ${(e as Error).message}`));
  }

  /**
   * Owner 2026-10-26 (no-unknown-channel): forget stack thread ids that Discord reports gone (Unknown Channel /
   * Missing Access). Other errors keep the id. Returns the stacks whose id was dropped.
   */
  async pruneGone(fetch: (id: string) => Promise<unknown>, log: (s: string) => void = () => {}): Promise<string[]> {
    const dropped: string[] = [];
    for (const [name, id] of Object.entries(this.st.threads)) {
      const gone = await fetch(id).then((c) => !c, (e: unknown) => THREAD_GONE.has((e as { code?: unknown })?.code as number));
      if (!gone) continue;
      delete this.st.threads[name];
      this.live.delete(name);
      dropped.push(name);
      log(`router: stack ${name} thread ${id} is gone; dropped (recreated on the next routed message)`);
    }
    if (dropped.length) {
      this.tracker.threads = this.st.threads;
      saveRouterState(this.opts.stateFile, this.st);
    }
    return dropped;
  }

  /** Plain-text status for `!stacks`. */
  statusText(): string {
    const lines = [`🧭 **Stacks** — router ${this.cfg.enabled ? "on" : "off"}, at most ${this.cfg.maxParallelStacks} in parallel`];
    for (const s of this.tracker.status()) {
      const thread = s.threadId ? ` · ${channelMention(s.threadId, "thread closed")}` : "";
      lines.push(`${s.emoji} **${s.stack}**: ⚙️ ${s.running.length} · ⏳ ${s.queued.length} · ✅ ${s.done} · ❌ ${s.failed}${thread}`);
    }
    return lines.join("\n");
  }
}

export function stackRouterFiles(stateDir: string) {
  return { stateFile: join(stateDir, "router", "state.json"), statusFile: join(stateDir, "router", "stacks.json") };
}

export { GENERAL };
