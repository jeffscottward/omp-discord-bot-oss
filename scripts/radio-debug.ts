// Radio start-up debug (owner 2026-10-15): measure skips (player underruns) in the first minute of playback.
// Feeds audio the way yt-dlp delivers the live stream: a 2-segment backlog at once, then one 2 s segment every 2 s.
// Then simulates the Discord player (one 20 ms Opus frame per tick; a missing frame = silence = a skip).
//   bun scripts/radio-debug.ts [file] [seconds]       local file, no YouTube requests
//   bun scripts/radio-debug.ts youtube [seconds]      the real live stream via yt-dlp (one YouTube session)
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = process.argv[2];
const SECS = Number(process.argv[3] ?? 45);
const LIVE = "https://www.youtube.com/watch?v=IPg9DRpm9xQ";
const dir = join(process.env.HOME ?? "", ".local/share/omp-discord-bot/hold");
const file = arg && arg !== "youtube" ? arg : join(dir, readdirSync(dir).find((f) => f.endsWith(".ogg"))!);

async function run(filter: string): Promise<string> {
  const t0 = performance.now();
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-vn", "-af", filter, "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-b:a", "96k", "-f", "ogg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
  ff.stdin.on("error", () => {});
  let stop = () => {};
  if (arg === "youtube") {
    const src = spawn("yt-dlp", ["--no-warnings", "-q", "-f", "bestaudio", "--hls-use-mpegts", "-o", "-", LIVE], { stdio: ["ignore", "pipe", "ignore"] });
    src.stdout.pipe(ff.stdin);
    stop = () => src.kill();
  } else {
    // Decode to raw PCM once, then release it like a live HLS stream (see runPcm).
    const pcm = Buffer.from(Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-i", file, "-f", "s16le", "-ar", "48000", "-ac", "2", "-"]).stdout);
    const seg = 48000 * 4 * 2;
    ff.kill(); // the local path uses its own raw-PCM ffmpeg (runPcm)
    return runPcm(filter, pcm, seg);
  }
  return measure(ff.stdout, t0, stop);
}

function runPcm(filter: string, pcm: Buffer, seg: number): Promise<string> {
  const t0 = performance.now();
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-af", filter, "-c:a", "libopus", "-b:a", "96k", "-f", "ogg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
  ff.stdin.on("error", () => {});
  let off = 0;
  const send = () => { if (off < pcm.length) { ff.stdin.write(pcm.subarray(off, off + seg)); off += seg; } };
  send();
  send(); // live HLS starts a little behind the live edge: about 2 segments are available at once
  const iv = setInterval(send, 2000);
  return measure(ff.stdout, t0, () => { clearInterval(iv); ff.kill(); });
}

async function measure(out: NodeJS.ReadableStream, t0: number, stop: () => void): Promise<string> {
  const arr: [number, number][] = [];
  out.on("data", (d: Buffer) => {
    for (let i = d.indexOf("OggS"); i >= 0 && i + 14 <= d.length; i = d.indexOf("OggS", i + 4)) {
      const g = Number(d.readBigInt64LE(i + 6));
      if (g > 0) arr.push([performance.now() - t0, g / 48000]);
    }
  });
  await Bun.sleep(SECS * 1000);
  stop();
  if (!arr.length) return "no audio";
  const avail = (t: number) => { let a = 0; for (const [w, s] of arr) { if (w <= t) a = s; else break; } return a; };
  const start = arr[0]![0];
  let pos = 0, silent = 0, gaps = 0, inGap = false;
  for (let t = start; t <= arr.at(-1)![0]; t += 20) {
    if (avail(t) >= pos + 0.02) { pos += 0.02; inGap = false; } else { silent++; if (!inGap) gaps++; inGap = true; }
  }
  return `first audio ${(start / 1000).toFixed(1)} s; ${gaps} skips (${(silent * 0.02).toFixed(1)} s of silence) in ${((arr.at(-1)![0] - start) / 1000).toFixed(0)} s`;
}

for (const f of ["loudnorm=I=-18", "volume=-4dB"]) console.log(`${f.padEnd(16)} ${await run(f)}`);
process.exit(0);
