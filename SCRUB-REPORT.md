# Scrub report

Source: the owner's private bot repository, commit 42a8edf (2026-10-26), exported with `git archive` (no history).
The private repository was not changed. This repository has ONE orphan commit (history replaced on the owner's
request, 2026-10-26).

## Removed
- A newsletter login automation for one account, its timer, buttons and tests.
- An account snapshot tool in `gate/` and two owner-account slash commands.
- A symbol-link feature for finance alerts, its test and its config field.
- Account data-center ping targets in `/net`.
- One-off migration scripts and report generators with fixed home paths or owner data.
- Python build artifacts (`__pycache__/`, now in `.gitignore`).

## Replaced
| Original | Replacement |
|---|---|
| 49 real Discord guild/channel/user/message IDs | synthetic IDs `1000000000000000NN` or config placeholders |
| tailnet name and host (`*.ts.net`) | `my-host.example-tailnet.ts.net` |
| tailnet and LAN IPs | `100.64.0.10`, `192.0.2.10` (documentation ranges) |
| home path, user name, email | `$HOME`, `owner`, `owner@example.com` |
| account services, remote server | generic `status-monitor` proxy, `remote` host |
| finance-domain stack, units and keywords | neutral finance stack (budgets, invoices, taxes); units `example-bot`, `ex-*`, `rebalance` |
| game names, streaming server | `demo-app`, `demo-tool`, `stream server` / `streamsrv` |
| machine names | `main` / "the main host"; optional peer = `second` / "second machine" |
| client project and newsletter names | `Client Co` / `clientco`, `newsletter` |
| GPU model in a test fixture | `NVIDIA Example GPU` |

Kept on purpose:
- The word "broker" for the approval broker and host-exec broker (a process that runs approved commands).
- Generic guards: keyword routing, account-number redaction, read-only status proxy.
- Omarchy as the tested platform (the reminder command depends on it).

## Scan results (2026-10-26)
- Real-ID scan: all 49 real IDs from the private repository, over files and full git history: **0 hits**.
- String scan over files and full history (tailnet, user name, email, newsletter, account services, remote server,
  finance-domain terms, client, game, streaming and machine names): **0 hits**. The pattern list is in the task record.
- `gitleaks dir` and `gitleaks git` (default rules, `.gitleaks.toml`): **no leaks found**. Allowlisted test files
  with fake tokens: `test/quickreply.test.ts`, `test/secretdrop.test.ts`.
- `bunx tsc --noEmit`: pass. `bun test`: 747 pass, 0 fail.
- Commit author and committer: `omp-discord-bot <noreply@users.noreply.github.com>`.

## README validation
The README was rewritten and checked against `src/`, `docs/FEATURES.md` and `docs/UX-DECISIONS.md`.

Added (each checked against the named code): FIRSTMATE router and stacks with `scripts/stack-add.ts`
(`src/router.ts`); transient reply threads in alert channels (`src/main.ts`); master queue sections and count
lines with no "+N more" (`src/masterqueue.ts`); the Needs-you admission rule (`src/needsyou.ts`); ask menus with
✏️ Other and the refusal of numbered-list questions (`src/ask.ts`, `src/http.ts`); two-tier `/models` with
per-provider sessions (`src/models.ts`, `src/omp.ts`); approvals with no expiry (`src/approvals.ts`); secret drop,
handoff, 🩺 Check and 🔁 Retry (`src/secretdrop.ts`, `src/handoff.ts`, `src/diagnose.ts`, `src/failcause.ts`);
mirror channel names and emoji sort (`src/mirror.ts`); voice, reminders and the restart-when-idle gate.

Removed or corrected: the owner channel table; the "30-minute expiry" for approvals; stale code comments in
`src/models.ts`, `src/approvals.ts` and `src/masterqueue.ts`. Detailed internals moved to `docs/REFERENCE.md`.
