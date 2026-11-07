// Headless DOM check of the 📨 Queued badge (queued-state task, 2026-10-18; rules updated by owner 2026-10-25,
// cards answered-clears-needs + needs-you-action-gate: an answered card leaves Needs you / Open at once and lists
// under In progress only, with the badge; Needs you / Open list only cards that name an owner `action`).
// Serves a temp copy of the dashboard with a fixture items.json (the live tracker is not changed), then checks:
// badge text, Needs you / Open filters drop the queued card, no "+N 📨" on their buttons, the hoisted Needs-you strip
// and count skip it, a running/done card has no badge, no JS errors. Usage: node queued-state-e2e.cjs [--live]
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const fs = require("fs"), path = require("path"), os = require("os");
const RUN = lib.runTmp("fm-queued-run-"); // Chrome profile + Chrome temp files; removed at exit (card test-tmp-leak)
const results = [];
const ok = (name, cond, info) => results.push({ name, pass: !!cond, info });

const now = Date.now(), t = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const L = (m) => `https://discord.com/channels/1/2/${m}`;
const fixture = { updated: "fixture", items: [
  { id: "need-a", t: "Still needs you", area: "Tools", s: "waiting", n: "sign in", src: L("101"), action: "Sign in" },
  { id: "q-from-needs", t: "Queued from Needs you", area: "Tools", s: "partial", n: "📨 Queued: owner responded " + t, src: L("102"), action: "Sign in", queued: String(now), queuedFrom: "waiting" },
  { id: "q-from-open", t: "Queued from Open", area: "Tools", s: "partial", n: "📨 Queued: owner responded " + t, q: L("103"), queued: String(now), queuedFrom: "open" },
  { id: "open-b", t: "Unanswered question", area: "Tools", s: "open", n: "", q: L("104"), action: "Answer the question" },
  { id: "run-c", t: "Running card with old queued field", area: "Tools", s: "running", n: "working", job: "W", queued: String(now) },
  { id: "plain-partial", t: "Plain in progress", area: "Tools", s: "partial", n: "" },
] };

(async () => {
  const live = process.argv.includes("--live");
  // --live: the live dashboard (BASE, else FM_DASHBOARD_URL). BASE without --live (other app, e.g. a v4 front):
  // fixture via request interception. Neither: a temp copy of the app with this file's fixture.
  let srv = null, base;
  if (live) base = (process.env.BASE || process.env.FM_DASHBOARD_URL || "http://127.0.0.1:8790/firstmate/").replace(/\/?$/, "/");
  else if (process.env.BASE) base = process.env.BASE;
  else { srv = await lib.serveFixture({ "items.json": fixture }); base = srv.base; }
  const shot = path.join(os.tmpdir(), "queued-state-needs.png");
  const b = await puppeteer.launch({ executablePath: lib.chrome(), headless: "new", userDataDir: path.join(RUN, "prof"), env: { ...process.env, TMPDIR: RUN }, args: ["--no-first-run", "--no-default-browser-check"] });
  try {
    const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    if (process.env.BASE) { await p.setRequestInterception(true); p.on("request", (r) => /\/items\.json(\?|$)/.test(r.url()) ? r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }) : r.continue()); }
    const errs = []; p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text() + " " + ((m.location() || {}).url || "")); });
    const go = async (qs) => { await p.goto(base + qs, { waitUntil: "networkidle0" }); await new Promise((r) => setTimeout(r, 600)); };
    const st = () => p.evaluate(() => ({
      cards: [...document.querySelectorAll("#l .c[data-item]")].filter((c) => !c.closest("details:not([open])")).map((c) => ({ id: c.dataset.item, queued: c.classList.contains("queued"), tag: (c.querySelector(".qtag") || {}).textContent || "", act: (c.querySelector(".act") || {}).textContent || "" })),
      strips: [...document.querySelectorAll(".strip")].map((x) => x.textContent), stats: [...document.querySelectorAll(".st")].map((x) => x.textContent), need: document.getElementById("need").textContent,
    }));
    if (live) {
      await go(""); const s = await st();
      ok("live page loads app.js without JS errors", !errs.length && s.cards.length > 0, { errs, n: s.cards.length });
    } else {
      await go(""); let s = await st(); const c = (id) => s.cards.find((x) => x.id === id);
      ok("All: queued card shows the 📨 badge with the response time", c("q-from-needs")?.queued && c("q-from-needs").tag === "📨 Answered " + t + "; working", c("q-from-needs"));
      ok("All: queued card links to 'Show your answer', not 'Answer'", c("q-from-open")?.act === "💬 Show your answer in Discord →", c("q-from-open"));
      ok("running card and plain partial card have no badge", !c("run-c")?.queued && !c("run-c")?.tag && !c("plain-partial")?.queued, [c("run-c"), c("plain-partial")]);
      ok("hoisted Needs-you count and strip skip queued cards", s.need === "✍️ 1 need you" && !s.strips.some((x) => x.includes("Queued from")), { need: s.need, strips: s.strips });
      ok("filter buttons: Needs you 1 and Open 1, no '+N 📨' (owner 2026-10-25)", s.stats.includes("✍️ Needs you 1") && s.stats.includes("⚠️ Open 1") && !s.stats.some((x) => x.includes("📨")), s.stats);
      await go("?tab=needs"); s = await st();
      ok("Needs you filter: only the waiting card (the answered card left at once)", JSON.stringify(s.cards.map((x) => x.id)) === '["need-a"]', s.cards);
      await go("?tab=open"); s = await st();
      ok("Open filter: only the open card (the answered card left at once)", JSON.stringify(s.cards.map((x) => x.id)) === '["open-b"]', s.cards);
      await go("?tab=progress"); s = await st();
      ok("In progress filter: queued cards listed there with the badge", ["q-from-needs", "q-from-open", "plain-partial"].every((id) => s.cards.some((x) => x.id === id)) && s.cards.filter((x) => x.queued).length === 2, s.cards);
      await go("?tab=needs"); await p.screenshot({ path: shot });
      ok("no JS errors", !errs.length, errs);
    }
  } finally {
    await b.close(); if (srv) srv.stop();
  }
  for (const r of results) console.log((r.pass ? "PASS " : "FAIL ") + r.name + (r.pass ? "" : "  " + JSON.stringify(r.info).slice(0, 400)));
  const bad = results.filter((r) => !r.pass).length; console.log(`${results.length - bad}/${results.length} passed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
