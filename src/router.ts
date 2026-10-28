/**
 * FIRSTMATE fan-out router (owner 2026-10-23, card fm-router).
 *
 * FIRSTMATE stays the one channel the owner writes in. Before a turn starts, each owner message in the
 * FIRSTMATE channel goes through a route filter to a domain stack ("sub-orchestrator"): finance, webapp,
 * realestate, infra, kb, personal, or the FIRSTMATE general stack (fallback).
 *
 * - Route filter: deterministic rules first (forced `stack:<name>` prefix, reply to a routed message,
 *   channel, referenced card area, keywords), then the JEV judge (OpenRouter decisions API, the OMP judge
 *   role model) for ambiguous messages. A judge answer below `judgeMinConfidence`, a timeout or an error
 *   falls back to the FIRSTMATE general stack.
 * - Each stack is a keyed serial queue: one persistent Discord thread under the FIRSTMATE channel per stack
 *   (queue key = thread id, one job at a time) and one OMP session (`stack-<name>`). Different stacks run in
 *   parallel, at most `maxParallelStacks` at once (JobQueue group "stack").
 * - Report up: the router reply in the FIRSTMATE channel shows the stack and its state (⏳ → ⚙️ → ✅/❌),
 *   the FIRSTMATE queue board lists every stack job, and `stacks.json` / `/health` carry the status.
 *
 * This file holds the pure parts (rules, judge, status) so they can be tested without Discord.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { redact } from "./redact.ts";

export type StackDef = {
  /** Slug: queue/session name (`stack-<name>`), `stack:<name>` prefix, board label. */
  name: string;
  emoji: string;
  title: string;
  /** One line for the judge: what belongs to this stack. */
  description: string;
  /** Work folder of the stack's OMP session. `~/` allowed. */
  cwd: string;
  /** Lower-case words or phrases; one point per distinct match. */
  keywords: string[];
  /** FIRSTMATE card areas (case-insensitive) that belong to this stack. */
  areas: string[];
  /** Discord channels whose own messages belong to this stack (they keep their own queue; the board tags them). */
  channelIds: string[];
};

export type RouterConfig = {
  enabled: boolean;
  /** Global cap: stack jobs running at the same time (the bot's MAX_CONCURRENT still applies on top). */
  maxParallelStacks: number;
  judgeMinConfidence: number;
  judgeTimeoutMs: number;
  /** Stack used when nothing matches: the FIRSTMATE general stack (the existing FIRSTMATE session). */
  fallback: string;
  stacks: StackDef[];
};

export type RouteBy = "forced" | "inherit" | "channel" | "card" | "keyword" | "judge" | "fallback";
export type RouteDecision = { stack: string; by: RouteBy; confidence: number; detail: string };
export type JudgeResult = { stack: string; confidence: number } | null;
export type Judge = (text: string, stacks: StackDef[]) => Promise<JudgeResult>;

export const GENERAL = "firstmate";

export const DEFAULT_STACKS: StackDef[] = [
  {
    name: "finance",
    emoji: "💹",
    title: "Finance",
    description: "Finance: budgets, invoices, taxes, bills, finance alerts",
    cwd: "~/Github/finance",
    keywords: ["finance", "budget", "budgets", "invoice", "invoices", "tax", "taxes", "bill", "bills", "expense", "expenses", "payment", "account", "example-watch", "finance alert", "finance alerts"],
    areas: ["finance"],
    channelIds: [],
  },
  {
    name: "webapp",
    emoji: "📈",
    title: "Example Web App",
    description: "Example Web App web app: charts, screeners, backtests, research UI, example-webapp repo",
    cwd: "~/Github/finance/example-webapp",
    keywords: ["webapp", "web app", "research app", "charts page", "chart", "charts", "candles", "backtest", "backtests", "screener", "quantlab", "strategy dsl", "lenses"],
    areas: ["webapp"],
    channelIds: [],
  },
  {
    name: "realestate",
    emoji: "🏛️",
    title: "Client Co",
    description: "Client OS / ExampleClient client work: its web app, PlanetScale, marketing email, company docs",
    cwd: "~/Github/realestate",
    keywords: ["client co", "clientco", "realestate", "exampleclient", "exampleclient", "planetscale"],
    areas: ["client co"],
    channelIds: [],
  },
  {
    name: "infra",
    emoji: "🛠️",
    title: "Infra / bot",
    description: "Infrastructure and tooling: the Discord bots and the owner's experience inside Discord (incl. the FX-Video Activity video player), OMP, Herdr, the main host and second machine, Omarchy/Hyprland, systemd services, Tailscale, GitLab CI, dashboards, disks",
    cwd: "~/Github/tools",
    keywords: ["discord bot", "the bot", "omp", "herdr", "heeler", "pane", "panes", "main", "omarchy", "hyprland", "systemd", "service", "services", "tailscale", "streamsrv", "stream-client", "gitlab", "pipeline", "btrfs", "disk", "dashboard", "fm-autoclear", "fm-spawn", "worktree", "restart", "channel", "channels", "thread", "threads", "ssh", "gpu", "discord", "activity", "discord activity", "example-activity", "framevid", "fx-video", "video player", "player", "bots"],
    areas: ["tools", "ops", "discord", "discord bot", "discord/herdr", "omp", "infra", "ai"],
    channelIds: [],
  },
  {
    name: "kb",
    emoji: "📚",
    title: "Knowledge / research",
    description: "Knowledge bases and research: transcription, YouTube/Instagram/TikTok/X scraping, research reports, papers, summaries",
    cwd: "~/Github/knowledge-bases",
    keywords: ["kb", "knowledge base", "knowledge bases", "transcribe", "transcription", "transcripts", "transcript", "youtube", "tiktok", "instagram", "podcast", "paper", "papers", "research", "summarize", "summary of", "scrape", "scraping", "x post", "tweet", "tweets"],
    areas: ["knowledge bases", "research", "transcription"],
    channelIds: [],
  },
  {
    name: "fun",
    emoji: "🎮",
    title: "Fun",
    description: "Apps and hobby projects: DemoApp 64, apps plugins, ports, emulators, demo, DemoApp, example-activity video",
    cwd: "~/Github/fun",
    keywords: ["demoapp", "apps", "apps", "plugin", "plugins", "ports", "tool", "retro", "demo", "demoapp", "rocket belt", "example-activity"],
    areas: ["fun", "apps"],
    channelIds: [],
  },
  {
    name: "personal",
    emoji: "🏠",
    title: "Personal",
    description: "Personal life: reminders, home devices (Nest, blinds, TV), shopping, appointments, travel, taxes, family",
    cwd: "~/Github",
    keywords: ["remind", "reminder", "reminders", "home", "nest", "blinds", "thermostat", "tv", "shopping", "buy", "order", "appointment", "doctor", "dentist", "trip", "travel", "flight", "taxes", "tax", "family", "birthday", "gift"],
    areas: ["personal", "home", "reminders", "taxes"],
    channelIds: [],
  },
  {
    name: GENERAL,
    emoji: "👷",
    title: "FIRSTMATE general",
    description: "Everything else: coordination, status questions, priorities, follow-ups to FIRSTMATE's own questions",
    cwd: "~/Github",
    keywords: [],
    areas: ["questions"],
    channelIds: [],
  },
];

export const DEFAULT_ROUTER: RouterConfig = {
  enabled: true,
  maxParallelStacks: 4,
  judgeMinConfidence: 0.6,
  judgeTimeoutMs: 4_000,
  fallback: GENERAL,
  stacks: DEFAULT_STACKS,
};

function expandHome(p: string): string {
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return isAbsolute(p) ? p : join(home, p);
}

/** Merge a partial config (config.json `router`) over the defaults. Stacks given by name replace or add. */
/** config.json `router` (every key optional). */
export type RouterConfigInput = Partial<Omit<RouterConfig, "stacks">> & { stacks?: Partial<StackDef>[] };

export function routerConfig(raw?: RouterConfigInput): RouterConfig {
  const stacks = DEFAULT_STACKS.map((s) => ({ ...s }));
  for (const r0 of raw?.stacks ?? []) {
    if (!r0?.name) continue;
    // A null field (e.g. "areas": null in config.json) keeps the default instead of breaking routing.
    const r = Object.fromEntries(Object.entries(r0).filter(([, v]) => v !== null && v !== undefined)) as Partial<StackDef>;
    const i = stacks.findIndex((s) => s.name === r.name);
    if (i >= 0) stacks[i] = { ...stacks[i]!, ...r } as StackDef;
    else stacks.push({ emoji: "🧩", title: r.name, description: r.name, cwd: "~/Github", keywords: [], areas: [], channelIds: [], ...r } as StackDef);
  }
  const c: RouterConfig = { ...DEFAULT_ROUTER, ...raw, stacks: stacks.map((s) => ({ ...s, cwd: expandHome(s.cwd) })) };
  if (!c.stacks.some((s) => s.name === c.fallback)) c.fallback = GENERAL;
  c.maxParallelStacks = Math.max(1, Math.floor(c.maxParallelStacks || 1));
  return c;
}

const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'");
/** Whole-word (or whole-phrase) match; a phrase may span hyphens/spaces. */
function hasWord(text: string, kw: string): boolean {
  const pat = norm(kw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
  return new RegExp(`(^|[^a-z0-9])${pat}([^a-z0-9]|$)`).test(text);
}

export function keywordScores(text: string, stacks: StackDef[]): { stack: string; score: number; hits: string[] }[] {
  const t = norm(text);
  return stacks
    .map((s) => {
      const hits = [...new Set(s.keywords)].filter((k) => hasWord(t, k));
      return { stack: s.name, score: hits.length, hits };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

export type RouteContext = {
  channelId?: string;
  parentId?: string | null;
  /** Stack of the message the owner replied to (or of a menu's source message), if known. */
  inherited?: string;
  /** Areas of FIRSTMATE cards the message names (⚓ item:, dashboard ?item=, replied card message). */
  cardAreas?: string[];
};

const FORCED = /^\s*(?:stack:\s*|@)([a-z][a-z0-9-]*)\b[\s:,-]*/i;

/** Strip a leading `stack:<name>` / `@<name>` prefix when it names a stack. */
export function forcedStack(text: string, stacks: StackDef[]): { stack: string; rest: string } | null {
  const m = FORCED.exec(text);
  const name = m?.[1]?.toLowerCase();
  if (!m || !name) return null;
  const s = stacks.find((x) => x.name === name || (name === "general" && x.name === GENERAL));
  return s ? { stack: s.name, rest: text.slice(m[0].length).trim() } : null;
}

/** Deterministic rules only. `decision` null = ambiguous (judge next); `candidates` = tied keyword stacks. */
export function ruleRoute(text: string, ctx: RouteContext, cfg: RouterConfig): { decision: RouteDecision | null; candidates: string[] } {
  const f = forcedStack(text, cfg.stacks);
  if (f) return { decision: { stack: f.stack, by: "forced", confidence: 1, detail: `prefix ${f.stack}` }, candidates: [] };
  // Owner rule 2026-10-24: any message with the word "webapp" goes to the webapp stack (beats inherit, channel, card area and keyword ties; only a stack: prefix wins).
  if (/\bwebapp\b/i.test(text) && cfg.stacks.some((s) => s.name === "webapp")) {
    return { decision: { stack: "webapp", by: "keyword", confidence: 0.95, detail: "word webapp (owner rule)" }, candidates: [] };
  }
  const inh = ctx.inherited && cfg.stacks.some((s) => s.name === ctx.inherited) ? ctx.inherited : undefined;
  if (inh) return { decision: { stack: inh, by: "inherit", confidence: 1, detail: "reply to a routed message" }, candidates: [] };
  for (const id of [ctx.channelId, ctx.parentId]) {
    const s = id ? cfg.stacks.find((x) => x.channelIds.includes(id)) : undefined;
    if (s) return { decision: { stack: s.name, by: "channel", confidence: 1, detail: `channel ${id}` }, candidates: [] };
  }
  const areas = (ctx.cardAreas ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean);
  if (areas.length) {
    const hit = cfg.stacks.filter((s) => s.areas.some((a) => areas.includes(a.toLowerCase())));
    if (hit.length === 1) return { decision: { stack: hit[0]!.name, by: "card", confidence: 0.95, detail: `card area ${areas.join(",")}` }, candidates: [] };
  }
  const scores = keywordScores(text, cfg.stacks);
  const top = scores[0];
  const second = scores[1]?.score ?? 0;
  if (top && top.score > second) {
    const margin = top.score - second;
    const confidence = Math.min(0.95, 0.6 + 0.12 * margin + (second === 0 ? 0.1 : 0));
    // A lone weak hit next to a competing stack stays ambiguous: let the judge decide.
    if (second === 0 || margin >= 2) return { decision: { stack: top.stack, by: "keyword", confidence, detail: `keywords ${top.hits.join(", ")}` }, candidates: [] };
  }
  return { decision: null, candidates: scores.filter((s) => s.score === top?.score).map((s) => s.stack) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  const { promise, resolve } = Promise.withResolvers<"timeout">();
  const t = setTimeout(() => resolve("timeout"), ms);
  return Promise.race([p, promise]).finally(() => clearTimeout(t));
}

/**
 * Financial or account details never go to the external judge (owner privacy rule: no financial data to
 * JEV/TypeSafe). Such a message stays local: the first tied keyword stack, else the fallback.
 */
export const FINANCIAL_RE = new RegExp(
  [
    String.raw`[$€£]\s?\d`,
    String.raw`\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b`, // 52,300 / 4,812.33
    String.raw`\b\d+(?:\.\d+)?\s?[kmb]\b`, // 1.2M, 40k
    String.raw`\b\d[\d,.]*\s?(?:shares?|contracts?|usd|eur|dollars?|bucks)\b`,
    String.raw`\b(?:sell|buy|short|cover)\s+\d`,
    String.raw`\b[Uu]\d{6,}\b`, // account-style account id
    String.raw`\baccount\s*(?:#|no\.?|number)?\s*\d{3,}`,
    String.raw`\b(?:balance|bank|banking|checking|savings|credit card|debit card|card number|salary|paycheck|net worth|p&l|pnl|ira|401k|roth|wire|transfer|loan|mortgage|invoice|tax return|iban|routing number|ssn|password|passcode|otp|2fa code)\b`,
  ].join("|"),
  "i",
);

/** Rules, then the judge for ambiguous messages, then the fallback stack. Never throws. */
export async function routeMessage(text: string, ctx: RouteContext, cfg: RouterConfig, judge?: Judge): Promise<RouteDecision> {
  const r = ruleRoute(text, ctx, cfg);
  if (r.decision) return r.decision;
  const tie = r.candidates.length ? ` (keyword tie: ${r.candidates.join(", ")})` : "";
  // Any finance keyword (top or runner-up) also keeps the message local (positions and orders are financial details).
  const tradingHit = keywordScores(text, cfg.stacks).some((x) => x.stack === "finance");
  if (FINANCIAL_RE.test(text) || tradingHit) {
    const local = tradingHit ? "finance" : (r.candidates[0] ?? cfg.fallback);
    return { stack: local, by: local === cfg.fallback ? "fallback" : "keyword", confidence: 0.5, detail: `financial details stay local, no judge${tie}` };
  }
  // Short follow-ups ("ok", "yes do it", "2") answer FIRSTMATE's last reply: no judge (it is confident even without context).
  if (!r.candidates.length && text.trim().split(/\s+/).length <= 3) return { stack: cfg.fallback, by: "fallback", confidence: 0, detail: "short follow-up, no judge" };
  if (judge && text.trim()) {
    try {
      const j = await withTimeout(judge(text, cfg.stacks), cfg.judgeTimeoutMs);
      if (j === "timeout") return { stack: cfg.fallback, by: "fallback", confidence: 0, detail: `judge timeout${tie}` };
      if (j && cfg.stacks.some((s) => s.name === j.stack)) {
        if (j.confidence >= cfg.judgeMinConfidence) return { stack: j.stack, by: "judge", confidence: j.confidence, detail: `judge ${j.stack} ${j.confidence.toFixed(2)}${tie}` };
        return { stack: cfg.fallback, by: "fallback", confidence: j.confidence, detail: `judge ${j.stack} ${j.confidence.toFixed(2)} below ${cfg.judgeMinConfidence}${tie}` };
      }
      return { stack: cfg.fallback, by: "fallback", confidence: 0, detail: `judge gave no answer${tie}` };
    } catch (e) {
      return { stack: cfg.fallback, by: "fallback", confidence: 0, detail: `judge error ${(e as Error).message.slice(0, 80)}${tie}` };
    }
  }
  return { stack: cfg.fallback, by: "fallback", confidence: 0, detail: `no rule matched${tie}` };
}

/**
 * JEV judge: OpenRouter decisions API with the OMP judge-role model (`~typesafe/jev-latest`), ~150-250 ms.
 * The API key comes from OMP's own credential store through `omp token openrouter` (kept in memory only,
 * never logged). The message is redacted (src/redact.ts) and cut to 1500 characters before it leaves.
 */
export function jevJudge(opts: {
  ompBin: string;
  endpoint?: string;
  model?: string;
  fetchFn?: typeof fetch;
  keyFn?: () => Promise<string>;
  log?: (s: string) => void;
}): Judge {
  const endpoint = opts.endpoint ?? "https://openrouter.ai/api/alpha/decisions";
  const model = opts.model ?? "~typesafe/jev-latest";
  const f = opts.fetchFn ?? fetch;
  let cached: { key: string; at: number } | null = null;
  const keyFn =
    opts.keyFn ??
    (async () => {
      const p = Bun.spawn([opts.ompBin, "token", "openrouter"], { stdout: "pipe", stderr: "ignore" });
      const out = (await new Response(p.stdout).text()).trim();
      if ((await p.exited) !== 0 || !out) throw new Error("no openrouter credential");
      return out;
    });
  return async (text, stacks) => {
    if (!cached || Date.now() - cached.at > 10 * 60_000) cached = { key: await keyFn(), at: Date.now() };
    const criteria = Object.fromEntries(stacks.map((s) => [s.name, s.description]));
    const body = {
      model,
      state: { task: "Route one owner message to the work stack that should handle it.", message: redact(text).text.slice(0, 1500) },
      questions: {
        stack: {
          type: "choice",
          criteria,
          instructions: { goal: "Pick the stack whose domain best matches the message.", rules: [`If the message is a general question, a status request or unclear, pick ${GENERAL}.`] },
        },
      },
    };
    const res = await f(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cached.key}` }, body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) cached = null;
    if (!res.ok) throw new Error(`decisions HTTP ${res.status}`);
    const j = (await res.json()) as { answers?: { stack?: { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } } };
    const a = j.answers?.stack;
    const choice = typeof a?.choice === "string" ? a.choice : null;
    if (!choice) return null;
    const p = a?.probabilities?.[choice];
    const confidence = typeof a?.confidence === "number" ? a.confidence : typeof p === "number" ? p : 0;
    return { stack: choice, confidence };
  };
}

/** Areas of cards named by item id, or whose q/src message is one of the message ids. */
export function cardAreasFor(items: { id?: string; area?: string; q?: string; src?: string }[], itemIds: string[], messageIds: string[]): string[] {
  const ids = new Set(itemIds);
  const msgs = new Set(messageIds);
  const tail = (u?: string) => /\/(\d{5,25})\/?$/.exec(u ?? "")?.[1];
  const out = new Set<string>();
  for (const c of items) {
    if (!c.area) continue;
    const q = tail(c.q);
    const s = tail(c.src);
    if ((c.id && ids.has(c.id)) || (q && msgs.has(q)) || (s && msgs.has(s))) out.add(c.area);
  }
  return [...out];
}

// ---------- status ("report up") ----------

export type StackJobState = "queued" | "running" | "done" | "failed";
export type StackJob = { id: string; stack: string; preview: string; link?: string; state: StackJobState; at: number; by: RouteBy; detail: string };
export type StackStatus = { stack: string; emoji: string; title: string; threadId?: string; running: StackJob[]; queued: StackJob[]; done: number; failed: number; last?: StackJob };

/**
 * Per-stack job states for the FIRSTMATE board, `/health` and `stacks.json`. In memory; the file is a
 * read-only snapshot for FIRSTMATE and other tools (written atomically).
 */
export class StackTracker {
  private readonly jobs = new Map<string, StackJob>();
  private readonly counts = new Map<string, { done: number; failed: number; last?: StackJob }>();
  threads: Record<string, string> = {};
  onChange?: () => void;
  constructor(
    private readonly cfg: RouterConfig,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {}

  add(job: Omit<StackJob, "state" | "at">): void {
    this.jobs.set(job.id, { ...job, state: "queued", at: this.now() });
    this.changed();
  }
  start(id: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.state = "running";
    j.at = this.now();
    this.changed();
  }
  /** `ok` undefined: cancelled (removed without counting). */
  finish(id: string, ok?: boolean): void {
    const j = this.jobs.get(id);
    if (!j) return;
    this.jobs.delete(id);
    if (ok !== undefined) {
      const c = this.counts.get(j.stack) ?? { done: 0, failed: 0 };
      if (ok) c.done++;
      else c.failed++;
      c.last = { ...j, state: ok ? "done" : "failed", at: this.now() };
      this.counts.set(j.stack, c);
    }
    this.changed();
  }
  get(id: string): StackJob | undefined {
    return this.jobs.get(id);
  }
  status(): StackStatus[] {
    return this.cfg.stacks.map((s) => {
      const mine = [...this.jobs.values()].filter((j) => j.stack === s.name);
      const c = this.counts.get(s.name);
      return {
        stack: s.name,
        emoji: s.emoji,
        title: s.title,
        ...(this.threads[s.name] ? { threadId: this.threads[s.name] } : {}),
        running: mine.filter((j) => j.state === "running"),
        queued: mine.filter((j) => j.state === "queued"),
        done: c?.done ?? 0,
        failed: c?.failed ?? 0,
        ...(c?.last ? { last: c.last } : {}),
      };
    });
  }
  /** Lines for the FIRSTMATE queue board: busy stacks only. `link(job)` renders one job. */
  boardLines(link: (j: StackJob) => string): string[] {
    const busy = this.status().filter((s) => s.running.length || s.queued.length);
    if (!busy.length) return [];
    const lines = ["🧭 **Stacks**"];
    for (const s of busy) {
      const rows = [...s.running.map((j) => `⚙️ ${link(j)}`), ...s.queued.map((j, n) => `${n + 1}. ${link(j)}`)];
      lines.push(`${s.emoji} **${s.stack}**: ${rows.join(" · ")}`);
    }
    return lines;
  }
  private changed(): void {
    this.onChange?.();
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ updatedAt: new Date(this.now()).toISOString(), stacks: this.status() }, null, 1)}\n`);
      renameSync(tmp, this.file);
    } catch {}
  }
}

// ---------- persistence: stack threads and routed message ids ----------

export type RouterState = { threads: Record<string, string>; msgs: Record<string, { stack: string; at: number }> };

export function loadRouterState(file: string): RouterState {
  try {
    if (existsSync(file)) {
      const d = JSON.parse(readFileSync(file, "utf8")) as Partial<RouterState>;
      const st = { threads: d.threads ?? {}, msgs: d.msgs ?? {} };
      applyReroute(file + ".reroute.json", st);
      return st;
    }
  } catch {}
  return { threads: {}, msgs: {} };
}

/**
 * Owner recategorization (2026-10-23): `<state>.reroute.json` = {"stack":"infra","ids":["<msg id>",...]}
 * moves already-routed messages to another stack at load time (replies to them then inherit it).
 * The in-memory state overwrites state.json on every save, so a manual edit while the bot runs is lost;
 * this file is applied at the next start and then removed.
 */
export function applyReroute(file: string, st: RouterState): number {
  if (!existsSync(file)) return 0;
  let n = 0;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as { stack?: string; ids?: string[] };
    if (r.stack && Array.isArray(r.ids)) for (const id of r.ids) { st.msgs[id] = { stack: r.stack, at: st.msgs[id]?.at ?? Date.now() }; n++; }
    renameSync(file, file + ".applied");
  } catch {}
  return n;
}

/** Keep the newest 3000 routed message ids, at most 30 days old. */
export function saveRouterState(file: string, st: RouterState, now = Date.now()): void {
  const keep = Object.entries(st.msgs)
    .filter(([, v]) => now - v.at < 30 * 86_400_000)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 3000);
  st.msgs = Object.fromEntries(keep);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(st));
    renameSync(`${file}.tmp`, file);
  } catch {}
}

/** The router reply's text in the FIRSTMATE channel (edited in place as the job moves). */
export function routeNote(s: StackDef, d: RouteDecision, state: StackJobState | "cancelled", threadUrl: string): string {
  const icon = { queued: "⏳", running: "⚙️", done: "✅", failed: "❌", cancelled: "🛑" }[state];
  const why = d.by === "judge" ? `judge ${Math.round(d.confidence * 100)}%` : d.by === "fallback" ? "fallback" : d.by;
  const word = { queued: "queued", running: "running", done: "done", failed: "failed", cancelled: "cancelled" }[state];
  return `🧭 → stack: ${s.emoji} **${s.name}** (${why}) · ${icon} ${word} · [open the ${s.name} thread](<${threadUrl}>)`;
}

/** Header the stack's run gets in front of the owner's text. */
export function stackPreamble(s: StackDef, d: RouteDecision, sourceUrl: string): string {
  return [
    `[FIRSTMATE router] You are the ${s.emoji} ${s.title} stack (sub-orchestrator "${s.name}") under FIRSTMATE.`,
    `The router sent you this owner message from the FIRSTMATE channel (${d.by}: ${d.detail}). Source: ${sourceUrl}`,
    "Work only on this domain; related work stays in this stack. Report up to FIRSTMATE: keep the FIRSTMATE tracker current (fm find/fm set; set `fm field <id> stack " + s.name + "` on cards you create or work), and end with a short result.",
    "If the message belongs to another domain, say so in one line and name the stack (the owner can resend it with `stack:<name>`).",
    "",
  ].join("\n");
}
