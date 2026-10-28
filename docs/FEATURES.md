# Features

This file lists each feature of the bot kit. For each feature it tells:

- what the feature does,
- how the owner uses it day to day,
- the commands and buttons,
- the config keys and services it needs,
- if it is **required** or **optional**.

"The owner" is the one Discord user that the bot obeys (`ownerId` in `config.json`). The dates and reasons for
each behavior are in [UX-DECISIONS.md](UX-DECISIONS.md). Setup steps are in [SETUP.md](SETUP.md).

Config files:

- `~/.config/omp-discord/bot.env`: bot secrets (`DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`).
- `~/.config/omp-discord/config.json`: ids and names (example: `config.example.json`). Env `OMP_BOT_CONFIG`
  overrides the path.
- `~/.config/omp-discord/kit.env`: settings for the kit scripts in `kit/` (example: `kit/kit.env.example`).

## Owner-only pieces that are NOT included

The original install also has finance and home-automation parts. They are not in this kit, and they need
private accounts:

- Finance: a read-only status monitor proxy and remote host timers in `/automations`.
- Home: `/nest` (thermostat), `/blinds` (TaHoma), `/rgb` (main lights), `/stream` (stream server).

These slash commands (`/rgb`, `/nest`, `/blinds`, `/stream`, `/second`) are registered only
when `config.json` `optionalCommands` lists them; the default list is empty.
`/second` pings the optional peer machine (`mirror.peers`).
The code for these pieces stays in the repo so the owner's own install keeps working. Do not set them up.

---

## 1. Discord bridge to OMP (core) — REQUIRED

**What it does.** The bot reads the owner's messages in Discord and runs an OMP agent (`omp -p`) for each one.
The answer comes back in Discord. Only the owner's own messages start a run. Messages from other users, bots,
webhooks and the bot itself are never routed (`src/policy.ts`).

**Day to day.** The owner writes a message in a run channel. The bot opens a thread (name from the link host or
the first words) and starts a run. Messages in that thread continue the same OMP session. In a DM, the bot keeps
one rolling session; `!new` starts a fresh one.

**Status and queue.**

- At most 2 runs at the same time; the rest wait in a queue (first in, first out). 30 min limit per run.
- Reactions on the owner's message: ⏳ and 1️⃣ 2️⃣ … while waiting, a spinning gear while running, ✅ or ❌ at the
  end.
- A silent `⏳ Queued.` note (with **Cancel**) becomes `Working… ❌ Stop` when the job starts. Working… shows a
  heartbeat every 10 s (alive / quiet / stuck, the running tool, CPU). A long quiet period shows
  `🗜️ Compacting memory`.
- One queue message per channel stays the last message: the running job, the waiting jobs and the last five
  results, each one a jump link.
- The queue is saved in `queue.json` and comes back after a restart.

**Notifications.** Only full answers notify. Status posts are silent. Approve requests, "couldn't transcribe" and
Herdr channel warnings stay loud on purpose.

**Long answers.** Split at 2000 characters with code fences kept. Answers over 8000 characters post a preview plus
`answer.md`. A line `📎 attach: <path>` in an answer uploads that file (max 10 MB, 10 files, only from allowed
folders such as `~/Github`, `~/Documents`, `~/Downloads`, `/tmp`).

**Paste blocks.** A fenced block with info string `text`, `prompt` or `firstmate` posts as its own message, so the
owner can long-press → Copy Text on the phone.

**Privacy filter.** Every outbound message goes through `src/redact.ts` and `src/secrets.ts`. They remove tokens,
account-like numbers, ID numbers and the exact values of secret keys found in `.env` files.

**Commands.** `!status` (runs and queue), `!new` (DM: new session), `!deny <id>` (cancel an approval).

**Needs.** `bot.env`; `config.json` keys `ownerId`, `guildId`, `channels` (channel id → `{name, cwd}`),
`workingEmoji`; service `omp-discord-bot.service`; `omp` signed in to the owner's own Claude subscription.

## 2. Slash commands — REQUIRED (some optional)

**What it does.** Guild slash commands for the owner. Anyone else gets a private refusal. `/help` lists all.

| Command | What it shows / does | Needs |
|---|---|---|
| `/help` | All commands | — |
| `/cpu` `/gpu` `/memory` `/stats` | Machine use and top programs | `/gpu`: NVIDIA `nvidia-smi` (optional) |
| `/disk` | Free space and largest folders | — |
| `/services` `/logs` `/restart` | User service status, last 20 log lines, restart (asks first; goes through the idle restart) | systemd user units |
| `/panes` | Herdr tabs | Herdr |
| `/net` | Tailscale state and egress | Tailscale (optional) |
| `/updates` | Pending repo and package updates (list only) | — |
| `/second` | Is a second machine reachable | `mirror.peers` (optional) |
| `/usage` | AI provider use limits (like `omp usage`) | OMP |
| `/remind what:` | Set a reminder in plain words (see §11) | — |
| `/radio` | Lofi Radio status (see §12) | radio bot (optional) |
| `/automations` | All user timers: next/last run, result; **Run now / Pause / Resume / Refresh** | systemd user timers |

Commands that change state report failure honestly. `/restart` never restarts at once; it queues the idle
restart (§15).

Owner-only commands that need private accounts (`/nest`, `/blinds`, `/rgb`, `/stream`)
are not part of the kit.

## 3. Capability sandbox, approvals and trusted mode — REQUIRED (choose one mode)

**Sandbox mode (default).** Each run starts in `bwrap` with a capability profile (`src/sandbox.ts`). The run can
read `~/Github`, write git work trees and a private `/tmp`, and use public network. It cannot read secrets, use
`sudo`, push to protected repos or touch other panes. Some host commands go through a broker without approval
(`git push/fetch`, `gh`, read-only `systemctl --user` and `herdr` verbs).

**Approvals (`omp-approve`).** For anything the run has no capability for, the agent runs
`omp-approve --reason '<why>' [--wait] -- '<exact command>'`. The bot posts the exact command in the thread and
opens a Herdr tab `Approve <id>`. The owner checks the command and types the machine login password in that tab
(PAM through `sudo -v`). The command then runs once, with a 4 h limit, and the bot posts a receipt. `!deny <id>`
cancels. Approved jobs that run longer than 5 min post a "still running" line in the long-jobs channel every
5 min.

**Trusted mode.** On while the file `~/.config/omp-discord/trusted` exists. Switch it with
`scripts/trusted.sh on|off|status`. Runs are not sandboxed: they run as the owner's user with the real
environment, like a terminal OMP session. `omp-approve` then shows an **Approve** button (owner only, single use,
hash-checked). `trusted.sh on` also installs a passwordless sudo rule. **Risk:** in trusted mode a prompt
injection in a shared link or page can act with the owner's full rights. See SETUP.md §11.

**Needs.** `bwrap` (bubblewrap); Herdr (approval tabs); `config.json` `longJobsChannelId`; `gate/bin` on the run's
PATH (the bot does this).

## 4. Questions as menus (ask blocks) — REQUIRED

**What it does.** `omp -p` has no interactive `ask` tool. A run ends its answer with a fenced ` ```ask ` JSON block
(at most 5 questions, 2–25 options). The bot posts one select menu per question (owner only, valid 24 h). When all
are answered, the picks go back to the same session as the owner's next turn (`src/ask.ts`).

**Day to day.** The owner taps the choices. Open menus survive a restart (`asks.json`). A tap on a menu that a
restart lost still goes to the agent as typed text. When the owner answers part of a set, the agent answers only
those and adds one `Still waiting:` line with links to the open menus.

**Voice.** When the owner is in the voice channel at run start, the agent asks one plain-text question at a time
instead of menus (§7).

## 5. Herdr mirror channels — OPTIONAL (strongly recommended)

**What it does.** Every OMP pane in Herdr gets its own Discord channel (`src/mirror.ts`). The bot reads
`herdr agent list` / `herdr tab list` every 60 s. Local panes go in the `local` category, panes of a peer machine
(over SSH) in the `peer` category. When a pane is gone, its channel moves to the `archive` category (never
deleted).

**Terminal → Discord.** The bot reads the pane's session log every 5 s and posts each new final reply. While a turn
runs, one silent progress message is edited in place: step count, the last 6 tool steps, and git notes (commits,
pushes, PRs). The message has a **📜 Last 40 lines** button (owner only, private, redacted).

**Discord → session.** A message in a mirrored channel continues that pane's OMP session when no live OMP process
holds it. When a process holds it, the bot starts a side session instead, so the session file never forks.

**Quick replies.** When a pane waits for the owner, the bot posts a card:
`❓ <tab> · asks: <question>` with one button per option plus **Reply…**, or
`✍️ <tab> · waiting for your answer` with **Continue**, **Yes**, **No**, **Reply…**. A press types into that pane
only when strict guards hold (same session, pane not focused, input box empty, OMP's record unchanged). Security
approval prompts are never answered from Discord.

**Stalls.** A tool call with no progress for 15 min posts `waiting on <tool> since HH:MM`. A turn stopped by a
short provider error continues by itself (2 min, then 8 min; at most 2 per hour).

**Channel names and order.** Each mirrored channel starts with a topic emoji (`👷‍♂️` FIRSTMATE, `📚` knowledge,
`🧰` tools, `🎮` apps, …; list `TOPIC_EMOJI` in `src/mirror.ts`; default `🤖` local, `💻` peer). Channels in a
category are sorted by emoji group, then by name. A channel the owner moves to a 📌 Pinned category stays there.

**Channel cleanup.** `channel-cleanup.timer` (daily 10:00) archives channels that are quiet for 24 h and clearly
finished, and closes their tab. Unsure channels go to the owner as one batched question.

**Needs.** Herdr; `config.json` `mirror.categories {local, peer, archive}`, optional `mirror.peers
[{machine, ssh, herdr}]`; bot permission Manage Channels; `systemd/channel-cleanup.*`.

## 6. FIRSTMATE and the dashboard — OPTIONAL (recommended)

**What it does.** FIRSTMATE is one long-lived OMP session in its own Herdr tab and Discord channel. The owner talks
mainly to FIRSTMATE. FIRSTMATE answers quick questions itself and starts every other job in a new side session
(own Herdr tab, own mirrored channel, own git worktree when the repo is busy). A tracker keeps one card per owner
request. The dashboard is a phone-friendly web page of these cards.

**Day to day.** The owner opens the dashboard from the dashboard channel or from the link under each reply. Cards
are grouped: ✍️ Needs you, ⚠️ Open (questions), 🔧 In progress, ⚙️ Running, ✅ Done. A tap on a card opens its
Discord message. A reply gets one link: `Card: <title> ↗`, `Report: <path> ↗`, `Cards changed in this reply ↗` or
`FIRSTMATE dashboard ↗` (owner 2026-10-21: no "Open …" wording). When the owner answers a card, the bot marks it 📨 Queued before the run starts.

**Kit pieces** (in `kit/`, installed by `kit/install.sh`):

| Piece | Job |
|---|---|
| `fm` | Tracker CLI: `fm add`, `fm find`, `fm get`, `fm set <id> <status> [note]`, `fm q`, `fm needs`, `fm field`, `fm receipt <card> done\|failed\|blocked "<summary>" --evidence <x>`, `fm beat <card>` |
| `fm-autoclear` (timer, every 1 min) | Applies deterministic rules: receipts close cards, answered questions move on, stale running cards get "needs check" |
| `fm-spawn` (`scripts/fm-spawn`) | Starts a side session: `fm-spawn --label <tab> --cwd <dir> --task <file> [--card <id>] [--stack <name>]`; saves the card's stack (area, else firstmate) and posts the task in the pane's mirrored channel once the mirror makes it; `--adopt <pane>` / `--adopt-all` do the same for live terminal jobs that started without it; `--cleanup` removes merged worktrees |
| `fm-tabwatch` (timer, every 2 min) | Closes finished spawned tabs; alerts on tab or sign-in pile-ups |
| `firstmate-sweep` (timer, every 2 h) | Starts ONE sweep session for idle cards |
| `auth-pane` | Opens at most ONE sign-in pane per login (no sign-in loops) |
| `firstmate-tests` | Dashboard self-tests |
| `kit/dashboard/` | Web app and index builders (`build-index.py`, `build-running.py`, timers) |

**Plan-limit watch.** Every 5 min the bot reads `omp usage --json --redact`. One pinned message in the alerts
channel shows each Claude window with a bar and a reset countdown. The dashboard header shows the same line. Alerts
at 80 % and 95 %.

**Send to FIRSTMATE.** A paste block that asks to paste into FIRSTMATE gets a **Send to FIRSTMATE** button. It
types the block into the FIRSTMATE pane only when that pane is idle and its input box is empty.

**📋 Master queue** (owner 2026-10-23, `src/masterqueue.ts`). One live board at the bottom of the FIRSTMATE channel lists
every job: bot runs in all channels plus tracker cards with a `job` field (side sessions, units) and their receipts.
Each row: title with a link to its message, where it runs, ⏳/⚙️/✅/❌/🛑 and the finish time. Finished rows stay 24 h.

**🧭 Router** (owner 2026-10-23, `src/router.ts`, `src/stackroute.ts`, chart `docs/router/`). A new owner message in the
FIRSTMATE channel goes to a domain stack before the run: rules first (`stack:<name>` or `@<name>` prefix, reply to a
routed message, topic channel, card area, keywords), then the JEV judge for unclear messages (OpenRouter decisions API,
≥ 0.6), else FIRSTMATE general. Each stack has one thread under the FIRSTMATE channel, its own OMP session
(`stack-<name>`) and a serial queue; stacks run in parallel, at most `router.maxParallelStacks` (default 4). A router
note under the message shows the stack and its state. Replies and menu answers to FIRSTMATE, Undo and handoffs stay
with FIRSTMATE. Messages with amounts, account ids or finance words never go to the judge. `!stacks` shows counts.
Status file: `<state>/router/stacks.json`; `/health` field `stacks`. Off: `"router": {"enabled": false}`.

**Needs.** Herdr; `config.json` `firstmateChannelId`, `dashboardUrl`; `kit.env` `FM_DIR`, `FM_DASHBOARD_URL`,
`FM_CHANNEL`, `FM_ALERTS_CHANNEL`; the kit timers; a web server for the dashboard (§13).

## 7. Voice channel and spoken replies — OPTIONAL

**What it does.** When the owner joins the voice channel (`voiceChannelId`), voice mode is on. Only the owner's
audio is received.

- **Listen.** The bot cuts the owner's speech into utterances (end after 1 s of silence, 60 s max), transcribes
  them with local Whisper, and deletes the audio. The transcript posts as `🎙️ from <name>: …` in the channel the
  owner last wrote in, and runs like a typed message.
- **Speak.** Each final answer is also spoken in the call with local Kokoro TTS, and posted as a
  `REPLY-<slug>.ogg` audio file. Incoming audio is ignored while the bot talks (no echo loop).
- **Questions.** The bot asks "Read them out, or post them?". The owner answers by number ("two and three").
- **Voice messages.** A Discord voice message (phone mic button) is transcribed too. The transcript message
  replaces it.

The idle restart and the queue drain never start while the owner is in the call.

**Needs.** `config.json` `voiceChannelId`, `voiceTranscriptChannelId`; `ffmpeg`; services `omp-whisper.service`
(faster-whisper model `small`: CUDA float16 on an NVIDIA GPU, else CPU int8) and `omp-tts.service` (Kokoro
`kokoro-v1.0.onnx` + `voices-v1.0.bin`, voice `af_heart`; CUDA when present, else CPU). Bot permissions Connect and
Speak; intent Guild Voice States.

## 8. iPhone Shortcut to FIRSTMATE — OPTIONAL

**What it does.** The owner sends a prompt to FIRSTMATE from the iPhone (home screen, widget, Action Button, Siri)
without opening Discord (`src/shortcut.ts`). Text or a voice recording goes to `POST /firstmate`. The bot posts a
`📱 from Shortcut` note in the FIRSTMATE channel and runs it like an owner message. The answer arrives in Discord.

**Safety.** A loopback server on port 47823 (`OMP_BOT_SHORTCUT_PORT`), published only on the tailnet by
`tailscale serve`. It accepts only the tailnet login in `~/.config/omp-discord/shortcut-login`, a Bearer key
(`shortcut-key`), size and rate limits, and a 15 min lockout after bad keys. A one-time setup page (valid 12 h)
shows the key once and the build steps.

**Needs.** Tailscale on the server and the phone; `tailscale serve` path `/firstmate`; voice notes also need
`omp-whisper.service`. Steps: SETUP.md §9.

## 9. Share links from the phone — REQUIRED (no setup)

The owner shares a link from the iPhone share sheet into a Discord run channel. The bot opens a thread named after
the link host and starts a run. Shared text and fetched pages are marked as untrusted data in the run's preamble
(`src/preamble.ts`).

## 10. Alerts channel and incident triage — REQUIRED

**What it does.** `alertsChannelId` (#omp-alerts) gets bot restart notices, plan-limit alerts, restart give-up
notices, tab pile-up alerts and sign-in alerts. Other services can post through the loopback endpoint:

```sh
curl -s 127.0.0.1:47821/post -H 'content-type: application/json' -d '{"channel":"<CHANNEL_ID>","text":"hello"}'
```

`POST /incident {key, detail, action}` starts one read-only triage run in a new thread under the alerts channel (at
most one per key per 6 h). The owner can reply in the thread.

**Needs.** `config.json` `alertsChannelId`, `alertChannels`; `OMP_BOT_HTTP_PORT` (default 47821).

## 11. Reminders — OPTIONAL

**What it does.** `/remind what:<when and what>` (for example `in 2 hours call mom`, `tomorrow 9am pay rent`)
parses the time locally and sets a wall-clock systemd timer, so it fires at the right time after a sleep. When it
is due, the bot pings Discord. Agents use the same path: `bun scripts/remind.ts "<when> <message>"`.

**iPhone sync (optional).** The reminders inbox is a small tailnet-only server (port 47830):

- `POST /reminders`: the phone sends all open reminders, one per line (`title | due: … | list: …`).
- `GET /add-queue`: lines `title | ISO due` that the bot wants created on the phone.
- `GET /delete-queue`: titles the agent wants deleted on the phone.

A daily digest (08:00) posts overdue and due-soon items. Steps for the Shortcut: SETUP.md §9.2.

**Needs.** systemd user timers; for the phone part: the reminders inbox service and Tailscale.

## 12. Lofi Radio — OPTIONAL

**What it does.** A second small bot (`scripts/radio.ts`) stays in its own voice channel (`radioChannelId`). Music
plays while someone listens and stops 5 min after the last listener leaves. It plays every `.ogg` in
`~/.local/share/omp-discord-bot/radio/`, shuffled. A second bot is necessary because Discord allows one voice
connection per bot per server, and the main bot stays in the voice channel.

**Needs.** A second Discord application; `~/.config/omp-discord/radio.env` (`RADIO_BOT_TOKEN=…`),
`RADIO_CHANNEL_ID`; `scripts/omp-lofi-radio.service`; `/radio` shows its status.

## 13. Report web pages — OPTIONAL

**What it does.** Tables and long lists do not fit Discord on a phone. Agents write a mobile page to
`<REPORTS_WEB_DIR>/<topic>/index.html` and send the link. A small static server (port 8790) serves the folder,
and `tailscale serve` publishes it at `https://<YOUR_TAILNET_HOST>/reports/`. The dashboard is one of these pages.
Static reports for the phone go as PDF (`md2pdf <in.md> [out.pdf]`).

**Needs.** `kit.env` `REPORTS_WEB_DIR`, `REPORTS_PORT`; Tailscale (or another private web server).

## 14. HEELER links — OPTIONAL

**What it does.** Heeler is a phone app that opens Herdr panes on a host. Approval posts get "Open HEELER" and
FIRSTMATE posts get "Open FIRSTMATE in HEELER". Discord buttons accept only http/https links, so a small Cloudflare
Worker (`heeler-link/worker.js`) turns an https link into a `heeler://agent?host=…&pane=…` link. It logs and stores
nothing.

**Needs.** The Heeler app; your own Worker deploy (`cd heeler-link && bunx wrangler deploy`) on your own domain.
Without it, use the terminal tab on the server.

## 15. Safe restarts — REQUIRED

**What it does.** Never restart the bot directly. Schedule `systemd-run --user --collect "$PWD/scripts/restart-when-idle.sh"` from the repo
(`--collect`: a run that the gate refuses leaves no failed unit behind). The script first runs the gate
(`bash -n`, `tsc`, `bun test`), then waits until no run, queue, reply or approved job is busy and the owner is not
in the voice call. After 10 min it turns on a drain (new jobs wait). After 2 h of a busy bot it gives up and posts
one alert. The queue message shows `🔄 Restart pending`, then `✅ Restarted: <commit>`.
`scripts/safe-restart.sh` reverts and restarts again when `/health` fails.

## 16. Status posts from scripts — OPTIONAL

`bun scripts/notify-owner.ts "<text>" [--file <path>]` posts one line to a channel (env `OMP_NOTIFY_CHANNEL`) with
the bot token. Use it in your own scripts. `scripts/ntfy-cutover.sh` is from the owner's ntfy phone-push setup; it
needs your own ntfy topic and is not part of the kit.
