# FIRSTMATE kit

The FIRSTMATE kit is the set of tools that runs next to the Discord bot: the tracker CLI (`fm`), the tracker
automation (auto-clear, sweep, tab watch), the FIRSTMATE dashboard (a phone-friendly web page), the report server,
the iOS Reminders inbox, and their systemd user units. On the owner's machine these files lived outside the repo.
This folder holds portable copies. All personal values (paths, URLs, channel ids, host names) are settings in one
file: `~/.config/omp-discord/kit.env`.

Setup steps for the whole bot (Discord app, Tailscale, iPhone Shortcut, voice): see `docs/SETUP.md`.

## Install

```bash
kit/install.sh --dry-run      # show what it does; writes nothing outside /tmp
kit/install.sh                # install (idempotent)
kit/install.sh --enable       # also daemon-reload and enable + start the timers, path units and services
kit/test.sh                   # self-tests on a scratch copy (your data is not changed)
```

`install.sh` does these steps:

1. Creates `~/.config/omp-discord/kit.env` from `kit.env.example` when it is missing (mode 600). Edit it.
2. Links every `kit/bin/*` command (and the repo's `scripts/fm-spawn`) into `~/.local/bin` (or `--prefix DIR`).
3. Copies the dashboard app (`dashboard/web/*`) and the agent instructions (`dashboard/docs/*.md`) into `FM_DIR`.
   It creates an empty `items.json` when there is none (`--fixtures`: the example cards). It never overwrites
   tracker data (`items.json`, `running.json`, `receipts/` …).
4. Renders `kit/systemd/*` into `~/.config/systemd/user/` (`@KIT@`, `@FM_DIR@`, `@BUN@` are replaced).
5. With `--enable` only: `systemctl --user daemon-reload` and `enable --now` for each timer, path unit and
   long-running service it installed, except the units in `KIT_SKIP_UNITS`.

An existing file that differs from the kit copy (for example your own edited unit) is kept, and the installer
tells you. `--force` replaces it and saves the old file as `<name>.bak-kit-<time>`. With a scratch home
(`HOME=/tmp/x kit/install.sh`), the installer never calls `systemctl`.

## Settings (`kit.env`)

Every key, its default and its meaning are in [`kit.env.example`](kit.env.example). Format: `KEY=VALUE` lines;
double quotes expand `$HOME` and earlier keys, single quotes keep the text (use them for regex values). A variable
that is already set in the environment wins over the file. Use another file with `OMP_KIT_ENV=/path/kit.env`.

Main keys: `REPORTS_WEB_DIR`, `FM_DIR` (must be `$REPORTS_WEB_DIR/firstmate`), `FM_DASHBOARD_URL`, `REPORTS_PORT`,
`REPORTS_BIND`, `OMP_BOT_REPO`, `OMP_BOT_POST_URL`, `FM_ALERTS_CHANNEL`, `FM_CHANNEL`, `OMP_NOTIFY`, `HERDR_BIN`,
`AUTH_PANE_NOTIFY_TRANSPORT`, `FM_HOST_LABEL`, `FM_SERVICE_GROUPS`, `FM_PEER_*` (optional second machine), `REMINDERS_*`, `FM_TESTS_LIVE`,
`PUPPETEER_CORE`, `CHROME_BIN`, `KIT_SKIP_UNITS`.

## Pieces

| Piece | What it does | Unit / timer | Source on the owner's machine |
|---|---|---|---|
| `bin/fm` | Tracker CLI: find/get/set/add cards, question links (`q`), fields, worker receipts, heartbeats. Writes `items.json` under a file lock. | – | `~/.local/bin/fm` |
| `bin/fm-autoclear` | Deterministic tracker rules (R1–R12): closes cards from status reports and receipts, moves cards between running/partial, flags silent jobs, writes `idle.json`. No LLM calls. `--test` runs its self-test. | `fm-autoclear.timer` (every minute) | `~/.local/bin/fm-autoclear` |
| `bin/fm-tabwatch` | Closes finished `fm-spawn` Herdr tabs; alerts on tab and sign-in pile-ups. `--test`. | `fm-tabwatch.timer` (2 min) | `~/.local/bin/fm-tabwatch` |
| `bin/firstmate-sweep` | Starts ONE OMP sweep session in a new Herdr tab for idle cards (`idle.json`), with a 45 min deadline. | `firstmate-sweep.timer` (2 h) | `~/.local/bin/firstmate-sweep` |
| `bin/firstmate-tests` | Runs the dashboard contract tests; `--alert` posts once per incident. | `firstmate-tests.timer` (30 min) + `firstmate-tests.path` (fm/app.js changed) | `~/.local/bin/firstmate-tests` |
| `bin/fm-prwatch` | Closes cards whose linked GitHub PR (`l`, `src`, `q`) merged; a PR closed unmerged → partial "needs check". Running/job cards and `FM_SKIP_AREAS` are only logged. Needs a logged-in `gh`. `--dry-run`. | `fm-prwatch.timer` (1 min) | `~/.local/bin/fm-prwatch` |
| `bin/auth-pane` | Opens ONE Herdr sign-in pane per login (no sign-in loops); one notice per pane. `--test`. | – | `~/.local/bin/auth-pane` |
| `bin/fm-notify` | Default alert sender (new): posts `--kind/--summary/--action` to `FM_ALERTS_CHANNEL` through the bot's `/post`. Set `OMP_NOTIFY` to use another sender. | – | new (replaces the owner's `omp-notify` for other users) |
| `bin/longjob` | Wrapper for the bot's `gate/longjob.ts` (status every 5 min in the long-running-jobs channel). | – | `~/.local/bin/longjob` |
| `bin/md2pdf` | Markdown → phone-friendly PDF (bunx marked + headless Chrome). | – | `~/.local/bin/md2pdf` |
| `scripts/fm-spawn` (repo) | Starts a side session for a card in a new Herdr tab. Not duplicated here; `install.sh` links it. | – | `~/.local/bin/fm-spawn` → repo (already the live copy) |
| `dashboard/web/` | The FIRSTMATE dashboard (index.html, app.js, manifest, icons). Reads `items.json`, `running.json`, `reports.json`, `changes.json`, `limits.json`. | served by `omp-reports-web` | `~/Documents/reports/web/firstmate/` |
| `dashboard/build-index.py` | Writes `reports.json` (every report under `REPORTS_WEB_DIR`) and `changes.json`. | `firstmate-index.timer` (1 min) + `firstmate-index.path` (items.json changed) | same folder |
| `dashboard/build-running.py` | Writes `running.json`: OMP jobs from Herdr, user units (grouped by `FM_SERVICE_GROUPS`), optional peer host over ssh. Read-only. | `firstmate-running.timer` (30 s) | same folder |
| `dashboard/docs/` | `task-template.md`, `sweep-task.md` (agent instructions), `deeplink-contract.md` (URL + UI contracts). Copied into `FM_DIR`. | – | same folder |
| `dashboard/tests/` | `fm-unit-test.py` and browser tests (`*-e2e.cjs`, puppeteer-core) with a shared `lib.cjs`. | via `firstmate-tests` | same folder |
| `dashboard/fixtures/` | Example data (10 fake cards, running/reports/changes/limits) for tests and demos. | – | new |
| `web/serve.py` | Static report server: Range requests (iOS audio/video) and `no-cache`. Loopback only; publish with `tailscale serve /reports`. | `omp-reports-web.service` | `~/.local/share/omp-reports-web/serve.py` |
| `reminders-inbox/` | iOS Reminders inbox (`server.ts`: POST /reminders, GET /delete-queue, GET /add-queue) and the 8 AM digest (`daily.ts`). | `reminders-inbox.service`, `reminders-daily.timer` | `~/Github/tools/reminders-inbox/` |
| `install.sh`, `test.sh` | Installer and self-tests (see above). | – | new |

Data written at run time (never in the repo): `FM_DIR/{items,running,reports,changes,idle,limits}.json`,
`receipts/`, `sweep-runs/`, `*.log`; `~/.local/state/{fm-spawn,fm-tabwatch,auth-pane,firstmate-tests}/`;
`~/.cache/{fm-autoclear,firstmate-dashboard}/`; `REMINDERS_DIR`.

## Not included (and why)

| Piece | Reason |
|---|---|
| `firstmate-dbsync.{service,timer,path}`, `firstmate-trailbase.service`, `firstmate-front-preview.service` | Dashboard v4 (Vike + TrailBase) from a separate, experimental repo; the v3 dashboard in this kit does not need it. |
| `darkfactory-*`, `omp-procedura-*`, `ex-remote-*`, `github-discord-feed`, `omp-postboot.service` | Owner-only services. |
| Finance pieces (market watch, status monitors, peer finance host) | Owner-only. The peer-host view in `build-running.py` is generic (`FM_PEER_*`); the owner's values live only in his own kit.env. |
| `omp-lofi-radio.service`, `omp-discord-bot.service`, `omp-tts.service`, `omp-whisper.service`, `channel-cleanup.*` | Already in the repo (`scripts/omp-lofi-radio.service`, `systemd/`); installed by `scripts/bootstrap.sh`. |
| `omp-notify` (owner's ntfy/Discord alert sender) | Owner-specific; `bin/fm-notify` replaces it. Point `OMP_NOTIFY` at your own sender if you have one. |
| `state-semantics-by-e2e.cjs` | Depends on the owner's live cards. |
| `tailscale serve` configuration | A manual step: `tailscale serve --bg --set-path /reports http://127.0.0.1:8790` (see `docs/SETUP.md`). |
| Backups (`*.bak*`, `*.before-*`), logs, tracker data, task files, screenshots | Private run-time data. |

## Tests

```bash
kit/test.sh                 # all self-tests on a scratch copy; browser tests skip when node/puppeteer-core/Chrome are missing
kit/test.sh --no-browser    # without the browser tests
firstmate-tests             # installed contract tests (fixture copy of your installed app)
firstmate-tests --live      # browser tests against the live dashboard (FM_DASHBOARD_URL); data replaced in the browser only
kit/bin/fm-autoclear --test; kit/bin/fm-tabwatch --test; kit/bin/auth-pane --test
```

The browser tests need Node.js, `puppeteer-core` (`npm i -g puppeteer-core`, or set `PUPPETEER_CORE` to a
`node_modules/puppeteer-core` folder) and Chrome or Chromium (`CHROME_BIN`).
