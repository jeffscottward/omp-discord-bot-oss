import { afterAll, expect, test } from "bun:test";
import { startHttp } from "../src/http.ts";

// Card bot-post-job-channel: /post accepts a guild channel id that is not mirrored (same rule as /messages).
const GUILD_CH = "100000000000000307";
const sent: string[] = [];
const srv = startHttp({
  post: async (id) => {
    if (id !== GUILD_CH) throw new Error("channel not sendable"); // the dep's guild check
    sent.push(id);
  },
  health: () => ({}),
}, 0);
afterAll(() => srv.stop(true));
const post = (channel: string) =>
  globalThis.fetch(`http://127.0.0.1:${srv.port}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, text: "x" }) });

test("raw id of a guild channel that is not mirrored is posted", async () => {
  const r = await post(GUILD_CH);
  expect(r.status).toBe(200);
  expect(sent).toEqual([GUILD_CH]);
});
test("unknown id or name still gets 400", async () => {
  expect((await post("1111111111111111111")).status).toBe(400);
  expect((await post("no-such-channel")).status).toBe(400);
  expect(sent).toEqual([GUILD_CH]);
});
