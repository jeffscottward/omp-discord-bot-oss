#!/usr/bin/env bash
# kit/test.sh: self-tests for the FIRSTMATE kit. Safe to run at any time: every test uses a scratch folder
# (mktemp) with the example cards from kit/dashboard/fixtures; your real tracker data and settings are not changed.
# Steps: syntax checks (bash -n, shellcheck when installed, python compile, node --check, bun build), unit tests
# (fm, fm-autoclear, fm-tabwatch, auth-pane), smoke runs of the commands on the scratch dashboard, the report server,
# and the dashboard browser tests (skipped with a message when node, puppeteer-core or Chrome is missing).
# Usage: kit/test.sh [--no-browser]
# PUPPETEER_CORE and CHROME_BIN are taken from the environment or from your kit.env when set there.
set -uo pipefail

KIT=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BROWSER=1
[ "${1:-}" = "--no-browser" ] && BROWSER=0
SCRATCH=$(mktemp -d /tmp/omp-kit-test.XXXXXX)
SRV_PID=""
cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT

# Browser test settings from the user's kit.env (only these two keys; nothing else is read from it).
USER_ENV="${OMP_KIT_ENV:-$HOME/.config/omp-discord/kit.env}"
for k in PUPPETEER_CORE CHROME_BIN; do
  if [ -z "${!k:-}" ] && [ -r "$USER_ENV" ]; then
    line=$(grep -E "^(export )?$k=" "$USER_ENV" | tail -n 1 || true)
    [ -n "$line" ] && eval "export ${line#export }"
  fi
done

# Scratch settings: every kit script reads this file instead of the user's kit.env.
export OMP_KIT_ENV="$SCRATCH/kit.env"
cat > "$OMP_KIT_ENV" <<EOF
REPORTS_WEB_DIR="$SCRATCH/web"
FM_DIR="$SCRATCH/web/firstmate"
REPORTS_PORT=0
OMP_BOT_ENV="$SCRATCH/no-bot.env"
OMP_BOT_POST_URL="http://127.0.0.1:9/post"
OMP_NOTIFY="$SCRATCH/notify"
HERDR_BIN="$SCRATCH/no-herdr"
FM_TESTS_LIVE=0
EOF
printf '#!/bin/sh\necho "$*" >> "%s/notify.log"\n' "$SCRATCH" > "$SCRATCH/notify"; chmod +x "$SCRATCH/notify"
unset BASE FM_DIR REPORTS_WEB_DIR FM_ITEMS OMP_NOTIFY HERDR_BIN
export PYTHONPYCACHEPREFIX="$SCRATCH/pycache" PYTHONDONTWRITEBYTECODE=1
FM="$SCRATCH/web/firstmate"
mkdir -p "$FM/receipts"
cp "$KIT"/dashboard/web/* "$KIT"/dashboard/docs/* "$KIT"/dashboard/fixtures/* "$FM/"

pass=0; fail=(); skip=()
t() { # t NAME COMMAND...: run, keep the output in the scratch log, show a short line
  local name=$1; shift
  if "$@" > "$SCRATCH/out.txt" 2>&1; then pass=$((pass+1)); echo "ok   $name"
  else fail+=("$name"); echo "FAIL $name"; sed -n '1,40p' "$SCRATCH/out.txt" | sed 's/^/     | /'; fi
}
s() { skip+=("$1"); echo "skip $1: $2"; }
has() { command -v "$1" >/dev/null 2>&1; }

echo "== syntax"
SH=("$KIT/install.sh" "$KIT/test.sh" "$KIT/bin/firstmate-tests" "$KIT/bin/longjob" "$KIT/bin/md2pdf")
for f in "${SH[@]}"; do t "bash -n $(basename "$f")" bash -n "$f"; done
if shellcheck --version >/dev/null 2>&1; then t "shellcheck" shellcheck -S warning "${SH[@]}"; else s shellcheck "not installed"; fi
PY=("$KIT/bin/fm" "$KIT/bin/fm-autoclear" "$KIT/bin/fm-tabwatch" "$KIT/bin/firstmate-sweep" "$KIT/bin/auth-pane"
    "$KIT/bin/fm-notify" "$KIT/bin/fm-prwatch" "$KIT/dashboard/build-index.py" "$KIT/dashboard/build-running.py" "$KIT/dashboard/tests/fm-unit-test.py"
    "$KIT/web/serve.py")
for f in "${PY[@]}"; do t "py_compile $(basename "$f")" python3 -m py_compile "$f"; done
if has node; then
  for f in "$KIT"/dashboard/web/app.js "$KIT"/dashboard/tests/*.cjs; do t "node --check $(basename "$f")" node --check "$f"; done
else s "node --check" "node not installed"; fi
if has bun; then
  for f in server.ts daily.ts; do t "bun build reminders-inbox/$f" bun build --target=bun "$KIT/reminders-inbox/$f" --outdir "$SCRATCH/bunout-$f"; done
  t "reminders daily digest (dry run)" bun "$KIT/reminders-inbox/daily.ts" --dry-run
else s "bun build" "bun not installed"; fi

echo "== unit tests"
t "fm unit tests" env FM_BIN="$KIT/bin/fm" python3 "$KIT/dashboard/tests/fm-unit-test.py"
t "fm-autoclear --test" python3 "$KIT/bin/fm-autoclear" --test
t "fm-tabwatch --test" python3 "$KIT/bin/fm-tabwatch" --test
t "auth-pane --test" python3 "$KIT/bin/auth-pane" --test

echo "== smoke (scratch dashboard $FM)"
t "fm find" sh -c "python3 '$KIT/bin/fm' find setup | grep -q finish-setup"
t "fm get" sh -c "python3 '$KIT/bin/fm' get demo-job | grep -q '\"s\": \"running\"'"
t "fm needs" sh -c "python3 '$KIT/bin/fm' needs | grep -q needs-your-step"
t "fm set" sh -c "FM_BY=kit-test python3 '$KIT/bin/fm' set plain-progress done 'smoke test' && python3 '$KIT/bin/fm' get plain-progress | grep -q '\"by\": \"kit-test\"'"
mkdir -p "$SCRATCH/fakegh"; printf '#!/bin/sh\necho "{\\"state\\":\\"MERGED\\",\\"mergedAt\\":\\"t\\",\\"mergeCommit\\":{\\"oid\\":\\"abcdef1\\"}}"\n' > "$SCRATCH/fakegh/gh"; chmod +x "$SCRATCH/fakegh/gh"
t "fm-prwatch --dry-run" sh -c "python3 '$KIT/bin/fm' field pick-theme l https://github.com/o/r/pull/1 >/dev/null && PATH='$SCRATCH/fakegh':\$PATH python3 '$KIT/bin/fm-prwatch' --dry-run | grep -q 'merged abcdef1'"
t "fm receipt" sh -c "python3 '$KIT/bin/fm' receipt nightly-build done 'smoke' --evidence test && test -s '$FM/receipts/nightly-build.json'"
t "fm refuses a non-Discord q" sh -c "! python3 '$KIT/bin/fm' q pick-theme https://example.com/x 2>/dev/null"
t "build-index.py" sh -c "python3 '$KIT/dashboard/build-index.py' && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d[\"reports\"], list)' '$FM/reports.json'"
t "fm-autoclear --dry-run" python3 "$KIT/bin/fm-autoclear" --dry-run
t "firstmate-sweep --dry-run" python3 "$KIT/bin/firstmate-sweep" --dry-run
t "fm-notify --dry-run" sh -c "python3 '$KIT/bin/fm-notify' --dry-run --kind test --summary 'kit self-test' | grep -q '\"channel\"'"
if has systemctl || has herdr; then
  # build-running.py only reads (herdr pane list, systemctl --user show); it writes running.json in the scratch folder.
  t "build-running.py" sh -c "timeout 120 python3 '$KIT/dashboard/build-running.py' && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert \"services\" in d and d[\"hostLabel\"]' '$FM/running.json'"
  cp "$KIT/dashboard/fixtures/running.json" "$FM/running.json"  # the browser tests expect the fixture
else s "build-running.py" "no systemctl or herdr"; fi

echo "== report server"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
REPORTS_PORT=$PORT python3 "$KIT/web/serve.py" >/dev/null 2>&1 &
SRV_PID=$!
t "serve.py serves /firstmate/" python3 - "$PORT" <<'EOF'
import sys, time, urllib.request
for _ in range(50):
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/firstmate/index.html", timeout=2)
        body = r.read().decode()
        assert "app.js" in body and r.headers.get("Cache-Control") == "no-cache"
        req = urllib.request.Request(f"http://127.0.0.1:{sys.argv[1]}/firstmate/items.json", headers={"Range": "bytes=0-9"})
        assert urllib.request.urlopen(req, timeout=2).status == 206
        sys.exit(0)
    except OSError:
        time.sleep(0.1)
sys.exit(1)
EOF
kill "$SRV_PID" 2>/dev/null; SRV_PID=""

echo "== dashboard browser tests (fixtures)"
if [ $BROWSER = 0 ]; then s "browser tests" "--no-browser"
elif ! has node; then s "browser tests" "node not installed"
elif ! export NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null || true)}" || ! (cd "$KIT/dashboard/tests" && node -e 'require("./lib.cjs").chrome(); require(process.env.PUPPETEER_CORE || "puppeteer-core")' >/dev/null 2>&1); then
  s "browser tests" "puppeteer-core or Chrome/Chromium not found (npm i -g puppeteer-core, or set PUPPETEER_CORE / CHROME_BIN in kit.env)"
else
  export FM_WEB_DIR="$KIT/dashboard/web" OUT="$SCRATCH/shots"
  for f in "$KIT"/dashboard/tests/*-e2e.cjs; do t "$(basename "$f")" timeout 240 node "$f"; done
fi

echo
n=${#fail[@]}
echo "$([ "$n" = 0 ] && echo PASS || echo FAIL): $pass passed, $n failed${fail[*]:+ (${fail[*]})}, ${#skip[@]} skipped${skip[*]:+ (${skip[*]})}"
[ "$n" = 0 ]
