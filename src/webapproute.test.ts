import { expect, test } from "bun:test";
import { ruleRoute, routeMessage, DEFAULT_STACKS } from "./router.ts";
const cfg = { stacks: DEFAULT_STACKS.map((s) => ({ ...s, channelIds: s.name === "finance" ? ["T"] : [] })), fallback: "firstmate", judgeMinConfidence: 0.7, judgeTimeoutMs: 100 } as any;
test("webapp word beats card area", () => { expect(ruleRoute("Why is the finance card webapp phases not in the webapp stack", { cardAreas: ["finance"] } as any, cfg).decision?.stack).toBe("webapp"); });
test("webapp beats financial tie", async () => { expect((await routeMessage("finance card webapp phases, buy 10 shares", {} as any, cfg)).stack).toBe("webapp"); });
test("webapp beats inherit and channel", () => { expect(ruleRoute("webapp portfolio url?", { inherited: "finance", channelId: "T" } as any, cfg).decision?.stack).toBe("webapp"); });
test("stack prefix still wins", () => { expect(ruleRoute("stack:finance webapp stuff", {} as any, cfg).decision?.stack).toBe("finance"); });
test("no webapp word unchanged", () => { expect(ruleRoute("newsletter copy trade", { inherited: "finance" } as any, cfg).decision?.stack).toBe("finance"); });
