// fm-spawn (scripts/fm-spawn, Orca #7): worktree decision, tab start, card update, safe cleanup.
// Uses a scratch git repo under /tmp, a fake herdr and a fake fm, so no real tab or card changes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_STACKS } from "../src/router.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "fm-spawn");
let dir: string, repo: string, env: Record<string, string>;

function sh(cmd: string[], cwd?: string) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const git = (...a: string[]) => sh(["git", "-C", repo, ...a]);
const setPanes = (cwds: string[]) =>
  writeFileSync(join(dir, "panes.json"), JSON.stringify(cwds.map((c, i) => ({ pane_id: `wT:p${i}`, workspace_id: "wT", cwd: c, foreground_cwd: c }))));
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");
const spawn = (...extra: string[]) =>
  sh(["python3", SCRIPT, "--label", "🧪 test job", "--cwd", repo, "--task", join(dir, "task.md"), ...extra]);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fm-spawn-test-")));
  repo = join(dir, "scratch");
  env = {
    FM_SPAWN_HERDR: join(dir, "herdr"), FM_SPAWN_FM: join(dir, "fm"), FM_SPAWN_STATE: join(dir, "state"),
    FM_SPAWN_TABWATCH: join(dir, "fm-tabwatch"),
    FM_SPAWN_FAST: "1", FM_SPAWN_OMP_WAIT_S: "5", HERDR_PANE_ID: "",
    // never reach the real bot: no channel waiter unless a test turns it on with fake agents.json + /post
    FM_SPAWN_CHANNEL_WAIT_S: "0", FM_SPAWN_AGENTS: join(dir, "agents.json"), FM_SPAWN_POST_URL: "http://127.0.0.1:9/post",
    FM_SPAWN_ITEMS: join(dir, "items.json"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  // fake herdr: pane list from panes.json; tab create returns ids; process-info says omp; logs every call
  writeFileSync(join(dir, "herdr"), `#!/bin/bash
printf '%s\\n' "herdr $*" >> ${dir}/calls.log
case "$1 $2" in
  "pane list") printf '{"result":{"panes":%s}}' "$(cat ${dir}/panes.json)";;
  "tab list") printf '{"result":{"tabs":%s}}' "$(cat ${dir}/tabs.json 2>/dev/null || echo '[]')";;
  "tab create") echo '{"result":{"tab":{"tab_id":"wT:t9"},"root_pane":{"pane_id":"wT:p9"}}}';;
  "pane process-info") echo '{"result":{"process_info":{"foreground_processes":[{"name":"omp"}]}}}';;
esac
`);
  // fake fm: logs every call; `fm get <id>` prints cards/<id>.json when present
  writeFileSync(join(dir, "fm"), `#!/bin/bash\nprintf '%s\\n' "fm $*" >> ${dir}/calls.log\n[ "$1" = get ] && cat ${dir}/cards/$2.json 2>/dev/null\nexit 0\n`);
  // fake fm-tabwatch: one finished fm-spawn tab and one that only looks finished
  writeFileSync(join(dir, "fm-tabwatch"), `#!/bin/bash\necho '{"tabs":31,"closable":[{"tab":"wT:t1","label":"🧪 done job","card":"c0","why":"receipt done"}],"look_finished":[{"tab":"wT:t2","label":"old tab","status":"done"}]}'\n`);
  chmodSync(join(dir, "fm-tabwatch"), 0o755);
  chmodSync(join(dir, "herdr"), 0o755);
  chmodSync(join(dir, "fm"), 0o755);
  writeFileSync(join(dir, "task.md"), "# task\n");
  sh(["git", "init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  setPanes([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fm-spawn start", () => {
  test("no other pane in the repo: starts in the repo, no worktree", () => {
    setPanes(["/elsewhere"]);
    const r = spawn("--card", "c1");
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    expect(o.worktree).toBeNull();
    expect(o.cwd).toBe(repo);
    expect(o.pane).toBe("wT:p9");
    const c = calls();
    expect(c).toContain(`tab create --workspace wT --cwd ${repo} --label 🧪 test job --no-focus`);
    expect(c).toContain(`agent prompt wT:p9 Read ${dir}/task.md and do the task. Owner questions: ONLY as a fenced \`\`\`ask JSON block`);
    expect(c).toContain("Card: c1 (update it with fm set/fm field)");
    expect(c).toContain("Last step: write the worker-done receipt with fm receipt c1 done|failed|blocked");
    expect(c).not.toContain("WORKTREE");
    expect(c).toContain("fm field c1 job wT:p9");
    expect(c).toMatch(/fm set c1 running fm-spawn: tab/);
  });

  test("brief lint (pstack): a bare task file warns and asks the session for its own done check and verify step", () => {
    setPanes(["/elsewhere"]);
    const r = spawn("--card", "c1");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning: task file has no done check, verify step (brief lint)");
    const c = calls();
    expect(c).toContain("The task file names no done check, verify step: write your own before you start");
    expect(c).toContain("--verified live|tests|typecheck|none --evidence <commit/file/URL>");
    expect(c).toContain("For engineering work follow skill pstack (playbook + principles).");
  });

  test("brief lint: a task file with goal, acceptance and verify steps sends no gap note", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "task.md"), "# Task: fix it\n## Acceptance\n- the bug is gone\n## Verify\n- run bun test\n");
    const r = spawn("--card", "c1");
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("brief lint");
    expect(calls()).not.toContain("The task file names no");
  });

  test("a live pane works in the repo: creates <repo>-wt-<slug> on ws/<slug> and sends merge-back steps", () => {
    setPanes([join(repo, "sub")]);
    const r = spawn("--card", "c1");
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    expect(o.worktree).toBe(`${repo}-wt-test-job`);
    expect(o.branch).toBe("ws/test-job");
    expect(o.base).toBe("main");
    expect(existsSync(join(o.worktree, "a.txt"))).toBe(true);
    const c = calls();
    expect(c).toContain(`--cwd ${repo}-wt-test-job --label`);
    expect(c).toContain("WORKTREE:");
    expect(c).toContain(`git -C ${repo}-wt-test-job rebase main`);
    expect(c).toContain(`flock /tmp/scratch-integrate.lock git -C ${repo} merge --ff-only ws/test-job`);
    const reg = JSON.parse(readFileSync(join(dir, "state", "worktrees.json"), "utf8")).worktrees;
    expect(reg[0]).toMatchObject({ path: `${repo}-wt-test-job`, branch: "ws/test-job", base: "main", card: "c1", pane: "wT:p9" });
  });

  test("second spawn picks a free slug", () => {
    setPanes([repo]);
    expect(spawn().code).toBe(0);
    const o = JSON.parse(spawn().out);
    expect(o.worktree).toBe(`${repo}-wt-test-job-2`);
  });

  test("a pane in a sibling worktree does not count as working in the main repo", () => {
    git("worktree", "add", "-q", "-b", "other", `${repo}-wt-other`);
    setPanes([`${repo}-wt-other`]);
    expect(JSON.parse(spawn().out).worktree).toBeNull();
  });

  test("not a git repo, --no-worktree and --dry-run", () => {
    setPanes([dir]);
    const plain = sh(["python3", SCRIPT, "--label", "x", "--cwd", dir, "--task", join(dir, "task.md"), "--dry-run"]);
    expect(JSON.parse(plain.out)).toMatchObject({ dry_run: true, worktree: null, reason: "not a git repo" });
    setPanes([repo]);
    expect(JSON.parse(spawn("--no-worktree", "--dry-run").out).worktree).toBeNull();
    const dry = JSON.parse(spawn("--dry-run").out);
    expect(dry.worktree).toBe(`${repo}-wt-test-job`);
    expect(existsSync(dry.worktree)).toBe(false); // dry run changes nothing
    expect(calls()).not.toContain("tab create");
  });

  test("more than 30 tabs: refuses before creating anything and lists closable tabs (auth-loop-guard)", () => {
    setPanes([repo]);
    writeFileSync(join(dir, "tabs.json"), JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ tab_id: `wT:t${i}` }))));
    const r = spawn("--card", "c1");
    expect(r.code).toBe(4);
    expect(r.err).toContain("already has 31 tabs (max 30)");
    expect(r.err).toContain("closes automatically (fm-tabwatch, finished + receipt): wT:t1 🧪 done job");
    expect(r.err).toContain("herdr tab close wT:t2");
    expect(calls()).not.toContain("tab create");
    expect(calls()).not.toContain("fm ");
    expect(existsSync(`${repo}-wt-test-job`)).toBe(false);
    writeFileSync(join(dir, "tabs.json"), JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ tab_id: `wT:t${i}` }))));
    expect(spawn("--card", "c1").code).toBe(0); // exactly 30 is still allowed
  });

  test("every spawn is recorded in spawned.jsonl for fm-tabwatch", () => {
    setPanes(["/elsewhere"]);
    expect(spawn("--card", "c7").code).toBe(0);
    const rows = readFileSync(join(dir, "state", "spawned.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "🧪 test job", tab: "wT:t9", pane: "wT:p9", card: "c7", workspace: "wT" });
    expect(typeof rows[0].tsMs).toBe("number");
  });

  test("stack: --stack wins; else the card's area mapped like the router; else firstmate (owner 2026-10-24)", () => {
    setPanes(["/elsewhere"]);
    sh(["mkdir", "-p", join(dir, "cards")]);
    writeFileSync(join(dir, "cards", "c1.json"), JSON.stringify({ id: "c1", area: "Discord" }));
    expect(JSON.parse(spawn("--card", "c1").out).stack).toBe("infra");
    expect(calls()).toContain("fm field c1 stack infra");
    expect(JSON.parse(spawn("--card", "c1", "--stack", "kb").out).stack).toBe("kb");
    expect(JSON.parse(spawn("--card", "nocard").out).stack).toBe("firstmate");
    expect(JSON.parse(spawn().out).stack).toBe("firstmate");
    writeFileSync(join(dir, "cards", "c2.json"), JSON.stringify({ id: "c2", area: "Client Co: postal address" }));
    expect(JSON.parse(spawn("--card", "c2", "--dry-run").out).stack).toBe("realestate");
    expect(spawn("--stack", "nope").code).not.toBe(0);
  });

  test("STACK_AREAS matches the router's DEFAULT_STACKS areas", () => {
    const r = sh(["python3", "-c", `import runpy,json;print(json.dumps(runpy.run_path(${JSON.stringify(SCRIPT)},run_name="x")["STACK_AREAS"]))`]);
    expect(JSON.parse(r.out)).toEqual(Object.fromEntries(DEFAULT_STACKS.map((s) => [s.name, s.areas])));
  });

  test("null router/areas in the bot config do not break fm-spawn at import", () => {
    const areas = () => {
      const r = sh(["python3", "-c", `import runpy,json;print(json.dumps(runpy.run_path(${JSON.stringify(SCRIPT)},run_name="x")["STACK_AREAS"]))`]);
      expect(r.code).toBe(0);
      return JSON.parse(r.out) as Record<string, string[]>;
    };
    const cfg = join(dir, "bot-config.json");
    env.OMP_BOT_CONFIG = cfg;
    writeFileSync(cfg, JSON.stringify({ router: null }));
    expect(areas().infra).toEqual(DEFAULT_STACKS.find((s) => s.name === "infra")!.areas);
    writeFileSync(cfg, JSON.stringify({ router: { stacks: [{ name: "infra", areas: null }, { name: "new", areas: ["Boats"] }] } }));
    const a = areas();
    expect(a.infra!.length).toBe(DEFAULT_STACKS.find((s) => s.name === "infra")!.areas.length);
    expect(a.new).toEqual(["boats"]);
  });
});

describe("fm-spawn channel post and --adopt (owner 2026-10-24)", () => {
  /** Fake bot /post on a free port; returns the posted bodies. */
  function fakeBot(status = 200) {
    const posts: { channel: string; text: string }[] = [];
    const srv = Bun.serve({ port: 0, fetch: async (req) => {
      const b = (await req.json()) as { channel: string; text: string };
      posts.push(b);
      return status === 200 && !b.text.includes("REFUSE") ? Response.json({ ok: true, url: `https://discord/x/${b.channel}` }) : Response.json({ error: "no" }, { status: 400 });
    } });
    env.FM_SPAWN_POST_URL = `http://127.0.0.1:${srv.port}/post`;
    return { posts, stop: () => srv.stop(true) };
  }
  async function run(...args: string[]) {
    const p = Bun.spawn(["python3", SCRIPT, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    return { code, out: await new Response(p.stdout).text() };
  }
  const adopted = () => (existsSync(join(dir, "state", "adopted.json")) ? Object.keys(JSON.parse(readFileSync(join(dir, "state", "adopted.json"), "utf8"))) : []);
  const agents = (rows: object[]) => writeFileSync(join(dir, "agents.json"), JSON.stringify(rows));

  test("the waiter posts the task text in the pane's mirrored channel; ask fences never become menus", async () => {
    const bot = fakeBot();
    env.FM_SPAWN_CHANNEL_WAIT_S = "2";
    writeFileSync(join(dir, "task.md"), "# Task: demo\nDo it.\n```ask\n{}\n```\n");
    agents([{ paneId: "wT:p9", tabId: "wT:t9", channelId: "C9", archived: false }]);
    const r = await run("--await-channel", "wT:p9", "--task", join(dir, "task.md"), "--label", "🧪 demo", "--stack", "infra", "--card", "c1");
    bot.stop();
    expect(r.code).toBe(0);
    expect(bot.posts).toHaveLength(1);
    expect(bot.posts[0]!.channel).toBe("C9");
    expect(bot.posts[0]!.text).toContain("📝 **Task** (fm-spawn): 🧪 demo");
    expect(bot.posts[0]!.text).toContain("stack: infra");
    expect(bot.posts[0]!.text).toContain("Do it.");
    expect(bot.posts[0]!.text).not.toContain("```ask");
  });

  test("no channel within the deadline: no post, exit 3; an archived entry does not count", async () => {
    const bot = fakeBot();
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    agents([{ paneId: "wT:p9", channelId: "OLD", archived: true }]);
    const r = await run("--await-channel", "wT:p9", "--task", join(dir, "task.md"), "--label", "x", "--stack", "infra");
    bot.stop();
    expect(r.code).toBe(3);
    expect(bot.posts).toHaveLength(0);
  });

  test("a refused full post falls back to the short form", async () => {
    const bot = fakeBot();
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    writeFileSync(join(dir, "task.md"), "REFUSE this\n");
    agents([{ paneId: "wT:p9", channelId: "C9", archived: false }]);
    const r = await run("--await-channel", "wT:p9", "--task", join(dir, "task.md"), "--label", "x", "--stack", "kb");
    bot.stop();
    expect(r.code).toBe(0);
    expect(bot.posts).toHaveLength(2);
    expect(bot.posts[1]!.text).toContain("Task file:");
  });

  test("--adopt-all: open cards with a live pane get a missing stack and one channel note; repeatable", async () => {
    const bot = fakeBot();
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    writeFileSync(join(dir, "panes.json"), JSON.stringify([{ pane_id: "wT:p1", tab_id: "wT:t1" }, { pane_id: "wT:p2", tab_id: "wT:t2" }, { pane_id: "wT:p3", tab_id: "wT:t3" }]));
    writeFileSync(join(dir, "items.json"), JSON.stringify([
      { id: "a", s: "running", job: "wT:p1", area: "discord" },
      { id: "b", s: "running", job: "wT:p2", stack: "kb", area: "tools" },
      { id: "c", s: "running", job: "wT:p7" }, // pane gone
      { id: "d", s: "done", job: "wT:p1" },
      { id: "e", s: "running", job: "kb-daily.timer" },
      { id: "f", s: "partial", job: ["wT:t1"], area: "Something new" }, // tab id; no domain -> firstmate
      { id: "g", s: "running", job: "wT:p3", area: "Finance: options", t: "SECRET position title" }, // finance stack ("Finance: …" too): no title in Discord
      { id: "h", s: "running", job: "wT:p2", area: "tools" }, // same pane as b: one note per pane
    ]));
    agents([{ paneId: "wT:p1", tabId: "wT:t1", channelId: "C1", archived: false }, { paneId: "wT:p2", tabId: "wT:t2", channelId: "C2", archived: false }, { paneId: "wT:p3", tabId: "wT:t3", channelId: "C3", archived: false }]);
    const dry = await run("--adopt-all", "--dry-run");
    expect(dry.out).toContain("DRY adopt wT:p1 card a stack infra (set) channel C1");
    expect(dry.out).toContain("DRY adopt wT:p2 card b stack kb channel C2");
    expect(dry.out).toContain("DRY adopt wT:t1 card f stack firstmate (set) channel C1 (already noted)");
    expect(dry.out).not.toContain("card c ");
    expect(dry.out).not.toContain("card d ");
    expect(dry.out).not.toContain("card e ");
    expect(calls()).not.toContain("fm field");
    await run("--adopt-all"); // waits in-process: every note is posted when it returns

    expect(calls()).toContain("fm field a stack infra");
    expect(calls()).toContain("fm field f stack firstmate");
    expect(calls()).toContain("fm field g stack finance");
    expect(bot.posts.some((p) => p.text.includes("SECRET"))).toBe(false);
    expect(bot.posts.find((p) => p.channel === "C3")!.text).toContain("Finance card g");
    expect(calls()).not.toContain("fm field b stack");
    expect(bot.posts.map((p) => p.channel).sort()).toEqual(["C1", "C2", "C3"]);
    expect(bot.posts[0]!.text).toContain("📌 **Terminal job** (fm-spawn --adopt)");
    expect(adopted().sort()).toEqual(["wT:p1", "wT:p2", "wT:p3"]);
    // the real fm saved the stacks: a second pass changes nothing and posts nothing
    const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).map((c: { stack?: string }) => ({ stack: "infra", ...c }));
    writeFileSync(join(dir, "items.json"), JSON.stringify(items));
    const fmCalls = () => calls().split("\n").filter((l) => l.startsWith("fm ")).length;
    const before = fmCalls();
    const again = await run("--adopt-all");
    bot.stop();
    expect(again.out).toContain("(already noted)");
    expect(fmCalls()).toBe(before); // nothing set again
    expect(readFileSync(join(dir, "state", "fm-spawn.log"), "utf8").match(/channel: .* posted/g)).toHaveLength(3); // noted panes start no waiter
  });

  test("--adopt sets job + stack on the card and prints the channel", async () => {
    agents([{ paneId: "wT:p1", channelId: "C1", archived: false }]);
    const r = await run("--adopt", "wT:p1", "--card", "a", "--stack", "personal");
    expect(JSON.parse(r.out)).toMatchObject({ pane: "wT:p1", card: "a", stack: "personal", channel: "C1" });
    expect(calls()).toContain("fm field a job wT:p1");
    expect(calls()).toContain("fm field a stack personal");
  });
});

describe("fm-spawn --cleanup", () => {
  function made() {
    setPanes([repo]);
    const o = JSON.parse(spawn().out);
    return o.worktree as string;
  }

  test("keeps unmerged work, dirty trees and trees with a live pane; removes merged clean idle ones", () => {
    const wt = made();
    // 1) unmerged commit -> keep
    writeFileSync(join(wt, "b.txt"), "b\n");
    sh(["git", "-C", wt, "add", "b.txt"]);
    sh(["git", "-C", wt, "commit", "-qm", "b"]);
    setPanes([]);
    let r = sh(["python3", SCRIPT, "--cleanup"]);
    expect(r.out).toContain("keep:");
    expect(r.out).toContain("not merged into main (1 commit(s) ahead)");
    expect(existsSync(wt)).toBe(true);
    // 2) merged but an untracked file -> keep
    git("merge", "-q", "--ff-only", "ws/test-job");
    writeFileSync(join(wt, "scratch.tmp"), "x");
    r = sh(["python3", SCRIPT, "--cleanup"]);
    expect(r.out).toContain("uncommitted/untracked");
    expect(existsSync(wt)).toBe(true);
    rmSync(join(wt, "scratch.tmp"));
    // 3) merged, clean, but a live pane works in it -> keep
    setPanes([wt]);
    r = sh(["python3", SCRIPT, "--cleanup"]);
    expect(r.out).toContain("live pane(s)");
    // 4) dry run lists it, removes nothing
    setPanes([]);
    r = sh(["python3", SCRIPT, "--cleanup", "--dry-run"]);
    expect(r.out).toContain("DRY would remove");
    expect(existsSync(wt)).toBe(true);
    // 5) merged, clean, idle -> removed with its branch
    r = sh(["python3", SCRIPT, "--cleanup"]);
    expect(r.out).toContain("removed:");
    expect(existsSync(wt)).toBe(false);
    expect(git("branch", "--list", "ws/test-job").out.trim()).toBe("");
    expect(git("log", "--oneline").out).toContain(" b"); // the merged work is still on main
    expect(JSON.parse(readFileSync(join(dir, "state", "worktrees.json"), "utf8")).worktrees).toEqual([]);
  });

  test("also checks hand-made ws/* worktrees of known repos, never other branches", () => {
    made();
    git("worktree", "add", "-q", "-b", "ws/manual", `${repo}-wt-manual`);
    git("worktree", "add", "-q", "-b", "orca/x", `${repo}-wt-orca`);
    setPanes([]);
    const r = sh(["python3", SCRIPT, "--cleanup", "--dry-run"]);
    expect(r.out).toContain(`${repo}-wt-manual [ws/manual]`);
    expect(r.out).not.toContain("orca/x");
  });
});

describe("fm-spawn shared dependencies (worktree-share, store-based)", () => {
  const setupDeps = () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.venv/\n");
    writeFileSync(join(repo, "bun.lock"), "lock-v1\n");
    writeFileSync(join(repo, "uv.lock"), "uv-v1\n");
    git("add", ".gitignore", "bun.lock", "uv.lock");
    git("commit", "-qm", "deps");
    sh(["mkdir", "-p", join(repo, "node_modules/pkg")]);
    writeFileSync(join(repo, "node_modules/pkg/index.js"), "x\n");
    // fake bun/uv: record argv + UV_LINK_MODE, create an own folder
    for (const [bin, folder] of [["bun", "node_modules"], ["uv", ".venv"]] as const) {
      writeFileSync(join(dir, bin), `#!/bin/bash\necho "${bin} $* link=$UV_LINK_MODE cwd=$PWD" >> ${dir}/pm.log\nmkdir -p ${folder}\n`);
      chmodSync(join(dir, bin), 0o755);
    }
    env.PATH = `${dir}:${process.env.PATH}`;
  };
  const wt = () => join(dir, "scratch-wt-x");
  const pm = () => (existsSync(join(dir, "pm.log")) ? readFileSync(join(dir, "pm.log"), "utf8") : "");
  test("worktree gets its own folders from the shared stores; never a symlink to the main checkout", () => {
    setupDeps();
    setPanes([repo]);
    const o = JSON.parse(spawn("--base", "main").out);
    expect(pm()).toContain("bun install --frozen-lockfile --backend=hardlink");
    expect(pm()).toContain("uv sync --frozen link=hardlink");
    expect(sh(["test", "-L", join(o.worktree, "node_modules")]).code).not.toBe(0);
    expect(sh(["test", "-d", join(o.worktree, "node_modules")]).code).toBe(0);
    expect(sh(["git", "-C", o.worktree, "status", "--porcelain"]).out.trim()).toBe("");
  });
  test("--share replaces a legacy writable symlink with an own install; main folder untouched", () => {
    setupDeps();
    git("worktree", "add", "-qb", "ws/x", wt(), "main");
    sh(["ln", "-s", join(repo, "node_modules"), join(wt(), "node_modules")]);
    const r = sh(["python3", SCRIPT, "--share", wt()]);
    expect(r.out).toContain("removed writable shared link");
    expect(sh(["test", "-L", join(wt(), "node_modules")]).code).not.toBe(0);
    expect(existsSync(join(repo, "node_modules/pkg/index.js"))).toBe(true);
  });
  test("cleanup unlinks a legacy link first and keeps the main checkout's node_modules", () => {
    setupDeps();
    setPanes([repo]);
    const o = JSON.parse(spawn("--base", "main").out);
    rmSync(join(o.worktree, "node_modules"), { recursive: true });
    sh(["ln", "-s", join(repo, "node_modules"), join(o.worktree, "node_modules")]);
    setPanes([]);
    const r = sh(["python3", SCRIPT, "--cleanup"]);
    expect(r.out).toContain("removed");
    expect(existsSync(o.worktree)).toBe(false);
    expect(existsSync(join(repo, "node_modules/pkg/index.js"))).toBe(true);
  });
  test("a kept (unmerged) worktree keeps its legacy link after cleanup", () => {
    setupDeps();
    setPanes([repo]);
    const o = JSON.parse(spawn("--base", "main").out);
    rmSync(join(o.worktree, "node_modules"), { recursive: true });
    sh(["ln", "-s", join(repo, "node_modules"), join(o.worktree, "node_modules")]);
    writeFileSync(join(o.worktree, "b.txt"), "b\n");
    sh(["git", "-C", o.worktree, "add", "b.txt"]);
    sh(["git", "-C", o.worktree, "commit", "-qm", "b"]);
    setPanes([]);
    const r = sh(["python3", SCRIPT, "--cleanup"]);
    expect(r.out).toContain("not merged");
    expect(sh(["test", "-L", join(o.worktree, "node_modules")]).code).toBe(0);
  });
});
