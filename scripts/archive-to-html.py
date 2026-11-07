#!/usr/bin/env python3
"""Render a purged channel's JSON safety copy (deleted-archive/*/<id>-<name>.json or <id>--<name>.json) as a
phone-friendly HTML page under ~/Documents/reports/web/discord-archive/<id>.html, with an anchor per message
(#m<message id>). Thread messages of the copy follow the channel's own messages, one section per thread.
Usage: archive-to-html.py <json file> [...]   (owner 2026-10-21: dashboard cards linking to purged channels)"""
import html, json, os, re, sys
OUT = os.path.expanduser("~/Documents/reports/web/discord-archive")


def rows_of(msgs):
    rows = []
    for m in sorted(msgs, key=lambda m: (len(str(m.get("id") or "")), str(m.get("id") or ""))):  # snowflake order, never a crash
        a = m.get("author"); who = html.escape(a.get("username", "?") if isinstance(a, dict) else str(a or "?"))
        ts = html.escape((m.get("timestamp") or m.get("ts") or "")[:16].replace("T", " "))
        body = html.escape(m.get("content") or "").replace("\n", "<br>")
        rows.append(f'<div class="m" id="m{html.escape(str(m.get("id")))}"><div class="h"><b>{who}</b> <span>{ts} UTC</span></div><div>{body}</div></div>')
    return rows


def render(path):
    data = json.load(open(path))
    msgs = data if isinstance(data, list) else data.get("messages", [])
    threads = [] if isinstance(data, list) else data.get("threads", []) or []
    base = os.path.basename(path).removesuffix(".json")
    # File names: <id>--<name> (older copies) or <id>-<name> (purge-archive.py); the copy's own id wins.
    m = re.match(r"^(\d+)-+(.*)$", base)
    cid = str(data.get("id")) if isinstance(data, dict) and data.get("id") else (m.group(1) if m else base)
    name = str(data.get("channel")) if isinstance(data, dict) and data.get("channel") else (m.group(2) if m else base)
    rows = rows_of(msgs)
    parts = rows[:]
    for t in threads:
        tr = rows_of(t.get("messages") or [])
        parts.append(f'<h3>🧵 {html.escape(str(t.get("name") or t.get("id") or "thread"))} ({len(tr)} messages)</h3>' + "".join(tr))
    n = len(rows) + sum(len(t.get("messages") or []) for t in threads)
    page = (f'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>#{html.escape(name)} (archived)</title><style>body{{font:15px/1.45 system-ui;margin:0;padding:12px;background:#111;color:#ddd}}'
            f'.m{{border-bottom:1px solid #333;padding:8px 0}}.m:target{{background:#2a2a10}}.h span{{color:#888;font-size:12px}}</style>'
            f'<h2>#{html.escape(name)}</h2><p>Saved copy of a deleted Discord channel ({n} messages).</p>' + "".join(parts))
    os.makedirs(OUT, exist_ok=True)
    out = f"{OUT}/{cid}.html"
    open(out, "w").write(page)
    return out, n


if __name__ == "__main__":
    for path in sys.argv[1:]:
        out, n = render(path)
        print(out, n)
