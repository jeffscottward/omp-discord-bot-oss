import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadChannels } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "cfg-reload-"));
const file = join(dir, "config.json");

test("a new channel becomes routable", () => {
  const map: Record<string, { name: string; cwd: string }> = { "1": { name: "a", cwd: "/x" } };
  writeFileSync(file, JSON.stringify({ channels: { "1": { name: "a", cwd: "/x" }, "2": { name: "b", cwd: "/y" } } }));
  const r = reloadChannels(file, map);
  expect(r).toEqual({ ok: true, added: ["2"], removed: [], changed: [] });
  expect(map["2"]).toEqual({ name: "b", cwd: "/y" });
});

test("bad JSON keeps the old map", () => {
  const map = { "1": { name: "a", cwd: "/x" } };
  writeFileSync(file, "{ not json");
  expect(reloadChannels(file, map).ok).toBe(false);
  expect(map).toEqual({ "1": { name: "a", cwd: "/x" } });
});

test("bad entry or empty map keeps the old map; removals apply", () => {
  const map: Record<string, { name: string; cwd: string }> = { "1": { name: "a", cwd: "/x" }, "2": { name: "b", cwd: "/y" } };
  writeFileSync(file, JSON.stringify({ channels: { "1": { name: 5 } } }));
  expect(reloadChannels(file, map).ok).toBe(false);
  writeFileSync(file, JSON.stringify({ channels: {} }));
  expect(reloadChannels(file, map).ok).toBe(false);
  expect(Object.keys(map)).toEqual(["1", "2"]);
  writeFileSync(file, JSON.stringify({ channels: { "1": { name: "a2", cwd: "/x" } } }));
  expect(reloadChannels(file, map)).toEqual({ ok: true, added: [], removed: ["2"], changed: ["1"] });
  expect(map).toEqual({ "1": { name: "a2", cwd: "/x" } });
});
