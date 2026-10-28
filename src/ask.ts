// Interactive questions for Discord runs (owner request 2026-10-13).
// `omp -p` does not offer OMP's `ask` tool (verified 2026-10-13: the tool list has no `ask` in
// print mode), so a run asks by ending its answer with a fenced ```ask block of JSON:
//   ```ask
//   {"questions":[{"id":"scope","question":"Which names?","options":["All","Chips only"],"multi":false}]}
//   ```
// The bridge strips the block, posts one message per question with a select menu, collects the
// owner's picks and, once every question is answered, sends them back as the owner's next turn in
// the same session ("Answers: …"). Only the owner can answer. Pending sets expire after 24 h and are
// persisted to <dir>/asks.json (0600, atomic tmp+rename) so a bot restart does not orphan open menus.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AskQuestion {
  id: string;
  question: string;
  options: string[];
  /** Owner 2026-10-23: per-option description ({label, description} options), "" when none. Same length as options. */
  descriptions?: string[];
  /** Index of the recommended option (owner 2026-10-14: show "(Recommended)" like OMP). */
  recommended?: number;
  multi: boolean;
}
export interface AskSet {
  setId: string;
  channelId: string;
  questions: AskQuestion[];
  answers: Record<string, string[]>;
  createdAt: number;
  /** Message ids of the posted menus, by question index. */
  messageIds?: Record<string, string>;
  /** Multi-select picks ticked but not yet confirmed with Done, by question index. */
  pending?: Record<string, number[]>;
  /** Owner 2026-10-23: the message the menus reply to (the owner's request), so a menu shows what it belongs to. */
  sourceId?: string;
  /** Owner 2026-10-25 (card answered-clears-needs): the owner responded (any way), so the boards hide this set at once. */
  answered?: boolean;
  answeredAt?: number;
  answerVia?: AnswerVia;
  /** Per question index: the owner responded to that question's menu (reply, ✅, text), even without a pick. */
  responded?: Record<string, { at: number; via: AnswerVia }>;
  /** Every message the menus use, including the leading parts of a split question (🗑️ Delete removes them all). */
  partIds?: string[];
}

const BLOCK = /^ {0,3}```ask[ \t]*\n([\s\S]*?)\n {0,3}```[ \t]*$/m;
export const ASK_PREFIX = "ask:";
/** Owner 2026-10-23 (Discord UX item 3): sets stay open until answered, closed by the card sweep, or 7 days old. */
export const ASK_TTL_MS = 7 * 24 * 60 * 60_000;
/** The TTL before 2026-10-23; a lost menu older than this was most likely expired, not lost in a restart. */
export const OLD_ASK_TTL_MS = 24 * 60 * 60_000;
/** Closed/expired sets are remembered this long (late-tap label, 🔁 Ask again). */
export const CLOSED_KEEP_MS = 30 * 24 * 60 * 60_000;
export const OPTION_FORMAT_HINT = "Options are plain strings or {\"label\": \"…\", \"description\": \"…\"} objects.";
const MAX_Q = 5; // one action row each; Discord allows 5 rows per message, we post one message per question
const MAX_OPT = 25; // Discord select-menu limit
/** Owner 2026-10-22: options and questions are shown in full (the old 100/150-char cut came from select menus). Only a sanity cap. */
export const MAX_OPTION_CHARS = 600;
export const MAX_QUESTION_CHARS = 1200;

/** Pull an ```ask block out of an answer. Invalid JSON stays in the text (visible to the owner). */
export function extractAsk(text: string): { text: string; questions: AskQuestion[] | null; error?: string } {
  const m = text.match(BLOCK);
  if (!m) return { text, questions: null };
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return { text, questions: null, error: "ask block is not valid JSON" };
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const list = Array.isArray(raw) ? raw : isObj(raw) ? raw.questions : undefined;
  if (!Array.isArray(list) || !list.length) return { text, questions: null, error: "ask block has no questions" };
  const questions: AskQuestion[] = [];
  // Answers are keyed by question id: a repeated id would let one answer fill two questions.
  const usedIds = new Set<string>();
  for (const [i, q] of list.slice(0, MAX_Q).entries()) {
    if (!isObj(q)) return { text, questions: null, error: `question ${i + 1} is not an object` };
    const o = q;
    const question = String(o.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
    // Owner 2026-10-23: options may be {label, description} objects (OMP's ask tool shape). Anything else is
    // rejected with an error naming the option, so a bad block never posts as raw JSON without a menu.
    const rawOpts = Array.isArray(o.options) ? o.options : [];
    const options: string[] = [];
    const descriptions: string[] = [];
    // `recommended` indexes the RAW options; skipped (empty/repeated) options shift the kept ones, so map it.
    const rawRec = typeof o.recommended === "number" && Number.isInteger(o.recommended) && o.recommended >= 0 ? o.recommended : undefined;
    let explicitRec: number | undefined;
    let flaggedRec: number | undefined;
    for (const [k, x] of rawOpts.entries()) {
      let label: string;
      let desc = "";
      let flagged = false;
      if (typeof x === "string" || typeof x === "number") label = String(x);
      else if (isObj(x) && typeof x.label === "string") {
        label = x.label;
        if (x.description !== undefined && typeof x.description !== "string") return { text, questions: null, error: `question ${i + 1}, option ${k + 1}: description must be a string. ${OPTION_FORMAT_HINT}` };
        desc = (x.description ?? "").trim().slice(0, MAX_OPTION_CHARS);
        flagged = x.recommended === true;
      } else return { text, questions: null, error: `question ${i + 1}, option ${k + 1} is not a string or {label, description}. ${OPTION_FORMAT_HINT}` };
      label = label.trim().slice(0, MAX_OPTION_CHARS);
      const at = label ? options.indexOf(label) : -1;
      const keep = !!label && at < 0 && options.length < MAX_OPT;
      const idx = keep ? options.length : at >= 0 ? at : undefined;
      if (k === rawRec) explicitRec = idx;
      if (flagged) flaggedRec ??= idx;
      if (!keep) continue;
      options.push(label);
      descriptions.push(desc);
    }
    let recommended = rawRec !== undefined ? explicitRec : flaggedRec;
    if (!question || options.length < 2) return { text, questions: null, error: `question ${i + 1} needs text and at least 2 options` };
    // Owner 2026-10-23: every menu has a ✏️ Other button (the hint promises it). Added when the block left it out.
    if (!options.some(isOtherOption)) {
      if (options.length >= MAX_OPT) {
        options.pop();
        descriptions.pop();
        if (recommended !== undefined && recommended >= options.length) recommended = undefined; // the popped option
      }
      options.push("✏️ Other (type or dictate a reply)");
      descriptions.push("");
    }
    if (recommended !== undefined && recommended >= options.length) recommended = undefined;
    // Recommended: explicit "recommended" index, or an option text ending in "(Recommended)" (tag stripped).
    const tag = /\s*\((?:recommended)\)\s*$/i;
    options.forEach((x, k) => {
      if (tag.test(x)) {
        options[k] = x.replace(tag, "");
        recommended ??= k;
      }
    });
    const withDesc = descriptions.some(Boolean) ? { descriptions } : {};
    let id = String(o.id ?? `q${i + 1}`).slice(0, 40);
    if (usedIds.has(id)) id = `q${i + 1}`;
    while (usedIds.has(id)) id += "_";
    usedIds.add(id);
    questions.push({ id, question, options, ...withDesc, multi: o.multi === true, ...(recommended !== undefined ? { recommended } : {}) });
  }
  return { text: text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim(), questions };
}

/** Owner's answers as the next turn's text. */
/** "✏️ Other (type a reply)"-style options open a text pop-up instead of being picked as-is. */
export const isOtherOption = (o: string): boolean => /^(✏️\s*)?other\b/i.test(o.trim());

export function answersText(set: AskSet): string {
  const lines = set.questions.map((q) => `- ${q.question} → ${(set.answers[q.id] ?? []).join(", ")}`);
  return ["[Answers to your questions, picked in Discord]", ...lines].join("\n");
}

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** Why a tapped menu is unknown to the store (owner 2026-10-23, Discord UX item 3). */
export type LateKind = "expired" | "closed" | "lost";

/** Creation time encoded in a set id (`Date.now().toString(36)` + counter), or null if it does not look like one. */
export function setIdTime(setId: string, now = Date.now()): number | null {
  const t = parseInt(setId.slice(0, 8), 36);
  return Number.isFinite(t) && t > now - 400 * 86_400_000 && t <= now + 60_000 ? t : null;
}

const ageText = (ms: number): string => (ms < 48 * 3_600_000 ? `${Math.max(1, Math.round(ms / 3_600_000))} h` : `${Math.round(ms / 86_400_000)} days`);

/** First line of a late answer: says truthfully why the menu is no longer open. */
export function lateHeader(kind: LateKind, ageMs?: number): string {
  const age = ageMs !== undefined ? ` (asked ${ageText(ageMs)} ago)` : "";
  if (kind === "expired") return `[Answer to an expired menu${age}, picked in Discord. It arrives on its own; check that it still applies.]`;
  if (kind === "closed") return `[Answer to a menu that was already closed${age}, picked in Discord. It arrives on its own; check that it still applies.]`;
  return "[Answer to an earlier question, picked in Discord. Its menu was lost in a bot restart, so it arrives on its own.]";
}

/** The question and the picked/typed answer of a tap on a menu message, as one "- question → answer" line. */
export function recoverLine(content: string | undefined, pick: number | null, typed?: string): string | null {
  const lines = (content ?? "").split("\n").map((l) => l.trim());
  const question = lines
    .map((l) => l.replace(/^❓/, "").replace(/\*\*Question \d+ of \d+\*\*/, "").trim())
    .find(Boolean);
  if (!question) return null;
  let answer: string | undefined;
  if (typed?.trim()) answer = typed.trim();
  else if (pick !== null) {
    const key = KEYCAPS[pick] ?? `**${pick + 1}.**`;
    const line = lines.find((l) => l.startsWith(key));
    const label = line?.slice(key.length).replace(/\s*\*\*⭐ \(Recommended\)\*\*\s*$/, "").trim();
    answer = label ? `${pick + 1}. ${label}` : String(pick + 1);
  }
  if (!answer) return null;
  return `- ${question.slice(0, 300)} → ${answer.slice(0, 1000)}`;
}

/** "Question 2 of 3" → 3; a single question → 1. */
export function menuTotal(content: string | undefined): number {
  const m = (content ?? "").match(/\*\*Question \d+ of (\d+)\*\*/);
  return m ? Number(m[1]) : 1;
}

/**
 * Owner 2026-10-16: a tap on a menu the bot no longer knows (lost in a restart) is not a dead end.
 * Recover the question and the tapped option from the bridge's own message text, so the tap can go to
 * the agent as the owner's typed answer. `pick` is the 0-based option index; `typed` is an Other text.
 */
export function recoverAnswer(content: string | undefined, pick: number | null, typed?: string, kind: LateKind = "lost", ageMs?: number): string | null {
  const line = recoverLine(content, pick, typed);
  return line ? [lateHeader(kind, ageMs), line].join("\n") : null;
}

/**
 * Owner 2026-10-23 (item 3): taps on the questions of one unknown set within 60 s go to the agent as ONE
 * turn (three taps on a 45 h old menu started three runs). Flushes early once every question has a tap.
 */
export class TapBatcher<T> {
  private open = new Map<string, { total: number; lines: Map<string, string>; items: T[]; timer: NodeJS.Timeout }>();
  constructor(
    private flush: (key: string, lines: string[], items: T[]) => void,
    private windowMs = 60_000,
  ) {}

  /** `slot` identifies the question (a later tap on the same question replaces the earlier line). */
  add(key: string, total: number, slot: string, line: string, item: T): void {
    let b = this.open.get(key);
    if (!b) {
      b = { total, lines: new Map(), items: [], timer: setTimeout(() => this.done(key), this.windowMs) };
      this.open.set(key, b);
    }
    b.lines.set(slot, line);
    b.items.push(item);
    if (b.lines.size >= b.total) this.done(key);
  }

  pending(key: string): number {
    return this.open.get(key)?.lines.size ?? 0;
  }

  private done(key: string): void {
    const b = this.open.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    this.open.delete(key);
    this.flush(key, [...b.lines.values()], b.items);
  }
}

/** A set that is no longer open: kept CLOSED_KEEP_MS for the late-tap label and 🔁 Ask again. */
export interface ClosedSet {
  setId: string;
  channelId: string;
  questions: AskQuestion[];
  messageIds?: Record<string, string>;
  createdAt: number;
  closedAt: number;
  reason: "expired" | "closed" | "asked-again" | "cancelled";
  sourceId?: string;
  partIds?: string[];
  /** Owner 2026-10-25 (card ask-cancel-button): 🚫 Cancel. Not an answer. */
  cancelled?: boolean;
  cancelledAt?: number;
  /** 🗑️ Delete message: the menu messages were removed from Discord (the record stays). */
  deletedAt?: number;
  answered?: boolean;
  answeredAt?: number;
  answerVia?: AnswerVia;
  /** Expired menus: true once the bot edited them to "⌛ Expired · 🔁 Ask again". */
  edited?: boolean;
}

export class AskStore {
  private sets = new Map<string, AskSet>();
  /** Channel ids that hold an open menu (owner 2026-10-24: the idle-thread sweep keeps those threads). */
  openChannels(): Set<string> {
    return new Set([...this.sets.values()].map((s) => s.channelId));
  }
  private closed = new Map<string, ClosedSet>();
  private n = 0;
  private file: string | null;

  /** `dir`: where asks.json lives; omit for a memory-only store. */
  constructor(dir?: string, now = Date.now()) {
    this.file = dir ? join(dir, "asks.json") : null;
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sets?: AskSet[]; closed?: ClosedSet[] };
      for (const s of raw.sets ?? []) {
        if (s && typeof s.setId === "string" && typeof s.channelId === "string" && Array.isArray(s.questions) && typeof s.createdAt === "number")
          this.sets.set(s.setId, { ...s, answers: s.answers ?? {} });
      }
      for (const c of raw.closed ?? []) if (c && typeof c.setId === "string" && typeof c.closedAt === "number" && Array.isArray(c.questions)) this.closed.set(c.setId, c);
    } catch {
      /* missing or corrupt file: start empty */
    }
    const before = this.sets.size + this.closed.size;
    this.prune(now);
    if (this.sets.size + this.closed.size !== before) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sets: [...this.sets.values()], closed: [...this.closed.values()] }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(`asks.json save failed: ${(e as Error).message}`);
    }
  }

  create(channelId: string, questions: AskQuestion[], now = Date.now(), sourceId?: string): AskSet {
    this.prune(now);
    const setId = `${now.toString(36)}${(this.n++).toString(36)}`;
    const set: AskSet = { setId, channelId, questions, answers: {}, createdAt: now, messageIds: {}, pending: {}, ...(sourceId ? { sourceId } : {}) };
    this.sets.set(setId, set);
    this.save();
    return set;
  }

  /** Remember the message id of the menu posted for question `qi`. */
  recordMessage(setId: string, qi: number, messageId: string): void {
    const s = this.sets.get(setId);
    if (!s) return;
    (s.messageIds ??= {})[String(qi)] = messageId;
    this.save();
  }

  /** Remember one posted menu message (any part), for 🗑️ Delete. */
  recordPart(setId: string, messageId: string): void {
    const s = this.sets.get(setId);
    if (!s) return;
    (s.partIds ??= []).push(messageId);
    this.save();
  }

  /**
   * Owner 2026-10-25 (card ask-cancel-button): 🚫 Cancel closes an open set without an answer. The boards drop it
   * (they list only open sets). Returns the closed record, or null when the set is not open.
   */
  cancel(setId: string, now = Date.now()): ClosedSet | null {
    this.prune(now);
    const s = this.sets.get(setId);
    if (!s) return null;
    this.sets.delete(setId);
    const c: ClosedSet = { ...closedFields(s), answered: false, closedAt: now, reason: "cancelled", cancelled: true, cancelledAt: now, edited: true };
    delete c.answeredAt;
    delete c.answerVia;
    this.closed.set(setId, c);
    this.save();
    return c;
  }

  /** 🗑️ Delete message: record that the menu messages were deleted. The record stays. */
  markDeleted(setId: string, now = Date.now()): void {
    const c = this.closed.get(setId);
    if (!c) return;
    c.deletedAt = now;
    this.save();
  }

  private parse(customId: string): { set: AskSet; qi: number } | null {
    const m = customId.slice(ASK_PREFIX.length).match(/^([a-z0-9]+):(\d+)$/);
    const set = m ? this.sets.get(m[1]!) : undefined;
    return set && set.questions[Number(m![2])] ? { set, qi: Number(m![2]) } : null;
  }

  /** Multi-select picks ticked so far (persisted). */
  picks(customId: string): Set<number> {
    const p = this.parse(customId);
    return new Set(p?.set.pending?.[String(p.qi)] ?? []);
  }

  setPicks(customId: string, picks: Set<number> | null): void {
    const p = this.parse(customId);
    if (!p) return;
    const pend = (p.set.pending ??= {});
    if (picks?.size) pend[String(p.qi)] = [...picks];
    else delete pend[String(p.qi)];
    this.save();
  }

  /** customId for question index `qi` of a set. */
  static customId(setId: string, qi: number): string {
    return `${ASK_PREFIX}${setId}:${qi}`;
  }

  /**
   * Record a pick. Returns the set when this pick completed it (it is then removed), "partial"
   * while questions remain, or "unknown" for an expired/unknown set or bad index/values.
   */
  answer(customId: string, values: string[], now = Date.now(), freeText?: string): AskSet | "partial" | "unknown" {
    this.prune(now);
    const m = customId.slice(ASK_PREFIX.length).match(/^([a-z0-9]+):(\d+)$/);
    const set = m ? this.sets.get(m[1]!) : undefined;
    const q = set?.questions[Number(m?.[2])];
    if (!set || !q) return "unknown";
    const picked = values.map((v) => q.options[Number(v)]).filter((x): x is string => x !== undefined);
    if (freeText?.trim()) picked.push(`Other: ${freeText.trim().slice(0, 1000)}`);
    if (!picked.length || (!q.multi && picked.length > 1)) return "unknown";
    set.answers[q.id] = picked;
    (set.responded ??= {})[String(Number(m![2]))] = { at: now, via: freeText?.trim() ? "other" : "pick" };
    if (set.pending) delete set.pending[String(Number(m![2]))];
    if (set.questions.every((x) => set.answers[x.id]?.length)) {
      this.sets.delete(set.setId);
      this.save();
      return set;
    }
    this.save();
    return "partial";
  }

  /** The open question behind a customId prefix ("ask:<set>:<qi>"), or null. */
  question(customId: string, now = Date.now()): AskQuestion | null {
    this.prune(now);
    const m = customId.slice(ASK_PREFIX.length).match(/^([a-z0-9]+):(\d+)$/);
    return (m && this.sets.get(m[1]!)?.questions[Number(m[2])]) || null;
  }

  /** Open sets (newest first), optionally for one channel. Read-only copies. */
  openSets(channelId?: string, now = Date.now()): AskSet[] {
    this.prune(now);
    return [...this.sets.values()].filter((s) => !channelId || s.channelId === channelId).sort((a, b) => b.createdAt - a.createdAt).map((s) => structuredClone(s));
  }

  /** Owner 2026-10-27: sets answered in this channel in the last `withinMs` (for the no-re-ask check). */
  recentlyAnswered(channelId: string, withinMs = 24 * 3_600_000, now = Date.now()): ClosedSet[] {
    return [...this.closed.values()].filter((c) => c.channelId === channelId && c.answered && now - (c.answeredAt ?? c.closedAt) < withinMs);
  }

  /** A closed/expired set, or null. */
  closedSet(setId: string): ClosedSet | null {
    return this.closed.get(setId) ?? null;
  }

  /** Why a set id is unknown, and how old it is (for the late-tap label). Null when the set is still open. */
  lateKind(setId: string, now = Date.now()): { kind: LateKind; ageMs?: number } | null {
    this.prune(now);
    if (this.sets.has(setId)) return null;
    const c = this.closed.get(setId);
    const t = c?.createdAt ?? setIdTime(setId, now);
    const ageMs = t !== null && t !== undefined ? now - t : undefined;
    if (c) return { kind: c.reason === "expired" ? "expired" : "closed", ageMs };
    // Not remembered: older than the TTL in force when it was posted → it expired; else it was lost.
    return { kind: ageMs !== undefined && ageMs > OLD_ASK_TTL_MS ? "expired" : "lost", ageMs };
  }

  /** Card sweep (POST /asks/close): close open sets; the caller edits their messages. Returns the ids closed. */
  close(setIds: string[], reason: ClosedSet["reason"] = "closed", now = Date.now()): string[] {
    const done: string[] = [];
    for (const id of setIds) {
      const s = this.sets.get(id);
      if (!s) continue;
      this.sets.delete(id);
      this.closed.set(id, { ...closedFields(s), closedAt: now, reason, edited: true });
      done.push(id);
    }
    if (done.length) this.save();
    return done;
  }

  /**
   * Owner 2026-10-25 (card answered-clears-needs): ANY owner response to a menu closes it for the boards at once, even
   * when the work is not done: a Discord reply to the menu or to the request it answers (`messageIds`), a ✅ reaction,
   * a late tap. Closed/expired sets count too (late answers). Only messages that point at the menu count; unrelated
   * text in the same channel does not (one channel holds menus of many topics). Returns the set ids marked.
   */
  markAnswered(messageIds: (string | null | undefined)[], via: AnswerVia, now = Date.now()): string[] {
    this.prune(now);
    const mids = new Set(messageIds.filter((x): x is string => Boolean(x)));
    const marked: string[] = [];
    const visit = (s: AskSet | ClosedSet, open: boolean) => {
      const qmids = Object.entries(s.messageIds ?? {});
      const all = s.sourceId !== undefined && mids.has(s.sourceId);
      const hit = all ? qmids.map(([k]) => k) : qmids.filter(([, v]) => mids.has(v)).map(([k]) => k);
      if (!hit.length && !all) return;
      if (open) {
        const o = s as AskSet;
        for (const k of hit) (o.responded ??= {})[k] ??= { at: now, via };
        if (!o.questions.every((q, i) => o.answers[q.id]?.length || o.responded?.[String(i)])) return void marked.push(s.setId);
      }
      if (!s.answered) Object.assign(s, { answered: true, answeredAt: now, answerVia: via });
      marked.push(s.setId);
    };
    for (const s of this.sets.values()) visit(s, true);
    for (const c of this.closed.values()) visit(c, false);
    if (marked.length) this.save();
    return marked;
  }

  /** Expired sets whose menus still need the "⌛ Expired · 🔁 Ask again" edit. */
  unedited(now = Date.now()): ClosedSet[] {
    this.prune(now);
    return [...this.closed.values()].filter((c) => c.reason === "expired" && !c.edited);
  }

  markEdited(setId: string): void {
    const c = this.closed.get(setId);
    if (!c || c.edited) return;
    c.edited = true;
    this.save();
  }

  /** 🔁 Ask again: forget the closed set (its menus get re-posted as a new set). */
  forgetClosed(setId: string): void {
    if (this.closed.delete(setId)) this.save();
  }

  private prune(now: number): void {
    let changed = false;
    for (const [k, s] of this.sets)
      if (now - s.createdAt > ASK_TTL_MS) {
        this.sets.delete(k);
        this.closed.set(k, { ...closedFields(s), closedAt: now, reason: "expired", edited: false });
        changed = true;
      }
    for (const [k, c] of this.closed)
      if (now - c.closedAt > CLOSED_KEEP_MS) {
        this.closed.delete(k);
        changed = true;
      }
    if (changed && this.file) this.save();
  }
}

export type AnswerVia = "pick" | "other" | "reply" | "text" | "reaction" | "stack-thread" | "late";

function closedFields(s: AskSet): Omit<ClosedSet, "closedAt" | "reason"> {
  const { setId, channelId, questions, messageIds, createdAt, sourceId, answered, answeredAt, answerVia, partIds } = s;
  return { setId, channelId, questions, messageIds, createdAt, sourceId, ...(partIds ? { partIds } : {}), ...(answered ? { answered, answeredAt, answerVia } : {}) };
}

/** Same question text, ignoring case, spaces and punctuation. */
const normQ = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/**
 * Owner 2026-10-27: never ask a question again while its earlier menu is still open in the channel.
 * Returns the questions to post and, for each dropped one, the open menu's message id (to link instead).
 */
export function dropRepeatedQuestions(questions: AskQuestion[], open: AskSet[], answered: ClosedSet[] = []): { keep: AskQuestion[]; repeated: { question: string; messageId?: string; answered?: boolean }[] } {
  const openQ = new Map<string, string | undefined>();
  const doneQ = new Map<string, string | undefined>();
  for (const c of answered) for (const q of c.questions) doneQ.set(normQ(q.question), c.messageIds?.[q.id] ?? Object.values(c.messageIds ?? {})[0]);
  for (const s of open)
    for (const q of s.questions) if (!(s.answers[q.id]?.length)) openQ.set(normQ(q.question), s.messageIds?.[q.id] ?? Object.values(s.messageIds ?? {})[0]);
  const keep: AskQuestion[] = [];
  const repeated: { question: string; messageId?: string; answered?: boolean }[] = [];
  for (const q of questions) {
    const k = normQ(q.question);
    if (openQ.has(k)) repeated.push({ question: q.question, messageId: openQ.get(k) });
    else if (doneQ.has(k)) repeated.push({ question: q.question, messageId: doneQ.get(k), answered: true });
    else keep.push(q);
  }
  return { keep, repeated };
}
