#!/usr/bin/env bun
/**
 * Live check for card pause-all-unreliable, scoped to test cards so real sessions are not interrupted.
 *   bun scripts/pause-live-test.ts pause <card,card> [stateFile]   Esc their panes, set the cards paused, report
 *   bun scripts/pause-live-test.ts resume [stateFile]              cards back to running, continue prompt to panes
 *   bun scripts/pause-live-test.ts yield-dry "<owner text>"         bank yield plan only (no change, no order)
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { isFinanceInstruction, isFinanceCard, pause, pauseSummary, resume, type Card } from "../src/pauseall.ts";

const run = promisify(execFile);
const wrap = (bin: string) => async (args: string[]) => {
  try {
    return { code: 0, out: String((await run(bin, args, { timeout: 20_000 })).stdout) };
  } catch {
    return { code: 1, out: "" };
  }
};
const herdr = wrap("herdr"), fm = wrap("fm");
const items = process.env.OMP_FM_ITEMS ?? `${process.env.HOME}/Documents/reports/web/firstmate/items.json`;
const tracker = (): Card[] => JSON.parse(readFileSync(items, "utf8")).items;
const [cmd, a1, a2] = process.argv.slice(2);
const stateFile = (cmd === "pause" ? a2 : a1) ?? "/tmp/pause-test/state.json";
if (cmd === "pause") {
  const ids = new Set((a1 ?? "").split(","));
  const t0 = Date.now();
  const r = await pause({ reason: "live pause-all test", kind: "all", herdr, fm, tracker, stateFile, cards: (c) => ids.has(c.id ?? "") });
  console.log(JSON.stringify(r), `\n${pauseSummary(r)} in ${Math.round((Date.now() - t0) / 1000)} s`);
} else if (cmd === "resume") console.log(JSON.stringify(await resume({ herdr, fm, stateFile, prompt: true })));
else if (cmd === "yield-dry") {
  console.log("bank instruction:", isFinanceInstruction(a1 ?? ""));
  console.log(JSON.stringify(await pause({ reason: "yield", kind: "yield", herdr, fm, tracker, stateFile: "/tmp/pause-test/yield.json", cards: (c) => !isFinanceCard(c), dryRun: true })));
} else console.log("usage: pause <cards> | resume | yield-dry <text>");
