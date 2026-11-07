// Receives iOS Reminders from an iPhone Shortcut over Tailscale.
// Settings (~/.config/omp-discord/kit.env): REMINDERS_BIND (default 127.0.0.1; set your tailnet IP, `tailscale ip -4`,
// so the phone can reach it, and never a public address), REMINDERS_PORT (47830), REMINDERS_DIR (data folder).
// POST /reminders  body: plain text, one reminder per line  ->  $REMINDERS_DIR/latest.txt (+ dated copy)
// GET  /delete-queue  -> titles (one per line) the agent asked to delete on the phone. The Shortcut fetches this,
//                       deletes matching reminders on the iPhone, and the next POST /reminders clears every queued
//                       title that is no longer present (confirmed deleted).
// GET  /add-queue     -> "title | ISO date" lines the Shortcut creates on the phone. Only src/rigcmds.ts remind() writes
//                       add-queue.txt (agents: `bun scripts/remind.ts "<when> <message>"`; never edit the file by hand).
//                       Lines without a valid date are skipped (addqueue.ts) and alerted once (add-queue.alerted.txt).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { pruneAlerted, recordReject, splitAddQueue, unseenRejects } from "./addqueue.ts";
import { loadKitEnv } from "./kitenv.ts";
loadKitEnv();
const DIR = process.env.REMINDERS_DIR || `${process.env.HOME}/.local/share/reminders-inbox`;
const QUEUE = `${DIR}/delete-queue.txt`;
const ADDQ = `${DIR}/add-queue.txt`; // "title | ISO due" lines the agent/bot wants created on the phone
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const save = (f: string, text: string) => {
  writeFileSync(f, text);
  chmodSync(f, 0o600);
};
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : []);
const REPO = process.env.OMP_BOT_REPO || resolve(import.meta.dir, "../.."); // for the alert (scripts/notify-owner.ts)
const ALERTED = `${DIR}/add-queue.alerted.txt`; // bad lines (no valid date) already alerted, one per line
// Card reminder-queue-date-guard: a line without a valid date stops the whole iPhone Shortcut run, so it is never served.
// A bad line stays in add-queue.txt (so its text is kept and someone can give it a date), and it is logged and sent to
// #omp-alerts; after the alert succeeds it is saved in add-queue.alerted.txt, so it is alerted once (a failed alert is
// tried again on the next read).
const alerting = new Set<string>();
const alert = async (line: string): Promise<boolean> => {
  const msg = `⚠️ Reminders add-queue: skipped a line with no valid date, so the iPhone Shortcut does not fail: "${line.slice(0, 80)}". Add reminders only with \`bun scripts/remind.ts "<when> <message>"\`; never edit add-queue.txt by hand. Give the line a date or remove it.`;
  try {
    return (await Bun.spawn([process.execPath, `${REPO}/scripts/notify-owner.ts`, "--alerts", msg], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    return false;
  }
};
const addQueue = (snap = lines(ADDQ)) => {
  const { ok, bad } = splitAddQueue(snap);
  pruneAlerted(ALERTED, bad);
  for (const l of unseenRejects(ALERTED, bad)) {
    if (alerting.has(l)) continue;
    console.error(`add-queue: skipped line without a valid date: ${JSON.stringify(l)}`);
    if (process.env.REMINDERS_NO_ALERT === "1") {
      recordReject(ALERTED, l);
      continue;
    }
    alerting.add(l);
    void alert(l).then((sent) => {
      if (sent) recordReject(ALERTED, l);
      else console.error("add-queue: alert failed; will try again on the next read");
      alerting.delete(l);
    });
  }
  return ok;
};
const queue = () => (existsSync(QUEUE) ? readFileSync(QUEUE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : []);
const server = Bun.serve({
  hostname: process.env.REMINDERS_BIND || process.env.BIND || "127.0.0.1",
  port: Number(process.env.REMINDERS_PORT || 47830),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/delete-queue") return new Response(queue().join("\n"));
    if (req.method === "GET" && url.pathname === "/add-queue") return new Response(addQueue().join("\n"));
    if (req.method !== "POST" || url.pathname !== "/reminders") return new Response("not found", { status: 404 });
    const text = (await req.text()).slice(0, 500_000);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    save(`${DIR}/latest.txt`, text);
    save(`${DIR}/${stamp}.txt`, text);
    const titles = new Set(text.split("\n").map((l) => l.split(" | ")[0]?.trim()).filter(Boolean));
    const left = queue().filter((t) => titles.has(t));
    save(QUEUE, left.join("\n"));
    // Added on the phone -> no longer pending.
    const snap = lines(ADDQ);
    const keep = snap.filter((l) => !titles.has(l.split(" | ")[0]!.trim()));
    const later = lines(ADDQ).slice(snap.length); // appended by remind() since the first read; keep them (a tiny race to save() remains)
    save(ADDQ, [...keep, ...later].map((l) => `${l}\n`).join("")); // trailing newline so later appends do not glue onto the last line
    return new Response(`ok ${titles.size} reminders, ${left.length} still queued for deletion\n`);
  },
});
// The bound port (REMINDERS_PORT=0 lets the kernel pick one); tests wait for this line.
console.log(`reminders-inbox listening on ${server.hostname}:${server.port}`);
