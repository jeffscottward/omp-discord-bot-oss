#!/usr/bin/env bash
# kit/install.sh: install the FIRSTMATE kit (bin links, dashboard files, systemd user units) for this user.
# Idempotent: run it again at any time. It never overwrites tracker data, and it keeps an existing file that differs
# from the kit copy unless you give --force (then it saves the old file as <name>.bak-kit-<time> first).
#
# Usage: kit/install.sh [--dry-run] [--prefix DIR] [--enable] [--force] [--fixtures]
#   --dry-run   print what it would do; write nothing (except under /tmp).
#   --prefix    folder for the command links (default: $HOME/.local/bin).
#   --enable    also run `systemctl --user daemon-reload` and enable + start the kit timers, path units and
#               services (skips the units named in KIT_SKIP_UNITS). Not done without --enable.
#   --force     replace files that differ from the kit copy (old file saved as .bak-kit-<time>).
#   --fixtures  when FM_DIR has no tracker data yet, start with the example cards (kit/dashboard/fixtures).
# Settings: $OMP_KIT_ENV, else ~/.config/omp-discord/kit.env (created from kit/kit.env.example when missing).
# Works with a scratch HOME (HOME=/tmp/x kit/install.sh): then it never calls systemctl.
set -euo pipefail

DRY=0; ENABLE=0; FORCE=0; FIXTURES=0; PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --enable) ENABLE=1 ;;
    --force) FORCE=1 ;;
    --fixtures) FIXTURES=1 ;;
    --prefix) [ $# -ge 2 ] || { echo "--prefix needs a folder" >&2; exit 2; }; PREFIX=$2; shift ;;
    --prefix=*) PREFIX=${1#--prefix=} ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

KIT=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
REPO_DEFAULT=$(dirname "$KIT")
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '%s\n' "$*"; }
act() { if [ $DRY = 1 ]; then say "DRY  $*"; else say "do   $*"; fi; }

# Only paths under /tmp may be written in dry-run mode.
writable() {
  [ $DRY = 0 ] && return 0
  case "$1" in /tmp/*) return 0 ;; *) return 1 ;; esac
}
run() { # run a command that changes files (skipped in dry-run mode)
  if [ $DRY = 1 ]; then return 0; fi
  "$@"
}

# ---------- settings ----------
ENV_FILE="${OMP_KIT_ENV:-$HOME/.config/omp-discord/kit.env}"
if [ ! -e "$ENV_FILE" ]; then
  act "create $ENV_FILE from kit/kit.env.example (edit it to set your values)"
  run mkdir -p "$(dirname "$ENV_FILE")"
  run install -m 600 "$KIT/kit.env.example" "$ENV_FILE"
fi
kit_env() { # KEY=VALUE lines; a variable that is already set in the environment wins
  local f=$1 line k
  [ -r "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line#export }"
    case "$line" in ''|'#'*) continue ;; esac
    k="${line%%=*}"
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -n "${!k+x}" ] && continue
    eval "export $line"
  done < "$f"
}
if [ -r "$ENV_FILE" ]; then kit_env "$ENV_FILE"; else kit_env "$KIT/kit.env.example"; fi

OMP_BOT_REPO="${OMP_BOT_REPO:-$REPO_DEFAULT}"
REPORTS_WEB_DIR="${REPORTS_WEB_DIR:-$HOME/.local/share/omp-discord/reports-web}"
FM_DIR="${FM_DIR:-$REPORTS_WEB_DIR/firstmate}"
BIN_DIR="${PREFIX:-$HOME/.local/bin}"
UNIT_DIR="$HOME/.config/systemd/user"
# bun for the reminders units: a stable path (not a version folder), so upgrades do not break the units.
if [ -x "$HOME/.bun/bin/bun" ]; then BUN_BIN="$HOME/.bun/bin/bun"
elif [ -x "$HOME/.local/share/mise/shims/bun" ]; then BUN_BIN="$HOME/.local/share/mise/shims/bun"
else BUN_BIN="$(command -v bun || echo "$HOME/.bun/bin/bun")"; fi
KIT_SKIP_UNITS="${KIT_SKIP_UNITS:-}"

say "kit      $KIT"
say "settings $ENV_FILE"
say "bin      $BIN_DIR"
say "FM_DIR   $FM_DIR"
say "web      $REPORTS_WEB_DIR"
say "units    $UNIT_DIR"
[ $DRY = 1 ] && say "(dry run: nothing is written outside /tmp)"

# Copy SRC to DST. Missing: copy. Same: nothing. Different: keep (or replace with --force, after a backup).
place() {
  local src=$1 dst=$2 mode=${3:-644}
  if [ -e "$dst" ] && cmp -s "$src" "$dst"; then
    say "ok   $dst"
  elif [ -e "$dst" ] && [ $FORCE = 0 ]; then
    say "keep $dst (differs from the kit copy; --force replaces it)"
  else
    if [ -e "$dst" ]; then act "back up $dst -> $dst.bak-kit-$STAMP"; if writable "$dst"; then run cp -p "$dst" "$dst.bak-kit-$STAMP"; fi; fi
    act "install $dst"
    if writable "$dst"; then run mkdir -p "$(dirname "$dst")"; run install -m "$mode" "$src" "$dst"; fi
  fi
}

# Symlink DST -> SRC. Same link: nothing. Other file/link: keep (or replace with --force, after a backup).
link() {
  local src=$1 dst=$2
  if [ -L "$dst" ] && [ "$(readlink -f "$dst")" = "$(readlink -f "$src")" ]; then
    say "ok   $dst"
  elif { [ -e "$dst" ] || [ -L "$dst" ]; } && [ $FORCE = 0 ]; then
    say "keep $dst (not a link to the kit; --force replaces it)"
  else
    if [ -e "$dst" ] || [ -L "$dst" ]; then act "back up $dst -> $dst.bak-kit-$STAMP"; if writable "$dst"; then run mv "$dst" "$dst.bak-kit-$STAMP"; fi; fi
    act "link $dst -> $src"
    if writable "$dst"; then run mkdir -p "$(dirname "$dst")"; run ln -s "$src" "$dst"; fi
  fi
}

# ---------- 1. commands ----------
say "== commands"
for f in "$KIT"/bin/*; do
  [ -f "$f" ] && [ -x "$f" ] || continue
  link "$f" "$BIN_DIR/$(basename "$f")"
done
[ -x "$OMP_BOT_REPO/scripts/fm-spawn" ] && link "$OMP_BOT_REPO/scripts/fm-spawn" "$BIN_DIR/fm-spawn"

# ---------- 2. dashboard files ----------
say "== dashboard"
if [ ! -d "$FM_DIR" ]; then act "mkdir $FM_DIR"; if writable "$FM_DIR"; then run mkdir -p "$FM_DIR"; fi; fi
for f in "$KIT"/dashboard/web/* "$KIT"/dashboard/docs/*; do
  place "$f" "$FM_DIR/$(basename "$f")"
done
# Tracker data: create only when missing; never overwrite.
for d in items.json running.json reports.json changes.json; do
  if [ -e "$FM_DIR/$d" ]; then say "ok   $FM_DIR/$d (data; never changed by install)"; continue; fi
  if [ $FIXTURES = 1 ]; then
    act "create $FM_DIR/$d from the example fixtures"
    if writable "$FM_DIR/$d"; then run install -m 644 "$KIT/dashboard/fixtures/$d" "$FM_DIR/$d"; fi
  elif [ "$d" = items.json ]; then
    act "create an empty tracker $FM_DIR/items.json"
    if writable "$FM_DIR/$d"; then run sh -c 'printf "%s\n" "{\"updated\": \"\", \"items\": []}" > "$1"' _ "$FM_DIR/$d"; fi
  fi
done
for d in receipts sweep-runs; do
  [ -d "$FM_DIR/$d" ] || { act "mkdir $FM_DIR/$d"; if writable "$FM_DIR/$d"; then run mkdir -p "$FM_DIR/$d"; fi; }
done
# The report server publishes REPORTS_WEB_DIR; the dashboard must be REPORTS_WEB_DIR/firstmate.
if [ "$(readlink -m "$FM_DIR")" != "$(readlink -m "$REPORTS_WEB_DIR/firstmate")" ]; then
  if [ -e "$REPORTS_WEB_DIR/firstmate" ] || [ -L "$REPORTS_WEB_DIR/firstmate" ]; then
    say "keep $REPORTS_WEB_DIR/firstmate (exists; FM_DIR is elsewhere, so the dashboard may not be served)"
  else
    act "link $REPORTS_WEB_DIR/firstmate -> $FM_DIR (so /reports/firstmate/ serves the dashboard)"
    if writable "$REPORTS_WEB_DIR"; then run mkdir -p "$REPORTS_WEB_DIR"; run ln -s "$FM_DIR" "$REPORTS_WEB_DIR/firstmate"; fi
  fi
fi

# ---------- 3. systemd user units ----------
say "== systemd user units"
TMPD=$(mktemp -d /tmp/omp-kit-units.XXXXXX)
trap 'rm -rf "$TMPD"' EXIT
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
UNITS=()
while IFS= read -r src; do
  rel=${src#"$KIT/systemd/"}
  mkdir -p "$TMPD/$(dirname "$rel")"
  sed -e "s|@KIT@|$(esc "$KIT")|g" -e "s|@FM_DIR@|$(esc "$FM_DIR")|g" -e "s|@BUN@|$(esc "$BUN_BIN")|g" "$src" > "$TMPD/$rel"
  place "$TMPD/$rel" "$UNIT_DIR/$rel"
  case "$rel" in */*) ;; *) UNITS+=("$rel") ;; esac
done < <(find "$KIT/systemd" -type f | sort)

# ---------- 4. enable (only with --enable) ----------
REAL_HOME=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true)
[ -n "$REAL_HOME" ] || REAL_HOME=$HOME
want_units() { # timers, path units and long-running services; their oneshot services start from these
  local u base
  for u in "${UNITS[@]}"; do
    case " $KIT_SKIP_UNITS " in *" $u "*) say "skip $u (KIT_SKIP_UNITS)"; continue ;; esac
    case "$u" in
      *.timer|*.path) printf '%s\n' "$u" ;;
      *.service)
        base=${u%.service}
        [ -e "$KIT/systemd/$base.timer" ] || [ -e "$KIT/systemd/$base.path" ] || printf '%s\n' "$u" ;;
    esac
  done
}
if [ $ENABLE = 1 ]; then
  say "== enable"
  mapfile -t EN < <(want_units)
  if [ $DRY = 1 ]; then
    act "systemctl --user daemon-reload"
    act "systemctl --user enable --now ${EN[*]} (only the units whose installed file is the kit copy)"
  elif [ "$(readlink -m "$HOME")" != "$(readlink -m "$REAL_HOME")" ]; then
    say "skip systemctl: HOME=$HOME is not your real home ($REAL_HOME); a scratch install is never enabled"
    say "     would run: systemctl --user daemon-reload && systemctl --user enable --now ${EN[*]}"
  elif ! command -v systemctl >/dev/null 2>&1; then
    say "skip systemctl: not found (macOS: run the commands by hand or with launchd; see docs/SETUP.md)"
  else
    systemctl --user daemon-reload
    for u in "${EN[@]}"; do
      # Enable only the units this kit installed (the file is the rendered kit copy).
      rel_tmp="$TMPD/$u"
      if [ -e "$UNIT_DIR/$u" ] && cmp -s "$rel_tmp" "$UNIT_DIR/$u"; then
        if systemctl --user enable --now "$u"; then say "on   $u"; else say "FAIL enable $u"; fi
      else
        say "skip $u (the installed file is not the kit copy)"
      fi
    done
  fi
else
  say "== units are installed but not enabled; run: kit/install.sh --enable"
fi
say "done"
