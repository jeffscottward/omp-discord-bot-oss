/**
 * Owner 2026-10-30 (card discord-stack-route-existing): a message routed to a stack first goes to an OPEN job of
 * that stack when it is a follow-up to it. Open job = FIRSTMATE card with this stack, status running/partial/
 * waiting, and a `job` that maps to a mirrored pane channel. Match: card id named in the text, clear title
 * keyword overlap, or the JEV judge. Unsure: one menu (existing job / new job). No match: a new side job (old path).
 */
import type { FmCard } from "./masterqueue.ts";
import { FINANCIAL_RE } from "./router.ts";
import { redact } from "./redact.ts";
import { isFinanceCard } from "./needsyou.ts";

/** `title`: safe for Discord and the judge (finance cards show only the id); `words`: local keyword text. */
export type OpenJob = { id: string; title: string; channelId: string; words?: string; finance?: boolean };
export type JobMatch = { kind: "match"; job: OpenJob; by: string } | { kind: "unsure"; job: OpenJob; by: string } | { kind: "none"; by: string };
/** Judge: pick a job id or "new". Null = no answer. */
export type JobJudge = (text: string, jobs: OpenJob[]) => Promise<{ choice: string; confidence: number } | null>;

const OPEN = new Set(["running", "partial", "waiting"]);
const STOP = new Set(
  "the and for with from into that this then than what when where which while your have will would should could about after before again also just only more most some such them they their there these those test tests fix fixes add make made new old job jobs card cards stack owner please check done work".split(" "),
);

/** Open cards of one stack whose job resolves to a channel (`channelFor` maps one job token to a channel id). */
export function openJobs(cards: FmCard[], stack: string, channelFor: (token: string) => string | undefined): OpenJob[] {
  const out: OpenJob[] = [];
  for (const c of cards) {
    if ((c.stack ?? "").toLowerCase() !== stack.toLowerCase() || !OPEN.has(c.s ?? "")) continue;
    const tokens = (Array.isArray(c.job) ? c.job : String(c.job ?? "").split(",")).map((x) => x.trim()).filter(Boolean);
    const ch = tokens.map(channelFor).find(Boolean);
    if (!ch) continue;
    const finance = isFinanceCard(c);
    out.push({ id: c.id, title: finance ? `Finance card: ${c.id}` : (c.t ?? c.id), channelId: ch, words: c.t ?? c.id, finance });
  }
  return out;
}

export function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).flatMap((w) => [w, ...w.split("-")]).filter((w) => w.length >= 3 && !STOP.has(w)));
}

/** Title + id words shared with the message, best first. */
export function overlapScores(text: string, jobs: OpenJob[], ignore: string[] = []): { job: OpenJob; score: number }[] {
  const skip = words(ignore.join(" "));
  const m = new Set([...words(text)].filter((w) => !skip.has(w)));
  return jobs
    .map((job) => ({ job, score: [...words(`${job.words ?? job.title} ${job.id}`)].filter((w) => m.has(w)).length }))
    .sort((a, b) => b.score - a.score);
}

/** Judge: never for financial text or finance jobs (no financial data to JEV); at most `timeoutMs`. */
export async function matchJob(text: string, jobs: OpenJob[], judge?: JobJudge, minConfidence = 0.8, timeoutMs = 4000, ignore: string[] = []): Promise<JobMatch> {
  if (!jobs.length) return { kind: "none", by: "no open job" };
  const lower = text.toLowerCase();
  const named = jobs.filter((j) => new RegExp(`(^|[^a-z0-9-])${j.id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9-])`).test(lower));
  if (named.length === 1) return { kind: "match", job: named[0]!, by: "card id" };
  const sc = overlapScores(text, jobs, ignore); // stack name/keywords are in most titles: no evidence
  const top = sc[0]!;
  const second = sc[1]?.score ?? 0;
  if (top.score >= 3 && top.score - second >= 2) return { kind: "match", job: top.job, by: `keywords ${top.score}` };
  if (judge && !FINANCIAL_RE.test(text) && !jobs.some((x) => x.finance)) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const j = await Promise.race([judge(text, jobs), new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))]).finally(() => clearTimeout(timer));
      const hit = j && jobs.find((x) => x.id === j.choice);
      if (j && hit && j.confidence >= minConfidence) return { kind: "match", job: hit, by: `judge ${j.confidence.toFixed(2)}` };
      if (j && j.choice === "new" && j.confidence >= minConfidence && top.score < 2) return { kind: "none", by: `judge new ${j.confidence.toFixed(2)}` };
      if (hit) return { kind: "unsure", job: hit, by: `judge ${j!.confidence.toFixed(2)}` };
    } catch {
      /* deterministic result below */
    }
  }
  if (top.score >= 2) return { kind: "unsure", job: top.job, by: `keywords ${top.score}` };
  return { kind: "none", by: "no overlap" };
}

/** JEV decisions judge for jobs (same API and key handling as the stack judge in src/router.ts). */
export function jevJobJudge(opts: { keyFn: () => Promise<string>; endpoint?: string; model?: string; fetchFn?: typeof fetch }): JobJudge {
  const endpoint = opts.endpoint ?? "https://openrouter.ai/api/alpha/decisions";
  const f = opts.fetchFn ?? fetch;
  let cached: { key: string; at: number } | null = null;
  return async (text, jobs) => {
    if (!cached || Date.now() - cached.at > 10 * 60_000) cached = { key: await opts.keyFn(), at: Date.now() };
    const criteria: Record<string, string> = Object.fromEntries(jobs.map((j) => [j.id, `Follow-up to the open job: ${redact(j.title).text}`]));
    criteria.new = "A new, separate request (no open job covers it)";
    const body = {
      model: opts.model ?? "~typesafe/jev-latest",
      state: { task: "Decide if an owner message continues one open job or is a new request.", message: redact(text).text.slice(0, 1500) },
      questions: { job: { type: "choice", criteria, instructions: { goal: "Pick the open job this message continues, or new.", rules: ["Pick new unless the message clearly refers to that job's topic."] } } },
    };
    const res = await f(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cached.key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    if (res.status === 401 || res.status === 403) cached = null;
    if (!res.ok) throw new Error(`decisions HTTP ${res.status}`);
    const a = ((await res.json()) as { answers?: { job?: { choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> } } }).answers?.job;
    const choice = typeof a?.choice === "string" ? a.choice : null;
    if (!choice) return null;
    const p = a?.probabilities?.[choice];
    return { choice, confidence: typeof a?.confidence === "number" ? a.confidence : typeof p === "number" ? p : 0 };
  };
}

export const JOBROUTE_PREFIX = "jobroute:";

/** Only the owner may answer the menu, and only on the bot's own menu message. */
export function jobRouteClickAllowed(userId: string, ownerId: string, messageAuthorId: string, botId: string | undefined): boolean {
  return Boolean(botId) && userId === ownerId && messageAuthorId === botId;
}
