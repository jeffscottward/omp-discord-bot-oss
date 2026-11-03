/**
 * Stop-sync (owner 2026-11-01, card dev-freeze-gate): when the owner presses ❌ Stop on a terminal job, the stop must
 * reach the card too. Before, Stop only sent Esc to the pane; the card stayed running with its `job`, so the master
 * queue and dashboard still showed it (webapp-autopilot). Now every unfinished card whose job names the pane (pane id,
 * or its tab id / tab label / code from running.json) gets `fm stop <id>`: partial "⏹️ Stopped: ...", job unlinked,
 * fm-spawn queue entries removed. Cards and running.json live on the main host, so only main-host panes are matched (Herdr ids are
 * per host). fm-autoclear R13 catches stops that come by other routes.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { FM_BIN, ITEMS_FILE, QUEUED_BY } from "./queued.ts";

const execFileAsync = promisify(execFile);

export type StopCard = { id?: string; s?: string; job?: unknown };
export type RunJob = { id?: string; tab?: string; tabLabel?: string };

/** Ids of unfinished cards whose job tag names `paneId` directly or through its running.json job record. */
export function cardsForPane(cards: StopCard[], jobs: RunJob[], paneId: string): string[] {
  // Review 2026-11-01: codes (WEBAPP, FILTER) and labels repeat across panes, so only the pane id, its tab id and a tab
  // label no other job uses may match; a code never does.
  const names = new Set([paneId.toLowerCase()]);
  const own = jobs.find((j) => j.id === paneId);
  if (own?.tab) names.add(own.tab.toLowerCase());
  const label = own?.tabLabel?.toLowerCase();
  if (label && jobs.filter((j) => j.tabLabel?.toLowerCase() === label).length === 1) names.add(label);
  return cards
    .filter((c) => {
      const tags = Array.isArray(c.job) ? c.job.map(String) : typeof c.job === "string" ? c.job.split(",") : [];
      return c.id && c.s !== "done" && tags.some((t) => names.has(t.trim().toLowerCase()));
    })
    .map((c) => c.id!);
}

/** Run `fm stop` for every card of the pane; returns the stopped card ids. Errors are logged, never thrown. */
export async function stopCardsForPane(paneId: string, reason: string, log: (s: string) => void = () => {}): Promise<string[]> {
  try {
    const cards = JSON.parse(readFileSync(ITEMS_FILE, "utf8"))?.items ?? [];
    let jobs: RunJob[] = [];
    try {
      jobs = JSON.parse(readFileSync(process.env.OMP_FM_RUNNING ?? join(dirname(ITEMS_FILE), "running.json"), "utf8"))?.jobs ?? [];
    } catch {
      /* no running.json: match the pane id only */
    }
    const ids = cardsForPane(Array.isArray(cards) ? cards : [], Array.isArray(jobs) ? jobs : [], paneId);
    const { FM_AUTO: _auto, ...base } = process.env;
    const done: string[] = [];
    for (const id of ids) {
      try {
        await execFileAsync(FM_BIN, ["stop", id, reason], { env: { ...base, FM_BY: QUEUED_BY }, timeout: 10_000 });
        done.push(id);
      } catch (e) {
        log(`stop-sync: fm stop ${id} failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    if (done.length) log(`stop-sync: pane ${paneId} -> cards stopped: ${done.join(", ")}`);
    return done;
  } catch (e) {
    log(`stop-sync: ${(e as Error).message}`);
    return [];
  }
}
