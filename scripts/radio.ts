// 📻 Lofi Radio: a second Discord bot that loops lofi clips in its own voice channel.
// Discord allows one voice connection per bot per server, and the main bot stays in 🎧 OMP Voice,
// so the radio needs its own bot token: ~/.config/omp-discord/radio.env (RADIO_BOT_TOKEN=...).
// Music: every .ogg in ~/.local/share/omp-discord-bot/radio/ plus the hold clips, shuffled.
// Owner 2026-10-15: the bot stays in the channel all the time; music plays while someone is listening
// and stops 5 minutes after the last person leaves.
import { createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, AudioPlayerStatus, StreamType, VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { join } from "node:path";
import { CONFIG, GUILD_ID } from "../src/config.ts";

const HOME = process.env.HOME ?? "";
const GUILD = GUILD_ID;
const CHANNEL = process.env.RADIO_CHANNEL_ID ?? CONFIG.radioChannelId;
const DIRS = [join(HOME, ".local/share/omp-discord-bot/radio"), join(HOME, ".local/share/omp-discord-bot/hold")];
const env = readFileSync(join(HOME, ".config/omp-discord/radio.env"), "utf8");
const token = env.match(/RADIO_BOT_TOKEN=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!token) throw new Error("RADIO_BOT_TOKEN missing in radio.env");

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const tracks = () => DIRS.filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ogg") && !f.includes(".part")).map((f) => join(d, f)));
const shuffle = <T,>(a: T[]) => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
// Live input arrives in bursts; the default (5 missed frames) stopped playback every ~9 s.
const player = createAudioPlayer({ behaviors: { maxMissedFrames: 250 } });
let conn: VoiceConnection | null = null;
let queue: string[] = [];
let playing = false;
let active = false; // music wanted (someone is listening, or within the 5-min grace)
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let joining = false;
const GRACE_MS = 5 * 60_000;
let failStreak = 0; // owner 2026-10-15: alert after repeated failures

function humans(ch: VoiceBasedChannel): number {
  return ch.members.filter((m) => !m.user.bot).size;
}

const LIVE = process.env.RADIO_STREAM_URL ?? "https://www.youtube.com/channel/UCsIg9WMfxjZZvwROleiVsQg/live" /* STEEZYASFUCK channel live: follows stream ID changes */;
/** After the live stream fails (e.g. YouTube bot check), play local clips for a while instead of retrying. */
let liveBackoffUntil = 0;
/** When YouTube blocks the host's own IP, the radio can retry the live stream through a SOCKS5 proxy. */
/** Optional SOCKS proxy for a second live-stream try (RADIO_PROXY in the environment or radio.env). Empty: no proxy retry. */
const PROXY = process.env.RADIO_PROXY ?? env.match(/RADIO_PROXY=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
let useProxy = false;

/**
 * Pass-through that logs startup buffering (debug, owner 2026-10-15): seconds of audio produced vs seconds
 * elapsed since the first audio. "ahead" below 0 means the player ran dry and inserted silence (a skip).
 */
function bufferProbe(label: string, launchedAt: number): { tap: Transform; produced: () => number } {
  let first = 0;
  let audio = 0;
  const checks = [5, 15, 30, 60];
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const now = performance.now();
      if (!first) {
        first = now;
        log(`${label}: first audio ${((now - launchedAt) / 1000).toFixed(1)} s after start`);
      }
      for (let i = chunk.indexOf("OggS"); i >= 0 && i + 14 <= chunk.length; i = chunk.indexOf("OggS", i + 4)) {
        const g = Number(chunk.readBigInt64LE(i + 6));
        if (g > 0) audio = g / 48000;
      }
      const el = (now - first) / 1000;
      while (checks.length && el >= checks[0]!) log(`${label}: at ${checks.shift()} s, ${(audio - el).toFixed(1)} s ahead`);
      cb(null, chunk);
    },
  });
  return { tap, produced: () => audio };
}

async function next(): Promise<void> {
  if (!conn || !active) return void (playing = false);
  // Owner 2026-10-14: play the STEEZYASFUCK 24/7 YouTube live stream; local clips are the fallback.
  // Debug 2026-10-15: the skips after joining came from loudnorm. Its 3 s look-ahead used up the start-up
  // buffer, and yt-dlp delivers the live stream just in time (one ~2 s segment every ~2.1 s), so the player
  // ran dry 16 times in the first ~30 s. The live stream now uses a fixed gain (no look-ahead, no buffering).
  // One yt-dlp call per start (the separate -g probe doubled YouTube requests and start-up time).
  // Owner 2026-10-15: `touch ~/.config/omp-discord/radio-local-only` plays local clips only (wobble comparison).
  const localOnly = existsSync(join(HOME, ".config/omp-discord/radio-local-only"));
  const live = !localOnly && Date.now() >= liveBackoffUntil;
  let file: string | undefined;
  if (!live) {
    if (!queue.length) queue = shuffle(tracks());
    file = queue.shift();
    if (!file) return void (playing = false);
  }
  const launchedAt = performance.now();
  const src = live ? spawn("yt-dlp", ["--no-warnings", "-q", ...(useProxy ? ["--proxy", PROXY] : []), "-f", "bestaudio", "--hls-use-mpegts", "-o", "-", LIVE], { stdio: ["ignore", "pipe", "pipe"] }) : null;
  // Live: yt-dlp follows the HLS playlist itself (ffmpeg on a -g URL stopped every ~7 s -> cut-outs).
  // -4 dB approximates the old loudnorm -18 LUFS target for a YouTube master (~-14 LUFS; estimate).
  const filter = live ? "volume=-4dB" : "loudnorm=I=-18";
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", live ? "pipe:0" : file!, "-vn", "-af", filter, "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-b:a", "96k", "-f", "ogg", "pipe:1"], { stdio: [live ? "pipe" : "ignore", "pipe", "pipe"] });
  ff.stderr?.on("data", (d) => log(`ffmpeg: ${String(d).trim().slice(0, 200)}`));
  const label = live ? "live stream" : file!;
  const probe = bufferProbe(label, launchedAt);
  ff.on("close", (c) => {
    log(`ffmpeg exited ${c}`);
    // A live stream that ends within a minute failed; use local clips for 10 minutes (no rapid retries).
    if (live && active && performance.now() - launchedAt < 60_000) {
      if (!useProxy && PROXY) {
        // Blocked on the main host's own exit: try the proxy city right away (no extra request on the blocked address).
        useProxy = true;
        log(`live stream failed (${probe.produced().toFixed(0)} s audio); retrying via ${PROXY.split("//")[1]}`);
      } else {
        useProxy = false;
        liveBackoffUntil = Date.now() + 10 * 60_000;
        log(`live stream failed via proxy too (${probe.produced().toFixed(0)} s audio); local clips for 10 min`);
      }
    }
  });
  if (src && ff.stdin) {
    src.stderr?.on("data", (d) => log(`yt-dlp: ${String(d).trim().split("\n")[0]!.slice(0, 200)}`));
    src.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    ff.on("close", () => src.kill());
  }
  ff.stdout!.pipe(probe.tap);
  player.play(createAudioResource(probe.tap, { inputType: StreamType.OggOpus }));
  playing = true;
  log(`playing ${label}`);
}
// Track ended or stream dropped: continue only while music is wanted (avoid reloading after a stop).
player.on(AudioPlayerStatus.Idle, () => {
  playing = false;
  if (active) setTimeout(() => void next(), 1_000);
});
player.on("error", (e) => log(`player: ${e.message}`));

function fail(why: string): void {
  log(`could not connect: ${why}`);
  if (++failStreak === 3)
    Bun.spawn(["bun", `${import.meta.dir}/notify-owner.ts`,
      "⚠️ **Lofi Radio cannot join 📻 Lofi Radio** (3 failed attempts; still retrying). Check that the bot can see the channel (View Channel, Connect, Speak)."], { stdout: "ignore", stderr: "ignore" });
}

/** Stay connected all the time (owner 2026-10-15). */
async function ensureConnected(): Promise<VoiceBasedChannel | null> {
  const ch = await client.channels.fetch(CHANNEL).catch(() => null);
  if (!ch?.isVoiceBased()) {
    fail("channel not visible to the bot");
    return null;
  }
  if (conn || joining) return ch;
  joining = true;
  const c = joinVoiceChannel({ channelId: ch.id, guildId: GUILD, adapterCreator: ch.guild.voiceAdapterCreator, selfDeaf: true });
  try {
    await entersState(c, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    try { c.destroy(); } catch {}
    joining = false;
    fail("voice connection timed out");
    return ch;
  }
  joining = false;
  conn = c;
  c.subscribe(player);
  instrument(c);
  c.on(VoiceConnectionStatus.Disconnected, () => {
    void Promise.race([entersState(c, VoiceConnectionStatus.Signalling, 5_000), entersState(c, VoiceConnectionStatus.Connecting, 5_000)]).catch(() => {
      log("disconnected; reconnecting");
      try { c.destroy(); } catch {}
      if (conn === c) conn = null;
      playing = false;
    });
  });
  if (failStreak >= 3) Bun.spawn(["bun", `${import.meta.dir}/notify-owner.ts`, "✅ **Lofi Radio is back in 📻 Lofi Radio.**"], { stdout: "ignore", stderr: "ignore" });
  failStreak = 0;
  log("connected (always on)");
  return ch;
}

/**
 * Debug (owner 2026-10-15, "speeds up and slows down"): Discord clients stretch or squeeze audio when packets
 * arrive unevenly. Log how evenly we send the 20 ms packets and how much the event loop stalls, every 30 s.
 */
let sends: number[] = [];
let loopLagMax = 0;
function instrument(c: VoiceConnection): void {
  const orig = c.dispatchAudio.bind(c);
  c.dispatchAudio = () => {
    sends.push(performance.now());
    return orig();
  };
}
{
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    loopLagMax = Math.max(loopLagMax, now - last - 50);
    last = now;
  }, 50);
  setInterval(() => {
    const t = sends;
    sends = [];
    const lag = loopLagMax;
    loopLagMax = 0;
    if (t.length < 10) return;
    const d = t.slice(1).map((x, i) => x - t[i]!).sort((a, b) => a - b);
    const q = (f: number) => d[Math.min(d.length - 1, Math.floor(f * d.length))]!.toFixed(1);
    const late = d.filter((x) => x > 40).length;
    const sec = (t.at(-1)! - t[0]!) / 1000;
    log(`net: ${t.length} packets in ${sec.toFixed(1)} s (${((t.length * 0.02) / sec * 100).toFixed(1)}% of real time); gap p50 ${q(0.5)} p99 ${q(0.99)} max ${q(1)} ms; ${late} gaps >40 ms; event-loop stall max ${lag.toFixed(0)} ms`);
  }, 30_000);
}

/** Debug: `kill -USR1 <pid>` plays 90 s even with nobody in the channel (for the stats above). */
process.on("SIGUSR1", () => {
  if (!conn) return log("test play: not connected");
  log("test play: 90 s");
  active = true;
  if (!playing) void next();
  setTimeout(() => void (async () => {
    const ch = await client.channels.fetch(CHANNEL).catch(() => null);
    if (ch?.isVoiceBased() && humans(ch) === 0 && !stopTimer) {
      active = false;
      player.stop(true);
      playing = false;
      log("test play: done");
    }
  })(), 90_000);
});

async function sync(): Promise<void> {
  const ch = await ensureConnected();
  if (!ch || !conn) return;
  if (humans(ch) > 0) {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = undefined;
    }
    if (!active) {
      active = true;
      log("listener joined; music on");
    }
    if (!playing) void next();
  } else if (active && !stopTimer) {
    log("channel empty; music stops in 5 min unless someone returns");
    stopTimer = setTimeout(() => {
      stopTimer = undefined;
      active = false;
      player.stop(true);
      playing = false;
      log("music off (channel empty 5 min)");
    }, GRACE_MS);
  }
}

client.once(Events.ClientReady, () => {
  log(`ready; ${tracks().length} tracks`);
  void sync();
  setInterval(() => void sync(), 60_000); // reconnect after drops; re-check listeners
});
client.on(Events.VoiceStateUpdate, (o, n) => {
  if (o.channelId === CHANNEL || n.channelId === CHANNEL) void sync();
});
await client.login(token);
