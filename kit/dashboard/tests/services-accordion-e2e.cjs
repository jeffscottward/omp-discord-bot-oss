// Headless check of the ⚙️ Running → Background services accordion (services-accordion task, 2026-10-18).
// Target: BASE (live dashboard), else a temp copy of the app with kit/dashboard/fixtures (lib.cjs).
// The group names come from the data: A = the first group, B = the second group (the test needs 2 or more groups).
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const fs = require("fs");
const OUT = process.env.OUT || "/tmp/svcacc";
fs.mkdirSync(OUT, {recursive: true});
const results = [];
const ok = (name, cond, info) => { results.push({name, pass: !!cond, info}); };
(async () => {
  const tg = await lib.target(); const BASE = tg.base;
  const b = await puppeteer.launch({executablePath: lib.chrome(), headless: "new", userDataDir: OUT + "/chrome-prof", args: ["--no-first-run", "--no-default-browser-check"]});
  const p = await b.newPage(); await p.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true});
  const errs = []; p.on("pageerror", e => errs.push(String(e))); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  let mock = null; // when set, running.json is answered with this body
  await p.setRequestInterception(true);
  p.on("request", r => { if (mock && /running\.json/.test(r.url())) r.respond({status: 200, contentType: "application/json", body: JSON.stringify(mock)}); else r.continue(); });
  const go = async qs => { await p.goto(BASE + qs, {waitUntil: "networkidle0"}); await new Promise(r => setTimeout(r, 600)); };
  const st = () => p.evaluate(() => ({url: location.search, tabOn: [...document.querySelectorAll(".tab.on")].map(x => x.id),
    groups: [...document.querySelectorAll("details.svg")].map(d => ({g: d.dataset.grp, open: d.open, head: d.querySelector("summary").textContent, rows: d.querySelectorAll(".c.sv").length,
      visible: [...d.querySelectorAll(".c.sv")].filter(c => c.checkVisibility() && c.getBoundingClientRect().height > 0).length})),
    flatRows: document.querySelectorAll("#l > .c.sv").length, h3: document.querySelectorAll("h3.grp").length,
    statRows: document.querySelectorAll("#s").length, stats: [...document.querySelectorAll("#s .st")].map(x => x.textContent),
    sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, headerZ: getComputedStyle(document.querySelector("header")).zIndex}));
  const click = async g => { await p.evaluate(g => document.querySelector(`details.svg[data-grp="${g}"] > summary`).click(), g); await new Promise(r => setTimeout(r, 250)); };
  // Fixture (firstmate-tests, 2026-10-19): live running.json with every failure cleared, so live unit failures don't break the test.
  const real = await (await fetch((process.env.DATA || BASE) + "running.json", {cache: "no-store"})).json();
  for (const u of real.services) if (u.state === "failed") { u.state = "inactive"; delete u.result; delete u.exitStatus; }
  const FIX = JSON.stringify(real); mock = JSON.parse(FIX);
  const grpOf = u => u.group || "Other";
  const realGroups = [...new Set(real.services.map(grpOf))];
  const A = realGroups[0], B = realGroups[1] || realGroups[0];
  const word = (String((real.services.find(u => grpOf(u) === B) || real.services[0]).unit).match(/[a-z]{4,}/i) || ["omp"])[0].toLowerCase();
  const realFailed = new Set(real.services.filter(u => u.state === "failed").map(grpOf));

  // 1. default render with live data
  await go("?tab=running"); let s = await st();
  ok("sections render: one accordion per group, no flat rows / h3 headings left", s.groups.length === realGroups.length && s.flatRows === 0 && s.h3 === 0 && JSON.stringify(s.groups.map(x => x.g)) === JSON.stringify(realGroups), s.groups.map(x => x.g));
  ok("headers show group name + count", s.groups.every(x => { const n = real.services.filter(u => grpOf(u) === x.g).length; return x.rows === n && x.head.includes(String(n)); }), s.groups.map(x => x.head));
  ok("default: failed groups open, others collapsed", s.groups.every(x => x.open === realFailed.has(x.g)), s.groups.map(x => x.g + ":" + x.open));
  ok("collapsed groups hide their rows", s.groups.filter(x => !x.open).every(x => x.visible === 0), null);
  ok("no extra toggle row (still one stats row, same 3-4 toggles)", s.statRows === 1 && s.stats.length <= 4 && /Services/.test(s.stats.join("|")), s.stats);
  ok("no horizontal overflow at 390px (collapsed), header z-index kept", s.sw <= 390 && s.bw <= 390 && s.headerZ === "10", {sw: s.sw, bw: s.bw});
  await p.screenshot({path: OUT + "/1-collapsed.png", fullPage: true});

  // 2. toggle opens + URL sync
  await click(A); s = await st();
  let q = s.groups.find(x => x.g === A);
  ok("tap the first group header opens it and shows its rows", q.open && q.visible === q.rows && q.rows > 0, q);
  ok("URL keeps ?svc=<A>", new URLSearchParams(s.url).get("svc") === A && s.url.includes("tab=running"), s.url);
  await click(B); s = await st();
  ok("second group adds to svc list", new URLSearchParams(s.url).get("svc") === A + "," + B, s.url);
  await p.evaluate(() => draw()); await new Promise(r => setTimeout(r, 200)); s = await st();
  ok("live redraw keeps open state", s.groups.find(x => x.g === A).open && s.groups.find(x => x.g === B).open && new URLSearchParams(s.url).get("svc") === A + "," + B, s.url);
  // open everything → overflow check
  for (const x of s.groups.filter(x => !x.open)) await click(x.g);
  s = await st();
  ok("all groups open: no horizontal overflow at 390px", s.groups.every(x => x.open) && s.sw <= 390 && s.bw <= 390, {sw: s.sw, bw: s.bw});
  await p.screenshot({path: OUT + "/2-all-open.png", fullPage: true});
  for (const x of s.groups.filter(x => x.g !== A)) await click(x.g);
  await click(A); s = await st();
  ok("closing every group removes svc from URL", !s.url.includes("svc=") && s.groups.every(x => !x.open), s.url);

  // 3. deep links
  await go("?tab=running&svc=" + encodeURIComponent(A)); s = await st();
  ok("?tab=running&svc=<A> opens only A on load", s.groups.every(x => x.open === (x.g === A || realFailed.has(x.g))), s.groups.map(x => x.g + ":" + x.open));
  await go("?svc=" + encodeURIComponent(A.toLowerCase() + "," + B.toUpperCase())); s = await st();
  ok("svc alone selects Running; names are case-insensitive", s.tabOn[0] === "t-running" && s.groups.find(x => x.g === A).open && s.groups.find(x => x.g === B).open, {tab: s.tabOn, url: s.url});
  await go("?tab=running&svc=NoSuchGroup"); s = await st();
  ok("unknown svc group is harmless (no errors, all collapsed)", !errs.length && s.groups.every(x => x.open === realFailed.has(x.g)), errs);
  await go("?tab=running&q=" + word); s = await st();
  ok("search opens matching groups (not saved to svc)", s.groups.length > 0 && s.groups.every(x => x.open) && !s.url.includes("svc="), s.groups.map(x => x.g));

  // 4. chip/jump into a collapsed group opens it
  await go("?tab=running");
  const tgt = real.services.find(u => grpOf(u) === "Maintenance") || real.services[0];
  const key = "svc-" + tgt.host + "-" + String(tgt.unit).replace(/[^A-Za-z0-9_-]/g, "_");
  await p.evaluate(k => jumpSvc(k, null), key); await new Promise(r => setTimeout(r, 400));
  const vis = await p.evaluate(k => { const c = document.getElementById(k); return !!(c && c.checkVisibility() && c.getBoundingClientRect().height > 0); }, key); s = await st();
  ok("jump to a unit opens its group and shows the row", vis && (new URLSearchParams(s.url).get("svc") || "").split(",").includes(grpOf(tgt)), {key, url: s.url});

  // 5. failed groups (mocked running.json)
  mock = JSON.parse(JSON.stringify(real)); mock.generated = new Date().toISOString();
  const tr = mock.services.filter(u => grpOf(u) === B); tr[0].state = "failed"; tr[0].result = "exit-code"; tr[0].exitStatus = "1"; if (tr[1]) tr[1].state = "failed";
  await go("?tab=running"); s = await st();
  let t = s.groups.find(x => x.g === B);
  ok("failed group starts expanded, shows ❌ count; others collapsed", t.open && t.head.includes("❌ " + (tr[1] ? 2 : 1)) && s.groups.filter(x => x.g !== B).every(x => !x.open), s.groups.map(x => x.head + ":" + x.open));
  ok("failed group has red border class", await p.evaluate(g => document.querySelector(`details.svg[data-grp="${g}"]`).classList.contains("bad"), B), null);
  await p.screenshot({path: OUT + "/3-failed.png", fullPage: true});
  await click(B); s = await st();
  ok("collapsing a failed group saves svc=!<B>", !s.groups.find(x => x.g === B).open && new URLSearchParams(s.url).get("svc") === "!" + B, s.url);
  await go("?tab=running&svc=" + encodeURIComponent("!" + B)); s = await st();
  ok("?svc=!<B> keeps the failed group closed on load", !s.groups.find(x => x.g === B).open, null);
  await p.evaluate(() => { document.querySelector('#s .st:last-child').click(); }); await new Promise(r => setTimeout(r, 250)); s = await st();
  ok("❌ Failed filter shows only the failed group, open", s.groups.length === 1 && s.groups[0].g === B && s.groups[0].open && s.groups[0].rows === (tr[1] ? 2 : 1), s.groups);
  mock = JSON.parse(FIX);

  ok("no JS errors during the run", !errs.length, errs);
  await b.close(); tg.stop();
  const pass = results.filter(r => r.pass).length;
  fs.writeFileSync(OUT + "/results.json", JSON.stringify(results, null, 1));
  results.forEach(r => console.log((r.pass ? "PASS " : "FAIL ") + r.name + (r.pass ? "" : " :: " + JSON.stringify(r.info).slice(0, 300))));
  console.log(pass + "/" + results.length + " passed");
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
