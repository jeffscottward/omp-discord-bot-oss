import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartSvg, findCharts, flowDot, orderImages, parseChartSpec, parseFlow, renderChartPng, renderCharts } from "../src/chartrender.ts";

const BAR = '```chart\n{"type":"bar","title":"Sales","labels":["Q1","Q2"],"series":[{"name":"2026","values":[3,5]}],"unit":"k"}\n```';
const FLOW = "```mermaid\ngraph TD\n  A[Start] --> B{Check}\n  B -->|yes| C(Done)\n  B -- no --> A\n```";

describe("parser", () => {
  test("chart spec ok and bad", () => {
    expect(parseChartSpec('{"type":"pie","title":"x","labels":["a"],"series":[{"values":[1]}]}')?.type).toBe("pie");
    expect(parseChartSpec("{not json")).toBeNull();
    expect(parseChartSpec('{"type":"bar","labels":["a","b"],"series":[{"values":[1]}]}')).toBeNull();
    expect(parseChartSpec('{"type":"radar","labels":["a"],"series":[{"values":[1]}]}')).toBeNull();
  });
  test("mermaid flowchart", () => {
    const g = parseFlow("graph LR\nA[Start] --> B{Check}\nB -->|yes| C(Done)\nB -- no --> A\nC -.-> D")!;
    expect(g.dir).toBe("LR");
    expect(g.nodes.find((n) => n.id === "B")).toMatchObject({ label: "Check", shape: "diamond" });
    expect(g.edges).toContainEqual({ from: "B", to: "C", label: "yes", dashed: false });
    expect(g.edges).toContainEqual({ from: "B", to: "A", label: "no", dashed: false });
    expect(g.edges).toContainEqual({ from: "C", to: "D", label: "", dashed: true });
  });
  test("state diagram and chains", () => {
    const g = parseFlow("stateDiagram-v2\n[*] --> Idle\nIdle --> Run : start\nRun --> [*]")!;
    expect(g.edges.length).toBe(3);
    expect(g.edges[1]!.label).toBe("start");
    expect(parseFlow("A --> B --> C")!.edges.length).toBe(2);
    expect(parseFlow("just text")).toBeNull();
  });
  test("dot output quotes everything", () => {
    const dot = flowDot(parseFlow('graph TD\nA["x\\" image=/etc/passwd"] --> B')!);
    expect(dot).not.toMatch(/[^\\]" image=/);
  });
  test("findCharts: good blocks only", () => {
    const t = `hi\n${BAR}\n${FLOW}\n\`\`\`chart\n{bad\n\`\`\`\n`;
    expect(findCharts(t).map((b) => b.kind)).toEqual(["chart", "flow"]);
    expect(findCharts("````markdown\n" + FLOW + "\n````")).toEqual([]);
    expect(findCharts(BAR.replace(/\n/g, "\r\n")).length).toBe(1);
  });
  test("svg for each type", () => {
    for (const type of ["bar", "line", "pie", "donut"] as const) expect(chartSvg({ type, title: "T<", labels: ["a", "b"], series: [{ name: "s", values: [1, 2] }] })).toContain("T&lt;");
  });
});

describe("renderCharts", () => {
  test("replaces blocks, limit, bad JSON stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-ct-"));
    try {
      const bad = "```chart\n{nope\n```";
      const text = [BAR, FLOW, BAR, FLOW, BAR, bad].join("\n\n");
      const r = await renderCharts(text, { dir, baseUrl: "https://x/t", render: async (_b, p) => Bun.write(p, "png").then(() => {}) });
      expect(r.files.length).toBe(4);
      expect(r.text.match(/^📈 Chart: /gm)!.length).toBe(4);
      expect(r.text).toContain('"title":"Sales"'); // fifth chart stays text
      expect(r.text).toContain("{nope");
      expect(r.text).not.toContain("```mermaid");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("render failure keeps the text", async () => {
    const r = await renderCharts(BAR, { dir: mkdtempSync(join(tmpdir(), "omp-ct-")), render: async () => { throw new Error("x"); } });
    expect(r.text).toBe(BAR);
    expect(r.files).toEqual([]);
  });
  test("orderImages follows lines", () => {
    expect(orderImages("📈 Chart: a\n📊 Table: b\n📈 Chart: c", ["T"], ["C1", "C2"])).toEqual(["C1", "T", "C2"]);
  });
});

describe("real render", () => {
  test("bar chart via Chrome and flow via dot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-ct-"));
    try {
      // The CI runner has no Graphviz; the main host (where the bot runs) does.
      for (const [i, b] of findCharts(`${BAR}\n${FLOW}`).entries()) {
        if (b.kind === "flow" && !Bun.which("dot")) continue;
        const p = join(dir, `${i}.png`);
        await renderChartPng(b, p);
        expect(existsSync(p) && statSync(p).size > 1000).toBe(true);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
