"use strict";
// FIRSTMATE dashboard v3. Data: items.json (agents edit), changes.json + reports.json (build-index.py), running.json (build-running.py).
// States (owner 2026-10-18, final): waiting = owner action (hoisted everywhere), open = ONLY unanswered owner questions,
// partial = in progress (answered/accepted, queued), running = a live job works on it now (field `job`).
// Deep links (deeplink-contract.md): ?item= ?tab= ?since= ?q= ?report= ?svc=, kept in sync with the address bar.
const E = {waiting:"✍️ Needs you", open:"⚠️ Open", running:"⚙️ Running", partial:"🔧 In progress", blocked:"🔐 Blocked", planned:"🗺️ Planned", backlog:"🗃️ Backlog", done:"✅ Done"};
const TAB2F = {needs:"waiting", open:"open", progress:"partial", done:"done", all:"all", blocked:"blocked", planned:"planned", backlog:"backlog"};
const F2TAB = Object.fromEntries(Object.entries(TAB2F).map(([k, v]) => [v, k]));
const KIND = {html:"🌐 Page", pdf:"📕 PDF", audio:"🎧 Audio", video:"🎬 Video", md:"📝 Notes"};
const $ = id => document.getElementById(id);
const m0 = location.pathname.match(/^(.*)\/firstmate\//);
const BASE = m0 ? m0[1] : "";               // "/reports" through tailscale serve, "" on 127.0.0.1:8790
const ROOT = location.origin + BASE + "/";
let D = null, R = [], C = {}, RUN = null, raw = "", tab = "items", f = "all", rk = "all", rf = "all", openDone = false, openIdle = false;
let lastJump = null, curItem = null, curView = null, since = null, byRun = null;
let svcOpenX = new Set(), svcClosedX = new Set(); // Background-service groups the user opened/closed against the default (failed = open)

const get = (u, type) => window.fetch(u, {cache: "no-store"}).then(r => { if (!r.ok) throw new Error(r.status + " " + u); return type === "text" ? r.text() : r.json(); });

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
// 📨 Queued (owner 2026-10-18): the owner responded to a Needs-you / Open card; the Discord bot set `queued` (epoch ms)
// and partial (fm records `queuedFrom`). fm removes both when the agent sets running/done or asks again.
const isQueued = i => i.s === "partial" && +i.queued > 0;
// A queued card also stays in the filter it came from (Needs you / Open / Blocked), so the owner sees it was received.
const inFilter = (i, k) => k === "all" || (k === "byyou" ? i._track === "owner" : k === "bybot" ? i._track === "bot" : false) || i.s === k || (isQueued(i) && (i.queuedFrom ? i.queuedFrom === k : k === "waiting" || k === "open"));
function queuedText(i) { return "📨 Queued: you responded " + new Date(+i.queued).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) + "; working on it"; }
function fmtUpdated(u) { const t = Date.parse(u); return t ? new Date(t).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) : (u || "?"); }
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------- model ----------
function index() {
  const items = D.items, ids = itemIds(items), byId = {}, byTitle = {};
  items.forEach((i, n) => { i._id = ids[n]; byId[ids[n]] = i; byTitle[String(i.t).toLowerCase()] = i; i._by = new Set(); i._un = new Set(); });
  const find = ref => { if (!ref) return null; const r = String(ref); const lo = r.toLowerCase(); return byId[r] || byTitle[lo] || items.find(x => String(x.t).toLowerCase().includes(lo)) || null; };
  items.forEach(i => {
    (Array.isArray(i.blockedBy) ? i.blockedBy : i.blockedBy ? [i.blockedBy] : []).forEach(ref => { const b = find(ref); if (b && b !== i) { i._by.add(b); b._un.add(i); } });
    (Array.isArray(i.blocks) ? i.blocks : i.blocks ? [i.blocks] : []).forEach(ref => { const d = find(ref); if (d && d !== i) { d._by.add(i); i._un.add(d); } });
  });
  D._byId = byId;
  // Dependency tracks (owner 2026-10-23, card blocker-tracks): follow open blockers (cycle-safe) to the root leaves.
  // Leaf class: owner (waiting/open, or blocked with q/src) | bot (running or a job; unit/ci refs) | external (ext:/time:) | unknown.
  const refCls = r => /^(ext|time):/i.test(r) ? "external" : /^(ci|job|unit|agent|pane):/i.test(r) || /\.(timer|service)$/.test(r) ? "bot" : "unknown";
  const leafCls = i => i.s === "waiting" || i.s === "open" || (i.s === "blocked" && (i.q || i.src)) ? "owner" : i.ext || (i.until && Date.parse(i.until) > Date.now()) ? "external" : i.s === "running" || i.job ? "bot" : "unknown";
  items.forEach(i => {
    i._roots = []; if (i.s === "done") return;
    // Same edges as the chips: blockedBy by id or title, plus reverse `blocks`; unresolved refs stay as non-card leaves.
    const refsOf = x => [...[...x._by].filter(b => !cleared(b)), ...(Array.isArray(x.blockedBy) ? x.blockedBy : x.blockedBy ? [x.blockedBy] : []).map(String).filter(r => !find(r))];
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
  const link = [i.q, i.src].find(isDiscord) || (String(i.n || "").match(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/) || [])[0] /* owner 2026-10-22: fall back to a Discord message named in the note */; const c = el(link ? "a" : "div", "c" + (i.owner ? " owner" : "") + (i.s === "waiting" ? " need" : "") + (isQueued(i) ? " queued" : "") + (isNew(i) ? " new" : "")); c.id = "card-" + i._id;
  if (link) c.href = link;
  c.dataset.item = i._id;
  c.append(el("b", null, i.t), el("div", "m", (E[i.s] || i.s) + " · " + i.area + (i.n ? " · " + i.n : "")));
  const meta = el("div", "meta2");
  if (isQueued(i)) meta.append(el("span", "qtag", queuedText(i)));
  if (isNew(i)) meta.append(el("span", "newtag", "🆕 changed in this reply"));
  if (i.owner) meta.append(el("span", null, "👤 Owner step"));
  if (i.until) meta.append(el("span", null, until(i.until)));
  const ch = i.ch ? {at: i.ch} : C[i._id];
  if (ch && ch.at) meta.append(el("span", null, "🕒 " + (ch.new ? "added " : "changed ") + (ch.approx ? "~" : "") + ago(ch.at)));
  else if (ch && ch.before) meta.append(el("span", null, "🕒 unchanged since before " + fmtUpdated(ch.before)));
  if (i.auto) { const a = el("span", "auto", "🤖 auto-updated"); a.title = "Changed by fm-autoclear: " + i.auto; meta.append(a); }
  if (meta.childNodes.length) c.append(meta);
  if (i._by.size || i._un.size) {
    const chips = el("div", "chips");
    i._by.forEach(b => { const x = el("button", "chip" + (cleared(b) ? " ok" : b.s === "waiting" ? " needc" : ""), (cleared(b) ? "✅ Was blocked by → " : b.s === "waiting" ? "✍️ Blocked by your step → " : "⛔ Blocked by → ") + b.t); x.dataset.jump = b._id; x.type = "button"; chips.append(x); });
    i._un.forEach(d => { const x = el("button", "chip un", "🔓 Unblocks → " + d.t); x.dataset.jump = d._id; x.type = "button"; chips.append(x); });
    c.append(chips);
  }
  if (i._roots && i._roots.length) {
    const tr = el("div", "chips track"); const T = {owner: "⛔ Blocked by you", bot: "⏳ Blocked by bot work", external: "🌐 Waiting on outside", unknown: "❔ Blocker unclear"};
    i._roots.forEach(r => { const x = el(r.item ? "button" : "span", "chip" + (r.cls === "owner" ? " needc" : r.cls === "bot" ? " job" : ""), T[r.cls] + ": " + r.chain.join(" ← ")); if (r.item) { x.type = "button"; x.dataset.jump = r.item._id; } x.title = "Root: " + r.name; tr.append(x); });
    c.append(tr);
  }
  const js = jobsFor(i), us = unitsFor(i);
  if (js.length || us.length || i.s === "running") {
    const chips = el("div", "chips");
    js.forEach(j => { const w = j.status === "working"; const x = el("button", "chip " + (w ? "job" : "ok"), (w ? "🔄 Working: " : "✅ Finished: ") + jobName(j) + " →"); if (w) x.prepend(el("span", "spin")); x.type = "button"; x.dataset.job = j.id; x.title = "Show this job in ⚙️ Running"; chips.append(x); });
    us.forEach(u => { const w = u.state === "running"; const x = el("button", "chip " + (w ? "job" : u.state === "failed" ? "" : "un"), (w ? "🔄 Working: " : u.state === "failed" ? "❌ Failed: " : "⏱️ Queued: ") + u.unit.replace(/\.service$/, "") + (!w && u.next ? " · next " + untilShort(u.next) : "") + " →"); if (w) x.prepend(el("span", "spin")); x.type = "button"; x.dataset.svc = svcKey(u); x.title = "Show this " + (runPeer().host && u.host === runPeer().host ? runPeer().group + " " : "") + "unit in ⚙️ Running"; chips.append(x); });
    if (i.s === "running" && !js.some(j => j.status === "working") && !us.some(u => u.state === "running")) chips.append(el("span", "chip", "⚠️ No live job found right now (the auto-check moves it back to 🔧 In progress)"));
    c.append(chips);
  }
  if (link) { const ask = i.q && !isQueued(i); c.append(el("span", "go", ask ? "✍️" : "↗"), el("span", "act", ask ? "💬 Answer in Discord →" : isQueued(i) ? "💬 Show your answer in Discord →" : "💬 Show message in Discord →")); }
  else if (i.nosrc) c.append(el("span", "act", "🗂️ No Discord message (from old session)"));
  if (i.l) {
    if (internal(i.l)) { const r = el("button", "rep", "📄 Open report"); r.type = "button"; r.dataset.view = i.l; r.dataset.title = i.t; c.append(r); }
    else { const gh = /^https:\/\/github\.com\//.test(i.l); const r = el("a", "rep", gh ? (/\/pull\/\d+/.test(i.l) ? "🔗 Open the PR on GitHub ↗" : "🔗 Open on GitHub ↗") : "📄 Report ↗"); r.href = i.l; r.dataset.stop = "1"; c.append(r); }
  }
  for (const u of [i.q, i.src]) if (u && !isDiscord(u) && u !== i.l) { const r = el("a", "rep", /github\.com/.test(u) ? "🔗 Open on GitHub ↗" : "🔗 Open link ↗"); r.href = u; r.dataset.stop = "1"; c.append(r); }
  return c;
}
// Hoisted at the very top of every view (owner rule): the owner's own actions, then cards changed in this reply.
function topStrips(inItemsAll) {
  const l = $("l"), need = D ? D.items.filter(i => i.s === "waiting") : [];
  if (need.length && !inItemsAll && !(tab === "items" && f === "waiting")) {
    const b = el("div", "strip needs"); b.append(el("b", null, "✍️ Needs you (" + need.length + ")"));
    const chips = el("div", "chips"); need.forEach(i => { const x = el("button", "chip needc", "✍️ " + i.t); x.type = "button"; x.dataset.jump = i._id; chips.append(x); }); b.append(chips); l.append(b);
  }
  if (false && since != null && D) { // owner 2026-10-19: "Changed in this reply" panel removed
    const ch = D.items.filter(isNew).sort((a, b) => changedMs(b) - changedMs(a));
    const b = el("div", "strip since"); const h = el("b", null, "🆕 Changed in this reply (" + ch.length + ")");
    const x = el("button", "rep", "✕ Clear"); x.type = "button"; x.id = "since-x"; x.onclick = () => { since = null; byRun = null; draw(); }; h.append(x); b.append(h);
    if (!ch.length) b.append(el("div", "m", "No card changed since " + new Date(since).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"}) + "."));
    const chips = el("div", "chips"); ch.forEach(i => { const y = el("button", "chip un", (E[i.s] || i.s).split(" ")[0] + " " + i.t); y.type = "button"; y.dataset.jump = i._id; chips.append(y); }); b.append(chips); l.append(b);
  }
}
function drawItems(q) {
  const s = $("s"), l = $("l"); s.innerHTML = ""; l.innerHTML = "";
  ["all", ...Object.keys(E)].forEach(k => {
    const n = k === "all" ? D.items.length : D.items.filter(i => i.s === k).length, qn = k === "all" || k === "partial" ? 0 : D.items.filter(i => i.s !== k && inFilter(i, k)).length;
    if (!n && !qn && k !== "open" && k !== "waiting") return;
    const b = el("button", "st" + (f === k && k !== "running" ? " on" : ""), (k === "all" ? "All" : E[k]) + " " + n + (qn ? " +" + qn + " 📨" : "")); b.type = "button";
    if (qn) b.title = qn + " queued: you responded; the agent works on it";
    b.onclick = k === "running" ? () => { tab = "running"; rf = "all"; curItem = null; draw(); window.scrollTo(0, 0); } : () => { f = k; curItem = null; draw(); };
    if (k === "running") b.title = "Cards a live job works on now (⚙️ Running tab)";
    s.append(b);
  });
  // Blocker tracks: separate "blocked by you" (the chain ends at your question) from "blocked by bot work".
  [["byyou", "⛔ Blocked by you", "Cards whose blocker chain ends at your question"], ["bybot", "⏳ Blocked by bot work", "Cards waiting on a running job, CI or timer; no action from you"]].forEach(([k, label, tip]) => {
    const n = D.items.filter(i => inFilter(i, k)).length; if (!n) return;
    const b = el("button", "st" + (f === k ? " on" : ""), label + " " + n); b.type = "button"; b.title = tip; b.id = "f-" + k;
    b.onclick = () => { f = k; curItem = null; draw(); }; s.append(b);
  });
  const ord = Object.keys(E);
  const list = D.items.filter(i => inFilter(i, f) && (!q || JSON.stringify(i, (k, v) => k[0] === "_" ? undefined : v).toLowerCase().includes(q)))
    .sort((a, b) => ord.indexOf(a.s) - ord.indexOf(b.s) || (b.owner ? 1 : 0) - (a.owner ? 1 : 0));
  topStrips(f === "all" && !q);
  if (!list.length) { l.append(el("div", "empty", f === "open" ? "No unanswered questions. ✅" : f === "waiting" ? "Nothing needs you right now. ✅" : "No items match.")); return; }
  const collapse = f === "all" && !q;
  const live = collapse ? list.filter(i => i.s !== "done") : list, done = collapse ? list.filter(i => i.s === "done") : [];
  let sec = null;
  live.forEach(i => { if (collapse && i.s !== sec) { sec = i.s; l.append(el("h2", "sec", E[i.s] + " (" + live.filter(x => x.s === i.s).length + ")")); } l.append(card(i)); });
  if (done.length) {
    const d = el("details", "done"); d.open = openDone; d.ontoggle = () => { openDone = d.open; };
    d.append(el("summary", null, "✅ Done (" + done.length + ")")); done.forEach(i => d.append(card(i))); l.append(d);
  }
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
  list.forEach(r => {
    const w = el("div", "rw"), b = el("button", "r"); b.type = "button"; b.dataset.view = r.path; b.dataset.title = r.title; w.append(b);
    b.append(el("b", null, (KIND[r.kind] || "📄").split(" ")[0] + " " + r.title),
      el("div", "m", r.group + " · " + (KIND[r.kind] || r.kind) + " · " + ago(r.mtime) + " · " + (r.size > 1e6 ? (r.size / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(r.size / 1e3)) + " KB")));
    const us = users[r.path];
    if (us) { const chips = el("div", "chips rc"); us.forEach(i => { const x = el("button", "chip un", "📋 Item → " + i.t); x.type = "button"; x.dataset.jump = i._id; chips.append(x); }); w.append(chips); }
    l.append(w);
  });
}

// ---------- running view (running.json from build-running.py) ----------
const JS = {working: "🔄 Working", done: "✅ Finished", idle: "💤 Idle", unknown: "❔ Unknown"};
const SS = {running: "🟢 Running", active: "🟢 Active", waiting: "⏱️ Waiting", failed: "❌ Failed", stopped: "⚪ Stopped", off: "🚫 Off", missing: "❔ Missing", unknown: "❔ Unknown"};
const jobName = j => (j.title || j.tabLabel || j.id);
const jobKey = id => "job-" + String(id).replace(/[^A-Za-z0-9_-]/g, "_");
const recent = (iso, h) => iso && Date.now() - Date.parse(iso) < h * 3600e3;
function jobsFor(i) {
  if (!RUN || !RUN.itemJobs) return [];
  const byId = Object.fromEntries((RUN.jobs || []).map(j => [j.id, j]));
  return (RUN.itemJobs[i._id] || []).map(id => byId[id]).filter(j => j && (j.status === "working" || ((j.status === "done" || j.status === "idle") && recent(j.active, 24))))
    .sort((a, b) => (a.status === "working" ? 0 : 1) - (b.status === "working" ? 0 : 1)).filter((j, n, arr) => j.status === "working" || arr.findIndex(x => x.status !== "working") === n);
}
const svcKey = u => "svc-" + u.host + "-" + String(u.unit).replace(/[^A-Za-z0-9_-]/g, "_");
// ---------- service groups (accordion; ?svc=Builds,Reminders,!Maintenance = opened / !closed against the default) ----------
// Optional peer host (build-running.py FM_PEER_HOST): running.json `peer` = {host, group, ok, checked, lastOk}.
const runPeer = () => (RUN && RUN.peer) || {};
const svcGroup = u => (runPeer().host && u.host === runPeer().host ? runPeer().group : u.group) || "Other";
const svcGroupLabel = g => runPeer().group && g === runPeer().group ? g + " (read-only over ssh)" : g;
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
  const by = Object.fromEntries((RUN.services || []).map(u => [u.host + ":" + u.unit, u]));
  return (RUN.itemUnits[i._id] || []).map(k => by[k]).filter(Boolean);
}
function untilShort(iso) { const t = Date.parse(iso); if (!t) return ""; const m = Math.round((t - Date.now()) / 60000); if (m < 1) return "now"; if (m < 90) return "in " + m + " min"; if (m < 36 * 60) return "in " + Math.round(m / 60) + " h"; return new Date(t).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"}); }
function jobCard(j) {
  const c = el("div", "c jb" + (j.status === "working" ? " wk" : "")); c.id = jobKey(j.id);
  const t = el("b", null, jobName(j)); if (j.status === "working") t.prepend(el("span", "spin")); c.append(t);
  c.append(el("div", "m", (JS[j.status] || j.status) + (j.tabLabel ? " · tab " + j.tabLabel + (j.tabNumber ? " (#" + j.tabNumber + ")" : "") : "") + " · " + (j.cwd || "")));
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
  c.append(el("b", null, (SS[s.state] || s.state) + " · " + s.unit.replace(/\.service$/, "")), el("div", "m", s.desc || ""));
  const meta = el("div", "meta2");
  meta.append(el("span", null, "🖥️ " + (runPeer().host && s.host === runPeer().host ? runPeer().group : (RUN.hostLabel || s.host || "local"))));
  if (s.state === "running" && s.since) meta.append(el("span", null, "▶️ up since " + ago(s.since).replace(" ago", "")));
  else if (s.lastStart) meta.append(el("span", null, "🕒 last run " + ago(s.lastStart) + (s.result && s.result !== "success" ? " (" + s.result + (s.exitStatus && s.exitStatus !== "0" ? ", exit " + s.exitStatus : "") + ")" : "")));
  if (s.next) meta.append(el("span", null, "⏭️ next " + untilShort(s.next)));
  if (s.note) meta.append(el("span", null, "ℹ️ " + s.note));
  c.append(meta);
  if (s.logs) { const lg = el("div", "logs"); lg.append(el("span", null, "📜 Logs: "), el("code", null, s.logs)); c.append(lg); }
  if (s.link) { if (internal(s.link)) { const r = el("button", "rep", "📄 Open report"); r.type = "button"; r.dataset.view = s.link; r.dataset.title = s.unit; c.append(r); } else { const r = el("a", "rep", "↗ Open"); r.href = s.link; r.target = "_blank"; c.append(r); } }
  if ((s.items || []).length) { const chips = el("div", "chips"); s.items.forEach(id => { const it = D && D._byId[id]; if (it) { const x = el("button", "chip un", "📋 Item → " + it.t); x.type = "button"; x.dataset.jump = id; chips.append(x); } }); c.append(chips); }
  return c;
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
  const info = el("div", "note", "⚙️ Read-only view, generated " + ago(RUN.generated) + " by the " + (RUN.hostLabel || "host") + " (every 30 s). Nothing here starts or stops anything.");
  if (age > 180) info.textContent = "⚠️ running.json is " + ago(RUN.generated).replace(" ago", "") + " old: the generator may be stopped (firstmate-running.timer).";
  l.append(info);
  if ((rf === "all" || rf === "jobs") && D) {
    const rc = D.items.filter(i => i.s === "running" && (!q || JSON.stringify(i, (k, v) => k[0] === "_" ? undefined : v).toLowerCase().includes(q)));
    l.append(el("h2", "sec", "⚙️ Cards being worked on now (" + rc.length + ")"));
    if (!rc.length) l.append(el("div", "empty", "No card has a live job right now."));
    rc.forEach(i => l.append(card(i)));
  }
  if (rf === "all" || rf === "jobs") {
    l.append(el("h2", "sec", "🤖 Agent jobs"));
    if (!RUN.jobsOk) l.append(el("div", "note", "⚠️ herdr pane list failed on the last run."));
    const live = jobs.filter(j => j.status !== "idle"), idle = jobs.filter(j => j.status === "idle");
    if (!live.length) l.append(el("div", "empty", "No job is working or newly finished."));
    live.forEach(j => l.append(jobCard(j)));
    if (idle.length) { const d = el("details", "done"); d.open = openIdle || !!q; d.ontoggle = () => { openIdle = d.open; }; d.append(el("summary", null, "💤 Idle (" + idle.length + ")")); idle.forEach(j => d.append(jobCard(j))); l.append(d); }
  }
  if (rf === "all" || rf === "services" || rf === "failed") {
    l.append(el("h2", "sec", "🛠️ Background services"));
    const qv = RUN.peer || {};
    if (qv.ok === false) l.append(el("div", "note", "⚠️ " + (qv.group || qv.host || "The peer host") + " did not answer; its rows are from " + (qv.lastOk ? ago(qv.lastOk) : "never") + "."));
    const force = !!q || rf === "failed"; // search or the ❌ filter shows every matching group open (not saved)
    const groups = [], byG = {};
    svcs.filter(x => rf !== "failed" || x.state === "failed").forEach(x => { const g = svcGroup(x); if (!byG[g]) { byG[g] = []; groups.push(g); } byG[g].push(x); });
    if (!groups.length) l.append(el("div", "empty", q ? "No service matches the search." : "No background services."));
    groups.forEach(g => {
      const rows = byG[g], nf = rows.filter(x => x.state === "failed").length, nr = rows.filter(x => x.state === "running").length;
      const d = el("details", "svg" + (nf ? " bad" : "")); d.dataset.grp = g; d.open = force || svcIsOpen(g);
      const sm = el("summary"); sm.append(el("span", "gn", svcGroupLabel(g)), el("span", "gc", rows.length + (nr ? " · " + nr + " up" : "")));
      if (nf) sm.append(el("span", "gf", "❌ " + nf));
      sm.title = svcGroupLabel(g) + ": " + rows.length + " units" + (nf ? ", " + nf + " failed" : "");
      d.append(sm); rows.forEach(x => d.append(svcRow(x)));
      d.ontoggle = () => { if (!force && d.isConnected) setSvcOpen(g, d.open); };
      l.append(d);
    });
  }
}
function flash(c) { c.scrollIntoView({block: "center"}); c.classList.remove("hl"); void c.offsetWidth; c.classList.add("hl"); }
function backFrom(fromId) { lastJump = fromId || null; $("back").style.display = lastJump ? "block" : "none"; }
function jumpJob(id, fromId) {
  tab = "running"; if (rf !== "all" && rf !== "jobs") rf = "all";
  const j = RUN && (RUN.jobs || []).find(x => x.id === id); if (j && j.status === "idle") openIdle = true;
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

function draw() {
  const q = $("q").value.trim().toLowerCase();
  $("t-items").classList.toggle("on", tab === "items"); $("t-reports").classList.toggle("on", tab === "reports"); $("t-running").classList.toggle("on", tab === "running");
  const wk = RUN ? (RUN.jobs || []).filter(j => j.status === "working").length : 0, fl = RUN ? (RUN.services || []).filter(x => x.state === "failed").length : 0;
  $("t-running").textContent = "⚙️ Running" + (wk ? " " + wk : "") + (fl ? " ·❌" + fl : ""); $("t-running").title = wk + " working jobs, " + fl + " failed services";
  $("t-items").textContent = "📋 Items" + (D ? " " + D.items.length : ""); $("t-reports").textContent = "📚 Reports " + R.length;
  if (D) {
    const need = D.items.filter(i => i.s === "waiting").length, nb = $("need");
    nb.hidden = !need; nb.textContent = "✍️ " + need + " need you"; document.title = (need ? "(" + need + ") " : "") + "FIRSTMATE";
    try { const p = navigator.setAppBadge ? (need ? navigator.setAppBadge(need) : navigator.clearAppBadge()) : null; if (p && p.catch) p.catch(() => {}); } catch (e) { /* badge needs permission */ }
  }
  if (tab === "reports") drawReports(q); else if (tab === "running") drawRunning(q); else if (D) drawItems(q);
  syncURL();
}

// ---------- deep links (deeplink-contract.md): ?item= ?tab= ?since= ?q= ?report= ----------
function tabParam() { return tab === "reports" ? "reports" : tab === "running" ? "running" : (F2TAB[f] || "all"); }
function urlFor(extra) {
  const p = new URLSearchParams(), st = Object.assign({tab: tabParam(), item: curItem, since: since, by: since != null ? byRun : null, q: $("q").value.trim(), report: curView, svc: tab === "running" ? svcParam() : null}, extra || {});
  ["item", "tab", "since", "by", "q", "report", "svc"].forEach(k => { const v = st[k]; if (v != null && v !== "" && !(k === "tab" && v === "all")) p.set(k, String(v)); });
  const s = p.toString(); return location.pathname + (s ? "?" + s : "");
}
function syncURL() { if (!urlReady) return; const u = urlFor(); if (u !== location.pathname + location.search || location.hash) history.replaceState(history.state, "", u); }
function parseSince(v) {
  if (v == null || v === "") return null; if (/^\d+$/.test(v)) { const n = +v; return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(v); return t || null;
}
function applyTab(t) {
  if (t == null || t === "") return true;
  if (t === "reports" || t === "running") { tab = t; return true; }
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
  since = null; // owner 2026-10-19: ?since= ignored (panel and tags removed)
  const b = p.get("by"); byRun = b && /^[A-Za-z0-9:_.-]{1,80}$/.test(b) ? b : null;
  applySvc(p.get("svc"));
  if (p.has("svc") && !p.get("tab")) tab = "running"; else applyTab(p.get("tab"));
  draw();
  const rep = p.get("report") || (h.startsWith("view=") ? h.slice(5) : null);
  const item = p.get("item") || (h && !h.startsWith("view=") ? h : null);
  if (item) {
    if (D && D._byId[item]) setTimeout(() => jump(item), first ? 50 : 0);
    else { curItem = null; tab = "items"; f = "all"; draw(); toast("Card not found: " + item + " · showing All"); }
  }
  if (rep) view(rep, null, false);
}

// ---------- jump between linked cards ----------
function jump(id, fromEl) {
  const it = D && D._byId[id]; if (!it) { toast("Card not found: " + id); return; }
  let c = $("card-" + id);
  if (!c || c.closest("details:not([open])") || !c.offsetParent) {
    tab = "items"; if (f !== "all" && it.s !== f) f = "all"; if (it.s === "done") openDone = true;
    draw(); c = $("card-" + id);
    if (!c) { $("q").value = ""; f = "all"; draw(); c = $("card-" + id); }
  }
  if (!c) { toast("Card not found: " + id); return; }
  backFrom(fromEl && fromEl !== "card-" + id ? fromEl : null);
  curItem = id; syncURL();
  c.scrollIntoView({block: "center", behavior: "smooth"});
  setTimeout(() => { const r = c.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) c.scrollIntoView({block: "center"}); }, 700); // smooth scroll can be skipped
  c.classList.remove("hl"); void c.offsetWidth; c.classList.add("hl");
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
  }
  $("v").classList.add("on"); document.body.style.overflow = "hidden";
  curView = p;
  if (push !== false) history.pushState({view: p}, "", urlFor({report: p})); else syncURL();
}
function closeView(fromPop) {
  if (!$("v").classList.contains("on")) return; $("v").classList.remove("on"); $("vb").innerHTML = ""; document.body.style.overflow = ""; curView = null;
  if (fromPop) return; if (history.state && history.state.view) history.back(); else syncURL();
}

// ---------- events ----------
document.addEventListener("click", e => {
  const j = e.target.closest("[data-jump]"); if (j) { e.preventDefault(); e.stopPropagation(); const from = j.closest(".c,.strip"); jump(j.dataset.jump, from && from.id ? from.id : null); return; }
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
$("need").onclick = () => { tab = "items"; f = "waiting"; $("q").value = ""; hideBack(); draw(); window.scrollTo(0, 0); };
$("back").onclick = () => {
  const id = lastJump; $("back").style.display = "none"; lastJump = null; if (!id) return;
  if (id.startsWith("card-")) { jump(id.slice(5)); return; }
  tab = "running"; draw(); const c = $(id); if (c) flash(c);
};
$("vx").onclick = () => closeView();
addEventListener("keydown", e => { if (e.key === "Escape") closeView(); });
addEventListener("popstate", () => { const p = new URLSearchParams(location.search); const r = p.get("report"); if (r) view(r, null, false); else closeView(true); });

// ---------- data loading + 10 s live refresh ----------
function setSub(live) { if (D) $("u").textContent = "Updated " + fmtUpdated(D.updated) + (live ? " · live ✓" : " · offline, retrying") + " · tap a card → Discord"; }
function loadItems(first) {
  return get("items.json", "text").then(t => { const changed = t !== raw; if (changed) { raw = t; D = JSON.parse(t); index(); } setSub(true); return changed; })
    .catch(e => { setSub(false); if (first) $("u").textContent = "Could not load items.json: " + e.message; return false; });
}
const loadChanges = () => get("changes.json").then(c => { const s = JSON.stringify(c.items); if (s === JSON.stringify(C)) return false; C = c.items || {}; return true; }).catch(() => false);
const loadReports = () => get("reports.json").then(r => { const s = JSON.stringify(r.reports); if (s === JSON.stringify(R)) return false; R = r.reports || []; return true; }).catch(() => false);
const loadRunning = () => get("running.json").then(r => { if (RUN && r.generated === RUN.generated) return false; RUN = r; return true; }).catch(() => false);
Promise.all([loadItems(true), loadChanges(), loadReports(), loadRunning()]).then(() => applyParams(true));
addEventListener("hashchange", () => { const h = decodeURIComponent(location.hash.slice(1)); if (h && !h.startsWith("view=") && D && D._byId[h]) jump(h); }); // old #id links
let tick = 0;
setInterval(() => {
  tick++;
  Promise.all([loadItems(false), loadChanges(), tick % 6 === 0 ? loadReports() : false, loadRunning()]).then(r => { if (r.some(Boolean) || tick % 6 === 0) draw(); });
}, 10000);

// ---------- Claude plan limits (Orca #5, owner 2026-10-19): limits.json from the Discord bot's limit watch ----------
let LIM = null;
function drawLimits() {
  const el = $("lim");
  if (!LIM || !LIM.windows || !LIM.windows.length) { el.hidden = true; return; }
  const left = ms => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? h + "h " + (m % 60) + "m" : Math.floor(h / 24) + "d " + (h % 24) + "h"; };
  const dot = w => w.status !== "ok" || w.pct >= 95 ? "🔴" : w.pct >= 80 ? "🟠" : w.pct >= 60 ? "🟡" : "🟢";
  const parts = LIM.windows.filter(w => w.pct > 0 || !/\(/.test(w.label)).map(w => dot(w) + " " + w.label + " " + w.pct + "%" + (w.resetsAt && w.resetsAt > Date.now() ? " · resets in " + left(w.resetsAt - Date.now()) : ""));
  if (LIM.banked) parts.push("✦ " + LIM.banked + " banked reset" + (LIM.banked === 1 ? "" : "s") + (LIM.autoRedeem === "yes" ? " (auto)" : ""));
  const stale = Date.now() - LIM.updatedAt > 20 * 60000 ? " · ⚠️ " + left(Date.now() - LIM.updatedAt) + " old" : "";
  el.textContent = "🧠 Claude " + parts.join(" · ") + stale;
  el.hidden = false;
}
const loadLimits = () => get("limits.json").then(l => { LIM = l; drawLimits(); }).catch(() => {});
loadLimits();
setInterval(loadLimits, 60000);
setInterval(drawLimits, 30000);
