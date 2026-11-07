import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTagAsk, tagReply } from "../src/tagquery.ts";

// Card fm-card-tags (owner 2026-11-05): theme tags on cards, `fm tag`, `fm find --tag`, `fm board --tag`, fm-spawn
// `Tags:` line, and the bot's "show tag X" answer.
const FM = join(import.meta.dir, "..", "kit", "bin", "fm");
const SPAWN = join(import.meta.dir, "..", "scripts", "fm-spawn");
let dir = "";
let env: Record<string, string> = {};
const items = (list: object[]) => writeFileSync(join(dir, "items.json"), JSON.stringify({ updated: "", items: list }));
const card = (id: string) => JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items.find((i: { id: string }) => i.id === id);
function fm(...args: string[]) {
  const r = Bun.spawnSync(["python3", "-B", FM, ...args], { env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fm-tags-"));
  mkdirSync(join(dir, "home"));
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"), OMP_KIT_ENV: "/nonexistent", FM_DIR: dir,
    REPORTS_WEB_DIR: dir, FM_ITEMS: join(dir, "items.json"), FM_SPAWN_STATE: join(dir, "spawn"),
    FM_SPAWN_PATH: "/nonexistent", OMP_BOT_ENV: join(dir, "no-bot.env"), FM_BY: "test",
  };
  items([
    { id: "a", t: "Second password", s: "waiting", stack: "firstmate" },
    { id: "b", t: "Photo export", s: "partial", stack: "firstmate" },
    { id: "c", t: "IG bot", s: "running", job: "x.service", stack: "social" },
  ]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("fm tag adds, normalizes, dedupes and removes tags", () => {
  expect(fm("tag", "a", "+macos-manual", "Security", "+macos-manual").code).toBe(0);
  expect(card("a").tags).toEqual(["macos-manual", "security"]);
  expect(fm("tag", "a", "-security").code).toBe(0);
  expect(card("a").tags).toEqual(["macos-manual"]);
  expect(fm("tag", "a", "-macos-manual").code).toBe(0);
  expect(card("a").tags).toBeUndefined();
  expect(fm("tag", "a", "+bad/slug").code).not.toBe(0);
  expect(fm("tag", "nope", "+x").code).not.toBe(0);
});

test("fm find --tag and fm tags list only tagged cards", () => {
  fm("tag", "a", "+macos-manual");
  fm("tag", "b", "+macos-manual", "+macos");
  const r = fm("find", "--tag", "macos-manual");
  expect(r.out).toContain("a | waiting");
  expect(r.out).toContain("b | partial");
  expect(r.out).not.toContain("c |");
  expect(fm("find", "photo", "--tag", "macos-manual").out.trim().split("\n")).toHaveLength(1);
  expect(fm("tags").out).toContain("macos-manual | 2");
});

test("fm board --tag filters running jobs by tag", () => {
  fm("tag", "c", "+instagram");
  expect(fm("board", "--tag", "instagram").out).toContain("| c |");
  expect(fm("board", "--tag", "macos").out).toContain("no running jobs");
});

test("fm-spawn reads the task file Tags: line", () => {
  const code = `import importlib.machinery as m, importlib.util as u
l = m.SourceFileLoader("fs", ${JSON.stringify(SPAWN)}); s = u.spec_from_loader("fs", l); f = u.module_from_spec(s); l.exec_module(f)
print(f.task_tags("# T\\nTags: macos, #API-keys \`instagram\` bad/x\\nTags: macos\\nTags:\\n## Acceptance check\\n"))`;
  const r = Bun.spawnSync(["python3", "-B", "-c", code], { env });
  expect(r.stdout.toString().trim()).toBe("['macos', 'api-keys', 'instagram']");
});

test("bot parses 'show tag X' and answers with card links", () => {
  expect(parseTagAsk("show tag macos-manual")).toBe("macos-manual");
  expect(parseTagAsk("Show me cards tagged #API keys")).toBe("api-keys");
  expect(parseTagAsk("list tag: instagram")).toBe("instagram");
  expect(parseTagAsk("show me the dashboard")).toBeUndefined();
  const list = [
    { id: "a", t: "Second password", s: "waiting", tags: ["macos-manual"] },
    { id: "b", t: "Old", s: "done", tags: ["macos-manual"] },
    { id: "c", t: "IG", s: "running", tags: ["instagram"] },
  ];
  const txt = tagReply(list, "macos-manual", "https://x.test/reports/firstmate/");
  expect(txt).toContain("1 open card, 1 done");
  expect(txt).toContain("https://x.test/reports/firstmate/?item=a");
  expect(txt).toContain("?tag=macos-manual");
  expect(txt).not.toContain("IG");
  expect(tagReply(list, "nope", "")).toBeUndefined(); // falls through to a normal turn
  for (const m of ["find tagged PRs from last week", "show tags", "list tagless cards", "show tag manager logs for the bot please"])
    expect(parseTagAsk(m)).toBeUndefined();
});
