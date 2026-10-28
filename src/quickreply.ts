// Orca #2 quick replies and #4 scrollback (owner picks 2026-10-19).
//
// #2: when a mirrored OMP pane waits for the owner, the channel gets a silent card with buttons.
//   - "ask": the pane runs the `ask` tool (one question, one choice). One button per option plus "Reply…"
//     (the selector's "Other (type your own)" with the owner's text).
//   - "question": the pane's turn ended with a question. Buttons Continue, Yes, No, Reply….
//   A press injects into that exact pane, only when every guard holds:
//     1. the owner pressed it (checked by the caller), on the card of the pane's current wait;
//     2. `herdr pane list`: same pane, omp agent, same session file, NOT focused (the owner may be using it);
//     3. still waiting, from OMP's OWN record (FIRSTMATE 2026-10-19: Herdr's agent_status is not used; it
//        reports OMP panes idle while they work or while the owner types): the session JSONL's last message
//        entry is still the one that opened the wait ("ask": the assistant entry with the open ask call;
//        "question": the final reply). Any newer entry (a new turn, a tool result) refuses;
//     4. the screen agrees: "ask" = that question's selector with the same rows; "question" = an empty input
//        box (the owner is not typing).
//   Guards 2-4 are checked on the press and again right before the key that sends. Refused otherwise.
//   Every inject and refusal is logged to pane-injects.jsonl (time, pane, kind, choice, length; never free text).
//   Tool approval prompts are never answered from Discord: OMP records no pending approval in the session, so a
//   pane waiting on one reads as "working" and every press is refused.
// #4: "📜 Last 40 lines" on the progress message: `herdr agent read --source recent --lines 40`, redacted with
//   the outbound filter, icon glyphs removed, code-fenced, split under 2000 characters.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.ts";
import { editorEmpty, type Check } from "./firstmate.ts";

export const QR_PREFIX = "qr:";
export const QR_MODAL_PREFIX = "qrmodal:";
export const SB_PREFIX = "sb:";
export const SCROLLBACK_LINES = 40;
const INJECT_LOG = join(STATE_DIR, "pane-injects.jsonl");
/** Selector row of the ask tool's free-text option (OMP 18.12). */
export const OTHER_LABEL = "Other (type your own)";
/** OMP marks the selected selector row with this icon (nf-fa-chevron_right). */
const CURSOR = "\uf054";
export const MAX_ASK_OPTIONS = 19;
export const MAX_TEXT = 1000;

/** One single-choice question of an `ask` tool call (the only kind answered from Discord). */
export type AskInfo = { question: string; options: string[]; recommended: number; supported: boolean };

/** The pane's current wait (saved in agents.json with its mirror entry). */
export type PaneWait = {
  nonce: string;
  kind: "ask" | "question";
  ts: number;
  /** The card message with the buttons. */
  msgId?: string;
  /** "ask": the tool call id; its result closes the wait. */
  callId?: string;
  /** OMP's record that opened the wait: id of the session entry (ask call / final reply). */
  rec?: string;
  ask?: AskInfo;
  /** "question": the question line shown on the card. */
  question?: string;
  /** An inject is in progress: the tail must not close the card under it. */
  sending?: boolean;
};

/** Button choice ids: c/y/n (question), o<k> (ask option k), r (Reply…, both kinds). */
export type Choice = { id: string; label: string; text?: string; option?: number };

/** Parse the `ask` tool arguments (pure). Multi-question or multi-select asks are shown but not answerable. */
export function askInfo(args: unknown): AskInfo | null {
  const a = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const qs = Array.isArray(a.questions) ? a.questions : [];
  const q0 = qs[0] as Record<string, unknown> | undefined;
  if (!q0 || typeof q0.question !== "string") return null;
  const options = (Array.isArray(q0.options) ? q0.options : [])
    .map((o: unknown) => (typeof o === "string" ? o : o && typeof o === "object" && "label" in o && typeof o.label === "string" ? o.label : ""))
    .filter(Boolean);
  const rec = typeof q0.recommended === "number" && Number.isInteger(q0.recommended) ? q0.recommended : 0;
  const recommended = Math.min(Math.max(rec, 0), Math.max(options.length - 1, 0));
  const supported = qs.length === 1 && q0.multi !== true && options.length > 0 && options.length <= MAX_ASK_OPTIONS;
  return { question: q0.question, options, recommended, supported };
}

/**
 * True when a final reply ends with a question to the owner (pure): one of the last three prose lines
 * (code blocks and links removed) ends with "?". Replies with an ```ask block already get menus.
 */
export function isQuestionReply(text: string): boolean {
  if (/```ask\b/.test(text)) return false;
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/https?:\/\/\S+/g, "");
  const lines = prose.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3);
  return lines.some((l) => /\?[\s*_)"'»`]*$/.test(l));
}

/** The question line to show on the card (pure). */
export function questionLine(text: string): string {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const lines = prose.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3);
  const q = [...lines].reverse().find((l) => /\?[\s*_)"'»`]*$/.test(l)) ?? lines.at(-1) ?? "";
  return q.replace(/[`*_~|<>@]/g, "").slice(0, 300);
}

/** Buttons for a wait (pure). Ask options keep their order; "Reply…" is always last. */
export function choicesFor(w: PaneWait): Choice[] {
  if (w.kind === "question")
    return [
      { id: "c", label: "Continue", text: "Continue" },
      { id: "y", label: "Yes", text: "Yes" },
      { id: "n", label: "No", text: "No" },
      { id: "r", label: "Reply…" },
    ];
  if (!w.ask?.supported) return [];
  return [...w.ask.options.map((o, k) => ({ id: `o${k}`, label: o.slice(0, 80), option: k })), { id: "r", label: "Reply…" }];
}

/** Card text for a wait (pure; the caller applies the outbound filter). */
export function waitCard(tab: string, w: PaneWait): string {
  if (w.kind === "question") return `✍️ **${tab}** · waiting for your answer\n> ${w.question ?? ""}\n-# Buttons type into the pane only while it waits and you are not using it.`;
  const q = (w.ask?.question ?? "").replace(/\s+/g, " ").slice(0, 600);
  if (!w.ask?.supported) return `❓ **${tab}** · asks: ${q}\n-# This question has several parts or choices; answer it at the terminal.`;
  return `❓ **${tab}** · asks: ${q}\n-# Buttons answer the question in the pane only while it waits and you are not using it.`;
}

/** Card text after a wait ended (pure). */
export function closedCard(content: string, note: string): string {
  return `${content.replace(/\n-# .*$/s, "")}\n${note}`.slice(0, 2000);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `herdr pane list` → facts of one pane (pure). Only an omp agent on that pane with that session file qualifies. */
export function paneFacts(raw: string, pane: string, sessionFile: string | null | undefined): { ok: true; focused: boolean } | { ok: false; reason: string } {
  let panes: unknown;
  try {
    panes = JSON.parse(raw).result.panes;
  } catch {
    return { ok: false, reason: "pane list unreadable" };
  }
  const p = Array.isArray(panes) ? panes.find((x) => x && typeof x === "object" && "pane_id" in x && x.pane_id === pane) : undefined;
  if (!p) return { ok: false, reason: "pane not found" };
  if (p.agent !== "omp") return { ok: false, reason: "pane is not an omp agent" };
  const s: unknown = p.agent_session;
  const path = s && typeof s === "object" && "kind" in s && s.kind === "path" && "value" in s ? s.value : undefined;
  if (sessionFile && path !== sessionFile) return { ok: false, reason: "the pane runs another session now" };
  return { ok: true, focused: p.focused === true };
}

/** OMP's own pending-input record: the session's last message entry. */
export type SessionRecord = { kind: "ask"; entryId: string; callId: string } | { kind: "question"; entryId: string } | { kind: "busy"; reason: string };

/**
 * Read OMP's record from a session JSONL tail (pure). "ask" = the last message is an assistant tool call to
 * `ask` (no result yet); "question" = the last message is a finished reply (stopReason "stop"); anything
 * else (user message, tool result, other tool call, partial line) = busy.
 */
export function sessionRecord(tail: string): SessionRecord {
  if (!tail.endsWith("\n")) return { kind: "busy", reason: "the session is being written" };
  const lines = tail.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: { type?: string; id?: string; message?: { role?: string; stopReason?: string; content?: unknown } };
    try {
      e = JSON.parse(lines[i]!);
    } catch {
      return { kind: "busy", reason: "the session is unreadable" };
    }
    if (e.type !== "message" || !e.message) continue;
    const id = typeof e.id === "string" ? e.id : "";
    const { role, stopReason, content } = e.message;
    if (role === "assistant" && stopReason === "stop") return { kind: "question", entryId: id };
    if (role === "assistant" && stopReason === "toolUse" && Array.isArray(content)) {
      const asks = content.filter((b) => b && typeof b === "object" && "type" in b && b.type === "toolCall" && "name" in b && b.name === "ask" && "id" in b && typeof b.id === "string");
      if (asks.length === 1) return { kind: "ask", entryId: id, callId: asks[0].id };
    }
    return { kind: "busy", reason: role === "user" ? "a new turn started" : "the agent is working" };
  }
  return { kind: "busy", reason: "no finished turn in the session" };
}

/** The record still is the one that opened the wait (pure). */
export function recordMatches(r: SessionRecord, w: PaneWait): Check {
  if (r.kind === "busy") return { ok: false, reason: r.reason };
  if (r.kind !== w.kind || !w.rec || r.entryId !== w.rec || (r.kind === "ask" && r.callId !== w.callId)) return { ok: false, reason: "the pane's question changed" };
  return { ok: true };
}

const BOX_ROW = /^│(.*)│\s*$/;

/**
 * The ask selector on the pane's visible screen (pure): question text, option rows (without icons) and the
 * selected row. Null when no ask selector is the last box on screen.
 */
export function parseAskScreen(screen: string): { question: string; rows: string[]; cursor: number } | null {
  const lines = screen.replace(/\r/g, "").split("\n");
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (/^╭─ Ask\b/.test(lines[i]!)) {
      top = i;
      break;
    }
  if (top === -1) return null;
  const q: string[] = [];
  let i = top + 1;
  for (; i < lines.length && !lines[i]!.startsWith("├"); i++) {
    const m = lines[i]!.match(BOX_ROW);
    if (!m) return null;
    if (m[1]!.trim()) q.push(m[1]!.trim());
  }
  if (i >= lines.length) return null;
  const rows: string[] = [];
  let cursor = -1;
  for (i++; i < lines.length && !lines[i]!.startsWith("├"); i++) {
    const m = lines[i]!.match(BOX_ROW);
    if (!m) return null;
    const body = m[1]!;
    if (!body.trim()) continue;
    const selected = body.trimStart().startsWith(CURSOR);
    // Row = [cursor] [option icon] label. Icons are private-use glyphs.
    const label = body.replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]/gu, "").trim();
    if (selected) cursor = rows.length;
    rows.push(label);
  }
  if (i >= lines.length || cursor === -1) return null;
  return { question: q.join(" "), rows, cursor };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const head = (s: string, n: number) => norm(s).slice(0, n);

/** The screen shows THIS ask (same question start, same rows in order, "Other" last). Pure. */
export function askMatches(screen: { question: string; rows: string[] }, ask: AskInfo): Check {
  const sq = norm(screen.question);
  const aq = norm(ask.question);
  const n = Math.min(40, sq.length, aq.length);
  if (!n || sq.slice(0, n) !== aq.slice(0, n)) return { ok: false, reason: "the pane shows another question" };
  if (screen.rows.length !== ask.options.length + 1) return { ok: false, reason: "the question's choices changed" };
  for (const [k, o] of ask.options.entries()) {
    const row = norm(screen.rows[k]!.replace(/\s*\(Recommended\)\s*$/, ""));
    // Long labels are cut at the box edge: compare the visible start.
    const want = head(o, Math.min(40, row.length));
    if (!row.startsWith(want)) return { ok: false, reason: "the question's choices changed" };
  }
  if (!screen.rows.at(-1)!.startsWith("Other")) return { ok: false, reason: "the question's choices changed" };
  return { ok: true };
}

/** The ask tool's free-text editor ("Custom answer" box): its input line, or null when it is not shown. Pure. */
export function customAnswerLine(screen: string): string | null {
  const lines = screen.replace(/\r/g, "").split("\n");
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (/^╭─ Custom answer\b/.test(lines[i]!)) {
      top = i;
      break;
    }
  if (top === -1) return null;
  for (let i = top + 1; i < lines.length && !lines[i]!.startsWith("╰"); i++) {
    const m = lines[i]!.match(/^│ > ?(.*)│\s*$/);
    if (m) return m[1]!.trimEnd();
  }
  return null;
}

/**
 * Extra redaction for raw terminal text (scrollback only; replies keep the shared filter). Terminal lines can
 * show env dumps, curl headers and key files, which the shared filter does not cover.
 */
export function redactTerminal(text: string): string {
  return text
    // Private key blocks: BEGIN + base64 lines (+ END), also when the 40 lines cut off either end.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\n[A-Za-z0-9+/=]+)*(?:\n-----END [A-Z ]*PRIVATE KEY-----)?/g, "[REDACTED-PRIVATE-KEY]")
    .replace(/^(?:[A-Za-z0-9+/=]{16,}\n)+-----END [A-Z ]*PRIVATE KEY-----/gm, "[REDACTED-PRIVATE-KEY]")
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[REDACTED-SECRET]") // JWT
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED-SECRET]") // AWS access key id
    .replace(/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1$2[REDACTED-SECRET]")
    .replace(/\b([A-Za-z_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|auth|credential|cookie)[A-Za-z_.-]*)(\s*[=:]\s*)(["']?)[^\s"']{6,}\3/gi, "$1$2$3[REDACTED-SECRET]$3");
}

/** Strip ANSI and icon glyphs, trim line ends (pure). */
export function plainLines(raw: string): string[] {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]/gu, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd());
}

/**
 * Scrollback messages (pure apart from `filter`): header + code-fenced lines, each message under `max`
 * characters. `filter` is the outbound redaction. Fences inside the text are defused.
 */
export function scrollbackMessages(header: string, raw: string, filter: (s: string) => string, max = 1990): string[] {
  const lines = plainLines(filter(raw)).map((l) => l.replace(/```/g, "ˋˋˋ"));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!lines.length) return [`${header}\n-# The pane shows no text.`];
  const out: string[] = [];
  let cur: string[] = [];
  let pre = `${header}\n`;
  const size = (ls: string[]) => pre.length + 8 + ls.reduce((n, l) => n + l.length + 1, 0);
  for (let l of lines) {
    if (pre.length + 8 + l.length + 1 > max) l = `${l.slice(0, max - pre.length - 10)}…`;
    if (cur.length && size([...cur, l]) > max) {
      out.push(`${pre}\`\`\`\n${cur.join("\n")}\n\`\`\``);
      cur = [];
      pre = "";
    }
    cur.push(l);
  }
  if (cur.length) out.push(`${pre}\`\`\`\n${cur.join("\n")}\n\`\`\``);
  return out;
}

export type HerdrCall = (args: string[]) => Promise<{ code: number; out: string }>;

export interface InjectTarget {
  machine: string;
  paneId: string;
  sessionFile?: string | null;
}

export interface InjectorDeps {
  /** Run herdr on the pane's host. */
  herdr: (t: InjectTarget, args: string[]) => Promise<{ code: number; out: string }>;
  /** Last bytes of the pane's session file (null when unreadable). */
  readTail: (t: InjectTarget) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  log?: (...a: unknown[]) => void;
  logFile?: string;
  now?: () => number;
}

export type InjectResult = { ok: true; sent: string; confirmed: boolean } | { ok: false; reason: string };

/** Guarded pane input for quick replies. One inject per pane at a time. */
export class PaneInjector {
  private readonly busy = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (...a: unknown[]) => void;
  private readonly logFile: string;
  private readonly now: () => number;

  constructor(private readonly deps: InjectorDeps) {
    this.sleep =
      deps.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
    this.log = deps.log ?? (() => {});
    this.logFile = deps.logFile ?? INJECT_LOG;
    this.now = deps.now ?? Date.now;
  }

  private record(t: InjectTarget, w: PaneWait, choice: string, status: string, extra: Record<string, unknown> = {}): void {
    const row = { at: new Date(this.now()).toISOString(), machine: t.machine, pane: t.paneId, kind: w.kind, choice, status, ...extra };
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(this.logFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch {}
    this.log(`quick-reply ${t.machine}:${t.paneId} ${w.kind} ${choice} ${status}${extra.reason ? ` (${String(extra.reason)})` : ""}`);
  }

  /** Pane identity and focus from `herdr pane list` (never agent_status). */
  private async facts(t: InjectTarget): Promise<Check> {
    const r = await this.deps.herdr(t, ["pane", "list"]);
    if (r.code !== 0) return { ok: false, reason: "pane list unreadable" };
    const f = paneFacts(r.out, t.paneId, t.sessionFile);
    if (!f.ok) return f;
    if (f.focused) return { ok: false, reason: "the pane is focused (you may be using it)" };
    return { ok: true };
  }

  /** OMP's own record, compared with the wait. */
  private async recordOk(t: InjectTarget, w: PaneWait): Promise<Check> {
    const tail = await this.deps.readTail(t);
    if (tail === null) return { ok: false, reason: "session unreadable" };
    return recordMatches(sessionRecord(tail), w);
  }

  private async screen(t: InjectTarget, lines = 40): Promise<string | null> {
    const r = await this.deps.herdr(t, ["agent", "read", t.paneId, "--source", "visible", "--lines", String(lines)]);
    return r.code === 0 ? r.out : null;
  }

  /** "question" guard: OMP record unchanged, not focused, input box empty. */
  private async questionReady(t: InjectTarget, w: PaneWait): Promise<Check> {
    const rec = await this.recordOk(t, w);
    if (!rec.ok) return rec;
    const f = await this.facts(t);
    if (!f.ok) return f;
    const s = await this.screen(t, 6);
    if (s === null) return { ok: false, reason: "input box unreadable" };
    return editorEmpty(s);
  }

  /** "ask" guard: OMP record unchanged, not focused, the selector shows this question. Returns the cursor row. */
  private async askReady(t: InjectTarget, w: PaneWait, ask: AskInfo): Promise<{ ok: true; cursor: number } | { ok: false; reason: string }> {
    const rec = await this.recordOk(t, w);
    if (!rec.ok) return rec;
    const f = await this.facts(t);
    if (!f.ok) return f;
    const s = await this.screen(t);
    const sel = s === null ? null : parseAskScreen(s);
    if (!sel) return { ok: false, reason: "the question selector is not on screen (answered, or you are typing an answer)" };
    const m = askMatches(sel, ask);
    if (!m.ok) return m;
    return { ok: true, cursor: sel.cursor };
  }

  async inject(t: InjectTarget, w: PaneWait, choice: Choice, typed?: string): Promise<InjectResult> {
    const key = `${t.machine}:${t.paneId}`;
    const free = choice.id === "r";
    const text = free ? (typed ?? "").trim() : (choice.text ?? choice.label);
    const meta = { chars: text.length };
    if (free && (!text || text.length > MAX_TEXT)) {
      this.record(t, w, choice.id, "refused", { reason: "empty or too long", ...meta });
      return { ok: false, reason: "empty or too long" };
    }
    if (this.busy.has(key)) {
      this.record(t, w, choice.id, "refused", { reason: "another answer is being sent", ...meta });
      return { ok: false, reason: "another answer is being sent" };
    }
    this.busy.add(key);
    try {
      const r = w.kind === "question" ? await this.#question(t, w, text) : await this.#ask(t, w, choice, text);
      this.record(t, w, choice.id, r.ok ? (r.confirmed ? "delivered" : "sent-unconfirmed") : "refused", r.ok ? meta : { reason: r.reason, ...meta });
      return r;
    } catch (e) {
      this.record(t, w, choice.id, "failed", { reason: (e as Error).message.slice(0, 200), ...meta });
      return { ok: false, reason: "sending failed" };
    } finally {
      this.busy.delete(key);
    }
  }

  async #question(t: InjectTarget, w: PaneWait, text: string): Promise<InjectResult> {
    // Checked twice: on the press and immediately before typing (the owner may start typing in between).
    let c = await this.questionReady(t, w);
    if (!c.ok) return c;
    c = await this.questionReady(t, w);
    if (!c.ok) return c;
    const r = await this.deps.herdr(t, ["agent", "prompt", t.paneId, text]);
    if (r.code !== 0) return { ok: false, reason: /agent_blocked/.test(r.out) ? "Herdr refused: the agent is waiting on something else" : "herdr agent prompt failed" };
    return { ok: true, sent: text, confirmed: await this.#answered(t, w) };
  }

  async #ask(t: InjectTarget, w: PaneWait, choice: Choice, text: string): Promise<InjectResult> {
    const ask = w.ask;
    if (!ask?.supported) return { ok: false, reason: "answer this question at the terminal" };
    const target = choice.id === "r" ? ask.options.length : choice.option;
    if (target === undefined || target < 0 || target > ask.options.length) return { ok: false, reason: "unknown choice" };
    let g = await this.askReady(t, w, ask);
    if (!g.ok) return g;
    const delta = target - g.cursor;
    if (delta) {
      const keys = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "down" : "up"));
      const k = await this.deps.herdr(t, ["agent", "send-keys", t.paneId, ...keys]);
      if (k.code !== 0) return { ok: false, reason: "could not move the selection" };
      await this.sleep(300);
    }
    // Re-check right before Enter: same OMP record, still not focused, cursor on the wanted row.
    g = await this.askReady(t, w, ask);
    if (!g.ok) return g;
    if (g.cursor !== target) return { ok: false, reason: "the selection moved (someone is using the pane)" };
    const e = await this.deps.herdr(t, ["agent", "send-keys", t.paneId, "enter"]);
    if (e.code !== 0) return { ok: false, reason: "could not select" };
    if (choice.id !== "r") return { ok: true, sent: ask.options[target]!, confirmed: await this.#answered(t, w) };
    // "Other": the free-text editor must open empty; Enter submits it, so newlines become spaces.
    await this.sleep(400);
    let s = await this.screen(t);
    if (s === null || customAnswerLine(s) !== "") return { ok: false, reason: "the answer box did not open empty; answer at the terminal" };
    const one = text.replace(/\s*\n\s*/g, " ");
    const typedR = await this.deps.herdr(t, ["pane", "send-text", t.paneId, one]);
    if (typedR.code !== 0) return { ok: false, reason: "typing failed; answer at the terminal" };
    await this.sleep(300);
    s = await this.screen(t);
    const line = s === null ? null : customAnswerLine(s);
    if (line === null || !norm(line).startsWith(head(one, 20))) return { ok: false, reason: "the typed answer did not show; it was not submitted" };
    // Re-check right before the submitting Enter.
    const rec = await this.recordOk(t, w);
    if (!rec.ok) return rec;
    const f = await this.facts(t);
    if (!f.ok) return f;
    const sub = await this.deps.herdr(t, ["agent", "send-keys", t.paneId, "enter"]);
    if (sub.code !== 0) return { ok: false, reason: "could not submit" };
    return { ok: true, sent: one, confirmed: await this.#answered(t, w) };
  }

  /** After sending: OMP's record moved on (a tool result, a new turn, or an entry being written); up to 3 s. */
  async #answered(t: InjectTarget, w: PaneWait): Promise<boolean> {
    for (let i = 0; i < 6; i++) {
      await this.sleep(500);
      const tail = await this.deps.readTail(t);
      if (tail !== null && !recordMatches(sessionRecord(tail), w).ok) return true;
    }
    return false;
  }
}
