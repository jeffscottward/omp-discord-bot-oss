/**
 * Owner 2026-10-15: talk to FIRSTMATE from the iPhone home screen (iOS Shortcut: Siri, widget, Action Button)
 * without opening Discord. A separate loopback server that only `tailscale serve` exposes, tailnet-only, at
 * https://<main>.ts.net/firstmate. Every prompt needs the secret key (Bearer); it then runs exactly like an owner
 * message in #main-github-firstmate (a visible "📱 from Shortcut" note is posted first, the answer arrives in Discord).
 *
 * This is a second way to send prompts with owner authority, so it is narrow on purpose:
 * one route, one channel, key compared in constant time, size and rate limits, lockout after bad keys,
 * and a one-time setup page that shows the key once.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SHORTCUT_PORT = Number(process.env.OMP_BOT_SHORTCUT_PORT ?? 47823);
export const KEY_FILE = join(homedir(), ".config", "omp-discord", "shortcut-key");
/** One-time setup nonce; deleted after the setup page is shown once (or after 12 h). */
/** Tailnet login allowed to use the endpoint (tailscale serve sends it as Tailscale-User-Login). */
export const LOGIN_FILE = join(homedir(), ".config", "omp-discord", "shortcut-login");
export const SETUP_FILE = join(homedir(), ".config", "omp-discord", "shortcut-setup");
const MAX_TEXT = 4000;
/** Owner 2026-10-15: voice notes from the Shortcut (Record Audio, .m4a), transcribed locally like Discord voice messages. */
const MAX_AUDIO = 25 * 1024 * 1024;
export const isAudioType = (ct: string) => /^(audio\/|video\/mp4|application\/octet-stream)/.test(ct);
const SETUP_TTL_MS = 12 * 60 * 60_000;

export function readKey(file = KEY_FILE): string | null {
  try {
    const k = readFileSync(file, "utf8").trim();
    return k.length >= 32 ? k : null;
  } catch {
    return null;
  }
}

/** Create the key (and a fresh setup nonce). Returns the setup nonce, never the key. */
export function rotateKey(file = KEY_FILE, setupFile = SETUP_FILE): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  chmodSync(file, 0o600);
  const nonce = randomBytes(18).toString("base64url");
  writeFileSync(setupFile, JSON.stringify({ nonce, at: Date.now() }), { mode: 0o600 });
  return nonce;
}

export function keyMatches(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Text from the Shortcut: JSON {"text": …} or a plain-text body. */
export function promptText(contentType: string, raw: string): string {
  let t = raw;
  if (contentType.startsWith("application/json")) {
    try {
      const j = JSON.parse(raw) as { text?: unknown };
      t = typeof j.text === "string" ? j.text : "";
    } catch {
      t = "";
    }
  }
  return t.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
}

/** Sliding-window limiter plus lockout after repeated bad keys. Pure state, injectable clock. */
export class Guard {
  private hits: number[] = [];
  private bad: number[] = [];
  private lockedUntil = 0;
  constructor(private perMin = 12, private badMax = 5, private lockMs = 15 * 60_000) {}
  locked(now = Date.now()): boolean {
    return now < this.lockedUntil;
  }
  badKey(now = Date.now()): void {
    this.bad = [...this.bad.filter((t) => now - t < 10 * 60_000), now];
    if (this.bad.length >= this.badMax) {
      this.lockedUntil = now + this.lockMs;
      this.bad = [];
    }
  }
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < 60_000);
    if (this.hits.length >= this.perMin) return false;
    this.hits.push(now);
    return true;
  }
}

export interface ShortcutDeps {
  /** Post the visible note and start the run; resolves once queued. */
  submit: (text: string, via: string, voice?: boolean) => Promise<{ position: number }>;
  /** Transcribe a local audio file (caller deletes it). Returns "" when nothing was heard. */
  transcribe?: (file: string) => Promise<string>;
  log: (s: string) => void;
}

const SETUP_PAGE = (key: string, base: string) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>FIRSTMATE Shortcut setup</title>
<style>body{font:17px -apple-system,system-ui;margin:20px;max-width:640px;background:#111;color:#eee}code,textarea{font:14px ui-monospace,monospace}
textarea{width:100%;height:5em;background:#222;color:#eee;border:1px solid #555;border-radius:8px;padding:8px}button{font-size:17px;padding:10px 16px;border-radius:8px;margin:8px 0}
li{margin:6px 0}.w{color:#fc6}</style>
<h2>📱 FIRSTMATE Shortcut</h2>
<p class=w>⚠️ This page works once. Copy the key now. Anyone with it can command the main host from your tailnet.</p>
<p><b>Key</b></p><textarea id=k readonly>${key}</textarea>
<button onclick="k.select();document.execCommand('copy');this.textContent='Copied ✓'">Copy key</button>
<h3>Build the Shortcut (Shortcuts app → +)</h3>
<ol>
<li><b>Dictate Text</b> (or <b>Ask for Input</b> → Text). Optional: Stop Listening <i>After Pause</i>.</li>
<li><b>Get Contents of URL</b>: URL <code>${base}/firstmate</code><br>Method <b>POST</b>, Request Body <b>JSON</b>: key <code>text</code> = the dictated text<br>
Headers: <code>Authorization</code> = <code>Bearer </code> + the key (one space after Bearer).</li>
<li><b>Get Dictionary Value</b> <code>message</code> from Contents of URL, then <b>Show Notification</b> with it.</li>
<li>Name it <b>Firstmate</b>. Then: Add to Home Screen, add a Shortcuts widget, set the Action Button, or say "Hey Siri, Firstmate".</li>
</ol>
<h3>🎙️ Voice instead of dictation (better transcription)</h3>
<p>Replace step 1 with <b>Record Audio</b> (Audio Quality Normal, Start Recording <i>Immediately</i>, Finish Recording <i>On Tap</i>).
In step 2 set Request Body to <b>File</b> and pick the <i>Recorded Audio</i>. The main host transcribes it like a Discord voice message.</p>
<p>Tailscale must be on (the URL is tailnet-only). The answer arrives in Discord #main-github-firstmate.</p>`;

export function startShortcutServer(deps: ShortcutDeps, port = SHORTCUT_PORT, keyFile = KEY_FILE, setupFile = SETUP_FILE, loginFile = LOGIN_FILE) {
  const guard = new Guard();
  let allowed = "";
  try {
    allowed = readFileSync(loginFile, "utf8").trim();
  } catch {}
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      // tailscale serve forwards the tailnet user; plain loopback callers have no such header.
      const who = req.headers.get("tailscale-user-login") ?? "loopback";
      // Only the owner's tailnet login gets this far, so another device on the tailnet cannot trigger the
      // bad-key lockout and shut the owner out (reviewer 2026-10-15). Checked before the key and the guard.
      // Fail closed: with no login file, only plain loopback callers (no tailnet header) are accepted.
      if (allowed ? who !== allowed : who !== "loopback") {
        deps.log(`shortcut: refused tailnet user ${who}`);
        return (deps.log(`shortcut: rejected "Not allowed." from ${who}`), Response.json({ ok: false, message: "Not allowed." }, { status: 403 }));
      }
      if (guard.locked()) return (deps.log(`shortcut: rejected "Locked for 15 min after bad keys." from ${who}`), Response.json({ ok: false, message: "Locked for 15 min after bad keys." }, { status: 429 }));

      const setup = url.pathname.match(/^\/firstmate\/setup\/([\w-]{16,64})$/);
      if (req.method === "GET" && setup) {
        let s: { nonce?: string; at?: number } = {};
        try {
          s = JSON.parse(readFileSync(setupFile, "utf8"));
        } catch {}
        const key = readKey(keyFile);
        if (!key || !s.nonce || !keyMatches(setup[1]!, s.nonce) || Date.now() - (s.at ?? 0) > SETUP_TTL_MS) {
          guard.badKey();
          return new Response("This setup link has expired or was already used.", { status: 404 });
        }
        writeFileSync(setupFile, "{}", { mode: 0o600 }); // one view only
        deps.log(`shortcut: setup page shown to ${who}`);
        const base = `https://${req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "the-main"}`;
        return new Response(SETUP_PAGE(key, base), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }

      if (req.method !== "POST" || url.pathname !== "/firstmate") return (deps.log(`shortcut: rejected "not found" from ${who}`), Response.json({ ok: false, message: "not found" }, { status: 404 }));
      const key = readKey(keyFile);
      const auth = req.headers.get("authorization") ?? "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!key || !given || !keyMatches(given, key)) {
        guard.badKey();
        deps.log(`shortcut: bad key from ${who}`);
        return (deps.log(`shortcut: rejected "Bad key." from ${who}`), Response.json({ ok: false, message: "Bad key." }, { status: 401 }));
      }
      if (!guard.allow()) return (deps.log(`shortcut: rejected "Too many prompts; wait a minute." from ${who}`), Response.json({ ok: false, message: "Too many prompts; wait a minute." }, { status: 429 }));
      const ct = (req.headers.get("content-type") ?? "").toLowerCase();
      let text: string;
      const voice = isAudioType(ct);
      if (voice) {
        if (!deps.transcribe) return (deps.log(`shortcut: rejected "Voice is not enabled." from ${who}`), Response.json({ ok: false, message: "Voice is not enabled." }, { status: 415 }));
        const buf = Buffer.from(await req.arrayBuffer());
        if (buf.length > MAX_AUDIO) return (deps.log(`shortcut: rejected "Recording too long." from ${who}`), Response.json({ ok: false, message: "Recording too long." }, { status: 413 }));
        if (buf.length < 1000) return (deps.log(`shortcut: rejected "Empty recording." from ${who}`), Response.json({ ok: false, message: "Empty recording." }, { status: 400 }));
        const dir = mkdtempSync(join(tmpdir(), "shortcut-"));
        try {
          const file = join(dir, "voice");
          writeFileSync(file, buf, { mode: 0o600 });
          text = (await deps.transcribe(file)).trim().slice(0, MAX_TEXT);
        } catch (e) {
          deps.log(`shortcut: transcription failed: ${(e as Error).message}`);
          return (deps.log(`shortcut: rejected "Couldn't transcribe that. Try again." from ${who}`), Response.json({ ok: false, message: "Couldn't transcribe that. Try again." }, { status: 502 }));
        } finally {
          rmSync(dir, { recursive: true, force: true }); // no audio is kept
        }
        if (!text) return (deps.log(`shortcut: rejected "I didn't hear anything." from ${who}`), Response.json({ ok: false, message: "I didn't hear anything." }, { status: 400 }));
      } else {
        const raw = await req.text();
        if (raw.length > 64 * 1024) return (deps.log(`shortcut: rejected "Too long." from ${who}`), Response.json({ ok: false, message: "Too long." }, { status: 413 }));
        text = promptText(ct, raw);
        if (!text) return (deps.log(`shortcut: rejected "Empty prompt." from ${who}`), Response.json({ ok: false, message: "Empty prompt." }, { status: 400 }));
      }
      try {
        const { position } = await deps.submit(text, who, voice);
        deps.log(`shortcut: ${voice ? "voice" : "prompt"} from ${who} (${text.length} chars), position ${position}`);
        const heard = voice ? ` Heard: “${text.length > 120 ? `${text.slice(0, 119)}…` : text}”` : "";
        const message = `${position > 1 ? `📨 Sent to FIRSTMATE (#${position} in line).` : "📨 Sent to FIRSTMATE."}${heard}`;
        return Response.json({ ok: true, message });
      } catch (e) {
        deps.log(`shortcut: submit failed: ${(e as Error).message}`);
        return (deps.log(`shortcut: rejected "The bot could not take it (Discord not ready?). Try again." from ${who}`), Response.json({ ok: false, message: "The bot could not take it (Discord not ready?). Try again." }, { status: 503 }));
      }
    },
  });
}

export const shortcutConfigured = (file = KEY_FILE) => existsSync(file) && readKey(file) !== null;
