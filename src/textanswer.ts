// Owner 2026-10-31 (card voice-answer-closes-menu): a spoken answer ("Yes, I heard it.")
// or a typed free-text message that is not a Discord reply can still answer an open menu in the same channel. The
// judge maps the text to one option of one open question. A sure match records the pick (menu closed, Needs you
// cleared, one answers turn to the asking session). An unsure match leaves the menu open and says so.

import { isOtherOption, type AskSet } from "./ask.ts";
import { redact } from "./redact.ts";
import { leavesOpen } from "./reask.ts";

export interface MenuCandidate {
  setId: string;
  qi: number;
  question: string;
  options: string[];
  messageId?: string;
}

/** Judge result: a choice key ("c<cand>o<option>" or "none") and its confidence (0..1). */
export interface MenuJudgeResult {
  choice: string;
  confidence: number;
}
export type MenuJudge = (text: string, cands: MenuCandidate[]) => Promise<MenuJudgeResult | null>;

export type MenuMatch =
  | { kind: "answer"; cand: MenuCandidate; option: number; confidence: number }
  | { kind: "unsure"; cands: MenuCandidate[]; detail: string }
  | { kind: "none"; detail: string };

/** Confidence needed to record an answer without a tap. */
export const MENU_MIN_CONFIDENCE = 0.8;
/** At most this many open questions go to the judge (newest first). */
export const MENU_MAX_CANDIDATES = 6;

/** Unanswered single-pick questions of the open sets in the given channels (newest set first). */
export function menuCandidates(sets: AskSet[], channelIds: (string | null | undefined)[]): MenuCandidate[] {
  const chans = new Set(channelIds.filter((x): x is string => Boolean(x)));
  const out: MenuCandidate[] = [];
  for (const s of [...sets].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!chans.has(s.channelId)) continue;
    s.questions.forEach((q, qi) => {
      if (q.multi || s.answers[q.id]?.length) return;
      out.push({ setId: s.setId, qi, question: q.question, options: q.options, messageId: s.messageIds?.[String(qi)] });
    });
  }
  return out.slice(0, MENU_MAX_CANDIDATES);
}

/** Choice keys and their criteria for the judge. "Other" options are not offered (they need the owner's own text). */
export function menuChoices(cands: MenuCandidate[]): Record<string, string> {
  const out: Record<string, string> = {};
  cands.forEach((c, ci) =>
    c.options.forEach((o, oi) => {
      if (!isOtherOption(o)) out[`c${ci}o${oi}`] = `Answers the question "${c.question.slice(0, 400)}" with: ${o.slice(0, 300)}`;
    }),
  );
  out.none = "The message does not clearly answer any of these questions (other topic, asks back, defers, or is ambiguous).";
  return out;
}

export async function matchMenuAnswer(text: string, cands: MenuCandidate[], judge: MenuJudge | undefined, opts: { minConfidence?: number; timeoutMs?: number } = {}): Promise<MenuMatch> {
  const t = text.trim();
  if (!t || !cands.length) return { kind: "none", detail: "no open question" };
  // Asking back or putting it off never answers (card noreask-clarify).
  if (leavesOpen(t)) return { kind: "none", detail: "asks back or defers" };
  if (!judge) return { kind: "unsure", cands, detail: "no judge" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let j: MenuJudgeResult | null | "timeout";
  try {
    const late = Promise.withResolvers<"timeout">();
    timer = setTimeout(() => late.resolve("timeout"), opts.timeoutMs ?? 8_000);
    j = await Promise.race([judge(t, cands), late.promise]);
  } catch (e) {
    return { kind: "unsure", cands, detail: `judge error ${(e as Error).message.slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
  if (j === "timeout" || !j) return { kind: "unsure", cands, detail: j === "timeout" ? "judge timeout" : "judge gave no answer" };
  const min = opts.minConfidence ?? MENU_MIN_CONFIDENCE;
  if (j.choice === "none") return j.confidence >= 0.5 ? { kind: "none", detail: `judge none ${j.confidence.toFixed(2)}` } : { kind: "unsure", cands, detail: `judge none ${j.confidence.toFixed(2)}` };
  const m = /^c(\d+)o(\d+)$/.exec(j.choice);
  const cand = m ? cands[Number(m[1])] : undefined;
  const option = m ? Number(m[2]) : -1;
  if (!cand || !cand.options[option] || isOtherOption(cand.options[option]!)) return { kind: "unsure", cands, detail: `judge bad choice ${j.choice}` };
  if (j.confidence < min) return { kind: "unsure", cands: [cand], detail: `judge ${j.choice} ${j.confidence.toFixed(2)} below ${min}` };
  return { kind: "answer", cand, option, confidence: j.confidence };
}

/** JEV decisions judge (same API and credential as the router judge in src/router.ts). The text is redacted first. */
export function jevMenuJudge(opts: { keyFn: () => Promise<string>; endpoint?: string; model?: string; fetchFn?: typeof fetch }): MenuJudge {
  const endpoint = opts.endpoint ?? "https://openrouter.ai/api/alpha/decisions";
  const model = opts.model ?? "~typesafe/jev-latest";
  const f = opts.fetchFn ?? fetch;
  let cached: { key: string; at: number } | null = null;
  return async (text, cands) => {
    if (!cached || Date.now() - cached.at > 10 * 60_000) cached = { key: await opts.keyFn(), at: Date.now() };
    const body = {
      model,
      state: { task: "Decide if the owner's message (spoken or typed) answers one of the open questions he was asked, and with which option.", message: redact(text).text.slice(0, 1500) },
      questions: {
        answer: {
          type: "choice",
          criteria: menuChoices(cands),
          instructions: {
            goal: "Pick the option the message clearly gives as its answer.",
            rules: ["Pick none when the message is about something else, asks a question back, puts the question off, or could fit more than one option.", "A plain 'yes'/'I heard it'/'it works' matches the positive option of a yes/no style test question."],
          },
        },
      },
    };
    const res = await f(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cached.key}` }, body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) cached = null;
    if (!res.ok) throw new Error(`decisions HTTP ${res.status}`);
    const j = (await res.json()) as { answers?: { answer?: { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } } };
    const a = j.answers?.answer;
    const choice = typeof a?.choice === "string" ? a.choice : null;
    if (!choice) return null;
    const p = a?.probabilities?.[choice];
    return { choice, confidence: typeof a?.confidence === "number" ? a.confidence : typeof p === "number" ? p : 0 };
  };
}
