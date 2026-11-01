#!/usr/bin/env bash
# Restart the bridge with a safety net: if /health does not report ready within the timeout,
# revert the given commit(s), leave trusted mode (flag + sudoers via trusted.sh off), restart again.
# Plan P1: first scripts/restart-gate.sh (bash -n, typecheck, bun test) on the code that will load;
# if a check fails, the bot is NOT restarted (exit 3, the reason is the last output line).
# Usage: scripts/safe-restart.sh [<rev-to-revert-on-failure>=HEAD] [timeout-seconds=45]
set -uo pipefail
cd "$(dirname "$0")/.."
REV="${1:-HEAD}"
TIMEOUT="${2:-45}"
UNIT=omp-discord-bot.service
PORT="${OMP_BOT_HTTP_PORT:-47821}"
REV_SHA="$(git rev-parse --verify "$REV^{commit}")" || { echo "bad rev $REV" >&2; exit 64; }

healthy() {
  local deadline=$((SECONDS + TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    if systemctl --user is-active --quiet "$UNIT" &&
       curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ready":[[:space:]]*true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Uncommitted changes to tracked files would load code the gate did not check against a commit.
git diff --quiet HEAD || { echo "NOT RESTARTED: the checkout has uncommitted changes" >&2; exit 3; }
GATED="$(git rev-parse HEAD)"
gate="$(scripts/restart-gate.sh 2>&1)"
if [ $? -ne 0 ]; then
  echo "$gate" >&2
  echo "NOT RESTARTED: $(tail -n 1 <<<"$gate")" >&2
  exit 3
fi
echo "$(tail -n 1 <<<"$gate")"
# Hold the integrate lock (ff-merges take it) from the HEAD check through the start, so no merge lands
# between check and load. Wait at most 30 s: a caller inside that lock (integration step) must not deadlock;
# then the HEAD check alone applies.
exec 8>"${OMP_INTEGRATE_LOCK:-/tmp/omp-discord-bot-integrate.lock}"
flock -w 30 8 || echo "warn: integrate lock busy; continuing with the HEAD check only" >&2
# Gated-commit rule: HEAD must still be the commit the gate checked.
NOW="$(git rev-parse HEAD)"
if [ "$NOW" != "$GATED" ]; then
  echo "NOT RESTARTED: HEAD moved from ${GATED:0:7} to ${NOW:0:7} during the checks" >&2
  exit 3
fi
# Deploy rule: the exact SHA that loads needs a green GitLab pipeline (no wait here: the integrate lock is held).
# OMP_SAFE_RESTART_CI = test hook. A failure revert below loads without CI on purpose (recovery).
ci="$(${OMP_SAFE_RESTART_CI:-scripts/ci-green.sh} "$NOW" 0 2>&1)" || { echo "$ci" >&2; echo "NOT RESTARTED: $(tail -n 1 <<<"$ci")" >&2; exit 3; }
echo "$(tail -n 1 <<<"$ci")"
systemctl --user restart "$UNIT"
if healthy; then echo "OK: $UNIT healthy at $(git rev-parse --short HEAD)"; exit 0; fi

echo "FAIL: $UNIT not healthy within ${TIMEOUT}s; reverting ${REV_SHA:0:7} and leaving trusted mode" >&2
journalctl --user -u "$UNIT" -n 30 --no-pager >&2 || true
git revert --no-edit "$REV_SHA" || { git revert --abort 2>/dev/null; echo "revert failed; manual fix needed" >&2; }
scripts/trusted.sh off || true
systemctl --user restart "$UNIT"
if healthy; then echo "RECOVERED at $(git rev-parse --short HEAD) (trusted mode off)" >&2; exit 1; fi
echo "STILL UNHEALTHY after revert; manual fix needed" >&2
exit 2
