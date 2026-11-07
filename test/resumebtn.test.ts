import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAINT_PREFIX } from "../src/maintpause.ts";
import { RESUME_PREFIX, RESUME_TEXT, pauseNotice, resumeDecision } from "../src/resumebtn.ts";

describe("▶️ Resume after Stop", () => {
  const jobs = new Map([["42", { msg: "m" }]]);
  test("owner tap on the bot message continues the same job with the continue text, not the original prompt", () => {
    const d = resumeDecision(jobs, `${RESUME_PREFIX}42`, "own", "own", true);
    expect(d).toEqual({ kind: "run", job: { msg: "m" }, text: RESUME_TEXT });
    expect(RESUME_TEXT).toBe("Continue where you stopped.");
  });
  test("non-owner or foreign message is denied", () => {
    expect(resumeDecision(jobs, `${RESUME_PREFIX}42`, "x", "own", true).kind).toBe("denied");
    expect(resumeDecision(jobs, `${RESUME_PREFIX}42`, "own", "own", false).kind).toBe("denied");
  });
  test("unknown job (bot restarted) is gone", () => {
    expect(resumeDecision(jobs, `${RESUME_PREFIX}7`, "own", "own", true).kind).toBe("gone");
  });
  test("Stopped row has Resume next to Undo, and the button is routed", () => {
    const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(src).toMatch(/setCustomId\(`\$\{RESUME_PREFIX\}\$\{id\}`\)[^\n]*Resume/);
    expect(src).toContain("setCustomId(`${UNDO_PREFIX}${id}`)");
    expect(src).toContain("i.customId.startsWith(RESUME_PREFIX)");
  });
});

describe("▶️ Resume on the pause notice", () => {
  test("button id is maint:resume, which the router sends to maintAction(i, \"resume\")", () => {
    const n = pauseNotice("upgrade");
    expect(n.button.customId).toBe(`${MAINT_PREFIX}resume`);
    expect(n.button.emoji).toBe("▶️");
    expect(n.content).toContain("⏸️ Paused: upgrade.");
    const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(src).toContain('maintAction(i, i.customId.slice(MAINT_PREFIX.length) === "resume" ? "resume" : "pause"');
    expect(src).toContain("pauseNotice(why)");
  });
});
