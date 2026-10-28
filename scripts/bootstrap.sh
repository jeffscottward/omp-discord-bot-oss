#!/usr/bin/env bash
# One-command setup for your own copy of the OMP Discord bot (bot + FIRSTMATE dashboard kit + voice).
# Idempotent: it never overwrites existing config files, data files or a different symlink target.
# Linux with systemd --user first (Omarchy/Arch tested). Other distros: install the same packages
# with your package manager. macOS: no systemd --user; run the services with launchd yourself
# (see docs/SETUP.md, "Other systems").
#
# Usage: scripts/bootstrap.sh [--dry-run] [--yes] [--voice] [--enable] [--skip-tests]
#   --dry-run     show every step; write nothing outside /tmp
#   --yes         no prompts (config files get placeholders you fill in later)
#   --voice       also set up local speech: Whisper (speech to text) and Kokoro (text to speech)
#   --enable      enable and start the systemd user units at the end
#   --skip-tests  skip bun test / typecheck / kit self-tests
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${OMP_DISCORD_CONFIG_DIR:-$HOME/.config/omp-discord}"
UNIT_DIR="$HOME/.config/systemd/user"
KOKORO_DIR="${KOKORO_DIR:-$HOME/Github/tools/kokoro-tts}"
DRY=0 YES=0 VOICE=0 ENABLE=0 TESTS=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --voice) VOICE=1 ;;
    --enable) ENABLE=1 ;;
    --skip-tests) TESTS=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
# run: execute, or only print in --dry-run.
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }
ask() { # ask VAR "question" default [secret]
  local __v="$1" q="$2" d="${3:-}" secret="${4:-}" ans=""
  if [ "$YES" = 1 ] || [ "$DRY" = 1 ] || [ ! -t 0 ]; then printf -v "$__v" '%s' "$d"; return; fi
  if [ -n "$secret" ]; then read -rs -p "$q: " ans || true; echo; else read -r -p "$q [${d}]: " ans || true; fi
  printf -v "$__v" '%s' "${ans:-$d}"
}

step "1. Prerequisites"
missing=0
need() { # need <cmd> <required|optional> <why>
  if command -v "$1" >/dev/null 2>&1; then say "  ok       $1"; else
    if [ "$2" = required ]; then say "  MISSING  $1 ($3)"; missing=1; else say "  optional $1 not found ($3)"; fi
  fi
}
need bun required "runs the bot: https://bun.sh"
need git required "repo updates"
need python3 required "dashboard builders, kit scripts"
need uv required "Whisper server (uv run) and Kokoro venv: https://docs.astral.sh/uv/"
need omp required "the agent the bot drives: Oh My Pi (omp)"
need herdr required "terminal sessions mirrored to Discord, approval tabs"
need ffmpeg required "voice and radio audio"
need systemctl required "systemd --user services"
need tailscale optional "phone access to the dashboard and Shortcuts (tailscale serve)"
need yt-dlp optional "Lofi radio live stream"
need nvidia-smi optional "GPU speech; CPU fallback works, slower"
need bwrap optional "sandboxed (non-trusted) runs"
if [ "$missing" = 1 ]; then
  if [ "$DRY" = 1 ]; then say "  (dry-run: continuing although required tools are missing)"; else say "Install the missing tools, then run this again."; exit 1; fi
fi

step "2. Dependencies"
run bash -c "cd '$REPO' && bun install --frozen-lockfile"

step "3. Config files in $CFG (never overwritten)"
run mkdir -p "$CFG"
[ "$DRY" = 1 ] || chmod 700 "$CFG"
if [ -e "$CFG/bot.env" ]; then say "  keep $CFG/bot.env"; else
  ask TOKEN "Discord bot token (hidden input; leave empty to fill in later)" "" secret
  ask APPID "Discord application id" ""
  if [ "$DRY" = 1 ]; then say "  [dry-run] write $CFG/bot.env (mode 600) from .env.example"; else
    umask 077
    # The token goes through the environment, never through command-line arguments.
    TOKEN="$TOKEN" APPID="$APPID" python3 - "$REPO/.env.example" "$CFG/bot.env" <<'PY'
import os, sys
out = []
for line in open(sys.argv[1]):
    if line.startswith("DISCORD_BOT_TOKEN="):
        line = "DISCORD_BOT_TOKEN=" + os.environ["TOKEN"] + "\n"
    elif line.startswith("DISCORD_APP_ID="):
        line = "DISCORD_APP_ID=" + os.environ["APPID"] + "\n"
    out.append(line)
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.writelines(out)
PY
    unset TOKEN
    chmod 600 "$CFG/bot.env"; say "  wrote $CFG/bot.env"
  fi
fi
if [ -e "$CFG/config.json" ]; then say "  keep $CFG/config.json"; else
  ask OWNER "Your Discord user id" "<YOUR_DISCORD_USER_ID>"
  ask GUILD "Your server (guild) id" "<YOUR_SERVER_ID>"
  ask HOSTL "A short name for this machine" "$(hostname -s 2>/dev/null || echo my-pc)"
  if [ "$DRY" = 1 ]; then say "  [dry-run] write $CFG/config.json from config.example.json"; else
    OWNER="$OWNER" GUILD="$GUILD" HOSTL="$HOSTL" python3 - "$REPO/config.example.json" "$CFG/config.json" <<'PY'
import json, os, sys
c = json.load(open(sys.argv[1]))
c["ownerId"], c["guildId"], c["hostLabel"] = os.environ["OWNER"], os.environ["GUILD"], os.environ["HOSTL"]
with open(sys.argv[2], "w") as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(sys.argv[2], 0o600)
PY
    say "  wrote $CFG/config.json: fill in the channel ids (docs/SETUP.md, section 2)"
  fi
fi
if [ -e "$CFG/kit.env" ]; then say "  keep $CFG/kit.env"; else
  run cp "$REPO/kit/kit.env.example" "$CFG/kit.env"
fi

step "4. Bot services (systemd --user units from $REPO/systemd)"
run mkdir -p "$UNIT_DIR"
for u in "$REPO"/systemd/*.service "$REPO"/systemd/*.timer "$REPO"/scripts/omp-lofi-radio.service; do
  [ -e "$u" ] || continue
  name="$(basename "$u")"
  case "$name" in omp-tts.service|omp-whisper.service) [ "$VOICE" = 1 ] || { say "  skip $name (use --voice)"; continue; } ;; esac
  dest="$UNIT_DIR/$name"
  # Units in the repo assume the checkout at ~/Github/tools/omp-discord-bot; point them at this checkout.
  rendered="$(sed -e "s|%h/Github/tools/omp-discord-bot|$REPO|g" -e "s|%h/Github/tools/kokoro-tts|$KOKORO_DIR|g" "$u")"
  if [ -e "$dest" ] && [ "$(cat "$dest")" = "$rendered" ]; then say "  same $name"; continue; fi
  if [ -e "$dest" ]; then say "  keep $name (differs from the repo copy; compare by hand)"; continue; fi
  if [ "$DRY" = 1 ]; then say "  [dry-run] install $dest"; else printf '%s\n' "$rendered" > "$dest"; say "  installed $name"; fi
done

step "5. Kit: FIRSTMATE dashboard, fm tools, timers (kit/install.sh)"
if [ "$DRY" = 1 ]; then run_kit=(bash "$REPO/kit/install.sh" --dry-run); else run_kit=(bash "$REPO/kit/install.sh"); fi
OMP_KIT_ENV="$CFG/kit.env" "${run_kit[@]}"

if [ "$VOICE" = 1 ]; then
  step "6. Local speech (Kokoro TTS in $KOKORO_DIR; Whisper runs through uv)"
  if [ -e "$KOKORO_DIR/kokoro-v1.0.onnx" ]; then say "  keep $KOKORO_DIR (model present)"; else
    run mkdir -p "$KOKORO_DIR"
    base="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
    run curl -fL --retry 3 -o "$KOKORO_DIR/kokoro-v1.0.onnx" "$base/kokoro-v1.0.onnx"
    run curl -fL --retry 3 -o "$KOKORO_DIR/voices-v1.0.bin" "$base/voices-v1.0.bin"
  fi
  if [ -x "$KOKORO_DIR/.venv/bin/python" ]; then say "  keep $KOKORO_DIR/.venv"; else
    ort=onnxruntime; command -v nvidia-smi >/dev/null 2>&1 && ort=onnxruntime-gpu
    run uv venv "$KOKORO_DIR/.venv"
    run uv pip install --python "$KOKORO_DIR/.venv/bin/python" kokoro-onnx "$ort" numpy
  fi
else
  step "6. Local speech: skipped (run again with --voice)"
fi

if [ "$TESTS" = 1 ]; then
  step "7. Self-tests"
  run bash -c "cd '$REPO' && bun test"
  run bash -c "cd '$REPO' && bunx tsc --noEmit -p ."
  if [ -x "$REPO/kit/test.sh" ]; then run bash "$REPO/kit/test.sh"; fi
else
  step "7. Self-tests: skipped"
fi

step "8. Services"
if [ "$ENABLE" = 1 ]; then
  run systemctl --user daemon-reload
  units=(omp-discord-bot.service)
  [ "$VOICE" = 1 ] && units+=(omp-whisper.service omp-tts.service)
  run systemctl --user enable --now "${units[@]}"
  [ "$DRY" = 1 ] || bash "$REPO/kit/install.sh" --enable
  say "  Live checks: curl -s http://127.0.0.1:47821/health ; bun scripts/voice-selftest.ts (needs voice + a Discord connection)"
else
  say "  Not started. When config.json is complete: scripts/bootstrap.sh --enable (or systemctl --user enable --now omp-discord-bot)"
fi

step "Manual steps left (docs/SETUP.md marks each one 🖐️ MANUAL)"
say "  - Discord application, bot token, intents, invite, channels, ids into $CFG/config.json"
say "  - omp: sign in with your own Claude subscription (omp, then /login)"
say "  - tailscale serve for the dashboard and Shortcuts; iPhone Shortcuts; optional HEELER and radio bot"
