// fm-spawn (scripts/fm-spawn, Orca #7): worktree decision, tab start, card update, safe cleanup.
// Uses a scratch git repo under /tmp, a fake herdr and a fake fm, so no real tab or card changes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from "node:fs";
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
    // the maintenance pause flag (card omp-pause-button): a scratch path, so a real pause never blocks these tests
    OMP_MAINT_PAUSED: join(dir, "paused.json"),
    // the dev freeze flag (card dev-freeze-gate): a scratch path, so a live freeze never blocks these tests
    FM_DEV_FREEZE: join(dir, "frozen.json"),
    // the stack catalog (owner 2026-10-28): a scratch file, so auto-created stacks never reach the real catalog
    OMP_BOT_STACKS: join(dir, "stacks.json"),
    // stack fallback: 3 quick tries, then a fake omp-notify that logs (the default transport fails; ntfy works)
    FM_SPAWN_FALLBACK_DELAYS: "0,0", FM_SPAWN_NOTIFY: join(dir, "omp-notify"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    // no user git config (e.g. remote.origin.followRemoteHEAD) may change what these tests see
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  // fake herdr: pane list from panes.json; tab create returns ids; process-info says omp; logs every call
  writeFileSync(join(dir, "herdr"), `#!/bin/bash
printf '%s\\n' "herdr $*" >> ${dir}/calls.log
case "$1 $2" in
  "pane list") printf '{"result":{"panes":%s}}' "$(cat ${dir}/panes.json)";;
  "tab list") printf '{"result":{"tabs":%s}}' "$(cat ${dir}/tabs.json 2>/dev/null || echo '[]')";;
  "tab create") echo '{"result":{"tab":{"tab_id":"wT:t9"},"root_pane":{"pane_id":"wT:p9"}}}';;
  "pane process-info") echo '{"result":{"process_info":{"foreground_processes":[{"name":"omp"}]}}}';;
  "pane get") m=$(cat ${dir}/agent-mode 2>/dev/null || echo ok); st=working
    if [ "$m" = never ]; then st=idle; fi
    if [ "$m" = enter ] && ! grep -q "send-keys" ${dir}/calls.log; then st=idle; fi
    if [ "$m" = reprompt ] && [ "$(grep -c "agent prompt" ${dir}/calls.log)" -lt 2 ]; then st=idle; fi
    printf '{"result":{"pane":{"pane_id":"%s","agent_status":"%s"}}}' "$3" "$st";;
  "pane read") cat ${dir}/screen.txt 2>/dev/null;;
esac
`);
  // fake fm: logs every call; `fm get <id>` prints cards/<id>.json when present
  writeFileSync(join(dir, "fm"), `#!/bin/bash\nprintf '%s\\n' "fm $*" >> ${dir}/calls.log\n[ "$1" = get ] && cat ${dir}/cards/$2.json 2>/dev/null\nexit 0\n`);
  // fake fm-tabwatch: one finished fm-spawn tab and one that only looks finished
  writeFileSync(join(dir, "fm-tabwatch"), `#!/bin/bash\necho '{"tabs":31,"closable":[{"tab":"wT:t1","label":"🧪 done job","card":"c0","why":"receipt done"}],"look_finished":[{"tab":"wT:t2","label":"old tab","status":"done"}]}'\n`);
  chmodSync(join(dir, "fm-tabwatch"), 0o755);
  writeFileSync(join(dir, "omp-notify"), `#!/bin/bash\nprintf '%s\\n' "notify[\${OMP_NOTIFY_TRANSPORT:-default}] $*" >> ${dir}/calls.log\n[ "\${OMP_NOTIFY_TRANSPORT:-}" = ntfy ]\n`);
  chmodSync(join(dir, "omp-notify"), 0o755);
  chmodSync(join(dir, "herdr"), 0o755);
  chmodSync(join(dir, "fm"), 0o755);
  writeFileSync(join(dir, "task.md"), "# task\nFlow: short\n## Acceptance check\n");
  sh(["git", "init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  setPanes([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fm-spawn start", () => {
  test("maintenance pause: refuses with exit 5 and starts no tab; works again after resume", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "paused.json"), JSON.stringify({ since: "2026-10-30T21:00:00-04:00", reason: "kernel update" }));
    const r = spawn();
    expect(r.code).toBe(5);
    expect(r.err).toContain("agent work is paused (kernel update)");
    expect(calls()).not.toContain("tab create");
    rmSync(join(dir, "paused.json"));
    expect(spawn().code).toBe(0);
  });

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

  test("prompt check (card fm-spawn-prompt-verify): started first time -> one prompt, card running", () => {
    setPanes(["/elsewhere"]);
    expect(spawn("--card", "c1").code).toBe(0);
    const c = calls();
    expect(c.match(/agent prompt/g)!.length).toBe(1);
    expect(c).not.toContain("send-keys");
    expect(c).toMatch(/fm set c1 running/);
  });

  test("prompt check: text left in the editor -> one Enter retry, then running", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "agent-mode"), "enter");
    writeFileSync(join(dir, "screen.txt"), `> Read ${dir}/task.md and do the task. Owner questions`);
    env.FM_SPAWN_PROMPT_WAIT_S = "0.3";
    expect(spawn("--card", "c1").code).toBe(0);
    const c = calls();
    expect(c).toContain("pane send-keys wT:p9 enter");
    expect(c.match(/agent prompt/g)!.length).toBe(1);
    expect(c).toMatch(/fm set c1 running/);
  });

  test("prompt check: long paste shown as an OMP placeholder -> Enter retry, no second prompt", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "agent-mode"), "enter");
    writeFileSync(join(dir, "screen.txt"), "> [Paste #1, 2412 chars]");
    env.FM_SPAWN_PROMPT_WAIT_S = "0.3";
    expect(spawn("--card", "c1").code).toBe(0);
    const c = calls();
    expect(c).toContain("pane send-keys wT:p9 enter");
    expect(c.match(/agent prompt/g)!.length).toBe(1);
  });

  test("prompt check: empty editor -> prompt sent again, then running", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "agent-mode"), "reprompt");
    env.FM_SPAWN_PROMPT_WAIT_S = "0.3";
    expect(spawn("--card", "c1").code).toBe(0);
    const c = calls();
    expect(c.match(/agent prompt/g)!.length).toBe(2);
    expect(c).toMatch(/fm set c1 running/);
  });

  test("prompt check: never started -> exit nonzero, card partial (not running), tab left open", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "agent-mode"), "never");
    env.FM_SPAWN_PROMPT_WAIT_S = "0.3";
    const r = spawn("--card", "c1");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("did not start the prompt");
    const c = calls();
    expect(c).toContain("fm set c1 partial [prompt not submitted; needs check]");
    expect(c).not.toMatch(/fm set c1 running/);
    expect(c).not.toContain("tab close");
  });

  test("brief lint (pstack): a bare task file warns and asks the session for its own done check and verify step", () => {
    setPanes(["/elsewhere"]);
    const r = spawn("--card", "c1");
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning: task file has no verify step (brief lint)");
    const c = calls();
    expect(c).toContain("The task file names no verify step: write your own before you start");
    expect(c).toContain("--verified live|tests --evidence <commit/file/URL>");
    expect(c).toContain("For engineering work follow skill pstack (playbook + principles).");
  });

  test("brief lint: a task file with goal, acceptance and verify steps sends no gap note", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "task.md"), "# Task: fix it\nFlow: full\n## Acceptance check\n- the bug is gone\n## Verify\n- run bun test\n");
    const r = spawn("--card", "c1");
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("brief lint");
    expect(calls()).not.toContain("The task file names no");
  });

  test("standard flow (card sdlc-standard-flow): a task file without Acceptance check or Flow line is refused", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "task.md"), "# Task: fix it\n## Acceptance\n- the bug is gone\n");
    const r = spawn("--card", "c1");
    expect(r.code).toBe(5);
    expect(r.err).toContain("refused");
    expect(r.err).toContain("Acceptance check");
    expect(r.err).toContain("Flow: full|short");
    expect(calls()).not.toContain("agent prompt");
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
    expect(spawn("--stack", "Not A Name!").code).not.toBe(0);
  }, 20_000); // runs fm-spawn several times; over 5 s under load (restart gate 2026-11-01)

  test("catalog (owner 2026-10-28): --stack accepts any name and adds an unknown one; a new area makes a new stack", () => {
    setPanes(["/elsewhere"]);
    const catalog = () => (existsSync(join(dir, "stacks.json")) ? (JSON.parse(readFileSync(join(dir, "stacks.json"), "utf8")).stacks as { name: string; areas?: string[]; addedBy?: string }[]) : []);
    // dry runs never write the catalog
    expect(JSON.parse(spawn("--stack", "boats", "--dry-run").out).stack).toBe("boats");
    expect(catalog()).toEqual([]);
    expect(JSON.parse(spawn("--stack", "boats").out).stack).toBe("boats");
    expect(catalog().map((s) => [s.name, s.addedBy])).toEqual([["boats", "fm-spawn auto"]]);
    sh(["mkdir", "-p", join(dir, "cards")]);
    writeFileSync(join(dir, "cards", "c3.json"), JSON.stringify({ id: "c3", area: "Boat Repair: hull" }));
    expect(JSON.parse(spawn("--card", "c3").out).stack).toBe("boat-repair");
    expect(catalog().find((s) => s.name === "boat-repair")!.areas).toEqual(["boat repair"]);
    // the same area again maps to that stack (no second entry)
    expect(JSON.parse(spawn("--card", "c3").out).stack).toBe("boat-repair");
    expect(catalog().filter((s) => s.name === "boat-repair")).toHaveLength(1);
  });

  test("catalog areas and keywords route cards to catalog stacks", () => {
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "stacks.json"), JSON.stringify({ version: 1, stacks: [
      { name: "infra", areas: ["tools", "infra"] },
      { name: "discord", emoji: "💬", areas: ["discord", "discord bot"], keywords: ["queue message", "discord"] },
      { name: "home", keywords: ["doorbell"] },
    ] }));
    sh(["mkdir", "-p", join(dir, "cards")]);
    writeFileSync(join(dir, "cards", "c1.json"), JSON.stringify({ id: "c1", area: "Discord" }));
    writeFileSync(join(dir, "cards", "c4.json"), JSON.stringify({ id: "c4", t: "Charge the Ring doorbell" }));
    expect(JSON.parse(spawn("--card", "c1").out).stack).toBe("discord");
    expect(JSON.parse(spawn("--card", "c4").out).stack).toBe("home");
    expect(JSON.parse(spawn("--label", "fix the queue-message footer").out).stack).toBe("discord");
  });

  test("STACK_KEYWORDS matches the router's DEFAULT_STACKS keywords", () => {
    const r = sh(["python3", "-c", `import runpy,json;print(json.dumps(runpy.run_path(${JSON.stringify(SCRIPT)},run_name="x")["STACK_KEYWORDS"]))`]);
    expect(JSON.parse(r.out)).toEqual(Object.fromEntries(DEFAULT_STACKS.map((s) => [s.name, s.keywords])));
  });

  test("built-in keywords and the webapp rule beat an unknown area (no needless new stack)", () => {
    setPanes(["/elsewhere"]);
    sh(["mkdir", "-p", join(dir, "cards")]);
    writeFileSync(join(dir, "cards", "c5.json"), JSON.stringify({ id: "c5", area: "Paperwork", t: "pay the tax bill before the deadline" }));
    writeFileSync(join(dir, "cards", "c6.json"), JSON.stringify({ id: "c6", area: "Web", t: "webapp settings page" }));
    expect(JSON.parse(spawn("--card", "c5").out).stack).toBe("finance");
    expect(JSON.parse(spawn("--card", "c6").out).stack).toBe("webapp");
    expect(existsSync(join(dir, "stacks.json"))).toBe(false);
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

describe("fm-spawn per-stack cap + queue (owner 2026-11-01, card fm-job-cap-ci-wait)", () => {
  const queue = () => {
    const f = join(dir, "state", "queued.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const cards = (list: Record<string, unknown>[]) => writeFileSync(join(dir, "items.json"), JSON.stringify({ items: list }));
  const receipt = (card: string, result: string, tsMs: number, summary = "x") => {
    mkdirSync(join(dir, "receipts"), { recursive: true });
    writeFileSync(join(dir, "receipts", `${card}.json`), JSON.stringify({ card, result, tsMs, summary }));
  };
  const drain = (...extra: string[]) => sh(["python3", SCRIPT, "--drain-queue", ...extra]);
  const launches = () => calls().split("\n").filter((l) => l.startsWith("launch "));
  beforeEach(() => {
    // three live webapp jobs: wT:p0..p2 (wT:p3 is a pane elsewhere)
    setPanes(["/v0", "/v1", "/v2", "/elsewhere"]);
    cards([0, 1, 2].map((i) => ({ id: `v${i}`, s: "running", stack: "webapp", job: `wT:p${i}`, t: `webapp job ${i}` })));
    // the drained spawn runs through a fake launcher that only logs its argv
    writeFileSync(join(dir, "launcher"), `#!/bin/bash\nprintf '%s\\n' "launch $*" >> ${dir}/calls.log\n`);
    chmodSync(join(dir, "launcher"), 0o755);
    env.FM_SPAWN_LAUNCHER = join(dir, "launcher");
  });

  test("dry run: a 4th webapp job reports queued at position 1 and creates nothing; another stack is not affected", () => {
    const r = spawn("--stack", "webapp", "--card", "v4", "--dry-run");
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out)).toMatchObject({ dry_run: true, queued: true, position: 1, stack: "webapp", cap: 3, live: ["v0", "v1", "v2"] });
    expect(r.err).toContain("Nothing was created");
    expect(queue()).toHaveLength(0);
    expect(calls()).not.toContain("tab create");
    expect(calls()).not.toContain("fm set");
    const k = spawn("--stack", "kb", "--card", "k1", "--dry-run");
    expect(k.code).toBe(0);
    expect(JSON.parse(k.out).queued).toBeUndefined();
  });

  test("at the cap: queued (exit 6) in FIFO order, card planned with a note; under the cap it starts", () => {
    const r = spawn("--stack", "webapp", "--card", "v4");
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out)).toMatchObject({ queued: true, position: 1 });
    expect(spawn("--stack", "webapp", "--card", "v5").code).toBe(6);
    expect(queue().map((q) => [q.card, q.stack, q.workspace])).toEqual([["v4", "webapp", "wT"], ["v5", "webapp", "wT"]]);
    expect(calls()).toContain("fm set v4 planned 📥 Queued by fm-spawn: stack webapp is at its cap of 3 live jobs; position 1.");
    expect(calls()).not.toContain("tab create");
    cards([0, 1].map((i) => ({ id: `v${i}`, s: "running", stack: "webapp", job: `wT:p${i}` })));
    // a free slot, but v4/v5 wait: a new spawn may not jump the queue
    expect(JSON.parse(spawn("--stack", "webapp", "--card", "v6").out).position).toBe(3);
    rmSync(join(dir, "state", "queued.jsonl"));
    expect(spawn("--stack", "webapp", "--card", "v6").code).toBe(0);
    expect(calls()).toContain("tab create");
    // the reservation ends with the spawned.jsonl record
    expect(JSON.parse(readFileSync(join(dir, "state", "reserved.json"), "utf8"))).toEqual([]);
    expect(readFileSync(join(dir, "state", "spawned.jsonl"), "utf8")).toContain('"stack": "webapp"');
  }, 20_000);

  test("a CI-wait blocked receipt keeps the slot; a done receipt or a gone pane frees it; the drain starts the oldest", () => {
    // v1 wrote a blocked receipt: fm-autoclear made the card partial and unlinked the job; its pane still lives
    cards([
      { id: "v0", s: "running", stack: "webapp", job: "wT:p0" },
      { id: "v1", s: "partial", stack: "webapp" },
      { id: "v2", s: "running", stack: "webapp", job: "wT:p2" },
    ]);
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "spawned.jsonl"), JSON.stringify({ tsMs: 1000, pane: "wT:p1", card: "v1", stack: "webapp" }) + "\n");
    receipt("v1", "blocked", 2000, "waiting on CI: PR #12, run https://x/1, 40 jobs queued ahead since 14:05Z");
    expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
    expect(spawn("--stack", "webapp", "--card", "v5").code).toBe(6);
    expect(drain().code).toBe(0);
    expect(launches()).toHaveLength(0);
    expect(queue()).toHaveLength(2);
    receipt("v1", "done", 3000);
    expect(drain("--dry-run").out).toContain("DRY would start queued 🧪 test job (stack webapp, card v4)");
    expect(queue()).toHaveLength(2);
    expect(drain().code).toBe(0);
    expect(launches()).toHaveLength(1);
    expect(launches()[0]).toContain("--stack webapp --workspace wT --queue-id");
    expect(launches()[0]).toContain("--card v4");
    expect(queue().map((q) => q.card)).toEqual(["v5"]);
    // the pane of v2 is gone: one more slot
    setPanes(["/v0", "/v1"]);
    expect(drain().code).toBe(0);
    expect(queue()).toHaveLength(0);
    expect(launches().pop()).toContain("--card v5");
  }, 20_000);

  test("one job tab is one slot, also when several cards name it", () => {
    cards([
      { id: "v0", s: "running", stack: "webapp", job: "wT:p0" },
      { id: "v1", s: "running", stack: "webapp", job: "wT:p0" },
      { id: "v2", s: "running", stack: "webapp", job: "wT:p1" },
    ]);
    expect(spawn("--stack", "webapp", "--card", "v4", "--dry-run").code).toBe(0);
  });

  test("a blocked receipt that does not wait on CI frees the slot", () => {
    cards([
      { id: "v0", s: "running", stack: "webapp", job: "wT:p0" },
      { id: "v1", s: "partial", stack: "webapp" },
      { id: "v2", s: "running", stack: "webapp", job: "wT:p2" },
    ]);
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "spawned.jsonl"), JSON.stringify({ tsMs: 1000, pane: "wT:p1", card: "v1", stack: "webapp" }) + "\n");
    receipt("v1", "blocked", 2000, "needs the owner's pick");
    expect(spawn("--stack", "webapp", "--card", "v4", "--dry-run").code).toBe(0);
  });

  test("finished spawned panes free the slot; working, blocked, CI-wait, new and running-card jobs hold it (card fm-spawn-dead-slots)", () => {
    // tab per pane; Herdr agent_status per pane
    const herdrPanes = (st: Record<string, { s?: string; title?: string }>) =>
      writeFileSync(join(dir, "panes.json"), JSON.stringify(Object.entries(st).map(([p, v]) => ({
        pane_id: `wT:${p}`, tab_id: `wT:t${p}`, workspace_id: "wT", cwd: `/${p}`, foreground_cwd: `/${p}`,
        agent_status: v.s, terminal_title: v.title ?? "omp" }))));
    cards([
      { id: "v0", s: "running", stack: "webapp", job: "wT:p0" }, // (d) running card with job: held even when its pane is done
      { id: "v1", s: "partial", stack: "webapp", n: "⏸️ Paused by owner" }, // (a) done pane, no receipt
      { id: "v2", s: "partial", stack: "webapp" }, // (b) done pane, CI-wait blocked receipt
      { id: "v3", s: "partial", stack: "webapp" }, // (c) working pane
    ]);
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "spawned.jsonl"), ["p1", "p2", "p3"].map((p, i) =>
      JSON.stringify({ tsMs: 1000, pane: `wT:${p}`, tab: `wT:t${p}`, card: `v${i + 1}`, stack: "webapp" })).join("\n") + "\n");
    receipt("v2", "blocked", 2000, "waiting on CI: PR #3, run https://x/2, 12 jobs queued ahead since 13:00Z");
    const live = () => {
      const r = spawn("--stack", "webapp", "--card", "v4", "--dry-run");
      return r.code === 6 ? JSON.parse(r.out).live : r.code === 0 ? "free" : `exit ${r.code}: ${r.err}`;
    };
    herdrPanes({ p0: { s: "done" }, p1: { s: "done" }, p2: { s: "done" }, p3: { s: "working" } });
    expect(live()).toEqual(["v0", "v2", "v3"]); // (a) v1 is free; (b) (c) (d) hold
    herdrPanes({ p0: { s: "done" }, p1: { s: "done" }, p2: { s: "done" }, p3: { s: "idle" } });
    expect(live()).toBe("free"); // (c) the working pane finished: its slot frees
    herdrPanes({ p0: { s: "done" }, p1: { s: "idle", title: "⠋ omp" }, p2: { s: "done" }, p3: { s: "blocked" } });
    expect(live()).toEqual(["v0", "v1", "v2", "v3"]); // spinner in the title = working; blocked = waits for input
    // a CI-wait receipt older than the spawn does not count
    receipt("v2", "blocked", 500, "waiting on CI: PR #3");
    herdrPanes({ p0: { s: "done" }, p1: { s: "done" }, p2: { s: "done" }, p3: { s: "done" } });
    expect(live()).toBe("free");
    // a CI-wait receipt without tsMs counts as written after the spawn (old behaviour kept); v3 works again
    writeFileSync(join(dir, "receipts", "v2.json"), JSON.stringify({ card: "v2", result: "blocked", summary: "waiting on CI: PR #3" }));
    herdrPanes({ p0: { s: "done" }, p1: { s: "done" }, p2: { s: "done" }, p3: { s: "working" } });
    expect(live()).toEqual(["v0", "v2", "v3"]);
    receipt("v2", "done", 3000);
    // spawns without a card, panes without tab_id: a done pane frees, a working pane holds (key = pane id)
    writeFileSync(join(dir, "state", "spawned.jsonl"), ["p5", "p6", "p7"].map((p) =>
      JSON.stringify({ tsMs: 1000, pane: `wT:${p}`, stack: "webapp" })).join("\n") + "\n");
    writeFileSync(join(dir, "panes.json"), JSON.stringify([
      { pane_id: "wT:p0", tab_id: "wT:tp0", workspace_id: "wT", agent_status: "done" },
      { pane_id: "wT:p5", workspace_id: "wT", agent_status: "done" },
      { pane_id: "wT:p6", workspace_id: "wT", agent_status: "working" },
      { pane_id: "wT:p7", workspace_id: "wT", agent_status: "blocked" },
    ]));
    expect(live()).toEqual(["v0", "wT:p6", "wT:p7"]);
    // a spawn younger than LAUNCH_HOLD_S holds its slot before the agent starts
    writeFileSync(join(dir, "state", "spawned.jsonl"), ["p1", "p2"].map((p, i) =>
      JSON.stringify({ tsMs: Date.now(), pane: `wT:${p}`, card: `v${i + 1}`, stack: "webapp" })).join("\n") + "\n");
    herdrPanes({ p0: { s: "done" }, p1: { s: "idle" }, p2: { s: "idle" } });
    expect(live()).toEqual(["v0", "v1", "v2"]);
  }, 20_000);

  test("a card already in the queue keeps its place; no second entry", () => {
    expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
    expect(spawn("--stack", "webapp", "--card", "v5").code).toBe(6);
    const again = spawn("--stack", "webapp", "--card", "v4");
    expect(again.code).toBe(6);
    expect(JSON.parse(again.out)).toMatchObject({ position: 1, already: true });
    expect(queue().map((q) => q.card)).toEqual(["v4", "v5"]);
    expect(calls().match(/fm set v4 planned/g)).toHaveLength(1);
  });

  test("the drain drops entries whose card is done, parked or running; a long wait gets one alert", async () => {
    expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
    expect(spawn("--stack", "webapp", "--card", "v5").code).toBe(6);
    expect(spawn("--stack", "webapp", "--card", "v6").code).toBe(6);
    cards([
      ...[0, 1, 2].map((i) => ({ id: `v${i}`, s: "running", stack: "webapp", job: `wT:p${i}` })),
      { id: "v4", s: "done" }, { id: "v5", s: "backlog" }, { id: "v6", s: "planned" },
    ]);
    env.FM_SPAWN_QUEUE_ALERT_S = "0";
    const r = drain();
    expect(r.out).toContain("dropped queued 🧪 test job (card v4: done)");
    expect(r.out).toContain("dropped queued 🧪 test job (card v5: backlog)");
    expect(r.out).toContain("📥 fm-spawn queue: `v6` has waited");
    expect(queue().map((q) => q.card)).toEqual(["v6"]);
    expect(queue()[0].alerted).toBeUndefined(); // the post failed (no bot): tried again next tick
    const posts: { channel?: string; text: string }[] = [];
    const srv = Bun.serve({ port: 0, fetch: async (req) => {
      posts.push((await req.json()) as { channel?: string; text: string });
      return Response.json({ ok: true, url: "https://discord/x/1" });
    } });
    env.FM_SPAWN_POST_URL = `http://127.0.0.1:${srv.port}/post`;
    try {
      const p = Bun.spawn(["python3", SCRIPT, "--drain-queue"], { env: { ...process.env, ...env }, stdout: "pipe" });
      await p.exited;
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ channel: "omp-alerts" });
      expect(typeof queue()[0].alerted).toBe("number");
      const p2 = Bun.spawn(["python3", SCRIPT, "--drain-queue"], { env: { ...process.env, ...env }, stdout: "pipe" });
      await p2.exited;
      expect(posts).toHaveLength(1);
    } finally {
      srv.stop(true);
    }
    expect(launches()).toHaveLength(0);
  }, 20_000);

  test("a queued start that fails goes back to the head; after 3 failures it leaves the queue with a card note", () => {
    const run = (n: number) => sh(["python3", SCRIPT, "--label", "🧪 test job", "--cwd", repo, "--task", join(dir, "gone.md"),
      "--stack", "webapp", "--card", "v7", "--workspace", "wT", "--queue-id", "qF", "--queue-attempts", String(n)]);
    expect(run(0).code).toBe(1);
    expect(queue()).toMatchObject([{ id: "qF", attempts: 1, card: "v7" }]);
    expect(run(2).code).toBe(1);
    expect(queue()).toHaveLength(0);
    expect(calls()).toContain("fm set v7 partial 📥 fm-spawn queue: the queued start failed 3 times");
  });

  test("a drained spawn that lost the race goes back to the head without a second card note", () => {
    expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
    const r = spawn("--stack", "webapp", "--card", "v9", "--queue-id", "qX", "--workspace", "wT");
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out).position).toBe(1);
    expect(queue().map((q) => q.card)).toEqual(["v9", "v4"]);
    expect(queue()[0].id).toBe("qX");
    expect(calls()).not.toContain("fm set v9");
  });

  test("pause and the 30-tab cap keep the queue; the cap config can lift or add caps", () => {
    expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
    setPanes(["/elsewhere"]);
    writeFileSync(join(dir, "paused.json"), JSON.stringify({ reason: "kernel update" }));
    expect(drain().out).toContain("paused (kernel update); queue kept");
    rmSync(join(dir, "paused.json"));
    writeFileSync(join(dir, "tabs.json"), JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ tab_id: `wT:t${i}` }))));
    expect(drain().out).toContain("over 30 tabs");
    expect(launches()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    rmSync(join(dir, "tabs.json"));
    // a drained spawn refused by the pause goes back to the head
    writeFileSync(join(dir, "paused.json"), JSON.stringify({ reason: "p" }));
    expect(spawn("--stack", "webapp", "--card", "v8", "--queue-id", "qP", "--workspace", "wT").code).toBe(5);
    expect(queue()[0].id).toBe("qP");
    rmSync(join(dir, "paused.json"));
    // stack-caps.json: 0 lifts the webapp cap, a number caps another stack
    setPanes(["/v0", "/v1", "/v2", "/k0"]);
    rmSync(join(dir, "state", "queued.jsonl"));
    writeFileSync(join(dir, "stack-caps.json"), JSON.stringify({ webapp: 0, kb: 1 }));
    cards([...[0, 1, 2].map((i) => ({ id: `v${i}`, s: "running", stack: "webapp", job: `wT:p${i}` })), { id: "k0", s: "running", stack: "kb", job: "wT:p3" }]);
    expect(spawn("--stack", "webapp", "--card", "v4", "--dry-run").code).toBe(0);
    expect(spawn("--stack", "kb", "--card", "k1", "--dry-run").code).toBe(6);
  }, 20_000);

  test("dev freeze (card dev-freeze-gate): regular stacks wait in the queue; firstmate/infra start; the drain keeps them until the flag is gone", () => {
    setPanes(["/elsewhere"]);
    cards([]);
    const flag = join(dir, "frozen.json");
    writeFileSync(flag, JSON.stringify({ reason: "dev setup" }));
    const r = spawn("--stack", "kb", "--card", "k1");
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out)).toMatchObject({ queued: true, frozen: "dev setup", stack: "kb" });
    expect(r.err).toContain("regular work is frozen (dev setup)");
    expect(calls()).toContain("fm set k1 planned ⏸️ Held by dev-freeze-gate");
    expect(calls()).not.toContain("tab create");
    expect(spawn("--stack", "kb", "--card", "k1").code).toBe(6);
    expect(queue().map((q) => q.card)).toEqual(["k1"]);
    expect(spawn("--stack", "infra", "--card", "i1").code).toBe(0);
    expect(calls()).toContain("tab create");
    drain();
    expect(launches()).toHaveLength(0);
    expect(queue().map((q) => q.card)).toEqual(["k1"]);
    // stop-sync: a card stopped while queued leaves the queue instead of starting
    expect(spawn("--stack", "kb", "--card", "k2").code).toBe(6);
    cards([{ id: "k2", s: "partial", n: "⏹️ Stopped: owner" }]);
    rmSync(flag);
    expect(drain().out).toContain("k2: card stopped");
    expect(launches()).toHaveLength(1);
    expect(queue()).toHaveLength(0);
  }, 20_000);

  describe("CI-wait resume (card fm-ci-wait-no-resume)", () => {
    const GREEN = { state: "OPEN", statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }, { context: "cf", state: "SUCCESS" }] };
    const PENDING = { state: "OPEN", statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "core", status: "QUEUED", conclusion: "" }] };
    const FAILED = { state: "OPEN", statusCheckRollup: [{ name: "core", status: "COMPLETED", conclusion: "FAILURE" }] };
    const gh = (pr: number, d: unknown) => writeFileSync(join(dir, `gh-pr-${pr}.json`), JSON.stringify(d));
    const ledger = () => {
      const f = join(dir, "state", "ci-wait.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    };
    const enqueue = (card: string) => writeFileSync(join(dir, "state", "queued.jsonl"), [...queue(), { id: `q-${card}`, tsMs: Date.now(),
      stack: "webapp", label: `📈 ${card} resume`, cwd: repo, task: join(dir, "task.md"), card, workspace: "wT", no_worktree: false, attempts: 0 }]
      .map((q) => JSON.stringify(q)).join("\n") + "\n");
    let T = 0; // the receipt time: recent (receipts older than 7 days are not watched)
    const CI_SUMMARY = "waiting on CI: PR #12, run https://github.com/o/r/actions/runs/1, 40 jobs queued ahead since 14:05Z";
    beforeEach(() => {
      // fake gh: `gh pr view N --json ... [-R repo]` prints gh-pr-N.json; logs every call
      writeFileSync(join(dir, "gh"), `#!/bin/bash\nprintf '%s\\n' "gh $*" >> ${dir}/calls.log\ncat ${dir}/gh-pr-$3.json\n`);
      chmodSync(join(dir, "gh"), 0o755);
      env.FM_SPAWN_GH = join(dir, "gh");
      // v1 wrote a CI-wait receipt; fm-autoclear made it partial; its idle pane wT:p1 still lives (webapp at cap 3)
      cards([
        { id: "v0", s: "running", stack: "webapp", job: "wT:p0" },
        { id: "v1", s: "partial", stack: "webapp", t: "webapp job 1" },
        { id: "v2", s: "running", stack: "webapp", job: "wT:p2" },
      ]);
      mkdirSync(join(dir, "state"), { recursive: true });
      writeFileSync(join(dir, "task.md"), "# task\nFlow: full\n## Acceptance check\n- it works\n");
      writeFileSync(join(dir, "state", "spawned.jsonl"), JSON.stringify({ tsMs: 1000, pane: "wT:p1", tab: "wT:t1", card: "v1",
        stack: "webapp", cwd: repo, label: "📈 job one", workspace: "wT", task: join(dir, "task.md") }) + "\n");
      T = Date.now() - 60_000;
      receipt("v1", "blocked", T, CI_SUMMARY);
    });

    test("green CI: the wait ends, its slot frees and the resume starts in the same tick; other queued jobs keep waiting", () => {
      expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
      gh(12, PENDING);
      const p = drain();
      expect(p.code).toBe(0);
      expect(calls()).toContain("gh pr view 12 --json state,statusCheckRollup -R o/r");
      expect(launches()).toHaveLength(0);
      expect(queue().map((q) => q.card)).toEqual(["v4"]);
      expect(ledger()[`v1:${T}`]).toMatchObject({ pr: 12, repo: "o/r", ci: "pending" });
      // dry run on green: reports the resume and the start, writes nothing
      gh(12, GREEN);
      const d = drain("--dry-run");
      expect(d.out).toContain("DRY would have CI wait v1: PR #12 green (2 checks passed); queued its resume at the head of the webapp queue");
      expect(d.out).toContain("DRY would start queued 🔁 📈 job one (stack webapp, card v1)");
      expect(queue().map((q) => q.card)).toEqual(["v4"]);
      expect(ledger()[`v1:${T}`].ciDone).toBeUndefined();
      // one real tick
      const r = drain();
      expect(r.out).toContain("CI wait v1: PR #12 green (2 checks passed); queued its resume at the head of the webapp queue");
      expect(launches()).toHaveLength(1);
      const l = launches()[0]!;
      expect(l).toContain("--label 🔁 📈 job one");
      expect(l).toContain(`--cwd ${repo}`);
      expect(l).toContain("--card v1");
      expect(l).toContain("--no-worktree");
      expect(queue().map((q) => q.card)).toEqual(["v4"]);
      expect(typeof ledger()[`v1:${T}`].ciDone).toBe("number");
      expect(calls()).toContain("fm set v1 planned 🔁 CI wait ended: PR #12 green (2 checks passed).");
      const task = l.match(/--task (\S+)/)![1]!;
      const text = readFileSync(task, "utf8");
      expect(text).toContain("Flow: full");
      expect(text).toContain(`Original task file: \`${join(dir, "task.md")}\``);
      expect(text).toContain("## Acceptance check");
      expect(text).toContain(CI_SUMMARY);
      // the ended wait holds no slot: a second resume entry would not be needed; v4 needs a slot of its own
      const live = spawn("--stack", "webapp", "--card", "v9", "--dry-run");
      expect(JSON.parse(live.out).live).not.toContain("v1");
      // no second resume and no second gh call for the same receipt
      const n = calls().split("\n").filter((x) => x.startsWith("gh ")).length;
      drain();
      expect(launches()).toHaveLength(1);
      expect(calls().split("\n").filter((x) => x.startsWith("gh ")).length).toBe(n);
    }, 30_000);

    test("a resume task chain keeps the first task file; the resume task names the merge-back steps of its worktree", () => {
      const wt = join(dir, "scratch-wt-x");
      git("worktree", "add", "-q", "-b", "ws/x", wt);
      writeFileSync(join(dir, "state", "worktrees.json"), JSON.stringify({ worktrees: [{ repo, path: wt, branch: "ws/x", base: "origin/main", task: join(dir, "task.md"), card: "v1" }] }));
      mkdirSync(join(dir, "state", "resume"), { recursive: true });
      const older = join(dir, "state", "resume", "v1-1.md");
      writeFileSync(older, `# Resume\nFlow: full\nOriginal task file: \`${join(dir, "task.md")}\`\n## Acceptance check\n`);
      writeFileSync(join(dir, "state", "spawned.jsonl"), JSON.stringify({ tsMs: 1000, pane: "wT:p1", card: "v1", stack: "webapp",
        cwd: wt, worktree: wt, workspace: "wT", task: older }) + "\n");
      gh(12, FAILED);
      expect(drain().out).toContain("CI wait v1: PR #12 failed (1 of 1 checks failed: core)");
      const text = readFileSync(launches()[0]!.match(/--task (\S+)/)![1]!, "utf8");
      expect(text).toContain(`Original task file: \`${join(dir, "task.md")}\``);
      expect(text).toContain("CI did not pass");
      expect(text).toContain(`flock /tmp/scratch-integrate.lock git -C ${repo} merge --ff-only ws/x`);
      expect(launches()[0]).toContain(`--cwd ${wt}`);
    }, 30_000);

    test("the card's own queued resume takes over its CI-wait slot while CI still runs (does not wait behind it)", () => {
      expect(spawn("--stack", "webapp", "--card", "v4").code).toBe(6);
      enqueue("v1"); // FIRSTMATE queued the resume while the old job still worked
      expect(queue().map((q) => q.card)).toEqual(["v4", "v1"]);
      gh(12, PENDING);
      drain();
      expect(launches()).toHaveLength(1);
      expect(launches()[0]).toContain("--card v1");
      expect(queue().map((q) => q.card)).toEqual(["v4"]);
      const res = JSON.parse(readFileSync(join(dir, "state", "reserved.json"), "utf8"));
      expect(res).toMatchObject([{ stack: "webapp", own: true }]);
      // the started spawn (drained, --queue-id) passes the cap check on the same slot
      const s = spawn("--stack", "webapp", "--card", "v1", "--queue-id", res[0].qid, "--workspace", "wT");
      expect(s.code).toBe(0);
      expect(calls()).toContain("tab create");
      // a fresh spawn of the card itself also starts on its own CI-wait slot (no queue)
      expect(spawn("--stack", "webapp", "--card", "v1", "--dry-run").code).toBe(0);
      // another card does not get that slot: still at the cap
      expect(spawn("--stack", "webapp", "--card", "v8", "--dry-run").code).toBe(6);
    }, 30_000);

    test("CI green and the job does not start again within 15 min: one #omp-alerts line", async () => {
      enqueue("v1"); // its queued entry ...
      writeFileSync(join(dir, "tabs.json"), JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ tab_id: `wT:t${i}` }))));
      gh(12, GREEN);
      env.FM_SPAWN_CI_ALERT_S = "0";
      const posts: { channel?: string; text: string }[] = [];
      const srv = Bun.serve({ port: 0, fetch: async (req) => {
        posts.push((await req.json()) as { channel?: string; text: string });
        return Response.json({ ok: true, url: "https://discord/x/2" });
      } });
      env.FM_SPAWN_POST_URL = `http://127.0.0.1:${srv.port}/post`;
      try {
        for (let i = 0; i < 2; i++) {
          const p = Bun.spawn(["python3", SCRIPT, "--drain-queue"], { env: { ...process.env, ...env }, stdout: "pipe" });
          await p.exited;
        }
      } finally {
        srv.stop(true);
      }
      // ... cannot start (workspace over 30 tabs): moved to the head, one alert, no launch
      expect(launches()).toHaveLength(0);
      expect(queue()[0]).toMatchObject({ card: "v1", resume: "ci" });
      const alerts = posts.filter((p) => p.channel === "omp-alerts");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.text).toContain("`v1`: CI for PR #12 went green and the job has not started again (queue position 1)");
      expect(typeof ledger()[`v1:${T}`].alerted).toBe("number");
    }, 30_000);

    test("a running card is not resumed again; a receipt without a PR is not watched; old and done cards are skipped", () => {
      cards([
        { id: "v0", s: "running", stack: "webapp", job: "wT:p0" },
        { id: "v1", s: "running", stack: "webapp", job: "unit-x.service" },
        { id: "v2", s: "partial", stack: "webapp" },
        { id: "v3", s: "done", stack: "webapp" },
        { id: "v5", s: "partial", stack: "webapp" },
      ]);
      receipt("v2", "blocked", T, "waiting on CI: the pipeline");
      receipt("v3", "blocked", T, "waiting on CI: PR #13");
      receipt("v5", "blocked", Date.now() - 8 * 86400_000, "waiting on CI: PR #15");
      gh(12, GREEN);
      const r = drain();
      expect(r.out).toContain("CI wait v1: PR #12 green (2 checks passed); card already runs again");
      expect(r.out).toContain("CI wait v2: the receipt names no PR");
      expect(launches()).toHaveLength(0);
      expect(calls()).not.toContain("gh pr view 13");
      expect(calls()).not.toContain("gh pr view 15");
      expect(calls()).not.toContain("fm set v1");
      // the ended wait of the running card frees the idle pane's slot
      expect(JSON.parse(spawn("--stack", "webapp", "--card", "v9", "--dry-run").out).queued).toBeUndefined();
    }, 30_000);

    const rawReceipt = (card: string, r: Record<string, unknown>) =>
      writeFileSync(join(dir, "receipts", `${card}.json`), JSON.stringify({ card, result: "blocked", ...r }));

    test("PR from a /pull/N evidence link; merged PR ends the wait; no repo URL and no folder is not looked up", () => {
      rawReceipt("v1", { tsMs: T, summary: "waiting on CI: the deploy lane", evidence: ["https://github.com/o/r/pull/12"] });
      gh(12, { state: "MERGED", statusCheckRollup: [] });
      const r = drain();
      expect(calls()).toContain("gh pr view 12 --json state,statusCheckRollup -R o/r");
      expect(r.out).toContain("CI wait v1: PR #12 merged (PR merged); queued its resume");
      expect(launches()).toHaveLength(1);
      cards([{ id: "v0", s: "running", stack: "webapp", job: "wT:p0" }, { id: "v4", s: "partial", stack: "webapp" }]);
      // PR without a repo URL and no job folder: gh would read another repo's PR, so it is not looked up
      rawReceipt("v4", { tsMs: T, summary: "waiting on CI: PR #14" });
      const s2 = drain();
      expect(calls()).not.toContain("gh pr view 14");
      expect(s2.out).toContain("CI wait v4: the receipt names no PR (or no repo URL and no job folder); cannot watch it");
    }, 30_000);

    test("gh keeps failing: no slot change, one alert after the delay; a dry run writes nothing", async () => {
      // no gh-pr-12.json: the fake gh fails
      writeFileSync(join(dir, "gh"), `#!/bin/bash\nprintf '%s\\n' "gh $*" >> ${dir}/calls.log\necho 'HTTP 502' >&2\nexit 1\n`);
      env.FM_SPAWN_CI_ALERT_S = "0";
      const d = drain("--dry-run");
      expect(d.out).toContain("DRY CI wait v1: PR #12 unknown (HTTP 502)");
      expect(d.out).toContain("DRY 🔁 fm-spawn CI wait: `v1`: the CI state of PR #12 cannot be read");
      expect(existsSync(join(dir, "state", "ci-wait.json"))).toBe(false);
      const posts: { channel?: string; text: string }[] = [];
      const srv = Bun.serve({ port: 0, fetch: async (req) => {
        posts.push((await req.json()) as { channel?: string; text: string });
        return Response.json({ ok: true, url: "https://discord/x/3" });
      } });
      env.FM_SPAWN_POST_URL = `http://127.0.0.1:${srv.port}/post`;
      try {
        for (let i = 0; i < 2; i++) {
          const p = Bun.spawn(["python3", SCRIPT, "--drain-queue"], { env: { ...process.env, ...env }, stdout: "pipe" });
          await p.exited;
        }
      } finally {
        srv.stop(true);
      }
      expect(posts.filter((p) => p.channel === "omp-alerts")).toHaveLength(1);
      expect(ledger()[`v1:${T}`]).toMatchObject({ ci: "unknown" });
      expect(ledger()[`v1:${T}`].ciDone).toBeUndefined();
      expect(JSON.parse(spawn("--stack", "webapp", "--card", "v9", "--dry-run").out).live).toContain("v1");
    }, 30_000);

    test("own slot: a direct spawn of the card replaces its queued entry; a failed own launch goes back without the own mark", () => {
      enqueue("v1");
      gh(12, PENDING);
      expect(spawn("--stack", "webapp", "--card", "v1").code).toBe(0);
      expect(queue()).toHaveLength(0);
      // a drained own start whose launch fails returns to the head as a plain entry
      rmSync(join(dir, "state", "spawned.jsonl"));
      writeFileSync(join(dir, "state", "spawned.jsonl"), JSON.stringify({ tsMs: 1000, pane: "wT:p1", tab: "wT:t1", card: "v1",
        stack: "webapp", cwd: repo, workspace: "wT", task: join(dir, "task.md") }) + "\n");
      writeFileSync(join(dir, "state", "reserved.json"), "[]");
      enqueue("v1");
      writeFileSync(join(dir, "launcher"), `#!/bin/bash\nprintf '%s\\n' "launch $*" >> ${dir}/calls.log\nexit 1\n`);
      const r = drain();
      expect(r.out).toContain("FAILED to start queued 📈 v1 resume");
      expect(queue()).toHaveLength(1);
      expect(queue()[0].own).toBeUndefined();
      expect(queue()[0].card).toBe("v1");
    }, 30_000);

    test("a slow gh never stalls the drain: the CI watch stops at its time budget and the queue still starts", () => {
      writeFileSync(join(dir, "gh"), `#!/bin/bash\nprintf '%s\\n' "gh $*" >> ${dir}/calls.log\nsleep 2\ncat ${dir}/gh-pr-$3.json\n`);
      gh(12, PENDING);
      gh(15, PENDING);
      cards([
        { id: "v0", s: "running", stack: "webapp", job: "wT:p0" },
        { id: "v1", s: "partial", stack: "webapp" },
        { id: "v5", s: "partial", stack: "webapp" },
      ]);
      receipt("v5", "blocked", T, "waiting on CI: PR #15, run https://github.com/o/r/actions/runs/5");
      expect(spawn("--stack", "kb", "--card", "k1").code).toBe(0); // kb has no cap: starts at once
      writeFileSync(join(dir, "state", "queued.jsonl"), JSON.stringify({ id: "qK", tsMs: Date.now(), stack: "kb", label: "kb job",
        cwd: repo, task: join(dir, "task.md"), card: "k2", workspace: "wT", attempts: 0 }) + "\n");
      env.FM_SPAWN_CI_BUDGET_S = "1";
      const r = drain();
      expect(r.out).toContain("CI watch: time budget (1 s) used up; next tick checks v5");
      expect(calls().split("\n").filter((x) => x.startsWith("gh ")).length).toBe(1);
      expect(launches().pop()).toContain("--card k2");
    }, 30_000);

    const liveOf = () => {
      const r = spawn("--stack", "webapp", "--card", "v9", "--dry-run");
      return r.code === 6 ? JSON.parse(r.out).live : [];
    };

    test("an error while queueing the resume leaves the wait open; the next tick retries", () => {
      writeFileSync(join(dir, "state", "resume"), "not a folder"); // the resume task file cannot be written
      gh(12, GREEN);
      expect(drain().out).toContain("CI wait v1: watch failed");
      expect(launches()).toHaveLength(0);
      expect(ledger()[`v1:${T}`]).toBeUndefined();
      expect(liveOf()).toContain("v1");
      rmSync(join(dir, "state", "resume"));
      drain();
      expect(launches()).toHaveLength(1);
      expect(launches()[0]).toContain("--card v1");
    }, 30_000);

    test("a CI-wait receipt without tsMs is watched under a hash key: it holds the slot while pending, then resumes", () => {
      rawReceipt("v1", { summary: CI_SUMMARY });
      gh(12, PENDING);
      drain();
      expect(Object.keys(ledger())).toEqual([expect.stringMatching(/^v1:0:[0-9a-f]{10}$/)]);
      expect(liveOf()).toContain("v1");
      gh(12, GREEN);
      drain();
      expect(launches()).toHaveLength(1);
      expect(liveOf()).not.toContain("v1");
    }, 30_000);

    test("the stuck alert and the not-started alert of one wait are posted once each", async () => {
      writeFileSync(join(dir, "gh"), `#!/bin/bash\n[ -f ${dir}/gh-pr-$3.json ] || exit 1\ncat ${dir}/gh-pr-$3.json\n`);
      writeFileSync(join(dir, "tabs.json"), JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ tab_id: `wT:t${i}` }))));
      env.FM_SPAWN_CI_ALERT_S = "0";
      const posts: { channel?: string; text: string }[] = [];
      const srv = Bun.serve({ port: 0, fetch: async (req) => {
        posts.push((await req.json()) as { channel?: string; text: string });
        return Response.json({ ok: true, url: "https://discord/x/4" });
      } });
      env.FM_SPAWN_POST_URL = `http://127.0.0.1:${srv.port}/post`;
      const tick = async () => {
        const p = Bun.spawn(["python3", SCRIPT, "--drain-queue"], { env: { ...process.env, ...env }, stdout: "pipe" });
        await p.exited;
      };
      try {
        await tick();
        await tick();
        gh(12, GREEN);
        await tick();
        await tick();
      } finally {
        srv.stop(true);
      }
      const texts = posts.filter((p) => p.channel === "omp-alerts").map((p) => p.text);
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain("the CI state of PR #12 cannot be read");
      expect(texts[1]).toContain("CI for PR #12 went green and the job has not started again (queue position 1)");
    }, 30_000);
  });
});

describe("fm-spawn channel post and --adopt (owner 2026-10-24)", () => {
  /** Fake bot /post on a free port; returns the posted bodies. */
  function fakeBot(status = 200) {
    const posts: { channel?: string; text: string; stack?: string; pane?: string; alert?: string }[] = [];
    const paths: string[] = [];
    const srv = Bun.serve({ port: 0, fetch: async (req) => {
      const b = (await req.json()) as { channel?: string; text: string };
      posts.push(b);
      paths.push(new URL(req.url).pathname);
      return status === 200 && !b.text.includes("REFUSE") ? Response.json({ ok: true, url: `https://discord/x/${b.channel ?? "thread"}` }) : Response.json({ error: "no" }, { status: status === 200 ? 400 : status });
    } });
    env.FM_SPAWN_POST_URL = `http://127.0.0.1:${srv.port}/post`;
    return { posts, paths, stop: () => srv.stop(true) };
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

  test("no channel within the deadline: the job goes to its stack thread with Stop + FIRSTMATE alert (owner 2026-10-28)", async () => {
    const bot = fakeBot();
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    agents([{ paneId: "wT:p9", channelId: "OLD", archived: true }]); // an archived entry does not count
    const r = await run("--await-channel", "wT:p9", "--task", join(dir, "task.md"), "--label", "x", "--stack", "infra", "--card", "c1");
    bot.stop();
    expect(r.code).toBe(0);
    expect(bot.paths).toEqual(["/stack-job"]);
    expect(bot.posts[0]).toMatchObject({ stack: "infra", pane: "wT:p9" });
    expect(bot.posts[0]!.text).toContain("no Discord channel of its own");
    expect(bot.posts[0]!.alert).toContain("x");
    expect(readFileSync(join(dir, "state", "fm-spawn.log"), "utf8")).toContain("posted in the infra stack thread with Stop");
  });

  test("a 4xx refusal is not retried: one post, then omp-notify", async () => {
    const bot = fakeBot(400);
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    agents([]);
    const r = await run("--await-channel", "wT:p5", "--label", "x", "--stack", "kb");
    bot.stop();
    expect(r.code).toBe(3);
    expect(bot.posts).toHaveLength(1);
    expect(calls()).toContain("notify[ntfy] --kind error");
  });

  test("a tab id resolves to its OMP pane for the Stop button", async () => {
    const bot = fakeBot();
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    agents([]);
    writeFileSync(join(dir, "panes.json"), JSON.stringify([{ pane_id: "wT:p8", tab_id: "wT:t9", agent: "shell" }, { pane_id: "wT:p9", tab_id: "wT:t9", agent: "omp" }]));
    const r = await run("--await-channel", "wT:t9", "--label", "x", "--stack", "kb");
    bot.stop();
    expect(r.code).toBe(0);
    expect(bot.posts[0]!.pane).toBe("wT:p9");
  });

  test("stack fallback refused on every retry: exit 3 and omp-notify (ntfy when the bot route fails); never silent", async () => {
    const bot = fakeBot(503);
    env.FM_SPAWN_CHANNEL_WAIT_S = "1";
    agents([]);
    const r = await run("--await-channel", "wT:p5", "--label", "x", "--stack", "kb");
    bot.stop();
    expect(r.code).toBe(3);
    expect(bot.posts).toHaveLength(3); // FM_SPAWN_FALLBACK_DELAYS "0,0": 3 tries
    expect(bot.posts[0]!.pane).toBe("wT:p5");
    expect(calls()).toContain("notify[default] --kind error --summary Terminal job x (stack kb, pane wT:p5)");
    expect(calls()).toContain("notify[ntfy] --kind error");
    expect(readFileSync(join(dir, "state", "fm-spawn.log"), "utf8")).toContain("stack fallback FAILED");
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
      { id: "f", s: "partial", job: ["wT:t1"], area: "Something new" }, // tab id; new area -> new stack (owner 2026-10-28)
      { id: "g", s: "running", job: "wT:p3", area: "Finance: invoices", t: "Pay 100 usd SECRET" }, // finance stack ("Finance: …" too): no title in Discord
      { id: "h", s: "running", job: "wT:p2", area: "tools" }, // same pane as b: one note per pane
    ]));
    agents([{ paneId: "wT:p1", tabId: "wT:t1", channelId: "C1", archived: false }, { paneId: "wT:p2", tabId: "wT:t2", channelId: "C2", archived: false }, { paneId: "wT:p3", tabId: "wT:t3", channelId: "C3", archived: false }]);
    const dry = await run("--adopt-all", "--dry-run");
    expect(dry.out).toContain("DRY adopt wT:p1 card a stack infra (set) channel C1");
    expect(dry.out).toContain("DRY adopt wT:p2 card b stack kb channel C2");
    expect(dry.out).toContain("DRY adopt wT:t1 card f stack something-new (set) channel C1 (already noted)");
    expect(dry.out).not.toContain("card c ");
    expect(dry.out).not.toContain("card d ");
    expect(dry.out).not.toContain("card e ");
    expect(calls()).not.toContain("fm field");
    await run("--adopt-all"); // waits in-process: every note is posted when it returns

    expect(calls()).toContain("fm field a stack infra");
    expect(calls()).toContain("fm field f stack something-new");
    expect(calls()).toContain("fm field g stack finance");
    expect(bot.posts.some((p) => p.text.includes("SECRET"))).toBe(false);
    expect(bot.posts.find((p) => p.channel === "C3")!.text).toContain("g");
    expect(bot.posts.some((p) => p.text.includes("100 usd"))).toBe(false);
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

describe("fm-spawn --close-finished (card tabclose-safe)", () => {
  const P = (id: string, tab: string, status = "idle", extra: Record<string, unknown> = {}) =>
    ({ pane_id: id, tab_id: tab, workspace_id: "wT", agent_status: status, terminal_title: "π > job", ...extra });
  const setup = (tabs: object[], panes: object[], items: object[], spawned: object[] = []) => {
    writeFileSync(join(dir, "tabs.json"), JSON.stringify(tabs));
    writeFileSync(join(dir, "panes.json"), JSON.stringify(panes));
    writeFileSync(join(dir, "items.json"), JSON.stringify({ items }));
    sh(["mkdir", "-p", join(dir, "state")]);
    writeFileSync(join(dir, "state", "spawned.jsonl"), spawned.map((s) => JSON.stringify(s)).join("\n") + "\n");
  };
  const run = (...a: string[]) => sh(["python3", SCRIPT, "--close-finished", "--workspace", "wT", ...a]);
  const line = (out: string, tab: string) => out.split("\n").find((l) => l.includes(`: ${tab} `)) || "";

  test("(a) a busy pane keeps the tab; an idle tab without cards closes", () => {
    setup([{ tab_id: "wT:t1", label: "a", agent_status: "done" }, { tab_id: "wT:t2", label: "b" }, { tab_id: "wT:t3", label: "c" }],
      [P("wT:p1", "wT:t1"), P("wT:p2", "wT:t2", "working"), P("wT:p3", "wT:t3", "idle", { terminal_title: "⠋ busy" })], []);
    const r = run();
    expect(line(r.out, "wT:t1")).toStartWith("closed");
    expect(line(r.out, "wT:t2")).toContain("keep");
    expect(line(r.out, "wT:t3")).toContain("keep");
    expect(calls()).toContain("tab close wT:t1");
    expect(calls()).not.toContain("tab close wT:t2");
    expect(calls()).not.toContain("tab close wT:t3");
  });

  test("(b) a live card whose job is the pane, tab id or label keeps the tab; done/backlog cards do not", () => {
    setup([1, 2, 3, 4].map((i) => ({ tab_id: `wT:t${i}`, label: `L${i}`, agent_status: "done" })),
      [1, 2, 3, 4].map((i) => P(`wT:p${i}`, `wT:t${i}`)),
      [{ id: "k1", s: "running", job: "wT:p1" }, { id: "k2", s: "partial", job: "wT:t2" },
       { id: "k3", s: "waiting", job: "L3" }, { id: "d4", s: "done", job: "wT:p4" }, { id: "b4", s: "backlog", job: "wT:p4" }]);
    const r = run("--dry-run");
    for (const t of ["wT:t1", "wT:t2", "wT:t3"]) expect(line(r.out, t)).toContain("live card job");
    expect(line(r.out, "wT:t4")).toStartWith("DRY would close");
    expect(calls()).not.toContain("tab close");
  });

  test("(c) own fm-spawn card must be done", () => {
    setup([{ tab_id: "wT:t1", label: "x" }, { tab_id: "wT:t2", label: "y" }], [P("wT:p1", "wT:t1"), P("wT:p2", "wT:t2")],
      [{ id: "c1", s: "partial" }, { id: "c2", s: "done" }], [{ tab: "wT:t1", card: "c1" }, { tab: "wT:t2", card: "c2" }]);
    const r = run("--dry-run");
    expect(line(r.out, "wT:t1")).toContain("own card c1 is partial");
    expect(line(r.out, "wT:t2")).toStartWith("DRY would close");
  });

  test("idle tab with no fm-spawn card and no Herdr done status is kept (DYR incident)", () => {
    setup([{ tab_id: "wT:t1", label: "DYR narration", agent_status: "idle" }], [P("wT:p1", "wT:t1")], []);
    const r = run();
    expect(line(r.out, "wT:t1")).toContain("may be an owner tab");
    expect(calls()).not.toContain("tab close");
  });

  test("focused and FIRSTMATE tabs are kept", () => {
    setup([{ tab_id: "wT:t1", label: "x", focused: true }, { tab_id: "wT:t2", label: "FIRSTMATE" }],
      [P("wT:p1", "wT:t1"), P("wT:p2", "wT:t2")], []);
    const r = run();
    expect(r.out).not.toContain("closed: wT");
    expect(calls()).not.toContain("tab close");
  });

  test("restore duplicates: same label, one tab holds the card job -> the other closes, the job tab stays", () => {
    setup([{ tab_id: "wT:t1", label: "DYR narration" }, { tab_id: "wT:t2", label: "DYR narration" }],
      [P("wT:p1", "wT:t1"), P("wT:p2", "wT:t2")], [{ id: "dyr", s: "running", job: "wT:p2" }]);
    const r = run();
    expect(line(r.out, "wT:t1")).toContain("restore duplicate");
    expect(line(r.out, "wT:t2")).toContain("live card job: dyr");
    expect(calls()).toContain("tab close wT:t1");
    expect(calls()).not.toContain("tab close wT:t2");
  });

  test("duplicates where the card names only the label: both kept (cannot tell which is live)", () => {
    setup([{ tab_id: "wT:t1", label: "dup" }, { tab_id: "wT:t2", label: "dup" }],
      [P("wT:p1", "wT:t1"), P("wT:p2", "wT:t2")], [{ id: "c", s: "running", job: "dup" }]);
    const r = run("--dry-run");
    expect(r.out).not.toContain("DRY would close");
  });

  test("a tab the refusal marks [done] closes even with a backlog own card and a Terminal pane; owner tabs stay", () => {
    setup([{ tab_id: "wT:t1", label: "📈 DS tables vx", agent_status: "done" },
           { tab_id: "wT:t2", label: "💬 webapp assistant stop", agent_status: "done" },
           { tab_id: "wT:t3", label: "FIRSTMATE", agent_status: "done" },
           { tab_id: "wT:t4", label: "owner notes", agent_status: "idle" }],
      [P("wT:p1", "wT:t1"), P("wT:p1b", "wT:t1", "unknown", { terminal_title: "bash" }), P("wT:p2", "wT:t2", "done"),
       P("wT:p3", "wT:t3"), P("wT:p4", "wT:t4")],
      [{ id: "ds", s: "backlog" }], [{ tab: "wT:t1", card: "ds" }]);
    const r = run();
    expect(line(r.out, "wT:t1")).toStartWith("closed");
    expect(line(r.out, "wT:t2")).toStartWith("closed");
    expect(calls()).toContain("tab close wT:t1");
    expect(calls()).toContain("tab close wT:t2");
    expect(calls()).not.toContain("tab close wT:t3");
    expect(calls()).not.toContain("tab close wT:t4");
  });

  test("own card with a done receipt closes; a working Terminal pane still keeps a done tab", () => {
    sh(["mkdir", "-p", join(dir, "receipts")]);
    writeFileSync(join(dir, "receipts", "r1.json"), JSON.stringify({ result: "done" }));
    setup([{ tab_id: "wT:t1", label: "x" }, { tab_id: "wT:t2", label: "y", agent_status: "done" }],
      [P("wT:p1", "wT:t1"), P("wT:p2", "wT:t2", "working")], [{ id: "r1", s: "partial" }], [{ tab: "wT:t1", card: "r1" }]);
    const r = sh(["env", `FM_SPAWN_RECEIPTS=${join(dir, "receipts")}`, "python3", SCRIPT, "--close-finished", "--workspace", "wT", "--dry-run"]);
    expect(line(r.out, "wT:t1")).toStartWith("DRY would close");
    expect(line(r.out, "wT:t2")).toContain("keep");
  });

  test("Herdr done + own card running/waiting keeps the tab", () => {
    setup([{ tab_id: "wT:t1", label: "💹 IWM hold", agent_status: "done" }, { tab_id: "wT:t2", label: "w", agent_status: "done" }],
      [P("wT:p1", "wT:t1", "done"), P("wT:p2", "wT:t2", "done")],
      [{ id: "iwm", s: "running" }, { id: "w", s: "waiting" }], [{ tab: "wT:t1", card: "iwm" }, { tab: "wT:t2", card: "w" }]);
    const r = run();
    expect(line(r.out, "wT:t1")).toContain("live job");
    expect(line(r.out, "wT:t2")).toContain("live job");
    expect(calls()).not.toContain("tab close");
  });

  test("cap hit: closes finished tabs once before the cap is checked again", () => {
    setPanes([repo]);
    const tabs = Array.from({ length: 31 }, (_, i) => ({ tab_id: `wT:t${i}`, label: `L${i}`, agent_status: i === 5 ? "done" : "idle" }));
    writeFileSync(join(dir, "tabs.json"), JSON.stringify(tabs));
    const pl = JSON.parse(readFileSync(join(dir, "panes.json"), "utf8"));
    pl.push({ pane_id: "wT:p5", tab_id: "wT:t5", workspace_id: "wT", agent_status: "done", terminal_title: "π > x" });
    writeFileSync(join(dir, "panes.json"), JSON.stringify(pl));
    writeFileSync(join(dir, "items.json"), JSON.stringify({ items: [] }));
    const r = spawn();
    expect(r.err).toContain("closing finished tabs once");
    expect(calls()).toContain("tab close wT:t5");
  });

  test("refusal message suggests --close-finished", () => {
    setPanes([repo]);
    writeFileSync(join(dir, "tabs.json"), JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ tab_id: `wT:t${i}` }))));
    expect(spawn().err).toContain("fm-spawn --close-finished --dry-run");
  });
});

describe("fm-spawn default base (card webapp-ws-branches-unrelated-history)", () => {
  const defaultBase = (clone: string) =>
    sh(["python3", "-c", `import runpy,sys;print(runpy.run_path(${JSON.stringify(SCRIPT)},run_name="x")["default_base"](sys.argv[1]))`, clone]);

  test("refreshes a stale cached origin/HEAD from the remote default branch", () => {
    // remote: default branch `live`; a stale `main` with unrelated history also exists
    const remote = join(dir, "remote.git");
    git("branch", "-m", "live");
    git("checkout", "-q", "--orphan", "main");
    git("commit", "-qm", "stale root");
    sh(["git", "clone", "-q", "--bare", repo, remote]);
    sh(["git", "-C", remote, "symbolic-ref", "HEAD", "refs/heads/live"]);
    const clone = join(dir, "clone");
    sh(["git", "clone", "-q", remote, clone]);
    // the clone cached `main` as origin/HEAD (default branch changed after the clone)
    sh(["git", "-C", clone, "remote", "set-head", "origin", "main"]);
    const r = defaultBase(clone);
    expect(r.err).toBe("");
    expect(r.out.trim()).toBe("origin/live");
  });

  test("keeps the cached origin/HEAD when the remote is unreachable", () => {
    // default branch `live`, so the main/master fallback cannot give the same answer
    const remote = join(dir, "remote.git");
    git("branch", "-m", "live");
    sh(["git", "clone", "-q", "--bare", repo, remote]);
    const clone = join(dir, "clone");
    sh(["git", "clone", "-q", remote, clone]);
    rmSync(remote, { recursive: true, force: true });
    expect(defaultBase(clone).out.trim()).toBe("origin/live");
  });
});

describe("ci_state rollup: superseded cancelled runs (card fm-ci-superseded-runs)", () => {
  const SCRIPT_P = join(import.meta.dir, "..", "scripts", "fm-spawn");
  const state = (checks: unknown[]) => {
    const code = `import runpy,json,sys;g=runpy.run_path(${JSON.stringify(SCRIPT_P)},run_name="x");print(json.dumps(g["rollup_state"](json.load(sys.stdin))))`;
    const r = Bun.spawnSync(["python3", "-c", code], { stdin: Buffer.from(JSON.stringify(checks)) });
    return JSON.parse(r.stdout.toString());
  };
  const run = (wf: string, id: number, name: string, conclusion: string, status = "COMPLETED") =>
    ({ __typename: "CheckRun", workflowName: wf, name, status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1` });
  test("PR #156 fixture: cancelled draft run + green newest run -> green", () => {
    const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "pr156-rollup.json"), "utf8"));
    expect(state(fx)).toEqual(["green", "18 checks passed"]); // all 18 newest-run checks kept, 5 draft-run checks dropped
  });
  test("superseded cancelled run + green newest -> green", () => {
    expect(state([run("CI", 1, "core", "CANCELLED"), run("CI", 1, "gate", "FAILURE"), run("CI", 2, "core", "SUCCESS")])[0]).toBe("green");
  });
  test("single cancelled run -> failed", () => {
    expect(state([run("CI", 1, "core", "CANCELLED")])[0]).toBe("failed");
  });
  test("newest run failing -> failed", () => {
    expect(state([run("CI", 1, "core", "CANCELLED"), run("CI", 2, "core", "FAILURE")])[0]).toBe("failed");
  });
  test("push + pull_request runs, older failed not cancelled -> counted", () => {
    expect(state([run("CI", 1, "core", "FAILURE"), run("CI", 2, "core", "SUCCESS")])[0]).toBe("failed");
  });
  test("newest run running -> pending", () => {
    expect(state([run("CI", 1, "core", "CANCELLED"), run("CI", 2, "core", "", "IN_PROGRESS")])[0]).toBe("pending");
  });
  test("StatusContext kept", () => {
    expect(state([run("CI", 2, "core", "SUCCESS"), { __typename: "StatusContext", context: "x", state: "FAILURE" }])[0]).toBe("failed");
  });
});
