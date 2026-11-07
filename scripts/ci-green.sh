#!/usr/bin/env bash
# Deploy rule (owner 2026-10-19): the bot loads only a commit with a green GitLab pipeline.
# Usage: scripts/ci-green.sh <sha> [wait-seconds=0]
# Exit 0 = a pipeline for this exact SHA succeeded. Exit 1 = its newest pipeline failed or was canceled.
# Exit 2 = no finished pipeline (none, pending or running) within the wait, or GitLab was not readable.
# The last output line says which (for the Discord notice). The token is never printed.
# Test hooks: OMP_GITLAB_API (API base), OMP_GITLAB_TOKEN_FILE, OMP_GITLAB_PROJECT, OMP_CI_POLL (seconds), OMP_CI_SLEEP.
set -uo pipefail
SHA="${1:?usage: ci-green.sh <sha> [wait-seconds]}"
WAIT="${2:-0}"
API="${OMP_GITLAB_API:-http://127.0.0.1:8080/api/v4}"
TOKFILE="${OMP_GITLAB_TOKEN_FILE:-$HOME/.config/gitlab-main/token}"
PROJECT="${OMP_GITLAB_PROJECT:-owner%2Fomp-discord-bot}"
POLL="${OMP_CI_POLL:-20}"
SLEEP="${OMP_CI_SLEEP:-sleep}"
short="${SHA:0:7}"
# No GitLab configured (no OMP_GITLAB_API and no token file): skip the CI check, so a setup without GitLab can
# still restart. Set OMP_GITLAB_API or OMP_GITLAB_TOKEN_FILE to require a green pipeline.
if [ -z "${OMP_GITLAB_API:-}" ] && [ -z "${OMP_GITLAB_TOKEN_FILE:-}" ] && [ ! -e "$TOKFILE" ]; then
  echo "CI SKIPPED at $short: no GitLab configured"
  exit 0
fi
[ -r "$TOKFILE" ] || { echo "CI UNKNOWN at $short: GitLab token file is not readable"; exit 2; }

# Prints the status of the newest pipeline for SHA ("none" when there is none). Fails when GitLab is not readable.
status() {
  local body
  body="$(curl -fsS --max-time 10 -H "PRIVATE-TOKEN: $(cat "$TOKFILE")" \
    "$API/projects/$PROJECT/pipelines?sha=$SHA&order_by=id&sort=desc&per_page=20" 2>/dev/null)" || return 1
  # Any success counts (a retried pipeline may succeed after an older failure); else the newest status.
  jq -r 'if length == 0 then "none" elif any(.[]; .status == "success") then "success" else .[0].status end' <<<"$body" 2>/dev/null
}

waited=0
while :; do
  st="$(status)" || st="unreadable"
  [ -n "$st" ] || st="unreadable"
  case "$st" in
    success) echo "CI GREEN at $short"; exit 0 ;;
    failed|canceled|skipped) echo "CI FAILED at $short: pipeline $st"; exit 1 ;;
  esac
  if [ "$waited" -ge "$WAIT" ]; then
    echo "CI NOT GREEN at $short: pipeline $st"
    exit 2
  fi
  $SLEEP "$POLL"; waited=$((waited + POLL))
done
