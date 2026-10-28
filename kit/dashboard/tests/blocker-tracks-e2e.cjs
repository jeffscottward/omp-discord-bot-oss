// Headless check of the blocker-track filters and chain chips (card blocker-tracks, 2026-10-23). Fixture copy only.
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const M = n => "https://discord.com/channels/1/2/" + n;
const items = {updated: "2026-10-23 12:00", items: [
  {id: "q", t: "Pick a host", s: "waiting", q: M(1), area: "x"},
  {id: "c", t: "CI fix", s: "running", job: "ci-tab", area: "x"},
  {id: "a", t: "Build A", s: "partial", blockedBy: "b", area: "x"},
  {id: "b", t: "Build B", s: "partial", blockedBy: ["q"], area: "x"},
  {id: "d", t: "Deploy D", s: "partial", blockedBy: "c", area: "x"},
  {id: "g", t: "Gate", s: "partial", until: "2099-01-01T00:00:00Z", area: "x"}, {id: "h", t: "Wait gate", s: "partial", blockedBy: "gate", area: "x"},
  {id: "o", t: "Your pick", s: "waiting", q: M(2), blocks: "r", area: "x"}, {id: "r", t: "Rev", s: "partial", area: "x"},
  {id: "x", t: "Loop X", s: "partial", blockedBy: "y", area: "x"}, {id: "y", t: "Loop Y", s: "partial", blockedBy: "x", area: "x"}]};
let fails = 0; const ok = (n, c, i) => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(i))); if (!c) fails++; };
(async () => {
  const tg = await lib.serveFixture({"items.json": items});
  const b = await puppeteer.launch({executablePath: lib.chrome(), headless: "new", args: ["--no-first-run"]});
  try {
    const p = await b.newPage(); const errs = []; p.on("pageerror", e => errs.push(String(e)));
    await p.goto(tg.base, {waitUntil: "networkidle0"}); await new Promise(r => setTimeout(r, 600));
    const btn = id => p.$eval("#f-" + id, e => e.textContent).catch(() => "");
    ok("by-you filter count", (await btn("byyou")).endsWith(" 3"), await btn("byyou"));
    ok("by-bot filter count", (await btn("bybot")).endsWith(" 1"), await btn("bybot"));
    await p.click("#f-byyou"); await new Promise(r => setTimeout(r, 300));
    const cards = await p.$$eval("#l .c[data-item]", cs => cs.map(c => c.dataset.item));
    ok("by-you lists A and B only", cards.sort().join() === "a,b,r", cards);
    const chain = await p.$eval("#card-a .track", e => e.textContent).catch(() => "");
    ok("chain chip on card A", chain.includes("Build A ← Build B ← your question"), chain);
    await p.click("#f-bybot"); await new Promise(r => setTimeout(r, 300));
    ok("bot chain", (await p.$eval("#card-d .track", e => e.textContent).catch(() => "")).includes("⏳ Blocked by bot work: Deploy D ← CI fix"));
    await p.click("#f-all").catch(() => {}); await p.evaluate(() => { const b = [...document.querySelectorAll(".st")].find(x => x.textContent.startsWith("All")); b && b.click(); }); await new Promise(r => setTimeout(r, 300));
    ok("title ref + future until = outside", (await p.$eval("#card-h .track", e => e.textContent).catch(() => "")).includes("🌐 Waiting on outside: Wait gate ← Gate"));
    ok("no page errors", !errs.length, errs);
  } finally { await b.close(); tg.stop(); }
  console.log(fails ? `FAIL: ${fails}` : "PASS: blocker-tracks e2e"); process.exit(fails ? 1 : 0);
})();
