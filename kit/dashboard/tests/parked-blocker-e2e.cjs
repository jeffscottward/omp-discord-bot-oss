// Headless check (card mainblocker-backlog, owner 2026-11-05): a backlog card is parked, so a card that names it in
// blockedBy shows a "🗃️ parked: <id>" chip and no blocker track; a backlog gate card ("Gate: …") still holds its
// cards (track "⏸️ Held by a gate card"). Fixture copy only.
const lib = require("./lib.cjs");
const puppeteer = lib.puppeteer();
const M = n => "https://discord.com/channels/1/2/" + n;
const items = {updated: "2026-11-05 12:00", items: [
  {id: "pk", t: "Parked kid", s: "backlog", area: "x"}, {id: "pp", t: "Parked parent", s: "partial", blockedBy: "pk", area: "x"},
  {id: "vg", t: "Gate: UI pause", s: "backlog", src: M(3), area: "x"}, {id: "vw", t: "UI wait", s: "partial", blockedBy: "vg", area: "x"},
  {id: "fg", t: "Field gate", gate: true, s: "backlog", area: "x"}, {id: "fw", t: "Field wait", s: "partial", blockedBy: "fg", area: "x"}]};
let fails = 0; const ok = (n, c, i) => { console.log((c ? "ok   " : "FAIL ") + n + (c ? "" : "  " + JSON.stringify(i))); if (!c) fails++; };
(async () => {
  const tg = await lib.serveFixture({"items.json": items});
  const b = await puppeteer.launch({executablePath: lib.chrome(), headless: "new", args: ["--no-first-run"]});
  try {
    const p = await b.newPage(); const errs = []; p.on("pageerror", e => errs.push(String(e)));
    await p.goto(tg.base + "?tab=all", {waitUntil: "networkidle0"}); await new Promise(r => setTimeout(r, 600));
    const text = id => p.$eval("#card-" + id, e => e.textContent).catch(() => "");
    const track = id => p.$eval("#card-" + id + " .track", e => e.textContent).catch(() => "");
    ok("parked blocker: chip says parked", (await text("pp")).includes("🗃️ parked: pk"), await text("pp"));
    ok("parked blocker: no track, no 'Blocked by'", !(await track("pp")) && !(await text("pp")).includes("Blocked by"), await text("pp"));
    ok("backlog gate (title) keeps its track", (await track("vw")).includes("⏸️ Held by a gate card: UI wait ← Gate: UI pause"), await track("vw"));
    ok("backlog gate (field) keeps its track", (await track("fw")).includes("⏸️ Held by a gate card: Field wait ← Field gate"), await track("fw"));
    ok("no page errors", !errs.length, errs);
  } finally { await b.close(); tg.stop(); }
  console.log(fails ? `FAIL: ${fails}` : "PASS: parked-blocker e2e"); process.exit(fails ? 1 : 0);
})();
