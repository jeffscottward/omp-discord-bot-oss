#!/usr/bin/env python3
"""Channel cleanup = delete (owner 2026-10-23): "archive" a Discord channel means DELETE it once the learners
have scanned its OMP sessions. The OMP chat logs stay on disk as the record (like the TUI).

Candidates: channels of closed mirrored panes (agents.json entry archived=true) and every channel still in a
legacy 📦 Archive category (config mirror.categories.archive / mirror.archives, if any are left).
Rule (owner 2026-11-05, msg 100000000000000053, supersedes the 2026-11-01 40-channel gate, which is gone):
a channel with no message for 7 days whose job is done and that holds no open work is deleted, in any category.
A candidate is deleted only when ALL of these hold:
  (a) idle: no Discord message and no OMP log write for IDLE_DAYS days (7 unless --idle-days N says otherwise);
  (b) the learners are done with it. Learners that read per-session OMP logs:
        daily-skill-bot (nightly 04:00 aar-loop over ~/.omp/agent/sessions + the bot's sessions folder, main+Second).
      It collects metrics over EVERY session of its window but sends only the 40 most informative of ~180 per day
      to the model (DSB_MAX_SESSIONS cost cap), so most sessions never get a per-session marker
      (runs/<day>/batch-NN.json + batch-NN.aar.json). Waiting for a marker held ~300 channels forever (card
      channel-purge-stuck, 2026-11-07). Decision: a log with a marker newer than the channel's last activity is
      "learned"; a log without one is deletable once a completed daily run ended after the channel's last activity
      (the learner is alive and had its chance), because the OMP log stays on disk and the learners can still read it.
      No completed daily run since the last activity = HOLD (the learner is down).
      No OMP session log on disk at all = nothing for the learners to process: deletable by (a) and (c) alone
      (a live pane never is). --empty-dupes: an empty closed pane channel in a pane mirror category goes without
      the idle wait (nothing to learn, nothing to copy; re-read at delete time).
      Other scanners (failure-digest, firstmate-sweep, card sweep, fm-autoclear) read logs/journal or tracker
      cards, not channels; open cards are protected below.
  (c) a JSON safety copy of the Discord messages, including every thread (active, archived public and private), is written first (a thread listing error holds the channel);
  and the channel is not protected: keepChannelIds or any configured *ChannelId(s) (FIRSTMATE, needs-you, alerts), linked by an open
  FIRSTMATE card (q/src/l), has an open ask menu (asks.json), or a queued bot job.
--drop-categories: afterwards, delete empty legacy archive categories and every stack category (mirror.stackCategories)
  that has had 0 channels for an hour (EMPTY_CAT_GRACE_MS, seen empty on two runs; state in empty-stack-cats.json); its id
  leaves config.json and the mirror makes the stack's category again on demand (owner 2026-11-07, card channel-purge-stuck).
Usage: purge-archive.py [--dry-run] [--json] [--drop-categories] [--ignore-learned] [--empty-dupes] [--idle-days N] [--drop-oldest N]
--idle-days N: idle days before a delete (default 7, the owner rule; the daily run passes 7 explicitly).
--drop-oldest N (owner 2026-11-07, server at the 500-channel limit): delete only the N (1..10) unprotected candidates with the
  oldest last activity, in any category, without waiting for the learners; each gets a JSON + HTML copy first. The bot runs it
  with --hold id,id,... (channels it uses right now; always held).
--ignore-learned: owner override (2026-10-24): delete idle channels without waiting for the learners; protected holds (open card, ask menu, queued job, keep list) still apply; OMP logs stay on disk.
--empty-dupes (owner 2026-10-25, hourly timer): also delete a closed pane channel (agents.json entry archived, no live
  pane uses it) in a pane mirror category (mirror.categories.local/peer, mirror.overflow/overflowSecond, mirror.stackCategories) that has NO OMP session log
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
# Owner 2026-11-05 (msg 100000000000000053, cards channel-cleanup-week, channel-purge-stuck): every eligible channel idle
# >= IDLE_DAYS (no message, no log write) is deleted, in any category; the 40-channel gate of 2026-11-01 is superseded.
IDLE_DAYS = 7.0
if "--idle-days" in args:
    i = args.index("--idle-days")
    try: IDLE_DAYS = float(args[i + 1]); args = args[:i] + args[i + 2:]
    except (IndexError, ValueError): IDLE_DAYS = -1; args = args[:i] + args[i + 1:]
# Owner 2026-11-07 (card server-full-auto-drop): "if the server is full, run a sweep and drop the 10 oldest channels".
# --drop-oldest N (1..10) deletes the N eligible candidates with the oldest last activity, in any category, without
# waiting for the learners; protected holds (keep list, open card, ask menu, queued job, live pane) still apply and
# each channel gets a JSON + HTML copy first. The bot runs it when Discord refuses a create at the 500-channel limit.
DROP_OLDEST = None
DROP_MAX = 10
DROP_MIN_IDLE_MS = 3600_000
if "--drop-oldest" in args:
    i = args.index("--drop-oldest")
    try: DROP_OLDEST = int(args[i + 1]); args = args[:i] + args[i + 2:]
    except (IndexError, ValueError): DROP_OLDEST = -1; args = args[:i] + args[i + 1:]
# --hold id,id,... (review 2026-11-07): channel ids the bot uses right now (live panes, panes matched again in its
# current pass, before agents.json is saved); always held.
HOLD = set()
if "--hold" in args:
    i = args.index("--hold")
    v = args[i + 1] if i + 1 < len(args) else ""
    if re.fullmatch(r"\d+(,\d+)*", v): HOLD = set(v.split(",")); args = args[:i] + args[i + 2:]
    else: HOLD = None; args = args[:i] + args[i + 1:]
UNKNOWN = [a for a in args if a not in ("--dry-run", "--json", "--drop-categories", "--ignore-learned", "--empty-dupes")]
if IDLE_DAYS is not None and IDLE_DAYS <= 0: UNKNOWN.append("--idle-days needs a positive number")
if DROP_OLDEST is not None and not 1 <= DROP_OLDEST <= DROP_MAX: UNKNOWN.append(f"--drop-oldest needs a number from 1 to {DROP_MAX}")
if HOLD is None: UNKNOWN.append("--hold needs comma-separated channel ids")
if UNKNOWN:
    sys.exit("unknown option(s): " + " ".join(UNKNOWN) + " (a typo must never run a real purge)")
BOT = f"{HOME}/.local/share/omp-discord-bot"
DSB_RUNS = f"{HOME}/.local/state/daily-skill-bot/runs"
OUT = f"{HOME}/.local/state/omp-discord/deleted-archive/{time.strftime('%Y%m%dT%H%M%S')}"
DISCORD_EPOCH = 1420070400000
PANE_CATS = set()  # pane mirror categories (filled in main from config); empty = no channel is an empty duplicate


def snowflake_ms(i):
    return (int(i) >> 22) + DISCORD_EPOCH if i else 0


IDLE_MS = IDLE_DAYS * 86400000
EMPTY_CAT_GRACE_MS = 3600_000
EMPTY_CATS_STATE = f"{HOME}/.local/state/omp-discord/empty-stack-cats.json"
LEARNER_WINDOWS = []  # [(start, end)] epoch ms of completed daily daily-skill-bot runs; filled in main


def learner_windows():
    """[(start, end)] epoch ms of every completed daily daily-skill-bot run (runs/<YYYY-MM-DD>/ with report.md and
    aggregate-input.json). Its collector reads every session with activity in the window (metrics); only the cost cap
    keeps most of them from the model. Dry runs and DSB_RUN_TAG backfills (runs/<day>-<tag>) read only some sessions."""
    out = []
    for f in glob.glob(f"{DSB_RUNS}/*/aggregate-input.json"):
        d = os.path.dirname(f)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", os.path.basename(d)) or not os.path.exists(os.path.join(d, "report.md")):
            continue
        try:
            a, b = (time.mktime(time.strptime(x.strip(), "%Y-%m-%d %H:%M")) * 1000 for x in json.load(open(f))["window"].split(" to "))
            out.append((a, b))
        except Exception:
            continue
    return sorted(out)


def covered(t_ms, windows):
    """True when a completed daily learner run's window contains t_ms (minute-rounded window strings: 1 min slack)."""
    return any(a - 60_000 <= t_ms < b + 60_000 for a, b in windows)


def empty_stack_cats(chans, stack_ids, seen, now_ms):
    """Owner 2026-11-07 (card channel-purge-stuck): stack categories with 0 channels go after EMPTY_CAT_GRACE_MS.
    chans: the guild channel list; stack_ids: ids in mirror.stackCategories; seen: {id: epoch ms first seen empty}
    (from the previous run). Returns (ids to delete, new seen map). A category is deleted only when it exists, has no
    child channel, was created over an hour ago and was already empty on a run at least an hour ago (so a category
    the mirror just made for a channel it is about to create, or one that was just emptied, stays)."""
    cats = {c["id"] for c in chans if c.get("type") == 4}
    used = {c.get("parent_id") for c in chans if c.get("type") != 4}
    empty = [i for i in stack_ids if i in cats and i not in used]
    new_seen = {i: seen.get(i, now_ms) for i in empty}
    drop = [i for i in empty if now_ms - snowflake_ms(i) >= EMPTY_CAT_GRACE_MS and now_ms - new_seen[i] >= EMPTY_CAT_GRACE_MS]
    return drop, new_seen


def drop_stack_ids(cfg_file, ids):
    """Remove category ids from config.json mirror.stackCategories (a stack with no id left is removed): backup copy,
    then an atomic rename (0600) of a temp file of our own (the bot's saveMirrorValue uses config.json.tmp). When the
    file changed while we worked (the bot saved), nothing is written; the bot then drops deleted ids itself on its next
    main sync. Returns True when the file changed."""
    raw = open(cfg_file).read()
    cfg = json.loads(raw)
    sc = (cfg.get("mirror") or {}).get("stackCategories")
    if not isinstance(sc, dict): return False
    out = {}
    for s, lst in sc.items():
        keep = [x for x in lst if x not in ids] if isinstance(lst, list) else lst
        if keep != []: out[s] = keep
    if out == sc: return False
    cfg["mirror"]["stackCategories"] = out
    tmp = f"{cfg_file}.purge-archive-{os.getpid()}.tmp"
    write_private(f"{cfg_file}.before-stackcat-drop-{int(time.time() * 1000)}", raw)
    write_private(tmp, json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    if open(cfg_file).read() != raw:
        os.unlink(tmp)
        raise RuntimeError("config.json changed while dropping stack category ids; left to the bot")
    os.replace(tmp, cfg_file)
    return True


def write_private(path, text):
    """Write text to a new 0600 file (never readable by others, not even for a moment)."""
    if os.path.exists(path): os.unlink(path)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f: f.write(text)


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


class MacUnreachable(Exception):
    """The Second did not answer, so whether its OMP session log exists is unknown (the channel is held)."""


def session_logs(cid, entry):
    """[(path, host, mtime_ms)] of existing OMP logs for a channel."""
    out = []
    for p in glob.glob(f"{BOT}/sessions/{cid}/**/*.jsonl", recursive=True) + glob.glob(f"{BOT}/sessions/side-{cid}/**/*.jsonl", recursive=True):
        # The learners never read __*.jsonl (__advisor.jsonl repeats the main session; daily-skill-bot collect.py), so a
        # marker for it can never exist; requiring one held such channels forever (card channel-cleanup-week, 2026-11-05).
        if os.path.basename(p).startswith("__"): continue
        out.append((p, "main", os.stat(p).st_mtime * 1000))
    sf = (entry or {}).get("sessionFile")
    if sf:
        if (entry or {}).get("machine") == "second":
            r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "peer-host", "stat", "-c", "%Y", sf],
                               capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip().isdigit():
                out.append((sf, "second", int(r.stdout.strip()) * 1000))
            elif not (r.returncode == 1 and re.search(r"^stat: cannot stat(x)? .*: No such file or directory$", r.stderr.strip(), re.M)):
                # ssh itself failed (255: Second asleep/offline) or stat broke: never read that as "no log on disk" (that
                # would allow a delete). Only stat's own "No such file" with exit 1 counts as absent (review 2026-11-07).
                raise MacUnreachable(sf)
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
DROP_REASON = "server full: one of the oldest idle closed-job channels (owner 2026-11-07); JSON + HTML copy kept"


def pick_oldest(rows, n):
    """Owner 2026-11-07 (card server-full-auto-drop): the ids of at most n (never more than DROP_MAX) deletable rows
    with the oldest last activity. rows: [{id, delete, oldest}] where oldest is the last message (or channel) snowflake."""
    ok = sorted((r for r in rows if r["delete"]), key=lambda r: int(r["oldest"]))
    return [r["id"] for r in ok[: max(0, min(n, DROP_MAX))]]


def idle_reason(last_ms, now_ms):
    """Hold reason when the channel was active within IDLE_DAYS, else None."""
    if now_ms - last_ms >= IDLE_MS: return None
    return (f"active {(now_ms - last_ms) / 86400000:.1f} days ago (" + time.strftime("%m-%d %H:%M", time.localtime(last_ms / 1000))
            + f"); deleted after {IDLE_DAYS:g} idle days")


def decide(c, entry, marks, protected_reason, windows=None, now_ms=None):
    """Return (delete: bool, reason). Owner rule 2026-11-05: idle IDLE_DAYS, job done, no open work, learners done.
    Learners done = for EVERY log of the channel a per-session daily-skill-bot marker from a run whose window ended after
    the channel's last activity, or (card channel-purge-stuck, 2026-11-07) a completed daily run whose window holds the
    log's last write: its collector read the log and the cost cap left it unsampled; the log stays on disk for the
    learners. A log write in a learner gap (no completed run over it) holds the channel. windows: [(start, end)] ms."""
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    windows = LEARNER_WINDOWS if windows is None else windows
    if protected_reason:
        return False, protected_reason
    if DROP_OLDEST:
        # Review 2026-11-07: never a channel with a message in the last hour (the owner may still read it).
        if now_ms - snowflake_ms(c.get("last_message_id") or c["id"]) < DROP_MIN_IDLE_MS:
            return False, "server-full sweep: active in the last hour"
        return True, DROP_REASON
    closed = not entry or bool(entry.get("archived"))  # no entry = a legacy 📦 Archive channel of a long-closed job
    msg_ms = snowflake_ms(c.get("last_message_id") or c["id"])
    try: logs = session_logs(c["id"], entry)
    except MacUnreachable: return False, "Second unreachable: cannot check its OMP session log"
    if not logs:
        if EMPTY_DUPES and entry and entry.get("archived") and c.get("parent_id") in PANE_CATS and not c.get("last_message_id"):
            return True, EMPTY_REASON
        if not closed: return False, "no OMP session log on disk (pane is live)"
        why = idle_reason(msg_ms, now_ms)
        if why: return False, "no OMP session log on disk; " + why
        # Card channel-purge-stuck: nothing on disk for the learners to process, so only the idle rule and the holds apply.
        return True, f"idle {(now_ms - msg_ms) / 86400000:.1f} days, no OMP session log on disk (nothing for the learners)"
    last = max([msg_ms] + [m for _, _, m in logs])
    why = idle_reason(last, now_ms)
    if why: return False, why
    if IGNORE_LEARNED:
        return True, f"owner override: deleted before the learners ({len(logs)} log(s) kept on disk)"
    unsampled = [(p, m) for p, _, m in logs if max(marks.get(p, 0), marks.get(sid(p) or "", 0)) <= last]
    if not unsampled:
        return True, f"learned (daily-skill-bot marker for {len(logs)} log(s)); logs kept"
    if not closed:
        return False, "pane is live and daily-skill-bot did not sample " + os.path.basename(unsampled[0][0])[:40]
    gap = [m for _, m in unsampled if not covered(m, windows)]
    if gap:
        return False, ("no completed daily-skill-bot run covers its last log write (" + time.strftime("%m-%d %H:%M", time.localtime(max(gap) / 1000))
                       + "); the learner never read it")
    return True, (f"idle {(now_ms - last) / 86400000:.1f} days; daily-skill-bot read its log(s) in its daily run but its cost cap "
                  + f"left {len(unsampled)} of {len(logs)} unsampled for the model; logs kept on disk for the learners")


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


def newest_ms(copy):
    """Newest activity in a safety copy (epoch ms): the newest message or thread snowflake of the channel and its threads."""
    ids = [m.get("id") for m in copy["messages"]] + [t["id"] for t in copy["threads"]] + [m.get("id") for t in copy["threads"] for m in t["messages"]]
    return max([snowflake_ms(i) for i in ids if i] + [0])


def html_copy(path, cid):
    """Render the JSON safety copy at path as ~/Documents/reports/web/discord-archive/<cid>.html (archive-to-html.py).
    Returns the page path, or None when rendering failed (the caller then holds the channel)."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "archive-to-html.py")
    out = f"{HOME}/Documents/reports/web/discord-archive/{cid}.html"
    try: r = subprocess.run([sys.executable, script, path], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError): return None
    return out if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0 else None


def main():
    env = open(f"{HOME}/.config/omp-discord/bot.env").read()
    token = re.search(r'^(?:export\s+)?DISCORD_(?:BOT_)?TOKEN=["\']?([^"\'\n]+)', env, re.M).group(1)
    cfg = json.load(open(f"{HOME}/.config/omp-discord/config.json"))
    guild = cfg["guildId"]
    arch = [x for x in [cfg.get("mirror", {}).get("categories", {}).get("archive")] + cfg.get("mirror", {}).get("archives", []) if x]
    mcfg = cfg.get("mirror", {})
    PANE_CATS.update(x for x in [(mcfg.get("categories") or {}).get("local"), (mcfg.get("categories") or {}).get("peer")] + (mcfg.get("overflow") or []) + (mcfg.get("overflowSecond") or []) if x)
    # Owner 2026-10-30 (card bot-upgrades-1030): main pane channels also live in one category per stack.
    PANE_CATS.update(x for ids in (mcfg.get("stackCategories") or {}).values() if isinstance(ids, list) for x in ids if isinstance(x, str) and x)
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
    global LEARNER_WINDOWS
    LEARNER_WINDOWS = learner_windows()
    results = []
    for c in cands:
        e = by_ch.get(c["id"])
        # Server-full sweep (review 2026-11-07): a live pane's channel is held in every category, a legacy 📦 one too.
        prot = ("standing channel (config)" if c["id"] in keep else "linked by an open FIRSTMATE card" if c["id"] in linked else "open ask menu" if c["id"] in asks
                else "queued bot job" if c["id"] in queued else "pane is live again" if e and not e.get("archived") and (DROP_OLDEST or c.get("parent_id") not in arch)
                else "in use by the bot (--hold)" if c["id"] in HOLD else "")
        ok, why = decide(c, e, marks, prot)
        results.append({"id": c["id"], "name": c["name"], "delete": ok, "reason": why, "category": c.get("parent_id") or "",
                        "idleDays": round((time.time() * 1000 - snowflake_ms(c.get("last_message_id") or c["id"])) / 86400000, 1)})

    # Owner 2026-11-05 (msg 100000000000000053): the 2026-11-01 40-channel gate is superseded; every eligible candidate
    # goes, oldest first (decide() already applied the idle rule and the holds).
    by_id = {c["id"]: c for c in cands}
    eligible = sorted((r for r in results if r["delete"]), key=lambda r: int(by_id[r["id"]].get("last_message_id") or r["id"]))
    not_oldest = f"not among the {DROP_OLDEST} oldest (server-full sweep)"
    if DROP_OLDEST and DRY:
        picked = set(pick_oldest([{"id": r["id"], "delete": r["delete"], "oldest": by_id[r["id"]].get("last_message_id") or r["id"]} for r in results], DROP_OLDEST))
        for r in results:
            if r["delete"] and r["id"] not in picked: r["delete"], r["reason"] = False, not_oldest

    deleted, deleted_ids, pages = [], [], []
    if not DRY and any(r["delete"] for r in results):
        os.makedirs(OUT, mode=0o700, exist_ok=True)
        active = api(f"/guilds/{guild}/threads/active").get("threads", [])
        fails = 0  # server-full sweep: give up after 2 x N failed channels or one rate limit (review 2026-11-07)
        for r in eligible:
            cat = by_id[r["id"]].get("parent_id") or ""
            if DROP_OLDEST and len(deleted) >= DROP_OLDEST:
                r["delete"], r["reason"] = False, not_oldest; continue
            if DROP_OLDEST and fails >= 2 * DROP_OLDEST:
                r["delete"], r["reason"] = False, "server-full sweep stopped after repeated failures"; continue
            try: copy = safety_copy(api, r["id"], r["name"], active)
            except urllib.error.HTTPError as e:
                fails += 1
                r["delete"], r["reason"] = False, f"safety copy failed (HTTP {e.code} reading messages or threads)"; continue
            except Exception as e:  # server-full sweep: one bad channel never stops the sweep (review 2026-11-07)
                if not DROP_OLDEST: raise
                fails += 2 * DROP_OLDEST if str(e).startswith("rate limited") else 1
                r["delete"], r["reason"] = False, f"safety copy failed ({e})"; continue
            if copy is None:
                print(f"skip #{r['name']}: already gone (404)"); r["delete"], r["reason"] = False, "already gone (404)"; continue
            if r["reason"] == EMPTY_REASON and (copy["messages"] or copy["threads"]):
                r["delete"], r["reason"] = False, "no OMP session log on disk (channel has messages)"; continue
            # Review 2026-11-07: open work may point at a THREAD of the channel (card link, ask menu, queued job, keep list,
            # --hold); the thread goes with its channel, so it holds the channel too (every mode).
            tids = [t["id"] for t in copy["threads"]]
            if any(t in keep or t in linked or t in asks or t in HOLD or t in queued for t in tids):
                r["delete"], r["reason"] = False, "a thread of it has open work (card, ask menu, queued job, keep list or --hold)"; continue
            if not DROP_OLDEST and r["reason"] != EMPTY_REASON:
                why = idle_reason(newest_ms(copy), time.time() * 1000)
                if why:  # a thread (or a message since the scan) is newer than the channel's last message (card channel-purge-stuck)
                    r["delete"], r["reason"] = False, "channel or thread " + why; continue
            if live_again(r["id"]):
                r["delete"], r["reason"] = False, "pane is live again (agents.json re-read at delete time)"; continue
            path = f"{OUT}/{r['id']}-{re.sub(r'[^a-z0-9-]+', '', r['name'].lower())[:60]}.json"
            with open(path, "w") as f:
                json.dump(copy, f)
            if os.path.getsize(path) < 10: r["delete"], r["reason"] = False, "safety copy failed"; continue
            page = None
            if DROP_OLDEST:
                # Owner 2026-11-07: a JSON + HTML copy of each dropped channel (served under reports/web/discord-archive).
                page = html_copy(path, r["id"])
                if not page: fails += 1; r["delete"], r["reason"] = False, "HTML copy failed"; continue
            try: gone = delete_gone_ok(api, f"/channels/{r['id']}")
            except Exception as e:
                if not DROP_OLDEST: raise
                fails += 2 * DROP_OLDEST if str(e).startswith("rate limited") else 1
                r["delete"], r["reason"] = False, f"delete failed ({e})"; continue
            if gone:
                deleted.append(r["name"]); deleted_ids.append(r["id"])
                if page: pages.append(page)
                # One stderr line per delete, so the bot can name what went even if this run dies before the JSON.
                if DROP_OLDEST: print(f"dropped {r['id']} {r['name']}", file=sys.stderr, flush=True)
            elif DROP_OLDEST:
                r["delete"], r["reason"] = False, "already gone (404)"
    dropped, would_drop = [], []
    if DROP_CATS and not DRY:
        all_ch = api(f"/guilds/{guild}/channels")
        exists = {c["id"] for c in all_ch}
        left = {c.get("parent_id") for c in all_ch if c.get("type") != 4}
        for cat in arch:
            if cat in exists and cat not in left and delete_gone_ok(api, f"/channels/{cat}"):
                dropped.append(cat)
    if DROP_CATS:
        # Owner 2026-11-07 (card channel-purge-stuck): a stack category with 0 channels for an hour is deleted and leaves
        # mirror.stackCategories; the mirror makes it again when the stack has a channel (addStackCategory). The base pane
        # categories (local, peer, overflow) and legacy archives are never in this list.
        base = set(arch) | {x for x in [(mcfg.get("categories") or {}).get("local"), (mcfg.get("categories") or {}).get("peer")] if x} \
            | set(mcfg.get("overflow") or []) | set(mcfg.get("overflowMac") or [])
        stack_ids = [x for ids in (mcfg.get("stackCategories") or {}).values() if isinstance(ids, list)
                     for x in ids if isinstance(x, str) and x and x not in base]
        try: seen = json.load(open(EMPTY_CATS_STATE))
        except Exception: seen = {}
        now_ms = time.time() * 1000
        all_ch = chans if DRY else api(f"/guilds/{guild}/channels")
        drop, new_seen = empty_stack_cats(all_ch, stack_ids, seen if isinstance(seen, dict) else {}, now_ms)
        if DRY:
            would_drop = drop
        else:
            gone_cats = []
            for cat in drop:
                # Re-read right before the delete: the mirror may have moved a channel in since the list above.
                if cat not in empty_stack_cats(api(f"/guilds/{guild}/channels"), [cat], {cat: 0}, now_ms)[0]: continue
                if delete_gone_ok(api, f"/channels/{cat}"): dropped.append(cat)
                gone_cats.append(cat)  # deleted now or already gone (404): either way its id leaves the config
            if gone_cats:
                try: drop_stack_ids(f"{HOME}/.config/omp-discord/config.json", set(gone_cats))
                except Exception as e: print(f"dropping {gone_cats} from config.json mirror.stackCategories failed: {e} (the mirror drops deleted ids itself)")
            try:
                os.makedirs(os.path.dirname(EMPTY_CATS_STATE), exist_ok=True)
                write_private(EMPTY_CATS_STATE + ".tmp", json.dumps({k: v for k, v in new_seen.items() if k not in gone_cats}))
                os.replace(EMPTY_CATS_STATE + ".tmp", EMPTY_CATS_STATE)
            except Exception as e: print(f"saving {EMPTY_CATS_STATE} failed: {e}")
    summary = {"candidates": len(results), "deleted": len(deleted) if not DRY else sum(r["delete"] for r in results),
               "held": [r for r in results if not r["delete"]], "dryRun": DRY, "droppedCategories": dropped, "wouldDropCategories": would_drop,
               "copies": OUT if deleted else None,
               "deletedIds": deleted_ids if not DRY else [r["id"] for r in results if r["delete"]],
               "deletedNames": deleted if not DRY else [r["name"] for r in results if r["delete"]], "pages": pages}
    if AS_JSON:
        print(json.dumps({**summary, "results": results}, indent=1))
    else:
        for r in results: print(("DELETE " if r["delete"] else "hold   ") + f"#{r['name']} ({r['id']}): {r['reason']}")
        print(f"candidates={summary['candidates']} {'would delete' if DRY else 'deleted'}={summary['deleted']} held={len(summary['held'])}"
              + (f"; copies in {OUT}" if deleted else "") + (f"; dropped categories {dropped}" if dropped else "")
              + (f"; would drop empty stack categories {would_drop}" if would_drop else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
