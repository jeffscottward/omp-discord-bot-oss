// Owner 2026-10-18: the dashboard link under each reply opens the named card, else the cards changed in the run.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DASHBOARD_URL, dashboardLine, dashboardUrl, firstItemId } from "../src/dashlink.ts";

const START = 1792369000123;

describe("reply dashboard deep link", () => {
  test("a ⚓ item:<id> token links to that card", () => {
    expect(dashboardUrl("Done. ⚓ item:reply-dashboard-link", START)).toBe(`${DASHBOARD_URL}?item=reply-dashboard-link`);
    expect(dashboardUrl("Updated (⚓ item: `tracker-auto-clear`).", START)).toBe(`${DASHBOARD_URL}?item=tracker-auto-clear`);
  });

  test("a dashboard item link in the reply links to that card", () => {
    expect(dashboardUrl(`See <${DASHBOARD_URL}?item=voice-mode-question-style> for details.`, START)).toBe(`${DASHBOARD_URL}?item=voice-mode-question-style`);
    expect(dashboardUrl(`[card](${DASHBOARD_URL}?tab=all&item=file-2023-2025-tax-returns)`, START)).toBe(`${DASHBOARD_URL}?item=file-2023-2025-tax-returns`);
  });

  test("several cards: the first one in the text wins", () => {
    const text = `First ⚓ item:alpha-1, then ${DASHBOARD_URL}?item=beta-2 and ⚓ item:gamma-3.`;
    expect(firstItemId(text)).toBe("alpha-1");
    expect(firstItemId(`Link ${DASHBOARD_URL}?item=beta-2 before ⚓ item:alpha-1`)).toBe("beta-2");
  });

  test("no card named: since=<run start epoch ms>", () => {
    expect(dashboardUrl("All done, nothing else to report.", START)).toBe(`${DASHBOARD_URL}?since=${START}`);
    // Other report links are not card links.
    expect(dashboardUrl("Report: https://dashboard.example.ts.net/reports/long-options/?item=x", START)).toBe(`${DASHBOARD_URL}?since=${START}`);
  });

  test("no card and no run start: the plain dashboard link", () => {
    expect(dashboardUrl("notice", undefined)).toBe(DASHBOARD_URL);
  });

  test("the line keeps Discord's no-embed link form", () => {
    expect(dashboardLine("⚓ item:abc", START, undefined, "/nonexistent.json")).toBe(`⚓ [Card: abc ↗](<${DASHBOARD_URL}?item=abc>)`);
    expect(dashboardLine("ok", START)).toBe(`⚓ [Cards changed in this reply ↗](<${DASHBOARD_URL}?since=${START}>)`);
  });

  test("run replies pass the run start into sendText (normal, late-audio, timeout, auto-continue, cyber reset, failure)", () => {
    const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const done = src.slice(src.indexOf("onDone: async (res, err)"), src.indexOf("jobKeys.set(id, target.id);"));
    // The success path has one sendText call; with late audio it gets audio=undefined and the link ends the text.
    expect(done).toContain('typeof ready === "string" && ready !== "late" ? ready : undefined, audioName(text), [], startedAt, fmRun, undefined, res.model ?? models.defaultModel());');
    expect(done.match(/sendText\(/g)?.length).toBe(5);
    expect(done.match(/\[\], startedAt, fmRun/g)?.length).toBe(5);
    expect(src).toContain("const dashLine = noDash ? \"\" : dashboardLine(text, runStartMs, runId);");
  });
});

test("since link carries the run id as by=run:<id> (fm-autoclear edits stay out of the reply view)", () => {
  expect(dashboardUrl("plain reply", 1792366394000, "a1b2c3d4e5f6")).toBe(`${DASHBOARD_URL}?since=1792366394000&by=run:a1b2c3d4e5f6`);
  expect(dashboardUrl("plain reply", 1792366394000, "../evil")).toBe(`${DASHBOARD_URL}?since=1792366394000`);
  expect(dashboardUrl("plain reply", 1792366394000)).toBe(`${DASHBOARD_URL}?since=1792366394000`);
});

import { writeFileSync } from "node:fs";
test("card title labels the deep link", () => {
  const f = "/tmp/dashlink-items-test.json";
  writeFileSync(f, JSON.stringify({ items: [{ id: "abc", t: "File 2023 [and] 2025 returns" }] }));
  expect(dashboardLine("⚓ item:abc", 1, undefined, f).startsWith("⚓ [Card: File 2023 and 2025 returns ↗](<")).toBe(true);
});

import { stripTokens } from "../src/dashlink.ts";
test("hint tokens are removed from the visible text", () => {
  expect(stripTokens("Done.\n\n⚓ item:abc\n\nMore")).toBe("Done.\n\nMore");
  expect(stripTokens("x\n⚓ report:gs-neocloud-2026-10/")).toBe("x");
});
test("report token deep-links into the Reports tab", () => {
  expect(dashboardLine("⚓ report:gs-neocloud-2026-10/", 1)).toContain("?tab=reports&report=gs-neocloud-2026-10%2F");
});
