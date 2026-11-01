# 🧹 FIRSTMATE sweep (automatic, started by firstmate-sweep.timer)

Owner rule 2026-10-18: nothing sits in In progress without moving. Clear or advance each idle card without asking.
Input: `idle.json` in the FIRSTMATE folder (`$FM_DIR`, the folder of this file) → `items` (cards that are `partial`, have no job, have no unfinished blocker, and did not change for more than 2 h). Handle only those cards. Read each card with `fm get <id>`; never load items.json whole.

Auditor cards (owner 2026-10-31, card dashboard-autoflow): the prompt also names cards from `audit.json` → `flow` (written every minute by `fm-audit`, a step of fm-tick.timer). Each has `kind` and `why`. Handle them the same way, first by kind:
- `unblocked`: every blocker is done. Start the work now (step 3), unless the card note names a later date or an owner decision that is still open (then step 4 or 5).
- `needs-check` / `no-job` / `daemon-job`: the job ended, or the card was "running" without a real job. Step 1 (check the real state), then step 2 (done) or step 3 (start a new side session from the card's task file; reuse `tasks/<id>-task.md` when it exists).
- `answered`: the owner answered the card's question, but no job took the answer. Read the answer (the card's `queuedFrom`/note or the FIRSTMATE message), then step 2 or 3.
Planned cards in `flow` are cards whose blockers are done; they are not a plan for a later date.

## For each idle card
1. Check the real state: status/summary files (`l`, `task`), repos (`git log`, `gh pr`), KB folders, `systemctl --user` units, running.json.
2. Finished → `fm set <id> done "<evidence: commit/PR/file/unit>"`.
3. Agent-actionable → write a task file next to items.json (`<id>-task.md`: target, steps, rules, acceptance; start from `task-template.md`), start a side session in a new Herdr tab (`herdr tab create --workspace <FIRSTMATE workspace> --cwd <work dir> --label "<emoji> <short name>" --no-focus`, wait ~8 s, check `herdr pane process-info` shows `omp`, then `herdr agent prompt <pane> "Read <task file> and carry it out fully."`). Then `fm field <id> job "<tab label>"` and `fm set <id> running "working: <tab label>. <note>"`.
   Every task file MUST end with the receipt step (Orca #3, 2026-10-19): `fm receipt <id> done|failed|blocked "<summary>" [--evidence <commit/file/unit/URL>]...`, and long silent work runs `fm beat <id>` at least every 20 min. fm-autoclear applies the receipt (done -> done; failed -> partial "[needs check]"; blocked with `--q`/`--src` (owner ask) -> blocked; blocked without a link -> partial with the reason and `--blocked-by` cards). One long command needs the background beat loop from `task-template.md`. A card whose job ended, stopped, or stayed silent for 30 min without a receipt is flagged "no receipt; needs check": treat that as step 1 (check the real state).
4. Blocked on the owner → `waiting` with the question or source link (`fm q <id> <discord url>` or `fm field <id> src <url>`). Only link a message that exists; never invent a link.
5. Blocked on time or on another card → keep `partial`, set `fm field <id> blockedBy <card id>` (or tag the timer unit with `fm field <id> job <unit>`), and put the reason in the note.

## Hard limits
- At most 4 new side sessions per sweep. Respect Claude plan limits; no Codex/OpenAI models.
- Hard limit (owner 2026-10-31): all cards flow the same way, finance cards included. Automatic flow never changes finance code, payments, gates or live configs, and never starts, stops, restarts or reconfigures live finance units or timers. Those steps stay owner decisions: ask with one ask menu. Cards on the owner hold list (`hold.json` next to items.json) are not in your input; never change them.
- Git, PR, merge and deploy steps need no owner question (standing owner approval 2026-10-31): side sessions push, open PRs, merge and deploy on their own judgment when CI is green on the exact commit; never `--no-verify`, never force-push shared branches, never delete on GitHub. Service restarts only through the repo's restart-when-idle script. Deletions and live finance changes still need a recorded owner approval. `omp-approve` does not work in Herdr panes.
- Never focus tabs or type into panes you did not create. Never close other tabs.

## Finish (deadline 45 min from start; the launcher closes this tab at the deadline)
- Append one line per card to `sweep.log` in the FIRSTMATE folder (`$FM_DIR`): `<time> RUN <run id> <card id>: <action>`.
- Then write the receipt file named in the prompt (`sweep-runs/<run id>.done`) with one line: `Result: done, <n> cards handled`.
- The launcher sees the receipt and closes this tab. Do not close it yourself.

- Owner questions from side sessions (2026-10-18): post them ONLY through the bot loopback /post with a fenced ```ask JSON block (renders buttons). Never ask through scripts/notify-owner.ts or free text like "reply approve"; those arrive without buttons.
