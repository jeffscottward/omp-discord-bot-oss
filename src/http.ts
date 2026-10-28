import { extractAsk, OPTION_FORMAT_HINT } from "./ask.ts";
import { checkPostFiles } from "./attach.ts";
import { ALERT_CHANNELS, CHANNELS, HTTP_HOST, HTTP_PORT } from "./config.ts";
import { parseIncident, type Incident } from "./triage.ts";

/** What /post returns (owner 2026-10-23, Discord UX item 1): agents need ids/links without the bot token. */
export interface PostResult {
  /** First message posted (the one to link). */
  id: string;
  url: string;
  messages: { id: string; url: string }[];
  attachments: { name: string; url: string }[];
  /** Menu messages of an ask block, one per question. */
  asks?: { setId: string; questions: { id: string; question: string; url: string }[] }[];
}

/** One message for GET /messages (text redacted; no embeds, no attachment URLs with tokens beyond Discord's own). */
export interface MessageView {
  id: string;
  url: string;
  ts: string;
  author: string;
  bot: boolean;
  content: string;
  attachments: string[];
  /** True when the message carries buttons (menus, Stop …). */
  buttons: boolean;
  replyTo?: string;
}

/** One open ask set for GET /asks. */
export interface AskView {
  setId: string;
  channelId: string;
  createdAt: number;
  questions: { id: string; question: string; answered: boolean; url: string | null }[];
}

export interface HttpDeps {
  /** `copy`: owner 2026-10-19 copy-ready message: the exact text only (no dashboard link, buttons or files). */
  post: (channelId: string, text: string, files?: { path: string; name: string }[], opts?: { copy?: boolean; replyTo?: string }) => Promise<PostResult | void>;
  health: () => unknown;
  /** Extra channels (mirrored Herdr tab channels): name/id → id, or null. */
  resolveExtra?: (ref: string) => { id: string; name: string } | null;
  /** P1 drain: `on` false ends it; `ttlMs` is how long it lasts unless renewed. */
  drain?: (on: boolean, ttlMs?: number) => { draining: boolean; since: number; until: number };
  /** P12: start a triage run for an incident (contract with harness-watch: {ok, started, reason?}). */
  incident?: (i: Incident) => Promise<{ started: boolean; reason?: string }>;
  /** GET /messages: newest first, redacted. `channelId` is resolved, or a raw id (thread) the dep must check. */
  messages?: (channelId: string, limit: number, before?: string) => Promise<MessageView[] | null>;
  /** GET /asks: open menu sets. */
  asks?: (channelId?: string) => AskView[];
  /** POST /asks/close (card sweep): close open sets by id; returns the ids closed. */
  closeAsks?: (setIds: string[], reason: string) => string[];
  /** Owner 2026-10-23 (item 2): POST /secret-drop creates a one-time tailnet form and posts its button. */
  secretDrop?: (o: { name: string; dest: string; overwrite: boolean; ttlMs?: number; channelId?: string }) => Promise<{ id: string; url: string; expiresAt: number; message?: string } | { error: string }>;
  /**
   * Owner alert pause (src/alertpause.ts): returns the pause end when this post was held instead of sent, else null.
   * `urgent` posts (sign-in/password waits) are never held.
   */
  holdAlert?: (channelId: string, text: string) => { until: number } | null;
  /** GET /secret-drop/<id>: state only (never the value). */
  secretDropStatus?: (id: string) => unknown | null;
}

export const MAX_MESSAGES = 50;

/** Longest drain one request may ask for (the waiter renews a short drain every 10 s). */
export const MAX_DRAIN_TTL_MS = 30 * 60_000;

/** Read a JSON body (size and content-type checked). Returns the parsed body or an error response. */
async function readJson(req: Request): Promise<{ body: unknown } | Response> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json"))
    return Response.json({ error: "content-type must be application/json" }, { status: 415 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
}

const MAX_BODY = 64 * 1024;

/** Resolve "dev" / "#dev" / a mapped channel id to a channel id. */
export function resolveChannel(ref: string): string | null {
  const r = ref.trim().replace(/^#/, "");
  if (CHANNELS[r] || ALERT_CHANNELS[r]) return r;
  const hit = [...Object.entries(CHANNELS), ...Object.entries(ALERT_CHANNELS)].find(([, c]) => c.name === r);
  return hit ? hit[0] : null;
}

/**
 * Local-only guard: loopback Host header (blocks DNS rebinding), no browser Origin
 * (blocks cross-site requests), JSON content type (forces a CORS preflight we never answer).
 */
export function checkLocalRequest(req: Request, port = HTTP_PORT): string | null {
  const host = req.headers.get("host") ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return "bad host";
  if (req.headers.get("origin")) return "browser origin not allowed";
  return null;
}

export function startHttp(deps: HttpDeps, port = HTTP_PORT) {
  return Bun.serve({
    hostname: HTTP_HOST,
    port,
    async fetch(req, server) {
      // Port 0 = OS-assigned (tests): check the Host header against the port actually bound.
      const bad = checkLocalRequest(req, server.port ?? port);
      if (bad) return Response.json({ error: bad }, { status: 403 });
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") return Response.json(deps.health());
      if (req.method === "POST" && url.pathname === "/drain" && deps.drain) {
        const r = await readJson(req);
        if (r instanceof Response) return r;
        const b = r.body as { on?: unknown; ttlSec?: unknown } | null;
        if (!b || typeof b !== "object" || typeof b.on !== "boolean") return Response.json({ error: "expected {on: boolean, ttlSec?: number}" }, { status: 400 });
        if (b.ttlSec !== undefined && (typeof b.ttlSec !== "number" || !(b.ttlSec > 0)))
          return Response.json({ error: "ttlSec must be a positive number" }, { status: 400 });
        const ttlMs = typeof b.ttlSec === "number" ? Math.min(b.ttlSec * 1000, MAX_DRAIN_TTL_MS) : undefined;
        return Response.json({ ok: true, ...deps.drain(b.on, ttlMs) });
      }
      if (req.method === "POST" && url.pathname === "/incident" && deps.incident) {
        const r = await readJson(req);
        if (r instanceof Response) return r;
        const i = parseIncident(r.body);
        if ("error" in i) return Response.json({ ok: false, error: i.error }, { status: 400 });
        try {
          const res = await deps.incident(i);
          return Response.json({ ok: true, started: res.started, ...(res.reason ? { reason: res.reason } : {}) });
        } catch (e) {
          return Response.json({ ok: true, started: false, reason: `start failed: ${(e as Error).message}` });
        }
      }
      if (req.method === "GET" && url.pathname === "/messages" && deps.messages) {
        const ref = url.searchParams.get("channel") ?? "";
        if (!ref.trim()) return Response.json({ error: "expected ?channel=<name or id>&limit=<1-50>" }, { status: 400 });
        const lim = Number(url.searchParams.get("limit") ?? 20);
        if (!Number.isInteger(lim) || lim < 1) return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
        const before = url.searchParams.get("before") ?? undefined;
        if (before !== undefined && !/^\d{17,20}$/.test(before)) return Response.json({ error: "before must be a message id" }, { status: 400 });
        const id = resolveAny(ref, deps);
        if (!id) return Response.json({ error: "unknown channel" }, { status: 400 });
        try {
          const msgs = await deps.messages(id.id, Math.min(lim, MAX_MESSAGES), before);
          if (!msgs) return Response.json({ error: "unknown channel" }, { status: 400 });
          return Response.json({ ok: true, channel: id.id, messages: msgs });
        } catch (e) {
          return Response.json({ error: `read failed: ${(e as Error).message}` }, { status: 502 });
        }
      }
      if (req.method === "GET" && url.pathname === "/asks" && deps.asks) {
        const ref = url.searchParams.get("channel");
        const id = ref ? resolveAny(ref, deps) : null;
        if (ref && !id) return Response.json({ error: "unknown channel" }, { status: 400 });
        return Response.json({ ok: true, asks: deps.asks(id?.id) });
      }
      if (req.method === "POST" && url.pathname === "/asks/close" && deps.closeAsks) {
        const r = await readJson(req);
        if (r instanceof Response) return r;
        const b = r.body as { setIds?: unknown; reason?: unknown } | null;
        if (!b || !Array.isArray(b.setIds) || !b.setIds.every((x) => typeof x === "string" && /^[a-z0-9]{1,24}$/.test(x)))
          return Response.json({ error: "expected {setIds: string[], reason?: string}" }, { status: 400 });
        return Response.json({ ok: true, closed: deps.closeAsks(b.setIds as string[], typeof b.reason === "string" ? b.reason.slice(0, 80) : "closed") });
      }
      if (req.method === "POST" && url.pathname === "/secret-drop" && deps.secretDrop) {
        const r = await readJson(req);
        if (r instanceof Response) return r;
        const b = r.body as { name?: unknown; dest?: unknown; overwrite?: unknown; ttlMin?: unknown; channel?: unknown } | null;
        if (!b || typeof b.name !== "string" || typeof b.dest !== "string") return Response.json({ error: "expected {name, dest, channel?, overwrite?, ttlMin?}" }, { status: 400 });
        if (b.overwrite !== undefined && typeof b.overwrite !== "boolean") return Response.json({ error: "overwrite must be a boolean" }, { status: 400 });
        if (b.ttlMin !== undefined && (typeof b.ttlMin !== "number" || !(b.ttlMin > 0))) return Response.json({ error: "ttlMin must be a positive number" }, { status: 400 });
        const ch = typeof b.channel === "string" ? resolveAny(b.channel, deps) : null; // default: FIRSTMATE (the dep)
        if (typeof b.channel === "string" && !ch) return Response.json({ error: "unknown channel" }, { status: 400 });
        const res = await deps.secretDrop({ name: b.name, dest: b.dest, overwrite: b.overwrite === true, ttlMs: typeof b.ttlMin === "number" ? b.ttlMin * 60_000 : undefined, ...(ch ? { channelId: ch.id } : {}) }).catch((e: Error) => ({ error: `post failed: ${e.message}` }));
        return "error" in res ? Response.json(res, { status: 400 }) : Response.json({ ok: true, ...res });
      }
      const sd = url.pathname.match(/^\/secret-drop\/([\w-]{20,64})$/);
      if (req.method === "GET" && sd && deps.secretDropStatus) {
        const st = deps.secretDropStatus(sd[1]!);
        return st ? Response.json({ ok: true, ...(st as object) }) : Response.json({ error: "unknown drop" }, { status: 404 });
      }
      if (req.method !== "POST" || url.pathname !== "/post") return Response.json({ error: "not found" }, { status: 404 });
      const parsed = await readJson(req);
      if (parsed instanceof Response) return parsed;
      const body = parsed.body;
      if (!body || typeof body !== "object" || !("channel" in body) || !("text" in body))
        return Response.json({ error: "expected {channel, text}" }, { status: 400 });
      const { channel, text } = body;
      if (typeof channel !== "string" || typeof text !== "string" || !text.trim())
        return Response.json({ error: "channel and text must be non-empty strings" }, { status: 400 });
      const askErr = askBlockError(text);
      if (askErr) return Response.json({ error: askErr }, { status: 400 });
      const checked = checkPostFiles((body as { files?: unknown }).files);
      if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
      const channelId = resolveChannel(channel);
      const extra = channelId ? null : (deps.resolveExtra?.(channel.trim().replace(/^#/, "")) ?? null);
      if (!channelId && !extra) return Response.json({ error: "unknown channel" }, { status: 400 });
      const id = channelId ?? extra!.id;
      const copy = (body as { copy?: unknown }).copy;
      if (copy !== undefined && typeof copy !== "boolean") return Response.json({ error: "copy must be a boolean" }, { status: 400 });
      if (copy && checked.files.length) return Response.json({ error: "copy messages cannot carry files" }, { status: 400 });
      const replyTo = parseReplyTo((body as { replyTo?: unknown }).replyTo, id);
      if (replyTo && "error" in replyTo) return Response.json({ error: replyTo.error }, { status: 400 });
      if (copy && replyTo) return Response.json({ error: "copy messages cannot reply" }, { status: 400 });
      const urgent = (body as { urgent?: unknown }).urgent;
      if (urgent !== undefined && typeof urgent !== "boolean") return Response.json({ error: "urgent must be a boolean" }, { status: 400 });
      const chName = channelId ? (CHANNELS[channelId] ?? ALERT_CHANNELS[channelId])!.name : extra!.name;
      // Only plain text is held: a post with files, a reply target, a copy message or an ask menu is sent as before
      // (the digest keeps text only, and the caller would not know that the rest was dropped).
      const plain = !checked.files.length && !replyTo && !copy && !/```ask\b/.test(text);
      const held = urgent || !plain ? null : (deps.holdAlert?.(id, text) ?? null);
      if (held) return Response.json({ ok: true, channel: chName, held: true, until: held.until });
      let res: PostResult | void;
      try {
        res = await deps.post(id, text, checked.files, copy ? { copy: true } : replyTo ? { replyTo: replyTo.id } : undefined);
      } catch (e) {
        return Response.json({ error: `post failed: ${(e as Error).message}` }, { status: 502 });
      }
      return Response.json({ ok: true, channel: chName, ...(res ?? {}) });
    },
  });
}

/**
 * `replyTo` of /post (owner 2026-10-23): a message id or a Discord message link in the same channel, so the post
 * and its menus show which request they answer. Undefined when absent.
 */
export function parseReplyTo(v: unknown, channelId: string): { id: string } | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "replyTo must be a message id or a Discord message link" };
  const s = v.trim();
  if (/^\d{17,20}$/.test(s)) return { id: s };
  const m = s.match(/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d+\/(\d{17,20})\/(\d{17,20})$/);
  if (!m) return { error: "replyTo must be a message id or a Discord message link" };
  if (m[1] !== channelId) return { error: "replyTo must be a message in the same channel" };
  return { id: m[2]! };
}

/** A configured, alert or mirrored channel by name/id, or a raw snowflake (a thread; the dep checks its parent). */
function resolveAny(ref: string, deps: HttpDeps): { id: string } | null {
  const r = ref.trim().replace(/^#/, "");
  const id = resolveChannel(r) ?? deps.resolveExtra?.(r)?.id ?? (/^\d{17,20}$/.test(r) ? r : null);
  return id ? { id } : null;
}

/**
 * Owner 2026-10-23: a /post whose ask block cannot become a menu is refused with the reason, so the
 * sender learns about it (a side session once reported "ask posted" for raw JSON with no menu).
 */
/** A plain-text question to the owner: a "Choose"/"Pick"/✍️ line followed by 2+ numbered options, without an ask block. */
export function looksLikeTextMenu(text: string): boolean {
  if (/```ask\b/.test(text)) return false;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /(✍️|\bchoose\b|\bpick\b|which (?:one|option)|reply with (?:a )?number)/i.test(l));
  if (i < 0) return false;
  const opts = lines.slice(i + 1).filter((l) => /^\s*(?:\d+[.)]|[1-9]\uFE0F?\u20E3)\s+\S/.test(l));
  return opts.length >= 2;
}
export function askBlockError(text: string): string | null {
  if (looksLikeTextMenu(text))
    return "owner questions need buttons: post them as a fenced ```ask JSON block (options = plain strings or {label, description}, last option \"✏️ Other (type or dictate a reply)\"), not as a numbered list";
  if (!/```ask\b/.test(text)) return null;
  const a = extractAsk(text);
  if (a.error) return `ask block rejected: ${a.error.includes(OPTION_FORMAT_HINT) ? a.error : `${a.error}. ${OPTION_FORMAT_HINT}`}`;
  if (!a.questions) return "ask block not recognised: the ```ask fence and the closing ``` must each start a line.";
  if (/```ask\b/.test(a.text)) return "only one ask block per message";
  return null;
}
