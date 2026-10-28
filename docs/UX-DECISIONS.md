# Discord UX decisions

Owner decisions for how the bot looks and behaves in Discord. Each entry says what the bot does, why, and the
date. Code comments that say "Owner 2026-10-15" point back to these entries. Change an entry only on a new owner
decision, and record the new date.

## Notifications (2026-10-15)

- **Only full answers notify.** Every status post is silent (`SuppressNotifications`): Working…, transcripts,
  queue notes, the queue message, menus, restart notices, late audio, compaction notes.
- **Three alerts stay loud on purpose:** Approve requests, "couldn't transcribe", and Herdr channel/tab warnings.
- A long answer sends **one** loud chunk: the audio chunk, or the first chunk if there is no audio.

## Queue (2026-10-15)

- **One standalone queue message per channel, always the last message.** It is reprinted below every new message.
  The reprint waits 1.2 s after the last new message and never more than 3 s (a steady stream cannot hold it back).
- Layout, top to bottom: a `━━` rule, `⏳ **Queue**` with an underline, the running job, the numbered waiting
  jobs, then a blank line and `🏁 **Finished**` with an underline and the last five results.
- **The running row has no "Now:" label.** The animated spinning gear says it.
- **Every row is a 🔗 jump link**: the running row opens its Working… message (❌ Stop); a waiting row opens its
  own `⏳ Queued.` note (Cancel).
- **No buttons on the queue message.** The owner removed the number buttons; Cancel lives on each note.
- When the queue empties, the bot posts a final `🏁 Finished` copy below the last answer. The owner's next message
  removes it.
- If the list is too long, waiting rows are cut with `… N more`; the `Restart pending` line always stays.

## Per-message status (2026-10-15)

- Each waiting message gets a silent `⏳ Queued.` note with a Cancel button.
- **When its job starts, that note is edited in place into `Working… ❌ Stop`.** The channel then reads in send
  order: ✅ done → ⚙️ working → ⏳ waiting. A job that starts at once (no note) posts Working… at the bottom.
- Reactions on the owner's message: ⏳ plus 1️⃣ 2️⃣ … while waiting, the animated spinning gear while running,
  ✅ or ❌ when done.
- **Working… shows a heartbeat:** first ~2 s after start, then every 10 s (alive / quiet / stuck, the running tool,
  CPU, log writes). It is deleted when the job ends.
- **Compaction:** when a run writes nothing to its session log for 8 s, Working… shows
  `🗜️ Compacting memory (usually ~60 s, about N s left)`. The 60 s comes from the three measured compactions
  (58–61 s). The owner chose this over switching to a fresh session before compaction.
- Do not delay replies to make tests easier (owner, 2026-10-15). Speed stays as it is.

## Mirrored pane progress (2026-10-15)

- The owner asked why a pane's coding work did not show in its mirrored channel. The mirror posted only final
  replies. Now each pane turn with tool steps gets **one silent status message**, edited in place:
  `⚙️ **<tab>** · working · started … · N steps · last step …` and the latest 6 steps (tool name + the agent's
  short intent; no other tool arguments). Edits are at most one per 4 s per channel.
- When the turn ends, the message becomes `✅ … turn finished … · N steps in T`, then the final reply posts below it
  (loud, as before). Aborted/errored turns, a closed pane or a new session show `⏹️ … turn stopped (<reason>)`.
- A turn without tool steps gets no status message. Times use Discord `<t:…>` stamps (reader's time zone; the
  relative ones keep counting without edits). Read-only: nothing is typed into the pane.

## Voice (2026-10-15)

- A voice message is swapped for a transcript message right after transcription; the transcript carries the
  reactions, Working…, Stop and the answer's reply link.
- Spoken replies: the bot waits for speech (up to 45 s) and sends text + audio as one message. Files are named
  `REPLY-<slug>.ogg` after the request.

## Restarts (2026-10-15)

- Never restart directly. `scripts/restart-when-idle.sh` waits until nothing is running or queued, no reply is
  being posted, no queue-message reprint is pending, and the owner is not in the voice call.
- While a restart waits, the queue message shows `🔄 Restart pending: N updates ready` (or "no new code" for a
  reload). After the restart, that line is edited to `✅ Restarted: the bot is running <commit>`.
- Restart notices are framed: `━━` rule, `🤖 **Bot restart**`, an underline (same style as the queue header).
- Fewer notices (2026-10-23, UX item 6): a restart with nothing waiting posts no notice (the queue boards say it).
  When a job waits, "Restarting" and "✅ Restart done" go only to that job's channel, and the "Restarting" post is
  deleted when "Restart done" appears. Failures also go to the owner channel. During a drain, the board line names
  the running job that holds the restart, with a link to its Working… message.

## Slash commands (2026-10-15)

- Owner only; anyone else gets a private refusal. `/help` lists them all.
- Main: `/cpu /gpu /memory /stats /disk /services /logs /restart /panes /net /stream /second /updates`
- Tools: `/usage` (AI provider limits, like `omp usage`), `/rgb` (toggle, or `state:on|off`), `/remind`, `/nest`,
  `/radio` (read-only).
- `/restart` asks first (private confirm button). The bot restarts only through the idle restart. The Claude
  broker and DarkFactory gateway cannot be picked.
- Commands that change state must report failure honestly: no "set" or "restarted" unless it really happened.

## Lofi Radio (2026-10-15)

- Always in its voice channel. Music starts when someone joins and stops 5 minutes after the last listener leaves.
- On a YouTube bot check it retries via a Chicago proxy, then plays local clips for 10 minutes.

## Blinds (2026-10-15)

- `/blinds` lists the TaHoma blinds and has ⬆️ Open, ⏹️ Stop, ⬇️ Close and ⭐ My buttons. `blind:` takes a room or one blind.
- The blinds are one-way RTS motors: no position feedback and no percentage moves, so there are no position buttons.
- **Open and Close are sent 3 times, about 3 s apart** (owner, seen in the condo: the signal does not always get through
  the walls, so "close all" left some blinds open). The box must accept each send; a blind whose sends all fail is
  sent again, at most 2 more times. Stop and My are sent once, because a second press would undo the first.
- The reply says which blinds the box confirmed. It cannot say whether a blind moved; press again if one did not.

## Side sessions (2026-10-15)

- A new mirrored work session is started in its Herdr pane (`herdr agent prompt`, new unfocused pane only), and the same task text is posted in its channel through `/post`, so the channel reads like FIRSTMATE. A bot post alone never starts a run.
- The live progress box shows the task (owner words only), eval titles and the agent's short updates.

## Queue message links (2026-10-15)

- Jump-link labels never contain a URL or a domain-like word. Discord opened the pasted URL (for example a social
  site) instead of the jump link. URLs become a short host label, also in the Finished, Stopped and Queued lines.
- An empty queue reads `No messages waiting`. The old "all done" text was read as "the Herdr session finished".
- The `Restart pending` line names the channels that are still busy. The restart waits for every channel.
- Paste blocks: a **Send to FIRSTMATE** button appears only when the label line asks to paste or send into
  FIRSTMATE. A line that only mentions FIRSTMATE gets no button.

## Heartbeat detail (2026-10-15)

- During a wait, Working… shows each subagent's current tool and its last activity.
- A tool is judged by the CPU and log writes of its own child processes. The root process also carries advisor and
  MCP traffic, which hid hangs. A tool with no CPU, I/O or log writes for 10 min gets a 🟠 flag.

## Mirror git notes (2026-10-15)

- The mirrored progress box notes commits, pushes and opened PRs, taken from the call and its successful result.
  The notes stay after the turn ends. Heredoc text and plain mentions of `git push`/`git commit` are ignored.

## iOS Shortcut to FIRSTMATE (2026-10-15)

- A tailnet-only endpoint on its own loopback port. Only the owner's tailnet login is accepted, checked before the
  key and the lockout; a missing login file fails closed. Bearer key, rate limit and lockout. The one-time setup
  link is valid for 12 h, so a restart can wait for idle.
- A prompt from the Shortcut runs like an owner message. A voice recording is transcribed locally (same as Discord
  voice messages), the audio is deleted, and the reply says what was heard.
- Every rejection (empty recording, nothing heard, too long, locked) is logged, so a dropped note can be traced.

## Reminders (2026-10-15, 2026-10-17)

- `/remind` takes one free-text field, parsed locally ("in 2 hours", "tomorrow 9am", "friday noon"). It sets a
  wall-clock timer in the `omarchy-reminder` format, so the reminder fires at the clock time after a sleep.
- A failed timer start never leaves a stray `.message` file.
- 2026-10-17: reminders are also queued for the iPhone (reminders-inbox `add-queue`) and the bot pings Discord
  when one is due. Agents use the same path: `scripts/remind.ts "<when> <message>"`.

## Silent Working… (2026-10-16)

- Working… is a reply to the owner's message but must not ping: it is sent with `repliedUser: false`.

## Long jobs (2026-10-16)

- Approved jobs (`omp-approve`) may run up to 4 h. After 5 min, a job posts a "still running" line in
  #long-running-jobs every 5 min, plus one end line.
- `longjob [--name TEXT] [--limit-min N] -- <command>` gives any other long command the same reporting. It has no
  time limit unless `--limit-min` is given, and it forwards stop signals to the command.
- The idle restart also waits for running approved jobs (`/health` field `approvals`).
- `omp-approve --help` prints usage and queues nothing. It had queued the literal command `--help` three times.

## Ask menus across restarts (2026-10-16)

- Open ask menus are saved (`state/asks.json`, 0600) and reloaded at start, so a restart does not end them.
- A tap on a menu that a restart still lost goes to the agent as the owner's typed answer. There is no "expired"
  dead end.

## Restarts without starvation (2026-10-17, 2026-10-18)

- The queue is saved (`state/queue.json`, 0600) and restored at start.
- After a 10 min wait, the restart turns on a drain: new jobs stay queued, running jobs finish. The drain never
  starts while the owner is in the voice call.
- Every restart first passes a gate: `bash -n`, `tsc` and `bun test`.
- 2026-10-18: after 2 h of a busy bot (voice time not counted), the pending restart gives up and posts one
  #omp-alerts notice that names what was still busy.

## Channel names and order (2026-10-17, 2026-10-18)

- Every mirrored channel name starts with a topic emoji (display only; lookups use the plain slug or the ID).
- Channels in a category are sorted by emoji group, then by name. The FIRSTMATE emoji is 👷‍♂️.
- 2026-10-18: a channel the owner moved into the 📌 Pinned category stays there.

## Mirror stall notes and auto-continue (2026-10-17)

- An open tool call with no session growth for 15 min posts `waiting on <tool> (<intent>) since HH:MM`, then
  `resumed` when work continues.
- A pane turn stopped by a transient provider error is continued automatically, only when no live OMP runs in the
  pane: backoff 2 min, then 8 min, at most 2 per hour.

## Incident triage threads (2026-10-17)

- `POST /incident` starts one read-only triage run in a new #omp-alerts thread with a fixed procedure. Fixes go
  through `omp-approve`. At most one run per key per 6 h and one at a time. The owner can reply in the thread.

## Questions to the owner (2026-10-17, 2026-10-18)

- Ask blocks come only through `/post` with a fenced `ask` JSON block, so they render as menus. Free-text "reply
  approve" questions arrive without buttons.
- When the owner answers some questions of a set, the reply covers only those. Open menus are not sent again; one
  `Still waiting:` line links each open question by its Discord message link.
- 2026-10-18: the question style follows the live voice state when a run starts. Owner in the voice call: one
  plain-text question at a time (question, choices, recommendation), no ask block, no recap. Otherwise: ask blocks.
  The state is `ownerInCall`, so a bot voice reconnect does not switch a run to ask blocks.

## Reply dashboard link (2026-10-18)

- A reply gets one FIRSTMATE dashboard link, right above the spoken audio (or at the end without audio), after a
  blank line.
- The link opens the card the reply names (`?item=<id>`), a report (`?tab=reports&report=<path>`), or the cards
  this run changed (`?since=<run start>&by=run:<id>`). The run id is the run's `OMP_GATE_RUN`, which `fm` records.
- The label is plain text and names the target: `Open card: <title>`, `Open report: <path>`, `Open the cards
  changed in this reply`. The link has no `#fragment`.
- Agents name the target with hint lines `⚓ item:<id>` or `⚓ report:<path>`. The bot removes these lines from
  the visible reply; they showed as plain text.

## 📨 Queued tracker cards (2026-10-18)

- When the owner responds to a Needs-you or Open card (menu pick, reply to its message, a message link, a
  `⚓ item:<id>` token or a dashboard `?item=` link), the bot marks the card before the run starts: field `queued`,
  then `partial` with `📨 Queued: owner responded HH:MM`. The dashboard shows a 📨 badge.
- Only the owner's own text is scanned, so the `Still waiting` links in a bot message do not mark unanswered cards.
  Time gates are never marked. Jobs restored after a restart are not marked again.

## Channel cleanup (2026-10-18)

- `channel-cleanup.timer` runs daily at 10:00. A channel quiet for 24 h (above the measured p95 gap of active
  work) is a candidate. It is archived (moved to 📦 Archive, never deleted) and its tab closed only when it is
  finished: final report, no open question, idle agent, no process in the tab.
- Open tracker cards, caveat phrases ("could not", "pending", "failed") and empty final messages count as unsure.
  Unsure channels go to the owner as one batched question, at most once per channel per week.
- FIRSTMATE, the dashboard channel, alert channels and running jobs are never touched.

## Dashboard channel (2026-10-18)

- A read-only FIRSTMATE dashboard channel sits at the top of the server, outside the categories. Discord pinning
  is per user, so the owner pins it; the bot cannot.

## 🌳 Side sessions get their own git worktree (2026-10-19, Orca #7)

- FIRSTMATE starts side sessions with `fm-spawn --label <tab> --cwd <folder> --task <file> [--card <id>]`
  (`scripts/fm-spawn`, linked as `~/.local/bin/fm-spawn`). The tab opens without focus, OMP gets the task file,
  and the card gets `job` = the new pane and state `running`.
- When another live Herdr pane already works in the same repo, the session gets the worktree `<repo>-wt-<slug>`
  on branch `ws/<slug>`. Its prompt lists the merge-back steps: commit, rebase onto the base branch, then
  `flock /tmp/<repo>-integrate.lock git merge --ff-only`. No force-push and no push to a remote.
- `fm-spawn --cleanup [--dry-run]` removes a worktree only when it is merged into its base, has no uncommitted or
  untracked files, and no live pane works in it. Unmerged work always stays. Log: `~/.local/state/fm-spawn/`.

## 🧾 Worker-done receipts and heartbeat (2026-10-19, Orca #3)

- A side session closes its dashboard card by contract: its last step is `fm receipt <card> done|failed|blocked
  "<summary>" --evidence <commit/file/URL>`. The receipt goes to `firstmate/receipts/<card>.json`, and
  fm-autoclear applies it within a minute: done closes the card, failed puts it back in 🔧 In progress with
  "[needs check]". A blocked receipt with the owner's ask link (`--q`/`--src`) moves the card to blocked (owner step);
  a blocker on another card (`--blocked-by`) or on time keeps it in 🔧 In progress with the reason. The note starts with 🧾.
- Heartbeat = the session's own activity, or `fm beat <card>` during long silent work. A ⚙️ Running card whose
  job pane is gone, stopped, or silent for 30 min without a receipt gets "no receipt; needs check". One long
  command runs a background `fm beat` loop (see the task template), because the pane is active only between tool calls.
- Task files start from `firstmate/task-template.md`, which ends with the receipt step; `fm-spawn --card` adds the
  same reminder to the prompt. Finance cards are never changed by receipts.

## 📊 Claude plan-limit watch (2026-10-19, Orca #5)

- Every 5 min the bot reads `omp usage --json --redact` (OMP's supported usage command; it never reads the
  credential data). One message in #omp-alerts shows each Anthropic window (5 hour, 7 day, tier meters) with a
  bar, the percent used and a live Discord countdown to its reset. The bot edits it in place and tries to pin it.
- The FIRSTMATE dashboard header shows the same line from `limits.json` (written by the bot).
- One alert per window at 80% and one at 95% (a jump past both posts only the 95% alert). Alerts notify. When an
  alerted window resets (reset time moves, or use drops by 25 points after a banked reset), one silent notice.
- Alerts name the banked resets (✦ count, expiry) and `claudeResets.autoRedeem`.
- 3 failed reads in a row post one alert; the first good read after that posts a recovery notice.

## ⏱️ /automations (2026-10-19, Orca #6)

- Lists every user timer on the main host and every system timer on the remote host (read over ssh), one line each:
  result icon, next run, last run, and the result when it failed or is running. No tables. OS timers sit on one
  read-only line per host.
- A menu below the list picks a timer. The private detail shows Run now / Pause / Resume / Refresh buttons.
  Run now = `systemctl start --no-block <service>`; Pause = `disable --now <timer>`; Resume = `enable --now`.
- Run now and Pause on finance units (example-watch*, ex-*, newsletter*, rebalance*, broker*, long-options*, and everything on the
  remote host) ask for a confirm. weekly-update.service never starts from here (real system update). OS timers are
  read-only.
- Only the owner's presses act. Every action, refusal and confirm request goes to
  `automations-actions.jsonl` in the bot state folder and the bot log.

## Quick replies to a waiting pane (Orca #2, 2026-10-19)

- When a mirrored OMP pane waits for the owner, the bot posts one silent card below the pane's messages:
  - `❓ <tab> · asks: <question>` while the pane runs the `ask` tool (one question, one choice): one button per
    option, plus **Reply…** (a text box; the answer goes to the selector's "Other" as one line).
  - `✍️ <tab> · waiting for your answer` when the pane's turn ends with a question: **Continue**, **Yes**, **No**,
    **Reply…**.
- A press types into that exact pane only when all guards hold: the owner pressed it on the bot's card for the
  pane's current wait; `herdr pane list` shows the same omp agent and session, **not focused** (the owner may be
  using it); **OMP's own record is unchanged**: the session's last message entry is still the open `ask` call or
  the final reply that opened the card (FIRSTMATE 2026-10-19: Herdr's agent state is not used, because it shows
  OMP panes idle while they work or while the owner types); and the screen agrees (ask: the same question's
  selector; question: an **empty input box**). The guards run on the press and again right before the key that
  sends. Otherwise nothing is sent and only the owner sees `⚠️ Not sent: …`.
- After sending, the card says `✅ You sent “…”` with the time, and its buttons go away. An answer given at the
  terminal closes the card (`⏹️ Closed: answered at the terminal`).
- Every inject and every refusal is logged in `pane-injects.jsonl` (time, pane, choice, result, reason, length;
  never the typed text).
- Not answered from Discord: questions with several parts or several choices (the card says to answer at the
  terminal) and tool approval prompts (security approvals stay at the terminal; OMP keeps no pending-approval
  record, so such a pane reads as working and every press is refused).

## Last 40 lines (Orca #4, 2026-10-19)

- A mirrored channel's progress message has a **📜 Last 40 lines** button. It replies only to the owner
  (ephemeral) with the pane's last 40 terminal lines, redacted with the outbound filter plus terminal rules
  (private key blocks, JWTs, AWS key ids, Bearer/Basic headers, password/token/key=value), icon glyphs removed,
  code-fenced, and split into messages under 2000 characters.

## 🛑 Sign-in loop guard and tab pile-up limits (2026-10-19, card auth-loop-guard)

- Owner, 12:15 ET: a job opened 5 `pscale auth login` panes in 12 min (each with a browser tab and a ping), and
  workspace wB had 34 tabs. "That shouldn't happen again."
- Sign-ins go through `~/.local/bin/auth-pane --op <name> -- <command>`: ONE pane below the caller (no focus,
  `OMP_AUTO_START=0`, `env -u CI TERM=xterm-256color`), a 20 min lock per operation, and at most 2 attempts per
  operation per hour. A second call while the pane is open refuses and names that pane. After 2 attempts it
  refuses and says to ask the owner for a non-browser credential.
- `fm-spawn` refuses to start a job when the workspace already has more than 30 tabs. It lists the tabs that close
  automatically and the tabs that only look finished. Every spawn is recorded in `~/.local/state/fm-spawn/spawned.jsonl`.
- `fm-tabwatch` (timer, every 2 min) closes an fm-spawn tab after its card's done/failed receipt, only when the
  OMP session ended with a final reply 3+ min ago, no pane is focused, no live card names the tab, and the only
  other pane is the idle Terminal pane. The card note gets "🧹 tab closed". It never closes other tabs.
  It alerts once in #omp-alerts when a workspace has more than 25 tabs or more than 3 sign-in panes open in 15 min.

## 🧠 Reply tail and finance tables (2026-10-21, card discord-reply-footer)

- The model signature and the dashboard link form one bullet list at the end of a reply: content, exactly one blank line, `- 🧠 <provider/model>`, `- ⚓ [Open …](<url>)`. Without a dashboard link the list has only the 🧠 line. With audio, the list stays on the audio message, above the spacer. If the list does not fit in 2000 characters, it goes in its own follow-up message; the 🧠 line is never dropped. Copy posts get no tail. Code: `src/replytail.ts`.
- Tables in finance channels (channel, parent or category name matches finance/newsletter/market/long-options/broker, or an id in `OMP_TRADING_CHANNEL_IDS`) are PNG only, with no page under /reports/tables/. This also covers example-bot `/post` calls to those channels. The account-number rule stays.

## 🧠-local-model channel (owner 2026-10-19, card local-model-channel)
- Channel `🧠-local-model` (100000000000000036) in 🔔 Alerts, outside the mirrored categories so sync never moves or archives it.
- Owner messages there go ONLY to the local llama.cpp server (127.0.0.1:8091, model `local-coder`); they never reach OMP/Claude or a cloud API. Other authors and bots are ignored. Code: `src/localmodel.ts`.
- One reply message, labeled "🧠 local-coder", edited at most every 1.5 s while streaming; overflow beyond 2000 chars goes to follow-up messages. Reasoning shows only as a short "💭 thinking…" preview until the answer starts.
- History persists in `<state>/local-model-history.json`, trimmed to ~75% of `n_ctx` minus the reply budget. `reset` or `/reset` clears it.
- Server down: one message "local model is off — `local-coder start`", no retries. Voice input and spoken replies: not built (optional, skipped).

## Run diagnostics, failures and handoff (2026-10-23, UX review items 5, 7, 8)

- 🩺 Check (src/diagnose.ts): a button on Working… and on the queue board posts a report without an LLM: state,
  process, CPU, child processes (names and states only), current tool and since when, the last 5 session entries
  (tool names and intents only), queue, why a job waits, and restart/drain state. The bot posts it by itself once
  when a run is quiet for ~8 min (before the 10-min idle stop) or when a message gets no Working… within 60 s and
  does not wait behind its own channel's job (at most one per channel per 5 min). A good finish deletes the reports.
- Failed runs (src/failcause.ts): one plain cause line (refusal, no credit, plan limit, sign-in, disk full, busy
  session, provider error, start error, unknown), the last output cut to 400 characters, and 🔁 Retry on the same
  message. A transient provider or busy-session error in a run shorter than 2 min retries once by itself after 20 s.
- ↪️ Handoff (src/handoff.ts): `/handoff to:<channel> [note]` or long-press a message → Apps → "Send to another
  channel". The bot posts a card in the destination (source link, session log paths, note), a back-link in the
  source, and starts a run there that reads the end of the source log and posts a short summary first.

## FIRSTMATE stacks, boards and transient threads (owner 2026-10-23)

- 🧭 Router: a new owner message in FIRSTMATE goes to one domain stack (finance, webapp, realestate, infra, kb,
  personal, or FIRSTMATE general). Each stack has one serial queue and one OMP session, and stacks run in parallel.
  Short follow-ups (≤ 3 words, no keyword) stay with FIRSTMATE. Code: `src/router.ts`, `src/stackroute.ts`.
- Stacks are threads under FIRSTMATE (owner choice A over real channels). A stack thread is transient: it is
  archived 90 s after its stack has no running or queued job; Discord's 1 h auto-archive is the backstop. The next
  routed message opens it again.
- Reply threads in #needs-you and alert channels are transient too: archived 90 s after their last job ends.
- 📋 Master queue board in FIRSTMATE: Running, Queued and Finished (24 h). Same style as the ⏳ Queue box (━ bars,
  ——— under section titles, animated gear). Each job is two lines: title and age, then an indented
  `↳ runs in <#channel> · stack: <#thread>` in plain words. Raw Herdr ids (like `wB:pMC`) never show; a job without
  a Discord channel shows its terminal tab name or background service. A card `job` may be a list (first one shown).
- 🔔 Needs-you board: same bar style as the master board; no empty section header.
- Ask menus: every menu has a ✏️ Other button even when the block omits it. Loopback `/post` refuses plain numbered
  owner menus and asks for an ask block. fm-spawn side-session prompts require ask blocks with buttons.
- An owner ✅ reaction on a bot message marks its linked cards done and queues one follow-up turn, after a 60 s
  cancel window.
- Restart gate: `scripts/restart-when-idle.sh` restarts only when typecheck and tests pass at HEAD. A failed gate
  keeps the old code running and posts the failure; check the journal before assuming a fix is live.

- Stacks are not a fixed set (owner 2026-10-24): add one with `bun scripts/stack-add.ts --name <slug> --emoji <e> --title <t> --keywords "a,b" [--areas ...]` (writes router.stacks in config.json, schedules an idle restart). Create a new stack whenever a new domain of work appears; its thread is made on the first routed message. 🎮 fun covers apps, plugins, ports, emulators and 3D models.
