#!/usr/bin/python3
"""FIRSTMATE dashboard indexer (read-only on items.json).

Writes two files next to the dashboard:
  reports.json  every report under $REPORTS_WEB_DIR/* (index pages, other
                HTML, PDFs, audio/video, status/summary Markdown)
  changes.json  last-change time per item id (content hash without id/blockedBy/blocks)

Run by firstmate-index.path (items.json changed) and firstmate-index.timer (every minute).
The id function must match itemIds() in app.js.
Settings (~/.config/omp-discord/kit.env): REPORTS_WEB_DIR, FM_DIR (default $REPORTS_WEB_DIR/firstmate).
"""
import glob, hashlib, json, os, re, tempfile
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

ROOT = os.environ.get("REPORTS_WEB_DIR") or os.path.expanduser("~/.local/share/omp-discord/reports-web")
HERE = os.environ.get("FM_DIR") or os.path.join(ROOT, "firstmate")
KINDS = {".pdf": "pdf", ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".ogg": "audio",
         ".mp4": "video", ".webm": "video", ".html": "html", ".md": "md"}
MD_KEEP = re.compile(r"(status|summary|report|plan|findings)", re.I)
SKIP_DIRS = {"node_modules", ".git"}
LINK_FIELDS = ("id", "blockedBy", "blocks")


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def slug(t):
    s = re.sub(r"[^a-z0-9]+", "-", (t or "").lower()).strip("-")[:48].strip("-")
    return s or "item"


def item_ids(items):
    seen, out = set(), []
    for i in items:
        base = i.get("id") or slug(i.get("t", ""))
        k, n = base, 2
        while k in seen:
            k, n = f"{base}-{n}", n + 1
        seen.add(k)
        out.append(k)
    return out


def content_hash(item):
    core = {k: v for k, v in item.items() if k not in LINK_FIELDS}
    return hashlib.sha1(json.dumps(core, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def write_json(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def title_of(path, kind):
    try:
        with open(path, errors="replace") as f:
            head = f.read(20000)
    except OSError:
        return None
    if kind == "html":
        m = re.search(r"<title>(.*?)</title>", head, re.S | re.I)
        return re.sub(r"\s+", " ", m.group(1)).strip() if m else None
    if kind == "md":
        m = re.search(r"^#\s+(.+)$", head, re.M)
        return m.group(1).strip() if m else None
    return None


def build_reports():
    out = []
    for top in sorted(os.listdir(ROOT)):
        d = os.path.join(ROOT, top)
        if not os.path.isdir(d) or top.startswith("."):
            continue
        for dirpath, dirnames, files in os.walk(d):
            dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS and not x.startswith(".")]
            if dirpath.count(os.sep) - d.count(os.sep) > 2:
                dirnames[:] = []
                continue
            for name in sorted(files):
                ext = os.path.splitext(name)[1].lower()
                kind = KINDS.get(ext)
                if not kind or name.startswith("."):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, ROOT)
                if rel == "firstmate/index.html":
                    continue  # the dashboard itself
                if kind == "md" and (not MD_KEEP.search(name) or name.endswith("-task.md")):
                    continue
                st = os.stat(full)
                path = rel[: -len("index.html")] if name == "index.html" else rel
                out.append({"path": path, "group": top, "kind": kind, "name": name,
                            "title": title_of(full, kind) or (top if name == "index.html" else name),
                            "size": st.st_size, "mtime": iso(st.st_mtime)})
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def snapshots():
    """Older items.json copies (agents copy before editing), oldest first."""
    snaps = []
    for p in glob.glob(os.path.join(HERE, "items.json.*")):
        data = read_json(p)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            continue
        items = data["items"]
        snaps.append((os.stat(p).st_mtime, {k: content_hash(i) for k, i in zip(item_ids(items), items)},
                      {slug(i.get("t", "")): content_hash(i) for i in items}))
    snaps.sort(key=lambda s: s[0])
    return snaps


def seed(iid, item, h, snaps):
    """First sight of an item: estimate its last change from the backups.
    A backup is taken right before an edit, so a change happened just after the
    newest backup whose copy of the item differs."""
    st = slug(item.get("t", ""))
    differs_at, absent = None, False
    for ts, by_id, by_slug in reversed(snaps):
        old = by_id.get(iid) or by_slug.get(st)
        if old != h:
            differs_at, absent = ts, old is None
            break
    if differs_at is not None:
        rec = {"h": h, "at": iso(differs_at), "approx": True}
        if absent:
            rec["new"] = True
        return rec
    return {"h": h, "at": None, "before": iso(snaps[0][0]) if snaps else None, "approx": True}


def build_changes(items):
    path = os.path.join(HERE, "changes.json")
    prev = read_json(path, {}) or {}
    known = prev.get("items", {})
    now = iso(datetime.now(timezone.utc).timestamp())
    snaps = None
    out = {}
    for iid, item in zip(item_ids(items), items):
        h = content_hash(item)
        old = known.get(iid)
        if old and old.get("h") == h:
            out[iid] = old
        elif old:
            out[iid] = {"h": h, "at": now}
        else:
            if snaps is None:
                snaps = snapshots()
            out[iid] = seed(iid, item, h, snaps) if not prev else {"h": h, "at": now, "new": True}
    return {"first": prev.get("first", now), "checked": now, "items": out}


def main():
    data = read_json(os.path.join(HERE, "items.json"))
    reports = build_reports()
    old_reports = read_json(os.path.join(HERE, "reports.json"), {}) or {}
    if old_reports.get("reports") != reports:
        write_json(os.path.join(HERE, "reports.json"), {"built": iso(datetime.now(timezone.utc).timestamp()), "reports": reports})
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        ch = build_changes(data["items"])
        old = read_json(os.path.join(HERE, "changes.json"), {}) or {}
        if old.get("items") != ch["items"]:
            write_json(os.path.join(HERE, "changes.json"), ch)


if __name__ == "__main__":
    main()
