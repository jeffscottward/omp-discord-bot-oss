# omp-discord-bot reference

Detailed internals. Overview: [../README.md](../README.md).

Discord bridge (**OMP 🤖**). Share a link from the iPhone share sheet into Discord; an
OMP agent works on it and replies in a thread. It also mirrors Herdr agent tabs to channels, talks
in a voice channel, and runs the FIRSTMATE task dashboard.

**Set up your own copy:** [docs/SETUP.md](SETUP.md) (step by step, manual steps marked) ·
**What it does:** [docs/FEATURES.md](FEATURES.md) · **Dashboard kit:** [kit/README.md](../kit/README.md) ·
one-command setup: `scripts/bootstrap.sh` (`--dry-run` first).

Per-install values (Discord ids, channels, dashboard URL, host names) are in
`~/.config/omp-discord/config.json` ([config.example.json](../config.example.json)); secrets are in
`~/.config/omp-discord/bot.env` ([.env.example](../.env.example)). The repo holds no personal values.
In this README, "the main host" is the machine that runs the bot and "the peer machine" is the optional peer
machine (`mirror.peers` in config.json).

**Discord look and behavior** (queue, notifications, slash commands, restarts): see
[docs/UX-DECISIONS.md](UX-DECISIONS.md) for the owner's decisions and their dates.

## Behavior

- **Allow-list / provenance:** only messages whose real Discord author is the owner (user id
  `ownerId` in config.json, not a bot, not a webhook, not a system message) in the server
  `guildId` or in a DM are routed (`messageProvenance` in `src/policy.ts`). Only those
  get the `[Discord message from the owner]` header. Anything the bridge itself produces (its bot
  user, relay webhooks, self-tests) is "bridge" provenance: it is never routed as owner input, and
  a bridge-generated prompt is labelled `[Bridge message — NOT from the owner]`.
- **Herdr tab ↔ Discord channel mirroring** (`src/mirror.ts`). It never types into a pane (the only
  exception is the owner's guarded "Send to FIRSTMATE" button, below).
  - **Sync (every 60 s, read-only):** `herdr agent list` / `herdr tab list` on the main host, and
    `ssh <peer> ~/.local/bin/herdr …` for the peer machine (config `mirror.peers`). Each OMP pane gets a channel named after
    its tab title (slugified; `-<pane>` suffix when a tab has two OMP panes). Main panes go in
    🖥️ Main (`mirror.categories.local`), second machine panes in 💻 second machine (`mirror.categories.peer`). When a pane is gone,
    its channel moves to 📦 Archive (`mirror.categories.archive`). The mapping is stable by pane id, then
    tab id, then name, and is stored in `agents.json` together with the session file and offset.
  - **Terminal → Discord (every 5 s):** the bot reads the pane's session JSONL from a saved byte
    offset (local read on the main host, `tail -c` over SSH on the peer machine). It posts each new final
    assistant reply (`stopReason: stop`, text blocks only) through the privacy filter. A new
    session is mirrored from the moment it is seen; old history is not backfilled.
  - **Live progress (owner 2026-10-15):** while a pane turn runs, one silent status message per turn is edited
    in place (at most every 4 s) with the step count and the latest 6 tool steps (tool name + the agent's `i`
    intent only). It becomes ✅ finished (or ⏹️ stopped) just before the final reply posts. The message id is
    kept in `agents.json` (`progress`), so a restart keeps editing the same message. See docs/UX-DECISIONS.md.
  - **Stall detector (plan P5 v1):** a tool call with no result while the session file does not grow for
    15 min posts one silent line "⏳ waiting on <tool> (<intent>) since HH:MM" in the pane's channel, and one
    "▶️ resumed" line when the file grows again (`src/stall.ts`; state in `agents.json` `watch`).
  - **Automatic continue (plan P5 v2, owner decision 2026-10-16):** a turn that stopped with `stopReason: error`
    and a transient provider message (socket closed, stream closed, overloaded, 5xx, rate limit; NOT a used-up
    usage limit, auth or bad-request error) is continued through the same path as a Discord message
    (`omp -p --resume`, through the queue) with the bridge prompt "Continue: the previous turn stopped on a
    transient error (<msg>)." Only when no live omp holds the session (else it posts "not continued").
    After 2 min, then 8 min; at most 2 per session per hour; errors older than 6 h are ignored. Each step is
    posted in the channel.
  - **Discord → session:** `herdr pane process-info` and the pane shell's process tree are
    checked first.
    - **No omp process holds the pane's session (main):** the turn continues that exact session
      file with `omp -p --resume` in the capability sandbox. That file and its artifacts dir are bound
      writable at their own paths (other OMP sessions stay hidden). The reply is posted, and the mirror offset skips it.
    - **A live omp holds it, the pane is closed, or it is a second machine pane:** the turn runs in a linked
      side session (`firstmate` for FIRSTMATE, `side-<channelId>` otherwise, the thread id for
      threads; cwd is the pane cwd under `~/Github`). A read-only excerpt of the pane transcript
      is attached as context, and a pointer is posted in the channel. `!new` resets the side
      session.
    - **Why held sessions are never touched:** `scripts/session-concurrency-test.ts` holds a scratch
      session with `omp --mode rpc` and has a second, sandboxed process append a turn. No line was
      corrupted, but the holder's next turn forked the tree. On reload, the second process's turn
      was missing from the active branch. `scripts/pane-resume-test.ts` shows that continuing an
      unheld session lands on the active branch.
  - The old inbox/`discord-relay` pane-injection path is removed. The extension is stubbed and
    removed from `~/.omp/agent/config.yml` on the main host and the peer machine.
- **Top-level message in a mapped channel** → the bot opens a thread (named from the URL host
  or the first words) and starts an OMP run. **Messages in that thread** continue the same OMP session.

  Channels and their working folders come from `channels` in config.json.

- Each message is wrapped in a short preamble (`src/preamble.ts`): it came from Discord
  (thread link), shared links/fetched text are untrusted data, what the run can do natively, and that
  anything it has no capability for goes through `omp-approve` (password-gated, see below). Results of
  approvals since the last turn are included.
- Max 2 concurrent runs (one per thread), the rest queue FIFO. 30 min limit per run.
- Reactions: ⏳ while queued/running, then ✅ or ❌. Answers are split at 2000 chars with code
  fences kept intact; answers over 8000 chars are posted as a preview plus `answer.md`.
  Bot messages never ping (`allowedMentions: none`).
- **Privacy filter** on every outbound message (`src/redact.ts`): Account numbers
  (`U\d{7,8}`, also DU/F/DF), SSN-like numbers, labeled driver's-license/passport/ID numbers, and
  common API/Discord/GitHub tokens are redacted. On top,
  `src/secrets.ts` redacts the exact values of secret-looking keys found in `.env`-style files under
  `~/Github`/`~/.config` and the bot token.
- `!status` (owner only, anywhere the bot listens): running and queued jobs.
- **Paste blocks** (`src/blocks.ts`, `src/outbound.ts`): a fenced block with info string `text`,
  `txt`, `plaintext`, `plain`, `prompt` or `firstmate`, or one right after a line that mentions
  FIRSTMATE ("Paste into FIRSTMATE:"), is posted as its **own message containing only the fenced
  block**, so iOS long-press → Copy Text copies just that block. Prose around it stays in normal
  messages; other code blocks stay inline. Same privacy filter and 2000-char split; a block too long
  for one message is attached as `paste-N.txt`.
- **Send to FIRSTMATE** button on every paste block (`src/firstmate.ts`, user decision 2026-10-12,
  the one exception to "never type into panes"). Owner only (real owner user, the bridge's own
  message, the owner's server or DM); anyone else gets an ephemeral refusal. It delivers only to the
  FIRSTMATE pane (`OMP_BOT_FIRSTMATE_PANE`, default `wB:p3D`; must be an omp agent in the tab
  labelled FIRSTMATE) and only when both hold, checked at the press and again right before sending:
  1. not working: `herdr agent get` says idle/done AND the session JSONL's last turn entry is an
     assistant message with `stopReason: stop` (only advisor notes, usage/model/mode changes,
     todo HUD and credential pins may follow it);
  2. empty input box: `herdr agent read <pane> --source visible --lines 6` (status bar + editor only,
     checked in memory, never logged or posted) shows nothing after `╰─` and nothing below it.
     Any layout it does not recognize is refused.
  Otherwise the owner gets an ephemeral "FIRSTMATE is busy or you are typing — try again" with a
  short reason; nothing is queued. Delivery: `herdr agent prompt <pane> "[Sent from Discord by the
  owner via button]\n\n<block>"`. Each attempt is logged (id, time, message id, status, length;
  never content) in the journal and `~/.local/share/omp-discord-bot/firstmate-deliveries.jsonl`.
  A second press on the same block within 30 s is refused.
- **HEELER links** (`src/heeler.ts`): Heeler 0.1.13+ opens
  `heeler://agent?host=<saved Host address or name>&session=<herdr session>&pane=<pane id>`. `pane`
  must be an Agent pane; without it the link opens that Host's Console. Plain shell terminals (the
  "Approve <id>" tabs) cannot be targeted. Discord buttons only accept http/https/discord URLs
  (`URL_TYPE_INVALID_SCHEME`), so the buttons point at `<heeler.redirect>?host=…&pane=…` (config `heeler.redirect`; deploy `heeler-link/` from `wrangler.example.jsonc`)
  (`heeler-link/worker.js`, Cloudflare Worker; deploy with `cd heeler-link && bunx wrangler deploy`).
  It only builds a validated `heeler://agent` URL, with no logging or storage. Paste blocks and posts in
  #firstmate get "Open FIRSTMATE in HEELER" (`pane=wB:p3D`); approval posts get "Open HEELER
  (the main host)" (the main host's Console → Terminals → "Approve <id>").

## How OMP is invoked (capability sandbox, user decision 2026-10-12)

```
bwrap <capability profile> -- sh -c 'bun netfwd.mjs 3128=… 3461=… & exec "$@"' \
  omp -p --session-dir ~/.local/share/omp-discord-bot/sessions/<key> --max-time 30m [--continue|--resume <pane session>] "<preamble + message>"
```

Owner runs behave like a native OMP session for ordinary work, but the gate is enforced by
**capability**, not by pattern matching: the run simply has no means to do the serious actions.
Those go through the password-gated approval broker, which runs outside the run.

| | Inside a Discord run |
|---|---|
| **Works natively** | Read `~/Github` and home configs; write git work trees under `~/Github`, a private `/tmp`, `~/discord-scratch` (per session) and `~/.cache`; network to any port on public hosts (HTTP/CONNECT proxy, `src/egress.ts`); the user's own environment (no env deny-list) and OMP extensions; `agent.db` writable (OMP's lease system serializes OAuth refreshes). |
| **Brokered, no approval** (`src/hostexec.ts`, per-run Unix socket, wrappers in `gate/bin`) | `git push/fetch/pull/clone/ls-remote` (https only, hooks and fsmonitor off, repo-local config limited to an allow-list; GitHub credentials stay in the keyring); `gh` (not `auth/extension/alias/config/codespace`); `systemctl --user` read verbs; `herdr` read commands (never `send-text/send-keys/run/read`); `op item list` / `op item get <name>` (labels only, never `--reveal`/JSON). |
| **Allowed directly** | status-monitor read-only API on `127.0.0.1:3461` (GET + WebSocket feeds; its POST 2FA endpoint is refused). |
| **No capability → `omp-approve`** | Remote hosts (no SSH key/agent; loopback, LAN and tailnet are refused by the proxy); money movement/purchases (no browser profiles, keyring or secret files); `sudo` (`no_new_privs`); secret values (`~/.ssh` keys, `~/.gnupg`, `~/.config/op`, `~/.1password`, keyrings, browser profiles, bot token, `gh` token and every `.env`/key/credential file under `~/Github` and `~/.config` are hidden or masked); deletions/writes outside git work trees (read-only file system); repos that user services run (`example-bot`, `status-monitor`, this bridge, … detected from `~/.config/systemd/user`) and every tree's `.git/hooks` and `.git/config` are read-only; no D-Bus, Herdr socket, host OMP daemons or other Unix sockets (all masked; `/run` empty). |

### Password-gated approval broker

1. The agent runs `omp-approve --reason '<why>' [--wait] -- '<exact command>'`. The request goes over
   the run's host-exec socket; the run cannot write the queue (`~/.local/share/omp-discord-bot/approvals`
   is hidden from it).
2. The bridge writes `pending/<id>.json` (id, exact command, cwd, channel/thread, session; no
   expiry), posts the exact command in the run's thread (owner's private channels only; others are
   rejected) with: *"Open HEELER → terminal list → 'Approve <id>' tab on the main host, check the command,
   enter your login password."* and an "Open HEELER (the main host)" link button (the main host's Console).
3. It creates a dedicated Herdr tab (`herdr tab create --env OMP_AUTO_START=0 --no-focus`), waits until
   `herdr pane process-info` shows a plain shell, then `pane run`s
   `exec bun gate/approve.ts <queue> <id> <sha256(entry)>`. It never focuses, captures or types into
   any other pane.
4. `gate/approve.ts` shows the exact command, refuses if the entry no longer hashes as posted, then
   verifies the **Omarchy login password through PAM with sudo's own hidden prompt**: `sudo -k`,
   refuse if `sudo -n true` would pass without a password, `sudo -v` (3 tries; faillock `deny = 10`),
   then `sudo -k` again before the command runs (kept only for a command that itself uses `sudo`, and
   dropped right after). The password never passes through the script and is never logged or stored;
   sudo tickets are per-tty, so no other process can use the ticket.
5. Only then it claims the entry atomically (`pending → claimed`, single use), re-checks the hash,
   runs `bash -c '<command>'` unchanged in its cwd (4-hour limit; while it runs longer than 5 minutes,
   `gate/longjob.ts` posts a "still running" line in #long-running-jobs every 5 minutes and one
   final line when it ends), writes a receipt (exit code,
   last 3000 chars through the privacy filter and the known-secret filter; output of commands that can
   reveal secrets is shown only in the tab, for 90 s) and exits, which closes the tab.
   The command runs in its own process group (same session and terminal, so the sudo ticket still
   works; `gate/procgroup.ts`). At the limit the whole group gets SIGTERM, then SIGKILL after 10 s,
   so grandchildren stop too. `omp-approve` refuses a command whose first word starts with `-`,
   also after `--`.
6. The bridge posts the receipt in the thread and hands it to the next prompt of that session
   (`--wait` returns it to the running agent). Wrong password ×3, Ctrl-C or `!deny <id>` from the
   owner close the entry with nothing run; `!deny` also closes the tab.

### Checks

- `bun test`: unit tests (`test/hardening.test.ts`: sandbox profile, broker validators, queue integrity
  — changed entry rejected, single use —, approval manager, owner-only provenance, egress) and
  `test/sandbox.int.test.ts` (real bwrap probes: `python -c` socket to the private gateway, `ssh remote
  docker exec`, `sudo -n`, reading `example-bot/.env`, `op read`, `gh auth token`, `rm` outside
  repos, writes to `~/.bashrc`/units/service repos, `systemd-run`, Herdr typing, host loopback/tailnet
  — all must fail; public HTTPS, repo reads, status-monitor snapshot, `systemctl --user is-active`,
  `herdr agent list` must work).
- `bun src/sandbox-cli.ts [--key K] [--cwd DIR] -- <cmd…>` runs any command in the same sandbox.
- `bun src/selftest.ts native|gate`: live `omp -p` runs through the production path. `gate` queues
  `rm ~/omp-gate-e2e-marker` via `omp-approve`; the running service posts it and opens the tab; the
  test cancels it through the queue and checks that the marker still exists. No password is entered.
- `!deny <id>` (owner) cancels a pending approval; `!status` lists runs.

## Local post endpoint (loopback only)

`127.0.0.1:47821` (`OMP_BOT_HTTP_PORT`), for other main services (e.g. finance alerts):

```
POST /post      Content-Type: application/json   {"channel": "dev" | "#finance" | "<channel id>", "text": "...", "files": ["/abs/path.pdf"], "replyTo"?: "<message id or Discord message link, same channel>"}
                → {"ok": true, "channel": "dev", "id": "<first message id>", "url": "https://discord.com/channels/…", "messages": [{id, url}], "attachments": [{name, url}], "asks"?: [{setId, questions: [{id, question, url}]}]}
GET  /messages?channel=<name|id>&limit=1-50[&before=<id>]   → {"ok": true, "messages": [{id, url, ts, author, bot, content (redacted), attachments, buttons, replyTo?}]}  (newest first)
GET  /asks[?channel=<name|id>]   → {"ok": true, "asks": [{setId, channelId, createdAt, questions: [{id, question, answered, url}]}]}
POST /asks/close {"setIds": [...], "reason": "asked-again"|"closed"}   → {"ok": true, "closed": [...]}  (card sweep)
POST /secret-drop {"name": "App token", "dest": "/home/…/.config/app/token", "channel"?: "firstmate", "overwrite"?: false, "ttlMin"?: 15}   → {"ok": true, "id", "url", "expiresAt", "message"}
GET  /secret-drop/<id>   → {"ok": true, "state": "waiting"|"received"|"expired", "chars"?: n}   (never the value)
GET  /health    → {"ready": true, "running": [...], "queued": [...], "max": 2, "drain": {"draining": false, ...}, ...}
POST /drain     {"on": true|false, "ttlSec": 120}   → {"ok": true, "draining": ..., "since": ..., "until": ...}   (plan P1)
POST /incident  {"key": string, "detail": string, "action": string}   → {"ok": true, "started": boolean, "reason"?: string}   (plan P12)
```

`/incident` (plan P12, caller: harness-watch) starts one agent run in a new thread under #omp-alerts
with a fixed procedure (`src/triage.ts`): investigate read-only, find the root cause, propose a fix;
every state change goes through `omp-approve`. One run per `key` per 6 h and one triage run at a time
(`started: false` with a `reason` otherwise; state in `triage.json`, 0600). The owner can reply in the
thread to continue that run's session. Bad bodies get 400 `{"ok": false, "error": ...}`.

The four mapped channels and the mirrored Herdr tab channels (by name, e.g. `firstmate`, or id) are
accepted. Text goes through the same privacy filter and splitting (paste blocks included).
Requests must use the loopback `Host`, carry no browser `Origin`, and be `application/json`
(blocks DNS-rebinding/cross-site posts from browsers).

Owner 2026-10-23: agents use the ids and links these endpoints return for card `q` links and
"read it back" checks, so they never need the bot token. A `/post` text with an ```ask block that
cannot become a menu gets 400 with the reason (options are plain strings or `{label, description}`).

`files` is optional: at most 10 absolute paths. Each must be a regular file under the same
allowed roots as `📎 attach:` lines (~/Github, ~/Documents, /tmp, ...), not in a protected
folder, and at most 10 MB. Any bad entry rejects the whole request with 400. The files are
uploaded with the last message. The `kb-debate` runner uses this to post to `#debates`.

```sh
curl -s 127.0.0.1:47821/post -H 'content-type: application/json' -d '{"channel":"dev","text":"hello"}'
```

## Secret drop (owner 2026-10-23)

`scripts/secret-drop.ts --name "<label>" --dest ~/.config/<app>/<file> [--channel …] [--overwrite] [--ttl-min 15]`
asks the bot for a one-time form and waits until the value arrives. The bot posts a 🔐 link button. The form is
served by `src/secretdrop.ts` on `127.0.0.1:47824`, exposed only through `tailscale serve` on the tailnet-only
HTTPS port (`/secret-drop` → `http://127.0.0.1:47824/secret-drop`; never the Funnel port 10000 and never the
Cloudflare share mirror). Only the owner's tailnet login (`~/.config/omp-discord/shortcut-login`) is served.
The value is written to `--dest` (tmp file + rename, mode 0600; only under ~/.config, ~/.local/state,
~/.local/share or ~/.secrets, never systemd/autostart/hypr/ssh folders) and is never logged, posted or returned.
Each link works once and expires (default 15 min, max 60). Open drops are in memory: a bot restart voids them.
Undo the route: `tailscale serve --https=443 --set-path /secret-drop off`.

## Run

Token: `~/.config/omp-discord/bot.env` (`DISCORD_BOT_TOKEN`, mode 600, never in git).

```sh
bun install
bun test && bun run typecheck
cp systemd/omp-discord-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now omp-discord-bot
journalctl --user -u omp-discord-bot -f
```

Env overrides: `OMP_BOT_MAX_CONCURRENT`, `OMP_BOT_TIMEOUT_MIN`, `OMP_BOT_STATE_DIR`,
`OMP_BOT_OMP_BIN`, `OMP_BOT_HTTP_PORT`, `OMP_BOT_APPROVAL_WORKSPACE` (Herdr workspace label for
approval tabs, default `Github`). The capability sandbox cannot be turned off.

## Trusted mode (owner decision 2026-10-13)

On while `~/.config/omp-discord/trusted` exists (checked per run). Switch it with
`scripts/trusted.sh on|off|status`: `off` removes `/etc/sudoers.d/90-omp-discord-trusted` first
(the password tab in `gate/approve.ts` refuses to run while sudo needs no password), then the flag.

- Runs are not sandboxed: `omp -p` runs as the owner's user with the real environment (minus `DISCORD*`). `/tmp` is a valid working directory.
- Same rules as a CLI session (AGENTS.md). There is no extra Discord approval layer: `omp-approve` is only for steps where a CLI session would need the owner's password or an interactive sign-in. Requests get an **Approve** button (owner only, single use, hash-checked); `gate/run.ts` runs the command with `bash -c` and writes the receipt.
- An answer line `📎 attach: <path>` uploads that file (≤ 10 MB, ≤ 10 files; `src/attach.ts`). Only from ~/Github, ~/discord-scratch, ~/Downloads, ~/Pictures, ~/Videos, ~/Music, ~/Documents, ~/Apps and /tmp (realpath; symlinks may not lead out); never secret-looking names or files under `.ssh`, `.gnupg`, `.config`, `.omp`, `.git` and similar.
- Questions: `omp -p` has no `ask` tool. A run ends its answer with a fenced ```` ```ask ```` JSON block (`{"questions":[{"id","question","options":[…],"multi"}]}`, ≤ 5 questions, 2–25 options). The bridge posts one select menu per question (owner only, 24 h) and, when all are answered, sends the picks as the owner's next turn in the same session (`src/ask.ts`).
- Question style (owner 2026-10-18, `src/preamble.ts`): each run's bridge rules get one line from the live voice state (`voicechat.ownerInCall`: the owner is in the channel, also while the bot's own voice connection reconnects; `/health` `voice` stays `active`) at the moment the queued run starts. In 🎧 OMP Voice: "ask ONE question at a time in plain text (repeat question, list choices, recommendation), no ask block, no recap after answers", and the ask-block format line is left out. Not in voice: "use ask blocks (menus) as normal". Earlier chat instructions do not change this choice. Tests: `test/voice-question-style.test.ts`.
- Restart with `scripts/safe-restart.sh [rev] [timeout]`: it first runs `scripts/restart-gate.sh` (`bash -n scripts/*.sh`, `tsc --noEmit -p .`, `bun test`) and does not restart if a check fails (exit 3). Then it checks `/health` on 127.0.0.1:47821; on failure it reverts `rev` (default HEAD), runs `trusted.sh off` and restarts again.
- `scripts/restart-when-idle.sh` (plan P1) runs the gate first, then waits for an idle bot. After 10 min it turns on a drain (`POST /drain {"on":true,"ttlSec":120}`, renewed every 10 s; `/health` field `drain`): new jobs stay queued and the board says "Restart pending", running jobs and approved commands finish, then the bot restarts. Waiting jobs are saved in `~/.local/share/omp-discord-bot/queue.json` (0600, atomic write) and queued again at start (`src/queuestate.ts`). No drain and no restart while the owner is in 🎧 OMP Voice.
- Give-up: if the bot stays busy for 2 h (`GIVE_UP_AFTER_DEFAULT=7200` in the script; time in 🎧 OMP Voice does not count), the waiter drops the pending restart instead of killing work: the drain ends, one notice goes to #omp-alerts (via `/post`) with what was still busy, and the script exits 4. Queue the restart again with `/restart`.

## Voice mode (owner request 2026-10-13)

A conversation in the voice channel **🎧 OMP Voice** (config `voiceChannelId`, 🔔 Alerts category).
The owner joining it turns voice mode on; leaving turns it off. Nobody else can turn it on, and
only the owner's audio is ever subscribed to (`src/voicechat.ts`).

- **Speak:** every final answer the bridge posts in any channel is also played in the voice
  channel. It is the same Kokoro file that is posted as the 🔊 attachment (`src/speech.ts`), so
  there is no second synthesis; the file is still posted. Utterances are queued and never overlap.
  While the bridge is talking, incoming audio is dropped (plus 400 ms), so it cannot answer the
  echo of its own voice coming back through the owner's microphone.
- **Listen:** `@discordjs/voice` hands over the owner's Opus packets. `src/segment.ts` cuts them
  into utterances: a packet counts as speech only when it is larger than a comfort-noise frame
  (12 bytes, so "always transmit" clients work as well as voice activity detection), an utterance
  ends after 1 s without speech, anything under 120 ms of speech is dropped and 60 s is the hard
  cap. Speech is counted per packet (× 20 ms), not from the first to the last timestamp, so a
  one-word answer such as "two" is not thrown away.
  The packets are written as Ogg Opus (`src/ogg.ts`: prism-media 1.3.5 demuxes but cannot mux, and
  its 2.x muxer is alpha), transcribed by `omp-whisper.service` and the file is deleted at once.
  No audio is stored and none leaves the main host except the Opus sent to Discord.
- **Where it answers:** the transcript is posted as `🎙️ from <name>: …` in the channel or thread
  the owner last wrote in (#general until they write somewhere) and handled exactly like a typed
  message, so it opens a thread in a run channel and continues the session in a thread.
- **Questions:** with voice mode on, an ```` ```ask ```` block is not posted as buttons straight
  away. The bridge says "I have N questions. Read them out, or post them?". "Post them" falls back
  to the normal numbered buttons in that channel; "read them out" reads each question and its
  numbered options. Spoken numbers answer ("two and three"), and anything else drops the questions
  and becomes a normal free-text message (`src/spoken.ts`).
  The brief said "post them" should use #omp-alerts. It posts in the answer's own channel instead:
  #omp-alerts is a post-only alert channel, so `route()` ignores messages there and the picks could
  never be sent back as the owner's next turn. The buttons have to sit where the session is.
- **Encryption and codecs under bun:** `aead_aes256_gcm_rtpsize` through node:crypto, so no
  sodium build is needed; no Opus encoder or decoder is needed either, because playback is
  `StreamType.OggOpus` (ffmpeg re-encodes the reply to 48 kHz stereo) and receiving keeps the
  packets in their container. `generateDependencyReport()` confirms this on the main host.
- The channel was created with the bot's REST access, which has no Manage Roles, so it has **no
  permission overwrites** and inherits the 🔔 Alerts category (the guild is the owner's private
  server). Add overwrites by hand to restrict it further.
- **Checking it without a second person:** `bun scripts/voice-selftest.ts` opens a second gateway
  session (no message handlers, so it reacts to nothing), joins the channel, plays two utterances
  and leaves. `test/voice-mode.test.ts` covers the other direction without anyone talking: real
  speech is synthesized, split into the Opus packets Discord would deliver, put back together by
  `src/ogg.ts` and transcribed by the same Whisper server. Both parts are skipped when ffmpeg or
  the GPU sockets are missing.
