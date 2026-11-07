# Task: <short name> (card <card-id>)

Template for FIRSTMATE side-session task files (Orca #3, 2026-10-19). Copy it to `<card-id>-task.md` next to items.json and fill in each section. Keep the last section ("Finish: receipt") in every task file.

Flow: full|short
(Required; keep one value. Process: ~/Documents/reports/web/firstmate/flow.md. short = config/text/one-file edit with no deploy; else full. fm-spawn refuses a task file without this line and the `## Acceptance check` section.)

Claims: none
(Optional. Resources this job will change, so no other job takes them: `pr:<repo>#<n>`, `branch:<repo>:<name>`, `deploy:<target>`, `file:<repo>:<path-glob>`, `service:<unit>`, comma separated. fm-spawn takes them at start and refuses the spawn when another live job holds one.)

## Target
- Files, repos, units and hosts to change. Name what is out of scope.

## Steps
1. <step>
2. <step>

## Rules
- Push, PRs, merges and deploys: standing owner approval (2026-10-31, msg 100000000000000050) under these gates: CI green on the exact commit before merge/deploy, never `--no-verify`, never force-push shared branches, never delete anything on GitHub. Service restarts outside a repo's own restart script, deletions, and finance actions still need the owner's approval recorded on the card. `omp-approve` does not work in Herdr panes.
- Owner questions only through the bot loopback /post with a fenced ```ask JSON block. Options are plain strings or {"label": "…", "description": "…"} objects; /post answers 400 with the reason for any other shape. Pass `"replyTo": "<the owner's request message id or link>"` so the menu shows which request it answers. Use the `id`/`url` that /post returns for card `q` links (no bot token): `GET 127.0.0.1:47821/asks` lists open menus with links, `GET /messages?channel=<name or id>&limit=20` reads a channel (redacted).
- Need a token or key from the owner: `bun ~/Github/tools/omp-discord-bot/scripts/secret-drop.ts --name "<label>" --dest ~/.config/<app>/<file>` (one-time tailnet form, saved as a 0600 file, never through Discord or a model). Never ask for a secret in Discord or a pane.
- Back up files before you edit them. Finance cards are worked like any card (owner 2026-10-31). Hard limit: never arm finance, never place or change live orders, never change risk settings (sizes, caps, gates, kill switches), never start, stop, restart or reconfigure live finance units or timers; those stay owner decisions (one ask menu).
- Heartbeat: a running card with no pane activity and no `fm beat` for 30 min is flagged "silent 30 min; no receipt; needs check". The pane counts as active only between tool calls, so one long command (build, download, test suite, `longjob`) needs a background beat. Run it in the same shell command: `( while sleep 900; do fm beat <card-id> "<what runs>"; done ) & B=$!; <long command>; rc=$?; kill $B; (exit $rc)`

## Coordination (owner 2026-11-04, card agent-coordination-protocol)
- One live job per card: fm-spawn refuses a second job for a card with a live job (exit 7). Talk to that job or end it first.
- Before each new step run `fm board --stack <your stack>` (running jobs, their status and claims). Post a status line every 10-15 min: `fm status <card-id> "<one line>"` (or `fm beat <card-id> "<note>"`, which also sets it).
- Before you touch a shared PR, branch, deploy target, file area or service: `fm claim <card-id> <resource>`. Exit 4 = another job holds it; the refusal names the holder card, pane and channel. Wait, or agree a split with that job. `fm release <card-id> [resource]` when done; the receipt releases everything.
- The coordinator (fm-coord, every 5 min) posts overlaps and waits in the stack thread and may prompt your pane. Follow its note or answer it in your status.

## Acceptance check
(Required. Write it before any change. fm-spawn refuses a task file without it.)
- <observable pass/fail check, the real target it runs on, and the command or page that proves it>

## Finish: receipt (required, last step)
Write the worker-done receipt. fm-autoclear applies it to the card within one minute:
- Done: `fm receipt <card-id> done "<one-line result>" --verified live|tests --evidence "<commit/file/unit/URL>" [--evidence ...]`
  (`--verified`: how you proved it. live = run on the real surface; tests = automated tests. fm refuses a done receipt with `none`/`typecheck` or without `--evidence`; Flow: full also needs one CI or review evidence item. Not verified yet: send failed or blocked, never done.)
- Owner decisions go to FIRSTMATE as an ask menu; never only in a report. Before a done receipt, post ONE ```ask block, with each open decision as one question, in YOUR OWN job channel: bot /post to channel `main-github-firstmate` (id `100000000000000051`) with `"pane": "<your Herdr pane id>"` and `"card": "<card>"` in the body; the bot moves the menu to your job channel and FIRSTMATE gets only a one-line link, and pass `--q <menu URL>`. `fm receipt ... done` refuses a summary or .md/.html evidence file with an open "Decisions for you"/"Needs you"/"Owner decision"/"Open questions" section; pass `--decisions-none` when nothing is open.
- Failed: `fm receipt <card-id> failed "<what failed and where the log is>"`
- Blocked on the owner (you posted an ask): `fm receipt <card-id> blocked "<what the owner must decide>" --q <Discord ask message link>` (or `--src <message link>`)
- Blocked on another card: `fm receipt <card-id> blocked "<what it waits for>" --blocked-by <card-id>[,<card-id>]`
- Blocked on time or something else: `fm receipt <card-id> blocked "<what it waits for and until when>"`

Contract: `~/Documents/reports/web/firstmate/receipts/<card-id>.json` = `{card, result: done|failed|blocked, summary, evidence[], ts, tsMs, pane, by[, verified, q, src, blockedBy]}`, written atomically by `fm receipt`. done -> card done; failed -> partial "[needs check]"; blocked with --q/--src -> blocked (owner step, link copied to the card); blocked without a link -> partial with "[blocked by <cards>]" (+ blockedBy) or "[blocked; not an owner step]". A session that ends, stops or stays silent without a receipt is flagged "no receipt; needs check".

## Owner questions (owner rule 2026-10-23)
Every question to the owner goes through the bot loopback /post as a fenced ```ask JSON block (buttons), NEVER as a numbered list or "Choose one:" text. Options: plain strings or {label, description}; last option "✏️ Other (type or dictate a reply)"; set "recommended". After posting, read the message back and confirm it has components (buttons); if not, fix the block and repost.

## Time guards (owner 2026-11-01)
- CI reruns: see "PRs and CI waits" (at most one rerun per commit; the same failure twice means fix the root cause or hand it to its owning card).
- 4 h without done: `fm receipt <card> blocked "<where stuck; what is needed>"`.

## PRs and CI waits (owner 2026-11-01, card fm-job-cap-ci-wait)
- Open every PR as a draft: `gh pr create --draft`. Run `gh pr ready <PR>` only when the work is finished; the full CI lane runs then.
- Every CI wait is bounded: `timeout 3600 gh pr checks <PR> --watch`. On timeout write `fm receipt <card> blocked "waiting on CI: PR #N, run <url>, <X> jobs queued ahead since HH:MMZ"` and stop. The job keeps its stack slot.
- Re-run CI at most once per commit. The same failure twice: no third run; fix the root cause or hand it to its owning card.
- Stack cap: fm-spawn runs at most 3 webapp jobs at once and queues the rest (exit 6, `queued: true`); fm-tick starts a queued job when a slot frees.
