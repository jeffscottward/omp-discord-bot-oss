#!/usr/bin/env bun
/**
 * Agent-side rerun of the ⏸️/▶️ test-mode path (card pause-all-live-button-check): the same pauseall calls as
 * testMaintAction in main.ts, with the bot's allowlist file and test state file.
 *   bun scripts/pause-allowlist-rerun.ts pause|resume
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { allowlistFilter, pause, readTestAllowlist, resume, type Card } from "../src/pauseall.ts";

const run = promisify(execFile);
const wrap = (bin: string) => async (args: string[]) => {
  try {
    return { code: 0, out: String((await run(bin, args, { timeout: 20_000 })).stdout) };
  } catch {
    return { code: 1, out: "" };
  }
};
const herdr = wrap("herdr"), fm = wrap("fm");
const dir = `${process.env.HOME}/.local/share/omp-discord-bot`;
const stateFile = `${dir}/pause-test.json`;
const items = `${process.env.HOME}/Documents/reports/web/firstmate/items.json`;
const tracker = (): Card[] => JSON.parse(readFileSync(items, "utf8")).items;
if (process.argv[2] === "pause") {
  const allow = readTestAllowlist(`${dir}/pause-test-allowlist.json`);
  if (!allow) throw new Error("no valid allowlist");
  console.log(JSON.stringify(await pause({ reason: "live button test (allowlist rerun)", kind: "all", herdr, fm, tracker, stateFile, cards: allowlistFilter(allow), onlyPanes: allow.panes, verifyMs: 30_000 })));
} else console.log(JSON.stringify(await resume({ herdr, fm, stateFile, prompt: true })));
