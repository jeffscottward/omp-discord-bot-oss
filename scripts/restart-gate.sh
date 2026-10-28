#!/usr/bin/env bash
# Plan P1: checks that must pass before the bot restarts onto the code in this checkout.
# Runs: bash -n on every script, the typecheck (tsc --noEmit -p .) and the full test suite (bun test).
# Exit 0 = all passed. Exit 1 = a check failed; the last line of output says which one (for the Discord notice).
# Usage: scripts/restart-gate.sh [repo-dir=this checkout]
set -uo pipefail
cd "${1:-$(dirname "$0")/..}" || { echo "GATE FAIL: no repo dir"; exit 1; }
rev="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
dirty=""; [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] && dirty=" (with uncommitted changes)"
fail() { printf '%s\n' "$2" | tail -n 15; echo "GATE FAIL at $rev$dirty: $1"; exit 1; }

for f in scripts/*.sh; do
  out="$(bash -n "$f" 2>&1)" || fail "bash -n $f" "$out"
done
out="$(timeout 300 node_modules/.bin/tsc --noEmit -p . 2>&1)" || fail "typecheck (tsc --noEmit -p .)" "$out"
# CI=1: no watch, no interactive output.
out="$(CI=1 timeout 600 bun test 2>&1)" || fail "tests (bun test)" "$(grep -E '\(fail\)|error:|^ *[0-9]+ fail' <<<"$out" || echo "$out")"
echo "GATE OK at $rev$dirty: bash -n, typecheck, tests"
