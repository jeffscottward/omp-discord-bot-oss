// Owner 2026-10-31 (card no-reask-answered): a session must not ask the owner again what the owner already
// answered. Before a menu is posted, each question is compared with the questions answered in the last 7 days
// in any channel. The check uses topic words of the question, its options and their descriptions (not exact
// text): a re-ask after a new CI run has other numbers and wording but the same topic.

/** One question the owner answered, as kept by the ask store. */
export interface AnsweredQuestion {
  question: string;
  options: string[];
  descriptions?: string[];
  /** Picked options or "Other: …" text; empty when the owner answered by reply or reaction. */
  answer: string[];
  channelId: string;
  messageId?: string;
  answeredAt: number;
}

export interface ReaskMatch {
  earlier: AnsweredQuestion;
  score: number;
}

export const REASK_WINDOW_MS = 7 * 24 * 3_600_000;
/** Jaccard score of topic words that counts as the same question. */
export const REASK_MIN_SCORE = 0.2;
/** Shared topic words needed in addition to the score (credit questions must not match on 2 words). */
export const REASK_MIN_SHARED = 5;
/** With the same card id in both questions, a weaker topic match is enough. */
export const REASK_CARD_SCORE = 0.12;
/** Shared topic words of the options (with descriptions): the same question offers the same kind of answers. */
export const REASK_MIN_OPTION_SHARED = 3;
/**
 * Card reask-false-match (2026-11-01): a new question on the same topic ("Webapp Autopilot key: how should it be
 * created?") units topic words with an answered one ("turn on the Autopilot tick timer?") but asks another thing
 * and offers other answers. The question text alone (its intent) and the option set must each match too.
 */
export const REASK_MIN_QUESTION_SHARED = 3;
export const REASK_MIN_QUESTION_SCORE = 0.2;
export const REASK_MIN_OPTION_SCORE = 0.15;
/**
 * Card reask-false-match-2 (2026-11-02): descriptions of two sizing questions share words ("loss", "size", "stop",
 * "spread") although the buttons offer other answers ("$10k max loss" vs "Full value counts as the loss"). The
 * button labels alone must match too (true repeat "artifact quota": 3 shared label words). One shared word is never
 * enough ("Merge"/"Wait" vs "Merge"/"Rebase"). Empty label words on one side only (Yes/No vs "Yes, merge") never match.
 */
export const REASK_MIN_LABEL_SHARED = 3;
export const REASK_MIN_LABEL_SCORE = 0.25;

const STOP = new Set(
  ("a an and are as at be been but by can do does done for from has have how i if in into is it its me my no not now of on only or our " +
    "out should so that the their them then there these they this to too us was we what when which who why will with you your yes " +
    "other type dictate reply tap number recommended option options choose pick all any one two three four after before about need needs new")
    .split(" "),
);

/** Light stem: plural and verb endings, so "artifacts"/"artifact" and "deleting"/"delete" meet. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Topic words of a question with its options and descriptions. Numbers and URLs are dropped. */
export function topicWords(question: string, options: string[] = [], descriptions: string[] = []): Set<string> {
  const text = [question, ...options, ...descriptions].join(" ").toLowerCase().replace(/https?:\/\/\S+/g, " ");
  const out = new Set<string>();
  for (const raw of text.split(/[^a-z]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const w = stem(raw);
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** FIRSTMATE card ids named in the text: kebab-case words with 2+ parts (e.g. "ci-speed-audit"). */
export function cardIds(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) ?? []).filter((x) => /[a-z]{3}/.test(x)));
}

export function similarity(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return { score: union ? shared / union : 0, shared };
}

// Owner 2026-10-31 (card noreask-clarify): an owner reply that asks back ("what do you mean", "which one?", "I'm
// confused about the context") is a clarification request, not an answer. The question stays open: a later menu
// that asks it again (after the session explains) must post. A false "answer" here blocks the question for 7 days;
// a false "clarification" only lets one menu post again, so unclear text with a question counts as clarification.
const CLARIFY_PHRASE =
  /\b(?:no idea|i(?: a|')?m (?:lost|not sure what)|(?:don'?t|do not|didn'?t|did not) (?:understand|get it|follow|know what)|not sure what (?:you|this|it|that)|what do(?:es)? (?:you|this|that|it) mean|what (?:is|was) (?:this|that|it) (?:about|for)|what are you asking|what(?:'s| is) the (?:question|context)|which one|(?:what|which) context|(?:more|some|missing) context(?=\s*(?:\?|please\b|first\b|$))|no context|context (?:of|for|behind) (?:the|this|that) question|need (?:more |some |the )?context|remind me what|what did i (?:send|say|ask|write|mean)|(?:please|can you|could you|would you) (?:explain|clarify|elaborate)|^(?:explain|clarify|elaborate)|huh)\b/i;
/** Text that answers the menu outright: a pick, yes/no, or a direct order. */
const ANSWER_LEAD =
  /^(?:yes|yeah|yep|yup|no(?! idea| context)|nope|nah|ok|okay|sure|fine|approved?|go(?: ahead)?|do (?:it|that|this|both|all|option)|ship|merge|skip|keep|stop|cancel|use|pick|choose|both|neither|none|all|delete|leave)\b/i;
/** A pick named at the start ("2", "option 2, but …"); "what does option 2 mean?" still asks back. */
const PICK = /^\s*(?:option\s*)?#?\d+\b|^\s*[1-9]\ufe0f?\u20e3/i;

/** Asking back beyond doubt: wins over a leading pick or "yes" ("Sure, which one?", "Option 1 or 2? I'm confused"). */
const CLARIFY_STRONG =
  /\b(?:(?:don'?t|do not|didn'?t|did not) understand|what do(?:es)? \w+ mean|which one|what (?:is|was) (?:this|that|it) (?:about|for)|no idea)\b/i;

/** The owner says the question confuses him ("Still confused", "This is so confusing", "I'm confused about …"). */
const CONFUSED =
  /^(?:(?:still|so|very|really|totally|a bit|i'?m|i am|this is|that is|it'?s)\s+){0,3}confus\w*\b|\bi(?: a|')?m (?:\w+ ){0,2}confus|\bconfus\w* (?:about|by|here|what)|\b(?:this|that|it)(?: is|'s) (?:\w+ ){0,2}confusing/i;

/** Owner reply text that asks for context or meaning instead of answering. */
export function isClarification(text: string): boolean {
  const t = text.replace(/[\u2018\u2019]/g, "'").replace(/^\s*(?:✏️\s*)?other:\s*/i, "").trim();
  if (!t) return false;
  if (CONFUSED.test(t) || CLARIFY_STRONG.test(t)) return true;
  // "2, but …" and "Yes, and explain later" answer.
  if (PICK.test(t) || ANSWER_LEAD.test(t)) return false;
  if (CLARIFY_PHRASE.test(t)) return true;
  return /\?\s*$/.test(t) || /^(?:what|which|why|how|who|where|when|wait what)\b/i.test(t);
}

// Owner 2026-10-31 (FIRSTMATE live case): a reply that puts the question off ("Remind me
// to test this later after an idle restart", "not now", "ask me again Monday") is a deferral, not an answer. The
// voice-call test menu was stopped 3 times by its own deferral. A deferral leaves the question open like asking back.
const DEFER =
  /\b(?:remind me\b(?! what)|not right now|hold off|skip for now|(?:ask|ping|check with) (?:me )?(?:again|later)|(?:test|try|check|decide|answer|look at|review|do) (?:(?:this|it|that|them) )?(?:later|another time)|not (?:now|yet|today)|(?:once|after|when|until) (?:the |an? |your |you )?(?:[\w-]+ ){0,3}(?:restart|deploy|fix) (?:is |has )?(?:done|happens|lands|is live|goes live|ships)|can(?:'?t|not) (?:\w+ ){0,3}until|(?:test|ask me|check) after (?:the |an? )?(?:[\w-]+ ){0,2}(?:restart|deploy)|(?:park|queue|hold) (?:it|this|that)(?: for later)?|ask (?:me )?(?:on|next|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|^\W*(?:\w+ )?later\b/i;

/** A button label that is itself a deferral ("⏳ Test later", "Not now"); "❌ Not yet fixed" is a result. */
const DEFER_LABEL = /^\W*(?:(?:test|try|check|decide|answer|ask(?: me)?|remind me|maybe|do (?:it|this))\s+)?later\b|^\W*(?:not now|remind me\b|ask me (?:again|later)|snooze)/i;

// Owner 2026-10-31 (card reask-retest-defer): "Maybe it's been restarted now. I have to
// test it again. I'm not sure" is an unsure retest, not an answer. These phrases count anywhere in the reply.
const RETEST =
  /\b(?:(?:have|need|got) to (?:re-?test|test|try|check)(?: (?:it|this|that))?(?: (?:again|once more))|(?:re-?test|test|try|check) (?:it |this |that )?again|maybe (?:it'?s|it has|it) (?:been|was) restarted|i'?m not sure|not sure yet|i don'?t know yet|^\W*not sure\b|let me know (?:if|when|once|whether)|i would answer(?: (?:this|that|it))?,? but|i'?ll (?:answer|try|test)(?: (?:it|this|that))? (?:when|once|after|later))\b/i;

/**
 * Owner reply text that puts the question off instead of answering it. Only the first clause counts, and not when it
 * is a pick or a direct answer: "Not yet, ask me again Monday" defers; "Yes, remind me to rotate the key" answers.
 */
export function isDeferral(text: string): boolean {
  const t = text.replace(/[\u2018\u2019]/g, "'").replace(/^\s*(?:✏️\s*)?other:\s*/i, "").trim();
  const first = t.split(/[,;.!?(]|\s[—–-]\s/)[0]!.trim();
  if (!first || PICK.test(first) || ANSWER_LEAD.test(first)) return false;
  return DEFER.test(first) || RETEST.test(t);
}

/** Owner reply text that leaves the question open: it asks back or puts the question off. */
export function leavesOpen(text: string): boolean {
  return isClarification(text) || isDeferral(text);
}

/**
 * A stored answer that leaves the question open: every entry asks back or defers. "Other: …" texts use both checks;
 * a button pick counts only when its label is itself a deferral ("⏳ Test later"); every other pick is an answer.
 */
export function isOpenAnswer(answer: string[]): boolean {
  return answer.length > 0 && answer.every((a) => (/^\s*other:/i.test(a) ? leavesOpen(a) : DEFER_LABEL.test(a)));
}

// Card bot-reask-false-match (2026-11-02): a new DEF-line question matched the answered
// "credit ABC" question twice. Both share the batch words (DEF, ABC, line, Acme, size). Two guards:
// 1. A question that says it is new or separate ("New question (not the ABC credit)", "separate from the approved …")
//    is never a re-ask: the asking session already knows the earlier answer does not cover it.
// 2. Uppercase identifiers (codes, IDs like GHI, PR numbers) in the new question text that the earlier question
//    and its options never named, next to one they share, mean another subject.
const SAYS_NEW = /^\W*(?:new|separate|different) question\b|\((?:new question|not the [^)]{1,60})\)/i;
const IDENT_STOP = new Set(["OK", "NO", "YES", "PR", "CI", "ET", "UTC", "AM", "PM", "US", "ID", "URL", "API", "LLM", "OMP", "GB", "MB", "KB", "TB", "EST", "EDT", "PT", "PST", "PDT", "USD", "ETF", "MOC", "MOO", "LMT", "MKT", "GTC", "DAY", "NOW", "NOT", "ALL", "ASAP", "FYI", "TODO"]);

/** Uppercase identifiers (2-6 letters) named in the text: codes, unit names. */
export function identifiers(text: string): Set<string> {
  return new Set((text.replace(/https?:\/\/\S+/g, " ").match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? []).filter((x) => /[A-Z]{2}/.test(x) && !IDENT_STOP.has(x)));
}

/** The question says itself that it is not the earlier one. */
export function saysNew(question: string): boolean {
  return SAYS_NEW.test(question);
}

/**
 * The best earlier answered question that matches, or null. `context` is extra text of the asking message
 * (for example the card id line) used only for the card-id match.
 */
export function findAnswered(
  q: { question: string; options: string[]; descriptions?: string[] },
  answered: AnsweredQuestion[],
  now = Date.now(),
  context = "",
): ReaskMatch | null {
  // A marked-new question skips only unmarked earlier answers; a repeat of a marked question still matches.
  const isNew = saysNew(q.question);
  const words = topicWords(q.question, q.options, q.descriptions);
  const ids = identifiers(q.question);
  const cards = cardIds(`${q.question} ${context}`);
  let best: ReaskMatch | null = null;
  for (const e of answered) {
    // An answer given by reply or reaction has no stored text; that question may be asked again (nothing to send back).
    if (now - e.answeredAt > REASK_WINDOW_MS || !e.answer.length) continue;
    // Asking back or putting it off leaves the question open (card noreask-clarify).
    if (isOpenAnswer(e.answer)) continue;
    if (isNew && !saysNew(e.question)) continue;
    const earlierIds = identifiers([e.question, ...e.options, ...(e.descriptions ?? [])].join(" "));
    // Only within one subject area: both name identifiers, share one, and the new one adds another (GHI next to DEF/ABC).
    if ([...ids].some((x) => earlierIds.has(x)) && [...ids].some((x) => !earlierIds.has(x))) continue;
    const { score, shared } = similarity(words, topicWords(e.question, e.options, e.descriptions));
    const sameCard = [...cardIds(e.question)].some((c) => cards.has(c));
    const intent = similarity(topicWords(q.question), topicWords(e.question));
    const opt = similarity(topicWords("", q.options, q.descriptions), topicWords("", e.options, e.descriptions));
    const qLabels = topicWords("", q.options), eLabels = topicWords("", e.options);
    const label = similarity(qLabels, eLabels);
    const labelsOk = (!qLabels.size && !eLabels.size) || label.shared >= REASK_MIN_LABEL_SHARED || (label.shared >= 2 && label.score >= REASK_MIN_LABEL_SCORE);
    const ok = labelsOk && shared >= REASK_MIN_SHARED && opt.shared >= REASK_MIN_OPTION_SHARED && opt.score >= REASK_MIN_OPTION_SCORE &&
      intent.shared >= REASK_MIN_QUESTION_SHARED && (intent.score >= REASK_MIN_QUESTION_SCORE || sameCard) &&
      (score >= REASK_MIN_SCORE || (sameCard && score >= REASK_CARD_SCORE));
    if (ok && (!best || score > best.score)) best = { earlier: e, score };
  }
  return best;
}

/** The earlier answer as text for the asking session and the FIRSTMATE line. */
export function answerLabel(e: AnsweredQuestion): string {
  return e.answer.length ? e.answer.join(", ") : "answered by reply (see the menu)";
}
