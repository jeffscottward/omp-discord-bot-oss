// Headless DOM check of theme tags (cards fm-card-tags, tag-filter-optin, owner 2026-11-06): tag chips on cards; the tag
// filter bar is hidden by default, a chip tap opens it, more chips add tags (AND), each tag removes alone, ✕ clears and hides;
// ?tag=a,b deep link (kept in the URL), tag + state filter together. 375 px and 1440 px, dark. Screenshots of the 4 states.
// Usage: node tag-filter-e2e.cjs [--live]   (--live: BASE/FM_DASHBOARD_URL, only checks ?tag=macos-manual loads)
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const path = require("path"), os = require("os");
const RUN = lib.runTmp("fm-tag-run-");
const results = [];
const ok = (name, cond, info) => results.push({ name, pass: !!cond, info });
const L = (m) => `https://discord.com/channels/1/2/${m}`;
const fixture = { updated: "fixture", items: [
  { id: "second-a", t: "Second password step", area: "Tools", s: "partial", n: "", src: L("1"), tags: ["macos-manual", "security"] },
  { id: "second-b", t: "Photo export on macOS", area: "Tools", s: "planned", n: "", src: L("2"), tags: ["macos-manual"] },
  { id: "ig", t: "Instagram bot", area: "Social", s: "partial", n: "", src: L("3"), tags: ["instagram"] },
  { id: "plain", t: "No tags", area: "Tools", s: "partial", n: "", src: L("4") },
] };

(async () => {
  const live = process.argv.includes("--live");
  let srv = null, base;
  if (live) base = (process.env.BASE || process.env.FM_DASHBOARD_URL || "http://127.0.0.1:8790/firstmate/").replace(/\/?$/, "/");
  else { srv = await lib.serveFixture({ "items.json": fixture }); base = srv.base; }
  const shotDir = process.env.SHOT_DIR || os.tmpdir();
  const b = await puppeteer.launch({ executablePath: lib.chrome(), headless: "new", userDataDir: path.join(RUN, "prof"), env: { ...process.env, TMPDIR: RUN }, args: ["--no-first-run", "--no-default-browser-check"] });
  try {
    for (const [w, h, mob] of [[375, 812, true], [1440, 900, false]]) {
      const p = await b.newPage(); await p.setViewport({ width: w, height: h, isMobile: mob, hasTouch: mob });
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
      const go = async (qs) => { await p.goto(base + qs, { waitUntil: "networkidle0" }); await new Promise((r) => setTimeout(r, 700)); };
      const st = () => p.evaluate(() => ({
        cards: [...document.querySelectorAll("#l .c[data-item]")].filter((c) => !c.closest("details:not([open])")).map((c) => c.dataset.item),
        chips: [...document.querySelectorAll("#l .chip.tag")].map((x) => x.textContent), bar: !!document.getElementById("tagbar"),
        barTags: [...document.querySelectorAll("#tagbar [data-tagrm]")].map((x) => x.dataset.tagrm), first: (document.querySelector("#tagbar button") || {}).dataset?.tagclear || "",
        inHeader: !!document.querySelector("header > #tagbar"), oldRow: !!document.getElementById("tagrow"),
        url: decodeURIComponent(location.search), overflow: document.documentElement.scrollWidth > innerWidth + 1,
      }));
      const wait = () => new Promise((r) => setTimeout(r, 300));
      const shot = (n) => p.screenshot({ path: path.join(shotDir, `tag-filter-${n}-${w}.png`) });
      if (live) {
        await go(""); let s = await st();
        ok(`${w}px live: bar hidden by default`, !errs.length && !s.bar && !s.oldRow && s.chips.length > 0, s); await shot("live-1-hidden");
        const tags = await p.evaluate(() => { const c = [...document.querySelectorAll("#l .c[data-item]")].find((c) => c.querySelectorAll(".chip.tag").length >= 2); return c ? [...c.querySelectorAll(".chip.tag")].slice(0, 2).map((x) => x.dataset.tag) : []; });
        if (tags.length < 2) { ok(`${w}px live: a card with 2+ tags exists`, false, tags); continue; }
        await p.click(`#l .chip.tag[data-tag="${tags[0]}"]`); await wait(); s = await st();
        ok(`${w}px live: chip opens bar`, s.bar && s.first === "1" && s.barTags.join() === tags[0], s); await shot("live-2-one");
        await p.click(`#l .chip.tag[data-tag="${tags[1]}"]`); await wait(); s = await st();
        ok(`${w}px live: second tag added`, s.barTags.join() === tags.join() && s.url.includes("tag=" + tags.join(",")) && !s.overflow, s); await shot("live-3-two");
        await p.click(`#tagbar [data-tagrm="${tags[0]}"]`); await wait(); s = await st();
        ok(`${w}px live: remove one`, s.barTags.join() === tags[1], s); await shot("live-4-removed");
        await p.click("#tagbar [data-tagclear]"); await wait(); s = await st();
        ok(`${w}px live: ✕ clears and hides`, !s.bar && !/tag=/.test(s.url), s); await shot("live-5-cleared");
        continue;
      }
      await go(""); let s = await st();
      ok(`${w}px: chips on cards, no tag bar by default`, s.chips.includes("#macos-manual") && !s.bar && !s.oldRow, s); await shot("1-hidden");
      await p.click('#l .c[data-item="second-a"] .chip.tag[data-tag="macos-manual"]'); await wait(); s = await st();
      ok(`${w}px: chip tap opens the bar in the top section, ✕ first`, s.bar && s.inHeader && s.first === "1" && s.barTags.join() === "macos-manual" && JSON.stringify(s.cards.sort()) === '["second-a","second-b"]' && /tag=macos-manual/.test(s.url), s); await shot("2-one");
      await p.click('#l .c[data-item="second-a"] .chip.tag[data-tag="security"]'); await wait(); s = await st();
      ok(`${w}px: second tag narrows (all tags) and syncs URL`, s.barTags.join() === "macos-manual,security" && JSON.stringify(s.cards) === '["second-a"]' && s.url.includes("tag=macos-manual,security"), s);
      ok(`${w}px: no horizontal overflow`, !s.overflow, s); await shot("3-two");
      await p.click('#tagbar [data-tagrm="macos-manual"]'); await wait(); s = await st();
      ok(`${w}px: focus stays on a tag after removing one`, await p.evaluate(() => document.activeElement && document.activeElement.dataset.tagrm === "security"), "");
      ok(`${w}px: remove one tag alone`, s.barTags.join() === "security" && JSON.stringify(s.cards) === '["second-a"]' && /tag=security/.test(s.url) && !/macos/.test(s.url), s); await shot("4-removed");
      await p.click("#tagbar [data-tagclear]"); await wait(); s = await st();
      ok(`${w}px: ✕ clears all and hides the bar`, !s.bar && s.cards.length === 4 && !/tag=/.test(s.url), s);
      await go("?tag=macos-manual,security"); s = await st();
      ok(`${w}px: ?tag=a,b deep link opens the bar`, s.bar && s.barTags.join() === "macos-manual,security" && JSON.stringify(s.cards) === '["second-a"]', s);
      await go("?tag=b%40d,,%23Security,security"); s = await st();
      ok(`${w}px: ?tag= cleanup (invalid, # prefix, duplicates)`, s.barTags.join() === "security", s);
      await go("?tag=security"); await p.click('#l .c[data-item="second-a"] .chip.tag[data-tag="security"]'); await wait(); s = await st();
      ok(`${w}px: tapping an active chip removes its tag`, !s.bar && !/tag=/.test(s.url), s);
      await go("?tab=planned&tag=macos-manual"); s = await st();
      ok(`${w}px: tag works with the state filter`, JSON.stringify(s.cards) === '["second-b"]', s);
      await p.focus("#tagbar [data-tagclear]"); await p.keyboard.press("Enter"); await wait(); s = await st();
      ok(`${w}px: keyboard Enter on ✕ clears`, !s.bar, s);
      ok(`${w}px: no JS errors`, !errs.length, errs);
      await p.close();
    }
  } finally {
    await b.close(); if (srv) srv.stop();
  }
  for (const r of results) console.log((r.pass ? "PASS " : "FAIL ") + r.name + (r.pass ? "" : "  " + JSON.stringify(r.info).slice(0, 400)));
  const bad = results.filter((r) => !r.pass).length; console.log(`${results.length - bad}/${results.length} passed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
