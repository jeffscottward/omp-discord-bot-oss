// Owner 2026-11-03: the 📋 Master queue reads from the bottom up.
import { expect, test } from "bun:test";
import { renderMasterPages, type Row } from "../src/masterqueue.ts";

test("bottom to top: Needs you, Running, Queued, Blocked, Finished, Bots; oldest row lowest in each list", () => {
  const row = (key: string, state: Row["state"], at: number): Row => ({ key, title: key, where: "x", state, at });
  const rows = [row("r-old", "running", 1), row("r-new", "running", 2), row("q-old", "queued", 1), row("q-new", "queued", 2), row("b1", "blocked", 1), row("d1", "done", 1), row("n-old", "needs", 1), row("n-new", "needs", 2)];
  const t = renderMasterPages(rows, 10_000, "", 100_000).join("\n");
  const at = (s: string) => t.indexOf(s);
  expect(at("Bots and scheduled")).toBeLessThan(at("Finished, last"));
  expect(at("Finished, last")).toBeLessThan(at("**Blocked**"));
  expect(at("**Blocked**")).toBeLessThan(at("**Queued**"));
  expect(at("**Queued**")).toBeLessThan(at("**Running**"));
  expect(at("**Running**")).toBeLessThan(at("**Needs you**"));
  expect(at("r-new")).toBeLessThan(at("r-old"));
  expect(at("q-new")).toBeLessThan(at("q-old"));
  expect(at("n-new")).toBeLessThan(at("n-old"));
});

test("check section sits between Finished and Blocked; Queued #1 is the oldest (lowest); Needs you is on the last page", () => {
  const row = (key: string, state: Row["state"], at: number): Row => ({ key, title: key, where: "x", state, at });
  const rows = [row("c-old", "check", 1), row("c-new", "check", 2), row("b-old", "blocked", 1), row("b-new", "blocked", 2), row("q-old", "queued", 1), row("q-new", "queued", 2), row("n1", "needs", 1)];
  const one = renderMasterPages(rows, 10_000, "", 100_000).join("\n");
  expect(one.indexOf("Finished, last")).toBeLessThan(one.indexOf("needs a check"));
  expect(one.indexOf("needs a check")).toBeLessThan(one.indexOf("**Blocked**"));
  expect(one.indexOf("c-new")).toBeLessThan(one.indexOf("c-old"));
  expect(one.indexOf("b-new")).toBeLessThan(one.indexOf("b-old"));
  expect(one).toMatch(/1\. \S* ?\[?q-old/);
  const pages = renderMasterPages(rows, 10_000, "", 300);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.at(-1)).toContain("Needs you");
});
