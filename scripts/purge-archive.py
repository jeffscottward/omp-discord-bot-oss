#!/usr/bin/env python3
"""Channel cleanup = delete (owner 2026-10-23): "archive" a Discord channel means DELETE it once the learners
have scanned its OMP sessions. The OMP chat logs stay on disk as the record (like the TUI).

Candidates: channels of closed mirrored panes (agents.json entry archived=true) and every channel still in a
legacy 📦 Archive category (config mirror.categories.archive / mirror.archives, if any are left).
A candidate is deleted only when ALL of these hold:
  (a) at least one OMP session log of the channel exists on disk (pane sessionFile, on the main host or over ssh on
      the peer machine, and/or the bot's side session folder sessions/<channel id>/). Exception, only with --empty-dupes: a
      closed pane channel in a pane mirror category with no log, no last message and (re-read at delete time) no
      message and no thread; the protected holds below still apply first;
  (b) every learner has processed it. Learners that read per-session OMP logs:
        daily-skill-bot (nightly 04:00 aar-loop over ~/.omp/agent/sessions + the bot's sessions folder, main+second machine).
      Marker (per session): runs/<day>/batch-NN.json (+ batch-NN.aar.json = model finished) lists the sessions
      that run sent to the model (file + id; max 40 per run). A channel is learned only when EVERY OMP log of it
      has such a marker from a run whose window ended after the channel's last activity (newest of last Discord
      message and log mtime). No marker (not sampled, or predates the learner) = HOLD and report.
      Other scanners (failure-digest, firstmate-sweep, card sweep, fm-autoclear) read logs/journal or tracker
      cards, not channels; open cards are protected below.
  (c) a JSON safety copy of the Discord messages, including every thread (active, archived public and private), is written first (a thread listing error holds the channel);
  and the channel is not protected: keepChannelIds or any configured *ChannelId(s) (FIRSTMATE, needs-you, alerts), linked by an open
  FIRSTMATE card (q/src/l), has an open ask menu (asks.json), or a queued bot job.
If (b) is false the channel is held; it is deleted only after a later learner run samples it.
Afterwards, empty legacy archive categories are deleted (--drop-categories).
Usage: purge-archive.py [--dry-run] [--json] [--drop-categories] [--ignore-learned] [--empty-dupes]
--ignore-learned: owner override (2026-10-24): delete without waiting for the learners; protected holds (open card, ask menu, queued job, keep list) still apply; OMP logs stay on disk.
--empty-dupes (owner 2026-10-25, hourly timer): also delete a closed pane channel (agents.json entry archived, no live
  pane uses it) in a pane mirror category (mirror.categories.local/peer, mirror.overflow) that has NO OMP session log
  and NO message or thread (nothing to learn, nothing to copy). Without it such a channel is held forever: after the
  2026-10-24 reboots the P6 resume opened duplicate tabs, the mirror made 20 empty duplicate channels for them, and the
  full 🖥️ Main category (50/50) then blocked every new pane channel. The delete step re-reads the messages and threads
  and holds the channel if any exist. The JSON record is written to deleted-archive/ like every other delete."""
import glob, json, os, re, subprocess, sys, time, urllib.request, urllib.error

HOME = os.path.expanduser("~")
args = sys.argv[1:]
DRY = "--dry-run" in args
AS_JSON = "--json" in args
DROP_CATS = "--drop-categories" in args
IGNORE_LEARNED = "--ignore-learned" in args
EMPTY_DUPES = "--empty-dupes" in args
UNKNOWN = [a for a in args if a not in ("--dry-run", "--json", "--drop-categories", "--ignore-learned", "--empty-dupes")]
if UNKNOWN:
    sys.exit("unknown option(s): " + " ".join(UNKNOWN) + " (a typo must never run a real purge)")
BOT = f"{HOME}/.local/share/omp-discord-bot"
DSB_RUNS = f"{HOME}/.local/state/daily-skill-bot/runs"
OUT = f"{HOME}/.local/state/omp-discord/deleted-archive/{time.strftime('%Y%m%dT%H%M%S')}"
DISCORD_EPOCH = 1420070400000
PANE_CATS = set()  # pane mirror categories (filled in main from config); empty = no channel is an empty duplicate


def snowflake_ms(i):
    return (int(i) >> 22) + DISCORD_EPOCH if i else 0


def learner_markers():
    """Per-session markers: {session file path or id: newest window end (epoch ms) of a completed daily-skill-bot run
    that sent this session to the model (runs/<day>/batch-*.json; only the sampled sessions, max 40 per run)."""
    marks = {}
    for f in glob.glob(f"{DSB_RUNS}/*/aggregate-input.json"):
        d = os.path.dirname(f)
        if d.endswith("-dry") or not os.path.exists(os.path.join(d, "report.md")):
            continue
        try:
            w = json.load(open(f))["window"]
            end = time.mktime(time.strptime(w.split(" to ")[1].strip(), "%Y-%m-%d %H:%M")) * 1000
        except Exception:
            continue
        for bf in glob.glob(f"{d}/batch-[0-9][0-9].json"):
            if not os.path.exists(bf[:-5] + ".aar.json"):
                continue  # batch not finished by the model
            try: batch = json.load(open(bf))
            except Exception: continue
            for x in batch:
                for k in (os.path.expanduser(x.get("file", "")) if x.get("file") else None, x.get("id")):
                    if k: marks[k] = max(marks.get(k, 0), end)
    return marks


def session_logs(cid, entry):
    """[(path, host, mtime_ms)] of existing OMP logs for a channel."""
    out = []
    for p in glob.glob(f"{BOT}/sessions/{cid}/**/*.jsonl", recursive=True) + glob.glob(f"{BOT}/sessions/side-{cid}/**/*.jsonl", recursive=True):
        out.append((p, "main", os.stat(p).st_mtime * 1000))
    sf = (entry or {}).get("sessionFile")
    if sf:
        if (entry or {}).get("machine") == "second":
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "peer-host", "stat", "-c", "%Y", sf],
                               capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip().isdigit():
                out.append((sf, "second", int(r.stdout.strip()) * 1000))
        elif os.path.exists(sf):
            out.append((sf, "main", os.stat(sf).st_mtime * 1000))
    return out


def sid(path):
    m = re.search(r"_([0-9a-f-]{36})\.jsonl$", path)
    return m.group(1) if m else None


def live_again(cid, path=None):
    """True when the mirror revived the channel's entry (archived=false) since the run started, or agents.json is
    unreadable. The mirror matches archived entries by pane, tab and name; deleting a revived channel would make the
    bot close that live pane's tab (closeDeleted)."""
    try: entries = json.load(open(path or f"{BOT}/agents.json"))
    except Exception: return True
    return any(e.get("channelId") == cid and not e.get("archived") for e in entries)


EMPTY_REASON = "empty channel of a closed pane, no OMP session log (nothing to learn)"


def decide(c, entry, marks, protected_reason):
    """Return (delete: bool, reason). Learned = a per-session daily-skill-bot marker exists for EVERY log of the
    channel, from a run whose window ended after the channel's last activity. Otherwise HOLD."""
    if protected_reason:
        return False, protected_reason
    logs = session_logs(c["id"], entry)
    if not logs:
        if EMPTY_DUPES and entry and entry.get("archived") and c.get("parent_id") in PANE_CATS and not c.get("last_message_id"):
            return True, EMPTY_REASON
        return False, "no OMP session log on disk"
    if IGNORE_LEARNED:
        return True, f"owner override: deleted before the learners ({len(logs)} log(s) kept on disk)"
    last = max([snowflake_ms(c.get("last_message_id"))] + [m for _, _, m in logs])
    for path, _, _ in logs:
        mark = max(marks.get(path, 0), marks.get(sid(path) or "", 0))
        if not mark:
            return False, "no per-session marker (daily-skill-bot did not sample " + os.path.basename(path)[:40] + ")"
        if mark <= last:
            return False, "marker older than last activity (" + time.strftime("%m-%d %H:%M", time.localtime(last / 1000)) + "); waits for a later learner run"
    return True, f"learned (daily-skill-bot marker for {len(logs)} log(s)); logs kept"


def delete_gone_ok(api, path):
    """DELETE path; a 404 means it is already gone (for example a category deleted earlier). Returns True if deleted now."""
    try:
        api(path, "DELETE"); return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"skip {path}: already gone (404)"); return False
        raise

def fetch_messages(api, cid):
    """All messages of one channel or thread, oldest first. None when it is already gone (404)."""
    msgs, before = [], None
    while True:
        try: page = api(f"/channels/{cid}/messages?limit=100" + (f"&before={before}" if before else ""))
        except urllib.error.HTTPError as e:
            if e.code != 404: raise
            return None
        if not page: break
        msgs += [{"id": m["id"], "ts": m["timestamp"], "author": m["author"]["username"], "content": m["content"],
                  "attachments": [a.get("url") for a in m.get("attachments", [])]} for m in page]
        before = page[-1]["id"]
        if len(page) < 100: break
    return msgs[::-1]


def channel_threads(api, cid, active):
    """Every thread of a channel: active ones (from the guild list) plus archived public and private ones.
    Threads are deleted with their channel, so the safety copy needs them (pstack audit 2026-10-25).
    A listing error (for example 403 on private threads) raises: the caller then holds the channel."""
    found = {t["id"]: t for t in active if t.get("parent_id") == cid}
    for kind in ("public", "private"):
        before = None
        while True:
            try: page = api(f"/channels/{cid}/threads/archived/{kind}?limit=100" + (f"&before={before}" if before else ""))
            except urllib.error.HTTPError as e:
                if e.code == 404: return None  # the channel itself is gone
                raise
            ts = page.get("threads", [])
            for t in ts: found.setdefault(t["id"], t)
            if not page.get("has_more") or not ts: break
            before = ts[-1].get("thread_metadata", {}).get("archive_timestamp")
            if not before: break
    return list(found.values())


def safety_copy(api, cid, name, active):
    """The JSON copy written before a delete: the channel's messages plus each thread's messages.
    None when the channel is already gone (404)."""
    msgs = fetch_messages(api, cid)
    if msgs is None: return None
    threads = channel_threads(api, cid, active)
    if threads is None: return None
    out = []
    for t in threads:
        tm = fetch_messages(api, t["id"])
        out.append({"id": t["id"], "name": t.get("name", ""), "messages": tm or []})
    return {"channel": name, "id": cid, "messages": msgs, "threads": out}


def main():
    env = open(f"{HOME}/.config/omp-discord/bot.env").read()
    token = re.search(r'^(?:export\s+)?DISCORD_(?:BOT_)?TOKEN=["\']?([^"\'\n]+)', env, re.M).group(1)
    cfg = json.load(open(f"{HOME}/.config/omp-discord/config.json"))
    guild = cfg["guildId"]
    arch = [x for x in [cfg.get("mirror", {}).get("categories", {}).get("archive")] + cfg.get("mirror", {}).get("archives", []) if x]
    mcfg = cfg.get("mirror", {})
    PANE_CATS.update(x for x in [(mcfg.get("categories") or {}).get("local"), (mcfg.get("categories") or {}).get("peer")] + (mcfg.get("overflow") or []) if x)
    # Standing channels: keepChannelIds plus every configured channel id (FIRSTMATE, needs-you, alerts, voice, ...).
    # Names are not used: closed pane channels named like "...-firstmate-sweep" are ordinary side channels.
    keep = set(cfg.get("keepChannelIds", []))
    for k, v in cfg.items():
        if k.endswith("ChannelId") and isinstance(v, str): keep.add(v)
        if k.endswith("ChannelIds") and isinstance(v, list): keep.update(x for x in v if isinstance(x, str))

    def api(path, method="GET", body=None):
        for _ in range(6):
            req = urllib.request.Request("https://discord.com/api/v10" + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Authorization": "Bot " + token, "User-Agent": "DiscordBot (omp, 1)", "Content-Type": "application/json"})
            try:
                b = urllib.request.urlopen(req, timeout=30).read()
                return json.loads(b) if b else {}
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(float(json.loads(e.read() or b"{}").get("retry_after", 2)) + 0.2)
                    continue
                raise
        raise RuntimeError("rate limited: " + path)

    try:
        items = json.load(open(f"{HOME}/Documents/reports/web/firstmate/items.json"))
        items = items.get("items", []) if isinstance(items, dict) else items
        linked = {m for it in items if it.get("s") != "done" for f in ("q", "src", "l") if isinstance(it.get(f), str)
                  for m in re.findall(r"discord\.com/channels/\d+/(\d+)", it[f])}
    except Exception:
        print("tracker unreadable; deleting nothing"); return 0
    try: asks = {s.get("channelId") for s in json.load(open(f"{BOT}/asks.json")).get("sets", [])}
    except Exception: asks = None
    try: queued = json.dumps(json.load(open(f"{BOT}/queue.json")).get("jobs", []))
    except Exception: queued = None
    if asks is None or queued is None:
        print("asks.json/queue.json unreadable; deleting nothing"); return 0
    try: entries = json.load(open(f"{BOT}/agents.json"))
    except Exception: print("agents.json unreadable; deleting nothing"); return 0
    by_ch = {}
    for e in entries:  # a live entry wins over an old archived one for the same channel
        if e.get("channelId") and (e["channelId"] not in by_ch or not e.get("archived")):
            by_ch[e["channelId"]] = e

    chans = api(f"/guilds/{guild}/channels")
    cands = [c for c in chans if c.get("type") != 4 and (c.get("parent_id") in arch or (by_ch.get(c["id"]) or {}).get("archived"))]
    marks = learner_markers()
    results = []
    for c in cands:
        e = by_ch.get(c["id"])
        prot = ("standing channel (config)" if c["id"] in keep else "linked by an open FIRSTMATE card" if c["id"] in linked else "open ask menu" if c["id"] in asks
                else "queued bot job" if c["id"] in queued else "pane is live again" if e and not e.get("archived") and c.get("parent_id") not in arch else "")
        ok, why = decide(c, e, marks, prot)
        results.append({"id": c["id"], "name": c["name"], "delete": ok, "reason": why})

    deleted = []
    if not DRY and any(r["delete"] for r in results):
        os.makedirs(OUT, mode=0o700, exist_ok=True)
        active = api(f"/guilds/{guild}/threads/active").get("threads", [])
        for r in [r for r in results if r["delete"]]:
            try: copy = safety_copy(api, r["id"], r["name"], active)
            except urllib.error.HTTPError as e:
                r["delete"], r["reason"] = False, f"safety copy failed (HTTP {e.code} reading messages or threads)"; continue
            if copy is None:
                print(f"skip #{r['name']}: already gone (404)"); r["delete"], r["reason"] = False, "already gone (404)"; continue
            if r["reason"] == EMPTY_REASON and (copy["messages"] or copy["threads"]):
                r["delete"], r["reason"] = False, "no OMP session log on disk (channel has messages)"; continue
            if live_again(r["id"]):
                r["delete"], r["reason"] = False, "pane is live again (agents.json re-read at delete time)"; continue
            path = f"{OUT}/{r['id']}-{re.sub(r'[^a-z0-9-]+', '', r['name'].lower())[:60]}.json"
            with open(path, "w") as f:
                json.dump(copy, f)
            if os.path.getsize(path) < 10: r["delete"], r["reason"] = False, "safety copy failed"; continue
            if delete_gone_ok(api, f"/channels/{r['id']}"): deleted.append(r["name"])
    dropped = []
    if DROP_CATS and not DRY:
        all_ch = api(f"/guilds/{guild}/channels")
        exists = {c["id"] for c in all_ch}
        left = {c.get("parent_id") for c in all_ch if c.get("type") != 4}
        for cat in arch:
            if cat in exists and cat not in left and delete_gone_ok(api, f"/channels/{cat}"):
                dropped.append(cat)
    summary = {"candidates": len(results), "deleted": len(deleted) if not DRY else sum(r["delete"] for r in results),
               "held": [r for r in results if not r["delete"]], "dryRun": DRY, "droppedCategories": dropped,
               "copies": OUT if deleted else None}
    if AS_JSON:
        print(json.dumps({**summary, "results": results}, indent=1))
    else:
        for r in results: print(("DELETE " if r["delete"] else "hold   ") + f"#{r['name']} ({r['id']}): {r['reason']}")
        print(f"candidates={summary['candidates']} {'would delete' if DRY else 'deleted'}={summary['deleted']} held={len(summary['held'])}"
              + (f"; copies in {OUT}" if deleted else "") + (f"; dropped categories {dropped}" if dropped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
