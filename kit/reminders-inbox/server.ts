// Receives iOS Reminders from an iPhone Shortcut over Tailscale.
// Settings (~/.config/omp-discord/kit.env): REMINDERS_BIND (default 127.0.0.1; set your tailnet IP, `tailscale ip -4`,
// so the phone can reach it, and never a public address), REMINDERS_PORT (47830), REMINDERS_DIR (data folder).
// POST /reminders  body: plain text, one reminder per line  ->  $REMINDERS_DIR/latest.txt (+ dated copy)
// GET  /delete-queue  -> titles (one per line) the agent asked to delete on the phone. The Shortcut fetches this,
//                       deletes matching reminders on the iPhone, and the next POST /reminders clears every queued
//                       title that is no longer present (confirmed deleted).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
const queue = () => (existsSync(QUEUE) ? readFileSync(QUEUE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : []);
Bun.serve({
  hostname: process.env.REMINDERS_BIND || process.env.BIND || "127.0.0.1",
  port: Number(process.env.REMINDERS_PORT || 47830),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/delete-queue") return new Response(queue().join("\n"));
    if (req.method === "GET" && url.pathname === "/add-queue") return new Response(lines(ADDQ).join("\n"));
    if (req.method !== "POST" || url.pathname !== "/reminders") return new Response("not found", { status: 404 });
    const text = (await req.text()).slice(0, 500_000);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    save(`${DIR}/latest.txt`, text);
    save(`${DIR}/${stamp}.txt`, text);
    const titles = new Set(text.split("\n").map((l) => l.split(" | ")[0]?.trim()).filter(Boolean));
    const left = queue().filter((t) => titles.has(t));
    save(QUEUE, left.join("\n"));
    // Added on the phone -> no longer pending.
    save(ADDQ, lines(ADDQ).filter((l) => !titles.has(l.split(" | ")[0]!.trim())).join("\n"));
    return new Response(`ok ${titles.size} reminders, ${left.length} still queued for deletion\n`);
  },
});
console.log(`reminders-inbox listening on ${process.env.REMINDERS_BIND || process.env.BIND || "127.0.0.1"}:${process.env.REMINDERS_PORT || 47830}`);
