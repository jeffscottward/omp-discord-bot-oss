#!/usr/bin/env bash
# Plan P1: checks that must pass before the bot restarts onto the code in this checkout.
# Runs: bash -n on every script, the typecheck (tsc --noEmit -p .) and the full test suite (bun test).
# Exit 0 = all passed. Exit 1 = a check failed; the last line of output says which one (for the Discord notice).
# For failed tests the last line names them (at most 3, then "+N more") and gives the full log file.
# Full log (card bot-gate-flake, 2026-11-03): every run writes all check output and the full list of failed tests
# to $OMP_GATE_LOG_DIR/gate-<sha>-<UTC time>-<pid>.log (default ~/.local/state/omp-discord-bot); logs older than 14 days are removed.
# One gate at a time on this host (lock $OMP_GATE_LOCK, default /tmp/omp-discord-bot-gate-<uid>.lock; wait up to
# $OMP_GATE_LOCK_WAIT s, default 900): two full test suites at the same time doubled the CPU load.
# Usage: scripts/restart-gate.sh [repo-dir=this checkout]
set -uo pipefail
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "${1:-$(dirname "$0")/..}" || { echo "GATE FAIL: no repo dir"; exit 1; }
rev="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
dirty=""; [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] && dirty=" (with uncommitted changes)"

if [ -z "${OMP_GATE_LOCKED:-}" ]; then
  lock="${OMP_GATE_LOCK:-/tmp/omp-discord-bot-gate-$(id -u).lock}"
  wait_s="${OMP_GATE_LOCK_WAIT:-900}"
  # -o: the checks (and any child a test leaves running) do not inherit the lock; flock itself holds it.
  OMP_GATE_LOCKED=1 flock -o -w "$wait_s" -E 75 "$lock" "$self" "$PWD"; rc=$?
  case "$rc" in
    0 | 1) exit "$rc" ;;
    75) echo "GATE FAIL at $rev$dirty: another gate run held $lock for more than ${wait_s}s"; exit 1 ;;
    *) echo "GATE FAIL at $rev$dirty: the gate stopped with exit $rc (lock error or signal)"; exit 1 ;;
  esac
fi

logdir="${OMP_GATE_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/omp-discord-bot}"
mkdir -p "$logdir"
find "$logdir" -maxdepth 1 \( -name 'gate-*.log' -o -name '.gate-*' \) -mtime +14 -delete 2>/dev/null
# One file per run (UTC start time and PID in the name): a later passing run at the same commit (the second gate
# inside safe-restart.sh, a manual rerun) never overwrites the log of a failed run.
log="$logdir/gate-$rev-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
shown="${log/#$HOME/\~}"
# Write to a temp file, rename at exit: a reader never sees half a log. No writable log dir: no log, same checks.
tmp="$(mktemp "$logdir/.gate-$rev.XXXXXX" 2>/dev/null)" || { tmp=/dev/null; shown="(no log: $logdir is not writable)"; }
trap '[ "$tmp" = /dev/null ] || mv -f "$tmp" "$log"' EXIT
# Host load at the start: shows whether a failure came under heavy load (other sessions' builds).
printf 'gate at %s%s in %s, started %s, load %s\n' "$rev" "$dirty" "$PWD" "$(date -Is)" "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)" >>"$tmp"
# section <name> <rc> <output>: one check's full output in the log.
section() { printf '\n===== %s (exit %s) =====\n%s\n' "$1" "$2" "$3" >>"$tmp"; }
fail() { printf '%s\n' "$2" | tail -n 15; echo "GATE FAIL at $rev$dirty: $1. Full log: $shown"; exit 1; }

# One line per failed test, no repeats: "<file>: <describe > test> [<ms>ms]", plus " (timed out)".
# A file that fails to load gives "<file>: unhandled error: <message>" (bun prints "error: x" or "TypeError: x").
# Sorted by file (bun's file order varies), test order kept: the same failures are listed in the same order.
failed_tests() {
  sed -e 's/\x1b\[[0-9;]*m//g' -e 's/^::group:://' -e '/^::endgroup::/d' | awk '
    function out(s) { if (!(s in seen)) { seen[s] = 1; print s } }
    pend != "" { if ($0 ~ /this test timed out/) pend = pend " (timed out)"; out(pend); pend = "" }
    /^[^ ].*\.(test|spec)\.[cm]?[jt]sx?:$/ { file = substr($0, 1, length($0) - 1); unhandled = 0; next }
    /^\(fail\) / { pend = file ": " substr($0, 8); next }
    /^# Unhandled error/ { unhandled = 1; next }
    unhandled && /^([A-Z][A-Za-z]*Error|error): / { m = $0; sub(/^error: /, "", m); out(file ": unhandled error: " m); unhandled = 0; next }
    END { if (pend != "") out(pend) }' | sort -s -t: -k1,1
}
# The first 3 names for the notice (backticks in names become quotes), then "+N more".
name_list() {
  awk -v q='`' 'NF { n++; gsub(/`/, "'\''"); if (n <= 3) s = s (n > 1 ? "; " : "") q substr($0, 1, 160) q }
    END { if (n > 3) s = s "; +" (n - 3) " more"; print n ? n " failed: " s : "" }'
}

for f in scripts/*.sh; do
  out="$(bash -n "$f" 2>&1)"; rc=$?
  [ "$rc" = 0 ] || { section "bash -n $f" "$rc" "$out"; fail "bash -n $f: $(head -n 1 <<<"$out")" "$out"; }
done
section "bash -n scripts/*.sh" 0 "all scripts parse"
out="$(timeout 300 node_modules/.bin/tsc --noEmit -p . 2>&1)"; rc=$?
section "typecheck (tsc --noEmit -p .)" "$rc" "$out"
[ "$rc" = 0 ] || fail "typecheck (tsc --noEmit -p .): $(grep -m1 'error' <<<"$out" | cut -c1-300 || echo "exit $rc")" "$out"
# CI=1: no watch, no interactive output. No FORCE_COLOR: colour output marks failures with a symbol, not "(fail)". No GITHUB_ACTIONS: bun then wraps files in ::group:: lines.
# --timeout: per-test budget (card bot-gate-flake, 2026-11-03). bun's 5 s default is a unit-test budget; this host
# shares 32 cores with other sessions' builds (load 60-130), and process-heavy integration tests (fm-spawn, the
# restart waiter) then took up to 11.2 s. The gate checks correctness, not host speed. A hung test still fails at
# 20 s; the whole run stops at 600 s. A timeout set on a test, or with setDefaultTimeout in its file, overrides it.
budget="${OMP_GATE_TEST_TIMEOUT_MS:-20000}"; [[ "$budget" =~ ^[0-9]+$ ]] || budget=20000
out="$(env -u FORCE_COLOR -u GITHUB_ACTIONS CI=1 timeout 600 bun test --timeout "$budget" 2>&1)"; rc=$?
section "tests (bun test)" "$rc" "$out"
if [ "$rc" != 0 ]; then
  all="$(failed_tests <<<"$out")"
  section "failed tests ($(grep -c . <<<"$all"))" "$rc" "$all"
  names="$(name_list <<<"$all")"
  [ "$rc" = 124 ] && names="timed out after 600 s${names:+; $names}"
  [ -n "$names" ] || names="exit $rc, $(grep -v '^[[:space:]]*$' <<<"$out" | tail -n 1)"
  fail "tests (bun test): $names" "$(grep -E '\(fail\)|error:|^ *[0-9]+ fail' <<<"$out" || echo "$out")"
fi
echo "GATE OK at $rev$dirty: bash -n, typecheck, tests"
