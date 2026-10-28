// Live check of a local-omp channel through the bot's handler path (owner 2026-10-19, card local-omp-followup).
// A bot-posted message never starts a run, so this builds the same LocalOmpChat the bot builds for that channel
// (config localOmpChannelIds, instanceFor), routes the prompt as an owner message, and posts the reply in the
// real channel through the Discord API. It uses the bot's state dir, so the channel's own session is used.
// Usage: bun scripts/local-omp-live.ts <channelId> "<prompt>"
import { discord, loadToken } from "../src/cleanup.ts";
import { CONFIG, OWNER_ID, STATE_DIR } from "../src/config.ts";
import { instanceFor, LocalOmpChat, routeMessage } from "../src/localomp.ts";

const [channelId = "", prompt = "Say hello."] = process.argv.slice(2);
const i = CONFIG.localOmpChannelIds.indexOf(channelId);
if (i < 0) throw new Error(`${channelId} is not in config localOmpChannelIds`);
if (routeMessage({ channelId, authorId: OWNER_ID, bot: false }, channelId, OWNER_ID) !== "local-omp") throw new Error("route check failed");
const token = loadToken();
const t0 = Date.now();
let final = "";
const chat = new LocalOmpChat({
  stateDir: STATE_DIR,
  ...instanceFor(i),
  tools: CONFIG.localOmpTools,
  log: console.error,
  send: async (content) => {
    const m = (await discord(token, `/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) })) as { id: string };
    final = content;
    return { edit: async (c) => { final = c; await discord(token, `/channels/${channelId}/messages/${m.id}`, { method: "PATCH", body: JSON.stringify({ content: c, allowed_mentions: { parse: [] } }) }); } };
  },
});
await chat.handle(prompt);
console.log(JSON.stringify({ channelId, instance: instanceFor(i), session: chat.sessionId(), seconds: Math.round((Date.now() - t0) / 1000) }));
console.log(final);
