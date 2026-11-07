import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Card agent-coordination-protocol (owner 2026-11-04): claims, the live board and the coordinator.
// fm runs against a scratch tracker; no Herdr on PATH, so pane liveness is not checked here.
const KIT = join(import.meta.dir, "..", "kit", "bin");
const FM = join(KIT, "fm");
const COORD = join(KIT, "fm-coord");
let dir = "";
let env: Record<string, string> = {};

function items(list: object[]) {
  writeFileSync(join(dir, "items.json"), JSON.stringify({ updated: "", items: list }));
}
const coord = () => JSON.parse(readFileSync(join(dir, "coord.json"), "utf8"));
function fm(...args: string[]) {
  const r = Bun.spawnSync(["python3", "-B", FM, ...args], { env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function fmCoord(...args: string[]) {
  const r = Bun.spawnSync(["python3", "-B", COORD, ...args], { env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const MIN = 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fm-coord-"));
  mkdirSync(join(dir, "home"));
  env = {
    PATH: "/usr/bin:/bin",
    HOME: join(dir, "home"),
    OMP_KIT_ENV: "/nonexistent",
    FM_DIR: dir,
    REPORTS_WEB_DIR: dir,
    FM_ITEMS: join(dir, "items.json"),
    FM_RUNNING: join(dir, "running.json"),
    FM_SPAWN_STATE: join(dir, "spawn"),
    FM_SPAWN_PATH: "/nonexistent",
    FM_COORD_AGENTS: join(dir, "agents.json"),
    FM_COORD_BOT_CONFIG: join(dir, "bot-config.json"),
    FM_COORD_STATE: join(dir, "coord-state"),
    FM_COORD_ROUTER: join(dir, "router.json"),
    FM_COORD_PAUSE: join(dir, "pause-all.json"),
    FM_COORD_MAINT: join(dir, "paused.json"),
    FM_COORD_POST_URL: "http://127.0.0.1:9/post",
    FM_COORD_HERDR: join(dir, "no-herdr"),
    HERDR_PANE_ID: "",
  };
  writeFileSync(join(dir, "agents.json"), JSON.stringify([{ paneId: "wT:p1", channelId: "111", machine: "main" }]));
  writeFileSync(join(dir, "bot-config.json"), JSON.stringify({ guildId: "999" }));
  items([
    { id: "a", t: "Job A", s: "running", job: "wT:p1", stack: "webapp" },
    { id: "b", t: "Job B", s: "running", job: "wT:p2", stack: "webapp" },
    { id: "c", t: "Other", s: "partial", stack: "firstmate" },
  ]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("two jobs claim the same PR: the second is refused with the holder card, pane and channel", () => {
  expect(fm("claim", "a", "pr:webapp#12", "--pane", "wT:p1").code).toBe(0);
  const r = fm("claim", "b", "PR:Webapp#12", "--pane", "wT:p2");
  expect(r.code).toBe(4);
  expect(r.err).toContain("held by card a");
  expect(r.err).toContain("pane wT:p1");
  expect(r.err).toContain("https://discord.com/channels/999/111");
  expect(coord().claims.map((c: { card: string }) => c.card)).toEqual(["a"]);
  expect(coord().waits[0]).toMatchObject({ card: "b", resource: "pr:webapp#12", holder: "a" });
});

test("file globs: an overlap is refused, a disjoint area is granted; same card renews", () => {
  expect(fm("claim", "a", "file:webapp:src/api/**").code).toBe(0);
  expect(fm("claim", "b", "file:webapp:src/api/routes.ts").code).toBe(4);
  expect(fm("claim", "b", "file:webapp:src/web/*").code).toBe(0);
  expect(fm("claim", "b", "file:other:src/api/x.ts").code).toBe(0);
  expect(fm("claim", "a", "file:webapp:src/api/**").code).toBe(0);
  expect(coord().claims.filter((c: { card: string }) => c.card === "a").length).toBe(1);
});

test("a bad resource is refused before anything is written", () => {
  const r = fm("claim", "a", "repo-x");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("bad resource");
});

test("receipt and fm stop release the card's claims", () => {
  fm("claim", "a", "pr:webapp#12");
  fm("claim", "b", "branch:webapp:ws/b");
  expect(fm("receipt", "a", "failed", "test").out).toContain("1 claim(s) released");
  expect(fm("claim", "b", "pr:webapp#12").code).toBe(0);
  expect(fm("stop", "b", "test").out).toContain("2 claim(s) released");
  expect(coord().claims).toEqual([]);
});

test("a claim expires 30 min after the last beat; a beat or pane activity renews it", () => {
  fm("claim", "a", "deploy:webapp-prod");
  const d = coord();
  d.claims[0].ts = d.claims[0].renewed = Date.now() - 31 * MIN;
  writeFileSync(join(dir, "coord.json"), JSON.stringify(d));
  // pane activity in running.json (fresh, jobsOk) keeps it live
  writeFileSync(join(dir, "running.json"), JSON.stringify({ generated: new Date().toISOString(), jobsOk: true,
    jobs: [{ id: "wT:p1", items: ["a"], active: new Date(Date.now() - 2 * MIN).toISOString() }] }));
  expect(fm("claim", "b", "deploy:webapp-prod").code).toBe(4);
  writeFileSync(join(dir, "running.json"), "{}");
  const r = fm("claim", "b", "deploy:webapp-prod");
  expect(r.code).toBe(0);
  expect(r.err).toContain("expired claim dropped: deploy:webapp-prod of card a");
});

test("board shows every running job with stack, status line, status age and claim age", () => {
  fm("claim", "a", "pr:webapp#12");
  fm("status", "a", "reviewing PR 12");
  fm("beat", "b", "building the web part");
  const rows = JSON.parse(fm("board", "--json").out);
  expect(rows.map((r: { card: string }) => r.card)).toEqual(["a", "b"]);
  expect(rows[0]).toMatchObject({ stack: "webapp", status: "reviewing PR 12", statusAge: 0, claims: [{ resource: "pr:webapp#12", age: 0 }] });
  expect(rows[1]).toMatchObject({ status: "building the web part", claims: [] });
  expect(fm("board", "--stack", "firstmate", "--json").out.trim()).toBe("[]");
  expect(fm("board").out).toContain("webapp | a | 0m | reviewing PR 12 | pr:webapp#12 (0m)");
});

test("blockedBy sanity (card fm-blockedby-sanity): self and circular links are refused", () => {
  expect(fm("field", "a", "blockedBy", "a").code).toBe(2);
  expect(fm("field", "a", "blockedBy", "b").code).toBe(0);
  const r = fm("field", "b", "blockedBy", "a");
  expect(r.code).toBe(2);
  expect(r.err).toContain("cycle");
});

test("coordinator: a planted overlap gives ONE deduped line per incident and a split/merge proposal", () => {
  // two running jobs of the webapp stack in the same checkout (no worktree) + a wait on a held resource
  writeFileSync(join(dir, "running.json"), JSON.stringify({ generated: new Date().toISOString(), jobsOk: true, jobs: [
    { id: "wT:p1", status: "working", items: ["a"], cwd: "/srv/webapp", active: new Date().toISOString() },
    { id: "wT:p2", status: "working", items: ["b"], cwd: "/srv/webapp", active: new Date().toISOString() },
  ] }));
  writeFileSync(join(dir, "router.json"), JSON.stringify({ threads: { webapp: "777" } }));
  fm("claim", "a", "pr:webapp#12");
  fm("claim", "b", "pr:webapp#12");
  const first = fmCoord("--dry-run", "--json");
  expect(first.code).toBe(0);
  const out = JSON.parse(first.out);
  const v = out.stacks.webapp;
  expect(v.incidents.map((i: { kind: string }) => i.kind).sort()).toEqual(["overlap", "wait"]);
  expect(v.posts.length).toBe(1); // one line per stack per run, in the stack thread
  expect(v.posts[0].channel).toBe("777");
  expect(v.posts[0].text).toContain("a");
  expect(v.proposals.a).toContain("same checkout");
  // a second run with the same incidents posts nothing new (ledger dedupe); dry-run does not save, so run for real
  // with a dead post URL: the post fails, so it is tried again next run (never lost)
  const real1 = JSON.parse(fmCoord("--json").out).stacks.webapp;
  expect(real1.posts.length).toBe(1);
  expect(real1.posted).toBe(false);
  const ledger = JSON.parse(readFileSync(join(dir, "coord-state", "ledger.json"), "utf8"));
  ledger.incidents = Object.fromEntries(Object.entries(ledger.incidents).map(([k, v]) => [k, { ...(v as object), posted: Date.now() }]));
  writeFileSync(join(dir, "coord-state", "ledger.json"), JSON.stringify(ledger));
  const real2 = JSON.parse(fmCoord("--json").out).stacks.webapp;
  expect(real2.posts.length).toBe(0);
  // the proposal is on the card
  const card = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items.find((i: { id: string }) => i.id === "a");
  expect(card.coord).toContain("same checkout");
});

test("coordinator: pause-all stops every action; no stack thread means no post", () => {
  writeFileSync(join(dir, "running.json"), JSON.stringify({ generated: new Date().toISOString(), jobsOk: true, jobs: [
    { id: "wT:p1", status: "working", items: ["a"], cwd: "/srv/webapp" }, { id: "wT:p2", status: "working", items: ["b"], cwd: "/srv/webapp" }] }));
  writeFileSync(join(dir, "pause-all.json"), JSON.stringify({ kind: "all", reason: "owner" }));
  const r = JSON.parse(fmCoord("--dry-run", "--json").out);
  expect(r.skipped).toContain("paused");
  rmSync(join(dir, "pause-all.json"));
  const s = JSON.parse(fmCoord("--dry-run", "--json").out).stacks.webapp;
  expect(s.incidents.length).toBe(1);
  expect(s.posts[0].channel).toBe("");
});

test("coordinator: several cards on ONE pane, or an idle second pane, are no overlap", () => {
  writeFileSync(join(dir, "running.json"), JSON.stringify({ generated: new Date().toISOString(), jobsOk: true, jobs: [
    { id: "wT:p1", status: "working", items: ["a", "b"], cwd: "/srv/webapp" },
    { id: "wT:p3", status: "idle", items: ["b"], cwd: "/srv/webapp" }] }));
  const s = JSON.parse(fmCoord("--dry-run", "--json").out).stacks.webapp;
  expect(s.incidents).toEqual([]);
});

test("a pause keeps the card's claims for the resume; a claim made for a card binds to the card's job pane", () => {
  env.HERDR_PANE_ID = "wT:p9"; // FIRSTMATE's pane, not the job's
  fm("claim", "a", "pr:webapp#12");
  expect(coord().claims[0].pane).toBe("wT:p1");
  expect(fm("set", "a", "paused", "owner pause").out).not.toContain("released");
  expect(coord().claims.length).toBe(1);
  items([{ id: "m", t: "Multi", s: "running", job: "wT:p1,wT:p5", stack: "webapp" }, { id: "a", t: "Job A", s: "running", job: "wT:p1", stack: "webapp" }]);
  env.HERDR_PANE_ID = "wT:p5"; // the job runs in its second listed pane
  fm("claim", "m", "service:x.service");
  expect(coord().claims.find((c: { card: string }) => c.card === "m").pane).toBe("wT:p5");
});

test("coordinator --stack S leaves other stacks' incidents open in the ledger", () => {
  writeFileSync(join(dir, "running.json"), JSON.stringify({ generated: new Date().toISOString(), jobsOk: true, jobs: [] }));
  fm("claim", "a", "pr:webapp#12");
  fm("claim", "b", "pr:webapp#12"); // a webapp wait incident
  fmCoord("--json");
  fmCoord("--stack", "firstmate", "--json");
  const led = JSON.parse(readFileSync(join(dir, "coord-state", "ledger.json"), "utf8")).incidents;
  const k = Object.keys(led).find((x) => x.startsWith("wait:b:"))!;
  expect(led[k].resolved).toBeUndefined();
});
