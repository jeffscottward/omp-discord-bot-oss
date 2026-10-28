// UI/function contract check (owner 2026-10-19): clicking a card ALWAYS opens a Discord message.
// Non-Discord targets (GitHub PR, report, other links) must appear as separate buttons, never as the card's own link.
// Read-only. Usage: node link-contract-e2e.cjs [url]
// Target: [url], else BASE (live dashboard), else a temp copy of the app with kit/dashboard/fixtures.
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const DISCORD = /^https:\/\/discord\.com\/channels\//;
(async () => {
  const tg = process.argv[2] ? { base: process.argv[2].replace(/\?.*$/, ""), stop: () => {} } : await lib.target();
  const URL = process.argv[2] || tg.base + "?tab=all";
  const b = await puppeteer.launch({ executablePath: lib.chrome(), headless: true, args: ["--no-sandbox", `--user-data-dir=/tmp/fm-contract-${process.pid}`] });
  const p = await b.newPage(); const errs = [];
  p.on("pageerror", e => errs.push(String(e)));
  await p.setViewport({ width: 390, height: 844 });
  await p.goto(URL, { waitUntil: "networkidle0" });
  await p.waitForSelector(".c", { timeout: 10000 });
  const r = await p.evaluate(() => {
    const cards = [...document.querySelectorAll(".c")];
    const bad = cards.filter(c => c.tagName === "A" && !/^https:\/\/discord\.com\/channels\//.test(c.getAttribute("href") || "")).map(c => c.dataset.item + " -> " + c.getAttribute("href"));
    const ghBtn = [...document.querySelectorAll(".c a.rep")].filter(a => /github\.com/.test(a.href)).length;
    return { cards: cards.length, links: cards.filter(c => c.tagName === "A").length, bad, ghBtn };
  });
  // Data side: every q/src that is not a Discord link is a contract break in items.json too.
  const items = (await (await fetch(tg.base + "items.json", { cache: "no-store" })).json()).items;
  const badData = items.filter(i => (i.q && !DISCORD.test(i.q)) || (i.src && !DISCORD.test(i.src))).map(i => i.id);
  await b.close(); tg.stop();
  const pass = r.cards > 0 && r.bad.length === 0 && errs.length === 0;
  console.log(JSON.stringify({ pass, ...r, badData, jsErrors: errs }, null, 1));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
