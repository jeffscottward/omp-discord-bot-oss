"use strict";
// FIRSTMATE dashboard v3. Data: items.json (agents edit), changes.json + reports.json (build-index.py), running.json (build-running.py).
// States (owner 2026-10-18, final): waiting = owner action (hoisted everywhere), open = ONLY unanswered owner questions,
// partial = in progress (answered/accepted, queued), running = a live job works on it now (field `job`).
// Deep links (deeplink-contract.md): ?item= ?tab= ?since= ?q= ?report= ?svc= ?why= ?receipt=, kept in sync with the address bar.
const E = {waiting:"✍️ Needs you", open:"⚠️ Open", running:"⚙️ Running", partial:"🔧 In progress", blocked:"🔐 Blocked", planned:"🗺️ Planned", backlog:"🗃️ Backlog", done:"✅ Done"};
const TAB2F = {needs:"waiting", open:"open", progress:"partial", scheduled:"scheduled", done:"done", all:"all", blocked:"blocked", planned:"planned", backlog:"backlog"};
const F2TAB = Object.fromEntries(Object.entries(TAB2F).map(([k, v]) => [v, k]));
const KIND = {html:"🌐 Page", pdf:"📕 PDF", audio:"🎧 Audio", video:"🎬 Video", md:"📝 Notes"};
const $ = id => document.getElementById(id);
const m0 = location.pathname.match(/^(.*)\/firstmate\//);
const BASE = m0 ? m0[1] : "";               // "/reports" through tailscale serve, "" on 127.0.0.1:8790
const ROOT = location.origin + BASE + "/";
let D = null, R = [], C = {}, RUN = null, PRS = {}, AUD = {flow: {}, owner: {}}, raw = "", tab = "items", f = "all", rk = "all", rf = "all", openDone = false, openIdle = false;
// PR state (pstack watch-pr tiers, 2026-10-25): prstate.json from fm-prwatch, keyed by card id. Read-only badge; it never changes a card.
const PRT = {conflicts: "🟥 PR has merge conflicts", "ci-failing": "🟥 PR checks failing", "changes-requested": "🟧 PR changes requested", "review-required": "🟨 PR waits for review", draft: "📝 PR is a draft", "ci-pending": "⏳ PR checks running", "no-ci": "⚪ PR has no GitHub checks (CI may run on GitLab)", ready: "🟩 PR ready to merge"};
function prText(p) { return (PRT[p.state] || ("PR " + p.state)) + (p.detail ? " (" + p.detail + ")" : ""); }
let tagF = []; // theme tag filter (cards fm-card-tags, tag-filter-optin, owner 2026-11-06): ?tag=a,b, cards must have ALL chosen tags; works with every state filter and search
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const tagsOf = i => Array.isArray(i.tags) ? i.tags.filter(t => typeof t === "string") : [];
let lastJump = null, curItem = null, curView = null, since = null, byRun = null;
let svcOpenX = new Set(), svcClosedX = new Set(); // Background-service groups the user opened/closed against the default (failed = open)

const get = (u, type) => window.fetch(u, {cache: "no-cache"}).then(r => { if (!r.ok) throw new Error(r.status + " " + u); return type === "text" ? r.text() : r.json(); }); // no-cache = revalidate (304), card dashboard-perf

// Same id rules as build-index.py (slug of title, -2 suffix on duplicates).
function slug(t) { const s = String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, ""); return s || "item"; }
function itemIds(items) { const seen = new Set(); return items.map(i => { const base = i.id || slug(i.t); let k = base, n = 2; while (seen.has(k)) k = base + "-" + n++; seen.add(k); return k; }); }

// Map "/reports/x" links and reports.json paths to this host's URL.
function hrefOf(p) {
  if (!p) return null;
  if (/^\/reports\//.test(p)) return BASE + p.slice(8);
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/")) return p;
  return BASE + "/" + p;
}
function internal(p) { const h = hrefOf(p); if (!h) return false; try { const u = new URL(h, location.href); return u.origin === location.origin && (u.pathname + "/").startsWith(BASE + "/") && !/\/firstmate\/(index\.html)?$/.test(u.pathname); } catch (e) { return false; } }
function kindOf(p) { const x = (p.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1]; return x ? ({pdf:"pdf", mp3:"audio", m4a:"audio", wav:"audio", ogg:"audio", mp4:"video", webm:"video", md:"md", txt:"md", html:"html"}[x.toLowerCase()] || "html") : "html"; }
function relKey(p) { const h = hrefOf(p); try { return new URL(h, location.href).pathname.slice(BASE.length + 1).replace(/index\.html$/, ""); } catch (e) { return p; } }

function ago(iso) {
  const t = Date.parse(iso); if (!t) return ""; const s = (Date.now() - t) / 1000;
  if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 7 * 86400) return Math.round(s / 86400) + " d ago"; return new Date(t).toLocaleDateString([], {month: "short", day: "numeric"});
}
function until(iso) {
  const t = Date.parse(iso); if (!t) return ""; let s = Math.round((t - Date.now()) / 60000);
  if (s <= 0) return "⏰ Gate passed " + ago(iso).replace(" ago", "") + " ago";
  const d = Math.floor(s / 1440), h = Math.floor(s % 1440 / 60), m = s % 60;
  return "⏰ Opens in " + (d ? d + " d " : "") + (d || h ? h + " h " : "") + m + " min · " + new Date(t).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short"});
}
const cleared = i => i.s === "done" || (!!i.until && Date.parse(i.until) <= Date.now());
// Card mainblocker-backlog (owner 2026-11-05): a backlog card is parked and blocks nothing, unless it is a gate card
// (field gate, title "Gate: …", id "gate-…"). Same rule as omp-discord-bot src/blockers.ts parked/isGate.
const isGate = i => i.gate === true || (typeof i.gate === "string" && /^(1|true|yes)$/i.test(i.gate.trim())) || /^\s*gate\s*:/i.test(String(i.t || "")) || /^gate-/i.test(String(i.id || i._id || ""));
const parked = i => i.s === "backlog" && !isGate(i);
// 📨 Queued (owner 2026-10-18): the owner responded to a Needs-you / Open card; the Discord bot set `queued` (epoch ms)
// and partial (fm records `queuedFrom`). fm removes both when the agent sets running/done or asks again.
const isQueued = i => i.s === "partial" && +i.queued > 0;
// Owner 2026-10-25 (card needs-you-action-gate): Needs you / Open list a card ONLY when it names a concrete owner
// action (`action`) and is not answered/queued (📨). Same rule as omp-discord-bot src/needsyou.ts hasOwnerAction.
const hasAction = i => String(i.action || "").trim() !== "" && !(+i.queued > 0);
const needsOwner = i => (i.s === "waiting" || i.s === "open" || (i.s === "blocked" && /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(i.q || i.src || ""))) && hasAction(i); // blocked-question-surfacing: owner-blocked cards too. kit/dashboard/tests/state-semantics-e2e.cjs keeps a copy of this rule: change both
const actionSteps = a => String(a || "").split(/\r?\n/).flatMap(line => { // same rules as omp-discord-bot actionSteps
  let parts = [];
  if (/^\s*1[.)]\s/.test(line)) { let rest = line.replace(/^\s*1[.)]\s*/, ""); for (let n = 2; ; n++) { const m = new RegExp("\\s" + n + "[.)]\\s").exec(rest); if (!m) break; parts.push(rest.slice(0, m.index)); rest = rest.slice(m.index + m[0].length); } parts.push(rest); }
  else { let cur = "", tick = false; for (let k = 0; k < line.length; k++) { const c = line[k]; if (c === "`") tick = !tick; if (!tick && c === ";" && /\s/.test(line[k + 1] || "")) { parts.push(cur); cur = ""; continue; } cur += c; } parts.push(cur); }
  return parts.map(x => x.replace(/^\s*[-*•]\s+/, "").trim()).filter(Boolean);
}).slice(0, 6);
// Owner 2026-10-25 (answered-clears-needs, supersedes 10-18): an answered card leaves Needs you / Open / Blocked at once; it lists under In progress with the 📨 badge.
// 🗓️ Scheduled (owner 2026-10-24): the card's job is a timer/unit that is not running and has a future fire time
// (e.g. a long-dated one-off re-check). Own tab, out of the Queued/In-progress counts.
const isScheduled = i => i.s !== "done" && i.s !== "waiting" && i.s !== "open" && !jobsFor(i).some(j => j.status === "working") && (() => { const us = unitsFor(i); return us.length > 0 && !us.some(u => u.state === "running" || u.state === "failed") && us.some(sched); })();
const nextFire = i => Math.min(...unitsFor(i).map(u => Date.parse(u.next)).filter(t => t > Date.now()));
// Owner 2026-10-24: finished cards older than 12 h are not listed (search and ?item= still find them).
const staleDone = i => i.s === "done" && Date.now() - changedMs(i) > 12 * 3600e3;
const inFilter = (i, k) => !staleDone(i) && inFilterAll(i, k);
// Card dash-e2e-baseline-fails (2026-11-05): the scheduled ternary is in its own parentheses. Before, "A || k === scheduled ? … : …"
// parsed as "(A || …) ? isScheduled(i) : …", so an owner-blocked card (blocked-question-surfacing) left the ✍️ Needs you filter.
const inFilterAll = (i, k) => (k === "waiting" && i.s === "blocked" && needsOwner(i)) || (k === "scheduled" ? isScheduled(i) : k === "all" || (k === "byyou" ? i._track === "owner" : k === "bybot" ? i._track === "bot" : false) || (i.s === k && (k !== "waiting" && k !== "open" || needsOwner(i)) && !((k === "partial" || k === "running") && isScheduled(i)))); // owner 2026-10-25 (answered-clears-needs): an answered card leaves Needs you / Open at once
function queuedText(i) { return "📨 Answered " + new Date(+i.queued).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) + "; working"; }
function fmtUpdated(u) { const t = Date.parse(u); return t ? new Date(t).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) : (u || "?"); }
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// ---------- structured text (owner 2026-11-03, card dash-structured-text): one shared list renderer ----------
// node = string | {t, sub: [nodes]} | null. Each node is its own line; sub-nodes indent under it. leaf(text) may return DOM nodes (links).
function tree(nodes, cls, leaf) {
  const ul = el("div", "stree" + (cls ? " " + cls : ""));
  (nodes || []).filter(Boolean).forEach(n => { const o = typeof n === "string" ? {t: n} : n, li = el("div", "sl"), tx = el("span", "slt");
    if (leaf) tx.append(...leaf(String(o.t))); else tx.textContent = o.t; li.append(tx);
    const sub = (o.sub || []).filter(Boolean); if (sub.length) li.append(tree(sub, null, leaf)); ul.append(li); });
  return ul;
}
// Free text (card notes, receipt summaries) has no array form: split runs on "; ", " · ", " | " and new lines;
// "head: a, b, c" (3+ items) becomes a head line with one sub-line per item. Short 1-2 part text stays one line.
// Split at separators outside (), [] and quotes only, so "(a; b)" stays one piece.
function splitTop(str, re) {
  const out = []; let d = 0, q = false, cur = "";
  for (let k = 0; k < str.length; k++) { const ch = str[k];
    if (ch === '"') q = !q; else if (!q && "([".includes(ch)) d++; else if (!q && ")]".includes(ch)) d = Math.max(0, d - 1);
    let m = null; if (!q && d === 0) { re.lastIndex = k; m = re.exec(str); } if (m && m[0].length) { out.push(cur); cur = ""; k += m[0].length - 1; continue; }
    cur += ch; }
  out.push(cur); return out;
}
function textNodes(s) {
  const str = String(s || "").trim(); if (!str) return [];
  const parts = splitTop(str, /\r?\n|;\s+|\s[·|]\s/y).map(x => x.trim()).filter(Boolean);
  if (parts.length <= 2 && str.length <= 90 && !/\n/.test(str)) return [str];
  return parts.map(x => { const m = x.match(/^([^:,]{1,48}):\s+(.+)$/); const it = m ? splitTop(m[2], /,\s+/y).map(y => y.trim()).filter(Boolean) : [];
    return m && it.length >= 3 && !/^https?$/.test(m[1]) ? {t: m[1] + ":", sub: it} : x; });
}
const textTree = (s, cls, leaf) => tree(textNodes(s), cls, leaf);

// ---------- folds (owner 2026-11-02, card dashboard-perf): every grouped list and every counted section folds ----------
// Fold state per view ("<view>|<group>") and the Group-by choice per tab live in localStorage. Only the user's own
// toggles are saved; the default is open, except on a phone a group longer than FOLD_LONG starts folded.
// Search shows every group open (not saved). Jumps to a card or row open the folds around it (reveal()).
const LS = (() => { try { const s = window.localStorage, k = "fm.t"; s.setItem(k, "1"); s.removeItem(k); return s; } catch (e) { return null; } })();
const lsGet = (k, d) => { try { const v = LS && LS.getItem(k); return v == null ? d : JSON.parse(v) || d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { if (LS) LS.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode / quota: state stays in memory */ } };
const FOLD = lsGet("fm.folds", {}), GBY = lsGet("fm.groupby", {});
// ---------- cached first paint (card dash-mobile-hang, 2026-11-05) ----------
// When the page is hidden or left (and once after the first full load) the drawn view is saved in localStorage. The
// next load of the SAME address paints it at once, before any data arrives, with "cached view" in the status line;
// the first live draw replaces it. The copy is display-only (no handlers): card links work, buttons wait for live data.
const SNAP_K = "fm.snap1", SNAP_MAX = 1.5e6, SNAP_AGE = 3 * 864e5;
let snapOn = false;
(function paintSnap() {
  if (window.fmSnap) { snapOn = true; return; } // v4 painted it already, inline right after the markup (pages/index/snap-paint.js)
  const s = lsGet(SNAP_K, null);
  if (!s || s.v !== 1 || s.path !== location.pathname || s.search !== location.search || location.hash || !(Date.now() - s.at < SNAP_AGE)) return;
  try {
    $("l").innerHTML = s.l; $("s").innerHTML = s.s;
    Object.entries(s.tabs || {}).forEach(([id, t]) => { const x = $(id); if (x) { x.textContent = t; x.classList.toggle("on", id === s.on); } });
    $("u").textContent = "Cached view from " + fmtUpdated(new Date(s.at).toISOString()) + " · updating…";
    snapOn = true; document.documentElement.classList.add("snap");
  } catch (e) { $("l").replaceChildren(); $("s").replaceChildren(); }
})();
function saveSnap() {
  if (!LS || !D || D.partial || snapOn || curView) return;
  const l = $("l").innerHTML; if (l.length > SNAP_MAX) { try { LS.removeItem(SNAP_K); } catch (e) {} return; }
  const tabs = {}; ["t-items", "t-running", "t-reports", "t-map"].forEach(id => { const x = $(id); if (x) tabs[id] = x.textContent; });
  try { LS.setItem(SNAP_K, JSON.stringify({v: 1, at: Date.now(), path: location.pathname, search: location.search, l, s: $("s").innerHTML, tabs, on: "t-" + tab})); }
  catch (e) { try { LS.removeItem(SNAP_K); } catch (e2) { /* private mode */ } } // quota: no stale copy left behind
}
const FOLD_LONG = 6;
const narrow = () => !!(window.matchMedia && matchMedia("(max-width: 700px)").matches);
let foldForce = false; // set while a search is active: all groups open, nothing saved
// pin: true = default open, false = default folded, undefined = by length (phones only).
const foldDefault = (n, pin) => pin === true || (pin !== false && (!narrow() || n <= FOLD_LONG));
const foldOpen = (key, n, pin) => foldForce || (key in FOLD ? FOLD[key] : foldDefault(n, pin));
function setFold(key, open) { FOLD[key] = open; lsSet("fm.folds", FOLD); }
// A foldable section: <details class="fold"><summary><h2 class="sec">label (n)</h2></summary>…rows</details>.
// rows: array of nodes, or a function returning them (built only when first opened: long lists stay cheap).
function fold(key, label, n, rows, o) {
  o = o || {};
  const d = el("details", "fold" + (o.cls ? " " + o.cls : "")); d.dataset.fold = key;
  const sm = el("summary"); sm.append(el(o.h || "h2", (o.h || "h2") === "h2" ? "sec" : "sgh", label + (n != null ? " (" + n + ")" : ""))); d.append(sm);
  let built = false; const build = () => { if (built) return; built = true; (typeof rows === "function" ? rows() : rows).forEach(x => d.append(x)); };
  d.open = foldOpen(key, n, o.pin); if (d.open || typeof rows !== "function") build();
  d.ontoggle = () => { if (d.open) build(); if (foldForce || !d.isConnected || d.open === foldOpen(key, n, o.pin)) return; setFold(key, d.open); };
  return d;
}
// Group-by select + Collapse all / Expand all for one view. opts: [[value, label], ...] or null (no Group-by).
function foldBar(view, opts, cur, onPick) {
  const b = el("div", "fbar");
  if (opts && opts.length > 1) {
    const lb = el("label", null, "Group by"); const s = el("select"); s.setAttribute("aria-label", "Group by");
    opts.forEach(([v, t]) => { const x = el("option", null, t); x.value = v; if (v === cur) x.selected = true; s.append(x); });
    s.onchange = () => { onPick(s.value); draw(); }; lb.htmlFor = s.id = "gby-" + view.replace(/[^a-z0-9]+/gi, "-"); b.append(lb, s);
  }
  const all = open => () => {
    if (!open) pinId = null; // Collapse all also closes the open card's fold
    $("l").querySelectorAll("details.fold").forEach(d => { if (d.dataset.fold.startsWith(view + "|")) FOLD[d.dataset.fold] = open; });
    $("l").querySelectorAll("details.svg[data-grp]").forEach(d => setSvcOpen(d.dataset.grp, open)); // Running › service accordion (?svc=)
    lsSet("fm.folds", FOLD); draw();
  };
  const c = el("button", null, "⊟ Collapse all"), e = el("button", null, "⊞ Expand all"); c.type = e.type = "button"; c.onclick = all(false); e.onclick = all(true);
  c.dataset.fbar = "collapse"; e.dataset.fbar = "expand"; b.append(c, e);
  return b;
}
const groupBy = (tab, def) => GBY[tab] || def;
function setGroupBy(tab, v) { GBY[tab] = v; lsSet("fm.groupby", GBY); }
// Open every closed fold (and accordion) around a node; user-visible state, so it is saved like a tap.
function reveal(c) { let d; while (c && (d = c.parentElement && c.parentElement.closest("details:not([open])"))) { if (d.dataset.fold) setFold(d.dataset.fold, true); d.open = true; } }

// ---------- model ----------
function index() {
  const items = D.items, ids = itemIds(items), byId = {}, byTitle = {};
  items.forEach((i, n) => { i._id = ids[n]; byId[ids[n]] = i; byTitle[String(i.t).toLowerCase()] = i; i._by = new Set(); i._un = new Set(); });
  // A short first list (D.partial) lacks old done cards: no title-substring guess then (it could pick a wrong card).
  const find = ref => { if (!ref) return null; const r = String(ref); const lo = r.toLowerCase(); return byId[r] || byTitle[lo] || (D.partial ? null : items.find(x => String(x.t).toLowerCase().includes(lo))) || null; };
  items.forEach(i => {
    (Array.isArray(i.blockedBy) ? i.blockedBy : i.blockedBy ? [i.blockedBy] : []).forEach(ref => { const b = find(ref); if (b && b !== i) { i._by.add(b); b._un.add(i); } });
    (Array.isArray(i.blocks) ? i.blocks : i.blocks ? [i.blocks] : []).forEach(ref => { const d = find(ref); if (d && d !== i) { d._by.add(i); i._un.add(d); } });
  });
  D._byId = byId;
  // Dependency tracks (owner 2026-10-23, card blocker-tracks): follow open blockers (cycle-safe) to the root leaves.
  // Leaf class: owner (waiting/open, or blocked with q/src) | bot (running or a job; unit/ci refs) | external (ext:/time:) | unknown.
  const refCls = r => /^(ext|time):/i.test(r) ? "external" : /^(ci|job|unit|agent|pane):/i.test(r) || /\.(timer|service)$/.test(r) ? "bot" : "unknown";
  const leafCls = i => hasAction(i) && (i.s === "waiting" || i.s === "open" || (i.s === "blocked" && (i.q || i.src))) ? "owner" : +i.queued > 0 && i.s !== "done" ? "bot" : i.ext || (i.until && Date.parse(i.until) > Date.now()) ? "external" : i.s === "running" || i.job ? "bot" : "unknown";
  items.forEach(i => {
    i._roots = []; if (i.s === "done") return;
    // Same edges as the chips: blockedBy by id or title, plus reverse `blocks`; unresolved refs stay as non-card leaves.
    const refsOf = x => [...[...x._by].filter(b => !cleared(b) && !parked(b)), ...(Array.isArray(x.blockedBy) ? x.blockedBy : x.blockedBy ? [x.blockedBy] : []).map(String).filter(r => !find(r))];
    const seen = new Set(), walk = (x, chain, path) => refsOf(x).forEach(r => {
      const b = typeof r === "string" ? null : r; r = b ? b._id : r; if (b === i || (b && path.has(b))) { if (!seen.has(r)) { seen.add(r); i._roots.push({cls: "unknown", name: (b ? b.t : r) + " (loop)", chain: [...chain, b ? b.t : r]}); } return; }
      if (!b) { if (!seen.has(r)) { seen.add(r); i._roots.push({cls: refCls(r), name: r, chain: [...chain, r]}); } return; }
      const own = leafCls(b);
      if (refsOf(b).length && own !== "owner" && own !== "external") return walk(b, [...chain, b.t], new Set([...path, b]));
      if (!seen.has(b._id)) { seen.add(b._id); const c = leafCls(b); i._roots.push({cls: c, item: b, name: c === "bot" && b.job ? b.job : b.t, chain: [...chain, c === "owner" ? "your question" : b.t]}); }
    });
    walk(i, [i.t], new Set([i]));
    i._track = !i._roots.length ? "" : i._roots.some(r => r.cls === "owner") ? "owner" : i._roots.some(r => r.cls === "bot") ? "bot" : i._roots[0].cls;
  });
}

// ---------- items view ----------
function changedMs(i) {
  if (i.cts) return +i.cts;
  const ch = C[i._id]; if (ch && ch.at && !ch.approx) { const t = Date.parse(ch.at); if (t) return t; }
  const t = Date.parse(String(i.changed || "").replace(" ", "T")); return t || 0;
}
// ?since= (+ ?by=run:<id>): cards this reply's run changed. Without by, fm-autoclear edits (by: autoclear) are left out.
function writes(i) { const h = Array.isArray(i.hist) && i.hist.length ? i.hist : [{by: i.by, cts: changedMs(i)}]; return h.filter(w => w && +w.cts > since); }
const isNew = i => since != null && writes(i).some(w => byRun ? w.by === byRun : w.by !== "autoclear");
function card(i) {
  // Owner contract 2026-10-19: a card click ALWAYS opens the Discord message. Other targets (GitHub PR, report) go in `l` as a separate button.
  const isDiscord = u => typeof u === "string" && /^https:\/\/discord\.com\/channels\//.test(u);
  // Contract C1: the card opens a MESSAGE. pstack audit 2026-10-25: message links win over channel-only links (148
  // cards had one in src); a channel-only link is the last resort and the card says so.
  const isMessage = u => typeof u === "string" && /^https:\/\/discord\.com\/channels\/(?:\d+|@me)\/\d+\/\d+/.test(u);
  const msgLink = [i.q, i.src].find(isMessage) || (String(i.n || "").match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/) || [])[0] /* owner 2026-10-22: fall back to a Discord message named in the note */;
  const link = msgLink || [i.q, i.src].find(isDiscord), chanOnly = !msgLink && !!link; const c = el(link ? "a" : "div", "c" + (i.owner ? " owner" : "") + (i.s === "waiting" ? " need" : "") + (isQueued(i) ? " queued" : "") + (isNew(i) ? " new" : "")); c.id = "card-" + i._id;
  if (link) c.href = link;
  c.dataset.item = i._id;
  if (chanOnly) c.dataset.chanOnly = "1";
  c.append(el("b", null, i.t), el("div", "m", (E[i.s] || i.s) + " · " + i.area)); if (i.n) c.append(textTree(i.n, "m"));
  if (needsOwner(i)) { // owner 2026-10-25: a blocked-out action section with dividers and emojis
    const ab = el("div", "actblk"); ab.append(el("div", "actrule", "━━━━━━━━━━━━━━━━━━━━"), el("div", "acthead", "✍️ YOUR ACTION"));
    actionSteps(i.action).forEach((x, n) => ab.append(el("div", "actstep", "👉 " + (n + 1) + ". " + x)));
    if (link) ab.append(el("div", "actlink", "🔗 Tap the card to open the " + (i.s === "open" ? "question menu" : "menu / Approve button")));
    ab.append(el("div", "actrule", "━━━━━━━━━━━━━━━━━━━━")); c.append(ab);
  }
  const meta = el("div", "meta2");
  if (isQueued(i)) meta.append(el("span", "qtag", queuedText(i)));
  if (isNew(i)) meta.append(el("span", "newtag", "🆕 changed in this reply"));
  if (i.owner) meta.append(el("span", null, "👤 Owner step"));
  if (i.until) meta.append(el("span", null, until(i.until)));
  const pr = PRS[i.id]; if (pr && pr.state) { const t = el("span", "prtag", prText(pr)); if (pr.pr) t.title = pr.pr; meta.append(t); }
  const ch = i.ch ? {at: i.ch} : C[i._id];
  if (ch && ch.at) { const pre = "🕒 " + (ch.new ? "added " : "changed ") + (ch.approx ? "~" : ""), t = el("span", null, pre + ago(ch.at)); t.dataset.ago = ch.at; t.dataset.pre = pre; meta.append(t); } // draw() keeps the text fresh ([data-ago])
  else if (ch && ch.before) meta.append(el("span", null, "🕒 unchanged since before " + fmtUpdated(ch.before)));
  if (AUD.flow[i._id]) { const a = el("span", "audtag", "🧭 Auditor: " + AUD.flow[i._id].why + " → sent to the sweep"); meta.append(a); }
  if (i.auto) { const a = el("span", "auto", "🤖 auto-updated"); a.title = "Changed by fm-autoclear: " + i.auto; meta.append(a); }
  if (meta.childNodes.length) c.append(meta);
  if (tagsOf(i).length) { const tg = el("div", "chips tags"); tagsOf(i).forEach(t => { const x = el("button", "chip tag", "#" + t); x.type = "button"; x.dataset.tag = t; const on = tagF.includes(t); if (on) x.className += " on"; x.setAttribute("aria-pressed", on ? "true" : "false"); x.title = on ? "Remove #" + t + " from the tag filter" : "Add #" + t + " to the tag filter"; tg.append(x); }); c.append(tg); }
  if (i._by.size || i._un.size) {
    const chips = el("div", "chips");
    i._by.forEach(b => { const pk = !cleared(b) && parked(b); const x = el("button", "chip" + (cleared(b) ? " ok" : pk ? " un" : b.s === "waiting" ? " needc" : ""), (cleared(b) ? "✅ Was blocked by → " : pk ? "🗃️ parked: " : b.s === "waiting" ? "✍️ Blocked by your step → " : "⛔ Blocked by → ") + (pk ? b._id : b.t)); x.dataset.jump = b._id; x.type = "button"; chips.append(x); });
    i._un.forEach(d => { const x = el("button", "chip un", "🔓 Unblocks → " + d.t); x.dataset.jump = d._id; x.type = "button"; chips.append(x); });
    c.append(chips);
  }
  if (i._roots && i._roots.length) {
    const tr = el("div", "chips track"); const T = {owner: "⛔ Blocked by you", bot: "⏳ Blocked by bot work", external: "🌐 Waiting on outside", unknown: "❔ Blocker unclear"};
    // Owner 2026-10-31 (card dashboard-autoflow): an "unclear" root says what fm-audit does about it.
    const lbl = r => r.cls !== "unknown" ? T[r.cls] : r.item && AUD.flow[r.item._id] ? "▶️ Blocker restarted by the auditor" : r.item && r.item.s === "backlog" && isGate(r.item) ? "⏸️ Held by a gate card" : r.item && (r.item.s === "planned" || r.item.s === "backlog") ? "🗃️ Waits on a parked card" : AUD.owner[i._id] ? "❔ Blocker unclear (question for you in FIRSTMATE)" : T.unknown;
    i._roots.forEach(r => { const x = el(r.item ? "button" : "span", "chip" + (r.cls === "owner" ? " needc" : r.cls === "bot" || (r.item && AUD.flow[r.item._id]) ? " job" : ""), lbl(r) + ": " + r.chain.join(" ← ")); if (r.item) { x.type = "button"; x.dataset.jump = r.item._id; } x.title = "Root: " + r.name; tr.append(x); });
    c.append(tr);
  }
  const js = jobsFor(i), us = unitsFor(i);
  if (js.length || us.length || i.s === "running") {
    const chips = el("div", "chips");
    js.forEach(j => { const w = j.status === "working"; const x = el("button", "chip " + (w ? "job" : "ok"), (w ? "🔄 Working: " : "✅ Finished: ") + jobName(j) + " →"); if (w) x.prepend(el("span", "spin")); x.type = "button"; x.dataset.job = j.id; x.title = "Show this job in ⚙️ Running"; chips.append(x); });
    us.forEach(u => { const w = u.state === "running"; const x = el("button", "chip " + (w ? "job" : u.state === "failed" ? "" : "un"), (w ? "🔄 Working: " : u.state === "failed" ? "❌ Failed: " : sched(u) ? "🗓️ Scheduled: " : "⏱️ Queued: ") + u.unit.replace(/\.service$/, "") + (!w && u.next ? (sched(u) ? " · " + whenAbs(u.next) : " · next " + untilShort(u.next)) : "") + " →"); if (w) x.prepend(el("span", "spin")); x.type = "button"; x.dataset.svc = svcKey(u); x.title = "Show this " + (u.host === "remote" ? "Remote " : "") + "unit in ⚙️ Running"; chips.append(x); });
    if (i.s === "running" && !js.some(j => j.status === "working") && !us.some(u => u.state === "running")) chips.append(el("span", "chip", "⚠️ No live job found right now (the auto-check moves it back to 🔧 In progress)"));
    c.append(chips);
  }
  if (link) { const ask = i.q && !isQueued(i); c.append(el("span", "go", ask ? "✍️" : "↗"), el("span", "act", chanOnly ? "💬 Open the Discord channel (no message link) →" : ask ? "💬 Answer in Discord →" : isQueued(i) ? "💬 Show your answer in Discord →" : "💬 Show message in Discord →")); }
  else if (i.nosrc) c.append(el("span", "act", "🗂️ No Discord message (from old session)"));
  if (i.l) {
    if (internal(i.l)) { const r = el("button", "rep", "📄 Open report"); r.type = "button"; r.dataset.view = i.l; r.dataset.title = i.t; c.append(r); }
    else { const gh = /^https:\/\/github\.com\//.test(i.l); const r = el("a", "rep", gh ? (/\/pull\/\d+/.test(i.l) ? "🔗 Open the PR on GitHub ↗" : "🔗 Open on GitHub ↗") : "📄 Report ↗"); r.href = i.l; r.dataset.stop = "1"; c.append(r); }
  }
  for (const u of [i.q, i.src]) if (u && !isDiscord(u) && u !== i.l) { const r = el("a", "rep", /github\.com/.test(u) ? "🔗 Open on GitHub ↗" : "🔗 Open link ↗"); r.href = u; r.dataset.stop = "1"; c.append(r); }
  return c;
}
// ---------- keyed rendering (card dash-mobile-hang, 2026-11-05) ----------
// The owner's phone froze ("the dashboard isn't even loading"): every 10 s poll rebuilt the whole list (~2100 nodes,
// 0.3-1 s of phone CPU each time). The items view now keeps its nodes: a card node is rebuilt only when its signature
// (its data object plus everything else card() shows) changed, folds are re-used by key, and setKids() inserts, moves
// or removes only the nodes that differ. An unchanged poll touches no DOM; one changed card replaces one node.
// Closed folds hold no rows (built when opened); an open fold shows the first ROWS_MAX rows and a "Show N more" button.
const KEEP = {cards: new Map(), folds: new Map(), misc: new Map()}; // id -> {sig, node}; fold key -> fold; slot -> node
const ROWS_MAX = 30;
const MORE = new Set(); // fold keys the user expanded past ROWS_MAX (this page view only)
let pinId = null; // a card that a jump or deep link must show: its fold opens and renders in full
// Only while that card is the open one (?item=): leaving it (filter, search, tab, Back) or closing its fold releases it.
const pinnedIn = items => !!pinId && pinId === curItem && items.some(i => i._id === pinId);
function setKids(p, kids, from) {
  const want = new Set(kids); // first drop what goes (else every later node would be moved once)
  for (let n = p.childNodes[from || 0]; n;) { const nx = n.nextSibling; if (!want.has(n)) p.removeChild(n); n = nx; }
  let k = from || 0;
  for (const n of kids) { const cur = p.childNodes[k]; if (cur !== n) p.insertBefore(n, cur || null); k++; }
  while (p.childNodes.length > k) p.removeChild(p.lastChild);
}
// Small fresh nodes (strips, the Group-by bar, empty notes): keep the node already shown when it is equal.
function keepEq(slot, fresh) { const old = KEEP.misc.get(slot); if (old && old.isEqualNode(fresh)) return old; KEEP.misc.set(slot, fresh); return fresh; }
let objN = 0; const objV = new WeakMap(); // card object -> version number (the adapter re-uses unchanged card objects)
const verOf = o => { let v = objV.get(o); if (!v) { v = ++objN; objV.set(o, v); } return v; };
// Everything card(i) reads besides the card object itself, as text (time labels included: they change once a minute).
function cardSig(i) {
  const ch = i.ch ? {at: i.ch} : C[i._id], pr = PRS[i.id], fl = AUD.flow[i._id];
  return [verOf(i), isNew(i), ch ? (ch.new ? "n" : "") + (ch.approx ? "~" : "") + (ch.at ? ch.at : "b" + ch.before) : "", i.until ? until(i.until) : "",
    pr ? [pr.state, pr.detail, pr.pr].join("|") : "", fl ? fl.why : "", AUD.owner[i._id] ? 1 : 0,
    [...i._by].map(b => [b._id, b.t, cleared(b), b.s].join(":")).join(","), [...i._un].map(d => d._id + ":" + d.t).join(","),
    (i._roots || []).map(r => [r.cls, r.name, r.chain.join("<"), r.item ? r.item._id + ":" + r.item.s + ":" + !!AUD.flow[r.item._id] : ""].join(":")).join(","),
    jobsFor(i).map(j => [j.id, j.status, jobName(j)].join(":")).join(","),
    unitsFor(i).map(u => [svcKey(u), u.state, sched(u), u.next ? whenAbs(u.next) + "|" + untilShort(u.next) : ""].join(":")).join(",")].join("\u0001");
}
function cardKeep(i) {
  const sig = cardSig(i); let k = KEEP.cards.get(i._id);
  if (!k || k.sig !== sig) { k = {sig, node: card(i)}; KEEP.cards.set(i._id, k); }
  return k.node;
}
// Items-view fold, re-used by key. items: the cards (built into rows only while the fold is open).
function foldKeep(key, label, items, o) {
  let F = KEEP.folds.get(key);
  if (!F) {
    const d = el("details", "fold"); d.dataset.fold = key;
    const sm = el("summary"), h = el("h2", "sec"); sm.append(h); d.append(sm);
    F = {key, d, h, items: [], pin: undefined, more: null, filled: false}; KEEP.folds.set(key, F);
    // The toggle event also fires (later) for an open/close set by foldKeep: fill only a fold that is still empty.
    d.ontoggle = () => {
      if (d.open) { if (!F.filled) { fillFold(F); drawWhy(); } }
      else { emptyFold(F); if (pinnedIn(F.items)) pinId = null; } // closing the open card's fold releases it
      if (foldForce || !d.isConnected || d.open === foldOpen(key, F.items.length, F.pin)) return; setFold(key, d.open);
    };
  }
  const text = label + " (" + items.length + ")"; if (F.h.textContent !== text) F.h.textContent = text;
  F.items = items; F.pin = o.pin;
  const pinned = pinnedIn(items);
  if (pinned && !foldForce && !foldOpen(key, items.length, o.pin)) setFold(key, true); // like reveal(): a jump opens the fold for good
  const open = pinned || foldOpen(key, items.length, o.pin);
  if (F.d.open !== open) F.d.open = open;
  if (open) fillFold(F); else emptyFold(F);
  return F.d;
}
function fillFold(F) {
  const all = MORE.has(F.key) || pinnedIn(F.items), shown = all ? F.items : F.items.slice(0, ROWS_MAX);
  const kids = shown.map(cardKeep);
  if (shown.length < F.items.length) {
    if (!F.more) { F.more = el("button", "more"); F.more.type = "button"; F.more.onclick = () => { MORE.add(F.key); fillFold(F); drawWhy(); }; }
    const t = "⬇️ Show " + (F.items.length - shown.length) + " more"; if (F.more.textContent !== t) F.more.textContent = t;
    kids.push(F.more);
  }
  setKids(F.d, kids, 1); F.filled = true;
}
function emptyFold(F) { setKids(F.d, [], 1); F.filled = false; }
// Hoisted at the very top of every view (owner rule): the owner's own actions, then cards changed in this reply.
// out: an array to collect the nodes in (items view); without it they are appended to #l.
function topStrips(inItemsAll, out) {
  const l = $("l"), need = D ? D.items.filter(i => (i.s === "waiting" || i.s === "blocked") && needsOwner(i)) : [];
  const put = (slot, n) => { if (out) out.push(keepEq(slot, n)); else l.append(n); };
  const mb = mainBlockerStrip(); // 🚧 Main blocker directly above ✍️ Needs you (owner 2026-11-04)
  if (mb) put("mb", mb);
  if (need.length && !inItemsAll && !(tab === "items" && f === "waiting")) {
    const b = el("div", "strip needs"); b.append(el("b", null, "✍️ Needs you (" + need.length + ")"));
    const chips = el("div", "chips"); need.forEach(i => { const x = el("button", "chip needc", "✍️ " + i.t); x.type = "button"; x.dataset.jump = i._id; chips.append(x); }); b.append(chips); put("needs", b);
  }
  if (false && since != null && D) { // owner 2026-10-19: "Changed in this reply" panel removed
    const ch = D.items.filter(isNew).sort((a, b) => changedMs(b) - changedMs(a));
    const b = el("div", "strip since"); const h = el("b", null, "🆕 Changed in this reply (" + ch.length + ")");
    const x = el("button", "rep", "✕ Clear"); x.type = "button"; x.id = "since-x"; x.onclick = () => { since = null; byRun = null; draw(); }; h.append(x); b.append(h);
    if (!ch.length) b.append(el("div", "m", "No card changed since " + new Date(since).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) + "."));
    const chips = el("div", "chips"); ch.forEach(i => { const y = el("button", "chip un", (E[i.s] || i.s).split(" ")[0] + " " + i.t); y.type = "button"; y.dataset.jump = i._id; chips.append(y); }); b.append(chips); put("since", b);
  }
}
function drawItems(q) {
  const s = $("s"), l = $("l"), sk = [];
  const sc = new Map(), isSch = i => { let v = sc.get(i); if (v === undefined) sc.set(i, v = isScheduled(i)); return v; }; // once per card per draw
  const SCH = "🗓️ Scheduled", order = ["all", ...Object.keys(E)].flatMap(k => k === "partial" ? [k, "scheduled"] : [k]); // "all" first (restored 2026-10-24)
  const live = D.items.filter(i => !staleDone(i));
  order.forEach(k => {
    if (k === "scheduled") { const n = D.items.filter(isSch).length; if (!n) return; const b = el("button", "st" + (f === k ? " on" : ""), SCH + " " + n); b.type = "button"; b.id = "f-scheduled"; b.title = "Timer jobs that wait for a future fire time"; b.onclick = () => { f = k; curItem = null; draw(); }; sk.push(b); return; }
    const n = k === "all" ? live.length : live.filter(i => (k === "waiting" && i.s === "blocked" && needsOwner(i)) || i.s === k && (k !== "waiting" && k !== "open" || needsOwner(i)) && !((k === "partial" || k === "running") && isSch(i))).length, qn = 0; // owner 2026-10-25 (needs-you-action-gate): no "+N 📨" on Needs you / Open; answered cards are In progress only. Same set as inFilterAll (Needs you counts owner-blocked cards too), with the per-draw isSch cache (card dash-mobile-hang)
    if (!n && !qn && k !== "open" && k !== "waiting") return;
    const b = el("button", "st" + (f === k && k !== "running" ? " on" : ""), (k === "all" ? "All" : E[k]) + " " + n + (qn ? " +" + qn + " 📨" : "")); b.type = "button";
    if (qn) b.title = qn + " queued: you responded; the agent works on it";
    b.onclick = k === "running" ? () => { tab = "running"; rf = "all"; curItem = null; draw(); window.scrollTo(0, 0); } : () => { f = k; curItem = null; draw(); };
    if (k === "running") b.title = "Cards a live job works on now (⚙️ Running tab)";
    sk.push(b);
  });
  // Blocker tracks: separate "blocked by you" (the chain ends at your question) from "blocked by bot work".
  [["byyou", "⛔ Blocked by you", "Cards whose blocker chain ends at your question"], ["bybot", "⏳ Blocked by bot work", "Cards waiting on a running job, CI or timer; no action from you"]].forEach(([k, label, tip]) => {
    const n = D.items.filter(i => inFilter(i, k)).length; if (!n) return;
    const b = el("button", "st" + (f === k ? " on" : ""), label + " " + n); b.type = "button"; b.title = tip; b.id = "f-" + k;
    b.onclick = () => { f = k; curItem = null; draw(); }; sk.push(b);
  });
  // Filter row: replaced only when a button differs (equal buttons have equal handlers: label and id name the filter).
  if (sk.length !== s.children.length || sk.some((b, n) => !b.isEqualNode(s.children[n]))) s.replaceChildren(...sk);
  const ord = Object.keys(E);
  const gm = new Map(), grp = i => { let g = gm.get(i); if (g === undefined) gm.set(i, g = i.s !== "done" && isSch(i) ? "scheduled" : i.s); return g; };
  const gi = g => g === "scheduled" ? ord.indexOf("partial") + 0.5 : ord.indexOf(g);
  // The open card (?item= or a jump) is listed even when it is a done card older than 12 h (card dash-mobile-hang).
  const opened = i => i._id === pinId && pinId === curItem && !q && (f === "all" || f === i.s);
  // Tag filter bar (card tag-filter-optin, owner 2026-11-06): hidden until a card #tag is tapped; sits at the bottom of the
  // top section. Each tag removes alone; the ✕ on the left clears all and hides the bar. Kept when equal.
  const otb = $("tagbar");
  if (tagF.length) { const tb = el("div", "tagbar"); tb.id = "tagbar"; tb.setAttribute("role", "group"); tb.setAttribute("aria-label", "Tag filter: " + tagF.map(t => "#" + t).join(" and "));
    const cx = el("button", "tbx", "✕"); cx.type = "button"; cx.dataset.tagclear = "1"; cx.title = "Clear all tags"; cx.setAttribute("aria-label", "Clear all tags and hide the tag filter"); tb.append(cx);
    tb.append(el("span", "tbl", tagF.length > 1 ? "Cards with all of:" : "Cards with:"));
    tagF.forEach(t => { const x = el("button", "tbt", "#" + t + " ✕"); x.type = "button"; x.dataset.tagrm = t; x.title = "Remove #" + t; x.setAttribute("aria-label", "Remove tag " + t); tb.append(x); });
    const kt = keepEq("tagbar", tb); if (otb !== kt) { if (otb) otb.remove(); $("q").after(kt); } }
  else if (otb) otb.remove();
  const list = D.items.filter(i => tagF.every(t => tagsOf(i).includes(t)) && ((q ? inFilterAll(i, f) : inFilter(i, f)) || opened(i)) && (!q || JSON.stringify(i, (k, v) => k[0] === "_" ? undefined : v).toLowerCase().includes(q)))
    .sort((a, b) => gi(grp(a)) - gi(grp(b)) || (grp(a) === "scheduled" && grp(b) === "scheduled" ? nextFire(a) - nextFire(b) : 0) || (b.owner ? 1 : 0) - (a.owner ? 1 : 0));
  const kids = [];
  topStrips(f === "all" && !q, kids);
  if (!list.length) { kids.push(keepEq("empty", el("div", "empty", f === "open" ? "No unanswered questions. ✅" : f === "waiting" ? "Nothing needs you right now. ✅" : f === "scheduled" ? "No scheduled timer jobs. ✅" : tagF.length ? "No cards tagged " + tagF.map(t => "#" + t).join(" + ") + " here." : "No items match."))); setKids(l, kids); return; }
  // Owner 2026-11-02 (card dashboard-perf): every view is grouped and every group folds; Group by state or stack.
  const gb = groupBy("items", "state"), view = "items/" + f + "/" + gb;
  const bar = keepEq("bar", foldBar(view, [["state", "State"], ["stack", "Stack"]], gb, v => setGroupBy("items", v)));
  const key = gb === "stack" ? (i => i.stack || i.area || "other") : grp;
  const groups = []; const byG = {};
  list.forEach(i => { const g = key(i); if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(i); });
  if (gb === "stack") groups.sort((a, b) => a.localeCompare(b));
  const one = groups.length === 1;
  let barIn = false;
  groups.forEach(g => {
    const rows = byG[g], label = gb === "stack" ? "🧱 " + g : g === "scheduled" ? SCH : E[g] || g;
    // Pinned open: what needs you or works now, and a view with one group. Done starts folded in the All view.
    const pin = one || (gb === "state" && (g === "waiting" || g === "open" || g === "running")) ? true : gb === "state" && g === "done" ? false : undefined;
    // Owner rule: the owner's own actions stay hoisted at the very top; the Group-by bar follows them.
    if (!barIn && !(gb === "state" && g === "waiting")) { kids.push(bar); barIn = true; }
    kids.push(foldKeep(view + "|" + g, label, rows, {pin}));
  });
  if (!barIn) kids.push(bar);
  setKids(l, kids);
}

// ---------- reports view ----------
function drawReports(q) {
  const s = $("s"), l = $("l"); s.innerHTML = ""; l.innerHTML = ""; topStrips(false);
  ["all", ...Object.keys(KIND)].forEach(k => {
    const n = k === "all" ? R.length : R.filter(r => r.kind === k).length; if (!n) return;
    const b = el("button", "st" + (rk === k ? " on" : ""), (k === "all" ? "All" : KIND[k]) + " " + n); b.type = "button"; b.onclick = () => { rk = k; draw(); }; s.append(b);
  });
  const users = {}; (D ? D.items : []).forEach(i => { if (i.l && internal(i.l)) (users[relKey(i.l)] = users[relKey(i.l)] || []).push(i); });
  const list = R.filter(r => (rk === "all" || r.kind === rk) && (!q || (r.title + " " + r.path).toLowerCase().includes(q)));
  if (!R.length) { l.append(el("div", "empty", "No report list yet (reports.json missing).")); return; }
  if (!list.length) { l.append(el("div", "empty", "No reports match.")); return; }
  const row = r => {
    const w = el("div", "rw"), b = el("button", "r"); b.type = "button"; b.dataset.view = r.path; b.dataset.title = r.title; w.append(b);
    b.append(el("b", null, (KIND[r.kind] || "📄").split(" ")[0] + " " + r.title),
      tree(["📁 " + r.group, (KIND[r.kind] || r.kind) + " · " + ago(r.mtime) + " · " + (r.size > 1e6 ? (r.size / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(r.size / 1e3)) + " KB")], "m"));
    const us = users[r.path];
    if (us) { const chips = el("div", "chips rc"); us.forEach(i => { const x = el("button", "chip un", "📋 Item → " + i.t); x.type = "button"; x.dataset.jump = i._id; chips.append(x); }); w.append(chips); }
    return w;
  };
  // Owner 2026-11-02 (card dashboard-perf): Reports fold by file type (PDF / page / notes / media), folder or date.
  const gb = groupBy("reports", "type"), view = "reports/" + gb;
  l.append(foldBar(view, [["type", "File type"], ["folder", "Folder"], ["date", "Date"]], gb, v => setGroupBy("reports", v)));
  const age = r => (Date.now() - Date.parse(r.mtime)) / 864e5;
  const DATES = [["today", "🕒 Today", 1], ["week", "📅 Last 7 days", 7], ["month", "🗓️ Last 30 days", 30], ["older", "🗄️ Older", Infinity]];
  const KORD = ["pdf", "html", "md", "video", "audio"];
  const key = gb === "folder" ? (r => r.group || "other") : gb === "date" ? (r => (DATES.find(([, , d]) => age(r) < d) || DATES[3])[0]) : (r => r.kind || "other");
  const groups = [], byG = {};
  list.forEach(r => { const g = key(r); if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(r); });
  const newest = g => Math.max(...byG[g].map(r => Date.parse(r.mtime) || 0));
  groups.sort(gb === "type" ? (a, b) => (KORD.indexOf(a) + 1 || 99) - (KORD.indexOf(b) + 1 || 99) : gb === "date" ? (a, b) => DATES.findIndex(x => x[0] === a) - DATES.findIndex(x => x[0] === b) : (a, b) => newest(b) - newest(a));
  const label = g => gb === "type" ? KIND[g] || "📄 " + g : gb === "date" ? DATES.find(x => x[0] === g)[1] : "📁 " + g;
  const one = groups.length === 1;
  groups.forEach(g => l.append(fold(view + "|" + g, label(g), byG[g].length, () => byG[g].map(row), {pin: one ? true : undefined})));
}

// ---------- running view (running.json from build-running.py) ----------
const JS = {working: "🔄 Working", done: "✅ Finished", idle: "💤 Idle", unknown: "❔ Unknown"};
const SS = {running: "🟢 Running", active: "🟢 Active", waiting: "⏱️ Waiting", failed: "❌ Failed", stopped: "⚪ Stopped", off: "🚫 Off", missing: "❔ Missing", unknown: "❔ Unknown"};
const jobName = j => (j.title || j.tabLabel || j.id);
const jobKey = id => "job-" + String(id).replace(/[^A-Za-z0-9_-]/g, "_");
const recent = (iso, h) => iso && Date.now() - Date.parse(iso) < h * 3600e3;
// Owner 2026-10-24: finished jobs older than 12 h are not listed anywhere (same cutoff as the Discord master queue).
const FIN_H = 12;
// Lookup maps per running.json object (card dash-mobile-hang, 2026-11-05): jobsFor/unitsFor ran for every card on every
// draw (also inside the sort) and rebuilt a map of all jobs/units each time: ~0.6 s of a phone's CPU per redraw.
const runMaps = new WeakMap();
function runMap() {
  let m = runMaps.get(RUN);
  if (!m) { m = {jobs: new Map((RUN.jobs || []).map(j => [j.id, j])), units: new Map((RUN.services || []).map(u => [u.host + ":" + u.unit, u]))}; runMaps.set(RUN, m); }
  return m;
}
function jobsFor(i) {
  if (!RUN || !RUN.itemJobs) return [];
  const byId = runMap().jobs, ids = RUN.itemJobs[i._id]; if (!ids) return [];
  return ids.map(id => byId.get(id)).filter(j => j && (j.status === "working" || ((j.status === "done" || j.status === "idle") && recent(j.active, FIN_H))))
    .sort((a, b) => (a.status === "working" ? 0 : 1) - (b.status === "working" ? 0 : 1)).filter((j, n, arr) => j.status === "working" || arr.findIndex(x => x.status !== "working") === n);
}
const svcKey = u => "svc-" + u.host + "-" + String(u.unit).replace(/[^A-Za-z0-9_-]/g, "_");
// ---------- service groups (accordion; ?svc=Remote,Finance,!Maintenance = opened / !closed against the default) ----------
const svcGroup = u => u.host === "remote" ? "Remote" : (u.group || "Other");
const svcGroupLabel = g => g === "Remote" ? "Remote (read-only over ssh)" : g;
const svcGroupFailed = g => ((RUN && RUN.services) || []).some(u => svcGroup(u) === g && u.state === "failed");
const svcIsOpen = g => svcOpenX.has(g) || (svcGroupFailed(g) && !svcClosedX.has(g));
function setSvcOpen(g, open) {
  if (open === svcIsOpen(g)) return; // redraws re-fire toggle with the same state: keep the URL order stable
  svcOpenX.delete(g); svcClosedX.delete(g);
  if (open !== svcGroupFailed(g)) (open ? svcOpenX : svcClosedX).add(g);
  syncURL();
}
const svcParam = () => [...svcOpenX].concat([...svcClosedX].map(g => "!" + g)).join(",");
function applySvc(v) {
  svcOpenX = new Set(); svcClosedX = new Set(); if (!v) return;
  const known = [...new Set(((RUN && RUN.services) || []).map(svcGroup))];
  v.split(",").map(s => s.trim()).filter(Boolean).forEach(s => {
    const neg = s[0] === "!", n = (neg ? s.slice(1) : s).trim(); if (!n) return;
    const g = known.find(k => k.toLowerCase() === n.toLowerCase()) || n;
    (neg ? svcClosedX : svcOpenX).add(g);
  });
}
function unitsFor(i) {
  if (!RUN || !RUN.itemUnits) return [];
  const by = runMap().units, ks = RUN.itemUnits[i._id]; if (!ks) return [];
  return ks.map(k => by.get(k)).filter(Boolean);
}
// A unit waiting for a future fire time (not running, not failed).
// Only one-off (transient) timers count; recurring timers like fm-tabwatch stay ⏱️ Queued.
const sched = u => u.state !== "running" && u.state !== "failed" && (u.timerEnabled === "transient" || u.enabled === "transient" || u.oneShot) && Date.parse(u.next) > Date.now();
// Absolute date + time when > 24 h away ("Wed, Nov 11, 10:30 AM"), else "in N h/min".
function whenAbs(iso) { const t = Date.parse(iso); if (!t) return ""; return t - Date.now() > 864e5 ? new Date(t).toLocaleString([], {weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : untilShort(iso); }
function untilShort(iso) { const t = Date.parse(iso); if (!t) return ""; const m = Math.round((t - Date.now()) / 60000); if (m < 1) return "now"; if (m < 90) return "in " + m + " min"; if (m < 36 * 60) return "in " + Math.round(m / 60) + " h"; return new Date(t).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"}); }
function jobCard(j) {
  const c = el("div", "c jb" + (j.status === "working" ? " jwk" : "")); c.id = jobKey(j.id);
  const t = el("b", null, jobName(j)); if (j.status === "working") t.prepend(el("span", "spin")); c.append(t);
  c.append(tree([(JS[j.status] || j.status) + (j.tabLabel ? " · tab " + j.tabLabel + (j.tabNumber ? " (#" + j.tabNumber + ")" : "") : ""), j.cwd ? "📁 " + j.cwd : null], "m"));
  if (j.status === "working") c.append(el("div", "dni", "⛔ Do not interrupt: the agent is working. Do not type in its pane."));
  const meta = el("div", "meta2");
  if (j.started) meta.append(el("span", null, "🚀 started " + ago(j.started)));
  if (j.active) meta.append(el("span", null, "🕒 last activity " + ago(j.active)));
  meta.append(el("span", null, "🧷 pane " + j.id)); c.append(meta);
  if ((j.tasks || []).length || (j.items || []).length) {
    const chips = el("div", "chips");
    (j.tasks || []).forEach(tk => { if (tk.web && tk.exists) { const x = el("button", "chip un", "📝 Task → " + tk.web); x.type = "button"; x.dataset.view = tk.web; x.dataset.title = tk.web; chips.append(x); } else chips.append(el("span", "chip", "📝 " + tk.path)); });
    (j.items || []).forEach(id => { const it = D && D._byId[id]; if (it) { const x = el("button", "chip un", "📋 Item → " + it.t); x.type = "button"; x.dataset.jump = id; chips.append(x); } });
    c.append(chips);
  }
  return c;
}
function svcRow(s) {
  const c = el("div", "c sv " + s.state); c.id = svcKey(s);
  c.append(el("b", null, (s.badge === "Down" ? "🔴 Down" : (SS[s.state] || s.state) + (s.badge ? " · " + s.badge : "")) + " · " + s.unit.replace(/\.service$/, "")), textTree(s.desc || "", "m"));
  const meta = el("div", "meta2");
  meta.append(el("span", null, s.host === "remote" ? "🖥️ Remote" : "🖥️ main"));
  if (s.state === "running" && s.since) meta.append(el("span", null, "▶️ up since " + ago(s.since).replace(" ago", "")));
  else if (s.lastStart) meta.append(el("span", null, "🕒 last run " + ago(s.lastStart) + (s.result && s.result !== "success" ? " (" + s.result + (s.exitStatus && s.exitStatus !== "0" ? ", exit " + s.exitStatus : "") + ")" : "")));
  if (s.next) meta.append(el("span", null, "⏭️ next " + untilShort(s.next)));
  if (s.note) c.append(textTree("ℹ️ " + s.note, "m"));
  c.append(meta);
  if (s.logs) { const lg = el("div", "logs"); lg.append(el("span", null, "📜 Logs: "), el("code", null, s.logs)); c.append(lg); }
  if (s.link) { if (internal(s.link)) { const r = el("button", "rep", "📄 Open report"); r.type = "button"; r.dataset.view = s.link; r.dataset.title = s.unit; c.append(r); } else { const r = el("a", "rep", "↗ Open"); r.href = s.link; r.target = "_blank"; c.append(r); } }
  if ((s.items || []).length) { const chips = el("div", "chips"); s.items.forEach(id => { const it = D && D._byId[id]; if (it) { const x = el("button", "chip un", "📋 Item → " + it.t); x.type = "button"; x.dataset.jump = id; chips.append(x); } }); c.append(chips); }
  return c;
}
// 🤝 Live board: every running job by stack: last status (fm status / fm beat note) and its age, claims with age,
// and the coordinator's split/merge proposal (card field coord). Read-only. A claim with no beat, status or claim
// renewal for 30 min is shown as expired (fm drops it on the next write).
function liveBoard(q, view) {
  const now = Date.now(), st = (CO && CO.status) || {};
  // Same liveness as fm_coord.dead_reason (as far as the page can see): no done/unknown cards; pane activity from
  // running.json counts like a beat.
  const act = {}; ((RUN && RUN.jobsOk && RUN.jobs) || []).forEach(j => (j.items || []).forEach(id => { const t = Date.parse(j.active) || 0; if (t > (act[id] || 0)) act[id] = t; }));
  const claims = ((CO && CO.claims) || []).filter(c => D._byId[c.card] && D._byId[c.card].s !== "done");
  const mins = ts => ts ? Math.max(0, Math.round((now - ts) / 60000)) : null, fmt = m => m == null ? "–" : m < 90 ? m + " min" : Math.round(m / 60) + " h";
  const rows0 = D.items.filter(i => i.s === "running" || claims.some(c => c.card === i._id))
    .filter(i => !q || (i._id + " " + i.t + " " + ((st[i._id] || {}).line || "") + " " + claims.filter(c => c.card === i._id).map(c => c.resource).join(" ")).toLowerCase().includes(q));
  const byStack = {};
  rows0.forEach(i => (byStack[i.stack || "firstmate"] = byStack[i.stack || "firstmate"] || []).push(i));
  const rows = [];
  const run = COR && COR.at ? mins(COR.at) : null;
  const incs = COR && COR.stacks ? Object.values(COR.stacks).reduce((n, x) => n + (x.incidents || []).length, 0) : 0;
  rows.push(el("div", "note", "🤝 Coordinator " + (run == null ? "has not run yet" : "ran " + (run < 1 ? "now" : fmt(run) + " ago") + (run > 15 ? " ⚠️" : "")) +
    " · " + incs + " open incident" + (incs === 1 ? "" : "s") + ". Jobs: fm board --stack <s> before each step, fm status every 10–15 min, fm claim before shared work."));
  if (!rows0.length) rows.push(el("div", "empty", "No running job on the board."));
  Object.keys(byStack).sort().forEach(sk => {
    const cs = byStack[sk].map(i => {
      const s = st[i._id] || {}, sAge = mins(s.ts || i.beat), mine = claims.filter(c => c.card === i._id);
      const c = el("div", "c jb"); c.id = "board-" + i._id;
      c.append(el("b", null, i.t));
      const lines = ["💬 " + (s.line || i.beatNote || "(no status yet)") + " · " + fmt(sAge) + (sAge != null && sAge > 15 ? " ⚠️ old" : "")];
      mine.forEach(x => { const seen = Math.max(x.renewed || 0, x.ts || 0, i.beat || 0, s.ts || 0, act[i._id] || 0); lines.push("🔒 " + x.resource + " · held " + fmt(mins(x.ts)) + (now - seen > 30 * 60000 ? " · expired" : "")); });
      if (!mine.length) lines.push("🔓 no claims");
      if (i.coord) lines.push(i.coord);
      c.append(tree(lines, "m"));
      const chips = el("div", "chips"), x = el("button", "chip un", "📋 Item → " + i._id); x.type = "button"; x.dataset.jump = i._id; chips.append(x);
      if (i.job) chips.append(el("span", "chip", "🧷 " + i.job));
      c.append(chips);
      return c;
    });
    rows.push(fold(view + "|board:" + sk, "🧱 " + sk, cs.length, cs, {h: "h3", cls: "sub2", pin: true}));
  });
  return fold(view + "|board", "🤝 Live board", rows0.length, rows, {pin: true});
}
function drawRunning(q) {
  const s = $("s"), l = $("l"); s.innerHTML = ""; l.innerHTML = ""; topStrips(false);
  if (!RUN) { l.append(el("div", "empty", "No running.json yet.")); return; }
  const jobs = (RUN.jobs || []).filter(j => !q || (jobName(j) + " " + j.tabLabel + " " + j.cwd + " " + j.status).toLowerCase().includes(q));
  const svcs = (RUN.services || []).filter(x => !q || (x.unit + " " + x.desc + " " + x.group + " " + x.host + " " + x.state).toLowerCase().includes(q));
  const wk = (RUN.jobs || []).filter(j => j.status === "working").length, fl = (RUN.services || []).filter(x => x.state === "failed").length;
  [["all", "All"], ["jobs", "🤖 Jobs " + (RUN.jobs || []).length + (wk ? " · " + wk + " working" : "")], ["services", "🛠️ Services " + (RUN.services || []).length], ["failed", "❌ Failed " + fl]].forEach(([k, txt]) => {
    if (k === "failed" && !fl) return; const b = el("button", "st" + (rf === k ? " on" : ""), txt); b.type = "button"; b.onclick = () => { rf = k; draw(); }; s.append(b);
  });
  const age = (Date.now() - Date.parse(RUN.generated)) / 1000;
  const info = el("div", "note", "⚙️ Read-only view, generated " + ago(RUN.generated) + " by the main (every 30 s). Nothing here starts or stops anything.");
  if (age > 180) info.textContent = "⚠️ running.json is " + ago(RUN.generated).replace(" ago", "") + " old: the generator may be stopped (firstmate-running.timer).";
  l.append(info);
  // Owner 2026-11-02 (card dashboard-perf): every counted section folds (state per view); services Group by.
  const view = "running/" + rf, sgb = groupBy("running", "group");
  l.append(foldBar(view, rf === "jobs" ? null : [["group", "Service group"], ["state", "State"], ["host", "Host"]], sgb, v => setGroupBy("running", v)));
  if ((rf === "all" || rf === "jobs") && D) {
    const rc = D.items.filter(i => i.s === "running" && (!q || JSON.stringify(i, (k, v) => k[0] === "_" ? undefined : v).toLowerCase().includes(q)));
    l.append(fold(view + "|cards", "⚙️ Cards being worked on now", rc.length, rc.length ? rc.map(card) : [el("div", "empty", "No card has a live job right now.")], {pin: true}));
  }
  if ((rf === "all" || rf === "jobs") && D) l.append(liveBoard(q, view));
  if (rf === "all" || rf === "jobs") {
    const live = jobs.filter(j => j.status !== "idle" && (j.status !== "done" || recent(j.active, FIN_H))), idle = jobs.filter(j => j.status === "idle");
    const rows = [];
    if (!RUN.jobsOk) rows.push(el("div", "note", "⚠️ herdr pane list failed on the last run."));
    if (!live.length) rows.push(el("div", "empty", "No job is working or newly finished."));
    live.forEach(j => rows.push(jobCard(j)));
    if (idle.length) rows.push(fold(view + "|idle", "💤 Idle", idle.length, idle.map(jobCard), {h: "h3", pin: false, cls: "sub2"}));
    l.append(fold(view + "|jobs", "🤖 Agent jobs", live.length, rows));
  }
  if (rf === "all" || rf === "services" || rf === "failed") {
    const rows = [];
    const qv = RUN.remote || {};
    if (qv.ok === false) rows.push(el("div", "note", "⚠️ Remote did not answer; its rows are from " + (qv.lastOk ? ago(qv.lastOk) : "never") + "."));
    const force = !!q || rf === "failed"; // search or the ❌ filter shows every matching group open (not saved)
    const shown = svcs.filter(x => rf !== "failed" || x.state === "failed");
    const gkey = sgb === "state" ? (x => x.state || "unknown") : sgb === "host" ? (x => x.host === "remote" ? "Remote" : "main") : svcGroup;
    const groups = [], byG = {};
    shown.forEach(x => { const g = gkey(x); if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(x); });
    if (sgb === "state") groups.sort((a, b) => (a === "failed" ? -1 : 0) - (b === "failed" ? -1 : 0) || a.localeCompare(b));
    if (!groups.length) rows.push(el("div", "empty", q ? "No service matches the search." : "No background services."));
    groups.forEach(g => {
      const gr = byG[g], nf = gr.filter(x => x.state === "failed").length, nr = gr.filter(x => x.state === "running").length;
      if (sgb !== "group") { // State / Host: plain folds (the ?svc= accordion below keeps the service-group contract)
        rows.push(fold(view + "|" + sgb + ":" + g, (sgb === "state" ? SS[g] || g : "🖥️ " + g) + (nf && sgb !== "state" ? " · ❌ " + nf : ""), gr.length, gr.map(svcRow), {h: "h3", cls: "sub2", pin: force || nf ? true : undefined}));
        return;
      }
      const d = el("details", "svg" + (nf ? " bad" : "")); d.dataset.grp = g; d.open = force || svcIsOpen(g);
      const sm = el("summary"); sm.append(el("span", "gn", svcGroupLabel(g)), el("span", "gc", gr.length + (nr ? " · " + nr + " up" : "")));
      if (nf) sm.append(el("span", "gf", "❌ " + nf));
      sm.title = svcGroupLabel(g) + ": " + gr.length + " units" + (nf ? ", " + nf + " failed" : "");
      d.append(sm); gr.forEach(x => d.append(svcRow(x)));
      d.ontoggle = () => { if (!force && d.isConnected) setSvcOpen(g, d.open); };
      rows.push(d);
    });
    l.append(fold(view + "|services", "🛠️ Background services", shown.length, rows, {pin: true}));
  }
}
// The highlight flash (.hl, 2.4 s). Kept card nodes must not flash again: the class goes after the animation, also when
// the animation was cancelled (card removed by a filter or fold); a newer flash restarts the timer.
function hlOn(c) { c.classList.remove("hl"); void c.offsetWidth; c.classList.add("hl"); clearTimeout(c._hlT); c._hlT = setTimeout(() => c.classList.remove("hl"), 2600); }
function flash(c) { reveal(c); c.scrollIntoView({block: "center"}); hlOn(c); }
function backFrom(fromId) { lastJump = fromId || null; $("back").style.display = lastJump ? "block" : "none"; }
function jumpJob(id, fromId) {
  tab = "running"; if (rf !== "all" && rf !== "jobs") rf = "all";
  // An idle job sits in the folded 💤 Idle group: flash() opens the folds around it (reveal).
  draw(); let c = $(jobKey(id)); if (!c) { $("q").value = ""; rf = "all"; draw(); c = $(jobKey(id)); }
  if (!c) { toast("Job not found (it may have ended)"); return; }
  backFrom(fromId); flash(c);
}
function jumpSvc(key, fromId) {
  tab = "running"; if (rf !== "all" && rf !== "services") rf = "all";
  const u = RUN && (RUN.services || []).find(x => svcKey(x) === key); if (u && !svcIsOpen(svcGroup(u))) setSvcOpen(svcGroup(u), true);
  draw(); let c = $(key); if (!c) { $("q").value = ""; rf = "all"; draw(); c = $(key); }
  if (!c) { toast("Unit not found"); return; }
  backFrom(fromId); flash(c);
}
let toastT = null;
function toast(msg) { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 3500); }

// Text and attribute writes only when the value changed: an unchanged redraw then marks nothing for layout.
const setText = (e, t) => { if (e.textContent !== t) e.textContent = t; };
let badgeN = -1;
function draw() {
  if (snapOn && D) { snapOn = false; $("s").replaceChildren(); $("l").replaceChildren(); document.documentElement.classList.remove("snap"); } // the cached first paint has no handlers; kept until live data exists
  if (snapOn) { syncURL(); return; } // no card data yet: keep the cached copy (and its offline note) for every tab
  const q = $("q").value.trim().toLowerCase();
  $("t-items").classList.toggle("on", tab === "items"); $("t-reports").classList.toggle("on", tab === "reports"); $("t-running").classList.toggle("on", tab === "running"); if ($("t-map")) $("t-map").classList.toggle("on", tab === "map");
  const wk = RUN ? (RUN.jobs || []).filter(j => j.status === "working").length : 0, fl = RUN ? (RUN.services || []).filter(x => x.state === "failed").length : 0;
  setText($("t-running"), "⚙️ Running" + (wk ? " " + wk : "") + (fl ? " ·❌" + fl : "")); const rt = wk + " working jobs, " + fl + " failed services"; if ($("t-running").title !== rt) $("t-running").title = rt;
  setText($("t-items"), "📋 Items" + (D ? " " + D.items.length : "")); setText($("t-reports"), "📚 Reports " + R.length);
  if (D) {
    const need = D.items.filter(i => (i.s === "waiting" || i.s === "blocked") && needsOwner(i)).length, nb = $("need");
    nb.hidden = !need; setText(nb, "✍️ " + need + " need you"); const dt = (need ? "(" + need + ") " : "") + "FIRSTMATE"; if (document.title !== dt) document.title = dt;
    if (need !== badgeN) { badgeN = need; try { const p = navigator.setAppBadge ? (need ? navigator.setAppBadge(need) : navigator.clearAppBadge()) : null; if (p && p.catch) p.catch(() => {}); } catch (e) { /* badge needs permission */ } }
  }
  foldForce = !!q; if (tab !== "items") { const otb = $("tagbar"); if (otb) otb.remove(); }
  if (tab === "reports") drawReports(q); else if (tab === "running") drawRunning(q); else if (tab === "map") { if (D) drawMap(q); } else if (D) drawItems(q);
  $("l").querySelectorAll("[data-ago]").forEach(t => setText(t, t.dataset.pre + ago(t.dataset.ago))); // "N min ago" labels of kept cards
  drawWhy();
  syncURL();
  if (tab !== lastTab) { lastTab = tab; const t = $("t-" + tab); if (t && t.parentElement.scrollWidth > t.parentElement.clientWidth) t.parentElement.scrollTo({left: Math.max(0, t.offsetLeft - 16 - (t.parentElement.clientWidth - t.offsetWidth) / 2)}); }
  document.querySelectorAll(".hs").forEach(hint);
}
// Sideways rows (tabs, filters): fade the edge that has more to scroll to (owner 2026-11-02, card dashboard-perf).
let lastTab = null;
function hint(r) {
  const max = r.scrollWidth - r.clientWidth;
  r.classList.toggle("fl", max > 2 && r.scrollLeft > 2); r.classList.toggle("fr", max > 2 && r.scrollLeft < max - 2);
  if (!r.dataset.hint) { r.dataset.hint = "1"; r.addEventListener("scroll", () => hint(r), {passive: true}); }
}
addEventListener("resize", () => document.querySelectorAll(".hs").forEach(hint));

// ---------- deep links (deeplink-contract.md): ?item= ?tab= ?since= ?q= ?report= ----------
function tabParam() { return tab === "map" ? "map" : tab === "reports" ? "reports" : tab === "running" ? (rf === "services" ? "services" : rf === "failed" ? "failed" : "running") : (F2TAB[f] || "all"); }
function urlFor(extra) {
  const p = new URLSearchParams(), st = Object.assign({tab: tabParam(), item: curItem, since: since, by: since != null ? byRun : null, q: $("q").value.trim(), tag: tab === "items" && tagF.length ? tagF.join(",") : null, report: curView, svc: tab === "running" ? svcParam() : null}, whyParams(), extra || {});
  ["item", "tab", "since", "by", "q", "tag", "report", "svc", "why", "receipt"].forEach(k => { const v = st[k]; if (v != null && v !== "" && !(k === "tab" && v === "all")) p.set(k, String(v)); });
  const s = p.toString(); return location.pathname + (s ? "?" + s : "");
}
function syncURL() { if (!urlReady) return; const u = urlFor(); if (u !== location.pathname + location.search || location.hash) history.replaceState(history.state, "", u); }
function parseSince(v) {
  if (v == null || v === "") return null; if (/^\d+$/.test(v)) { const n = +v; return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(v); return t || null;
}
function applyTab(t) {
  if (t == null || t === "") return true;
  if (t === "reports" || t === "running" || t === "map") { tab = t; return true; }
  // Owner 2026-10-24: ?tab=services opens the bots and scheduled jobs list (Running › Services); ?tab=failed its failures.
  if (t === "services" || t === "failed") { tab = "running"; rf = t; return true; }
  if (t === "items") { tab = "items"; return true; }
  if (TAB2F[t]) { tab = "items"; f = TAB2F[t]; return true; }
  tab = "items"; f = "all"; toast("Unknown tab \"" + t + "\": showing All"); return false;
}
// The address is read once at startup (INIT) and only synced after that, so an early draw cannot wipe the params.
const INIT = {search: location.search, hash: location.hash};
let urlReady = false;
function applyParams(first) {
  const p = new URLSearchParams(INIT.search), h = decodeURIComponent(INIT.hash.slice(1));
  urlReady = true;
  if (p.has("q")) $("q").value = p.get("q");
  const tg = String(p.get("tag") || "").toLowerCase().replace(/^#/, ""); tagF = [...new Set(tg.split(",").map(t => t.trim().replace(/^#/, "")).filter(t => TAG_RE.test(t)))].slice(0, 8);
  since = null; // owner 2026-10-19: ?since= ignored (panel and tags removed)
  const b = p.get("by"); byRun = b && /^[A-Za-z0-9:_.-]{1,80}$/.test(b) ? b : null;
  applySvc(p.get("svc"));
  if (p.has("svc") && !p.get("tab")) tab = "running"; else applyTab(p.get("tab"));
  draw();
  const rep = p.get("report") || (h.startsWith("view=") ? h.slice(5) : null);
  const item = p.get("item") || (h && !h.startsWith("view=") ? h : null);
  if (item) {
    if (D && D._byId[item]) { if (p.get("why") === "1") { curItem = item; openWhy(item, p.get("receipt")); } setTimeout(() => jump(item), first ? 50 : 0); }
    else { curItem = null; tab = "items"; f = "all"; draw(); toast("Card not found: " + item + " · showing All"); }
  }
  if (rep) view(rep, null, false);
}

// ---------- jump between linked cards ----------
function jump(id, fromEl) {
  const it = D && D._byId[id]; if (!it) { toast("Card not found: " + id); return; }
  pinId = id; // its fold opens and shows every row (keyed rendering: closed folds hold no cards)
  const prevItem = curItem; curItem = id; // set before the draws below: drawItems also lists an old done card when it is the open one
  let c = $("card-" + id);
  if (!c || (!c.offsetParent && !c.closest("details:not([open])"))) { // a card inside a closed fold is opened in place (reveal)
    tab = "items"; if (f !== "all" && it.s !== f) f = "all";
    draw(); c = $("card-" + id);
    if (!c) { $("q").value = ""; f = "all"; draw(); c = $("card-" + id); }
  }
  if (!c) { curItem = prevItem; syncURL(); toast("Card not found: " + id); return; }
  reveal(c);
  backFrom(fromEl && fromEl !== "card-" + id ? fromEl : null);
  curItem = id; syncURL();
  const tgt = () => (WHY && WHY.id === id && $("why")) || c; // with an open why panel, show the receipt (it sits under the card)
  const w0 = () => !!(WHY && WHY.id === id && $("why"));
  tgt().scrollIntoView(w0() ? {block: "start"} : {block: "center", behavior: "smooth"});
  // Smooth scroll can be skipped, and a late layout change can move the why panel under the sticky header: check again.
  setTimeout(() => { const t = tgt(), r = t.getBoundingClientRect(); if (t !== c ? r.top < 120 || r.top > innerHeight * 0.6 : r.bottom < 0 || r.top > innerHeight) t.scrollIntoView({block: t === c ? "center" : "start"}); }, 700);
  hlOn(c);
}

// ---------- why panel (card why-link-dashboard, owner 2026-11-03): ?item=<id>&why=1[&receipt=<file>] ----------
// The master-queue "why" link opens the card with its latest receipt (receipts/<file>.json, the file fm receipt wrote)
// in a readable panel right under the card. ?receipt= is untrusted: a plain file name only (no folders), else <id>.json.
let WHY = null; // {id, file, r: receipt object | null, err: text | null}
const RFILE = /^[^/\\.][^/\\]{0,150}\.json$/;
const RES = {done: "✅ Done", failed: "❌ Failed", blocked: "⛔ Blocked"};
function whyParams() { return WHY && WHY.id === curItem ? {why: "1", receipt: WHY.file !== WHY.id + ".json" ? WHY.file : null} : {}; }
function openWhy(id, file) {
  if (file && !RFILE.test(file)) { toast("Receipt name refused: showing " + id + ".json"); file = null; }
  file = file || id + ".json";
  if (WHY && WHY.id === id && WHY.file === file) { drawWhy(); return; }
  const w = WHY = {id, file, r: null, err: null};
  get("receipts/" + encodeURIComponent(file)).then(r => { w.r = r && typeof r === "object" ? r : {}; }, e => { w.err = /^404/.test(e.message) ? "No receipt file " + file + " for this card." : "Could not load the receipt: " + e.message; })
    .then(() => { if (WHY !== w) return; drawWhy(); const x = $("why"); if (x && curItem === id) x.scrollIntoView({block: "start"}); });
}
function closeWhy() { WHY = null; const x = $("why"); if (x) x.remove(); syncURL(); }
// Report paths in receipts are main file paths; the ones under ~/Documents/reports/web/ open in the dashboard viewer.
const RPATH = /^(?:~|\/home\/[^/\s]+)\/Documents\/reports\/web\/(\S+)$/;
// Text with links: URLs open in a new tab, report paths open in the viewer. DOM nodes only (no innerHTML from receipts).
function richText(s) {
  const out = [], re = /(https?:\/\/[^\s<>"'`]+|(?:~|\/home\/[^/\s]+)\/Documents\/reports\/web\/[^\s<>"'`]+)/g; s = String(s == null ? "" : s); let at = 0, m;
  while ((m = re.exec(s))) {
    let u = m[1]; const tail = (u.match(/[.,;:!?)\]]+$/) || [""])[0]; if (tail) u = u.slice(0, -tail.length);
    if (m.index > at) out.push(document.createTextNode(s.slice(at, m.index)));
    out.push(linkNode(u, u)); at = m.index + u.length;
  }
  if (at < s.length) out.push(document.createTextNode(s.slice(at)));
  return out;
}
function linkNode(u, label) {
  const rp = u.match(RPATH);
  if (rp && internal("/reports/" + rp[1])) { const b = el("button", "wlink", "📄 " + label); b.type = "button"; b.dataset.view = "/reports/" + rp[1]; b.dataset.title = rp[1]; b.title = "Open in the dashboard viewer"; return b; }
  if (/^https?:\/\//.test(u)) { const a = el("a", "wlink", label); a.href = u; a.target = "_blank"; a.rel = "noopener"; return a; }
  return el("code", null, label);
}
function cardChip(ref, cls) {
  const b = D && D._byId[ref];
  if (!b) return el("span", "chip", "❔ " + ref);
  const x = el("button", "chip" + (cls ? " " + cls : b.s === "done" ? " ok" : ""), (E[b.s] || b.s).split(" ")[0] + " " + b.t); x.type = "button"; x.dataset.jump = b._id; x.title = (E[b.s] || b.s) + " · tap to open the card"; return x;
}
// Blocker chains: each receipt blocker, then that card's own open blockers (cycle-safe, at most 12 rows of 6 cards).
function whyChains(refs) {
  const rows = [], walk = (ref, path) => {
    if (rows.length >= 12) return;
    const b = D && D._byId[ref], next = b && path.length < 6 ? [...b._by].filter(x => x.s !== "done" && !path.includes(x._id)).map(x => x._id) : [];
    if (!next.length) { rows.push([...path, ref]); return; }
    next.forEach(n => walk(n, [...path, ref]));
  };
  refs.forEach(r => walk(String(r), []));
  return rows.map(chain => { const d = el("div", "wchain"); chain.forEach((r, n) => { const row = el("div", "wstep"); row.style.paddingLeft = Math.min(n, 5) * 14 + "px"; if (n) row.append(el("span", "warr", "↳ blocked by ")); row.append(cardChip(r)); d.append(row); }); return d; });
}
function whyPanel(w) {
  const it = D._byId[w.id], p = el("section", "why"); p.id = "why"; p.setAttribute("aria-label", "Latest receipt for " + it.t);
  const hd = el("div", "whead"); hd.append(el("b", null, "🧾 Why: latest receipt"));
  const x = el("button", "wx", "✕ Close"); x.type = "button"; x.onclick = closeWhy; x.setAttribute("aria-label", "Close the receipt"); hd.append(x); p.append(hd, el("div", "wcard", "Card: " + it.t));
  if (w.err) { p.append(el("div", "note", "⚠️ " + w.err)); return p; }
  if (!w.r) { p.append(el("div", "note", "Loading the receipt…")); return p; }
  const r = w.r, line = (k, nodes) => { const d = el("div", "wrow"); d.append(el("span", "wk", k)); const v = el("span", "wv"); v.append(...nodes); d.append(v); return d; };
  const t = +r.tsMs || Date.parse(String(r.ts || "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  p.append(line("Result", [document.createTextNode(RES[r.result] || ("❔ " + (r.result || "unknown")))]));
  if (r.verified) p.append(line("Verified", [document.createTextNode("🧪 " + r.verified)]));
  const d = new Date(t), okT = !!t && !isNaN(d); // a bad tsMs (out of range) must not throw inside draw()
  const tAgo = okT ? ago(d.toISOString()) : ""; // ago() gives a plain date after 7 days: no repeat of the date then
  if (okT) p.append(line("Time", [document.createTextNode("🕒 " + d.toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) + (/ago|now/.test(tAgo) ? " (" + tAgo + ")" : ""))]));
  p.append(line("Card now", [document.createTextNode(E[it.s] || it.s)]));
  if (r.card && r.card !== w.id) p.append(el("div", "note", "⚠️ This receipt names card " + r.card + "."));
  p.append(textTree(r.summary || "(no summary)", "wsum", richText));
  const bl = Array.isArray(r.blockedBy) ? r.blockedBy : r.blockedBy ? [r.blockedBy] : [];
  if (bl.length) p.append(fold("why|blocked", "⛔ Blocked by", bl.length, () => whyChains(bl), {h: "h3", pin: true}));
  const ev = (Array.isArray(r.evidence) ? r.evidence : r.evidence ? [r.evidence] : []).map(String);
  if (ev.length) p.append(fold("why|evidence", "📎 Evidence", ev.length, () => { const ul = el("ul", "wev"); ev.forEach(e => { const li = el("li"); li.append(...richText(e)); ul.append(li); }); return [ul]; }, {h: "h3", pin: true}));
  const links = el("div", "chips");
  [[r.q, "💬 Question in Discord ↗"], [r.src, "💬 Source message in Discord ↗"]].forEach(([u, lb]) => { if (typeof u === "string" && /^https?:\/\//.test(u)) links.append(linkNode(u, lb)); });
  if (links.childNodes.length) p.append(links);
  if (r.by || r.pane) p.append(el("div", "note", "Written by " + (r.by || "pane:" + r.pane) + " · file receipts/" + w.file));
  p.append(fold("why|raw", "🔧 Raw receipt", null, () => [el("pre", "wraw", JSON.stringify(r, null, 1))], {h: "h3", pin: false}));
  return p;
}
// Re-attached after every draw (the 10 s refresh rebuilds the list); only where the card itself is shown.
// The panel belongs to its card: leaving the card (search, filter, tab; curItem cleared) closes it, so the address
// (which carries why only with its item) matches the screen. Exception: a jump to a blocker keeps the panel under its
// own card while the address names the blocker (↩ Back returns to the card and its why link).
function drawWhy() {
  const old = $("why"); if (old) old.remove();
  if (WHY && curItem == null) WHY = null;
  if (!WHY || tab !== "items" || !D || !D._byId[WHY.id]) return;
  const c = $("card-" + WHY.id); if (!c || !c.isConnected) return;
  try { c.after(whyPanel(WHY)); } catch (e) { console.warn("why panel:", e); } // never break draw() on an odd receipt
}

// ---------- in-page viewer ----------
function esc(s) { return s.replace(/[&<>"]/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch])); }
function inline(s, baseUrl) {
  const codes = []; s = s.replace(/`([^`]+)`/g, (_, x) => "\u0000" + (codes.push("<code>" + esc(x) + "</code>") - 1) + "\u0000");
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => { let h; try { h = new URL(u.replace(/&amp;/g, "&"), baseUrl).href; } catch (e) { return t; } if (!/^(https?:|mailto:)/i.test(h)) return t; return '<a href="' + esc(h) + '" target="_blank" rel="noopener">' + t + "</a>"; });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[n]);
}
function md(text, baseUrl) {
  const L = text.replace(/\r/g, "").split("\n"), out = []; let i = 0;
  const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(x => x.trim());
  while (i < L.length) {
    const line = L[i];
    if (/^```/.test(line)) { const buf = []; i++; while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]); i++; out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>"); continue; }
    let h = line.match(/^(#{1,6})\s+(.*)$/); if (h) { out.push("<h" + h[1].length + ">" + inline(h[2], baseUrl) + "</h" + h[1].length + ">"); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      const head = cells(line); i += 2; let t = "<table><tr>" + head.map(c => "<th>" + inline(c, baseUrl) + "</th>").join("") + "</tr>";
      while (i < L.length && /^\s*\|/.test(L[i])) t += "<tr>" + cells(L[i++]).map(c => "<td>" + inline(c, baseUrl) + "</td>").join("") + "</tr>";
      out.push(t + "</table>"); continue;
    }
    if (/^\s*>/.test(line)) { const buf = []; while (i < L.length && /^\s*>/.test(L[i])) buf.push(L[i++].replace(/^\s*>\s?/, "")); out.push("<blockquote>" + inline(buf.join(" "), baseUrl) + "</blockquote>"); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ol = /^\s*\d/.test(line), buf = [];
      while (i < L.length && (/^\s*([-*+]|\d+[.)])\s+/.test(L[i]) || (/^\s{2,}\S/.test(L[i]) && buf.length))) {
        if (/^\s*([-*+]|\d+[.)])\s+/.test(L[i])) buf.push(L[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "")); else buf[buf.length - 1] += " " + L[i].trim(); i++;
      }
      out.push((ol ? "<ol>" : "<ul>") + buf.map(x => "<li>" + inline(x, baseUrl) + "</li>").join("") + (ol ? "</ol>" : "</ul>")); continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = []; while (i < L.length && L[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*\||\s*([-*+]|\d+[.)])\s+)/.test(L[i])) buf.push(L[i++]);
    if (!buf.length) buf.push(L[i++]);
    out.push("<p>" + inline(buf.join(" "), baseUrl) + "</p>");
  }
  return out.join("\n");
}
function view(p, title, push) {
  if (!p || !internal(p)) { toast("Report not found: only dashboard reports can open here"); if (push === false) { curView = null; syncURL(); } return; } // ?report= is untrusted input
  const h = hrefOf(p), url = new URL(h, location.href).href, k = kindOf(new URL(h, location.href).pathname), vb = $("vb");
  $("vt").textContent = title || p; $("vo").href = url; vb.innerHTML = "";
  if (k === "audio" || k === "video") { const w = el("div", "pad"); w.append(el("b", null, title || p)); const a = el(k); a.controls = true; a.preload = "metadata"; a.src = url; w.append(a); vb.append(w); }
  else if (k === "md") { const w = el("div", "pad md", "Loading…"); vb.append(w); get(url, "text").then(t => { w.innerHTML = md(t, url); }).catch(e => { w.textContent = "Could not load: " + e.message; }); }
  else {
    if (k === "pdf") { const n = el("div", "note", "📕 If only the first page shows, tap ↗ Open."); n.style.padding = "0 12px"; vb.append(n); }
    const fr = el("iframe"); fr.src = url; fr.title = title || p; vb.append(fr);
    // Same-origin report pages: keep them inside the phone width (owner 2026-11-02: no sideways scroll off the screen).
    if (k !== "pdf") fr.addEventListener("load", () => { try { const d = fr.contentDocument; if (!d || !d.head) return; const s = d.createElement("style"); s.dataset.fm = "fit";
      s.textContent = "html,body{max-width:100%!important;overflow-x:hidden!important;box-sizing:border-box}body{overflow-wrap:anywhere}img,video,canvas,svg,iframe{max-width:100%;height:auto}pre{white-space:pre-wrap}table{display:block;max-width:100%;overflow-x:auto}";
      d.head.append(s); } catch (e) { /* cross-origin: leave it */ } });
  }
  $("v").classList.add("on"); document.body.style.overflow = "hidden";
  curView = p;
  if (push !== false) history.pushState({view: p}, "", urlFor({report: p})); else syncURL();
}
function closeView(fromPop) {
  if (!$("v").classList.contains("on")) return; $("v").classList.remove("on"); $("vb").innerHTML = ""; document.body.style.overflow = ""; curView = null; setTimeout(drawIfWanted, 0);
  if (fromPop) return; if (history.state && history.state.view) history.back(); else syncURL();
}

// ---------- events ----------
document.addEventListener("click", e => {
  if (snapOn && e.target.closest("[data-jump],[data-job],[data-svc],[data-view],.fbar,button.more")) { e.preventDefault(); e.stopPropagation(); toast("Loading live data…"); return; } // the cached copy has no data behind it
  const tg = e.target.closest("[data-tag]"); if (tg) { e.preventDefault(); e.stopPropagation(); const t = tg.dataset.tag; if (!TAG_RE.test(t)) return; const add = !tagF.includes(t); if (add && tagF.length >= 8) { toast("Up to 8 tags"); return; }
    tagF = add ? [...tagF, t] : tagF.filter(x => x !== t); tab = "items"; curItem = null; draw(); window.scrollTo(0, 0);
    const bar = $("tagbar"); const fb = bar && (bar.querySelector(`[data-tagrm="${t}"]`) || bar.querySelector("button")); if (fb) fb.focus(); return; }
  const tr = e.target.closest("[data-tagrm]"); if (tr) { e.preventDefault(); const k = tagF.indexOf(tr.dataset.tagrm); tagF = tagF.filter(x => x !== tr.dataset.tagrm); draw();
    const rm = [...document.querySelectorAll("#tagbar [data-tagrm]")]; (rm[Math.min(k, rm.length - 1)] || $("q")).focus(); return; }
  if (e.target.closest("[data-tagclear]")) { e.preventDefault(); tagF = []; draw(); $("q").focus(); return; }
  const j = e.target.closest("[data-jump]"); if (j) { e.preventDefault(); e.stopPropagation(); const from = j.closest(".why") ? $("card-" + WHY.id) : j.closest(".c,.strip"); jump(j.dataset.jump, from && from.id ? from.id : null); return; }
  const jb = e.target.closest("[data-job]"); if (jb) { e.preventDefault(); e.stopPropagation(); const from = jb.closest(".c"); jumpJob(jb.dataset.job, from ? from.id : null); return; }
  const sv = e.target.closest("[data-svc]"); if (sv) { e.preventDefault(); e.stopPropagation(); const from = sv.closest(".c"); jumpSvc(sv.dataset.svc, from ? from.id : null); return; }
  const v = e.target.closest("[data-view]"); if (v) { e.preventDefault(); e.stopPropagation(); view(v.dataset.view, v.dataset.title); return; }
  if (e.target.closest("[data-stop]")) e.stopPropagation();
}, true);
$("q").oninput = () => { curItem = null; draw(); };
const hideBack = () => { $("back").style.display = "none"; lastJump = null; curItem = null; };
$("t-items").onclick = () => { tab = "items"; hideBack(); draw(); };
$("t-reports").onclick = () => { tab = "reports"; hideBack(); draw(); };
$("t-running").onclick = () => { tab = "running"; hideBack(); draw(); };
if ($("t-map")) $("t-map").onclick = () => { tab = "map"; hideBack(); draw(); window.scrollTo(0, 0); };
$("need").onclick = () => { tab = "items"; f = "waiting"; $("q").value = ""; hideBack(); draw(); window.scrollTo(0, 0); };
$("back").onclick = () => {
  const id = lastJump; $("back").style.display = "none"; lastJump = null; if (!id) return;
  if (id.startsWith("card-")) { jump(id.slice(5)); return; }
  tab = "running"; draw(); const c = $(id); if (c) flash(c);
};
$("vx").onclick = () => closeView();
// ℹ️ status modal (owner 2026-11-02, card dashboard-perf): the "Updated … live" line and Claude limits moved off the header.
const INFO = $("info");
$("ib").onclick = () => { if (INFO.showModal) { if (!INFO.open) INFO.showModal(); } else INFO.setAttribute("open", ""); };
$("ix").onclick = () => { if (INFO.close) INFO.close(); else INFO.removeAttribute("open"); };
INFO.addEventListener("click", e => { if (e.target === INFO) $("ix").click(); }); // tap on the backdrop
addEventListener("keydown", e => { if (e.key === "Escape") { if (INFO.open) { $("ix").click(); return; } closeView(); } });
addEventListener("popstate", () => { const p = new URLSearchParams(location.search); const r = p.get("report"); if (r) view(r, null, false); else closeView(true); });

// ---------- data loading + 10 s live refresh ----------
// Spoken label of the (i) button follows both dots: red = offline, amber = Claude limit high (review 2026-11-03).
function ibLabel() {
  const ib = $("ib"), why = [ib.classList.contains("stale") && "offline", ib.classList.contains("warn") && "Claude limit high"].filter(Boolean);
  ib.setAttribute("aria-label", "Dashboard status" + (why.length ? " (" + why.join(", ") + ")" : ""));
}
function setSub(live) {
  const ib = $("ib"); ib.classList.toggle("stale", !live); ibLabel();
  if (D) setText($("u"), "Updated " + fmtUpdated(D.updated) + (live ? " · live ✓" : " · offline, retrying") + (D.partial ? " · loading older cards…" : ""));
}
// Card dash-mobile-hang (2026-11-05): with the TrailBase adapter (v4) an unchanged items list comes back as the SAME
// object (304 by ETag; nothing parsed), so a poll compares objects; no JSON text is built or parsed again. The static
// v3 page (plain fetch) still compares the text. The first v4 answer can be the short list (unfinished cards + done in
// the last 12 h, D.partial); the full list follows right after the first draw.
const V4 = !!window.fmGet;
function loadItems(first) {
  const p = V4 ? get("items.json") : get("items.json", "text").then(t => { if (t === raw) return D; raw = t; return JSON.parse(t); });
  // A new list is indexed in its own task (after the parse task), so a phone never runs parse + index + draw as one long task.
  return p.then(v => v === D ? v : new Promise(r => setTimeout(r, 0, v))).then(v => {
    const changed = v !== D;
    if (changed) { D = v; index(); for (const id of KEEP.cards.keys()) if (!D._byId[id]) KEEP.cards.delete(id); }
    setSub(true); return changed;
  }).catch(e => {
    setSub(false);
    if (first && snapOn) { const n = el("div", "note", "⚠️ Could not load live data (" + e.message + "): this is the saved view; retrying every 10 s"); n.id = "snap-err"; $("l").prepend(n); }
    else if (first) { $("u").textContent = "Could not load items.json: " + e.message; $("l").replaceChildren(el("div", "empty", "⚠️ Could not load items.json: " + e.message + " (retrying every 10 s)")); }
    return false;
  });
}
// Same object as last time (v4: unchanged ETag) = nothing to compare.
const LASTDOC = {}; const same = (k, v) => { if (LASTDOC[k] === v) return true; LASTDOC[k] = v; return false; };
const loadChanges = () => get("changes.json").then(c => { if (same("changes", c)) return false; const s = JSON.stringify(c.items); if (s === JSON.stringify(C)) return false; C = c.items || {}; return true; }).catch(() => false);
// reports.json is ~290 KB: the lists only show its count, so a new copy redraws only for a new count or on the Reports tab.
const loadReports = () => get("reports.json").then(r => { if (same("reports", r)) return false; const n = R.length; R = r.reports || []; return tab === "reports" || R.length !== n; }).catch(() => false);
// running.json is rewritten every 30 s (new `generated`): the lists only redraw when its content changed; the Running
// tab also shows its age, so there it redraws on every new file.
let runSig = "";
const loadRunning = () => get("running.json").then(r => {
  if (RUN && r.generated === RUN.generated) return false;
  const s = JSON.stringify(Object.assign({}, r, {generated: 0})), ch = s !== runSig || tab === "running"; RUN = r; runSig = s; return ch;
}).catch(() => false);
// fm-audit (owner 2026-10-31, card dashboard-autoflow): audit.json lists stuck cards it sent to the sweep (flow) or asked about (owner).
const loadAudit = () => get("audit.json").then(r => { if (same("audit", r)) return false; const a = {flow: Object.fromEntries((r.flow || []).map(x => [x.id, x])), owner: Object.fromEntries((r.owner || []).map(x => [x.id, x]))}; if (JSON.stringify(a) === JSON.stringify(AUD)) return false; AUD = a; return true; }).catch(() => false);
// 🤝 Live board (owner 2026-11-04, card agent-coordination-protocol): coord.json (fm claim/status/beat notes) and
// coord-run.json (fm-coord, the per-stack coordinator, every 5 min). Only the Running tab shows them.
let CO = null, COR = null;
const loadCoord = () => Promise.all([get("coord.json").catch(() => null), get("coord-run.json").catch(() => null)]).then(([c, r]) => {
  const ch = (c && c.updated) !== (CO && CO.updated) || (r && r.at) !== (COR && COR.at); CO = c; COR = r; return ch && tab === "running"; });
const loadPR = () => get("prstate.json").then(r => { if (same("prstate", r)) return false; const s = JSON.stringify(r.cards || {}); if (s === JSON.stringify(PRS)) return false; PRS = r.cards || {}; return true; }).catch(() => false);
// The first draw needs the full list only for a deep link to one card or a search; else the short list draws first.
// Reports and the live board load beside it and redraw when they arrive, unless the address opens their tab.
const needFull = () => { const p = new URLSearchParams(INIT.search); return p.has("item") || p.has("q") || (INIT.hash.length > 1 && !INIT.hash.startsWith("#view=")); };
{
  const p = new URLSearchParams(INIT.search), t = p.get("tab");
  const rep = loadReports(), co = loadCoord();
  const firstSet = [loadItems(true), loadChanges(), loadRunning(), loadPR(), loadAudit()];
  if (t === "reports" || p.has("report")) firstSet.push(rep);
  if (t === "running" || t === "services" || t === "failed" || p.has("svc")) firstSet.push(co);
  Promise.all(firstSet)
    .then(() => D && D.partial && needFull() ? loadItems(false) : null)
    .then(() => {
      applyParams(true);
      Promise.all([rep, co]).then(r => { if (r.some(Boolean)) requestDraw(); });
      const full = D && D.partial ? new Promise(r => setTimeout(r, 50)).then(() => loadItems(false)).then(ch => { if (ch) requestDraw(); }) : Promise.resolve();
      full.then(() => setTimeout(saveSnap, 8000)); // a first copy for the next load, even if this page is never hidden
    });
}
addEventListener("hashchange", () => { const h = decodeURIComponent(location.hash.slice(1)); if (h && !h.startsWith("view=") && D && D._byId[h]) jump(h); }); // old #id links
// ---------- redraw only when it helps (card dash-mobile-hang) ----------
// No poll while the page is hidden (a phone app switch); one poll as soon as it is visible again. A data change while
// the page is hidden, scrolling, or shows a modal (ℹ️ status, report viewer) waits until that ends, so a redraw never
// moves the list under the user's finger. Taps and other user actions still call draw() directly.
let tick = 0, drawWanted = false, lastScroll = 0, scrollT = 0;
const busy = () => document.hidden || Date.now() - lastScroll < 700 || !!INFO.open || $("v").classList.contains("on");
function requestDraw() {
  if (!busy()) { drawWanted = false; draw(); return; }
  drawWanted = true;
}
const drawIfWanted = () => { if (drawWanted) requestDraw(); };
addEventListener("scroll", () => { lastScroll = Date.now(); clearTimeout(scrollT); scrollT = setTimeout(drawIfWanted, 750); }, {passive: true});
INFO.addEventListener("close", drawIfWanted);
function poll() {
  tick++;
  Promise.all([loadItems(false), loadChanges(), tick % 6 === 0 ? loadReports() : false, loadRunning(), tick % 3 === 0 ? loadPR() : false, tick % 3 === 1 ? loadAudit() : false, loadCoord()])
    .then(r => { if (r.some(Boolean) || tick % 6 === 0) setTimeout(requestDraw, 0); }); // own task; every 60 s anyway ("N min ago" labels)
}
setInterval(() => { if (!document.hidden) poll(); }, 10000);
document.addEventListener("visibilitychange", () => { if (document.hidden) { saveSnap(); return; } poll(); drawIfWanted(); });
addEventListener("pagehide", saveSnap);

// ---------- Claude plan limits (Orca #5, owner 2026-10-19): limits.json from the Discord bot's limit watch ----------
let LIM = null;
function drawLimits() {
  const el = $("lim");
  const ib = $("ib"); // amber dot on the (i) button when a Claude window is at >= 95 % or not ok (the line itself is in the modal)
  if (!LIM || !LIM.windows || !LIM.windows.length) { el.hidden = true; ib.classList.remove("warn"); ibLabel(); return; }
  ib.classList.toggle("warn", LIM.windows.some(w => w.status !== "ok" || w.pct >= 95)); ibLabel();
  const left = ms => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? h + "h " + (m % 60) + "m" : Math.floor(h / 24) + "d " + (h % 24) + "h"; };
  const dot = w => w.status !== "ok" || w.pct >= 95 ? "🔴" : w.pct >= 80 ? "🟠" : w.pct >= 60 ? "🟡" : "🟢";
  const parts = LIM.windows.filter(w => w.pct > 0 || !/\(/.test(w.label)).map(w => dot(w) + " " + w.label.replace(/^#(\d+)\s*/, "Account #$1 · ") + " " + w.pct + "%" + (w.resetsAt && w.resetsAt > Date.now() ? " · resets in " + left(w.resetsAt - Date.now()) : ""));
  if (LIM.banked) parts.push("✦ " + LIM.banked + " banked reset" + (LIM.banked === 1 ? "" : "s") + (LIM.autoRedeem === "yes" ? " (auto)" : ""));
  const stale = Date.now() - LIM.updatedAt > 20 * 60000 ? " · ⚠️ " + left(Date.now() - LIM.updatedAt) + " old" : "";
  el.replaceChildren(tree([{t: "🧠 Claude" + stale, sub: parts}]));
  el.hidden = false;
}
const loadLimits = () => get("limits.json").then(l => { LIM = l; drawLimits(); }).catch(() => {});
loadLimits();
setInterval(() => { if (!document.hidden) loadLimits(); }, 60000);
setInterval(() => { if (!document.hidden) drawLimits(); }, 30000);

// ---------- 🧭 Overseer (owner 2026-11-02, card job-overseer): overseer.json from fm-overseer (fm-tick, 1 min) ----------
function drawOverseer(o) {
  const el = $("ovs");
  if (!el) return;
  if (!o || !o.generated) { el.hidden = true; return; }
  const age = Math.round((Date.now() - o.generated) / 60000);
  const live = (o.flags || []).filter(f => !f.observe);
  const names = {a: "PR done", b: "CI queued", c: "wait loop", d: "pane idle", e: "4 h"};
  el.replaceChildren(tree([{t: "🧭 Overseer · last run " + (age < 1 ? "now" : age + " min ago") + (age > 5 ? " ⚠️" : "") + " · " + (o.cards || []).length + " running",
    sub: [live.length ? {t: live.length + " flag" + (live.length === 1 ? "" : "s") + " open:", sub: live.map(f => "• " + (names[f.flag] || f.flag) + ": " + f.card)} : "no flags open"]}]));
  el.hidden = false;
}
const loadOverseer = () => get("overseer.json").then(drawOverseer).catch(() => drawOverseer(null));
loadOverseer();
setInterval(() => { if (!document.hidden) loadOverseer(); }, 60000);

// ---------- 🚧 Main blocker (owner 2026-11-04, card mq-main-blocker): mainblocker.json from the Discord bot's 📋 Master queue ----------
// The same blockers and line as the board: the largest one, then up to 2 more as smaller lines; hidden when none
// qualifies (>= 3 jobs held up or a wait > 60 min) or the file is older than 15 min (the bot rewrites it every 5 min).
// Owner 2026-11-04 (msg 100000000000000052): the section sits directly ABOVE ✍️ Needs you (topStrips), as on the board.
let MB = null, mbText = "";
function mainBlockerStrip() {
  const bs = MB && Array.isArray(MB.blockers) ? MB.blockers.slice(0, 3) : [];
  if (!bs.length || !(Date.now() - (MB.generated || 0) < 15 * 60000)) return null;
  const span = ms => { const t = Math.max(0, Math.round(ms / 60000)); if (t < 60) return t + "m"; const h = Math.floor(t / 60); return h < 48 ? h + "h " + (t % 60) + "m" : Math.round(h / 24) + "d"; };
  const box = el("div", "strip mb"); box.id = "mb"; box.setAttribute("role", "status"); box.setAttribute("aria-label", "Main blocker");
  box.append(...bs.map((b, n) => {
    const row = el("div", n ? "mbx" : "mbm");
    if (!n) row.append(el("b", null, "🚧 Main blocker: "));
    else row.append("🚧 Also: ");
    const held = Number(b.held) || 0;
    row.append(String(b.name || "?") + " — holds up " + held + " job" + (held === 1 ? "" : "s") + ", oldest waiting " + span(Date.now() - (Number(b.since) || Date.now())));
    if (typeof b.link === "string" && /^https:\/\//.test(b.link)) {
      const a = el("a", null, String(b.linkLabel || "open")); a.href = b.link; a.target = "_blank"; a.rel = "noopener";
      row.append(" → ", a);
    }
    return row;
  }));
  return box;
}
// Redraw only when the blockers changed (ages refresh with the normal redraw).
const loadMainBlocker = () => get("mainblocker.json").then(m => m, () => null).then(m => {
  const t = JSON.stringify(m && m.blockers || []); MB = m;
  if (t !== mbText) { mbText = t; if (D) requestDraw(); }
});
loadMainBlocker();
setInterval(() => { if (!document.hidden) loadMainBlocker(); }, 60000);

// ---------- 🧭 Map (owner 2026-10-30, card live-state-chart): bird's-eye dependency graph of unfinished cards ----------
// Lanes = stack (else area), columns = blocker depth (a card sits right of everything that blocks it).
// Owner 2026-10-31 (card dashboard-autoflow): box colour = stack; the emoji in the top-right corner = status (MAPS legend).
// ⛔N = this card blocks N unfinished cards downstream (bottleneck when N >= 2). Red edges = the longest blocker chain.
// Same blocker edges as the card chips (index(): blockedBy + reverse blocks). Redrawn on the normal 10 s refresh.
const MAPC = {waiting: "#d9822b", open: "#c9a227", blocked: "#c0392b", running: "#2f9e44", partial: "#3b6fc4", planned: "#7b5cc4", backlog: "#666", done: "#444"};
let mapStack = "all", mapState = "all", mapChain = false;
const STACKC = ["#3b6fc4", "#2f9e44", "#8e44ad", "#16808a", "#d35400", "#b7950b", "#5d6d7e", "#1f618d", "#6c7a1e", "#7d5a3c", "#4b4fa8", "#2e7d6b"]; // no red: red outlines mark bottlenecks and the longest chain
let laneIdx = {}; // stack -> colour slot, by sorted position among all unfinished stacks (neighbour lanes never share a colour)
const stackColor = k => STACKC[(laneIdx[k] || 0) % STACKC.length];
// Status in the box corner, first match wins: on you > running > restarted by the auditor > scheduled > backlog > blocked > planned > in progress.
const MAPS = [["owner", "✍️", "Waiting on you"], ["running", "⚙️", "Running"], ["flow", "▶️", "The auditor sent it to a sweep"], ["scheduled", "🗓️", "Scheduled (waits for a timer)"],
  ["backlog", "🗃️", "Backlog (parked)"], ["blocked", "🔒", "Blocked by another card or job"], ["planned", "🗺️", "Planned"], ["progress", "🔧", "In progress (queued, no live job yet)"], ["check", "❔", "Unclear; the auditor checks it"]];
const MAPE = Object.fromEntries(MAPS.map(([k, e]) => [k, e]));
function mapStatus(i, G) {
  if (needsOwner(i) || i._track === "owner") return "owner";
  if (i.s === "running") return "running";
  if (AUD.flow[i._id]) return "flow";
  if (isScheduled(i)) return "scheduled";
  if (i.s === "backlog") return "backlog";
  if (i.s === "blocked" || G.by(i).length || (i._roots && i._roots.length)) return "blocked";
  if (i.s === "planned") return "planned";
  if (i.s === "partial") return "progress";
  return "check";
}
function mapGraph() {
  const act = D.items.filter(i => i.s !== "done"), A = new Set(act);
  const by = i => [...i._by].filter(b => A.has(b)), un = i => [...i._un].filter(d => A.has(d));
  const dep = new Map(), down = new Map(), stack = new Set();
  const depth = i => { if (dep.has(i)) return dep.get(i); if (stack.has(i)) return 0; stack.add(i); const v = by(i).reduce((m, b) => Math.max(m, depth(b) + 1), 0); stack.delete(i); dep.set(i, v); return v; };
  const reach = i => { if (down.has(i)) return down.get(i); const seen = new Set(), st = [i]; while (st.length) un(st.pop()).forEach(d => { if (!seen.has(d) && d !== i) { seen.add(d); st.push(d); } }); down.set(i, seen.size); return seen.size; };
  act.forEach(i => { depth(i); reach(i); });
  // Longest chain: deepest card, then walk back through the deepest blocker.
  // Cycle-safe (review 2026-10-30): a visited set ends the walk inside a blocker loop; hotE keeps only the chain's own edges.
  let tip = act.reduce((m, i) => !m || dep.get(i) > dep.get(m) ? i : m, null); const chain = new Set(), hotE = new Set();
  if (tip && dep.get(tip) > 0) while (tip && !chain.has(tip)) { chain.add(tip); if (!(dep.get(tip) > 0)) break; const nx = by(tip).filter(x => !chain.has(x)).reduce((m, x) => !m || dep.get(x) > dep.get(m) ? x : m, null); if (nx) hotE.add(nx._id + ">" + tip._id); tip = nx; }
  return {act, by, un, dep, down, chain, hotE};
}
const laneOf = i => i.stack || i.area || "other";
function drawMap(q) {
  const s = $("s"), l = $("l"), ob = l.querySelector(".mapbox"), sx = ob ? ob.scrollLeft : 0, sy = ob ? ob.scrollTop : 0; // keep scroll across live redraws
  s.innerHTML = ""; l.innerHTML = ""; topStrips(false);
  const G = mapGraph(), linked = i => G.by(i).length || G.un(i).length;
  const lanesAll = [...new Set(G.act.map(laneOf))].sort(); laneIdx = Object.fromEntries(lanesAll.map((k, n) => [k, n]));
  if (mapStack !== "all" && !lanesAll.includes(mapStack)) mapStack = "all";
  if (mapState !== "all" && !G.act.some(i => i.s === mapState)) mapState = "all";
  const sel = (opts, cur, set, lbl) => { const x = el("select", "st"); x.setAttribute("aria-label", lbl); opts.forEach(([v, t]) => { const o = el("option", "", t); o.value = v; if (v === cur) o.selected = true; x.append(o); }); x.onchange = () => { set(x.value); draw(); }; return x; };
  s.append(sel([["all", "All stacks"], ...lanesAll.map(k => [k, k + " " + G.act.filter(i => laneOf(i) === k).length])], mapStack, v => mapStack = v, "Stack filter"));
  s.append(sel([["all", "All states"], ...Object.keys(MAPC).filter(k => k !== "done" && G.act.some(i => i.s === k)).map(k => [k, E[k] + " " + G.act.filter(i => i.s === k).length])], mapState, v => mapState = v, "State filter"));
  const cb = el("button", "st" + (mapChain ? " on" : ""), "🔗 Only blocked chains"); cb.type = "button"; cb.onclick = () => { mapChain = !mapChain; draw(); }; s.append(cb);
  const nodes = G.act.filter(i => (mapStack === "all" || laneOf(i) === mapStack) && (mapState === "all" || i.s === mapState) && (!mapChain || linked(i)) && (!q || (i.t + " " + i._id + " " + (i.n || "")).toLowerCase().includes(q)));
  const bott = G.act.filter(i => G.down.get(i) >= 2).sort((a, b) => G.down.get(b) - G.down.get(a));
  const sum = el("div", "sub"); sum.append(tree([nodes.length + " shown of " + G.act.length + " unfinished cards", G.act.filter(i => G.by(i).length).length + " blocked by another card", "longest chain " + G.chain.size, bott.length ? {t: "bottlenecks:", sub: bott.slice(0, 5).map(i => "• " + i._id + " ⛔" + G.down.get(i))} : "bottlenecks: none"]));
  l.append(sum);
  if (!nodes.length) { l.append(el("div", "empty", "No cards match these filters.")); return; }
  const W = 190, H = 34, GX = 46, GY = 10, LH = 22, N = new Set(nodes), pos = new Map(), lanes = [...new Set(nodes.map(laneOf))].sort();
  const maxD = Math.max(...nodes.map(i => linked(i) ? G.dep.get(i) : 0)), GC = Math.max(maxD + 1, Math.floor((l.clientWidth - 20) / (W + GX)) || 1);
  let y = 8; const laneY = [];
  lanes.forEach(k => {
    // Linked cards use depth columns; cards with no blocker edge fill a grid below them (keeps the map compact).
    const cols = {}, iso = [], mine = nodes.filter(i => laneOf(i) === k).sort((a, b) => G.down.get(b) - G.down.get(a) || a.s.localeCompare(b.s));
    mine.forEach(i => (linked(i) ? (cols[G.dep.get(i)] = cols[G.dep.get(i)] || []) : iso).push(i));
    const lr = Object.values(cols).reduce((m, c) => Math.max(m, c.length), 0), ir = Math.ceil(iso.length / GC), rows = lr + ir; laneY.push([k, y, rows]);
    Object.entries(cols).forEach(([d, c]) => c.forEach((i, r) => pos.set(i, [10 + d * (W + GX), y + LH + r * (H + GY)])));
    iso.forEach((i, n) => pos.set(i, [10 + (n % GC) * (W + GX), y + LH + (lr + Math.floor(n / GC)) * (H + GY)]));
    y += LH + rows * (H + GY) + 14;
  });
  const SW = 20 + GC * (W + GX) - GX, NS = "http://www.w3.org/2000/svg";
  const mk = (t, a, txt) => { const e = document.createElementNS(NS, t); Object.entries(a).forEach(([k, v]) => e.setAttribute(k, v)); if (txt != null) e.textContent = txt; return e; };
  const svg = mk("svg", {width: SW, height: y, viewBox: "0 0 " + SW + " " + y, role: "group", "aria-label": "Card dependency map", style: "font:12px system-ui,sans-serif;display:block"});
  laneY.forEach(([k, ly, rows], n) => { svg.append(mk("rect", {x: 0, y: ly, width: SW, height: LH + rows * (H + GY) + 4, fill: n % 2 ? "rgba(127,127,127,.06)" : "rgba(127,127,127,.12)", rx: 6})); svg.append(mk("rect", {x: 8, y: ly + 5, width: 12, height: 12, rx: 3, fill: stackColor(k)})); svg.append(mk("text", {x: 26, y: ly + 15, fill: "currentColor", "font-weight": 700}, k)); });
  nodes.forEach(i => G.by(i).forEach(b => {
    if (!N.has(b)) return; const [x1, y1] = pos.get(b), [x2, y2] = pos.get(i), hot = G.hotE.has(b._id + ">" + i._id);
    const ax = x1 + W, ay = y1 + H / 2, bx = x2, by2 = y2 + H / 2, mx = (ax + bx) / 2;
    svg.append(mk("path", {d: "M" + ax + "," + ay + " C" + mx + "," + ay + " " + mx + "," + by2 + " " + bx + "," + by2, fill: "none", stroke: hot ? "#e5484d" : "#8899aa", "stroke-width": hot ? 3 : 1.5, "marker-end": "url(#arr)", opacity: .9}));
  }));
  const defs = mk("defs", {}); const mkr = mk("marker", {id: "arr", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto"}); mkr.append(mk("path", {d: "M0,0 L10,5 L0,10 z", fill: "#8899aa"})); defs.append(mkr); svg.prepend(defs);
  nodes.forEach(i => {
    const [x, y0] = pos.get(i), dn = G.down.get(i), st = mapStatus(i, G), a = mk("a", {href: "?item=" + encodeURIComponent(i._id), "data-map": i._id, "data-status": st});
    const t = mk("title", {}, i.t + "\n" + MAPE[st] + " " + MAPS.find(m => m[0] === st)[2] + (st === "flow" ? " (" + AUD.flow[i._id].kind + ": " + AUD.flow[i._id].why + ")" : "") + "\n" + E[i.s] + " · " + laneOf(i) + (dn ? "\nblocks " + dn + " downstream" : "") + (G.by(i).length ? "\nblocked by:\n  • " + G.by(i).map(b => b._id).join("\n  • ") : ""));
    a.append(t, mk("rect", {x, y: y0, width: W, height: H, rx: 7, fill: stackColor(laneOf(i)), stroke: dn >= 2 ? "#ff4d4f" : G.chain.has(i) ? "#e5484d" : "rgba(0,0,0,.3)", "stroke-width": dn >= 2 ? 3 : G.chain.has(i) ? 2 : 1}));
    const lbl = String(i.t); a.append(mk("text", {x: x + 7, y: y0 + 14, fill: "#fff", "font-weight": 600}, lbl.length > 24 ? lbl.slice(0, 23) + "…" : lbl));
    a.append(mk("circle", {cx: x + W - 12, cy: y0 + 12, r: 10, fill: "rgba(0,0,0,.35)"}), mk("text", {x: x + W - 12, y: y0 + 16.5, "text-anchor": "middle", "font-size": 13, class: "mapst"}, MAPE[st]));
    a.append(mk("text", {x: x + 7, y: y0 + 28, fill: "rgba(255,255,255,.8)", "font-size": 10}, (i._id.length > 24 ? i._id.slice(0, 23) + "…" : i._id) + (dn ? "  ⛔" + dn : "")));
    a.addEventListener("click", e => { if (e.ctrlKey || e.metaKey || e.button) return; e.preventDefault(); jump(i._id); });
    svg.append(a);
  });
  const box = el("div", "mapbox"); box.style.cssText = "overflow:auto;max-width:100%;border:1px solid rgba(127,127,127,.3);border-radius:10px;margin-top:6px;-webkit-overflow-scrolling:touch"; box.append(svg); l.append(box); box.scrollLeft = sx; box.scrollTop = sy;
  const leg = el("div", "sub maplegend"); leg.append(el("div", null, "Box colour = stack (the lane name). Corner emoji = status:"));
  const lc = el("div", "chips"); MAPS.forEach(([k, e, txt]) => { const n = nodes.filter(i => mapStatus(i, G) === k).length; if (n) lc.append(el("span", "chip", e + " " + txt + " · " + n)); }); leg.append(lc);
  leg.append(el("div", null, "Arrows: blocker → blocked card. Red outline ⛔N: blocks N cards (bottleneck). Red path: longest chain. Tap a card to open it."));
  l.insertBefore(leg, box); // above the map: the owner reads the key before the boxes
}
