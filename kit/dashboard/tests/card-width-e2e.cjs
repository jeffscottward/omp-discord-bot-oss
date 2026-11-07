// Visual check: every dashboard card uses the full column width, at phone (375) and desktop (1440), dark theme.
// Card dash-jobs-mobile (2026-11-07): a working job card carried class "wk", which collided with the why-row key
// column rule .wk{width:72px}, so working job cards were 72 px wide (one word per line).
// Target: BASE (live dashboard, read-only), else a temp copy of the app with fixtures (lib.cjs).
// Without BASE, running.json is the fixture with a long unbroken cwd on the working job.
// Screenshots: $OUT/<tab>-<width>.png.
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const fs = require("fs"), path = require("path");
const OUT = process.env.OUT || "/tmp/cardwidth";
fs.mkdirSync(OUT, {recursive: true});
const results = [];
const ok = (name, cond, info) => results.push({name, pass: !!cond, info});
(async () => {
  let extra;
  if (!process.env.BASE) {
    const run = JSON.parse(fs.readFileSync(path.join(lib.FIX, "running.json"), "utf8"));
    run.jobs[0].cwd = "~/Github/finance/webapp-research-public-wt-capacity-wait-with-a-very-long-unbroken-folder-name";
    run.jobs[0].status = "working";
    extra = {"running.json": run};
  }
  const tg = await lib.target(extra);
  const b = await puppeteer.launch({executablePath: lib.chrome(), headless: "new", userDataDir: lib.runTmp("fm-cw-") + "/prof", args: ["--no-first-run", "--no-default-browser-check"]});
  const p = await b.newPage();
  await p.emulateMediaFeatures([{name: "prefers-color-scheme", value: "dark"}]);
  const errs = []; p.on("pageerror", e => errs.push(String(e)));
  for (const w of [375, 1440]) {
    await p.setViewport({width: w, height: w < 500 ? 812 : 900, isMobile: w < 500, hasTouch: w < 500});
    await p.goto(tg.base, {waitUntil: "networkidle0"}); await new Promise(r => setTimeout(r, 600));
    const tabs = await p.$$eval(".tab", t => t.map(x => x.id).filter(Boolean));
    for (const id of tabs) {
      await p.click("#" + id); await new Promise(r => setTimeout(r, 500));
      // open folds so nested cards are measured too
      await p.$$eval("details", d => d.forEach(x => { x.open = true; })); await new Promise(r => setTimeout(r, 200));
      const m = await p.evaluate(() => {
        const narrow = [];
        let cards = 0;
        for (const c of document.querySelectorAll(".c")) {
          const r = c.getBoundingClientRect(); if (!r.height || !c.checkVisibility()) continue;
          const par = c.parentElement, ps = getComputedStyle(par);
          if (ps.display.includes("flex") && ps.flexDirection.startsWith("row")) continue; // chips/rows laid out side by side
          const pw = par.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight);
          cards++;
          if (r.width < pw * 0.85) narrow.push({cls: c.className, w: Math.round(r.width), pw: Math.round(pw), t: c.textContent.slice(0, 50)});
        }
        return {cards, narrow, sx: document.documentElement.scrollWidth, vw: innerWidth};
      });
      await p.screenshot({path: `${OUT}/${id}-${w}.png`, fullPage: false});
      ok(`${id}@${w}: cards full width (${m.cards} cards)`, !m.narrow.length, m.narrow.slice(0, 3));
      ok(`${id}@${w}: no horizontal scroll`, m.sx <= m.vw, {scrollWidth: m.sx, vw: m.vw});
    }
  }
  if (!tg.live) {
    // fixture run: the working job card itself (the reported bug) must be wide
    await p.setViewport({width: 375, height: 812, isMobile: true, hasTouch: true});
    await p.goto(tg.base, {waitUntil: "networkidle0"}); await new Promise(r => setTimeout(r, 600));
    await p.click("#t-running"); await new Promise(r => setTimeout(r, 500));
    const jw = await p.$$eval(".c.jb", cs => cs.map(c => Math.round(c.getBoundingClientRect().width)).filter(Boolean));
    ok("working job card ≥ 300 px at 375", jw.length && Math.min(...jw) >= 300, jw);
  }
  ok("no page errors", !errs.length, errs.slice(0, 3));
  await b.close(); tg.stop();
  for (const r of results) console.log((r.pass ? "PASS " : "FAIL ") + r.name + (r.pass ? "" : " " + JSON.stringify(r.info)));
  const fail = results.filter(r => !r.pass).length;
  console.log(`${results.length - fail}/${results.length} passed; screenshots in ${OUT}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
