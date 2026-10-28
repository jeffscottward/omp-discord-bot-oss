// Owner 2026-10-23 (Discord UX item 4): ask blocks and attach lines from earlier answers of a run are posted.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimsMissingMenu, earlierExtras, newestSessionFile, runAnswers } from "../src/earlier.ts";

const ASK = '```ask\n{"questions":[{"id":"k","question":"Which kit?","options":["Zip","Repo"]}]}\n```';
const entry = (ts: string, text: string, stopReason = "stop") =>
  JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });

describe("runAnswers", () => {
  test("returns end-of-turn answers since the run start, oldest first", async () => {
    const dir = mkdtempSync("/tmp/earlier-");
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      [
        entry("2026-10-20T22:00:00.000Z", "old run answer"),
        entry("2026-10-20T22:10:00.000Z", "thinking", "toolUse"),
        JSON.stringify({ type: "message", timestamp: "2026-10-20T22:10:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
        entry("2026-10-20T22:10:05.000Z", `Pick one.\n\n${ASK}`),
        JSON.stringify({ type: "custom_message", customType: "advisor", content: "review" }),
        "not json",
        entry("2026-10-20T22:11:00.000Z", "Still waiting: the menu above."),
      ].join("\n"),
    );
    expect(await runAnswers(f, Date.parse("2026-10-20T22:09:00.000Z"))).toEqual([`Pick one.\n\n${ASK}`, "Still waiting: the menu above."]);
    expect(newestSessionFile(dir)).toBe(f);
    expect(await runAnswers(join(dir, "missing.jsonl"), 0)).toEqual([]);
  });
});

describe("earlierExtras", () => {
  test("re-posts the earlier ask block when the final answer has none", () => {
    const x = earlierExtras([`Pick one.\n\n${ASK}`, "Still waiting: the menu above."], "Still waiting: the menu above.")!;
    expect(x.ask).toBe(true);
    expect(x.text).toContain(ASK);
    expect(x.text).toContain("earlier answer in this run");
  });
  test("a final ask block wins; nothing to add", () => {
    expect(earlierExtras([`A\n\n${ASK}`, `B\n\n${ASK}`], `B\n\n${ASK}`)).toBeNull();
  });
  test("attach lines missing from the final answer are added once", () => {
    const x = earlierExtras(["Report\n📎 attach: ~/Documents/reports/a.pdf\n📎 attach: /tmp/b.png", "Done\n📎 attach: /tmp/b.png"], "Done\n📎 attach: /tmp/b.png")!;
    expect(x.files).toBe(1);
    expect(x.text).toContain("📎 attach: ~/Documents/reports/a.pdf");
    expect(x.text).not.toContain("/tmp/b.png");
  });
  test("a single-answer run adds nothing", () => {
    expect(earlierExtras(["only"], "only")).toBeNull();
    expect(earlierExtras([], "x")).toBeNull();
  });
  test("an invalid earlier ask block is not re-posted", () => {
    expect(earlierExtras(["```ask\n{bad}\n```", "final"], "final")).toBeNull();
  });
});

describe("claimsMissingMenu", () => {
  test("flags menu talk only when no menu is open", () => {
    expect(claimsMissingMenu("Still waiting: the menu above.", false)).toBe(true);
    expect(claimsMissingMenu("Still waiting on your pick for the kit.", false)).toBe(true);
    expect(claimsMissingMenu("Still waiting: the menu above.", true)).toBe(false);
    expect(claimsMissingMenu("Still waiting on the build to finish.", false)).toBe(false);
    expect(claimsMissingMenu(`Pick:\n${ASK}`, false)).toBe(false);
  });
});
