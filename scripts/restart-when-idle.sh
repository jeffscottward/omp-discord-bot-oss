#!/usr/bin/env bash
# Wait until the bridge is idle, then scripts/safe-restart.sh, with Discord notices before and after.
# Idle = no running or queued job, no reply still being posted, owner not in the voice call.
# Plan P1 (no starvation): after DRAIN_AFTER seconds (default 600) the waiter turns on a drain through the
# loopback API (POST /drain). Then no new job starts (it stays queued; the board says "restart pending"),
# running jobs and approved commands finish, and the bot restarts. Waiting jobs are saved in
# state/queue.json and run after the start. The drain lasts 120 s unless renewed, so a lost waiter
# cannot stop the queue. Never restarts during a voice call (no drain while the owner is in the call).
# Before it waits, scripts/restart-gate.sh (bash -n, typecheck, bun test) must pass; else no restart.
# Give-up: after GIVE_UP_AFTER seconds (default 7200 = 2 h) of a busy bot (time in the voice call does not
# count), the waiter abandons this restart. No forced restart (it would kill running jobs and approved
# commands); the drain ends and ONE notice in #omp-alerts says what was still busy. Exit code 4.
# Lets a Discord run restart its own bridge without killing itself before its answer is posted.
# Usage: scripts/restart-when-idle.sh [rev] [timeout]   (run detached, e.g. via systemd-run --user --collect, so a refused run leaves no failed unit)
# Test hooks: OMP_RESTART_SLEEP (sleep command), OMP_RESTART_SAFE (restart command),
# OMP_RESTART_GATE (gate command), OMP_RESTART_NOTIFY (notice command), OMP_RESTART_LOCK (lock file),
# OMP_RESTART_ALERT (#omp-alerts notice command), OMP_RESTART_GIVE_UP_AFTER (seconds).
set -uo pipefail
cd "$(dirname "$0")/.."
# Single flight: a newer waiter replaces nothing; extra waiters exit at once.
# Lesson 2026-10-19: the drain holds the owner's new messages until the longest running turn ends (up to the
# 30-min run limit; a Example Activity turn held them 16 min). Check /health for long jobs before scheduling a restart.
exec 9>"${OMP_RESTART_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/omp-discord-restart.lock}"
flock -n 9 || { echo "another restart waiter is active; exiting"; exit 0; }
PORT="${OMP_BOT_HTTP_PORT:-47821}"
SLEEP="${OMP_RESTART_SLEEP:-sleep}"
SAFE="${OMP_RESTART_SAFE:-scripts/safe-restart.sh}"
GATE="${OMP_RESTART_GATE:-scripts/restart-gate.sh}"
NOTIFY="${OMP_RESTART_NOTIFY:-bun scripts/notify-owner.ts}"
DRAIN_AFTER="${OMP_RESTART_DRAIN_AFTER:-600}"
GIVE_UP_AFTER_DEFAULT=7200  # 2 h of a busy bot, then the pending restart is abandoned
GIVE_UP_AFTER="${OMP_RESTART_GIVE_UP_AFTER:-$GIVE_UP_AFTER_DEFAULT}"
# Owner 2026-10-15: restart notices are framed by rule lines with a 🤖 header, so they stand apart in the chat.
RULE="━━━━━━━━━━━━━━━━━━━━"
notify() { $NOTIFY "$(printf "%s\n🤖 **Bot restart**\n———————————\n%s\n%s" "$RULE" "$1" "$RULE")" || true; }
# One notice to one channel (OMP_NOTIFY_CHANNEL). notify-owner prints "posted <message id>"; --delete <id> removes one.
notify_to() { local c="$1"; shift; OMP_NOTIFY_CHANNEL="$c" $NOTIFY "$@" || true; }
# Channels with a job waiting in a /health snapshot (queue keys: "<id>", "mirror-<id>", "voice-<id>", "dm-<id>").
waiting_channels() {
  jq -r '[(.queued // [])[] | (.key // "") | tostring | sub("^(mirror|voice|dm)-"; "") | select(test("^[0-9]+$"))] | unique | .[:5] | .[]' <<<"$1" 2>/dev/null
}
health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null; }
# drain on|off [ttl-seconds]
drain() {
  local on=false; [ "$1" = on ] && on=true
  curl -fsS --max-time 3 -H 'content-type: application/json' -d "{\"on\":$on,\"ttlSec\":${2:-120}}" "http://127.0.0.1:$PORT/drain" >/dev/null 2>&1
}
draining=0
undrain() { if [ "$draining" = 1 ]; then drain off; draining=0; fi; }
# #omp-alerts through the bot's loopback /post; the owner channel (notify-owner) if the bot does not take it.
post_alert() {
  local body; body="$(jq -nc --arg t "$1" '{channel:"omp-alerts",text:$t}')" || return 1
  curl -fsS --max-time 5 -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$PORT/post" >/dev/null 2>&1
}
alert() {
  if [ -n "${OMP_RESTART_ALERT:-}" ]; then $OMP_RESTART_ALERT "$1" || true; return; fi
  post_alert "$1" || $NOTIFY "$1" || true
}
# What keeps the bot busy, in plain words, from one /health snapshot.
busy_summary() {
  jq -r '[
      ((.running // []) | length | select(. > 0) | "\(.) running job(s)"),
      ((.queued // []) | length | select(. > 0) | "\(.) queued job(s)"),
      ((.approvals // 0) | select(. > 0) | "\(.) approved command(s)"),
      ((.finishing // 0) | select(. > 0) | "\(.) reply(ies) still posting"),
      ((.boards // 0) | select(. > 0) | "\(.) queue-message update(s)")
    ] as $parts
    | (if ($parts | length) == 0 then "unknown" else ($parts | join(", ")) end)
    + ((.running // []) | map(.label // empty) | .[:3] | if length > 0 then " (running: " + join(", ") + ")" else "" end)' <<<"$1" 2>/dev/null \
    || echo "unknown (/health was not readable)"
}
trap undrain EXIT

# Check the new code first: never drain or wait for code that would not load.
gate="$($GATE 2>&1)"
if [ $? -ne 0 ]; then
  echo "$gate"
  notify "⚠️ **Restart skipped:** the checks failed, so the bot keeps its current code. $(tail -n 1 <<<"$gate"). Fix it and queue the restart again."
  exit 3
fi
echo "$(tail -n 1 <<<"$gate")"
$SLEEP 20
# Owner 2026-10-14: never restart during a voice call, however long that takes
# (the old 2 h give-up restarted mid-call). One Discord notice if the wait passes DRAIN_AFTER.
waited=0; told=0; down=0; stuck=0
while :; do
  if h="$(health)"; then
    down=0
    # Older builds have no "finishing"/"boards" field: treat a missing field as 0.
    # "boards" = queue-message reprints still pending (the final 🏁 Finished post runs 1.5 s after the last answer).
    # Read the TOP-LEVEL fields with jq: /health also holds `stacks[]` with their own (often empty) running/queued
    # lists, so a text grep for "running":[] matched a quiet stack while a job still ran (audit 2026-10-25).
    # Unreadable snapshot = busy (never restart on a guess).
    st="$(jq -r '[
        (if .voice == true then 1 else 0 end),
        (if ((.running // []) | length) > 0 or (.finishing // 0) > 0 or (.boards // 0) > 0 or (.approvals // 0) > 0 then 1 else 0 end),
        (if ((.queued // []) | length) == 0 then 1 else 0 end),
        (if (.drain.draining // .draining // false) == true then 1 else 0 end)
      ] | map(tostring) | join(" ")' <<<"$h" 2>/dev/null)" || st=""
    [ -n "$st" ] || st="0 1 0 0"
    read -r voice busy qempty drainon <<<"$st"
    # Require an empty queue too: the next job starts in the same ms the last one ends, but one poll can land in that gap.
    [ "$busy" = 0 ] && [ "$voice" = 0 ] && [ "$qempty" = 1 ] && break
    # Drain on in THIS snapshot: no job can have started since, so queued jobs may stay (they are saved).
    [ "$busy" = 0 ] && [ "$voice" = 0 ] && [ "$draining" = 1 ] && [ "$drainon" = 1 ] && break
    # Busy outside the voice call counts toward the give-up (owner 2026-10-14: voice waits stay unlimited).
    if [ "$voice" = 0 ]; then
      stuck=$((stuck + 10))
      if [ "$stuck" -ge "$GIVE_UP_AFTER" ]; then
        undrain
        alert "$(printf "%s\n🤖 **Bot restart abandoned**\n———————————\nThe bot stayed busy for %s min, so the pending restart (new code \`%s\`) was dropped instead of killing work. Still busy: %s. New jobs run again. Queue the restart again when it is quiet (\`/restart\`).\n%s" \
          "$RULE" "$((GIVE_UP_AFTER / 60))" "$(git rev-parse --short HEAD)" "$(busy_summary "$h")" "$RULE")"
        echo "gave up after ${GIVE_UP_AFTER}s busy"
        exit 4
      fi
    fi
    if [ "$voice" = 1 ]; then
      undrain  # the owner talks in the call: let the queue run
    elif [ "$waited" -ge "$DRAIN_AFTER" ]; then
      drain on 120 && draining=1
    fi
    # Owner in the call: say once why the restart waits. Outside the call the queue board's "Restart pending"
    # line says it, with the job that holds the drain (UX item 6: no separate notice in the owner channel).
    if [ "$told" = 0 ] && [ "$waited" -ge "$DRAIN_AFTER" ] && [ "$voice" = 1 ]; then
      notify "🕓 **Bot restart pending** (new code is ready). Waiting because you are in 🎧 OMP Voice; it restarts as soon as you leave."
      told=1
    fi
  else
    down=$((down + 1))  # bridge unreachable: no call or job to protect; restart after ~3 min
    [ "$down" -ge 18 ] && break
  fi
  $SLEEP 10; waited=$((waited + 10))
done
# Hold the drain through the restart checks (the bot stops, so the drain ends with it).
[ "$draining" = 1 ] && drain on 1800
OLD="$(git rev-parse --short HEAD)"
# UX item 6 (owner pick 2026-10-23): restart notices go only to the channels where a job waits for the restart
# (queued in the last /health snapshot). A quiet restart posts nothing: the queue boards already show
# "Restart pending" and then "Restarted". The "Restarting" post is deleted when "Restart done" is posted.
# Failures always go to the owner channel too.
chans="$(waiting_channels "${h:-}")"
opened=()
for c in $chans; do
  id="$(notify_to "$c" "$(printf "%s\n🤖 **Bot restart**\n———————————\n%s\n%s" "$RULE" "🔄 **Restarting the bot now** (loading \`$OLD\`). Your waiting message runs after the restart; please wait for ✅ before you send more." "$RULE")" | sed -n 's/^posted //p')"
  opened+=("$c:$id")
done
START=$(date +%s)
out="$($SAFE "${1:-HEAD}" "${2:-60}" 2>&1)"; rc=$?
echo "$out"
secs=$(( $(date +%s) - START ))
case $rc in
  0) draining=0; msg="✅ **Restart done** in ${secs}s. The bot is running \`$(git rev-parse --short HEAD)\`. Your waiting message runs now." ;;
  1) draining=0; msg="⚠️ **Restart failed; the change was reverted.** The bot is back up at \`$(git rev-parse --short HEAD)\` with trusted mode off." ;;
  3) msg="⚠️ **Restart skipped:** the checks failed, so the bot keeps its current code. $(grep -m1 'NOT RESTARTED' <<<"$out" | sed 's/^NOT RESTARTED: //'). Fix it and queue the restart again." ;;
  *) draining=0; msg="❌ **Restart failed and the bot is still down.** It needs a manual fix on the main host." ;;
esac
for o in ${opened[@]+"${opened[@]}"}; do  # empty-array safe under set -u on old bash
  c="${o%%:*}"; id="${o#*:}"
  [ "$rc" = 0 ] && [ -n "$id" ] && notify_to "$c" --delete "$id" >/dev/null
  notify_to "$c" "$(printf "%s\n🤖 **Bot restart**\n———————————\n%s\n%s" "$RULE" "$msg" "$RULE")" >/dev/null
done
[ "$rc" = 0 ] || notify "$msg"
exit $rc
