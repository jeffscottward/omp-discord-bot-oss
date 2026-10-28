# Setup

This guide installs your OWN copy of the bot, the FIRSTMATE dashboard, voice and reminders. The features are in
[FEATURES.md](FEATURES.md).

- Steps marked **🖐️ MANUAL** need you: a web page, the phone, or a choice. The bootstrap script cannot do them.
- All other steps are done by `scripts/bootstrap.sh` (§3), or are checks.
- Placeholders: `<GUILD_ID>`, `<OWNER_ID>`, `<CHANNEL_ID>`, `<APP_ID>`, `<YOUR_TAILNET_HOST>` (for example
  `myrig.tailXXXX.ts.net`), `<REPO>` (the folder of this repo). Replace them with your own values.
- Never put tokens or keys in the repo, in Discord or in screenshots. Secret files have mode `600`.

Time: about 1 hour for the core, plus 30 min for voice and the phone Shortcuts.

---

## 1. Prerequisites

### 1.1 Operating system

- **Linux with systemd user services. Omarchy (Arch) is the tested system.** The bot uses `systemctl --user`,
  `bwrap` and Herdr.
- **Other distros** (Debian, Ubuntu, Fedora): install the same tools with your package manager. Run
  `loginctl enable-linger $USER` so user services run without a login session.
- **macOS:** not supported as the bot host. There is no systemd and no `bwrap`, so the sandbox, timers and
  approvals do not work. You can use a second machine as a mirrored **peer** machine (Herdr + OMP over SSH, `mirror.peers`).

### 1.2 Packages

| Tool | Why | Omarchy / Arch |
|---|---|---|
| `bun` | runs the bot | `mise use -g bun` or `pacman -S bun` |
| `git`, `curl`, `jq` | basics | `pacman -S git curl jq` |
| `bubblewrap` (`bwrap`) | run sandbox | `pacman -S bubblewrap` |
| `python` 3.11+, `uv` | kit scripts, voice servers | `pacman -S python uv` |
| `ffmpeg` | voice | `pacman -S ffmpeg` |
| `omp` | the agent | §5 |
| `herdr` | panes, mirror, approvals | §6 |
| `tailscale` | phone access (optional) | §8 |
| NVIDIA driver + CUDA | faster voice (optional) | Omarchy NVIDIA setup |

The bootstrap (§3) checks each tool and tells you what is missing.

---

## 2. Discord

### 2.1 🖐️ MANUAL — Create the application and the bot

1. Go to <https://discord.com/developers/applications> → **New Application**. Name it (for example `OMP 🤖`).
2. Copy **Application ID** from **General Information**. This is `DISCORD_APP_ID`.
3. Open **Bot**:
   - **Reset Token** → copy the token. This is `DISCORD_BOT_TOKEN`. You see it only once.
   - Turn **Public Bot** OFF (only you can invite it).
   - Under **Privileged Gateway Intents**, turn ON **Message Content Intent**. The other two privileged intents
     (Presence, Server Members) stay OFF.
4. The bot uses these gateway intents (`src/main.ts`): Guilds, Guild Messages, **Message Content** (privileged),
   Direct Messages, Guild Voice States. Partials: Channel, Message.

### 2.2 🖐️ MANUAL — Create the server

1. In the Discord app: **+** → **Create My Own** → **For me and my friends**. This is your private server. Do not
   add other people: the bot obeys only you, but the channels show your agent work.
2. **User Settings → Advanced → Developer Mode: ON.** Now a right-click (long-press on the phone) on a server,
   channel or user shows **Copy ID**.
3. Copy these ids:
   - Server → **Copy Server ID** → `<GUILD_ID>`.
   - Your own name → **Copy User ID** → `<OWNER_ID>`.

### 2.3 🖐️ MANUAL — Create categories and channels

Channel names start with a topic emoji (owner rule). Use these names or your own. Copy each id (right-click →
**Copy Channel ID**) for `config.json`.

| Category | Channel | Type | config.json key |
|---|---|---|---|
| (top, no category) | `📊-dashboard` | text, read-only for you | — (link to the dashboard; pin it yourself) |
| `💬 Chat` | `💬-general` | text | `channels.<id> = {name: "general", cwd: "~/Github"}` |
| `💬 Chat` | `🛠️-dev` | text | `channels.<id> = {name: "dev", cwd: "~/Github"}` |
| `🔔 Alerts` | `🚨-omp-alerts` | text | `alertsChannelId`, and in `alertChannels` |
| `🔔 Alerts` | `⏱️-long-running-jobs` | text | `longJobsChannelId` |
| `🔔 Alerts` | `🎧 OMP Voice` | voice | `voiceChannelId` (optional) |
| `🔔 Alerts` | `🎙️-voice-transcript` | text | `voiceTranscriptChannelId` (optional) |
| `🔔 Alerts` | `📻 Lofi Radio` | voice | `radioChannelId` (optional) |
| `🖥️ Local` | `👷‍♂️-firstmate` | text | `firstmateChannelId` |
| `🖥️ Local` | — (the bot adds mirror channels here) | category | `mirror.categories.local` |
| `💻 Peer` | — (only with a second machine) | category | `mirror.categories.peer` |
| `📦 Archive` | — (finished channels move here) | category | `mirror.categories.archive` |
| `📌 Pinned` | — (optional; channels you move here stay) | category | — |

Each `channels` entry is one "run" channel: a message there starts an OMP run in that working folder (`cwd`). Add as
many as you like (for example one per project).

Copy the category ids too: right-click the category → **Copy Category ID**.

### 2.4 Bot permissions and the invite link

The code uses these permissions:

| Permission | Bit | Why |
|---|---|---|
| Manage Channels | 4 | create, rename, move, sort and archive mirror channels |
| Add Reactions | 6 | ⏳ ✅ ❌ status reactions |
| View Channels | 10 | read channels |
| Send Messages | 11 | answers, queue message |
| Manage Messages | 13 | replace the owner's voice message with its transcript |
| Embed Links | 14 | link previews |
| Attach Files | 15 | audio replies, `📎 attach:` files |
| Read Message History | 16 | reply links, edit old status messages |
| Use External Emojis | 18 | the animated spinning-gear emoji |
| Connect | 20 | voice channel |
| Speak | 21 | spoken replies |
| Create Public Threads | 35 | one thread per run |
| Send Messages in Threads | 38 | answers in threads |
| Pin Messages | 51 | pin the plan-limit message |

Permissions integer: **`2252109054864464`**. (Discord moved pinning to its own bit 51 in 2025. If the Developer
Portal shows no **Pin Messages**, the pin fails without harm.)

🖐️ **MANUAL — Invite the bot.** Open this URL in a browser (replace `<APP_ID>`), pick your server, and accept:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=2252109054864464
```

Scopes: `bot` and `applications.commands` (slash commands).

After the invite, check the voice channel: the bot role must be able to **View Channel**, **Connect** and **Speak**
there. The bot has no Manage Roles, so set channel permission overrides by hand if you want them.

### 2.5 🖐️ MANUAL (optional) — Spinning-gear emoji

The running reaction is an animated application emoji. After `bot.env` exists (§3), run once:

```sh
bun scripts/make-spin-gear.ts
```

Put the emoji id it prints into `config.json` `workingEmoji`. Without it, the bot uses ⚙️.

### 2.6 🖐️ MANUAL (optional) — Second application for Lofi Radio

Discord allows one voice connection per bot per server. The radio needs its own application: repeat §2.1 (no
privileged intents needed) and invite it with permissions View Channels + Connect + Speak (integer `3146752`):

```
https://discord.com/oauth2/authorize?client_id=<RADIO_APP_ID>&scope=bot&permissions=3146752
```

Save its token in `~/.config/omp-discord/radio.env` as `RADIO_BOT_TOKEN=<token>` (mode 600).

---

## 3. Run the bootstrap

Clone the repo (for example to `~/Github/tools/omp-discord-bot`), then run the bootstrap from the checkout. Run the
dry run first: it prints every step and writes nothing outside `/tmp`.

```sh
cd ~/Github/tools/omp-discord-bot
scripts/bootstrap.sh --dry-run          # preview
scripts/bootstrap.sh                    # asks for the token, app id, your user id, server id, machine name
scripts/bootstrap.sh --voice            # same, plus local speech (Whisper + Kokoro models, about 350 MB)
```

What it does, in order (it is safe to run again; it never overwrites existing config or data files):

1. Checks the prerequisites (§1.2). Required tools that are missing stop the script.
2. `bun install --frozen-lockfile`.
3. Writes `~/.config/omp-discord/bot.env`, `config.json` (from `config.example.json`) and `kit.env`
   (from `kit/kit.env.example`), mode 600. Existing files are kept.
4. Installs the bot's systemd user units from `systemd/` (paths point at your checkout). A unit that already
   exists with different content is kept; compare it by hand.
5. Runs `kit/install.sh`: the `fm` tools in `~/.local/bin`, the dashboard files in `FM_DIR`, the kit timers.
6. With `--voice`: downloads the Kokoro model files to `KOKORO_DIR` (default `~/Github/tools/kokoro-tts`) and makes
   its Python venv (GPU build of onnxruntime when `nvidia-smi` exists). Whisper runs through `uv run`.
7. Runs the self-tests: `bun test`, the typecheck and `kit/test.sh` (fixture data only). `--skip-tests` skips them.
8. With `--enable`: `systemctl --user enable --now` for the bot (and speech units with `--voice`) and the kit
   timers. Without it, nothing starts.

🖐️ **MANUAL:** after the script, complete `~/.config/omp-discord/config.json` with the ids from §2.3, then run
`scripts/bootstrap.sh --enable`. Options: `--yes` (no prompts, placeholders only), `--skip-tests`.

---

## 4. Config files (reference)

| File | Content | Mode |
|---|---|---|
| `~/.config/omp-discord/bot.env` | `DISCORD_BOT_TOKEN=…`, `DISCORD_APP_ID=…` | 600 |
| `~/.config/omp-discord/config.json` | ids from §2 (example: `config.example.json`) | 600 |
| `~/.config/omp-discord/kit.env` | kit settings (example: `kit/kit.env.example`) | 600 |
| `~/.config/omp-discord/radio.env` | `RADIO_BOT_TOKEN=…` (optional) | 600 |
| `~/.config/omp-discord/trusted` | exists = trusted mode on (§11) | — |
| `~/.config/omp-discord/shortcut-key`, `shortcut-login` | made by the bot for the Shortcut (§9) | 600 |

`config.json` keys (full list with comments: `config.example.json`): `ownerId`, `guildId`, `channels`,
`alertChannels`, `alertsChannelId`, `firstmateChannelId`, `voiceChannelId`, `voiceTranscriptChannelId`,
`longJobsChannelId`, `radioChannelId`, `localModelChannelId`, `localOmpChannelId`, `localOmpTools`, `mirror {categories {local, peer, archive}, peers [{machine, ssh, herdr}]}`,
`dashboardUrl`, `fmDir`, `hostLabel`, `workingEmoji`, `heeler {host, redirect}`, `optionalCommands`,
`features {newsletterLogin}`. Leave `optionalCommands` empty and `newsletterLogin` false: those are the owner's own
hardware and accounts (see docs/FEATURES.md, "Owner-only pieces"). `fmDir` must be the same folder as `FM_DIR`
in `kit.env`.

### 🧠-local-omp channel (local model inside OMP)

Set `localOmpChannelId`. Owner messages there run one OMP turn with `local-coder/local-coder` (llama.cpp on
127.0.0.1:8091) and nothing else: OMP uses its own agent dir (`state/local-omp-agent`, local model only, no
credentials, advisor and auto thinking off), runs in bwrap (`$HOME` hidden, only `~/discord-scratch/local-omp`
writable), and a run stops when any non-local model appears. One session per channel is resumed each turn;
`reset` starts a new one. When local-coder is off the channel says so and nothing runs. Default tools:
`read` (files and URLs), `grep`, `glob`, `write`, `edit`. To allow commands, set `localOmpTools` to
`"read,grep,glob,write,edit,bash"` and restart the bot; bash then runs inside the same sandbox.

More channels: list them in `localOmpChannelIds`. Each channel uses the same handler and the same model pin, with
its own session and work dir (`local-omp-2`, `local-omp-3`, …). The pane mirror leaves these channels alone.

Archive categories: Discord allows 50 channels per category. Put more archive category ids in
`mirror.archives`; the mirror uses the first archive category with room. A failed move is logged and retried.

---

## 5. 🖐️ MANUAL — OMP and your own Claude sign-in

1. Install OMP (follow the OMP install guide; the bootstrap checks that `omp` is on `PATH`).
2. Run `omp` in a terminal, then type `/login` and sign in with **your own** Claude subscription in the browser.
3. Check: `omp usage` shows your plan windows.

Use only your own account. Never copy another person's `~/.omp` folder, tokens or sign-in. The bot reads only
`omp usage --json --redact`; it never reads credential data.

## 6. Herdr

1. Install Herdr (follow the Herdr install guide). Check: `herdr agent list` prints JSON.
2. 🖐️ **MANUAL:** start Herdr, make a workspace, and open one tab labelled `FIRSTMATE` that runs `omp`. This is the
   FIRSTMATE session. Its mirror channel name starts with `👷‍♂️`.
3. Approval tabs open in the Herdr workspace `OMP_BOT_APPROVAL_WORKSPACE` (default `Github`). Make that workspace,
   or set the env var in the service.

## 7. Start and check the bot

```sh
systemctl --user status omp-discord-bot
journalctl --user -u omp-discord-bot -f
curl -s 127.0.0.1:47821/health
```

🖐️ **MANUAL:** write `hello` in a run channel. The bot opens a thread, reacts ⏳ then ✅, and answers. Type `/help`.

---

## 8. Tailscale, dashboard and report pages (optional)

The dashboard, report pages and phone Shortcuts are reachable only inside your tailnet (your own devices). Nothing
is public.

1. 🖐️ **MANUAL:** install Tailscale on the server and on the iPhone, and sign in to the same tailnet. In the admin
   console, turn on **MagicDNS** and **HTTPS Certificates**.
2. Find your host name: `tailscale status --json | jq -r .Self.DNSName` → `<YOUR_TAILNET_HOST>` (drop the end dot).
3. Publish the local servers (one time; `tailscale serve` keeps the config):

   ```sh
   sudo tailscale set --operator=$USER   # once, so serve works without sudo
   tailscale serve --bg --set-path /reports   http://127.0.0.1:8790
   tailscale serve --bg --set-path /firstmate http://127.0.0.1:47823/firstmate
   tailscale serve --bg --set-path /reminders-inbox http://127.0.0.1:47830   # only with the reminders inbox
   tailscale serve status
   ```

   - `/reports` → report pages and the dashboard (`REPORTS_PORT`, default 8790; folder `REPORTS_WEB_DIR`).
   - `/firstmate` → the Shortcut endpoint in the bot (port 47823).
4. Set `kit.env` `FM_DASHBOARD_URL=https://<YOUR_TAILNET_HOST>/reports/firstmate/` and `config.json`
   `dashboardUrl` to the same URL. Restart through `scripts/restart-when-idle.sh`.
5. 🖐️ **MANUAL:** open `https://<YOUR_TAILNET_HOST>/reports/firstmate/` on the phone (Tailscale on). Add it to the
   home screen. Put the link in the `📊-dashboard` channel and pin that channel for yourself.

Without Tailscale: keep the defaults (`http://127.0.0.1:8790/…`). The dashboard then works only on the server.

---

## 9. 🖐️ MANUAL — iPhone Shortcuts (optional)

Tailscale must be ON on the phone for all Shortcuts.

### 9.1 Share sheet: send a link

No Shortcut needed. In any app: **Share** → **Discord** → pick a run channel → **Send**. The bot opens a thread and
starts a run.

### 9.2 "Firstmate" Shortcut: send a prompt to FIRSTMATE

1. On the server, in `<REPO>`, make a new key and a one-time setup link. The script prints the link, never the key:

   ```sh
   bun scripts/shortcut-setup.ts https://<YOUR_TAILNET_HOST>
   tailscale whois --json $(tailscale ip -4) | jq -r .UserProfile.LoginName > ~/.config/omp-discord/shortcut-login
   chmod 600 ~/.config/omp-discord/shortcut-login
   ```

   The second line writes your own tailnet login. The endpoint refuses every other login, and it refuses all
   requests when this file is missing.
2. On the iPhone, open the printed setup link (`https://<YOUR_TAILNET_HOST>/firstmate/setup/<NONCE>`) within 12 h. The page works **once**.
   Tap **Copy key**.
3. Shortcuts app → **+** → build these actions:
   1. **Dictate Text** (or **Ask for Input** → Text). Optional: Stop Listening **After Pause**.
   2. **Get Contents of URL**
      - URL: `https://<YOUR_TAILNET_HOST>/firstmate`
      - Method: **POST**
      - Headers: `Authorization` = `Bearer <KEY>` (one space after `Bearer`)
      - Request Body: **JSON**, key `text` = **Dictated Text**
   3. **Get Dictionary Value**: key `message` from **Contents of URL**.
   4. **Show Notification** with the **Dictionary Value**.
4. Name it **Firstmate**. Add it to the home screen, a widget or the Action Button, or say "Hey Siri, Firstmate".
5. **Voice note instead of dictation** (better transcription, needs §10): replace action 1 with **Record Audio**
   (Audio Quality **Normal**, Start Recording **Immediately**, Finish Recording **On Tap**). In action 2, set
   Request Body to **File** and pick **Recorded Audio**.
6. Test: run it. The notification says the prompt was accepted; a `📱 from Shortcut` note and then the answer
   appear in the FIRSTMATE channel.

### 9.3 "Send Reminders to Main" Shortcut: sync iPhone Reminders (optional)

This needs the reminders inbox service (port 47830, published at `/reminders-inbox` in §8). Use
`https://<YOUR_TAILNET_HOST>/reminders-inbox` as `<INBOX>` below.

Shortcuts app → **+** → name it **Send Reminders to Main**. Build these actions in this order:

**Part A — create reminders the bot queued** (`/remind` and agents):

1. **Get Contents of URL**: URL `<INBOX>/add-queue`, Method **GET**.
2. **Split Text**: input = result of step 1, separator **New Lines**.
3. **Repeat with Each**: input = **Split Text**. Inside the repeat:
   1. **Split Text**: input **Repeat Item**, separator **Custom** = `space | space` (a space, a vertical bar, a
      space).
   2. **Get Item from List**: **First Item** of the step 3.1 result (the title).
   3. **Get Item from List**: **Last Item** of the step 3.1 result (the due date).
   4. **Get Dates from Input**: input = the step 3.3 result.
   5. **Add New Reminder**: Title = step 3.2 result. Tap **Show More**, turn on **Remind Me**, date = step 3.4
      result. List = your normal list.
4. **End Repeat**.

**Part B — delete reminders the agent asked to delete:**

5. **Get Contents of URL**: URL `<INBOX>/delete-queue`, Method **GET**.
6. **Split Text** by **New Lines**.
7. **Repeat with Each** item. Inside: **Find Reminders** where **Title is Repeat Item**, then **Remove Reminders**
   with the found reminders. (Turn on **Allow Deleting Without Confirmation** in the Shortcut settings if you want
   no prompt.)
8. **End Repeat**.

**Part C — send all open reminders:**

9. **Find Reminders**: filter **Is Not Completed**, sort by **Due Date**, **Limit** off.
10. **Repeat with Each** found reminder. Inside: **Text** = `[Title] | due: [Due Date] | list: [List]` (tap each
    field → **Repeat Item** → pick the field).
11. **End Repeat**, then **Combine Text**: **Repeat Results**, separator **New Lines**.
12. **Get Contents of URL**: URL `<INBOX>/reminders`, Method **POST**, Request Body **File** = **Combined Text**.

Test: tap ▶️. The result says `ok N reminders, 0 still queued for deletion`.

Run it automatically: **Automation** → **+** → **Time of Day** → for example 4:00 and 16:00 (or hourly) →
**Run Immediately** → **Send Reminders to Main**.

---

## 10. Voice (optional)

1. GPU: an NVIDIA GPU with CUDA makes speech fast. Without a GPU, both servers fall back to the CPU (slower: a
   few seconds per reply on a modern CPU).
2. Speech to text: `omp-whisper.service` runs `scripts/whisper_server.py` with faster-whisper model **`small`**
   (CUDA `float16`, else CPU `int8`). `uv` downloads the model at first start. Socket:
   `$XDG_RUNTIME_DIR/omp-whisper.sock`.
3. Text to speech: `omp-tts.service` runs `scripts/tts_server.py` with **Kokoro** (`kokoro-v1.0.onnx`,
   `voices-v1.0.bin`, voice `af_heart`) on onnxruntime (CUDA provider first, CPU fallback). Socket:
   `$XDG_RUNTIME_DIR/omp-tts.sock`. 🖐️ **MANUAL** if the bootstrap did not do it: download the two model files from
   the kokoro-onnx releases into the model folder that `tts_server.py` reads.
4. Check: `systemctl --user status omp-whisper omp-tts` shows `ready device=…` / `ready provider=…` in the log.
   Then `bun scripts/voice-selftest.ts` joins the voice channel and plays two test lines.
5. 🖐️ **MANUAL:** join `🎧 OMP Voice` and say something. A `🎙️ from <name>:` transcript appears and the answer is
   spoken.

## 11. 🖐️ MANUAL — Choose sandbox mode or trusted mode

| | Sandbox (default) | Trusted |
|---|---|---|
| How runs start | `bwrap` with a capability profile | as your user, full environment |
| Secrets, `~/.ssh`, `sudo` | hidden or blocked | available |
| Extra actions | `omp-approve` → Herdr tab → your login password | `omp-approve` → **Approve** button |
| Passwordless sudo | no | yes (`/etc/sudoers.d/90-omp-discord-trusted`) |

- Switch: `scripts/trusted.sh on|off|status`.
- **Risk of trusted mode.** Every shared link, web page or file the agent reads can contain hidden instructions
  (prompt injection). In trusted mode such a run can do anything your user can do, also with `sudo`, without a
  password. Use trusted mode only on a machine with nothing you cannot lose, and keep your server private.
- Start in sandbox mode. Change only when you understand the risk.

## 12. Lofi Radio (optional)

1. Do §2.6.
2. Put `.ogg` music files in `~/.local/share/omp-discord-bot/radio/`.
3. Set `radioChannelId` in `config.json` (and `RADIO_CHANNEL_ID` for the service, if the bootstrap asks).
4. `systemctl --user enable --now omp-lofi-radio`. Join `📻 Lofi Radio` to hear it. `/radio` shows its state.

## 13. HEELER (optional)

1. 🖐️ **MANUAL:** install Heeler on the phone and add your server as a Host.
2. 🖐️ **MANUAL:** deploy your own link Worker: `cd heeler-link && bunx wrangler deploy` (your Cloudflare account and
   your own domain). Set the Worker URL in the bot config. Without it, approve in the terminal tab on the server.

---

## 14. Troubleshooting

**The bot does not answer.**

- `journalctl --user -u omp-discord-bot -n 50`. Look for a login or token error.
- Message Content Intent is OFF → the bot sees empty messages. Turn it on (§2.1) and restart.
- `ownerId` or `guildId` wrong → your messages are not "owner" messages. Check the ids (§2.2).
- The channel is not in `channels` and is not a mirror channel → the bot ignores it. Alert channels are post-only.
- `omp` not signed in → `omp` then `/login` (§5). `omp usage` must work.
- Slash commands missing → the bot was invited without `applications.commands`. Invite again with the URL in §2.4.

**Voice is silent.**

- The bot is not in the call: check View Channel, Connect, Speak on `🎧 OMP Voice`. The bot posts
  `cannot join 🎧 OMP Voice` after 3 failed tries.
- No transcript: `systemctl --user status omp-whisper` and `ls $XDG_RUNTIME_DIR/omp-whisper.sock`.
- No spoken reply: `systemctl --user status omp-tts`; check that the Kokoro model files exist.
- `ffmpeg` missing → install it.

**Dashboard 404.**

- `tailscale serve status` must list `/reports`. `curl -I http://127.0.0.1:8790/firstmate/` must give 200.
- The web files are missing in `FM_DIR` → run `kit/install.sh` again (it copies only missing files).
- The URL needs the end slash: `…/reports/firstmate/`.
- Tailscale is off on the phone.

**Shortcut 401 / 403.**

- 401 `Bad key.` → the header is wrong. It must be `Authorization: Bearer <KEY>`, with one space. Make a new key
  and setup link (§9.2) if the key is lost.
- 403 `Not allowed.` → `shortcut-login` does not match your tailnet login, or the request did not come through
  `tailscale serve`.
- 429 `Locked for 15 min after bad keys.` / `Too many prompts; wait a minute.` → wait 15 min / 1 min.
- Reminders Shortcut fails → check `tailscale serve status` lists `/reminders-inbox` and the inbox service runs.

**Approvals do not show or do not run.**

- No `Approve <id>` tab → Herdr is not running, or the workspace `OMP_BOT_APPROVAL_WORKSPACE` does not exist.
- The tab refuses: "sudo needs no password" → trusted mode's sudoers rule is on. Use `scripts/trusted.sh off`, or
  use trusted mode's **Approve** button.
- An approval expires after 30 min. `!deny <id>` cancels it.
- `omp-approve --help` prints help only; it queues nothing.

**Restart does not happen.** `scripts/restart-when-idle.sh` waits for an idle bot and never restarts while you are in
the voice call. After 2 h it gives up and posts an alert. Leave the call or let the runs finish, then `/restart`.
