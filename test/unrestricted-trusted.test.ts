import { describe, expect, test } from "bun:test";
import { DM_CWD, GUILD_ID, OWNER_ID } from "../src/config.ts";
import { unrestrictedRoute } from "../src/policy.ts";

// Owner 2026-10-19: the 🔓-unrestricted-qwen channel runs trusted turns (no sandbox), pinned to Qwen.
describe("unrestrictedRoute", () => {
  const ids = ["111"];
  const base = { authorId: OWNER_ID, authorIsBot: false, guildId: GUILD_ID, channelId: "111", isDM: false, isThread: false, parentId: null };
  test("owner in the channel: trusted turn in the channel itself, cwd ~/Github", () => {
    expect(unrestrictedRoute(base, ids)).toEqual({ kind: "thread", cwd: DM_CWD, channelName: "🔓-unrestricted-qwen" });
  });
  test("owner in a thread under the channel: same", () => {
    expect(unrestrictedRoute({ ...base, channelId: "t1", isThread: true, parentId: "111" }, ids)).toEqual({ kind: "thread", cwd: DM_CWD, channelName: "🔓-unrestricted-qwen" });
  });
  test("others and bots are ignored", () => {
    expect(unrestrictedRoute({ ...base, authorId: "999" }, ids)?.kind).toBe("ignore");
    expect(unrestrictedRoute({ ...base, authorIsBot: true }, ids)?.kind).toBe("ignore");
  });
  test("other channels, DMs and other guilds are not handled here", () => {
    expect(unrestrictedRoute({ ...base, channelId: "222" }, ids)).toBeNull();
    expect(unrestrictedRoute({ ...base, isDM: true, guildId: null }, ids)).toBeNull();
    expect(unrestrictedRoute({ ...base, guildId: "other" }, ids)).toBeNull();
  });
});
