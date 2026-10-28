# omp-discord-bot

A Discord bridge for the [OMP](https://github.com/can1357/oh-my-pi) coding agent. One owner writes in a private
Discord server (also from a phone). The bot starts OMP runs, posts the answers, mirrors Herdr agent panes to
channels, talks in a voice channel and keeps live boards of the work.

This is a public copy of a personal setup. It holds no personal values: Discord IDs, host names and paths come
from your config. Some features expect the same companion tools (Herdr, the FIRSTMATE tracker `fm`, Tailscale).
Those features stay off or show nothing when the tools are missing.

- Setup, step by step: [docs/SETUP.md](docs/SETUP.md) (manual steps are marked). One command: `scripts/bootstrap.sh --dry-run`, then without `--dry-run`.
- Full feature list: [docs/FEATURES.md](docs/FEATURES.md). Design decisions and their dates: [docs/UX-DECISIONS.md](docs/UX-DECISIONS.md).
- Internals (sandbox, approval broker, loopback API, voice details): [docs/REFERENCE.md](docs/REFERENCE.md).
- Dashboard and tracker kit: [kit/README.md](kit/README.md). OMP slash commands: [docs/omp-commands.md](docs/omp-commands.md).

## Configuration

| File | Holds |
|---|---|
| `~/.config/omp-discord/config.json` | Per-install values: `guildId`, `ownerId`, channel IDs and working folders, categories, voice channel, dashboard URL, router stacks, peer machines. Start from [config.example.json](config.example.json). |
| `~/.config/omp-discord/bot.env` | Secrets: `DISCORD_BOT_TOKEN` and optional keys (mode 0600, never in git). Start from [.env.example](.env.example). |
| `~/.config/omp-discord/trusted` | Optional flag file. When it exists, runs are not sandboxed (see Trusted mode in docs/REFERENCE.md). |

Optional owner-hardware slash commands (`rgb`, `nest`, `blinds`, `stream`, `second`) are off unless listed in
`optionalCommands`.

## Features

### Owner-only input
Only messages from the real owner account (`ownerId`) in your server or in a DM start runs. Bot, webhook and
system messages never do. Every outbound message goes through a privacy filter (account-number, ID and token
patterns, plus the exact values of secrets found in local `.env` files).

### Runs, threads and the queue
- A top-level message in a configured channel opens a thread and starts an OMP run. Replies in the thread
  continue the same session. In a DM there is one rolling session; `!new` starts a fresh one.
- At most 2 runs run at once by default (`OMP_BOT_MAX_CONCURRENT`); the rest wait in a FIFO queue. Each run has a
  30 min limit (`OMP_BOT_TIMEOUT_MIN`). A ⏳ Queue box shows waiting and running jobs; `!status` lists them.
- A "Working…" heartbeat shows the latest tool steps (tool name and intent only).
- Reply threads in post-only alert channels are transient: they are archived again when their run ends.

### Diagnostics and Retry
- 🩺 **Check** (button on the Working… message and the queue box) builds a report without a model call: process
  state, CPU, current tool, child process names, the last session steps and the queue. It never shows commands,
  arguments or output.
- A failed run posts one line with the cause and what to do (`src/failcause.ts`), for example refusal, usage
  limit, sign-in, or disk full. Transient provider errors get ONE automatic retry. Other failures get a
  🔁 **Retry** button.

### FIRSTMATE router and stacks
- FIRSTMATE is the one channel the owner writes in. Before each turn, the router sends the message to a domain
  stack: deterministic rules first (a `stack:<name>` prefix, a reply to a routed message, a card area, keywords),
  then an optional judge model for unclear messages. Unclear or failed judgments go to the general stack.
- Each stack has one persistent Discord thread under FIRSTMATE and one OMP session. Different stacks run in
  parallel up to `maxParallelStacks`; one stack runs one job at a time.
- Add a stack without a code change:
  `bun scripts/stack-add.ts --name 3d --emoji 🧊 --title "3D models" --keywords "blender,stl"`.
  It updates `router.stacks` in config.json (backup first) and schedules a restart-when-idle. The thread is
  created when the first message is routed to it.

### 📋 Master queue
One live board at the bottom of the FIRSTMATE channel lists every job: bot runs in any channel and tracker cards
that have a `job` field. Sections, in order:
- ✍️ **Needs you**, ⚙️ **Running**, ⏳ **Queued**: every row is shown (no "+N more"); a long board continues in
  extra messages.
- 🏁 **Finished, last 12 h**: one count line (with the failed/stopped count) and a dashboard link.
- 🤖 **Bots and scheduled jobs**: one count line (running, scheduled, down) and a dashboard link.

### ✍️ Needs-you board
A post-only channel whose last message is a live board of every tracker card and open menu that waits on the
owner. An item appears only when it is an open, unanswered menu or Approve button, or a card with concrete owner
steps. An answer removes it at once. Optional one-line alerts announce new items.

### Ask menus
- A run asks the owner questions by ending its answer with a fenced ```` ```ask ```` JSON block. The bot turns
  each question into a select menu or buttons (owner only).
- Every menu gets a "✏️ Other (type or dictate a reply)" option that opens a text pop-up; the bot adds it when
  the block left it out.
- The loopback `/post` endpoint refuses a plain numbered list that asks the owner to choose, and an ask block that
  cannot become a menu. The sender gets the reason, so questions always arrive with buttons.
- When the owner is in the voice channel, questions are asked one at a time in plain text instead.

### /models (two tiers)
`/models` sets the model per channel: pick a provider first, then a model of that provider. Providers are shown
when OMP lists models for them: Anthropic, OpenAI (Codex), Venice, OpenRouter (its `~…-latest` aliases) and a
local llama.cpp model. Each list holds at most 24 models. Non-default providers run in their own per-provider
session for that channel. The choice is saved and survives restarts.

### Approvals (no expiry)
A run that needs a step it may not do itself (for example `sudo`) calls `omp-approve --reason … -- '<command>'`.
The bot posts the exact command. In sandboxed mode the owner approves in a dedicated Herdr "Approve <id>" tab
with the login password; in trusted mode the owner taps **Approve** (single use, hash-checked). Approvals have no
expiry; `!deny <id>` cancels one. Long approved commands report progress every 5 min, up to 4 h.

### 🔐 Secret drop
An agent asks for a one-time form (`scripts/secret-drop.ts` or `POST /secret-drop`). The bot posts a link
button. The form is served only on your tailnet. The value goes straight to the target file (mode 0600); it is
never logged, posted or sent to a model. Each link works once and expires (default 15 min).

### ↪️ Handoff
`/handoff to:<channel> [note]`, or the message action "Send to another channel", moves a conversation. The bot
posts a card with the source link and session log paths in the destination and starts a run there that reads
the source context.

### Mirror channels
Each OMP pane in Herdr (local and optional peer machines) gets its own channel, synced every 60 s. Channel names
are short (the tab part only) with a topic emoji in front, and channels in each category are sorted by emoji
group, then by name. New final replies are posted from the pane's session file, with a live progress message per
turn. Gone panes are archived. The mirror never types into a pane, except the guarded "Send to FIRSTMATE"
button (only when the pane is idle and its input box is empty).

### 🎧 Voice
The owner joining the configured voice channel turns voice mode on. Answers are spoken (Kokoro TTS); the owner's
speech is transcribed locally (faster-whisper) and handled like a typed message. Only the owner's audio is used.
Voice messages in text channels are transcribed the same way.

### ⏰ Reminders
`/remind <text>`, for example "in 2 hours call mom" or "tomorrow 9am pay rent". The time is parsed locally
(chrono-node, no model call); a date without a time means 09:00.

### 🔄 Restart-when-idle gate
Restart with `scripts/restart-when-idle.sh` (detached, for example through `systemd-run --user --collect`), never
from inside a run. It first runs the gate (`bash -n`, typecheck, `bun test`) and refuses on failure. Then it waits
until no job runs and the owner is not in a voice call. After 10 min it drains: new jobs stay queued (saved, run
after the restart) while running jobs finish. After 2 h of a busy bot it gives up and posts one notice.

### Loopback API
Other local services post through `127.0.0.1:47821` (`/post`, `/messages`, `/asks`, `/health`, `/drain`,
`/secret-drop`, `/incident`). Requests must use the loopback host, carry no browser `Origin` and be JSON. Details:
docs/REFERENCE.md.

## Run

```sh
bun install
bun run typecheck && bun test
cp systemd/omp-discord-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now omp-discord-bot
journalctl --user -u omp-discord-bot -f
```

## License and status
Personal project, shared as is. Read [SCRUB-REPORT.md](SCRUB-REPORT.md) for what was removed from the private
original.
