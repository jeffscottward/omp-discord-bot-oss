import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearPause, holdAlert, MAX_PAUSE_MS, restoreHeld, parseDuration, pauseLine, pauseTransition, readPause, resumeDigest, setPause, takeHeld } from "../src/alertpause.ts";
import { startHttp } from "../src/http.ts";
import { renderMaster } from "../src/masterqueue.ts";
import { renderNeedsYou } from "../src/needsyou.ts";

const dir = mkdtempSync("/tmp/alertpause-");
const pf = join(dir, "alerts-pause.json");
const hf = join(dir, "alerts-held.jsonl");
const T = 1_800_000_000_000;

describe("pause state file", () => {
  test("no file, bad JSON or an expired pause read as not paused", () => {
    expect(readPause(T, pf)).toBeNull();
    writeFileSync(pf, "{bad");
    expect(readPause(T, pf)).toBeNull();
    writeFileSync(pf, JSON.stringify({ until: T - 1, setAt: T - 10 }));
    expect(readPause(T, pf)).toBeNull();
  });
  test("set, read, expire, clear", () => {
    const p = setPause(2 * 3600_000, "travel", "test", T, pf);
    expect(readPause(T + 1000, pf)).toEqual(p);
    expect(readPause(p.until, pf)).toBeNull(); // expiry: the pause ends by itself
    expect(clearPause(pf)).toBe(true);
    expect(clearPause(pf)).toBe(false);
  });
  test("every pause has a limit: 1 min … 7 days, and a hand-edited longer file is capped", () => {
    expect(() => setPause(10_000, "", "t", T, pf)).toThrow();
    expect(() => setPause(MAX_PAUSE_MS + 1, "", "t", T, pf)).toThrow();
    writeFileSync(pf, JSON.stringify({ until: T + 30 * 86_400_000, setAt: T }));
    expect(readPause(T, pf)!.until).toBe(T + MAX_PAUSE_MS);
    clearPause(pf);
  });
  test("durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("90")).toBe(5_400_000);
    expect(parseDuration("soon")).toBeNull();
  });
  test("transitions: paused → changed → resumed", () => {
    expect(pauseTransition(0, T, pf)).toEqual({ until: 0, event: null });
    setPause(3600_000, "", "t", T, pf);
    const a = pauseTransition(0, T, pf);
    expect(a.event).toBe("paused");
    setPause(7200_000, "", "t", T, pf);
    expect(pauseTransition(a.until, T, pf).event).toBe("changed");
    clearPause(pf);
    expect(pauseTransition(a.until, T, pf).event).toBe("resumed");
  });
});

describe("held alerts", () => {
  test("held alerts come back once, in order, in one digest", () => {
    holdAlert("⚠️ mirror check failed\nline 2", T, hf);
    holdAlert("⚠️ GPU wedge", T + 60_000, hf);
    const { held, saved } = takeHeld(T + 120_000, hf);
    expect(held.map((h) => h.text)).toEqual(["⚠️ mirror check failed\nline 2", "⚠️ GPU wedge"]);
    expect(existsSync(hf)).toBe(false);
    expect(readFileSync(saved!, "utf8")).toContain("GPU wedge"); // kept as the record
    expect(takeHeld(T, hf)).toEqual({ held: [], saved: null });
    const d = resumeDigest(held, saved);
    expect(d).toStartWith("🔔 **Owner alerts resumed.** 2 alerts were held");
    expect(d).toContain("mirror check failed line 2");
    expect(resumeDigest([], null)).toContain("No alerts were held");
  });
  test("a failed digest post puts the alerts back in front of newer ones (review: digest must never be lost)", () => {
    holdAlert("old 1", T, hf);
    const { saved } = takeHeld(T + 1, hf);
    holdAlert("new during retry", T + 2, hf);
    restoreHeld(saved!, hf);
    expect(existsSync(saved!)).toBe(false);
    expect(takeHeld(T + 3, hf).held.map((h) => h.text)).toEqual(["old 1", "new during retry"]);
  });
  test("a long digest stays under the Discord limit and names the rest", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ts: T + i, text: `alert ${i} ${"x".repeat(100)}` }));
    const d = resumeDigest(many, "/tmp/x.jsonl");
    expect(d.length).toBeLessThanOrEqual(1900);
    expect(d).toMatch(/➕ \d+ more in `\/tmp\/x\.jsonl`/);
  });
});

describe("boards show the pause", () => {
  const p = { until: T + 3600_000, reason: "meeting", setAt: T, by: "t" };
  const line = pauseLine(p);
  test("line text", () => {
    expect(line).toContain("🔕 **Owner alerts paused**");
    expect(line).toContain("meeting");
    expect(pauseLine(null)).toBe("");
  });
  test("master queue and Needs-you boards carry the line below the head", () => {
    expect(renderMaster([], T, "", 1900, "⚙️", line).split("\n")[2]).toBe(line);
    expect(renderNeedsYou([], T, "", 1900, [], line).split("\n")[2]).toBe(line);
    expect(renderMaster([], T, "")).not.toContain("🔕");
    expect(renderNeedsYou([], T, "")).not.toContain("🔕");
  });
});

describe("POST /post while paused", () => {
  const sent: string[] = [];
  let paused = true;
  const srv = startHttp(
    {
      post: async (_id, text) => void sent.push(text),
      health: () => ({}),
      holdAlert: (_id, text) => (paused && !text.includes("other") ? { until: 42 } : null),
    },
    0,
  );
  const post = (body: unknown) => globalThis.fetch(`http://127.0.0.1:${srv.port}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  test("a held post is not sent and says held", async () => {
    const r = await post({ channel: "omp-alerts", text: "⚠️ alert" });
    expect(await r.json()).toMatchObject({ ok: true, held: true, until: 42 });
    expect(sent).toEqual([]);
  });
  test("urgent posts (sign-in waits) go out while paused", async () => {
    const r = await post({ channel: "omp-alerts", text: "🔐 enter the password", urgent: true });
    expect(r.status).toBe(200);
    expect(sent).toEqual(["🔐 enter the password"]);
  });
  test("only plain text is held: an ask menu is sent as before (review: no silent drops)", async () => {
    const ask = "Pick one\n```ask\n" + JSON.stringify({ questions: [{ id: "q1", question: "Go?", options: ["Yes", "No", "✏️ Other (type or dictate a reply)"] }] }) + "\n```";
    const r = await post({ channel: "omp-alerts", text: ask });
    expect(r.status).toBe(200);
    expect(await r.json()).not.toHaveProperty("held");
    expect(sent.at(-1)).toBe(ask);
  });
  test("urgent must be a boolean; not paused sends normally", async () => {
    expect((await post({ channel: "omp-alerts", text: "x", urgent: "yes" })).status).toBe(400);
    paused = false;
    await post({ channel: "omp-alerts", text: "after" });
    expect(sent.at(-1)).toBe("after");
    srv.stop(true);
  });
});
