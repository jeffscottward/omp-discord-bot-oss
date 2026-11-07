import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Card channel-purge-stuck (owner 2026-11-07): the daily idle purge deleted nothing (428 held). The 40-channel gate of
// 2026-11-01 was still in the code although the 2026-11-05 rule (msg 100000000000000053) superseded it, and every
// channel whose session daily-skill-bot's cost cap left unsampled waited forever for a marker. Empty stack categories
// were never deleted. These tests pin the new rule.

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
/** Runs python with the script loaded as `pa` and HOME set to `home`; returns stdout (asserts a clean stderr). */
function runPy(home: string, body: string, argv: string[] = []): string {
  const py = `
import importlib.util, io, json, os, sys, time, types, urllib.error, urllib.request
sys.argv = ["purge-archive.py", *${JSON.stringify(argv)}]
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
NOW = time.time() * 1000
DAY = 86400000
def sf(ms): return str(int(ms - 1420070400000) << 22)
${body}
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py], { env: { ...process.env, HOME: home } });
  expect(r.stderr.toString()).toBe("");
  return r.stdout.toString();
}

test("decide: idle rule, learned markers, cost-cap unsampled logs, no-log channels, live panes, Second unreachable", () => {
  const home = tempDir("idle-decide-");
  const out = runPy(home, `
assert pa.IDLE_DAYS == 7 and not hasattr(pa, "ARCHIVE_AT") and not hasattr(pa, "pick_to_archive")
log = os.path.join(os.environ["HOME"], "s_00000000-0000-7000-8000-000000000001.jsonl")
open(log, "w").write("{}\\n")
os.utime(log, (NOW / 1000 - 10 * 86400, NOW / 1000 - 10 * 86400))
old = sf(NOW - 10 * DAY)
c = {"id": old, "last_message_id": old}
W = [(NOW - 11 * DAY, NOW - 9 * DAY)]      # a completed daily run over the log's last write (10 days ago)
GAP = [(NOW - 20 * DAY, NOW - 15 * DAY), (NOW - 9 * DAY, NOW - 8 * DAY)]  # runs before and after, none over it
closed = {"archived": True, "machine": "main", "sessionFile": log}
# unsampled (no marker), a completed daily run read its last write: deleted, logs kept
ok, why = pa.decide(c, closed, {}, "", windows=W)
assert ok and "cost cap left 1 of 1 unsampled for the model" in why and "logs kept on disk" in why, why
# a marker older than the last activity counts as unsampled, same result
assert pa.decide(c, closed, {log: NOW - 20 * DAY}, "", windows=W)[0] is True
# the log's last write fell in a learner gap (no completed run over it): held
ok, why = pa.decide(c, closed, {}, "", windows=GAP)
assert not ok and why.startswith("no completed daily-skill-bot run covers its last log write"), why
# a marker newer than the last activity (by path or by session id): learned
assert pa.decide(c, closed, {log: NOW - DAY}, "", windows=[]) == (True, "learned (daily-skill-bot marker for 1 log(s)); logs kept")
assert pa.decide(c, closed, {"00000000-0000-7000-8000-000000000001": NOW - DAY}, "", windows=[])[0] is True
# a live pane (legacy archive category) without markers: held
ok, why = pa.decide(c, {**closed, "archived": False}, {}, "", windows=W)
assert not ok and why.startswith("pane is live"), why
# a message 2 days ago: held by the idle rule, whatever the learners did
c2 = {**c, "last_message_id": sf(NOW - 2 * DAY)}
ok, why = pa.decide(c2, closed, {log: NOW}, "", windows=W)
assert not ok and why.startswith("active 2.0 days ago") and why.endswith("deleted after 7 idle days"), why
# a log write 1 day ago counts as activity too
os.utime(log, (NOW / 1000 - 86400, NOW / 1000 - 86400))
ok, why = pa.decide(c, closed, {}, "", windows=W)
assert not ok and why.startswith("active 1.0 days ago"), why
# the owner override still waits for the idle days
pa.IGNORE_LEARNED = True
assert pa.decide(c, closed, {}, "", windows=[])[0] is False
os.utime(log, (NOW / 1000 - 10 * 86400, NOW / 1000 - 10 * 86400))
assert pa.decide(c, closed, {}, "", windows=[])[0] is True
pa.IGNORE_LEARNED = False
# no OMP log on disk: nothing for the learners, so idle + closed is enough (no entry = legacy archive channel)
gone = {**closed, "sessionFile": "/nonexistent/x.jsonl"}
ok, why = pa.decide(c, gone, {}, "", windows=[])
assert ok and why == "idle 10.0 days, no OMP session log on disk (nothing for the learners)", why
assert pa.decide(c, None, {}, "", windows=[])[0] is True
assert pa.decide(c, {**gone, "archived": False}, {}, "", windows=[]) == (False, "no OMP session log on disk (pane is live)")
ok, why = pa.decide(c2, gone, {}, "", windows=[])
assert not ok and why.startswith("no OMP session log on disk; active 2.0 days ago"), why
# protected holds always win
assert pa.decide(c, closed, {}, "open ask menu", windows=W) == (False, "open ask menu")
# Second: ssh failed = unknown, never "no log"; an explicit "No such file" = no log
second = {"archived": True, "machine": "second", "sessionFile": "/Users/x/s.jsonl"}
answer = {}
pa.subprocess.run = lambda *a, **k: types.SimpleNamespace(**answer)
answer.update(returncode=255, stdout="", stderr="ssh: connect to host second-host: No route to host")
assert pa.decide(c, second, {}, "", windows=W) == (False, "Second unreachable: cannot check its OMP session log")
answer.update(returncode=1, stdout="", stderr="stat: cannot statx '/Users/x/s.jsonl': No such file or directory")
assert pa.decide(c, second, {}, "", windows=W)[0] is True
answer.update(returncode=0, stdout=str(int(NOW / 1000 - 10 * 86400)) + "\\n", stderr="")
assert "unsampled" in pa.decide(c, second, {}, "", windows=W)[1]
# ssh's own "No such file" (a missing identity file) or an odd stat answer is not "no log"
answer.update(returncode=255, stdout="", stderr="Warning: Identity file /x/id not accessible: No such file or directory.")
assert pa.decide(c, second, {}, "", windows=W)[0] is False
answer.update(returncode=0, stdout="", stderr="")
assert pa.decide(c, second, {}, "", windows=W)[0] is False
print("OK")
`);
  expect(out).toContain("OK");
});

test("learner_windows: only completed daily runs count (no dry run, no backfill, no unfinished run)", () => {
  const home = tempDir("idle-runs-");
  const run = (name: string, window: string, report = true) => {
    const d = join(home, ".local/state/daily-skill-bot/runs", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "aggregate-input.json"), JSON.stringify({ window }));
    if (report) writeFileSync(join(d, "report.md"), "ok\n");
  };
  run("2026-11-05", "2026-11-05 04:00 to 2026-11-06 04:00");
  run("2026-11-06-dry", "2026-11-06 04:00 to 2026-11-07 04:00");
  run("2026-11-06-channel-cleanup-week", "2026-11-06 04:00 to 2026-11-07 05:00");
  run("2026-11-07", "2026-11-07 04:00 to 2026-11-08 04:00", false);
  const out = runPy(home, `
t = lambda x: time.mktime(time.strptime(x, "%Y-%m-%d %H:%M")) * 1000
assert pa.learner_windows() == [(t("2026-11-05 04:00"), t("2026-11-06 04:00"))], pa.learner_windows()
assert pa.covered(t("2026-11-05 13:00"), pa.learner_windows()) and not pa.covered(t("2026-11-06 13:00"), pa.learner_windows())
print("OK")
`);
  expect(out).toContain("OK");
});

test("empty_stack_cats: 0 channels for an hour on two runs, created over an hour ago; drop_stack_ids rewrites config 0600", () => {
  const home = tempDir("idle-cats-");
  const out = runPy(home, `
H = 3600_000
old, young = sf(NOW - 30 * DAY), sf(NOW - 10 * 60_000)
used, fresh, unknown = sf(NOW - 29 * DAY), sf(NOW - 28 * DAY), sf(NOW - 27 * DAY)
chans = [{"id": i, "type": 4} for i in (old, young, used, fresh)] + [{"id": "c1", "type": 0, "parent_id": used}]
drop, seen = pa.empty_stack_cats(chans, [old, young, used, fresh, unknown], {old: NOW - 2 * H, young: NOW - 2 * H}, NOW)
assert drop == [old], drop                        # young: created 10 min ago; fresh: first seen empty now
assert seen == {old: NOW - 2 * H, young: NOW - 2 * H, fresh: NOW}, seen  # used (has a channel) and unknown (gone) drop out
cfg = os.path.join(os.environ["HOME"], "config.json")
open(cfg, "w").write(json.dumps({"guildId": "G", "mirror": {"categories": {"local": "R"}, "stackCategories": {"lookup": ["L"], "webapp": ["V1", "V2"]}}}))
assert pa.drop_stack_ids(cfg, {"L", "V2"}) is True
got = json.load(open(cfg))
assert got == {"guildId": "G", "mirror": {"categories": {"local": "R"}, "stackCategories": {"webapp": ["V1"]}}}, got
assert oct(os.stat(cfg).st_mode & 0o777) == "0o600"
backups = [f for f in os.listdir(os.environ["HOME"]) if f.startswith("config.json.before-stackcat-drop-")]
assert len(backups) == 1 and "lookup" in open(os.path.join(os.environ["HOME"], backups[0])).read()
assert pa.drop_stack_ids(cfg, {"nope"}) is False
print("OK")
`);
  expect(out).toContain("OK");
});

/**
 * main() against a fake HOME and a fake Discord: one small stack category (3 channels, so the old 40-channel gate
 * would have held everything) and one empty stack category. Returns the parsed --json summary and the DELETE paths.
 */
function runMain(home: string, argv: string[]): { summary: Record<string, unknown>; deleted: string[] } {
  const out = runPy(home, `
G = "900000000000000000"
cats = json.load(open(os.path.join(os.environ["HOME"], "cats.json")))
idle_unsampled, recent, thread_busy, live, carded = sf(NOW - 10 * DAY), sf(NOW - DAY), sf(NOW - 9 * DAY), sf(NOW - 12 * DAY), sf(NOW - 10 * DAY + 5000)
thread, thread_msg = sf(NOW - 9 * DAY + 1000), sf(NOW - DAY)
card_thread = sf(NOW - 10 * DAY + 6000)  # an old thread of "carded" that an open FIRSTMATE card links
chans = [{"id": cats["bot"], "type": 4, "name": "bot"}, {"id": cats["lookup"], "type": 4, "name": "lookup"}]
chans += [{"id": i, "type": 0, "name": "ch-" + i[-5:], "parent_id": cats["bot"], "last_message_id": i} for i in (idle_unsampled, recent, thread_busy, live, carded)]
deleted = []
class R:
    def __init__(self, b): self.b = b
    def read(self): return self.b
def urlopen(req, timeout=30):
    p, m = req.full_url.split("/api/v10", 1)[1], req.get_method()
    if m == "DELETE":
        cid = p.split("/")[2]; deleted.append(cid)
        global chans; chans = [c for c in chans if c["id"] != cid]
        return R(b"")
    if p == f"/guilds/{G}/channels": return R(json.dumps(chans).encode())
    if p == f"/guilds/{G}/threads/active": return R(json.dumps({"threads": [{"id": thread, "parent_id": thread_busy}, {"id": card_thread, "parent_id": carded}]}).encode())
    if "/threads/archived/" in p: return R(b'{"threads": [], "has_more": false}')
    if "/messages" in p:
        cid = p.split("/")[2]
        mid = thread_msg if cid == thread else cid
        return R(json.dumps([] if "before=" in p else [{"id": mid, "timestamp": "2026-10-01T00:00:00Z", "author": {"username": "u"}, "content": "hi", "attachments": []}]).encode())
    raise SystemExit("unexpected " + m + " " + p)
w = lambda p, v: (os.makedirs(os.path.dirname(os.path.join(os.environ["HOME"], p)), exist_ok=True), open(os.path.join(os.environ["HOME"], p), "w").write(v if isinstance(v, str) else json.dumps(v)))
if not os.path.exists(os.path.join(os.environ["HOME"], ".config/omp-discord/config.json")):
    w(".config/omp-discord/bot.env", "DISCORD_TOKEN=x\\n")
    w(".config/omp-discord/config.json", {"guildId": G, "mirror": {"categories": {"local": "MAINCAT"}, "stackCategories": {"bot": [cats["bot"]], "lookup": [cats["lookup"]]}}})
    w("Documents/reports/web/firstmate/items.json", [{"id": "c", "s": "running", "q": f"https://discord.com/channels/{G}/{card_thread}"}])
    w(".local/share/omp-discord-bot/asks.json", {"sets": []})
    w(".local/share/omp-discord-bot/queue.json", {"jobs": []})
    w(".local/share/omp-discord-bot/agents.json", [{"channelId": i, "archived": True, "machine": "main"} for i in (idle_unsampled, recent, thread_busy, carded)] + [{"channelId": live, "archived": False, "machine": "main"}])
    # each closed channel has an OMP log in the bot's side session folder, 10 days old and never sampled by the learner
    for i in (idle_unsampled, recent, thread_busy, carded):
        f = f".local/share/omp-discord-bot/sessions/{i}/s.jsonl"; w(f, "{}\\n")
        os.utime(os.path.join(os.environ["HOME"], f), (NOW / 1000 - 10 * 86400,) * 2)
    w(".local/state/daily-skill-bot/runs/2026-11-06/aggregate-input.json", {"window": time.strftime("%Y-%m-%d %H:%M", time.localtime(NOW / 1000 - 11 * 86400)) + " to " + time.strftime("%Y-%m-%d %H:%M", time.localtime(NOW / 1000 - 9 * 86400))})
    w(".local/state/daily-skill-bot/runs/2026-11-06/report.md", "ok")
pa.urllib.request.urlopen = urlopen
buf = io.StringIO(); real = sys.stdout; sys.stdout = buf
pa.main()
sys.stdout = real
s = buf.getvalue()
print(json.dumps({"summary": json.loads(s[s.index("{"):]), "deleted": deleted, "ids": {"idle": idle_unsampled, "recent": recent, "thread": thread_busy, "live": live, "carded": carded}}))
`, argv);
  return JSON.parse(out) as { summary: Record<string, unknown>; deleted: string[] };
}

test("main: deletes an idle unsampled channel in a 5-channel category (no 40 gate); holds recent, thread-active, thread-carded and live; empty stack category goes after an hour", () => {
  const home = tempDir("idle-main-");
  const sf = (ms: number) => String(BigInt(Math.round(ms - 1420070400000)) << 22n);
  const cats = { bot: sf(Date.now() - 40 * 86_400_000), lookup: sf(Date.now() - 39 * 86_400_000) };
  writeFileSync(join(home, "cats.json"), JSON.stringify(cats));
  const first = runMain(home, ["--json", "--drop-categories"]) as unknown as {
    summary: { results: { id: string; delete: boolean; reason: string }[]; droppedCategories: string[] };
    deleted: string[];
    ids: Record<string, string>;
  };
  const why = Object.fromEntries(first.summary.results.map((r) => [r.id, r.reason]));
  expect(first.deleted).toEqual([first.ids.idle!]);
  expect(why[first.ids.idle!]).toContain("cost cap left 1 of 1 unsampled for the model");
  expect(why[first.ids.recent!]).toStartWith("active 1.0 days ago");
  expect(why[first.ids.thread!]).toStartWith("channel or thread active 1.0 days ago");
  expect(why[first.ids.carded!]).toBe("a thread of it has open work (card, ask menu, queued job, keep list or --hold)");
  expect(why[first.ids.live!]).toBeUndefined(); // a live pane outside a legacy archive is not even a candidate
  // The empty stack category was seen empty for the first time: kept, remembered.
  expect(first.summary.droppedCategories).toEqual([]);
  const state = join(home, ".local/state/omp-discord/empty-stack-cats.json");
  expect(Object.keys(JSON.parse(readFileSync(state, "utf8")))).toEqual([cats.lookup]);
  expect(statSync(state).mode & 0o777).toBe(0o600);
  // A dry run an hour later names it and changes nothing.
  writeFileSync(state, JSON.stringify({ [cats.lookup]: Date.now() - 2 * 3_600_000 }));
  const dry = runMain(home, ["--json", "--drop-categories", "--dry-run"]) as unknown as { summary: { wouldDropCategories: string[] }; deleted: string[] };
  expect(dry.deleted).toEqual([]);
  expect(dry.summary.wouldDropCategories).toEqual([cats.lookup]);
  // The real run an hour later deletes it and drops its id from mirror.stackCategories (the bot's own category stays).
  const second = runMain(home, ["--json", "--drop-categories"]) as unknown as { summary: { droppedCategories: string[] }; deleted: string[] };
  expect(second.deleted).toContain(cats.lookup);
  expect(second.deleted).not.toContain(cats.bot);
  expect(second.summary.droppedCategories).toEqual([cats.lookup]);
  const cfg = JSON.parse(readFileSync(join(home, ".config/omp-discord/config.json"), "utf8")) as { mirror: { stackCategories: Record<string, string[]> } };
  expect(cfg.mirror.stackCategories).toEqual({ bot: [cats.bot] });
  expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({});
}, 30_000);
