#!/usr/bin/env bun
// Owner 2026-10-23 (Discord UX item 2): ask the owner for a token without it passing through Discord or a model.
//   secret-drop --name "TaHoma token" --dest ~/.config/tahoma/token [--channel firstmate] [--overwrite] [--ttl-min 15] [--no-wait]
// The bot posts a 🔐 button with a one-time, tailnet-only form. The owner pastes the value on the phone; the
// bot writes it to --dest (mode 0600). This command prints only the state and the length, never the value.
import { homedir } from "node:os";

const PORT = Number(process.env.OMP_BOT_HTTP_PORT ?? 47821);
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = opt("--name");
const destRaw = opt("--dest");
if (!name || !destRaw || args.includes("--help") || args.includes("-h")) {
  console.log('usage: secret-drop --name "<label>" --dest <~/.config/... file> [--channel <name|id>] [--overwrite] [--ttl-min N] [--no-wait]');
  process.exit(name && destRaw ? 0 : 2);
}
const dest = destRaw.replace(/^~(?=\/)/, homedir());
const ttl = opt("--ttl-min");
const body = { name, dest, overwrite: args.includes("--overwrite"), ...(opt("--channel") ? { channel: opt("--channel") } : {}), ...(ttl ? { ttlMin: Number(ttl) } : {}) };
const r = await globalThis.fetch(`http://127.0.0.1:${PORT}/secret-drop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = (await r.json()) as { ok?: boolean; id?: string; expiresAt?: number; message?: string; error?: string };
if (!r.ok || !j.id) {
  console.error(`secret-drop: ${j.error ?? `HTTP ${r.status}`}`);
  process.exit(1);
}
console.log(`🔐 Button posted for "${name}" (${j.message ?? "Discord"}). Expires ${new Date(j.expiresAt!).toLocaleTimeString()}.`);
if (args.includes("--no-wait")) {
  console.log(`Check later: GET 127.0.0.1:${PORT}/secret-drop/${j.id}`);
  process.exit(0);
}
for (;;) {
  await Bun.sleep(3_000);
  const s = (await globalThis.fetch(`http://127.0.0.1:${PORT}/secret-drop/${j.id}`).then((x) => x.json()).catch(() => null)) as { state?: string; chars?: number } | null;
  if (s?.state === "received" && typeof s.chars === "number") {
    console.log(`✅ Received ${s.chars} characters → ${dest} (0600).`);
    process.exit(0);
  }
  if (!s || s.state !== "waiting") {
    console.error(!s ? "secret-drop: the bot no longer knows this drop (restart?)" : s.state === "expired" ? "⌛ Expired before the owner sent the value." : "❌ The value could not be saved (nothing written). Ask again.");
    process.exit(3);
  }
}
