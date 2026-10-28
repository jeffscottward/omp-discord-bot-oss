# OMP session commands in Discord

Card `omp-discord-commands-build` (owner pick 2026-10-21). Spec: `~/Documents/reports/web/omp-discord-commands/report.md`.
Code: `src/sessioncmds.ts` (Discord commands and buttons), `src/ompsession.ts` (RPC client, session lock, session files, channel state).

## Routes

- Turns stay `omp -p` (unchanged). Channel settings from `/mode` are passed as CLI flags on every turn
  (`--thinking`, `--advisor`, `--tools`, `--config <overlay>`). `/resume` pins `--resume <file>`; `/new` and `/clear`
  start the next turn without `--continue`.
- Session commands (`/compact`, `/context`, Shake, Export, Handoff, Rename, Branch, `/btw`) and read-only views with an
  RPC handler (`/tools`, `/mcp list`, `/changelog`, `/modelpreset`, `/memory view`, `/todo`) run in a short-lived
  `omp --mode rpc --no-ui --session-dir <channel session> --continue` process. Only the slash commands in
  `RPC_SLASH` pass; a reply with `agentInvoked: true` is aborted. `/login`, `/logout`, `/setup` and other auth
  commands are never sent.
- Session lock: every RPC operation holds `withSessionLock(key)`; `runOmp` waits for it before it spawns. Commands
  refuse while a turn runs or waits in the same channel (`busy`).
- Session key per channel: same logic as normal turns (thread id, `dm-<id>`, `voice-<id>`, mirrored channel side
  session; `-venice`/`-qwen` suffix for isolated models). The pane's own session of a mirrored channel is never touched.

## Spike result (2026-10-22, omp 18.12.5, main)

Run with `/tmp/rpcspike.ts` on COPIES in `/tmp/spike-sess` (never on a live channel session):

| Copy of | Command | Result |
|---|---|---|
| `sessions/cli-test`, `sessions/int-test` (empty) | `get_state` | success, 735 ms |
| same | `prompt "/context"` | success, `agentInvoked: false`, 309 ms |
| same | `compact` | refused: "Nothing to compact (session too small)" |
| `sessions/100000000000000039` (55 KB, 1 user / 9 assistant messages) | `prompt "/context"` | success, `agentInvoked: false`, 316 ms |
| same | `compact` | success, 11.4 s, returned a summary |
| same | `get_session_stats` after compact | 0 user / 3 assistant messages (was 1 / 9): the copy's JSONL was compacted |

Conclusion: RPC works for `/compact` and `/context`. The fallbacks of the report (read the JSONL for read-only
views) are used only for `/resume`, `/tree` lists and the session info title/counts.

## Phases

Phases are switched on one by one in `src/main.ts` (`SESSION_PHASES`) after a live test of the previous one.

1. `/session` (info + New/Resume/Compact/Clear/Rename/Export/Handoff/Delete), `/context` (+Shake), `/resume`, `/compact`, 🔁 Retry under a failed run.
2. `/mode`, plan approval buttons, `/todo`, `/jobs` (Stop), `/tools`, `/mcp`, `/changelog`.
3. `/branch`, `/tree`, `/fork`, `/btw`, `/goal`, `/loop` (bounded), `/modelpreset`, `/ompmemory`, `/seance`.
