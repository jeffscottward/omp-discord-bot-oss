"""Live coordination between running jobs (owner 2026-11-04, card agent-coordination-protocol).

Shared by `fm` (claim/release/claims/status/board), `fm-spawn` (refuse a spawn whose resources another job holds)
and `fm-coord` (the per-stack coordinator loop).

Data: ONE file next to items.json, coord.json, written only under coord.json.lock (separate from the tracker lock,
so claims never slow card writes):
  {"claims": [{"resource", "card", "pane", "ts", "renewed"}],         one row per held resource
   "status": {"<card>": {"line", "ts", "pane"}},                      last one-line status per card
   "waits":  [{"card", "resource", "holder", "ts"}]}                  refused claims (a job waits on a resource)
Times are epoch ms.

Claim life: a claim is live while ALL hold: the card exists and is not done; no receipt written after the claim;
the claim's pane (when known and Herdr answers) still exists; and the newest of claim time, card beat and status
time is less than TTL (30 min) old. So `fm beat` renews every claim of its card; a receipt or a closed pane ends
them. Dead claims are dropped on the next write.

Resources (kind:body, compared case-insensitively):
  pr:<repo>#<n>  branch:<repo>:<name>  deploy:<target>  file:<repo>:<path-glob>  service:<unit>
Two claims conflict when they name the same resource; two file claims conflict when the repo is the same and the
globs can match a common path.
"""
import fcntl, fnmatch, json, os, re, time
from contextlib import contextmanager

TTL_MS = 30 * 60 * 1000
KINDS = ("pr", "branch", "deploy", "file", "service")
_SHAPES = {
    "pr": re.compile(r"^[^#\s]+#\d+$"),
    "branch": re.compile(r"^[^:\s]+:\S+$"),
    "deploy": re.compile(r"^\S+$"),
    "file": re.compile(r"^[^:\s]+:\S+$"),
    "service": re.compile(r"^\S+$"),
}
HELP = ("resources: pr:<repo>#<n>, branch:<repo>:<name>, deploy:<target>, file:<repo>:<path-glob>, "
        "service:<unit>")


def now_ms():
    return int(time.time() * 1000)


def parse_resource(s):
    """Normalized 'kind:body' or ValueError with the accepted shapes."""
    s = str(s or "").strip()
    kind, sep, body = s.partition(":")
    kind = kind.lower()
    if not sep or kind not in KINDS or not _SHAPES[kind].match(body):
        raise ValueError(f"bad resource {s!r}; {HELP}")
    if kind == "file":
        repo, _, glob = body.partition(":")
        return f"file:{repo.lower()}:{glob.lstrip('/')}"
    return f"{kind}:{body.lower()}"


def _literal_prefix(g):
    m = re.search(r"[*?\[]", g)
    return g if m is None else g[:m.start()]


def globs_overlap(a, b):
    """True when some path can match both globs. Conservative: unsure means overlap."""
    if a == b:
        return True
    wa, wb = _literal_prefix(a) != a, _literal_prefix(b) != b
    if not wa and not wb:
        return a == b
    if not wa:
        return fnmatch.fnmatchcase(a, b)
    if not wb:
        return fnmatch.fnmatchcase(b, a)
    pa, pb = _literal_prefix(a), _literal_prefix(b)
    return pa.startswith(pb) or pb.startswith(pa)


def overlaps(a, b):
    """a, b: normalized resources."""
    ka, _, ba = a.partition(":")
    kb, _, bb = b.partition(":")
    if ka != kb:
        return False
    if ka != "file":
        return ba == bb
    ra, _, ga = ba.partition(":")
    rb, _, gb = bb.partition(":")
    return ra == rb and globs_overlap(ga, gb)


# ---- file ----
def path_for(items_file):
    return os.environ.get("FM_COORD") or os.path.join(os.path.dirname(items_file), "coord.json")


def empty():
    return {"claims": [], "status": {}, "waits": []}


_CLAIMS_LINE = re.compile(r"(?im)^[ \t]*(?:[-*][ \t]*)?\**Claims\**:\**[ \t]*(.*)$")


def task_claims(text):
    """Resources named on the task file's `Claims:` line(s) -> (normalized list, [bad entries]).
    `Claims: none` or an empty line names nothing. Entries are split on commas and spaces; backticks are ignored."""
    res, bad = [], []
    for m in _CLAIMS_LINE.finditer(text or ""):
        for tok in re.split(r"[,\s]+", m.group(1).replace("`", "")):
            if not tok or tok.lower() in ("none", "-", "n/a"):
                continue
            try:
                r = parse_resource(tok)
            except ValueError:
                bad.append(tok)
                continue
            if r not in res:
                res.append(r)
    return res, bad


def read(path):
    try:
        with open(path) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return empty()
    if not isinstance(d, dict):
        return empty()
    d.setdefault("claims", [])
    d.setdefault("status", {})
    d.setdefault("waits", [])
    return d


@contextmanager
def locked(path):
    """Read-modify-write under coord.json.lock. Yields the data; writes it back (temp file + rename) on exit."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        d = read(path)
        yield d
        d["updated"] = now_ms()
        tmp = f"{path}.tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(d, f, indent=1, ensure_ascii=False)
        os.replace(tmp, path)


# ---- liveness ----
def receipt_ms(receipts_dir, card):
    try:
        with open(os.path.join(receipts_dir, card + ".json")) as f:
            r = json.load(f)
        return int(r.get("tsMs") or 0) or None
    except (OSError, ValueError, TypeError):
        return None


def job_activity(running_path, now=None, max_age_ms=10 * 60 * 1000):
    """card -> last pane activity (epoch ms) from running.json jobs[].active (OMP session writes), the same signal
    fm-autoclear counts as a beat. Empty when the file is missing, jobsOk is false or it is older than max_age_ms."""
    from datetime import datetime
    now = now or now_ms()
    try:
        with open(running_path) as f:
            r = json.load(f)
        gen = datetime.fromisoformat(str(r.get("generated") or r.get("jobsAt")).replace("Z", "+00:00")).timestamp() * 1000
        if not r.get("jobsOk") or now - gen > max_age_ms:
            return {}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}
    out = {}
    for j in r.get("jobs") or []:
        try:
            ms = int(datetime.fromisoformat(str(j.get("active")).replace("Z", "+00:00")).timestamp() * 1000)
        except (ValueError, TypeError):
            continue
        for cid in j.get("items") or []:
            out[cid] = max(out.get(cid, 0), ms)
    return out


def last_seen(claim, card, status, active=None):
    st = (status or {}).get(claim.get("card")) or {}
    return max(int(claim.get("renewed") or 0), int(claim.get("ts") or 0), int((card or {}).get("beat") or 0),
               int(st.get("ts") or 0), int((active or {}).get(claim.get("card")) or 0))


def dead_reason(claim, cards, status, receipt, live_panes, now, active=None):
    """None when the claim is live; else why it ended. receipt: card -> receipt tsMs or None.
    live_panes: set of lowercase live Herdr pane/tab ids, or None when Herdr did not answer (pane not checked).
    active: card -> last pane activity (job_activity), which renews like a beat."""
    card = cards.get(claim.get("card"))
    if card is None:
        return "card gone"
    if card.get("s") == "done":
        return "card done"
    r = receipt(claim["card"])
    if r and r >= int(claim.get("ts") or 0):
        return "receipt written"
    pane = str(claim.get("pane") or "").lower()
    if live_panes is not None and pane and pane not in live_panes:
        return "pane closed"
    if now - last_seen(claim, card, status, active) > TTL_MS:
        return "expired (no beat for 30 min)"
    return None


def split_live(d, cards, receipt, live_panes, now, active=None):
    """(live claims, [(dead claim, reason)])."""
    live, dead = [], []
    for c in d.get("claims") or []:
        why = dead_reason(c, cards, d.get("status"), receipt, live_panes, now, active)
        (dead.append((c, why)) if why else live.append(c))
    return live, dead


def conflicts(live, card, resources):
    """[(wanted resource, holder claim)] for claims of OTHER cards that overlap the wanted resources."""
    out = []
    for r in resources:
        for c in live:
            if c.get("card") != card and overlaps(r, c["resource"]):
                out.append((r, c))
    return out


def claim(d, card, resources, pane, now):
    """Add or renew claims (caller checked conflicts). Drops this card's waits for these resources."""
    for r in resources:
        mine = next((c for c in d["claims"] if c.get("card") == card and c["resource"] == r), None)
        if mine:
            mine["renewed"] = now
            if pane:
                mine["pane"] = pane
        else:
            d["claims"].append({"resource": r, "card": card, "pane": pane or "", "ts": now, "renewed": now})
    d["waits"] = [w for w in d.get("waits") or [] if not (w.get("card") == card and w.get("resource") in resources)]


def release(d, card, resources=None):
    """Remove the card's claims (all, or the given ones) and its waits. Returns the removed resources."""
    gone = [c["resource"] for c in d["claims"] if c.get("card") == card and (resources is None or c["resource"] in resources)]
    d["claims"] = [c for c in d["claims"] if not (c.get("card") == card and c["resource"] in gone)]
    if resources is None:
        d["waits"] = [w for w in d.get("waits") or [] if w.get("card") != card]
    return gone


def add_wait(d, card, resource, holder, now):
    d["waits"] = [w for w in d.get("waits") or [] if not (w.get("card") == card and w.get("resource") == resource)]
    d["waits"].append({"card": card, "resource": resource, "holder": holder, "ts": now})


def set_status(d, card, line, pane, now):
    d["status"][card] = {"line": str(line).strip()[:200], "ts": now, "pane": pane or ""}


# ---- channel link of a pane (bot mirror agents.json) ----
AGENTS = os.environ.get("FM_COORD_AGENTS") or os.path.expanduser("~/.local/share/omp-discord-bot/agents.json")
BOT_CONFIG = os.environ.get("FM_COORD_BOT_CONFIG") or os.path.expanduser("~/.config/omp-discord/config.json")


def channel_link(pane, card=None):
    """Discord link of the job's channel: the bot mirror's channel for the pane, else the card's src/q link."""
    if pane:
        try:
            entries = json.load(open(AGENTS))
            guild = json.load(open(BOT_CONFIG)).get("guildId")
            ch = next((e["channelId"] for e in entries if str(pane) in (e.get("paneId"), e.get("tabId"))
                       and e.get("channelId") and not e.get("archived") and e.get("machine", "main") == "main"), None)
            if ch and guild:
                return f"https://discord.com/channels/{guild}/{ch}"
        except (OSError, ValueError, AttributeError):
            pass
    return (card or {}).get("src") or (card or {}).get("q") or ""


def holder_text(c, cards, now):
    card = cards.get(c.get("card")) or {}
    age = max(0, (now - int(c.get("ts") or now)) // 60000)
    link = channel_link(c.get("pane"), card)
    return (f"card {c.get('card')} (pane {c.get('pane') or '-'}"
            + (f", channel {link}" if link else "") + f", held {age} min)")


# ---- board ----
def stack_of(card):
    return str(card.get("stack") or "firstmate")


def age_min(ts, now):
    return None if not ts else max(0, (now - int(ts)) // 60000)


def board(items, d, now, stack=None, live=None):
    """Rows for every running card (and any card that holds a live claim): stack, card, title, job, status line
    and age, claims with age. `live`: the live claims (default: every claim in d)."""
    live = d.get("claims") if live is None else live
    claims_of = {}
    for c in live:
        claims_of.setdefault(c["card"], []).append(c)
    rows = []
    for it in items:
        cid = it.get("id")
        if not cid or (it.get("s") != "running" and cid not in claims_of):
            continue
        if stack and stack_of(it) != stack:
            continue
        st = (d.get("status") or {}).get(cid) or {}
        rows.append({
            "stack": stack_of(it), "card": cid, "title": str(it.get("t") or "")[:100], "state": it.get("s"),
            "job": it.get("job") or "", "status": st.get("line") or it.get("beatNote") or "",
            "statusAge": age_min(st.get("ts") or it.get("beat"), now),
            "claims": [{"resource": c["resource"], "age": age_min(c.get("ts"), now)} for c in claims_of.get(cid, [])],
        })
    rows.sort(key=lambda r: (r["stack"], r["card"]))
    return rows


def board_text(rows):
    if not rows:
        return "board: no running jobs"
    out = []
    for r in rows:
        age = "-" if r["statusAge"] is None else f"{r['statusAge']}m"
        cl = ", ".join(f"{c['resource']} ({c['age']}m)" for c in r["claims"]) or "no claims"
        out.append(f"{r['stack']} | {r['card']} | {age} | {r['status'][:90] or '(no status)'} | {cl}")
    return "\n".join(out)
