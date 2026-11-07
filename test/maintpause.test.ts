// Card omp-pause-button: the maintenance pause gate (queue starts nothing while paused.json exists; resumes after),
// the board line and the Pause/Resume button on the 📋 Master queue's last page.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maintButton, maintLine, readMaintPause } from "../src/maintpause.ts";
import { MasterQueueBoard } from "../src/masterqueue.ts";
import type { BoardChannel, BoardMsg } from "../src/needsyou.ts";
import { JobQueue } from "../src/queue.ts";

const flagFile = () => join(mkdtempSync(join(tmpdir(), "maint-")), "paused.json");

describe("readMaintPause / maintLine / maintButton", () => {
  test("no file: not paused; file: reason and since; broken file still counts as paused", () => {
    const f = flagFile();
    expect(readMaintPause(f)).toBeNull();
    expect(maintLine(null)).toBe("");
    writeFileSync(f, JSON.stringify({ since: "2026-10-30T21:00:00-04:00", reason: "kernel update" }));
    const p = readMaintPause(f)!;
    expect(p.reason).toBe("kernel update");
    expect(maintLine(p)).toStartWith("⏸️ **Paused**: kernel update (since <t:");
    writeFileSync(f, "{not json");
    expect(readMaintPause(f)?.reason).toBe("maintenance");
  });
  test("button flips between Pause and Resume", () => {
    expect(maintButton(false)).toEqual({ customId: "maint:pause", label: "Pause all", emoji: "⏸️" });
    expect(maintButton(true).customId).toBe("maint:resume");
  });
});

describe("JobQueue maintenance gate", () => {
  test("queued jobs wait while paused, running jobs finish, and the queue starts again after resume", async () => {
    const f = flagFile();
    const q = new JobQueue<string>(2, { paused: () => readMaintPause(f) !== null });
    const gate = Promise.withResolvers<void>();
    const doneA = Promise.withResolvers<void>();
    const doneB = Promise.withResolvers<void>();
    q.enqueue({ key: "a", label: "a", run: async () => (await gate.promise, "a"), onDone: () => doneA.resolve() });
    expect(q.status().running.map((j) => j.key)).toEqual(["a"]);

    writeFileSync(f, JSON.stringify({ since: new Date().toISOString(), reason: "test" }));
    q.enqueue({ key: "b", label: "b", run: async () => "b", onDone: () => doneB.resolve() });
    q.kick();
    expect(q.status().queued.map((j) => j.key)).toEqual(["b"]);
    gate.resolve();
    await doneA.promise; // the running job finishes during the pause
    expect(q.status().running.length).toBe(0);
    q.kick();
    expect(q.status().queued.map((j) => j.key)).toEqual(["b"]);

    rmSync(f);
    q.kick();
    expect(q.status().queued.length).toBe(0);
    await doneB.promise;
  });
});

describe("MasterQueueBoard pause button", () => {
  test("last page carries the button; a pause change reposts the board (no edit)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mq-maint-"));
    mkdirSync(join(dir, "receipts"));
    writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [] }));
    const list: (BoardMsg & { components?: unknown[] })[] = [];
    let n = 0;
    const ch: BoardChannel = {
      send: async (o) => {
        const m = { id: String(++n), content: o.content, components: o.components, author: { id: "bot" }, edit: async (e: { content: string; components?: unknown[] }) => void Object.assign(m, e), delete: async () => void (list.includes(m) && list.splice(list.indexOf(m), 1)) };
        list.unshift(m);
        return m;
      },
      messages: { fetch: async () => new Map(list.map((m) => [m.id, m])) },
    };
    let paused = false;
    const b = new MasterQueueBoard({
      getChannel: async () => ch,
      botId: () => "bot",
      jobs: () => [],
      mayBeBelow: () => false,
      notice: () => (paused ? maintLine({ since: "", reason: "test" }) : ""),
      components: () => [maintButton(paused)],
      itemsFile: join(dir, "items.json"),
      receiptsDir: join(dir, "receipts"),
      stateFile: join(dir, "mq.json"),
      dash: "",
      log: () => {},
    });
    await b.refresh();
    expect(list.length).toBe(1);
    expect(list[0]!.components).toEqual([maintButton(false)]);
    paused = true;
    await b.refresh();
    expect(list.length).toBe(1);
    expect(list[0]!.content).toContain("⏸️ **Paused**: test");
    expect(list[0]!.components).toEqual([maintButton(true)]);
  });
});

import { showMaintButton } from "../src/maintpause.ts";
import { test as t3, expect as e3 } from "bun:test";
t3("master-queue button: hidden when idle, shown for running card, bot job, or pause (owner 2026-11-01)", () => {
  const idle = { updated: 1, items: [{ id: "a", s: "done" }, { id: "b", s: "partial" }] };
  e3(showMaintButton(false, 0, idle)).toBe(false);
  e3(showMaintButton(false, 0, { updated: 1, items: [{ id: "c", s: "running", job: "wB:p1" }] })).toBe(true); // side job, empty bot queue
  e3(showMaintButton(false, 2, idle)).toBe(true);
  e3(showMaintButton(true, 0, idle)).toBe(true); // paused, nothing runs: Resume all stays
});
