// Post a short status line to the owner's Discord channel (restart notices, reports).
// Usage: bun scripts/notify-owner.ts "<text>" [--file <path>]   Channel: $OMP_NOTIFY_CHANNEL or #github-firstmate.
//        bun scripts/notify-owner.ts --delete <message id>     (removes one of the bot's own notices)
// Prints "posted <message id>" (restart-when-idle.sh deletes its "Restarting" post with it).
// The bot token is read from bot.env and never printed.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { holdAlert, readPause } from "../src/alertpause.ts";
import { DEV_CHANNEL_ID, FIRSTMATE_CHANNEL_ID } from "../src/config.ts";
const args = process.argv.slice(2);
const fi = args.indexOf("--file");
const file = fi >= 0 ? args.splice(fi, 2)[1] : undefined;
const di = args.indexOf("--delete");
const del = di >= 0 ? args.splice(di, 2)[1] : undefined;
const text = args.join(" ").trim();
if (!text && !file && !del) process.exit(0);
const env = readFileSync(`${process.env.HOME}/.config/omp-discord/bot.env`, "utf8");
const tok = env.match(/DISCORD_BOT_TOKEN=(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!tok) process.exit(1);
const channel = process.env.OMP_NOTIFY_CHANNEL || FIRSTMATE_CHANNEL_ID;
const headers: Record<string, string> = { Authorization: `Bot ${tok}` };
if (del) {
  if (!/^\d+$/.test(del)) process.exit(2);
  const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages/${del}`, { method: "DELETE", headers });
  console.log(r.ok ? "deleted" : `delete failed: ${r.status}`);
  process.exit(r.ok ? 0 : 1);
}
// Owner alert pause (src/alertpause.ts): #omp-alerts posts are held; the bot posts the digest when the pause ends.
if (channel === DEV_CHANNEL_ID && !file && readPause()) {
  holdAlert(text);
  console.log("held (owner alerts paused)");
  process.exit(0);
}
const payload = { content: text.slice(0, 1900), allowed_mentions: { parse: [] } };
let body: FormData | string;
if (file) {
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify(payload));
  fd.append("files[0]", new Blob([readFileSync(file)]), basename(file));
  body = fd;
} else {
  headers["content-type"] = "application/json";
  body = JSON.stringify(payload);
}
const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, { method: "POST", headers, body });
const json: unknown = r.ok ? await r.json().catch(() => null) : null;
const id = json && typeof json === "object" && "id" in json && typeof json.id === "string" ? json.id : undefined;
console.log(r.ok ? `posted${id ? ` ${id}` : ""}` : `post failed: ${r.status}`);
process.exit(r.ok ? 0 : 1);
