# FIRSTMATE dashboard deep-link contract (owner 2026-10-18)
Base: `$FM_DASHBOARD_URL` from kit.env (example: http://127.0.0.1:8790/firstmate/, or https://<host>.<your-tailnet>/reports/firstmate/ through `tailscale serve`)
Query params (read on load AND kept in sync with the address bar on every tab/filter/card change, history.replaceState; nuqs-style, plain JS is fine):
- item=<id>        open the page scrolled to that card, expanded and highlighted
- tab=needs|open|progress|running|reports|done|all   select that tab/filter
- since=<epoch ms> IGNORED since 2026-10-19 (owner: "Changed in this reply" strip and 🆕 tags removed; do not restore). The bot may still send it.
- by=run:<id>       with since: only cards whose last change came from that run (fm writes `by`; the bot passes OMP_GATE_RUN). Without by, edits by fm-autoclear (`by: autoclear`) are not shown.
- q=<text>         prefill search
- report=<path>    open that report inside the dashboard viewer
- svc=<groups>     ⚙️ Running → Background services accordion: comma list of group names to open (case-insensitive, e.g. svc=Builds,Reminders); `!Group` keeps a group closed that would open by default. Default without svc: groups with a failed unit open, others closed. svc alone implies tab=running.
Unknown or missing ids fall back gracefully (toast "card not found", show All).

# UI ↔ function contracts (owner 2026-10-19: "watch out for these contracts between UI and functionality")
Every contract below names the writer, the reader and the test that guards it. `firstmate-tests` (kit/bin, linked into ~/.local/bin) runs all tests; timer every 30 min + after fm/app.js changes; failure → one alerts-channel post per incident, plus a recovery post.

| # | Contract | Writer → reader | Test |
|---|---|---|---|
| C1 | Card click ALWAYS opens the Discord message: card href = `q` else `src`, and both must match `https://discord.com/channels/<g>/<c>/<m>`. No q/src → card is not a link. | `fm q`, `fm field src`, `fm add --q/--src`, `fm receipt --q/--src` (all reject non-Discord URLs) → app.js | fm-unit-test.py, link-contract-e2e.cjs |
| C2 | Any other target (GitHub PR, report, page) lives in `l` and renders as a SEPARATE button: internal report → "📄 Open report" (viewer), external → "🔗 … ↗" new tab. | `fm field l` → app.js | link-contract-e2e.cjs |
| C3 | Deep links ?item ?tab ?since ?by ?q ?report ?svc (above) are read on load and kept in the address bar. Unknown id → toast + All. | bot dashlink.ts → app.js | state-semantics-e2e.cjs, services-accordion-e2e.cjs |
| C4 | `?report=` is untrusted: only same-origin dashboard reports open in the viewer; `javascript:`, foreign or protocol-relative URLs are refused with a toast. | URL → app.js view() | state-semantics-e2e.cjs |
| C5 | States: ✍️ Needs you `waiting` (owner action, hoisted to the top of every view, needs q/src); ⚠️ Open `open` = only an unanswered owner question (needs q; `fm set open` refuses without q); 🔧 In progress `partial`; ⚙️ Running `running` (needs `job`; `fm set running` refuses without it); `blocked`, `planned`, `backlog`, `done`. | fm set → app.js filters | state-semantics-e2e.cjs, fm-unit-test.py |
| C6 | 📨 Queued: bot sets `queued` + partial when the owner responds; card keeps its Needs-you/Open filter with a 📨 badge; any state other than partial removes it; fm-autoclear (FM_AUTO) may not move a queued card back to an owner state. | bot queued.ts, fm → app.js | queued-state-e2e.cjs, fm-autoclear --test |
| C7 | Receipts: `fm receipt <card> done|failed|blocked` writes receipts/<card>.json only; fm-autoclear R11 applies it (done→done, failed→partial "needs check", blocked+q/src→blocked, else partial). | worker → fm-autoclear | fm-autoclear --test, fm-unit-test.py |
| C8 | Every write stamps `cts` (epoch ms), `by`, `hist` (last 5); (`?since=`/`by` display removed 2026-10-19 by owner; `by` stamps remain.) `fm beat` changes only `beat`/`beatNote`. | fm → app.js, fm-autoclear R12 | state-semantics-e2e.cjs |
| C9 | ⚙️ Running → Background services accordion from running.json; groups with a failed unit open by default; `?svc=` overrides. | build-running.py → app.js | services-accordion-e2e.cjs |
| C10 | Claude plan limits header from limits.json; missing file = no header, no error. | Discord bot limit watch → app.js | (visual; covered by page-load error check in link-contract-e2e.cjs) |
| C11 | Report viewer: reports.json lists reports; viewer opens in-page with back button and `?report=` history entry. | build-index.py → app.js | state-semantics-e2e.cjs |
| C12 | Tests never mutate live items.json: fm tests use `FM_ITEMS=<tmp fixture>`; browser tests read live or serve a temp copy. | — | firstmate-tests |

## Card link contract (owner 2026-10-19)
- Card link contract (owner 2026-10-19): tapping a dashboard card ALWAYS opens its Discord message, so `q`/`src` must be Discord message URLs (https://discord.com/channels/…). Put GitHub PRs, reports or other targets in `l`; the card shows them as a separate button ("🔗 Open the PR on GitHub ↗"). Test: `node kit/dashboard/tests/link-contract-e2e.cjs`. Card dashboard-vike adds `fm` validation and a full contract test suite.
