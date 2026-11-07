// add-queue.txt line check (card reminder-queue-date-guard, 2026-11-05).
// Each line is "<title> | <ISO date>", written only by src/rigcmds.ts remind() (`bun scripts/remind.ts "<when> <message>"`).
// The iPhone Shortcut turns the part after " | " into a date. One line without a date stopped the whole Shortcut run
// ("Shortcuts couldn't convert from Text to Date"), so GET /add-queue serves only valid lines.
// The served date format stays the one remind() writes (Date.toISOString(), e.g. 2026-11-06T14:00:00.000Z).
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** True when the line has a non-empty title, then " | ", then an ISO date with a time zone that parses. */
export function validAddLine(line: string): boolean {
  const i = line.lastIndexOf(" | ");
  if (i < 0) return false;
  const title = line.slice(0, i).trim();
  const due = line.slice(i + 3).trim();
  return title.length > 0 && ISO.test(due) && Number.isFinite(Date.parse(due));
}

/** Splits queue lines into lines the Shortcut can use and lines it cannot. */
export function splitAddQueue(lines: string[]): { ok: string[]; bad: string[] } {
  const ok: string[] = [], bad: string[] = [];
  for (const l of lines) (validAddLine(l) ? ok : bad).push(l);
  return { ok, bad };
}

/** Bad lines (deduplicated) that are not yet recorded in `alertedFile`. The caller logs and alerts for them. */
export function unseenRejects(alertedFile: string, bad: string[]): string[] {
  if (!bad.length) return [];
  const seen = new Set(existsSync(alertedFile) ? readFileSync(alertedFile, "utf8").split("\n").map((s) => s.trim()) : []);
  return [...new Set(bad)].filter((l) => !seen.has(l));
}

/** Records one bad line in `alertedFile` after its alert was sent, so it is alerted only once. */
export function recordReject(alertedFile: string, line: string): void {
  appendFileSync(alertedFile, `${line}\n`);
  chmodSync(alertedFile, 0o600);
}

/** Drops alerted entries that are no longer bad lines in the queue, so the file stays small and reused text alerts again. */
export function pruneAlerted(alertedFile: string, bad: string[]): void {
  if (!existsSync(alertedFile)) return;
  const all = readFileSync(alertedFile, "utf8").split("\n").filter(Boolean);
  const still = new Set(bad);
  const keep = all.filter((l) => still.has(l.trim()));
  if (keep.length === all.length) return;
  writeFileSync(alertedFile, keep.map((l) => `${l}\n`).join(""));
  chmodSync(alertedFile, 0o600);
}
