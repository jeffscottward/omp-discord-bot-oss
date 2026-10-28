// Owner 2026-10-23 (Discord UX item 4): the bridge posts a run's `omp -p` stdout, which holds only the FINAL
// answer. An ask block or `📎 attach:` line in an earlier answer of the same run (one that a review turn
// followed) never reached Discord, and the agent then wrote "Still waiting: the menu above". After a run,
// read the run's answers from its session log and re-post what the final answer does not carry.

import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { extractAsk } from "./ask.ts";

/** Session logs can be large; only the tail written by recent runs is read. */
const MAX_READ = 8 * 1024 * 1024;
const ATTACH_LINE = /^[ \t]*📎[ \t]*attach:[ \t]*`?([^`\n]+?)`?[ \t]*$/gm;
const ASK_FENCE = /^ {0,3}```ask[ \t]*\n[\s\S]*?\n {0,3}```[ \t]*$/m;

/** Newest .jsonl in a session dir, or null. */
export function newestSessionFile(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

/** The end of the log, read asynchronously (the bot's event loop keeps serving Discord meanwhile). */
async function tail(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, MAX_READ);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const s = buf.toString("utf8");
    return len < size ? s.slice(s.indexOf("\n") + 1) : s;
  } finally {
    await fh.close();
  }
}

/** Texts of the assistant answers that ended a turn (stopReason "stop") since `sinceMs`, oldest first. */
export async function runAnswers(file: string, sinceMs: number): Promise<string[]> {
  let raw: string;
  try {
    raw = await tail(file);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    // Cheap filter first: only end-of-turn assistant entries are parsed.
    if (!line.includes('"stopReason":"stop"') || !line.includes('"assistant"')) continue;
    let j: { type?: string; timestamp?: string; message?: { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] } };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const m = j.message;
    if (j.type !== "message" || m?.role !== "assistant" || m.stopReason !== "stop") continue;
    const ts = Date.parse(j.timestamp ?? "");
    if (!(ts >= sinceMs - 1000)) continue;
    const text = (m.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text!).join("\n").trim();
    if (text) out.push(text);
  }
  return out;
}

const attachPaths = (text: string): string[] => [...text.matchAll(ATTACH_LINE)].map((m) => m[1]!.trim());

/**
 * Text to post after the final answer: attach lines and the latest valid ask block from EARLIER answers of the
 * run that the final answer does not carry. Null when there is nothing to add. An ask block in the final
 * answer wins (the agent asked again); earlier blocks are then dropped.
 */
export function earlierExtras(answers: string[], finalText: string): { text: string; ask: boolean; files: number } | null {
  const final = finalText.trim();
  const earlier = answers.filter((a) => a.trim() !== final);
  if (!earlier.length) return null;
  const have = new Set(attachPaths(final));
  const files: string[] = [];
  for (const a of earlier) for (const p of attachPaths(a)) if (!have.has(p) && !files.includes(p)) files.push(p);
  let ask: string | null = null;
  if (!extractAsk(final).questions && !ASK_FENCE.test(final)) {
    for (const a of [...earlier].reverse()) {
      const r = extractAsk(a);
      if (r.questions) {
        ask = a.match(ASK_FENCE)![0];
        break;
      }
    }
  }
  if (!ask && !files.length) return null;
  const head = "↩️ From an earlier answer in this run (a review turn followed it, so it was not posted):";
  return { text: [head, ...files.slice(0, 10).map((p) => `📎 attach: ${p}`), ...(ask ? ["", ask] : [])].join("\n"), ask: !!ask, files: Math.min(files.length, 10) };
}

/** The final answer points the owner at a menu ("Still waiting", "menu above") but none is open or posted. */
export function claimsMissingMenu(finalText: string, menuOpen: boolean): boolean {
  if (menuOpen || ASK_FENCE.test(finalText)) return false;
  return /\b(?:menu|menus) (?:above|below)\b|\bstill waiting\b[^.\n]{0,100}\b(?:menu|pick|choice|answer)s?\b/i.test(finalText);
}
