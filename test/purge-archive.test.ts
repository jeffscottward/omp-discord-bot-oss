import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// purge-archive.py crashed the whole run on a 404 DELETE (category already gone, 2026-10-23).
test("purge-archive: DELETE 404 is skipped, other errors still raise", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const py = `
import importlib.util, urllib.error, io
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
def mk(code):
    def api(path, method="GET", body=None):
        if code: raise urllib.error.HTTPError(path, code, "x", {}, io.BytesIO(b""))
        return {}
    return api
assert pa.delete_gone_ok(mk(0), "/channels/1") is True
assert pa.delete_gone_ok(mk(404), "/channels/1") is False
try:
    pa.delete_gone_ok(mk(403), "/channels/1"); raise SystemExit("403 not raised")
except urllib.error.HTTPError: pass
print("OK")
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("OK");
});

// 2026-10-25: threads are deleted with their channel, so the safety copy must hold them too.
test("purge-archive: the safety copy includes active and archived thread messages; a 403 thread listing raises", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const py = `
import importlib.util, urllib.error, io, json
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
msg = lambda i, t: {"id": i, "timestamp": "2026-10-25", "author": {"username": "u"}, "content": t, "attachments": []}
def api_for(private_code=0):
    def api(path, method="GET", body=None):
        if path.startswith("/channels/C/messages"): return [msg("2", "chan b"), msg("1", "chan a")]
        if path.startswith("/channels/T1/messages"): return [msg("11", "active thread")]
        if path.startswith("/channels/T2/messages"): return [msg("21", "archived thread")]
        if path.startswith("/channels/T3/messages"): return [msg("31", "private thread")]
        if path.startswith("/channels/C/threads/archived/public"): return {"threads": [{"id": "T2", "name": "old", "thread_metadata": {"archive_timestamp": "x"}}], "has_more": False}
        if path.startswith("/channels/C/threads/archived/private"):
            if private_code: raise urllib.error.HTTPError(path, private_code, "x", {}, io.BytesIO(b""))
            return {"threads": [{"id": "T3", "name": "priv"}], "has_more": False}
        raise SystemExit("unexpected " + path)
    return api
active = [{"id": "T1", "name": "live", "parent_id": "C"}, {"id": "TX", "name": "other", "parent_id": "D"}]
c = pa.safety_copy(api_for(), "C", "chan", active)
assert [m["content"] for m in c["messages"]] == ["chan a", "chan b"], c
got = {t["name"]: [m["content"] for m in t["messages"]] for t in c["threads"]}
assert got == {"live": ["active thread"], "old": ["archived thread"], "priv": ["private thread"]}, got
try:
    pa.safety_copy(api_for(403), "C", "chan", active); raise SystemExit("403 not raised")
except urllib.error.HTTPError: pass
print("OK")
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("OK");
});

// 2026-10-25: 20 empty duplicate channels (no OMP log) were held forever and kept 🖥️ Main full (50/50).
test("purge-archive: --empty-dupes deletes only an empty closed-pane channel without OMP logs in a pane category", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const py = `
import importlib.util
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
closed = {"archived": True, "machine": "main", "sessionFile": "/nonexistent/x.jsonl"}
empty = {"id": "100000000000000046", "last_message_id": None, "parent_id": "MAIN"}
used = {**empty, "id": "100000000000000047", "last_message_id": "100000000000000048"}
pa.PANE_CATS.update({"MAIN"})
# default (no flag): held
assert pa.decide(empty, closed, {}, "") == (False, "no OMP session log on disk")
pa.EMPTY_DUPES = True
assert pa.decide(empty, closed, {}, "") == (True, pa.EMPTY_REASON)
# a channel that ever had a message, a live pane, an unknown channel, a channel outside the pane
# categories (for example a legacy 📦 Archive or alert channel) or a protected one stays held
assert pa.decide(used, closed, {}, "")[0] is False
assert pa.decide(empty, {**closed, "archived": False}, {}, "")[0] is False
assert pa.decide(empty, None, {}, "")[0] is False
assert pa.decide({**empty, "parent_id": "ARCHIVE"}, closed, {}, "")[0] is False
assert pa.decide(empty, closed, {}, "open ask menu") == (False, "open ask menu")
print("OK")
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("OK");
});

// A typo (or the retired --drop-empty name) must exit before any Discord call, never run a real purge.
// Safety: --dry-run plus an empty HOME, so even a script that accepted the option could not read the bot token
// (2026-10-25: this test, run against the old script that accepted --drop-empty, did a real purge of 4 channels).
test("purge-archive: unknown options exit non-zero", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const home = mkdtempSync(join(tmpdir(), "purge-archive-home-"));
  for (const bad of ["--drop-empty", "--empty-dupe", "--dryrun"]) {
    const r = Bun.spawnSync(["python3", "-B", script, "--dry-run", bad], { env: { ...process.env, HOME: home } });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("unknown option(s): " + bad);
  }
});

// Review 2026-10-25: the mirror can revive an archived entry (pane/tab/name match) during a run; deleting that
// channel would make the bot close the live pane's tab. The delete step re-reads agents.json.
test("purge-archive: live_again holds a channel whose entry was revived, or when agents.json is unreadable", () => {
  const script = join(import.meta.dir, "..", "scripts", "purge-archive.py");
  const dir = mkdtempSync(join(tmpdir(), "purge-archive-agents-"));
  const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("pa", ${JSON.stringify(script)})
pa = importlib.util.module_from_spec(spec); spec.loader.exec_module(pa)
p = ${JSON.stringify(join(dir, "agents.json"))}
json.dump([{"channelId": "A", "archived": True}, {"channelId": "B", "archived": True}, {"channelId": "B", "archived": False}], open(p, "w"))
assert pa.live_again("A", p) is False
assert pa.live_again("B", p) is True
assert pa.live_again("A", p + ".missing") is True
print("OK")
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("OK");
});
