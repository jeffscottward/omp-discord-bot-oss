#!/usr/bin/python3
"""FIRSTMATE dashboard: write running.json (agent jobs + background services). Read-only.

Sources (nothing is started, stopped or changed):
- `herdr pane list` / `herdr tab list`: OMP panes, their label, cwd and agent_status.
- OMP session files: only the title line and the task-file paths named in the first
  user message (the prompt text itself is not copied).
- `systemctl --user show/list-timers` on this machine (host label FM_HOST_LABEL).
- Optional peer host (FM_PEER_HOST, FM_PEER_SSH): `ssh <peer> systemctl show/list-timers` (system units), cached 2 min.
Settings: ~/.config/omp-discord/kit.env (see kit/kit.env.example).
Run by firstmate-running.timer every 30 s. No secrets, no account data, no log lines.
"""
import importlib.util, json, os, re, socket, subprocess, time
from datetime import datetime, timezone


def _kit_env():
    """Read the kit settings file (KEY=VALUE lines; the shell kit scripts read the same file).
    File: $OMP_KIT_ENV, else ~/.config/omp-discord/kit.env. A variable that is already set in the environment wins."""
    path = os.environ.get("OMP_KIT_ENV") or os.path.expanduser("~/.config/omp-discord/kit.env")
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].strip()
        key, sep, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if not sep or line.startswith("#") or not key.isidentifier() or key in os.environ:
            continue
        if len(val) >= 2 and val[0] == val[-1] == "'":
            val = val[1:-1]
        else:
            if len(val) >= 2 and val[0] == val[-1] == '"':
                val = val[1:-1]
            val = os.path.expanduser(os.path.expandvars(val))
        os.environ[key] = val


_kit_env()

HOME = os.path.expanduser("~")
WEB = os.environ.get("REPORTS_WEB_DIR") or os.path.join(HOME, ".local/share/omp-discord/reports-web")
HERE = os.environ.get("FM_DIR") or os.path.join(WEB, "firstmate")
OUT = os.path.join(HERE, "running.json")
LOCAL_HOST = os.environ.get("FM_HOST_LABEL") or "local"  # label of this machine's rows (job tags "<label>:<unit>")
PEER_HOST = os.environ.get("FM_PEER_HOST") or ""  # optional second machine, read-only over ssh; empty = off
PEER_SSH = os.environ.get("FM_PEER_SSH") or PEER_HOST  # ssh target (Host alias in ~/.ssh/config)
PEER_GROUP = os.environ.get("FM_PEER_GROUP") or PEER_HOST  # its group name on the dashboard
VPS_CACHE = os.path.join(HOME, ".cache/firstmate-dashboard", (PEER_HOST or "peer") + ".json")
VPS_TTL = 120


def _pairs(text, sep="="):
    """'a=b;c=d' -> [('a', 'b'), ('c', 'd')] (kit.env list format)."""
    out = []
    for part in (text or "").split(";"):
        k, s, v = part.partition(sep)
        if s and k.strip():
            out.append((k.strip(), v.strip()))
    return out


_spec = importlib.util.spec_from_file_location("bi", os.path.join(os.path.dirname(os.path.realpath(__file__)), "build-index.py"))
bi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bi)

# (group, unit-name regex), in display order. kit.env FM_SERVICE_GROUPS='Group=regex;Group=regex' replaces the list.
RIG_GROUPS = _pairs(os.environ.get("FM_SERVICE_GROUPS")) or [
    ("Discord + OMP", r"^(omp-|channel-cleanup)"),
    ("Reminders", r"^reminders-"),
    ("Maintenance", r"^(firstmate-|fm-)"),
]
# Peer host units: FM_PEER_UNIT_GLOBS (space-separated systemctl globs) and FM_PEER_UNIT_PATTERN (regex).
VPS_GLOBS = (os.environ.get("FM_PEER_UNIT_GLOBS") or "").split()
VPS_PAT = os.environ.get("FM_PEER_UNIT_PATTERN") or ("^(" + "|".join(re.escape(g.rstrip("*")) for g in VPS_GLOBS) + ")" if VPS_GLOBS else "^$")
# Units to show even when they do not exist: FM_EXPECTED_UNITS='unit|group|description;...'.
EXPECTED = [tuple(x.split("|", 2)) for x in (os.environ.get("FM_EXPECTED_UNITS") or "").split(";") if x.count("|") >= 2]
# unit -> dashboard link (report or page); FM_SERVICE_LINKS='unit=/reports/...;unit=...' adds to (or replaces) these.
LINKS = {
    "omp-reports-web.service": "/reports/",
    "firstmate-index.service": "/reports/firstmate/reports.json",
    "firstmate-running.service": "/reports/firstmate/running.json",
    **dict(_pairs(os.environ.get("FM_SERVICE_LINKS"))),
}
VPS_LINK = os.environ.get("FM_PEER_LINK") or None  # link for every peer host row
PROPS = "Id,Description,ActiveState,SubState,Result,LoadState,UnitFileState,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainStatus,TriggeredBy,Triggers,ActiveEnterTimestamp"
GLYPH = re.compile(r"[\u2800-\u28ff\ue000-\uf8ff\U000f0000-\U000ffffd\U00100000-\U0010fffd]")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def safe_desc(d, unit):
    """Transient units use their command line as Description; never publish argv."""
    if d.startswith("[systemd-run]"):
        m = re.search(r"--name[ =]\"?([\w .:/+-]{1,60})", d)
        return "Transient job" + (": " + m.group(1).strip() if m else " (" + unit.removesuffix(".service") + ")")
    return tilde_all(d)


def tilde_all(t):
    return (t or "").replace(HOME, "~").replace("/root/", "~root/")


def tilde(p):
    return ("~" + p[len(HOME):]) if p and p.startswith(HOME) else p


def us_iso(us):
    try:
        us = int(us)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(us / 1e6, timezone.utc).isoformat(timespec="seconds") if us > 0 else None


def ts_iso(s):
    """systemd 'Sun 2026-10-18 16:17:19 EDT' -> ISO (local zone)."""
    if not s or s == "n/a":
        return None
    if s.startswith("@"):
        try:
            return datetime.fromtimestamp(int(s[1:]), timezone.utc).isoformat(timespec="seconds")
        except ValueError:
            return None
    try:
        if s.split()[-1] == "UTC":
            return datetime.strptime(" ".join(s.split()[1:3]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
        return datetime.strptime(" ".join(s.split()[1:3]), "%Y-%m-%d %H:%M:%S").astimezone().astimezone(timezone.utc).isoformat(timespec="seconds")
    except ValueError:
        return None


# ---------------- agent jobs ----------------
def clean_title(t):
    t = GLYPH.sub("", t or "")
    t = re.sub(r"^\s*π\s*[>]?\s*", "", t)
    return re.sub(r"\s+", " ", t).strip()


_SESS_CACHE = os.path.join(HOME, ".cache/firstmate-dashboard/sessions.json")
_sess = None


def session_info(path):
    """Title, start time and the task file from the first user message.
    Reads at most the first 256 KB of the session file; cached by path (the head never changes)."""
    global _sess
    if _sess is None:
        _sess = bi.read_json(_SESS_CACHE, {}) or {}
    info = {"title": None, "started": None, "active": None, "tasks": []}
    if not path or not os.path.isfile(path):
        return info
    active = datetime.fromtimestamp(os.stat(path).st_mtime, timezone.utc).isoformat(timespec="seconds")
    hit = _sess.get(path)
    if hit and hit.get("tasks") is not None and hit.get("complete"):
        return {**hit, "active": active}
    info["active"] = active
    try:
        with open(path, "rb") as fb:
            head = fb.read(256 * 1024).decode("utf-8", "replace")
        lines = head.split("\n")[:-1] if len(head) >= 256 * 1024 else head.split("\n")
        for n, line in enumerate(lines):
            if n > 80:
                break
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("type") == "title" and not info["title"]:
                info["title"] = clean_title(o.get("title"))
            elif o.get("type") == "session":
                info["started"] = o.get("timestamp")
            elif o.get("type") == "message" and (o.get("message") or {}).get("role") == "user":
                c = o["message"].get("content")
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                text = str(c or "")[:4000]
                info["complete"] = True
                # Only the task file the prompt asks to carry out: the first *-task.md named.
                found = re.findall(r"(?:~|/home/[\w.-]+)?[\w./-]*?[\w.-]+-task\.md", text)[:1]
                seen = []
                for p in found:
                    p = p.replace("~", HOME, 1) if p.startswith("~") else p
                    if not p.startswith("/"):
                        p = os.path.join(o.get("cwd") or "", p)
                    if p not in seen:
                        seen.append(p)
                info["tasks"] = seen
                break
    except OSError:
        pass
    if info.get("complete"):
        _sess[path] = {k: v for k, v in info.items() if k != "active"}
    return info


def task_ref(p):
    rel = os.path.relpath(p, WEB) if p.startswith(WEB + os.sep) else None
    return {"path": tilde(p), "web": rel, "exists": os.path.isfile(p)}


def jobs():
    rc, out = run(["herdr", "pane", "list"])
    if rc:
        return None
    panes = json.loads(out).get("result", {}).get("panes", [])
    rc, out = run(["herdr", "tab", "list"])
    tabs = {t["tab_id"]: t for t in (json.loads(out).get("result", {}).get("tabs", []) if not rc else [])}
    res = []
    for p in panes:
        if p.get("agent") != "omp":
            continue
        sess = (p.get("agent_session") or {}).get("value")
        si = session_info(sess)
        title = si["title"] or clean_title(p.get("terminal_title_stripped"))
        m = re.match(r"^([A-Z0-9]{2,8}):\s*(.*)$", title)
        tab = tabs.get(p.get("tab_id"), {})
        res.append({
            "id": p["pane_id"], "tab": p.get("tab_id"), "tabLabel": GLYPH.sub("", tab.get("label") or "").strip() or None,
            "tabNumber": tab.get("number"), "title": title, "code": m.group(1) if m else None,
            "status": p.get("agent_status") or "unknown", "cwd": tilde(p.get("cwd")),
            "started": si["started"], "active": si["active"], "tasks": [task_ref(t) for t in si["tasks"]], "items": [],
        })
    order = {"working": 0, "done": 1, "idle": 2}
    res.sort(key=lambda j: (order.get(j["status"], 3), -(datetime.fromisoformat(j["active"]).timestamp() if j["active"] else 0)))
    return res


def link_items(job_list):
    data = bi.read_json(os.path.join(HERE, "items.json"), {}) or {}
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return {}
    ids = bi.item_ids(items)
    as_list = lambda v: v if isinstance(v, list) else ([v] if v else [])
    item_jobs = {}
    tagged = set()  # jobs named by an explicit item `job`/`task` tag: those tags win over the file-stem rule
    pairs = list(zip(ids, items))
    for iid, it in pairs:
        for j in job_list:
            for want in as_list(it.get("job")):
                w = str(want).lower()
                if w and (w == (j["code"] or "").lower() or w == (j["tabLabel"] or "").lower() or w == j["id"].lower()):
                    tagged.add(j["id"])
    for iid, it in pairs:
        if iid.startswith(("gate-", "owner-")) or it.get("owner") or it.get("until"):
            continue  # time gates and owner steps are never "worked on" by an agent
        l = str(it.get("l") or "")
        lm = re.match(r"^/reports/(.+?)/([\w.-]+?)-(status|summary|findings|result)\.md$", l)
        for j in job_list:
            hit = False
            for t in j["tasks"]:
                full = t["path"]
                base = os.path.basename(full)
                for want in as_list(it.get("task")):
                    w = str(want)
                    if full.endswith("/" + w.lstrip("/")) or base == os.path.basename(w):
                        hit = True
                if lm and t["web"] and t["web"] == f"{lm.group(1)}/{lm.group(2)}-task.md" and j["id"] not in tagged:
                    hit = True
            for want in as_list(it.get("job")):
                w = str(want).lower()
                if w and (w == (j["code"] or "").lower() or w == (j["tabLabel"] or "").lower() or w == j["id"].lower()):
                    hit = True
            if hit:
                j["items"].append(iid)
                item_jobs.setdefault(iid, []).append(j["id"])
    return item_jobs


def unit_base(name):
    """'peer:x.timer' -> ('peer', 'x'): timers and services share one row. Known hosts: FM_HOST_LABEL, FM_PEER_HOST."""
    n, host = str(name).strip().lower(), None
    if ":" in n and n.split(":", 1)[0] in {h.lower() for h in (LOCAL_HOST, PEER_HOST) if h}:
        host, n = n.split(":", 1)
    return host, re.sub(r"\.(service|timer)$", "", n)


def link_units(rows):
    """Item `job` tags that name a unit (owner 2026-10-18: a job can be a Herdr tab or a timer/service).
    Adds row["items"] and returns {item id: ["host:unit", ...]}."""
    data = bi.read_json(os.path.join(HERE, "items.json"), {}) or {}
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return {}
    out = {}
    for iid, it in zip(bi.item_ids(items), items):
        tags = it.get("job") if isinstance(it.get("job"), list) else ([it["job"]] if it.get("job") else [])
        for t in tags:
            h, b = unit_base(t)
            for r in rows:
                if unit_base(r.get("unit", ""))[1] == b and h in (None, r.get("host")):
                    r.setdefault("items", []).append(iid)
                    out.setdefault(iid, []).append(f"{r['host']}:{r['unit']}")
    return out


# ---------------- services ----------------
def parse_show(text):
    units, cur = [], {}
    for line in text.splitlines():
        if not line.strip():
            if cur:
                units.append(cur)
                cur = {}
            continue
        k, _, v = line.partition("=")
        cur[k] = v
    if cur:
        units.append(cur)
    return units


def classify(s, has_timer):
    a, sub, res = s.get("ActiveState"), s.get("SubState"), s.get("Result")
    if a == "failed" or (res and res not in ("success", "")):
        return "failed"
    if s.get("LoadState") == "not-found":
        return "missing"
    if a in ("active", "activating", "reloading") and sub in ("running", "start", "start-pre", "start-post", "auto-restart"):
        return "running"
    if a == "active":
        return "active"
    return "waiting" if has_timer else "stopped"


def services(prefix_cmd, listing_globs, pattern, host, groups=None):
    base = prefix_cmd + (["systemctl", "--user"] if host == LOCAL_HOST else ["env", "TZ=UTC", "systemctl"])  # old remote systemd: no --timestamp=unix
    rc, out = run(base + ["list-units", "--all", "--type=service,timer", "--no-legend", "--plain"] + listing_globs, 25)
    if rc:
        return None
    names = [ln.split()[0] for ln in out.splitlines() if ln.strip()]
    names = sorted({n for n in names if re.search(pattern, n)})
    if host == LOCAL_HOST:
        rc2, out2 = run(base + ["list-unit-files", "--no-legend", "--type=service,timer"], 25)
        for ln in out2.splitlines():
            n = ln.split()[0] if ln.strip() else ""
            if re.search(pattern, n) and n not in names and ln.split()[1:2] != ["transient"]:
                names.append(n)
    if not names:
        return []
    rc, out = run(base + ["show"] + (["--timestamp=unix"] if host == LOCAL_HOST else []) + ["-p", PROPS] + names, 25)
    shows = {u.get("Id"): u for u in parse_show(out)}
    rc, tout = run(base + ["list-timers", "--all", "-o", "json"], 25)
    try:
        timers = {t["unit"]: t for t in json.loads(tout or "[]")}
    except ValueError:
        timers = {}
    rows = {}
    for n in names:
        s = shows.get(n, {})
        if n.endswith(".timer"):
            svc = s.get("Triggers") or (timers.get(n, {}) or {}).get("activates") or n[:-6] + ".service"
            svc = svc.split()[0]
            row = rows.setdefault(svc, {"unit": svc})
            t = timers.get(n, {})
            row.update({"timer": n, "timerState": s.get("ActiveState") + "/" + s.get("SubState") if s else None,
                        "timerEnabled": s.get("UnitFileState"), "next": us_iso(t.get("next")), "lastTrigger": us_iso(t.get("last"))})
            if not row.get("desc") and s.get("Description"):
                row["desc"] = s.get("Description")
        else:
            row = rows.setdefault(n, {"unit": n})
            row["svc"] = s
    out_rows = []
    for unit, row in rows.items():
        s = row.pop("svc", None)
        if s is None:
            s = shows.get(unit) or {}
        has_timer = bool(row.get("timer"))
        if has_timer and (row.get("timerState") or "").startswith("inactive"):
            has_timer = False
        r = {
            "unit": unit, "host": host, "desc": safe_desc(s.get("Description") or row.get("desc") or unit, unit),
            "state": classify(s, has_timer) if s else "unknown",
            "active": s.get("ActiveState"), "sub": s.get("SubState"), "result": s.get("Result"),
            "enabled": s.get("UnitFileState") or None,
            "lastStart": ts_iso(s.get("ExecMainStartTimestamp")) or row.get("lastTrigger"),
            "lastExit": ts_iso(s.get("ExecMainExitTimestamp")), "exitStatus": s.get("ExecMainStatus"),
            "since": ts_iso(s.get("ActiveEnterTimestamp")),
            "timer": row.get("timer"), "timerEnabled": row.get("timerEnabled"), "next": row.get("next"),
            "logs": ("journalctl --user -u " if host == LOCAL_HOST else f"ssh {PEER_SSH} journalctl -u ") + unit.removesuffix(".service"),
            "link": LINKS.get(unit) or (VPS_LINK if host == PEER_HOST else None),
        }
        if row.get("timer") and (row.get("timerState") or "").startswith("inactive"):
            r["note"] = "timer off"
        if groups:
            r["group"] = next((g for g, rx in groups if re.search(rx, unit)), "Other")
        else:
            r["group"] = PEER_GROUP
        out_rows.append(r)
    out_rows.sort(key=lambda r: (r["group"], r["unit"]))
    return out_rows


def vps_services():
    if not PEER_HOST:
        return {}
    try:
        st = os.stat(VPS_CACHE)
        if time.time() - st.st_mtime < VPS_TTL:
            return bi.read_json(VPS_CACHE)
    except OSError:
        pass
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=yes", PEER_SSH]
    # One remote shell per call; each argv item is a fixed literal.
    rows = services(ssh, ["'" + g + "'" for g in VPS_GLOBS], VPS_PAT, PEER_HOST)
    prev = bi.read_json(VPS_CACHE)
    data = {"checked": now_iso(), "ok": rows is not None, "rows": rows if rows is not None else ((prev or {}).get("rows") or []),
            "lastOk": now_iso() if rows is not None else (prev or {}).get("lastOk")}
    os.makedirs(os.path.dirname(VPS_CACHE), exist_ok=True)
    bi.write_json(VPS_CACHE, data)
    return data


ACCT = re.compile(r"\b(?:[UDF]{1,2}\d{5,9}|\d{8,})\b")


def scrub(obj):
    """Drop anything that looks like an account number (broker U1234567 style or long digit runs)."""
    if isinstance(obj, str):
        return ACCT.sub("[hidden]", obj) if not re.match(r"^\d{4}-\d\d-\d\dT", obj) else obj
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items()}
    return obj


def main():
    j = jobs()
    item_jobs = link_items(j) if j else {}
    main = services([], [], "|".join(rx for _, rx in RIG_GROUPS), LOCAL_HOST, RIG_GROUPS) or []
    have = {r["unit"] for r in main}
    for unit, group, desc in EXPECTED:
        if unit not in have:
            main.append({"unit": unit, "host": LOCAL_HOST, "group": group, "desc": desc, "state": "off", "note": "no unit installed"})
    main.sort(key=lambda r: ([g for g, _ in RIG_GROUPS].index(r["group"]) if r["group"] in [g for g, _ in RIG_GROUPS] else 99, r["unit"]))
    remote = vps_services()
    item_units = link_units(main + (remote.get("rows") or []))
    data = {
        "generated": now_iso(), "host": os.environ.get("FM_HOST_NAME") or socket.gethostname(), "hostLabel": LOCAL_HOST,
        "jobs": j or [], "jobsOk": j is not None, "itemJobs": item_jobs, "itemUnits": item_units,
        "services": main + (remote.get("rows") or []),
        "peer": {"host": PEER_HOST, "group": PEER_GROUP, "ok": remote.get("ok"), "checked": remote.get("checked"), "lastOk": remote.get("lastOk")} if PEER_HOST else None,
    }
    if PEER_HOST and PEER_HOST not in data:  # older readers use the peer host name as the key
        data[PEER_HOST] = {"ok": remote.get("ok"), "checked": remote.get("checked"), "lastOk": remote.get("lastOk")}
    now = datetime.now(timezone.utc).timestamp() + 120
    for r in data["services"]:
        for k in ("lastStart", "lastExit", "since"):
            if r.get(k) and datetime.fromisoformat(r[k]).timestamp() > now:
                r[k] = None  # a "last" time in the future is a parsing error: show nothing
    bi.write_json(OUT, scrub(data))
    if _sess is not None:
        os.makedirs(os.path.dirname(_SESS_CACHE), exist_ok=True)
        bi.write_json(_SESS_CACHE, _sess)


if __name__ == "__main__":
    main()
