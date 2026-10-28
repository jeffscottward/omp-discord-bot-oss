import { expect, test } from "bun:test";
import { applyReroute, keywordScores, DEFAULT_STACKS } from "./router.ts";
import { writeFileSync, existsSync } from "node:fs";
test("reroute", () => { const f = "/tmp/rr-x.json"; writeFileSync(f, JSON.stringify({ stack: "infra", ids: ["1"] })); const st = { threads: {}, msgs: { "1": { stack: "kb", at: 5 } } } as any; expect(applyReroute(f, st)).toBe(1); expect(st.msgs["1"]).toEqual({ stack: "infra", at: 5 }); expect(existsSync(f)).toBe(false); });
test("player message prefers infra", () => { const s = keywordScores("We need to fix the video player in the Discord activity, like YouTube buttons", DEFAULT_STACKS); expect(s[0]!.stack).toBe("infra"); });
