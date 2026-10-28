// Diagnose voice connect failures: join a voice channel with the radio bot token and log every state change.
// Usage: bun scripts/voice-probe.ts [channelId]   (default 📻 Lofi Radio). Never prints the token.
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { readFileSync } from "node:fs";
import { CONFIG } from "../src/config.ts";
const tok = readFileSync(`${process.env.HOME}/.config/omp-discord/radio.env`, "utf8").match(/RADIO_BOT_TOKEN=(.+)/)![1]!.trim();
const CH = process.argv[2] ?? CONFIG.radioChannelId;
const c = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
await c.login(tok);
await new Promise<void>((r) => c.once(Events.ClientReady, () => r()));
const ch = await c.channels.fetch(CH);
if (!ch?.isVoiceBased()) throw new Error("not voice");
const conn = joinVoiceChannel({ channelId: ch.id, guildId: ch.guild.id, adapterCreator: ch.guild.voiceAdapterCreator, selfDeaf: true, debug: true });
conn.on("stateChange", (o, n) => console.log("state", o.status, "->", n.status));
conn.on("debug", (m) => console.log("debug", m.replace(/"token":"[^"]+"/g, '"token":"***"').slice(0, 300)));
conn.on("error", (e) => console.log("error", e.message));
try {
  await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  console.log("READY");
} catch (e) {
  console.log("FAILED", (e as Error).message);
}
conn.destroy();
await c.destroy();
process.exit(0);
