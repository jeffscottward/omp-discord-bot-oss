// Daily digest (owner 2026-10-14): merge iOS reminders with the running to-do list and post
// overdue / due-soon items to the owner's Discord channel. Reads only local files.
// Settings (~/.config/omp-discord/kit.env): REMINDERS_DIR, REMINDERS_CHANNEL (channel id for the digest; empty =
// FM_CHANNEL when it is an id, else the default channel of scripts/notify-owner.ts), OMP_BOT_REPO (default: the repo that holds this file).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadKitEnv } from "./kitenv.ts";
loadKitEnv();
const HOME = process.env.HOME!;
const DIR = process.env.REMINDERS_DIR || `${HOME}/.local/share/reminders-inbox`;
const REPO = process.env.OMP_BOT_REPO || resolve(dirname(new URL(import.meta.url).pathname), "../..");
const latest = `${DIR}/latest.txt`;
const todo = `${DIR}/todo.md`; // running list kept by the agent
const now = Date.now();
const day = 86_400_000;
const seen = new Set<string>();
const overdue: string[] = [], soon: string[] = [];
if (existsSync(latest)) {
  for (const line of readFileSync(latest, "utf8").split("\n")) {
    const [title, due] = line.split(" | ").map((s) => s?.trim());
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const d = due?.replace(/^due:\s*/, "").replace(" at ", " ");
    const t = d ? Date.parse(d) : NaN;
    if (Number.isNaN(t)) continue;
    const label = `${title.slice(0, 90)} (${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
    if (t < now - day / 2) overdue.push(label);
    else if (t < now + 3 * day) soon.push(label);
  }
}
const open = existsSync(todo) ? readFileSync(todo, "utf8").split("\n").filter((l) => l.startsWith("- [ ]")).map((l) => l.slice(6)) : [];
const parts = ["📋 **Daily to-do check**"];
if (overdue.length) parts.push(`🔴 **Overdue (${overdue.length}):**\n${overdue.map((x) => `- ${x}`).join("\n")}`);
if (soon.length) parts.push(`🟡 **Due in the next 3 days:**\n${soon.map((x) => `- ${x}`).join("\n")}`);
if (open.length) parts.push(`🛠️ **Open project items (${open.length}):**\n${open.slice(0, 15).map((x) => `- ${x}`).join("\n")}`);
if (parts.length === 1) parts.push("✅ Nothing overdue or due soon.");
const msg = parts.join("\n\n").slice(0, 1900);
const channel = process.env.REMINDERS_CHANNEL || (/^\d+$/.test(process.env.FM_CHANNEL || "") ? process.env.FM_CHANNEL : "");
const env = { ...process.env, ...(channel ? { OMP_NOTIFY_CHANNEL: channel } : {}) };
if (process.argv.includes("--dry-run")) {
  console.log(msg);
  process.exit(0);
}
const r = Bun.spawnSync([process.execPath, `${REPO}/scripts/notify-owner.ts`, msg], { env });
console.log(r.stdout.toString().trim());
