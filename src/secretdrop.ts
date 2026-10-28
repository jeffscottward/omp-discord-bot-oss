/**
 * Owner 2026-10-23 (Discord UX item 2): a safe way to hand over a token from the phone. Pasting into a Herdr pane
 * through Heeler failed several times, and once a key was pasted into a Discord message.
 *
 * An agent asks the bot (loopback POST /secret-drop) for a one-time form. The bot posts a button with the link.
 * The form is served only on the tailnet (`tailscale serve` path /secret-drop on the tailnet-only HTTPS port, never
 * the Funnel port and never the Cloudflare share mirror). The owner pastes the value; the server writes it straight
 * to the destination file with mode 0600 and answers "Received, N characters". The value is never logged, never
 * posted to Discord, never stored elsewhere and never reaches a model. Each link works once and expires (15 min).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export const SECRET_DROP_PORT = Number(process.env.OMP_BOT_SECRET_DROP_PORT ?? 47824);
export const SECRET_DROP_PATH = "/secret-drop";
export const DEFAULT_TTL_MS = 15 * 60_000;
export const MAX_TTL_MS = 60 * 60_000;
export const MAX_VALUE = 16 * 1024;
const MAX_OPEN = 20;

export interface Drop {
  id: string;
  name: string;
  dest: string;
  overwrite: boolean;
  createdAt: number;
  expiresAt: number;
  /** "failed": the write failed; the link is used up and the agent must ask again. */
  state: "waiting" | "received" | "expired" | "failed";
  chars?: number;
  receivedAt?: number;
  /** Channel to tell when the value arrived (no value, only the length). */
  channelId?: string;
}

/** Status view (no secret, ever). */
export type DropStatus = Pick<Drop, "id" | "name" | "dest" | "state" | "expiresAt"> & { chars?: number };

/** Folders a drop may write into (under $HOME). Code-running config folders are excluded. */
const ALLOWED = [".config", ".local/state", ".local/share", ".secrets"];
const DENIED = [".config/systemd", ".config/autostart", ".config/environment.d", ".config/hypr", ".config/omarchy", ".config/omp-discord", ".local/share/applications", ".local/share/systemd", ".ssh", ".gnupg"];

/** Why `dest` may not receive a drop (null: allowed). */
export function destDenied(dest: string, home = homedir()): string | null {
  if (!isAbsolute(dest)) return "dest must be an absolute path";
  const p = normalize(dest);
  if (p !== dest.replace(/\/+$/, "") || dest.includes("/../") || dest.endsWith("/..")) return "dest must be a normalized path";
  const rel = p.startsWith(home + sep) ? p.slice(home.length + 1) : null;
  if (rel === null) return `dest must be under ${home}`;
  if (!ALLOWED.some((a) => rel.startsWith(a + "/"))) return `dest must be under ~/${ALLOWED.join(", ~/")}`;
  if (DENIED.some((d) => rel === d || rel.startsWith(d + "/"))) return "dest is in a protected folder";
  // Every existing part of the path must be a real directory (no symlink can lead the write elsewhere).
  let cur = home;
  for (const part of rel.split("/").slice(0, -1)) {
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return `${cur} is not a plain directory`;
    } catch {
      break; // missing: created 0700 on write
    }
  }
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return "dest is a symlink";
    if (!st.isFile()) return "dest exists and is not a regular file";
  } catch {}
  return null;
}

/** Write `value` to `dest` with mode 0600 (tmp file O_EXCL + fsync + rename). */
export function writeSecretFile(dest: string, value: string, overwrite: boolean): void {
  let exists = false;
  try {
    lstatSync(dest);
    exists = true;
  } catch {}
  if (exists && !overwrite) throw new Error("dest exists (overwrite not allowed)");
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(dest), `.${randomBytes(6).toString("hex")}.secret-drop.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, value.endsWith("\n") ? value : `${value}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export class SecretDrops {
  private drops = new Map<string, Drop>();
  constructor(private home = homedir()) {}

  create(o: { name: string; dest: string; overwrite?: boolean; ttlMs?: number; channelId?: string }, now = Date.now()): Drop | { error: string } {
    this.prune(now);
    const name = o.name.trim();
    if (!/^[\w .:@+-]{1,60}$/.test(name)) return { error: "name: 1-60 letters, digits, space or . _ - : @ +" };
    const bad = destDenied(o.dest, this.home);
    if (bad) return { error: bad };
    if (!o.overwrite) {
      try {
        lstatSync(o.dest);
        return { error: "dest exists; pass overwrite: true to replace it" };
      } catch {}
    }
    if ([...this.drops.values()].filter((d) => d.state === "waiting").length >= MAX_OPEN) return { error: "too many open drops" };
    const ttl = Math.min(Math.max(o.ttlMs ?? DEFAULT_TTL_MS, 60_000), MAX_TTL_MS);
    const d: Drop = { id: randomBytes(24).toString("base64url"), name, dest: o.dest, overwrite: !!o.overwrite, createdAt: now, expiresAt: now + ttl, state: "waiting", ...(o.channelId ? { channelId: o.channelId } : {}) };
    this.drops.set(d.id, d);
    return d;
  }

  /** Constant-time lookup by id. */
  get(id: string, now = Date.now()): Drop | null {
    this.prune(now);
    const given = Buffer.from(id);
    for (const d of this.drops.values()) {
      const b = Buffer.from(d.id);
      if (b.length === given.length && timingSafeEqual(b, given)) return d;
    }
    return null;
  }

  status(id: string, now = Date.now()): DropStatus | null {
    const d = this.get(id, now);
    return d ? { id: d.id, name: d.name, dest: d.dest, state: d.state, expiresAt: d.expiresAt, ...(d.chars !== undefined ? { chars: d.chars } : {}) } : null;
  }

  /** Store the value for a waiting drop. Returns the length written, or an error (no secret in it). */
  receive(id: string, value: string, now = Date.now()): { chars: number; drop: Drop } | { error: string; status: number } {
    const d = this.get(id, now);
    if (!d) return { error: "This link is not valid.", status: 404 };
    if (d.state === "received" || d.state === "failed") return { error: "This link was already used.", status: 410 };
    if (d.state === "expired" || now > d.expiresAt) return { error: "This link has expired.", status: 410 };
    const v = value.replace(/\r\n/g, "\n").trim();
    if (!v) return { error: "The value is empty.", status: 400 };
    if (v.length > MAX_VALUE) return { error: "The value is too long.", status: 413 };
    const bad = destDenied(d.dest, this.home);
    if (bad) return { error: "The destination is no longer allowed.", status: 409 };
    try {
      writeSecretFile(d.dest, v, d.overwrite);
    } catch {
      d.state = "failed"; // one use only; the status tells the agent nothing was saved
      return { error: "Could not save the value. Ask the agent for a new link.", status: 500 };
    }
    d.state = "received";
    d.chars = v.length;
    d.receivedAt = now;
    return { chars: v.length, drop: d };
  }

  private prune(now: number): void {
    for (const [k, d] of this.drops) {
      if (d.state === "waiting" && now > d.expiresAt) d.state = "expired";
      if (now - d.expiresAt > 24 * 60 * 60_000) this.drops.delete(k);
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.45 system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:24px;max-width:520px}h1{font-size:20px}label{display:block;margin:16px 0 6px}textarea{width:100%;box-sizing:border-box;min-height:96px;font:15px ui-monospace,monospace;background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:8px;padding:10px;-webkit-text-security:disc}button{margin-top:14px;font-size:17px;padding:12px 18px;border:0;border-radius:8px;background:#2f7d46;color:#fff;width:100%}.m{color:#aaa;font-size:14px}code{background:#222;padding:1px 4px;border-radius:4px}</style></head><body>${body}</body></html>`;

export function formPage(d: Drop, now = Date.now()): string {
  const mins = Math.max(1, Math.round((d.expiresAt - now) / 60_000));
  return PAGE(
    `Secret drop: ${d.name}`,
    `<h1>🔐 ${esc(d.name)}</h1><p class="m">Paste the value. It is saved to <code>${esc(d.dest.replace(homedir(), "~"))}</code> on the main host (mode 0600). It is not sent to Discord, logs or any AI model. This link works once and expires in ${mins} min.</p><form method="post" autocomplete="off"><label for="v">Value</label><textarea id="v" name="value" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea><button type="submit">Save on the main host</button></form>`,
  );
}

export const messagePage = (title: string, text: string) => PAGE(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);

export interface SecretDropDeps {
  drops: SecretDrops;
  log: (m: string) => void;
  /** Called after a value was saved (name, dest, length only). */
  onReceived?: (d: Drop) => void;
}

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'", "referrer-policy": "no-referrer" };

/**
 * Loopback server that only `tailscale serve` exposes at https://<main>.ts.net/secret-drop/<id> (tailnet-only).
 * With a login file, only that tailnet login is served; without one, only plain loopback callers.
 */
export function startSecretDropServer(deps: SecretDropDeps, port = SECRET_DROP_PORT, loginFile = join(homedir(), ".config", "omp-discord", "shortcut-login")) {
  let allowed = "";
  try {
    allowed = readFileSync(loginFile, "utf8").trim();
  } catch {}
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 64 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      const who = req.headers.get("tailscale-user-login") ?? "loopback";
      if (allowed ? who !== allowed : who !== "loopback") {
        deps.log(`secret-drop: refused ${who === "loopback" ? "loopback caller" : "tailnet user"}`);
        return new Response(messagePage("Not allowed", "This page is only for the owner."), { status: 403, headers: HTML });
      }
      const m = url.pathname.match(/^\/secret-drop\/([\w-]{20,64})$/);
      if (!m) return new Response(messagePage("Not found", "This link is not valid."), { status: 404, headers: HTML });
      const id = m[1]!;
      if (req.method === "GET") {
        const d = deps.drops.get(id);
        if (!d) return new Response(messagePage("Not found", "This link is not valid."), { status: 404, headers: HTML });
        if (d.state === "received" || d.state === "failed") return new Response(messagePage("Already used", "This link was already used. Ask the agent for a new one if needed."), { status: 410, headers: HTML });
        if (d.state === "expired") return new Response(messagePage("Expired", "This link has expired. Ask the agent for a new one."), { status: 410, headers: HTML });
        return new Response(formPage(d), { headers: HTML });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      // A cross-site form post would carry a foreign Origin.
      const origin = req.headers.get("origin");
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
      if (origin && origin !== "null" && new URL(origin).host !== host) return new Response(messagePage("Not allowed", "Cross-site request refused."), { status: 403, headers: HTML });
      let value = "";
      try {
        const ct = req.headers.get("content-type") ?? "";
        if (ct.startsWith("application/x-www-form-urlencoded") || ct.startsWith("multipart/form-data")) value = String((await req.formData()).get("value") ?? "");
        else return new Response(messagePage("Bad request", "Use the form on this page."), { status: 415, headers: HTML });
      } catch {
        return new Response(messagePage("Bad request", "The form could not be read."), { status: 400, headers: HTML });
      }
      const r = deps.drops.receive(id, value);
      value = "";
      if ("error" in r) {
        deps.log(`secret-drop: refused a submit (${r.status})`);
        return new Response(messagePage("Not saved", r.error), { status: r.status, headers: HTML });
      }
      deps.log(`secret-drop: received "${r.drop.name}" (${r.chars} characters) → ${r.drop.dest}`);
      try {
        deps.onReceived?.(r.drop);
      } catch {}
      return new Response(messagePage("Received", `Received, ${r.chars} characters. Saved on the main host. You can close this page.`), { headers: HTML });
    },
    error() {
      return new Response("error", { status: 500 }); // never echo the request
    },
  });
}
