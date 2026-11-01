// Stack catalog (owner 2026-10-28, card stack-catalog): ONE file read by the router and fm-spawn; every request in a
// stack; a terminal job without a channel still gets a Stop control.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStackJob } from "../src/http.ts";
import { paneStopId, parsePaneStopId, stopPane } from "../src/panestop.ts";
import { DEFAULT_STACKS, routerConfig, ruleRoute } from "../src/router.ts";
import { loadCatalog, parseCatalog, stackSlug, upsertStack } from "../src/stackcatalog.ts";
import { StackRouter } from "../src/stackroute.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "stack-catalog-"));
const REPO = join(import.meta.dir, "..");

describe("catalog file", () => {
  test("parseCatalog keeps valid entries, lower-cases names/keywords, drops bad and duplicate ones", () => {
    const c = parseCatalog({ version: 1, stacks: [
      { name: "Home", emoji: "🏡", keywords: ["Nest", 3, " Ring "], channelIds: ["123"] },
      { name: "home", title: "dup" },
      { name: "x" }, // too short
      { name: "bad name" },
      null,
      { name: "email", areas: null },
    ] });
    expect(c.stacks).toEqual([
      { name: "home", emoji: "🏡", keywords: ["nest", "ring"], channelIds: ["123"] },
      { name: "email" },
    ]);
    expect(parseCatalog("nonsense").stacks).toEqual([]);
  });

  test("upsertStack adds, merges, keeps curated entries with onlyIfMissing, and writes 0600", () => {
    const file = join(scratch(), "stacks.json");
    expect(loadCatalog(file).stacks).toEqual([]); // missing file = empty catalog
    expect(upsertStack({ name: "boats", title: "Boats" }, { file }).added).toBe(true);
    expect(upsertStack({ name: "boats", keywords: ["hull"] }, { file }).entry).toMatchObject({ name: "boats", title: "Boats", keywords: ["hull"] });
    expect(upsertStack({ name: "boats", title: "Overwritten" }, { file, onlyIfMissing: true })).toMatchObject({ added: false, entry: { title: "Boats" } });
    expect(loadCatalog(file).stacks).toHaveLength(1);
    expect((Bun.spawnSync(["stat", "-c", "%a", file]).stdout.toString().trim())).toBe("600");
    expect(() => upsertStack({ name: "Bad Name" }, { file })).toThrow();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("a corrupt catalog is never overwritten; writes keep unknown fields and leave a backup", () => {
    const d = scratch();
    const file = join(d, "stacks.json");
    writeFileSync(file, '{"stacks": [ {"name": "finance", "channelIds": ["1"]} ');
    expect(() => upsertStack({ name: "boats" }, { file })).toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"stacks": [ {"name": "finance", "channelIds": ["1"]} ');
    writeFileSync(file, JSON.stringify({ version: 1, stacks: [{ name: "finance", channelIds: ["1"], futureField: { x: 1 } }] }));
    upsertStack({ name: "boats" }, { file });
    const saved = JSON.parse(readFileSync(file, "utf8")).stacks;
    expect(saved[0]).toEqual({ name: "finance", channelIds: ["1"], futureField: { x: 1 } });
    expect(saved[1]).toMatchObject({ name: "boats" });
    expect(readdirSync(d).some((f) => f.startsWith("stacks.json.before-"))).toBe(true);
  });

  test("stackSlug makes a stack name from a topic or area", () => {
    expect(stackSlug("Client Co: web")).toBe("client-co-web");
    expect(stackSlug("Café Ops")).toBe("cafe-ops");
    expect(stackSlug("!!")).toBeNull();
  });

  test("scripts/stack-add.ts writes the catalog given in OMP_BOT_STACKS and needs no restart", () => {
    const file = join(scratch(), "stacks.json");
    const r = Bun.spawnSync(["bun", "scripts/stack-add.ts", "--name", "home", "--emoji", "🏡", "--keywords", "Nest, Ring", "--areas", "home"], { cwd: REPO, env: { ...process.env, OMP_BOT_STACKS: file } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toMatchObject({ name: "home", added: true });
    expect(JSON.parse(readFileSync(file, "utf8")).stacks[0]).toMatchObject({ name: "home", emoji: "🏡", keywords: ["nest", "ring"], areas: ["home"], addedBy: "stack-add" });
    expect(Bun.spawnSync(["bun", "scripts/stack-add.ts", "--name", "Bad!"], { cwd: REPO, env: { ...process.env, OMP_BOT_STACKS: file } }).exitCode).toBe(2);
  });
});

describe("router reads the catalog", () => {
  test("catalog entries override defaults by name and add new stacks; the catalog wins over legacy config", () => {
    const cfg = routerConfig({ stacks: [{ name: "infra", keywords: ["legacy"] }] }, [
      { name: "infra", keywords: ["herdr"], areas: ["tools"] },
      { name: "home", emoji: "🏡", keywords: ["doorbell"], areas: ["home"] },
    ]);
    expect(cfg.stacks.find((s) => s.name === "infra")!.keywords).toEqual(["herdr"]);
    const home = cfg.stacks.find((s) => s.name === "home")!;
    expect(home).toMatchObject({ emoji: "🏡", title: "home", channelIds: [] });
    expect(cfg.stacks.length).toBe(DEFAULT_STACKS.length + 1);
    expect(ruleRoute("charge the ring doorbell", {}, cfg).decision).toMatchObject({ stack: "home", by: "keyword" });
  });

  test("StackRouter.refresh reloads the catalog when its file changes (no restart)", () => {
    const d = scratch();
    const file = join(d, "stacks.json");
    const logs: string[] = [];
    const r = new StackRouter(routerConfig(undefined), { stateFile: join(d, "state.json"), statusFile: join(d, "stacks-status.json"), itemsFile: join(d, "items.json"), guildId: "g", log: (s) => logs.push(s), catalogFile: file });
    expect(r.stack("home")).toBeUndefined();
    upsertStack({ name: "home", emoji: "🏡", keywords: ["thermostat"] }, { file });
    utimesSync(file, new Date(), new Date(Date.now() + 5_000)); // a distinct mtime even on coarse clocks
    expect(r.stack("home")).toMatchObject({ name: "home", emoji: "🏡" });
    expect(r.tracker.status().some((s) => s.stack === "home")).toBe(true); // the tracker shares the reloaded list
    expect(r.refresh()).toBe(false); // unchanged file: no reload
    expect(logs.some((l) => l.includes("stack catalog loaded"))).toBe(true);
    // a broken hand-edit keeps the loaded stacks (no drop to the defaults)
    writeFileSync(file, "{ broken");
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(r.refresh()).toBe(false);
    expect(r.stack("home")).toBeDefined();
    expect(logs.some((l) => l.includes("unreadable, keeping"))).toBe(true);
  });
});

describe("POST /stack-job body", () => {
  test("valid body, defaults and limits", () => {
    expect(parseStackJob({ stack: "kb", text: "job", pane: "wB:pWG" })).toEqual({ stack: "kb", text: "job", pane: "wB:pWG", machine: "main", alert: "" });
    expect(parseStackJob({ stack: "kb", text: "x".repeat(5000) })).toMatchObject({ text: "x".repeat(1900) });
  });
  test("bad bodies are refused", () => {
    for (const b of [null, { stack: "Bad Name", text: "t" }, { stack: "kb", text: " " }, { stack: "kb", text: "t", pane: "wB:tX" }, { stack: "kb", text: "t", machine: "pc" }])
      expect("error" in parseStackJob(b)).toBe(true);
  });
});

describe("pane Stop", () => {
  test("custom id round trip; only main/second pane ids parse", () => {
    expect(parsePaneStopId(paneStopId({ machine: "main", paneId: "wB:pWG" }))).toEqual({ machine: "main", paneId: "wB:pWG" });
    expect(parsePaneStopId("ps:pc:wB:pWG")).toBeNull();
    expect(parsePaneStopId("ps:main:wB:tWG")).toBeNull();
    expect(parsePaneStopId("sb:123")).toBeNull();
  });

  function fakeHerdr(panes: object[], sendCode = 0) {
    const calls: string[][] = [];
    const herdr = async (_t: unknown, args: string[]) => {
      calls.push(args);
      if (args[0] === "pane") return { code: 0, out: JSON.stringify({ result: { panes } }) };
      return { code: sendCode, out: "" };
    };
    return { calls, herdr };
  }

  test("sends Esc only to an existing OMP pane", async () => {
    const t = { machine: "main", paneId: "wB:pWG" };
    const ok = fakeHerdr([{ pane_id: "wB:pWG", agent: "omp" }]);
    expect((await stopPane(t, ok.herdr)).ok).toBe(true);
    expect(ok.calls[1]).toEqual(["agent", "send-keys", "wB:pWG", "esc"]);
    const gone = fakeHerdr([{ pane_id: "wB:pXX", agent: "omp" }]);
    expect(await stopPane(t, gone.herdr)).toMatchObject({ ok: false });
    expect(gone.calls).toHaveLength(1); // no key sent
    const shell = fakeHerdr([{ pane_id: "wB:pWG", agent: "bash" }]);
    expect(await stopPane(t, shell.herdr)).toMatchObject({ ok: false });
    expect(shell.calls).toHaveLength(1);
    expect(await stopPane(t, fakeHerdr([{ pane_id: "wB:pWG", agent: "omp" }], 1).herdr)).toMatchObject({ ok: false });
  });
});
