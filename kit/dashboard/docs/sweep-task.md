# 🧹 FIRSTMATE sweep (automatic, started by firstmate-sweep.timer)

Owner rule 2026-10-18: nothing sits in In progress without moving. Clear or advance each idle card without asking.
Input: `idle.json` in the FIRSTMATE folder (`$FM_DIR`, the folder of this file) → `items` (cards that are `partial`, have no job, have no unfinished blocker, and did not change for more than 2 h). Handle only those cards. Read each card with `fm get <id>`; never load items.json whole.

## For each idle card
1. Check the real state: status/summary files (`l`, `task`), repos (`git log`, `gh pr`), KB folders, `systemctl --user` units, running.json.
2. Finished → `fm set <id> done "<evidence: commit/PR/file/unit>"`.
3. Agent-actionable → write a task file next to items.json (`<id>-task.md`: target, steps, rules, acceptance; start from `task-template.md`), start a side session in a new Herdr tab (`herdr tab create --workspace <FIRSTMATE workspace> --cwd <work dir> --label "<emoji> <short name>" --no-focus`, wait ~8 s, check `herdr pane process-info` shows `omp`, then `herdr agent prompt <pane> "Read <task file> and carry it out fully."`). Then `fm field <id> job "<tab label>"` and `fm set <id> running "working: <tab label>. <note>"`.
   Every task file MUST end with the receipt step (Orca #3, 2026-10-19): `fm receipt <id> done|failed|blocked "<summary>" [--evidence <commit/file/unit/URL>]...`, and long silent work runs `fm beat <id>` at least every 20 min. fm-autoclear applies the receipt (done -> done; failed -> partial "[needs check]"; blocked with `--q`/`--src` (owner ask) -> blocked; blocked without a link -> partial with the reason and `--blocked-by` cards). One long command needs the background beat loop from `task-template.md`. A card whose job ended, stopped, or stayed silent for 30 min without a receipt is flagged "no receipt; needs check": treat that as step 1 (check the real state).
4. Blocked on the owner → `waiting` with the question or source link (`fm q <id> <discord url>` or `fm field <id> src <url>`). Only link a message that exists; never invent a link.
5. Blocked on time or on another card → keep `partial`, set `fm field <id> blockedBy <card id>` (or tag the timer unit with `fm field <id> job <unit>`), and put the reason in the note.

## Hard limits
- At most 4 new side sessions per sweep. Respect Claude plan limits; no Codex/OpenAI models.
- Never change finance code, orders, gates or live configs. Finance cards are not in idle.json; do not touch them.
- Side-session task files must forbid `git push`, `gh pr create/merge/close`, deploys, service restarts and deletions unless the card already records the owner's approval for that exact action. `omp-approve` does not work in Herdr panes.
- Never focus tabs or type into panes you did not create. Never close other tabs.

## Finish (deadline 45 min from start; the launcher closes this tab at the deadline)
- Append one line per card to `sweep.log` in the FIRSTMATE folder (`$FM_DIR`): `<time> RUN <run id> <card id>: <action>`.
- Then write the receipt file named in the prompt (`sweep-runs/<run id>.done`) with one line: `Result: done, <n> cards handled`.
- The launcher sees the receipt and closes this tab. Do not close it yourself.

- Owner questions from side sessions (2026-10-18): post them ONLY through the bot loopback /post with a fenced ```ask JSON block (renders buttons). Never ask through scripts/notify-owner.ts or free text like "reply approve"; those arrive without buttons.
