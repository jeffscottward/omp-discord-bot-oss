/**
 * 🧠-local-model channel (owner 2026-10-19, card local-model-channel): owner messages in this ONE channel go ONLY to
 * the local llama.cpp server (model `local-coder`). Never to Claude/OMP, never to a cloud API.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitMessage } from "./split.ts";

export const LOCAL_MODEL_URL = process.env.OMP_LOCAL_MODEL_URL ?? "http://127.0.0.1:8091";
export const LOCAL_MODEL_NAME = "local-coder";
export const LABEL = "🧠 local-coder";
export const DOWN_TEXT = "⚠️ local model is off — `local-coder start`";
const SYSTEM = "You are local-coder, a local model on the owner's main. This Discord channel is chat only: you have NO tools, cannot browse, run commands, load skills or edit files. Never emit tool calls; answer in plain text. Answer concisely. Use Discord markdown.";
/** Raw tool-call markup the model emits when it imagines tools (LFM <|tool_call_start|>…, <tool_call>…). */
const TOOL_MARKUP = /<\|tool_call_start\|>[\s\S]*?(?:<\|tool_call_end\|>|$)|<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g;
export const NO_TOOLS_NOTE = "_(tried to call a tool; this channel is chat only, so nothing ran)_";
export function cleanToolMarkup(text: string): string {
  if (!TOOL_MARKUP.test(text)) return text;
  TOOL_MARKUP.lastIndex = 0;
  return `${text.replace(TOOL_MARKUP, "").trim()}\n\n${NO_TOOLS_NOTE}`.trim();
}

export type Turn = { role: "user" | "assistant"; content: string };
export type Route = "local" | "ignore" | "other";

/** Pure routing: only this channel goes local; inside it, only the owner (not bots) is answered. */
export function routeMessage(m: { channelId: string; authorId: string; bot: boolean }, channelId: string, ownerId: string): Route {
  if (m.channelId !== channelId) return "other";
  return m.authorId === ownerId && !m.bot ? "local" : "ignore";
}

export const isReset = (t: string) => /^\s*\/?reset\s*$/i.test(t);
/** Rough token estimate (~3.5 chars per token, rounded up; safe side for code/English). */
export const estTokens = (s: string) => Math.ceil(s.length / 3.5) + 4;

/** Drop the oldest turns until the history fits `budget` tokens. The newest turn always stays. */
export function trimHistory(h: Turn[], budget: number): Turn[] {
  const out = [...h];
  let total = out.reduce((n, t) => n + estTokens(t.content), estTokens(SYSTEM));
  while (out.length > 1 && total > budget) total -= estTokens(out.shift()!.content);
  while (out.length > 1 && out[0]!.role !== "user") out.shift(); // start with a user turn
  return out;
}

/** Display text: reply, with reasoning shown as a short quoted preview while nothing else exists yet. */
export function render(content: string, reasoning: string, done: boolean): string {
  if (content.trim()) return `${LABEL}\n${cleanToolMarkup(content)}${done ? "" : " ▌"}`;
  if (!done && reasoning.trim()) return `${LABEL} 💭 thinking…\n> ${reasoning.trim().slice(-300).replace(/\n+/g, " ")}`;
  return done ? `${LABEL}\n(empty reply)` : `${LABEL} 💭 thinking…`;
}

/** One SSE chunk from llama.cpp → text deltas (unknown shapes give empty strings). */
export function deltaOf(j: unknown): { content: string; reasoning: string } {
  const ch = j && typeof j === "object" && "choices" in j && Array.isArray(j.choices) ? j.choices[0] : null;
  const d = ch && typeof ch === "object" && "delta" in ch ? ch.delta : null;
  const pick = (k: string) => (d && typeof d === "object" && k in d && typeof (d as Record<string, unknown>)[k] === "string" ? String((d as Record<string, unknown>)[k]) : "");
  return { content: pick("content"), reasoning: pick("reasoning_content") };
}

export type Out = { edit(text: string): Promise<void> };
export type Deps = {
  stateDir: string;
  fetch?: typeof fetch;
  send(text: string): Promise<Out>;
  log?(s: string): void;
  editEveryMs?: number;
  /** Abort when the server sends nothing for this long (default 2 min), so a stalled stream cannot block the channel. */
  idleMs?: number;
};

export class LocalModelChat {
  #busy = false;
  #ctx: number | null = null;
  constructor(private d: Deps) {}
  get #file() { return join(this.d.stateDir, "local-model-history.json"); }
  load(): Turn[] {
    try { return existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as Turn[]) : []; } catch { return []; }
  }
  save(h: Turn[]): void {
    mkdirSync(this.d.stateDir, { recursive: true });
    writeFileSync(this.#file, JSON.stringify(h));
  }
  async #nCtx(f: typeof fetch): Promise<number> {
    if (this.#ctx) return this.#ctx;
    const r = await f(`${LOCAL_MODEL_URL}/props`, { signal: AbortSignal.timeout(5000) });
    const j: unknown = await r.json();
    const g = j && typeof j === "object" && "default_generation_settings" in j ? j.default_generation_settings : null;
    const n = g && typeof g === "object" && "n_ctx" in g && typeof g.n_ctx === "number" ? g.n_ctx : 4096;
    return (this.#ctx = n);
  }

  /** Handle one owner message. One request at a time; no retry loop when the server is down. */
  async handle(text: string): Promise<void> {
    if (isReset(text)) { this.save([]); await this.d.send(`${LABEL}: history cleared.`); return; }
    if (this.#busy) { await this.d.send(`${LABEL}: still answering the previous message; send again after it finishes.`); return; }
    this.#busy = true;
    try { await this.#ask(text); } finally { this.#busy = false; }
  }

  async #ask(text: string): Promise<void> {
    const f = this.d.fetch ?? fetch;
    let nCtx: number;
    try { nCtx = await this.#nCtx(f); } catch { await this.d.send(DOWN_TEXT); return; }
    const maxReply = Math.min(4096, Math.floor(nCtx * 0.25));
    const hist = trimHistory([...this.load(), { role: "user", content: text }], Math.floor(nCtx * 0.75) - maxReply);
    let res: Response;
    const abort = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(new Error("no data from the local model for too long")), this.d.idleMs ?? 120_000); };
    arm();
    try {
      res = await f(`${LOCAL_MODEL_URL}/v1/chat/completions`, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: LOCAL_MODEL_NAME, stream: true, max_tokens: maxReply, messages: [{ role: "system", content: SYSTEM }, ...hist] }),
      });
    } catch { clearTimeout(idle); this.#ctx = null; await this.d.send(DOWN_TEXT); return; }
    if (!res.ok || !res.body) { await this.d.send(`⚠️ local model error: HTTP ${res.status}`); return; }

    const out = await this.d.send(render("", "", false));
    let content = "", reasoning = "", last = 0, shown = "";
    const every = this.d.editEveryMs ?? 1500; // Discord: ~5 edits / 5 s per channel; stay well under
    const flush = async (done: boolean) => {
      const t = render(content, reasoning, done);
      const first = splitMessage(t)[0]!;
      if (first !== shown) { shown = first; await out.edit(first).catch((e) => this.d.log?.(`local-model edit: ${(e as Error).message}`)); }
      last = Date.now();
    };
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm();
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const d = deltaOf(JSON.parse(data));
            content += d.content; reasoning += d.reasoning;
          } catch { /* partial line */ }
        }
        if (Date.now() - last >= every) await flush(false);
      }
    } catch (e) {
      content += `\n\n⚠️ stream ended early: ${abort.signal.aborted ? String(abort.signal.reason?.message ?? "timeout") : (e as Error).message}`;
    } finally {
      clearTimeout(idle);
    }
    const parts = splitMessage(render(content, reasoning, true));
    await out.edit(parts[0]!).catch(() => {});
    for (const p of parts.slice(1)) await this.d.send(p);
    if (content.trim()) this.save([...hist, { role: "assistant", content: cleanToolMarkup(content) }]);
  }
}
