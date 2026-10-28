# Task: <short name> (card <card-id>)

Template for FIRSTMATE side-session task files (Orca #3, 2026-10-19). Copy it to `<card-id>-task.md` next to items.json and fill in each section. Keep the last section ("Finish: receipt") in every task file.

## Target
- Files, repos, units and hosts to change. Name what is out of scope.

## Steps
1. <step>
2. <step>

## Rules
- No `git push`, `gh pr create/merge/close`, deploys, service restarts or deletions unless the card records the owner's approval for that exact action. `omp-approve` does not work in Herdr panes.
- Owner questions only through the bot loopback /post with a fenced ```ask JSON block.
- Back up files before you edit them. Finance code, orders, gates and live configs stay unchanged unless the card says otherwise.
- Heartbeat: a running card with no pane activity and no `fm beat` for 30 min is flagged "silent 30 min; no receipt; needs check". The pane counts as active only between tool calls, so one long command (build, download, test suite, `longjob`) needs a background beat. Run it in the same shell command: `( while sleep 900; do fm beat <card-id> "<what runs>"; done ) & B=$!; <long command>; rc=$?; kill $B; (exit $rc)`

## Acceptance
- <observable result and how you verify it>

## Finish: receipt (required, last step)
Write the worker-done receipt. fm-autoclear applies it to the card within one minute:
- Done: `fm receipt <card-id> done "<one-line result>" --evidence "<commit/file/unit/URL>" [--evidence ...]`
- Failed: `fm receipt <card-id> failed "<what failed and where the log is>"`
- Blocked on the owner (you posted an ask): `fm receipt <card-id> blocked "<what the owner must decide>" --q <Discord ask message link>` (or `--src <message link>`)
- Blocked on another card: `fm receipt <card-id> blocked "<what it waits for>" --blocked-by <card-id>[,<card-id>]`
- Blocked on time or something else: `fm receipt <card-id> blocked "<what it waits for and until when>"`

Contract: `$FM_DIR/receipts/<card-id>.json` = `{card, result: done|failed|blocked, summary, evidence[], ts, tsMs, pane, by[, q, src, blockedBy]}`, written atomically by `fm receipt`. done -> card done; failed -> partial "[needs check]"; blocked with --q/--src -> blocked (owner step, link copied to the card); blocked without a link -> partial with "[blocked by <cards>]" (+ blockedBy) or "[blocked; not an owner step]". A session that ends, stops or stays silent without a receipt is flagged "no receipt; needs check".
