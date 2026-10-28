// Headless check of the FIRSTMATE dashboard states + deep links (state-semantics task, 2026-10-18).
// Target: BASE (live dashboard, read-only), else a temp copy of the app with kit/dashboard/fixtures (lib.cjs).
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const fs = require("fs");
const SHOTS = process.env.OUT || "/tmp/stsem";
const results = [];
const ok = (name, cond, info) => { results.push({name, pass: !!cond, info}); };
(async () => {
  const tg = await lib.target(); const BASE = tg.base; fs.mkdirSync(SHOTS, {recursive: true});
  const b = await puppeteer.launch({executablePath: lib.chrome(), headless: "new", userDataDir: SHOTS + "/chrome-prof", args: ["--no-first-run", "--no-default-browser-check"]});
  const p = await b.newPage(); await p.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true});
  const errs = []; p.on("pageerror", e => errs.push(String(e))); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  const go = async (qs) => { await p.goto(BASE + qs, {waitUntil: "networkidle0"}); await new Promise(r => setTimeout(r, 700)); };
  const st = () => p.evaluate(() => ({url: location.search + location.hash, toast: document.getElementById("toast").classList.contains("on") ? document.getElementById("toast").textContent : "",
    tabOn: [...document.querySelectorAll(".tab.on")].map(x => x.id), stOn: [...document.querySelectorAll(".st.on")].map(x => x.textContent),
    cards: [...document.querySelectorAll("#l .c[data-item]")].filter(c => !c.closest("details:not([open])")).map(c => c.dataset.item),
    first: (document.querySelector("#l > *") || {}).className, firstText: ((document.querySelector("#l > *") || {}).textContent || "").slice(0, 60),
    hl: [...document.querySelectorAll(".hl")].map(c => c.id), viewer: document.getElementById("v").classList.contains("on"), vt: document.getElementById("vt").textContent,
    q: document.getElementById("q").value, strips: [...document.querySelectorAll(".strip > b")].map(x => x.textContent),
    headerZ: getComputedStyle(document.querySelector("header")).zIndex, sw: document.documentElement.scrollWidth}));
  // Fixture (firstmate-tests, 2026-10-19): live items.json plus one card per owner state, served to the page only (live file untouched).
  const items = await (await fetch((process.env.DATA || BASE) + "items.json", {cache: "no-store"})).json();
  const L = m => "https://discord.com/channels/1/2/" + m, now = Date.now();
  for (const s of ["open", "waiting"]) if (!items.items.some(i => i.s === s))
    items.items.push({id: "e2e-fixture-" + s, t: "e2e fixture " + s, area: "test", s, n: "", q: L(String(9e5 + now % 1e5)), changed: "2026-10-19 00:00", cts: now - 864e5, by: "manual"});
  const FIX = JSON.stringify(items);
  await p.setRequestInterception(true);
  p.on("request", r => { if (/\/items\.json(\?|$)/.test(r.url())) r.respond({status: 200, contentType: "application/json", body: FIX}); else r.continue(); });
  const by = s => items.items.filter(i => i.s === s).map(i => i.id);
  // 📨 Queued cards (partial + queued) also show in the filter they came from (queuedFrom; both owner filters if unset).
  const inF = k => items.items.filter(i => i.s === k || (i.s === "partial" && +i.queued > 0 && (i.queuedFrom ? i.queuedFrom === k : k === "waiting" || k === "open"))).map(i => i.id);

  await go("");
  let s = await st();
  ok("default: no JS errors, header z-index kept, no horizontal overflow", !errs.length && s.headerZ === "10" && s.sw <= 390, {errs, z: s.headerZ, sw: s.sw});
  ok("default: Needs you section first (hoisted)", /Needs you/.test(s.firstText), s.firstText);
  ok("default: first cards are the waiting ones", JSON.stringify(s.cards.slice(0, by("waiting").length).sort()) === JSON.stringify(by("waiting").sort()), s.cards.slice(0, 4));

  await go("?tab=open"); s = await st();
  ok("tab=open shows only open (unanswered) cards + needs strip on top", JSON.stringify(s.cards.sort()) === JSON.stringify(inF("open").sort()) && /Needs you/.test(s.strips[0] || "") && s.url === "?tab=open", s);
  await go("?tab=needs"); s = await st();
  ok("tab=needs shows waiting cards", JSON.stringify(s.cards.sort()) === JSON.stringify(inF("waiting").sort()), s.cards);
  await go("?tab=progress"); s = await st();
  ok("tab=progress shows partial cards only", JSON.stringify(s.cards.sort()) === JSON.stringify(by("partial").sort()), s.cards.length + " vs " + by("partial").length);
  await go("?tab=done"); s = await st();
  ok("tab=done shows done cards", s.cards.length === by("done").length && s.url === "?tab=done", s.cards.length);
  await go("?tab=running"); s = await st();
  ok("tab=running opens Running tab with running cards first, needs strip on top", s.tabOn[0] === "t-running" && by("running").every(id => s.cards.includes(id)) && /Needs you/.test(s.strips[0] || ""), s);
  await go("?tab=reports"); s = await st();
  ok("tab=reports opens Reports with needs strip", s.tabOn[0] === "t-reports" && /Needs you/.test(s.strips[0] || ""), s.tabOn);
  await go("?tab=bogus"); s = await st();
  ok("tab=bogus falls back to All with a toast", /Unknown tab/.test(s.toast) && s.stOn[0].startsWith("All"), s);

  const doneId = by("done")[3], openId = by("open")[0];
  await go("?item=" + doneId); await new Promise(r => setTimeout(r, 900)); s = await st();
  ok("item=<done id> expands Done and highlights the card; URL keeps item", s.hl.includes("card-" + doneId) && s.url.includes("item=" + doneId), s);
  for (const bad of ["javascript:window.__pwned=1", "https://example.com/x.md", "//example.com/x.md"]) {
    await go("?report=" + encodeURIComponent(bad)); s = await st();
    const pw = await p.evaluate(() => window.__pwned === 1 || !!document.querySelector("#vb iframe"));
    ok("report=" + bad.slice(0, 22) + " is refused (no viewer, toast, param dropped)", !s.viewer && !pw && /Report not found/.test(s.toast) && !s.url.includes("report="), s);
  }
  await go("?item=no-such-card"); s = await st();
  ok("item=<unknown> toasts 'card not found' and shows All", /Card not found/.test(s.toast) && s.stOn[0].startsWith("All") && !s.url.includes("item="), s);
  await go("?tab=open&item=" + openId); await new Promise(r => setTimeout(r, 900)); s = await st();
  ok("tab=open&item=<open id> highlights within Open", s.hl.includes("card-" + openId) && s.url.includes("tab=open"), s);

  const cts = items.items.map(i => i.cts || 0).filter(Boolean).sort((a, b) => b - a);
  // Same rule as app.js isNew(): any of the card's last writes (hist) after the cut by someone other than fm-autoclear.
  const writesAfter = i => (Array.isArray(i.hist) && i.hist.length ? i.hist : [{by: i.by, cts: i.cts || 0}]).filter(w => w && +w.cts > cut && w.by !== "autoclear");
  const cut = cts[2] - 1, want = items.items.filter(i => writesAfter(i).length).length;
  await go("?since=" + cut); s = await st();
  const nNew = await p.$$eval("#l .c.new", x => x.length);
  ok("since=<ms> is ignored (owner 2026-10-19): no strip, no tags, param dropped", !s.strips.some(t => /Changed/.test(t)) && nNew === 0 && !s.url.includes("since="), {strips: s.strips, nNew, want});

  // Search word: the first word of 5+ letters in a card title that is not done (from the data, not hard-coded).
  const word = ((items.items.find(i => i.s !== "done" && /[a-z]{5,}/i.test(i.t || "")) || {t: "example"}).t.match(/[a-z]{5,}/i)[0]).toLowerCase();
  await go("?q=" + word); s = await st();
  ok("q=<word> prefills search and filters", s.q === word && s.cards.length > 0 && s.url.includes("q=" + word), {q: s.q, n: s.cards.length});

  // deeplink-contract.md is installed next to the app (kit/install.sh copies kit/dashboard/docs into FM_DIR).
  await go("?report=" + encodeURIComponent("/reports/firstmate/deeplink-contract.md")); await new Promise(r => setTimeout(r, 600)); s = await st();
  const mdText = await p.$eval("#vb", x => x.textContent.slice(0, 200));
  ok("report=<path> opens the viewer with the report", s.viewer && /contract/i.test(mdText) && s.url.includes("report="), {vt: s.vt, mdText});
  await p.click("#vx"); await new Promise(r => setTimeout(r, 300)); s = await st();
  ok("closing the viewer removes report from the URL", !s.viewer && !s.url.includes("report="), s.url);

  // URL sync on clicks
  await go(""); await p.evaluate(() => [...document.querySelectorAll(".st")].find(x => x.textContent.startsWith("⚠️ Open")).click()); s = await st();
  ok("clicking the Open filter syncs tab=open", s.url === "?tab=open", s.url);
  // working chip -> Running entry -> back link to the card
  const runId = by("running").find(id => true);
  await go("?item=" + runId); await new Promise(r => setTimeout(r, 800));
  const hasJob = await p.$("#card-" + runId + " [data-job], #card-" + runId + " [data-svc]");
  if (hasJob) {
    await hasJob.click(); await new Promise(r => setTimeout(r, 500)); s = await st();
    const target = s.hl.find(x => /^(job|svc)-/.test(x));
    ok("working chip jumps to its ⚙️ Running entry", s.tabOn[0] === "t-running" && target && s.url.includes("tab=running"), s);
    const backChip = await p.$("#" + target + " [data-jump='" + runId + "']");
    ok("the Running entry links back to the card", !!backChip, target);
    if (backChip) { await backChip.click(); await new Promise(r => setTimeout(r, 900)); s = await st(); ok("back-link jumps to the card", s.hl.includes("card-" + runId) && s.url.includes("item=" + runId), s); }
  } else ok("running card has a job chip", false, runId);
  // unit chip (timer/service job)
  const unitCard = items.items.find(i => i.s !== "done" && /\.(service|timer)$/.test(String(i.job || "")) && !/finance/i.test(i.area));
  if (unitCard) {
    await go("?item=" + unitCard.id); await new Promise(r => setTimeout(r, 800));
    const sv = await p.$("#card-" + unitCard.id + " [data-svc]");
    if (sv) { await sv.click(); await new Promise(r => setTimeout(r, 500)); s = await st(); const t = s.hl.find(x => x.startsWith("svc-")); ok("unit chip jumps to the service row, which links back", !!t && !!(await p.$("#" + t + " [data-jump='" + unitCard.id + "']")), {t, card: unitCard.id}); }
    else ok("unit card has a unit chip", false, unitCard.id);
  }
  // blocked-by chip to an owner step
  const dep = items.items.find(i => i.s === "blocked" && i.blockedBy);
  if (dep) {
    await go("?item=" + dep.id); await new Promise(r => setTimeout(r, 800));
    const c = await p.$("#card-" + dep.id + " .chip.needc[data-jump]"); const tgt = c && await c.evaluate(x => x.dataset.jump);
    if (c) { await c.click(); await new Promise(r => setTimeout(r, 900)); s = await st(); ok("'Blocked by your step' chip jumps to the owner card", s.hl.includes("card-" + tgt) && items.items.find(i => i.id === tgt).s === "waiting", {tgt}); }
    else ok("blocked card shows a 'Blocked by your step' chip", false, dep.id);
  }
  await p.screenshot({path: SHOTS + "/dash-default.png"});
  await go("?tab=running"); await p.screenshot({path: SHOTS + "/dash-running.png"});
  await b.close(); tg.stop();
  const fail = results.filter(r => !r.pass);
  results.forEach(r => console.log((r.pass ? "PASS " : "FAIL ") + r.name + (r.pass ? "" : "  " + JSON.stringify(r.info).slice(0, 400))));
  console.log(`${results.length - fail.length}/${results.length} passed; page errors: ${errs.length}`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
