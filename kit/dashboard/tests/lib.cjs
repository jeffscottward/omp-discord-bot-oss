// Shared helper for the FIRSTMATE dashboard browser tests (kit/dashboard/tests/*-e2e.cjs).
// Settings come from the environment (firstmate-tests reads ~/.config/omp-discord/kit.env and exports them):
//   PUPPETEER_CORE  require() path of puppeteer-core (default "puppeteer-core"; install: npm i -g puppeteer-core,
//                   or set an absolute path to an existing node_modules/puppeteer-core)
//   CHROME_BIN      Chrome/Chromium binary (default: the first that exists of the usual Linux/macOS paths)
//   BASE            live dashboard URL (…/firstmate/). Not set: serve a temp copy of the app with the fixtures.
//   FM_WEB_DIR      app files for the temp copy (default: kit/dashboard/web)
//   FM_FIXTURES     fixture data for the temp copy (default: kit/dashboard/fixtures)
const fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");

function puppeteer() {
  const want = process.env.PUPPETEER_CORE || "puppeteer-core";
  try {
    return require(want);
  } catch (e) {
    console.error(`cannot load puppeteer-core (${want}): set PUPPETEER_CORE in kit.env or run npm i -g puppeteer-core`);
    process.exit(3);
  }
}

function chrome() {
  const list = [process.env.CHROME_BIN, "/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  const exe = list.find((p) => fs.existsSync(p));
  if (!exe) { console.error("no Chrome/Chromium found: set CHROME_BIN in kit.env"); process.exit(3); }
  return exe;
}

const WEB = process.env.FM_WEB_DIR || path.join(__dirname, "..", "web");
const FIX = process.env.FM_FIXTURES || path.join(__dirname, "..", "fixtures");
const DOCS = path.join(__dirname, "..", "docs");

// Serve <tmp>/firstmate/ = app files + fixture data (+ docs) on a free loopback port. Live files are never changed.
async function serveFixture(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-e2e-")), d = path.join(dir, "firstmate");
  fs.mkdirSync(d);
  for (const f of fs.readdirSync(WEB)) if (/^[\w-]+\.(html|js|json|png)$/.test(f) && !/^(items|running|reports|changes|limits|idle)\.json$/.test(f)) fs.copyFileSync(path.join(WEB, f), path.join(d, f));
  if (fs.existsSync(DOCS)) for (const f of fs.readdirSync(DOCS)) fs.copyFileSync(path.join(DOCS, f), path.join(d, f));
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(d, f));
  for (const [name, data] of Object.entries(extra || {})) fs.writeFileSync(path.join(d, name), typeof data === "string" ? data : JSON.stringify(data));
  const port = 18790 + Math.floor(Math.random() * 500);
  const srv = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: dir, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { if ((await fetch(`http://127.0.0.1:${port}/firstmate/index.html`)).ok) break; } catch (e) { /* not up yet */ }
  }
  return { base: `http://127.0.0.1:${port}/firstmate/`, dir: d, live: false,
    stop: () => { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// BASE set: the live dashboard (read-only). Else: the fixture copy.
async function target(extra) {
  if (process.env.BASE) return { base: process.env.BASE.replace(/\/?$/, "/"), live: true, stop: () => {} };
  return serveFixture(extra);
}

module.exports = { puppeteer, chrome, serveFixture, target, WEB, FIX };
