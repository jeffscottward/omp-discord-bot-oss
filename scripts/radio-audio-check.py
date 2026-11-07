#!/usr/bin/env -S uv run -q --with numpy python
"""Lofi Radio main-host audio check (card kb-youtube-feed-audio-clicks, 2026-10-30).

Runs the exact live pipeline of scripts/radio.ts for N seconds (yt-dlp -> ffmpeg -> Ogg Opus) and keeps the
raw yt-dlp bytes. Then it checks, on the main host only:
  1. source: codec, sample rate, packet timestamp gaps, decode errors;
  2. output: Opus packet durations (Discord expects 20 ms);
  3. output vs source: click events present in the output but absent in the source.
A pass means the main host adds no artifact. It says nothing about the Discord network path or the listener's app.

Usage: scripts/radio-audio-check.py [seconds=90] [workdir=/tmp/radio-audio-check]
"""
import json
import os
import subprocess
import sys

import numpy as np

SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 90
WORK = sys.argv[2] if len(sys.argv) > 2 else "/tmp/radio-audio-check"
URL = os.environ.get("RADIO_STREAM_URL", "https://www.youtube.com/channel/UCsIg9WMfxjZZvwROleiVsQg/live")
SR = 48000
os.makedirs(WORK, exist_ok=True)
raw, ogg = f"{WORK}/raw.ts", f"{WORK}/out.ogg"


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True, check=False).stdout + ""


# Same arguments as radio.ts next() for the live stream (direct route; radio.ts may retry via RADIO_PROXY).
pipe = (
    'timeout "$1" yt-dlp --no-warnings -q -f bestaudio --hls-use-mpegts -o - "$2"'
    ' | tee "$3" | ffmpeg -loglevel error -i pipe:0 -vn -af volume=-4dB -c:a libopus -ar 48000 -ac 2'
    ' -b:a 96k -f ogg pipe:1 > "$4"'
)
subprocess.run(["bash", "-c", pipe, "_", str(SECONDS), URL, raw, ogg], check=False)


def rows(path: str, fields: str) -> list[list[float]]:
    """ffprobe packet fields as floats; lines with N/A or missing fields are skipped."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", f"packet={fields}",
               "-of", "csv=p=0", path])
    want = fields.count(",") + 1
    res = []
    for line in out.splitlines():
        parts = [p for p in line.strip().split(",") if p][:want]
        if len(parts) == want and "N/A" not in parts:
            res.append([float(p) for p in parts])
    return res


info = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels",
                       "-of", "json", raw]) or "{}")
print("source stream:", info.get("streams"))
pk = rows(raw, "pts_time,duration_time")
if sum(d for _, d in pk) < 0.9 * SECONDS:
    sys.exit(f"capture failed: {len(pk)} source packets in {SECONDS} s (yt-dlp blocked, offline or ended?)")
gaps = [round(pk[i][0] - pk[i - 1][0] - pk[i - 1][1], 4) for i in range(1, len(pk))]
gaps = [g for g in gaps if abs(g) > 0.0005]
dec = subprocess.run(["ffmpeg", "-v", "error", "-i", raw, "-f", "null", "-"], capture_output=True, text=True).stderr
durs = [d[0] for d in rows(ogg, "duration_time")]
odd = sum(1 for d in durs[:-1] if abs(d - 0.02) > 1e-6)


def pcm(path: str) -> np.ndarray:
    b = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ar", str(SR), "-ac", "2", "-f", "f32le", "-"],
                       capture_output=True, check=True).stdout
    return np.frombuffer(b, dtype="<f4").reshape(-1, 2).mean(1)


def ratio(x: np.ndarray) -> np.ndarray:
    """Sharpness: second difference divided by its 50 ms RMS. Clicks and drum hits score high."""
    d2 = np.abs(np.diff(x, 2))
    return d2 / (np.sqrt(np.convolve(d2 ** 2, np.ones(2400) / 2400, mode="same")) + 1e-6)


src, out = pcm(raw), pcm(ogg)
n = min(len(src), len(out)) - SR // 2  # skip the last 0.5 s (the capture cuts the stream there)
rs, ro = ratio(src[:n]), ratio(out[:n])
hit = np.where(ro > 8)[0]
events = hit[np.insert(np.diff(hit) > 240, 0, True)] if len(hit) else hit
# An artifact is a sharp output event with no sharp event in the source within 10 ms. Tested 2026-10-30:
# real captures 0 per 105 s; 20 injected 10 ms dropouts gave 21-23.
added = [round(e / SR, 2) for e in events if rs[max(0, e - 480):e + 480].max() < 4]
secs = len(src) / SR
print(f"source: {secs:.1f} s, {len(pk)} packets, timestamp gaps {len(gaps)}, decode errors {len(dec.splitlines())}")
print(f"output: {len(out) / SR:.1f} s, {len(durs)} Opus packets, non-20 ms packets {odd}")
print(f"sharp output events {len(events)}; added by the main host path (no source event within 10 ms): {len(added)} {added[:20]}")
ok = not gaps and not dec.strip() and odd == 0 and not added
print("RESULT:", "PASS (main path adds no artifact)" if ok else "FAIL (main path changes the audio)")
sys.exit(0 if ok else 1)
