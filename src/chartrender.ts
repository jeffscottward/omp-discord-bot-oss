// Owner 2026-11-03 (card discord-charts): bot answers may carry chart and flow-chart blocks.
// ```chart  JSON {type: bar|line|pie|donut, title, labels[], series[{name, values[]}], unit?}
//           -> SVG written here, screenshot to PNG with local headless Chrome (no network).
// ```mermaid / ```flow  a flowchart/stateDiagram subset -> Graphviz DOT -> `dot -Tpng` (local).
// Each rendered block is replaced by one line `📈 Chart: <title>` (+ page link) and the PNG is attached.
// Limits: MAX_CHARTS images, CHARTS_DEADLINE_MS total. Any failure keeps the original block text.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_RE, chrome, TABLE_LINE_PREFIX, TABLES_BASE_URL, TABLES_DIR } from "./tablerender.ts";
import { redact } from "./redact.ts";
import { redactKnownSecrets } from "./secrets.ts";

export const CHART_LINE_PREFIX = "📈 Chart";
export const MAX_CHARTS = 4;
export const CHARTS_DEADLINE_MS = 45_000;

export type ChartKind = "chart" | "flow";
export interface ChartBlock {
  kind: ChartKind;
  /** Character range of the whole fenced block in the text. */
  start: number;
  end: number;
  source: string;
  title: string;
  spec?: ChartSpec;
  graph?: Graph;
}
export interface ChartSpec {
  type: "bar" | "line" | "pie" | "donut";
  title: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
}

/** Validate a chart JSON spec; null when it is not usable (the block then stays text). */
export function parseChartSpec(src: string): ChartSpec | null {
  let parsed: unknown;
  try { parsed = JSON.parse(src); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const j = parsed as { type?: unknown; title?: unknown; labels?: unknown; series?: unknown; unit?: unknown };
  if (typeof j.type !== "string" || !["bar", "line", "pie", "donut"].includes(j.type)) return null;
  if (!Array.isArray(j.labels) || !j.labels.length || j.labels.length > 60) return null;
  if (!Array.isArray(j.series) || !j.series.length || j.series.length > 8) return null;
  const labels = j.labels.map((l: unknown) => String(l));
  const series: ChartSpec["series"] = [];
  for (const s of j.series as unknown[]) {
    if (!s || typeof s !== "object") return null;
    const { name, values } = s as { name?: unknown; values?: unknown };
    if (!Array.isArray(values) || values.length !== labels.length) return null;
    if (!values.every((v: unknown) => typeof v === "number" && Number.isFinite(v))) return null;
    series.push({ name: String(name ?? ""), values: values as number[] });
  }
  if ((j.type === "pie" || j.type === "donut") && series[0]!.values.some((v) => v < 0)) return null;
  return { type: j.type as ChartSpec["type"], title: String(j.title ?? "Chart"), labels, series, unit: j.unit == null ? undefined : String(j.unit) };
}

// ---------- flow charts (mermaid subset) ----------
export interface GNode { id: string; label: string; shape: "box" | "round" | "diamond" | "circle" | "start" | "end" }
export interface Graph { dir: "TB" | "LR" | "BT" | "RL"; nodes: GNode[]; edges: { from: string; to: string; label: string; dashed: boolean }[]; title: string }

const NODE_RE = /^\s*([A-Za-z0-9_\-\u00C0-\uFFFF]+|\[\*\])\s*(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\[([^\]]*)\]\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?/u;
const EDGE_RE = /^\s*(?:--\s*([^->|]+?)\s*-->|(-\.->|==>|-->|---|->)(?:\s*\|([^|]*)\|)?)/;

/** Parse a mermaid flowchart / stateDiagram subset. Null when no edge or node parses. */
export function parseFlow(src: string): Graph | null {
  const lines = src.split("\n").map((l) => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  if (!lines.length) return null;
  let dir: Graph["dir"] = "TB";
  let title = "";
  let state = false;
  const head = lines[0]!.match(/^(graph|flowchart|stateDiagram(?:-v2)?)\b\s*(TD|TB|LR|RL|BT)?/i);
  if (head) {
    lines.shift();
    state = head[1]!.toLowerCase().startsWith("state");
    const d = (head[2] ?? "").toUpperCase();
    dir = d === "LR" || d === "RL" || d === "BT" ? (d as Graph["dir"]) : "TB";
  }
  const nodes = new Map<string, GNode>();
  const edges: Graph["edges"] = [];
  let starts = 0;
  for (const raw of lines) {
    const tm = raw.match(/^title\s*:?\s*(.+)$/i);
    if (tm) { title = tm[1]!.trim(); continue; }
    if (/^(classDef|class|style|linkStyle|click|subgraph|end|direction|note)\b/i.test(raw)) continue;
    let rest = raw;
    let stateLabel = "";
    if (state) { const c = rest.match(/^(.*?)\s*:\s*(.+)$/); if (c && /--?>/.test(c[1]!)) { rest = c[1]!; stateLabel = c[2]!; } }
    let prev: string | null = null;
    let pending: { label: string; dashed: boolean } | null = null;
    let side = 0;
    while (rest.trim()) {
      const n = rest.match(NODE_RE);
      if (!n || !n[1]) break;
      let id = n[1];
      const text = n[3] ?? n[4] ?? n[5] ?? n[6] ?? n[7] ?? n[8];
      let shape: GNode["shape"] = n[3] != null ? "circle" : n[4] != null || n[7] != null ? "round" : n[8] != null ? "diamond" : "box";
      if (id === "[*]") { id = side === 0 ? `__start${starts++}` : "__end"; shape = side === 0 ? "start" : "end"; }
      else if (state) shape = "round";
      const old = nodes.get(id);
      if (!old) nodes.set(id, { id, label: (text ?? id).replace(/^"|"$/g, ""), shape });
      else if (text != null) { old.label = text.replace(/^"|"$/g, ""); old.shape = shape; }
      if (prev && pending) edges.push({ from: prev, to: id, ...pending });
      prev = id;
      side++;
      rest = rest.slice(n[0].length);
      const e = rest.match(EDGE_RE);
      if (!e) break;
      pending = { label: (e[1] ?? e[3] ?? "").trim(), dashed: e[2] === "-.->" };
      rest = rest.slice(e[0].length);
    }
    if (stateLabel && edges.length) edges[edges.length - 1]!.label = stateLabel;
  }
  if (!edges.length) return null;
  return { dir, nodes: [...nodes.values()], edges, title: title || "Flow chart" };
}

const dq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** DOT source in the dark style. Only quoted IDs/labels: no file paths or images can enter. */
export function flowDot(g: Graph): string {
  const shape = (s: GNode["shape"]) => ({ box: "shape=box,style=\"rounded,filled\"", round: "shape=box,style=\"rounded,filled\"", diamond: "shape=diamond,style=filled", circle: "shape=circle,style=filled", start: "shape=circle,style=filled,fillcolor=\"#e6e6e6\",label=\"\",width=0.25", end: "shape=doublecircle,style=filled,fillcolor=\"#e6e6e6\",label=\"\",width=0.2" }[s]);
  const out = [
    "digraph G {",
    `  graph [bgcolor="#1e1f22",rankdir=${g.dir},pad=0.3,nodesep=0.4,ranksep=0.5,fontname="sans-serif",fontcolor="#dbdee1",labelloc=t,fontsize=18,label=${dq(g.title)}];`,
    '  node [fontname="sans-serif",fontsize=13,color="#5865f2",fillcolor="#2b2d31",fontcolor="#f2f3f5",penwidth=1.5,margin="0.2,0.1"];',
    '  edge [fontname="sans-serif",fontsize=11,color="#949ba4",fontcolor="#b5bac1",arrowsize=0.8];',
  ];
  for (const n of g.nodes) out.push(`  ${dq(n.id)} [${shape(n.shape)}${n.shape === "start" || n.shape === "end" ? "" : `,label=${dq(n.label)}`}];`);
  for (const e of g.edges) out.push(`  ${dq(e.from)} -> ${dq(e.to)} [${e.label ? `label=${dq(" " + e.label + " ")}` : ""}${e.dashed ? `${e.label ? "," : ""}style=dashed` : ""}];`);
  out.push("}");
  return out.join("\n");
}

// ---------- block finder ----------
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(chart|mermaid|flow)[ \t]*\r?\n([\s\S]*?)\r?\n\1\2[ \t]*\r?$/gim;

/** Find chart/mermaid/flow fenced blocks that parse. Bad blocks are skipped (they stay text). */
export function findCharts(text: string): ChartBlock[] {
  const out: ChartBlock[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const tag = m[3]!.toLowerCase();
    const source = m[4]!;
    const start = m.index!;
    const end = start + m[0].length;
    // A block inside another open fence (an example the bot shows as code) stays text.
    if ((text.slice(0, start).match(/^[ \t]*(?:`{3,}|~{3,})/gm) ?? []).length % 2 === 1) continue;
    if (tag === "chart") {
      const spec = parseChartSpec(source);
      if (spec) out.push({ kind: "chart", start, end, source, title: spec.title, spec });
    } else {
      const graph = parseFlow(source);
      if (graph) out.push({ kind: "flow", start, end, source, title: graph.title, graph });
    }
  }
  return out;
}

// ---------- SVG charts ----------
const PALETTE = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245", "#3ba55d", "#faa61a", "#00b0f4"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (v: number) => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`);

export const CHART_W = 760;
export const CHART_H = 460;

/** Self-written SVG for a chart spec (dark style). */
export function chartSvg(c: ChartSpec): string {
  const W = CHART_W, H = CHART_H;
  const parts: string[] = [];
  const unit = c.unit ? ` ${esc(c.unit)}` : "";
  parts.push(`<rect width="${W}" height="${H}" fill="#1e1f22"/>`);
  parts.push(`<text x="${W / 2}" y="30" text-anchor="middle" font-size="20" font-weight="600" fill="#f2f3f5">${esc(c.title)}</text>`);
  const legend = (names: string[], y: number) => {
    let x = 20;
    for (const [i, n] of names.entries()) {
      parts.push(`<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="${x + 18}" y="${y}" font-size="13" fill="#dbdee1">${esc(n)}</text>`);
      x += 30 + n.length * 7.5;
    }
  };
  if (c.type === "pie" || c.type === "donut") {
    const vals = c.series[0]!.values;
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = 230, cy = 250, r = 170, ir = c.type === "donut" ? 95 : 0;
    let a0 = -Math.PI / 2;
    for (const [i, v] of vals.entries()) {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const col = PALETTE[i % PALETTE.length];
      if (vals.filter((x) => x > 0).length === 1 && v > 0) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>`);
      else if (v > 0) parts.push(`<path d="M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${ir ? p(ir, a1) + ` A${ir},${ir} 0 ${large} 0 ${p(ir, a0)}` : `${cx},${cy}`} Z" fill="${col}" stroke="#1e1f22" stroke-width="2"/>`);
      a0 = a1;
    }
    if (ir) parts.push(`<circle cx="${cx}" cy="${cy}" r="${ir}" fill="#1e1f22"/><text x="${cx}" y="${cy + 7}" text-anchor="middle" font-size="20" fill="#f2f3f5">${fmt(total)}${unit}</text>`);
    for (const [i, l] of c.labels.slice(0, 16).entries()) {
      const y = 90 + i * 22;
      parts.push(`<rect x="440" y="${y - 11}" width="13" height="13" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="460" y="${y}" font-size="14" fill="#dbdee1">${esc(l)}: ${fmt(vals[i]!)}${unit} (${((vals[i]! / total) * 100).toFixed(1)}%)</text>`);
    }
  } else {
    const L = 70, R = W - 20, T = 70, B = H - 60;
    const all = c.series.flatMap((s) => s.values);
    let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    if (hi === lo) hi = lo + 1;
    const span = hi - lo;
    const step = 10 ** Math.floor(Math.log10(span / 5));
    const tick = [1, 2, 5, 10].map((k) => k * step).find((t) => span / t <= 6) ?? step * 10;
    lo = Math.floor(lo / tick) * tick; hi = Math.ceil(hi / tick) * tick;
    const y = (v: number) => B - ((v - lo) / (hi - lo)) * (B - T);
    for (let v = lo; v <= hi + tick / 2; v += tick) parts.push(`<line x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}" stroke="#3f4147"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#b5bac1">${fmt(v)}</text>`);
    if (c.unit) parts.push(`<text x="16" y="${T - 14}" font-size="12" fill="#b5bac1">${esc(c.unit)}</text>`);
    const n = c.labels.length;
    const band = (R - L) / n;
    const every = Math.ceil(n / 12);
    for (const [i, l] of c.labels.entries()) if (i % every === 0) parts.push(`<text x="${L + band * (i + 0.5)}" y="${B + 20}" text-anchor="middle" font-size="12" fill="#b5bac1">${esc(l.length > 14 ? l.slice(0, 13) + "…" : l)}</text>`);
    if (c.type === "bar") {
      const k = c.series.length;
      const bw = (band * 0.75) / k;
      for (const [si, s] of c.series.entries()) for (const [i, v] of s.values.entries()) {
        const x = L + band * i + band * 0.125 + bw * si;
        const y0 = y(Math.max(0, v)), h = Math.abs(y(v) - y(0));
        parts.push(`<rect x="${x}" y="${y0}" width="${Math.max(bw - 2, 1)}" height="${Math.max(h, 1)}" rx="2" fill="${PALETTE[si % PALETTE.length]}"/>`);
        if (n * k <= 16) parts.push(`<text x="${x + bw / 2}" y="${v >= 0 ? y0 - 5 : y0 + h + 14}" text-anchor="middle" font-size="11" fill="#dbdee1">${fmt(v)}</text>`);
      }
    } else {
      for (const [si, s] of c.series.entries()) {
        const pts = s.values.map((v, i) => `${L + band * (i + 0.5)},${y(v)}`);
        const col = PALETTE[si % PALETTE.length];
        parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="3" stroke-linejoin="round"/>`);
        if (n <= 30) for (const p of pts) { const [px, py] = p.split(","); parts.push(`<circle cx="${px}" cy="${py}" r="4" fill="${col}"/>`); }
      }
    }
    parts.push(`<line x1="${L}" x2="${R}" y1="${y(0)}" y2="${y(0)}" stroke="#80848e"/>`);
    if (c.series.length > 1 || c.series[0]!.name) legend(c.series.map((s) => s.name), H - 14);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">${parts.join("")}</svg>`;
}

// ---------- renderers ----------
async function run(cmd: string[], input: string, timeoutMs = 20_000): Promise<number> {
  const p = Bun.spawn(cmd, { stdin: new Blob([input]), stdout: "ignore", stderr: "ignore" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  try { return await p.exited; } finally { clearTimeout(t); }
}

export async function renderChartPng(b: ChartBlock, pngPath: string): Promise<void> {
  if (b.kind === "flow") {
    const code = await run([process.env.OMP_DOT ?? "dot", "-Tpng", "-Gdpi=144", `-o${pngPath}`], flowDot(b.graph!));
    if (code !== 0 || !existsSync(pngPath) || statSync(pngPath).size < 100) throw new Error(`dot failed (exit ${code})`);
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), "omp-chart-"));
  try {
    const src = join(tmp, "c.html");
    writeFileSync(src, `<!doctype html><html><body style="margin:0;background:#1e1f22">${chartSvg(b.spec!)}</body></html>`);
    const s = await chrome([`--user-data-dir=${join(tmp, "chrome")}`, "--force-device-scale-factor=2", `--window-size=${CHART_W},${CHART_H}`, `--screenshot=${pngPath}`, `file://${src}`], tmp);
    if (s.code !== 0 || !existsSync(pngPath) || statSync(pngPath).size < 100) throw new Error(`chrome screenshot failed (exit ${s.code})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function pageHtml(b: ChartBlock, created: Date): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.title)}</title>
<style>body{background:#1e1f22;color:#dbdee1;font-family:sans-serif;margin:16px}img{max-width:100%;border-radius:8px}pre{background:#2b2d31;padding:12px;border-radius:8px;overflow:auto}</style></head>
<body><h2>${esc(b.title)}</h2><img src="chart.png" alt="${esc(b.title)}"><h3>Source (${b.kind === "chart" ? "chart JSON" : "flow chart"})</h3><pre>${esc(b.source)}</pre><p><small>Created ${created.toISOString()}</small></p></body></html>`;
}

export interface RenderedCharts { text: string; files: { path: string; name: string }[]; tmpDirs: string[] }
export interface ChartOptions {
  dir?: string;
  baseUrl?: string;
  now?: Date;
  log?: (s: string) => void;
  render?: (b: ChartBlock, pngPath: string) => Promise<void>;
  deadlineMs?: number;
  max?: number;
}

const clean = (s: string) => redactKnownSecrets(redact(s).text).text;

/** Render chart blocks in `text` (max MAX_CHARTS). Failures and extra blocks keep their text. */
export async function renderCharts(text: string, opts: ChartOptions = {}): Promise<RenderedCharts> {
  if (process.env.OMP_CHARTS_RENDER === "0") return { text, files: [], tmpDirs: [] };
  const blocks = findCharts(text).slice(0, opts.max ?? MAX_CHARTS);
  if (!blocks.length) return { text, files: [], tmpDirs: [] };
  const dir = opts.dir ?? TABLES_DIR;
  const base = (opts.baseUrl ?? TABLES_BASE_URL).replace(/\/+$/, "");
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const render = opts.render ?? renderChartPng;
  const page = !ACCOUNT_RE.test(text);
  const end = Date.now() + (opts.deadlineMs ?? CHARTS_DEADLINE_MS);
  const files: RenderedCharts["files"] = [];
  const tmpDirs: string[] = [];
  const repl: (string | null)[] = [];
  for (const [k, raw] of blocks.entries()) {
    const b: ChartBlock = { ...raw, source: clean(raw.source), title: clean(raw.title) };
    if (b.spec) b.spec = { ...b.spec, title: clean(b.spec.title), labels: b.spec.labels.map(clean), series: b.spec.series.map((s) => ({ ...s, name: clean(s.name) })) };
    if (b.graph) b.graph = { ...b.graph, title: clean(b.graph.title), nodes: b.graph.nodes.map((n) => ({ ...n, label: clean(n.label) })), edges: b.graph.edges.map((e) => ({ ...e, label: clean(e.label) })) };
    const id = `${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`;
    const folder = page ? join(dir, id) : mkdtempSync(join(tmpdir(), "omp-chart-"));
    try {
      if (page) mkdirSync(folder, { recursive: true });
      else tmpDirs.push(folder);
      const png = join(folder, "chart.png");
      const left = end - Date.now();
      if (left <= 0) throw new Error("render deadline passed");
      const late = Promise.withResolvers<never>();
      const timer = setTimeout(() => late.reject(new Error("render deadline passed")), left);
      try { await Promise.race([render(b, png), late.promise]); } finally { clearTimeout(timer); }
      const t = b.title.replace(/[\n\[\]]/g, " ").slice(0, 120);
      if (page) {
        writeFileSync(join(folder, "index.html"), pageHtml(b, now));
        repl.push(`${CHART_LINE_PREFIX}: ${t} ([source ↗](<${base}/${id}/>))`);
      } else repl.push(`${CHART_LINE_PREFIX}: ${t}`);
      files.push({ path: png, name: blocks.length > 1 ? `chart-${k + 1}.png` : "chart.png" });
    } catch (e) {
      log(`chart render failed (block ${k + 1}, kept as text): ${(e as Error).message}`);
      try { rmSync(folder, { recursive: true, force: true }); } catch {}
      repl.push(null);
    }
  }
  let out = text;
  for (let i = blocks.length - 1; i >= 0; i--) if (repl[i] != null) out = out.slice(0, blocks[i]!.start) + repl[i] + out.slice(blocks[i]!.end);
  return { text: out, files, tmpDirs };
}

export function chartLineCount(content: string): number {
  return content.split("\n").filter((l) => l.startsWith(`${CHART_LINE_PREFIX}:`)).length;
}

/** Table and chart PNGs in the order of their 📊/📈 lines, so each rides on the message holding its line. */
export function orderImages<T>(text: string, tables: T[], charts: T[]): T[] {
  const t = [...tables], c = [...charts], out: T[] = [];
  for (const l of text.split("\n")) {
    if (l.startsWith(`${TABLE_LINE_PREFIX}:`) && t.length) out.push(t.shift()!);
    else if (l.startsWith(`${CHART_LINE_PREFIX}:`) && c.length) out.push(c.shift()!);
  }
  return [...out, ...t, ...c];
}

