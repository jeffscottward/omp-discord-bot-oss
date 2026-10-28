// Owner 2026-10-21 (card discord-table-render): Markdown tables are too narrow on the phone.
// Each GitHub-style table in outgoing bot text (bridge answers and /post, not copy posts) becomes
// a PNG (headless Chrome, dark theme) attached to the message, plus a mobile HTML page at
// <TABLES_BASE_URL>/<id>/ (filter box, sticky header, horizontal scroll). The table text is
// replaced by one line `📊 Table: <link>`. Tables inside code fences are included, except paste
// blocks (src/blocks.ts), which exist to be copied as text. If rendering fails, the original
// table text stays (src/tables.ts then turns it into a monospace block); nothing is dropped.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isPasteInfo } from "./blocks.ts";
import { redact } from "./redact.ts";
import { redactKnownSecrets } from "./secrets.ts";

export const TABLES_DIR = process.env.OMP_TABLES_DIR ?? join(homedir(), "Documents", "reports", "web", "tables");
export const TABLES_BASE_URL = (process.env.OMP_TABLES_BASE_URL ?? "https://my-host.example-tailnet.ts.net/reports/tables").replace(/\/+$/, "");
export const TABLE_LINE_PREFIX = "📊 Table";
/** Table pages older than this are deleted at render time. */
export const TABLE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** At most this many tables per text become images (Discord allows 10 files per message). */
export const MAX_TABLES = 6;
/** Total render time per message; tables not done by then stay as text (the answer still posts). */
export const TABLES_DEADLINE_MS = 45_000;
/** Rows drawn in the PNG; the HTML page always has every row. */
export const PNG_MAX_ROWS = 60;
/** Same pattern as the account-number rule in src/redact.ts. Text with account numbers gets no web page. */
const ACCOUNT_RE = /\b(?:DU|DF|U|F)\d{7,8}\b/;

export type Align = "left" | "center" | "right" | "";

export interface Table {
  /** First line (header row) and the line after the last body row, 0-based, in the input text. */
  start: number;
  end: number;
  header: string[];
  align: Align[];
  rows: string[][];
  /** Index of the opening fence line when the table is inside a code fence. */
  fenceOpen?: number;
}

// ---------- detection ----------

/** Split a table row into cells. Pipes inside `code` spans or escaped as \| do not split. */
export function splitRow(line: string): string[] | null {
  const cells: string[] = [];
  let cur = "";
  let pipes = 0;
  let i = 0;
  const s = line.trim();
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      const tick = "`".repeat(n);
      const close = s.indexOf(tick, i + n);
      if (close > -1) {
        cur += s.slice(i, close + n);
        i = close + n;
        continue;
      }
      cur += tick;
      i += n;
      continue;
    }
    if (ch === "|") {
      pipes++;
      cells.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);
  if (!pipes) return null;
  if (s.startsWith("|")) cells.shift();
  if (s.endsWith("|") && !s.endsWith("\\|") && cells.length) cells.pop();
  return cells.map((c) => c.trim());
}

const SEP_CELL = /^:?-+:?$/;

function parseSep(line: string): Align[] | null {
  if (!line.includes("|") || !/-/.test(line)) return null;
  const cells = splitRow(line);
  if (!cells || !cells.length || !cells.every((c) => SEP_CELL.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;

/** Find GitHub-style tables (header row + |---| separator, at least 2 columns), also inside code fences. */
export function findTables(text: string): Table[] {
  const lines = text.split("\n");
  const out: Table[] = [];
  const scan = (from: number, to: number, fenceOpen?: number) => {
    for (let i = from; i < to - 1; i++) {
      const header = splitRow(lines[i]!);
      if (!header || header.length < 2 || !lines[i]!.trim()) continue;
      const align = parseSep(lines[i + 1]!);
      if (!align || align.length !== header.length) continue;
      const rows: string[][] = [];
      let j = i + 2;
      while (j < to && lines[j]!.trim()) {
        const r = splitRow(lines[j]!);
        if (!r) break;
        rows.push(Array.from({ length: header.length }, (_, k) => r[k] ?? ""));
        j++;
      }
      out.push({ start: i, end: j, header, align, rows, ...(fenceOpen !== undefined ? { fenceOpen } : {}) });
      i = j - 1;
    }
  };
  let prose = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(FENCE_OPEN);
    if (!m) continue;
    const marker = m[1]!;
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j]!)) j++;
    if (j >= lines.length) break; // unclosed fence: leave the rest alone
    scan(prose, i);
    if (!isPasteInfo(m[2]!)) scan(i + 1, j, i);
    prose = j + 1;
    i = j;
  }
  if (prose < lines.length) {
    // Stop at an unclosed fence (its contents are not scanned).
    let end = lines.length;
    for (let k = prose; k < lines.length; k++) if (FENCE_OPEN.test(lines[k]!)) { end = k; break; }
    scan(prose, end);
  }
  return out;
}

/**
 * Replace tables with the given lines (null keeps the table). A table inside a code fence splits
 * the fence: code before it stays fenced, the replacement line goes outside, code after is fenced again.
 */
export function replaceTables(text: string, tables: Table[], repl: (string | null)[]): string {
  const lines = text.split("\n");
  const byStart = new Map<number, number>();
  tables.forEach((t, k) => { if (repl[k] != null) byStart.set(t.start, k); });
  if (!byStart.size) return text;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(FENCE_OPEN);
    if (m) {
      const marker = m[1]!;
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j]!)) j++;
      if (j >= lines.length) { out.push(...lines.slice(i)); break; }
      const inner = tables.map((t, k) => ({ t, k })).filter(({ t, k }) => t.fenceOpen === i && repl[k] != null);
      if (!inner.length) { out.push(...lines.slice(i, j + 1)); i = j; continue; }
      let code: string[] = [];
      const flush = () => {
        while (code.length && !code[0]!.trim()) code.shift();
        while (code.length && !code[code.length - 1]!.trim()) code.pop();
        if (code.length) out.push(lines[i]!, ...code, lines[j]!);
        code = [];
      };
      for (let k = i + 1; k < j; k++) {
        const hit = inner.find(({ t }) => t.start === k);
        if (hit) {
          flush();
          out.push(repl[hit.k]!);
          k = hit.t.end - 1;
        } else code.push(lines[k]!);
      }
      flush();
      i = j;
      continue;
    }
    const k = byStart.get(i);
    if (k !== undefined && tables[k]!.fenceOpen === undefined) {
      out.push(repl[k]!);
      i = tables[k]!.end - 1;
      continue;
    }
    out.push(lines[i]!);
  }
  return out.join("\n");
}

// ---------- HTML ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown in a cell: `code`, **bold**, *italic*, [text](https://…), bare https URLs. */
export function cellHtml(md: string): string {
  return md
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part.replace(/^`+|`+$/g, ""))}</code>`;
      let h = esc(part);
      h = h.replace(/\[([^\]]+)\]\((?:&lt;)?(https?:\/\/[^\s)&]+(?:&amp;[^\s)&]+)*)(?:&gt;)?\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`);
      h = h.replace(/(?<![">])(https?:\/\/[^\s<"]+[^\s<".,;:!?)])/g, (u) => `<a href="${u}">${u}</a>`);
      h = h.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a?: string, b?: string) => `<b>${a ?? b}</b>`);
      h = h.replace(/(?<![\w*])\*([^*\s][^*]*)\*(?!\w)/g, "<i>$1</i>");
      return h;
    })
    .join("");
}

function tableHtml(t: Table, maxRows = Infinity): string {
  // Cell hints for narrow screens: short cells stay on one line (class s), long text keeps a minimum width (class l).
  const attrs = (c: string, k: number) => {
    const cls = c.length <= 24 ? ' class="s"' : c.length > 40 ? ' class="l"' : "";
    return `${cls}${t.align[k] ? ` style="text-align:${t.align[k]}"` : ""}`;
  };
  const head = t.header.map((c, k) => `<th${attrs(c, k)}>${cellHtml(c)}</th>`).join("");
  const body = t.rows
    .slice(0, maxRows)
    .map((r) => `<tr>${r.map((c, k) => `<td${attrs(c, k)}>${cellHtml(c)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

const FONT = `"Noto Sans", "DejaVu Sans", system-ui, sans-serif, "Noto Color Emoji"`;

/** Image source: dark, Discord-like colors, cells wrap at 260px. */
/** Tables wider than this (CSS px) become stacked cards in the PNG, so the image stays readable at phone width. */
export const PNG_GRID_MAX_W = 430;
/** CSS width of the card layout (an iPhone is about 390 CSS px wide). */
export const PNG_CARD_W = 390;
/** Card layout: up to this many rows; the page has the rest. */
export const PNG_MAX_CARDS = 25;

/**
 * PNG source (owner 2026-10-21: the 1708 px wide PNG was unreadable on the phone).
 * "grid" = the normal table (narrow tables only); "cards" = one card per row at phone width,
 * first cell as the card title and "Header: value" lines for the other cells.
 */
export function pngHtml(t: Table, mode: "grid" | "cards" = "grid"): string {
  const max = mode === "cards" ? PNG_MAX_CARDS : PNG_MAX_ROWS;
  const more = t.rows.length > max ? `<p class="more">+${t.rows.length - max} more rows on the web page</p>` : "";
  const body =
    mode === "cards"
      ? t.rows
          .slice(0, max)
          .map((r) => {
            const lines = t.header
              .slice(1)
              .map((h, k) => (r[k + 1] ?? "").trim() ? `<div class="kv"><span class="k">${cellHtml(h)}</span> <span class="v">${cellHtml(r[k + 1] ?? "")}</span></div>` : "")
              .join("");
            return `<div class="card"><div class="t">${cellHtml(r[0] ?? "")}</div>${lines}</div>`;
          })
          .join("")
      : tableHtml(t, max);
  const w = mode === "cards" ? `display:block;width:${PNG_CARD_W}px` : "display:inline-block";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#1e1f22}
#w{${w};box-sizing:border-box;padding:12px;background:#1e1f22;color:#dbdee1;font:15px/1.4 ${FONT}}
table{border-collapse:collapse}
th,td{border:1px solid #3f4147;padding:6px 10px;text-align:left;vertical-align:top;max-width:260px;overflow-wrap:break-word}
th{background:#2b2d31;color:#f2f3f5;font-weight:700}
.s{white-space:nowrap}
tbody tr:nth-child(even) td{background:#26272b}
.card{background:#2b2d31;border:1px solid #3f4147;border-radius:8px;padding:9px 12px;margin:0 0 10px;overflow-wrap:break-word}
.card .t{font-weight:700;color:#f2f3f5;font-size:16px;margin:0 0 4px}
.kv{margin:2px 0}.k{color:#949ba4;font-weight:600}.k::after{content:":"}
code{font-family:"DejaVu Sans Mono",monospace;font-size:13px;background:#383a40;padding:0 4px;border-radius:3px}
a{color:#00a8fc;text-decoration:none}
.more{margin:8px 0 0;color:#949ba4;font-size:13px}
</style></head><body><div id="w">${body}${more}</div>
<script>const r=document.getElementById("w").getBoundingClientRect();document.title=JSON.stringify({w:Math.ceil(r.width),h:Math.ceil(r.height)})</script>
</body></html>`;
}

/** Web page: mobile layout, light/dark, filter box, sticky header, horizontal scroll. */
export function pageHtml(t: Table, created: Date): string {
  const title = `Table: ${t.header.join(" · ")}`.slice(0, 120);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--mut:#6b6f76;--line:#d9dbe0;--head:#f0f1f5;--alt:#f8f9fb;--link:#005fcc;--code:#eef0f3}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f22;--fg:#dbdee1;--mut:#949ba4;--line:#3f4147;--head:#2b2d31;--alt:#26272b;--link:#00a8fc;--code:#383a40}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 ${FONT}}
header{padding:10px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#q{flex:1;min-width:160px;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
#n{color:var(--mut);font-size:13px;white-space:nowrap}
#s{overflow:auto;max-height:calc(100vh - 64px);max-height:calc(100dvh - 64px);border-top:1px solid var(--line)}
table{border-collapse:separate;border-spacing:0;min-width:100%}
th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top;min-width:3.5em;max-width:340px;overflow-wrap:break-word}
th{position:sticky;top:0;background:var(--head);font-weight:700;z-index:1}
.s{white-space:nowrap}.l{min-width:14em}
tbody tr:nth-child(even) td{background:var(--alt)}
code{font-family:"DejaVu Sans Mono",monospace;font-size:13px;background:var(--code);padding:0 4px;border-radius:3px}
a{color:var(--link)}
footer{color:var(--mut);font-size:12px;padding:8px 12px}
</style></head><body>
<header><input id="q" type="search" placeholder="Filter rows…" aria-label="Filter rows" autocomplete="off"><span id="n"></span></header>
<div id="s">${tableHtml(t)}</div>
<footer>Posted by the OMP Discord bot, ${esc(created.toISOString().slice(0, 16).replace("T", " "))} UTC. Pages are deleted after 30 days.</footer>
<script>
const rows=[...document.querySelectorAll("tbody tr")],q=document.getElementById("q"),n=document.getElementById("n");
function f(){const v=q.value.trim().toLowerCase();let k=0;for(const r of rows){const ok=!v||r.textContent.toLowerCase().includes(v);r.hidden=!ok;if(ok)k++}n.textContent=k+" / "+rows.length+" rows"}
q.addEventListener("input",f);f();
</script>
</body></html>`;
}

// ---------- rendering ----------

const CHROME = process.env.OMP_TABLES_CHROME ?? "google-chrome-stable";

async function chrome(args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  // setsid: Chrome leads its own process group, so a timeout kills its child processes too.
  // Children can inherit stdout; without the group kill and the race below, the read could never end.
  const p = Bun.spawn(["setsid", CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); }
    timeout.reject(new Error(`chrome timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  try {
    return await Promise.race([(async () => ({ out: await new Response(p.stdout).text(), code: await p.exited }))(), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Render the table PNG (two Chrome passes: measure, then screenshot at the measured size). */
async function measure(src: string, prof: string, width: number): Promise<{ w: number; h: number }> {
  const m = await chrome([prof, `--window-size=${width},800`, "--dump-dom", `file://${src}`]);
  const title = m.out.match(/<title>([^<]*)<\/title>/)?.[1]?.replace(/&quot;/g, '"');
  if (m.code !== 0 || !title) throw new Error(`chrome measure failed (exit ${m.code})`);
  return JSON.parse(title) as { w: number; h: number };
}

/**
 * Render the table PNG. Tables that fit a phone: the grid at scale 3. Wide tables (> PNG_GRID_MAX_W CSS px):
 * stacked cards at phone width (PNG_CARD_W) and scale 3, so Discord on a phone shows readable text.
 */
export async function renderPng(t: Table, pngPath: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "omp-table-"));
  try {
    const src = join(tmp, "t.html");
    const prof = `--user-data-dir=${join(tmp, "chrome")}`;
    writeFileSync(src, pngHtml(t, "grid"));
    let size = await measure(src, prof, 1100);
    let scale = 3;
    if (size.w > PNG_GRID_MAX_W && t.header.length > 1) {
      writeFileSync(src, pngHtml(t, "cards"));
      size = await measure(src, prof, PNG_CARD_W + 40);
      scale = 3;
    }
    const w = Math.min(Math.max(size.w, 200), 2400);
    const h = Math.min(Math.max(size.h, 40), 12_000);
    const s = await chrome([prof, `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`, `--screenshot=${pngPath}`, `file://${src}`]);
    if (s.code !== 0 || !existsSync(pngPath) || statSync(pngPath).size < 100) throw new Error(`chrome screenshot failed (exit ${s.code})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Delete table folders older than maxAge. Errors are ignored (cleanup must not block a post). */
export function pruneTables(dir = TABLES_DIR, maxAgeMs = TABLE_MAX_AGE_MS, now = Date.now()): number {
  let n = 0;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) { rmSync(p, { recursive: true, force: true }); n++; }
    } catch {}
  }
  return n;
}

export interface RenderedTables {
  text: string;
  /** PNGs in the order of their `📊 Table` lines in `text`. */
  files: { path: string; name: string }[];
  /** Temp folders (image-only tables, outside the served dir); delete after sending. */
  tmpDirs?: string[];
}

export interface RenderOptions {
  dir?: string;
  baseUrl?: string;
  now?: Date;
  log?: (s: string) => void;
  render?: (t: Table, pngPath: string) => Promise<void>;
  /** Finance channel (owner 2026-10-21): PNG only, never a web page. */
  imageOnly?: boolean;
  /** Total time for all tables (default TABLES_DEADLINE_MS). Tables not done by then stay as text. */
  deadlineMs?: number;
}

function newId(now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Redact secrets in every cell before anything is written or drawn. */
function redactTable(t: Table): Table {
  const r = (s: string) => redactKnownSecrets(redact(s).text).text;
  return { ...t, header: t.header.map(r), rows: t.rows.map((row) => row.map(r)) };
}

/**
 * Render every table in `text` (max MAX_TABLES). Returns the text with each rendered table
 * replaced by a `📊 Table` line, and the PNGs to attach. A table that fails stays as text.
 */
export async function renderTables(text: string, opts: RenderOptions = {}): Promise<RenderedTables> {
  if (process.env.OMP_TABLES_RENDER === "0") return { text, files: [] };
  const tables = findTables(text).slice(0, MAX_TABLES);
  if (!tables.length) return { text, files: [] };
  const dir = opts.dir ?? TABLES_DIR;
  const base = (opts.baseUrl ?? TABLES_BASE_URL).replace(/\/+$/, "");
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const render = opts.render ?? renderPng;
  // Finance rule: text with account numbers gets images only, never a web page.
  const page = !opts.imageOnly && !ACCOUNT_RE.test(text);
  const why = opts.imageOnly ? "finance channel" : "the text has account data";
  try { pruneTables(dir, TABLE_MAX_AGE_MS, now.getTime()); } catch {}
  const end = Date.now() + (opts.deadlineMs ?? TABLES_DEADLINE_MS);
  const repl: (string | null)[] = [];
  const files: RenderedTables["files"] = [];
  const tmpDirs: string[] = [];
  for (const [k, raw] of tables.entries()) {
    const t = redactTable(raw);
    const id = newId(now);
    // Image-only tables never touch the served folder (owner 2026-10-21: no account data on report pages).
    const folder = page ? join(dir, id) : mkdtempSync(join(tmpdir(), "omp-table-"));
    try {
      if (page) mkdirSync(folder, { recursive: true });
      else tmpDirs.push(folder);
      const png = join(folder, "table.png");
      // A hung renderer must never hold back the answer: race it against the rest of the deadline.
      const left = end - Date.now();
      if (left <= 0) throw new Error("render deadline passed");
      const late = Promise.withResolvers<never>();
      const timer = setTimeout(() => late.reject(new Error(`render deadline passed (${opts.deadlineMs ?? TABLES_DEADLINE_MS} ms)`)), left);
      try {
        await Promise.race([render(t, png), late.promise]);
      } finally {
        clearTimeout(timer);
      }
      const rows = `${t.rows.length} row${t.rows.length === 1 ? "" : "s"}`;
      if (page) {
        writeFileSync(join(folder, "index.html"), pageHtml(t, now));
        repl.push(`${TABLE_LINE_PREFIX}: [full table, ${rows} ↗](<${base}/${id}/>)`);
      } else repl.push(`${TABLE_LINE_PREFIX}: image attached, ${rows} (no web page: ${why})`);
      files.push({ path: png, name: tables.length > 1 ? `table-${k + 1}.png` : "table.png" });
    } catch (e) {
      log(`table render failed (table ${k + 1}, kept as text): ${(e as Error).message}`);
      try { rmSync(folder, { recursive: true, force: true }); } catch {}
      repl.push(null);
    }
  }
  return { text: replaceTables(text, tables, repl), files, tmpDirs };
}

/** Number of `📊 Table` lines in a message (to attach each PNG to the message holding its line). */
export function tableLineCount(content: string): number {
  return content.split("\n").filter((l) => l.startsWith(`${TABLE_LINE_PREFIX}:`)).length;
}
