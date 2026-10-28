#!/usr/bin/env python3
"""fm unit tests on a temp fixture (FM_ITEMS); the live items.json is never touched.
Contract (owner 2026-10-19): q/src are Discord message links only; other links go in `l`."""
import json, os, subprocess, sys, tempfile

# fm under test: $FM_BIN, else the kit copy (kit/bin/fm).
FM = os.environ.get("FM_BIN") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bin", "fm")
D = "https://discord.com/channels/1/2/3"
GH = "https://github.com/x/y/pull/1"
fails = 0

def run(*args):
    env = dict(os.environ, FM_ITEMS=items, FM_BY="unit-test")
    env.pop("FM_AUTO", None)
    return subprocess.run([sys.executable, FM, *args], env=env, capture_output=True, text=True)

def check(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {info}"))
    fails += 0 if cond else 1

def card(i):
    return next((x for x in json.load(open(items))["items"] if x["id"] == i), None)

with tempfile.TemporaryDirectory() as tmp:
    items = os.path.join(tmp, "items.json")
    json.dump({"updated": "", "items": [{"id": "c1", "t": "t", "area": "a", "s": "partial", "n": ""}]}, open(items, "w"))

    r = run("q", "c1", GH); check("fm q rejects GitHub", r.returncode != 0 and "`l` field" in r.stderr, r.stderr)
    r = run("q", "c1", D); check("fm q accepts Discord", r.returncode == 0 and card("c1").get("q") == D, r.stderr)
    r = run("q", "c1", "-"); check("fm q - removes", r.returncode == 0 and "q" not in card("c1"))
    r = run("field", "c1", "src", GH); check("fm field src rejects GitHub", r.returncode != 0 and "src" not in card("c1"), r.stderr)
    r = run("field", "c1", "src", "https://discord.com/channels/"); check("fm field src rejects bare prefix", r.returncode != 0)
    CH = "https://discord.com/channels/1/2"
    r = run("field", "c1", "src", CH); check("fm field src rejects a channel-only link", r.returncode != 0 and "src" not in card("c1"), r.stderr)
    r = run("q", "c1", CH + "/"); check("fm q rejects a channel-only link", r.returncode != 0, r.stderr)
    r = run("field", "c1", "src", D); check("fm field src accepts Discord", r.returncode == 0 and card("c1").get("src") == D, r.stderr)
    r = run("field", "c1", "src", "-"); check("fm field src - removes", r.returncode == 0 and "src" not in card("c1"))
    r = run("field", "c1", "q", GH); check("fm field q refused (use fm q)", r.returncode != 0 and "q" not in card("c1"))
    r = run("field", "c1", "l", GH); check("fm field l accepts GitHub", r.returncode == 0 and card("c1").get("l") == GH, r.stderr)
    r = run("add", "c2", "waiting", "a", "title", "--src", GH); check("fm add --src rejects GitHub", r.returncode != 0 and card("c2") is None, r.stderr)
    r = run("add", "c2", "waiting", "a", "title", "--q", "http://discord.com/channels/1/2/3"); check("fm add --q rejects http", r.returncode != 0 and card("c2") is None)
    r = run("add", "c2", "waiting", "a", "title", "--src", D); check("fm add --src accepts Discord", r.returncode == 0 and card("c2").get("src") == D, r.stderr)
    r = run("receipt", "c1", "blocked", "x", "--src", GH); check("fm receipt --src rejects GitHub", r.returncode != 0 and not os.path.exists(os.path.join(tmp, "receipts", "c1.json")), r.stderr)
    r = run("receipt", "c1", "blocked", "x", "--q", GH); check("fm receipt --q rejects GitHub", r.returncode != 0)
    r = run("receipt", "c1", "done", "ok", "--evidence", GH); check("fm receipt evidence may be GitHub", r.returncode == 0 and os.path.exists(os.path.join(tmp, "receipts", "c1.json")), r.stderr)
    r = run("set", "c1", "open"); check("fm set open needs q", r.returncode != 0)

    # fm why (blocker-tracks, 2026-10-23): chains, multi-parent, cycles, missing cards.
    json.dump({"updated": "", "items": [
        {"id": "q", "t": "q", "s": "waiting", "q": D}, {"id": "c", "t": "c", "s": "running", "job": "tab"},
        {"id": "a", "t": "a", "s": "partial", "blockedBy": "b"}, {"id": "b", "t": "b", "s": "partial", "blockedBy": ["q", "c"]},
        {"id": "x", "t": "x", "s": "partial", "blockedBy": "y"}, {"id": "y", "t": "y", "s": "partial", "blockedBy": "x"},
        {"id": "m", "t": "m", "s": "partial", "blockedBy": "gone"}, {"id": "e", "t": "e", "s": "partial", "blockedBy": "ext:vendor"}]}, open(items, "w"))
    r = run("why", "a"); check("fm why multi-parent", "owner    q <- b <- a" in r.stdout and "bot      c <- b <- a" in r.stdout, r.stdout)
    r = run("why", "x"); check("fm why cycle", r.returncode == 0 and "cycle" in r.stdout, r.stdout + r.stderr)
    r = run("why", "m"); check("fm why missing card", "unknown  gone <- m" in r.stdout, r.stdout)
    r = run("why", "e"); check("fm why external", r.stdout.startswith("external"), r.stdout)
    json.dump({"updated": "", "items": [
        {"id": "g", "t": "Gate", "s": "partial", "until": "2099-01-01T00:00:00Z"}, {"id": "p", "t": "Past", "s": "partial", "until": "2000-01-01T00:00:00Z"},
        {"id": "h", "t": "h", "s": "partial", "blockedBy": "gate"}, {"id": "k", "t": "k", "s": "partial", "blockedBy": "p"},
        {"id": "o", "t": "o", "s": "waiting", "q": D, "blocks": "r"}, {"id": "r", "t": "r", "s": "partial"}]}, open(items, "w"))
    r = run("why", "h"); check("fm why title ref + future until = external", r.stdout.startswith("external") and "g <- h" in r.stdout, r.stdout)
    r = run("why", "k"); check("fm why passed until = cleared", "no open blockers" in r.stdout, r.stdout)
    r = run("why", "r"); check("fm why reverse blocks edge", r.stdout.startswith("owner") and "o <- r" in r.stdout, r.stdout)
    r = run("why", "nope"); check("fm why unknown id", r.returncode != 0)

print(f"{'PASS' if not fails else 'FAIL'}: fm unit tests, {fails} failed")
sys.exit(1 if fails else 0)
