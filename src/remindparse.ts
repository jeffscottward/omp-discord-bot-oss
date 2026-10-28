/**
 * Owner 2026-10-15: /remind takes one free-text field ("in 2 hours call mom", "tomorrow 9am pay rent").
 * The time is read locally with chrono-node (no model call; the text never leaves the main host).
 * Pure: parseReminder(text, now) → when + message, or an error to show the owner.
 */
import * as chrono from "chrono-node";

export const MAX_DAYS = 366;
/** A date without a time ("tomorrow", "friday") means 09:00 local. */
export const DEFAULT_HOUR = 9;

export type ParsedReminder = { ok: true; when: Date; message: string } | { ok: false; error: string };

const RELATIVE = /\b(in|after)\b|\d\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\b/i;

export function parseReminder(input: string, now = new Date()): ParsedReminder {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "Say when and what, e.g. `in 2 hours call mom` or `tomorrow 9am pay rent`." };
  const hit = chrono.parse(text, now, { forwardDate: true })[0];
  if (!hit) return { ok: false, error: "I found no time in that. Try `in 20 minutes …`, `at 5pm …` or `friday 10am …`." };
  // chrono can swallow a following word ("in 3 hours bot …" → "bot"); drop trailing words that do not change the time.
  let span = hit.text;
  for (;;) {
    const shorter = span.replace(/\s*\S+$/, "");
    if (!shorter || shorter === span) break;
    const again = chrono.parse(shorter, now, { forwardDate: true })[0];
    if (!again || again.index !== 0 || again.text !== shorter || again.start.date().getTime() !== hit.start.date().getTime()) break;
    span = shorter;
  }
  const when = hit.start.date();
  if (!hit.start.isCertain("hour") && !RELATIVE.test(span)) when.setHours(DEFAULT_HOUR, 0, 0, 0);
  if (when.getTime() <= now.getTime() + 30_000) return { ok: false, error: `That time (${hit.text}) is not in the future.` };
  if (when.getTime() - now.getTime() > MAX_DAYS * 86_400_000) return { ok: false, error: `That is more than ${MAX_DAYS} days away.` };
  const rest = `${text.slice(0, hit.index)} ${text.slice(hit.index + span.length)}`
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please\s+)?(remind\s+me|reminder|remember)\b[\s,:-]*/i, "")
    .replace(/^(to|that|about|of|for|on|at)\b\s*/i, "")
    .replace(/\s+(to|that|about|on|at)$/i, "")
    .replace(/^[\s,:;.-]+|[\s,:;-]+$/g, "")
    .trim();
  const message = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "Reminder";
  return { ok: true, when, message: message.slice(0, 200) };
}

/** systemd OnCalendar value in local time, second precision. */
export function onCalendar(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
