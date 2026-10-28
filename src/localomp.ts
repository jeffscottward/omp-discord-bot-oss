/**
 * 🧠-local-omp channel (owner 2026-10-19, card local-omp-channel): owner messages run ONE OMP turn with the LOCAL
 * llama.cpp model (`local-coder/local-coder`, 127.0.0.1:8091) and tools. Never Claude, never a cloud model.
 *
 * Fail-closed design:
 * - OMP runs with its own agent dir (PI_CODING_AGENT_DIR = state/local-omp-agent) whose config.yml and models.yml
 *   this module writes. That dir has no cloud credentials; every model role points at local-coder; advisor off;
 *   thinking off (auto thinking would call the cloud judge). Before each turn models.yml is re-checked: only the
 *   loopback local-coder provider may exist.
 * - The child gets a minimal environment (no API keys) and runs in bwrap: `/` read-only, $HOME replaced by an empty
 *   read-only tmpfs, only the work dir and the agent dir writable. Writes outside the work dir fail.
 * - Each assistant message's provider/model is checked in the JSON stream; any other model kills the run.
 * Tools: LOCAL_OMP_TOOLS (default read,grep,glob,write,edit). `read` also fetches URLs. bash is off by default;
 * the owner can enable it with config.json `localOmpTools` (it still runs inside the same sandbox).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitMessage } from "./split.ts";

export const MODEL = "local-coder/local-coder";
export const SERVER = "http://127.0.0.1:8091";
export const LABEL = "🧠 local-omp";
export const DOWN_TEXT = "⚠️ local model is off — run `local-coder start` on the main host. Nothing ran (no cloud fallback).";
export const DEFAULT_TOOLS = "read,grep,glob,write,edit";
const SYSTEM = [
  "You are local-omp, a local model running on the owner's main with a few tools.",
  "Use the read tool to read files and web pages (pass a URL as the path).",
  "Your working directory is the only place you can write; write files there with relative paths.",
  "When you summarize a source, use your own words; do not copy long passages.",
  "Answer concisely in Discord markdown.",
].join(" ");

export const MODELS_YML = `# Written by omp-discord-bot src/localomp.ts. Loopback only; no API key.
providers:
  local-coder:
    baseUrl: ${SERVER}/v1
    api: openai-completions
    auth: none
    models:
      - id: local-coder
        name: Local Coder (main GPU)
        reasoning: true
        input: [text]
        contextWindow: 65536
        maxTokens: 8192
`;
export const CONFIG_YML = `# Written by omp-discord-bot src/localomp.ts. Every role is the local model; no advisor; no auto thinking.
setupVersion: 2
modelRoles:
  default: ${MODEL}
  smol: ${MODEL}
  slow: ${MODEL}
  plan: ${MODEL}
  judge: ${MODEL}
  advisor: ${MODEL}
defaultThinkingLevel: off
advisor:
  enabled: false
startup:
  quiet: true
`;

/** Fail closed: true only when every baseUrl in models.yml is the loopback llama.cpp server and only local-coder exists. */
export function modelsYmlIsLocal(text: string): boolean {
  const urls = [...text.matchAll(/baseUrl:\s*(\S+)/g)].map((m) => m[1]);
  const providers = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  return urls.length === 1 && urls[0] === `${SERVER}/v1` && providers.length === 1 && providers[0] === "local-coder";
}
/** Fail closed per message: the stream must only show the local provider/model. */
export function isLocalMessage(m: { provider?: unknown; model?: unknown }): boolean {
  return m.provider === "local-coder" && m.model === "local-coder";
}

export type Route = "local-omp" | "ignore" | "other";
export function routeMessage(m: { channelId: string; authorId: string; bot: boolean }, channelId: string, ownerId: string): Route {
  if (!channelId || m.channelId !== channelId) return "other";
  return m.authorId === ownerId && !m.bot ? "local-omp" : "ignore";
}
export const isReset = (t: string) => /^\s*\/?reset\s*$/i.test(t);
export const isStop = (t: string) => /^\s*\/?stop\s*$/i.test(t);

export function ompArgs(o: { prompt: string; tools: string; resume?: string | null; model?: string; system?: string }): string[] {
  return [
    "-p", "--mode", "json", "--model", o.model ?? MODEL, "--thinking", "off",
    // tools "none": the model gets no tools (OpenRouter rejects tool requests for models without tool support).
    "--no-extensions", "--no-skills", "--no-rules", ...(o.tools === "none" ? ["--no-tools"] : ["--tools", o.tools]), "--system-prompt", o.system ?? SYSTEM,
    ...(o.resume ? ["--resume", o.resume] : []),
    o.prompt,
  ];
}

/** bwrap command: / read-only, $HOME an empty read-only tmpfs, only work + agent dirs writable. */
export function sandboxArgv(o: { home: string; ompBin: string; agentDir: string; workDir: string; args: string[] }): string[] {
  const bin = join(o.home, ".omp-bin", "omp");
  return [
    // /tmp and /run are private: host scratch files and user sockets (systemd bus, Herdr, Wayland) are not reachable.
    "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--unshare-ipc",
    "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve", // /etc/resolv.conf points here (DNS for URL reads)
    "--tmpfs", o.home, "--ro-bind", o.ompBin, bin,
    // OMP needs a writable ~/.omp (run files; discarded) and its native addon from ~/.omp/natives (read-only).
    "--tmpfs", join(o.home, ".omp"), "--tmpfs", join(o.home, ".cache"),
    "--ro-bind-try", join(o.home, ".omp", "natives"), join(o.home, ".omp", "natives"),
    "--bind", o.agentDir, o.agentDir,
    "--ro-bind", join(o.agentDir, "models.yml"), join(o.agentDir, "models.yml"),
    "--ro-bind", join(o.agentDir, "config.yml"), join(o.agentDir, "config.yml"),
    "--bind", o.workDir, o.workDir, "--remount-ro", o.home,
    "--chdir", o.workDir,
    "--unshare-pid", "--die-with-parent", "--new-session", "--", bin, ...o.args,
  ];
}

/**
 * What a pinned-model channel runs (owner 2026-10-19: the same sandboxed OMP turn for the local model and for
 * OpenRouter Venice). Every check fails closed: a wrong models.yml, a missing credential or another model refuses.
 */
export interface Profile {
  /** `--model` value: `<provider>/<model id>`. */
  model: string;
  system: string;
  /** Checked before each turn; null = no health check. */
  healthUrl: string | null;
  downText: string;
  modelsYml: string;
  configYml: string;
  modelsOk(text: string): boolean;
  /** Per assistant message in the JSON stream: false kills the run. */
  allowed(m: { provider?: unknown; model?: unknown }): boolean;
  /** Extra child environment (e.g. the provider key); null = refuse the turn. */
  env(): Record<string, string> | null;
  /** Text when env() returns null. */
  noEnvText: string;
  /** Tools when the channel config sets none. */
  defaultTools: string;
}
export const LOCAL_PROFILE: Profile = {
  model: MODEL,
  system: SYSTEM,
  healthUrl: `${SERVER}/health`,
  downText: DOWN_TEXT,
  modelsYml: MODELS_YML,
  configYml: CONFIG_YML,
  modelsOk: modelsYmlIsLocal,
  allowed: isLocalMessage,
  env: () => ({}),
  noEnvText: "",
  defaultTools: DEFAULT_TOOLS,
};

/** Progress text: tool lines + answer so far. */
export function render(tools: string[], answer: string, done: boolean, note = "", label = LABEL): string {
  const t = tools.length ? `${tools.slice(-8).map((x) => `🔧 ${x}`).join("\n")}\n` : "";
  const body = answer.trim() ? answer.trim() : done ? "(no answer)" : "💭 working…";
  return `${label}\n${t}${body}${done ? "" : " ▌"}${note ? `\n${note}` : ""}`;
}
/**
 * Owner 2026-10-19 (same harness as Claude): status-only progress line. The answer is posted separately through the
 * bridge's normal reply path (ask menus, dashboard link, attachments), so this line only shows liveness.
 */
export function renderStatus(o: { label: string; elapsedMs: number; tools: string[]; done: boolean; note?: string; queued?: number }): string {
  const secs = Math.floor(o.elapsedMs / 1000);
  const t = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
  const last = o.tools.at(-1);
  const head = o.done
    ? `${o.label} · ✅ Done in ${t}${o.tools.length ? ` · ${o.tools.length} tool${o.tools.length === 1 ? "" : "s"}` : ""}`
    : `${o.label} · ⚙️ Working… ${t}${o.tools.length ? ` · ${o.tools.length} tool${o.tools.length === 1 ? "" : "s"}` : " · 💭 thinking"}`;
  const lines = [head];
  if (!o.done && last) lines.push(`🔧 ${last}`);
  if (o.queued) lines.push(`📨 ${o.queued} message${o.queued === 1 ? "" : "s"} queued: they run next.`);
  if (o.note) lines.push(o.note);
  return lines.join("\n");
}
/** Short tool description for the progress list. */
export function toolLine(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const v = a.path ?? a.pattern ?? a.command ?? "";
  return `${name}${v ? ` \`${String(v).slice(0, 120)}\`` : ""}`;
}

/** `final`: the turn is over (the bridge removes the Stop button). */
export type Out = { edit(text: string, final?: boolean): Promise<void> };
export type Child = { stdout: AsyncIterable<Uint8Array> | NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream | null; kill(sig?: string): void; exited: Promise<number> };
export type Deps = {
  stateDir: string;
  workDir: string;
  tools?: string;
  ompBin?: string;
  fetch?: typeof fetch;
  /** `progress`: a status message of a running turn (the bridge adds a Stop button). */
  send(text: string, opts?: { progress?: boolean }): Promise<Out>;
  /**
   * Owner 2026-10-19: when set, the final answer goes through the bridge's normal reply path (ask menus, dashboard
   * link, attachments, copy blocks) and the progress message shows liveness only. Unset = old single-message mode.
   */
  deliver?(answer: string, runStartMs: number): Promise<void>;
  /** Appended to the profile's system prompt (bridge rules such as the ask-block format). */
  extraSystem?: string;
  /** Liveness refresh while the model is silent (ms). Default 5000. */
  heartbeatMs?: number;
  log?(s: string): void;
  /** Injected for tests; default spawns the bwrap command. */
  spawn?(argv: string[], env: Record<string, string>): Child;
  editEveryMs?: number;
  timeoutMs?: number;
  /** State name per channel (agent dir, session file). Default "local-omp". */
  key?: string;
  /** Message prefix. Default LABEL. */
  label?: string;
  /** Model profile. Default LOCAL_PROFILE. */
  profile?: Profile;
};

export class LocalOmpChat {
  #busy = false;
  #halt = false;
  #child: Child | null = null;
  /** Owner messages sent while a turn runs (harness mode): they run next, in one follow-up turn. */
  #pending: string[] = [];
  constructor(private d: Deps) {}
  get busy() { return this.#busy; }
  /** Stop button / `stop`: end the running turn and any auto-continue; queued messages are kept. */
  stop(): boolean {
    if (!this.#busy) return false;
    this.#halt = true; this.#child?.kill("SIGTERM");
    return true;
  }
  get #key() { return this.d.key ?? "local-omp"; }
  get #label() { return this.d.label ?? LABEL; }
  get #profile() { return this.d.profile ?? LOCAL_PROFILE; }
  get agentDir() { return join(this.d.stateDir, `${this.#key}-agent`); }
  get #sessFile() { return join(this.d.stateDir, `${this.#key}-session.json`); }
  sessionId(): string | null {
    try {
      const j: unknown = JSON.parse(readFileSync(this.#sessFile, "utf8"));
      return j && typeof j === "object" && "id" in j && typeof j.id === "string" ? j.id : null;
    } catch { return null; }
  }
  #setSession(id: string | null) {
    mkdirSync(this.d.stateDir, { recursive: true });
    if (id) writeFileSync(this.#sessFile, JSON.stringify({ id })); else rmSync(this.#sessFile, { force: true });
  }
  /** Write the pinned agent config; then verify it (fail closed). */
  prepare(): boolean {
    mkdirSync(this.agentDir, { recursive: true });
    mkdirSync(this.d.workDir, { recursive: true });
    const pr = this.#profile;
    writeFileSync(join(this.agentDir, "models.yml"), pr.modelsYml);
    writeFileSync(join(this.agentDir, "config.yml"), pr.configYml);
    return pr.modelsOk(readFileSync(join(this.agentDir, "models.yml"), "utf8"));
  }

  async handle(text: string): Promise<void> {
    if (isStop(text)) {
      // Owner 2026-10-19: with unlimited auto-continue, `stop` ends the running turn and the continue loop.
      if (!this.stop()) { await this.d.send(`${this.#label}: nothing is running.`); return; }
      await this.d.send(`${this.#label}: 🛑 stopping the turn and auto-continue.${this.#pending.length ? " Queued messages run next." : ""}`); return;
    }
    if (isReset(text)) {
      // A running turn would write its session id back after a reset; refuse instead of silently undoing it.
      if (this.#busy) { await this.d.send(`${this.#label}: a turn is still running; send \`reset\` after it finishes.`); return; }
      this.#setSession(null); await this.d.send(`${this.#label}: new session; the next message starts fresh.`); return;
    }
    if (this.#busy) {
      if (!this.d.deliver) { await this.d.send(`${this.#label}: still working on the previous message; send again after it finishes.`); return; }
      // Same as the Claude path: a message during a run waits and runs next (steer). Stop ends the current turn first.
      this.#pending.push(text);
      await this.d.send(`${this.#label}: 📨 queued; it runs after the current turn. Tap Stop to end the current turn now.`);
      return;
    }
    this.#busy = true; this.#halt = false;
    // Time-limit auto-continue moved to the bridge (main.ts, timeLimitContinueChannelIds; owner 2026-10-19).
    try {
      await this.#run(text);
    } finally {
      this.#busy = false; this.#halt = false; this.#child = null;
    }
    if (this.#pending.length) {
      const next = this.#pending.length === 1 ? this.#pending[0]! : this.#pending.map((t, i) => `(${i + 1}) ${t}`).join("\n\n");
      this.#pending = [];
      await this.handle(next);
    }
  }

  /** One turn. Returns true when it was stopped by the time limit. */
  async #run(prompt: string): Promise<boolean> {
    const f = this.d.fetch ?? fetch;
    const pr = this.#profile;
    if (pr.healthUrl) {
      try {
        const r = await f(pr.healthUrl, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(String(r.status));
      } catch { await this.d.send(pr.downText); return false; }
    }
    if (!this.prepare()) { await this.d.send(`⚠️ ${this.#label}: model config is not the pinned model only; refused (fail closed).`); return false; }
    const extraEnv = pr.env();
    if (!extraEnv) { await this.d.send(pr.noEnvText); return false; }

    const home = homedir();
    const system = this.d.extraSystem ? `${pr.system}\n\n${this.d.extraSystem}` : pr.system;
    const args = ompArgs({ prompt, tools: this.d.tools || pr.defaultTools, resume: this.sessionId(), model: pr.model, system });
    const ompBin = realpathSync(this.d.ompBin ?? join(home, ".local", "bin", "omp"));
    const argv = sandboxArgv({ home, ompBin, agentDir: this.agentDir, workDir: this.d.workDir, args });
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1", PI_CODING_AGENT_DIR: this.agentDir, ...extraEnv };
    const child = (this.d.spawn ?? defaultSpawn)(argv, env);
    this.#child = child;

    const harness = !!this.d.deliver;
    const t0 = Date.now();
    const tools: string[] = [];
    let answer = "", note = "", last = 0, shown = "", sid: string | null = null, refused = false, timedOut = false;
    const view = (done: boolean) => harness
      ? renderStatus({ label: this.#label, elapsedMs: Date.now() - t0, tools, done, note, queued: this.#pending.length })
      : render(tools, answer, done, note, this.#label);
    const out = await this.d.send(view(false), { progress: true });
    const every = this.d.editEveryMs ?? 1500;
    const flush = async (done: boolean) => {
      const first = splitMessage(view(done))[0]!;
      if (first !== shown) { shown = first; await out.edit(first, done).catch((e) => this.d.log?.(`local-omp edit: ${(e as Error).message}`)); }
      last = Date.now();
    };
    // Liveness while the model thinks silently (no stream events): the elapsed time keeps moving.
    const beat = harness ? setInterval(() => { if (Date.now() - last >= (this.d.heartbeatMs ?? 5000)) void flush(false); }, 1000) : null;
    const timer = setTimeout(() => { timedOut = true; note = "⚠️ stopped: turn took longer than the limit"; child.kill("SIGTERM"); }, this.d.timeoutMs ?? 15 * 60_000);
    const errTail: string[] = [];
    child.stderr?.on("data", (b: Buffer) => { errTail.push(String(b)); if (errTail.length > 20) errTail.shift(); });
    const dec = new TextDecoder();
    let buf = "";
    let providerError = "";
    try {
      for await (const chunk of child.stdout as AsyncIterable<Uint8Array | string>) {
        buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (ev.type === "session" && typeof ev.id === "string") sid = ev.id;
          const msg = ev.message as Record<string, unknown> | undefined;
          if (msg?.role === "assistant" && (ev.type === "message_start" || ev.type === "message_end") && !pr.allowed(msg)) {
            refused = true; note = `⛔ refused: another model appeared (${String(msg.provider)}/${String(msg.model)}); run stopped.`;
            child.kill("SIGKILL");
          }
          if (ev.type === "tool_execution_start") tools.push(toolLine(String(ev.toolName), ev.args));
          if (ev.type === "message_end" && msg?.role === "assistant" && Array.isArray(msg.content)) {
            const text = msg.content.map((c: unknown) => (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : "")).join("").trim();
            if (text) answer = text;
          }
          // Provider errors (bad key, no credit, unsupported tools) end the turn with an errorMessage; show it.
          if (ev.type === "message_end" && msg?.role === "assistant" && typeof msg.errorMessage === "string" && msg.errorMessage) {
            providerError = msg.errorMessage.slice(0, 300);
          }
        }
        if (Date.now() - last >= every) await flush(false);
      }
    } finally { clearTimeout(timer); if (beat) clearInterval(beat); }
    const code = await child.exited;
    if (code !== 0 && !refused && !note) note = `⚠️ OMP exited with code ${code}${providerError ? `: ${providerError}` : errTail.length ? `: ${errTail.join("").trim().slice(-300)}` : ""}`;
    if (sid && !refused) this.#setSession(sid);
    if (harness) {
      if (this.#halt && !note) note = "🛑 Stopped.";
      await flush(true);
      if (answer.trim() && !refused) await this.d.deliver!(answer, t0).catch((e) => this.d.log?.(`local-omp deliver: ${(e as Error).message}`));
      else if (!note) await this.d.send(`${this.#label}: (no answer)`);
      return timedOut && !refused;
    }
    const parts = splitMessage(render(tools, answer, true, note, this.#label));
    shown = parts[0]!;
    await out.edit(parts[0]!).catch(() => {});
    for (const p of parts.slice(1)) await this.d.send(p);
    return timedOut && !refused;
  }
}

function defaultSpawn(argv: string[], env: Record<string, string>): Child {
  const p = nodeSpawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number>((res) => { p.on("close", (c) => res(c ?? 1)); p.on("error", () => res(127)); });
  return { stdout: p.stdout!, stderr: p.stderr, kill: (s) => void p.kill((s ?? "SIGTERM") as NodeJS.Signals), exited };
}

export const DEFAULT_WORKDIR = join(homedir(), "discord-scratch", "local-omp");
/** Per-channel setup (owner 2026-10-19): channel 0 keeps the original state; channel i>0 gets key/work dir "local-omp-<i+1>" and label suffix "-b", "-c", …. */
export function instanceFor(i: number): { key: string; workDir: string; label: string } {
  if (i === 0) return { key: "local-omp", workDir: DEFAULT_WORKDIR, label: LABEL };
  return { key: `local-omp-${i + 1}`, workDir: `${DEFAULT_WORKDIR}-${i + 1}`, label: `${LABEL}-${String.fromCharCode(97 + i)}` };
}
