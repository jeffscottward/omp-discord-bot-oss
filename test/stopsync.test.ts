// Stop-sync (card dev-freeze-gate): ❌ Stop on a pane finds the cards that job works on.
import { expect, test } from "bun:test";
import { cardsForPane } from "../src/stopsync.ts";

test("cards match by pane id, tab id or a unique tab label; never by code; done cards and other panes are skipped", () => {
  const jobs = [
    { id: "wB:p13E", tab: "wB:tQW", tabLabel: "🤖 webapp autopilot", code: "WEBAPP" },
    { id: "wB:p12Y", tab: "wB:tQ1", tabLabel: "dup", code: "WEBAPP" },
    { id: "wB:p1", tab: "wB:tQ2", tabLabel: "dup" },
  ];
  const cards = [
    { id: "a", s: "running", job: "wB:p13E" },
    { id: "b", s: "running", job: "🤖 Webapp Autopilot" },
    { id: "c", s: "partial", job: ["x", "wB:tQW"] },
    { id: "d", s: "running", job: "WEBAPP" },
    { id: "e", s: "done", job: "wB:p13E" },
    { id: "f", s: "running", job: "dup" },
    { id: "g", s: "running" },
  ];
  expect(cardsForPane(cards, jobs, "wB:p13E")).toEqual(["a", "b", "c"]);
  expect(cardsForPane(cards, jobs, "wB:p12Y")).toEqual([]);
  expect(cardsForPane(cards, [], "wB:p13E")).toEqual(["a"]);
});
