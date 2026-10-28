#!/usr/bin/env python3
"""Render a purged channel's JSON safety copy (deleted-archive/*/<id>--<name>.json) as a phone-friendly HTML page under
~/Documents/reports/web/discord-archive/<id>.html, with an anchor per message (#m<message id>).
Usage: archive-to-html.py <json file> [...]   (owner 2026-10-21: dashboard cards linking to purged channels)"""
import html, json, os, sys
OUT = os.path.expanduser("~/Documents/reports/web/discord-archive")
os.makedirs(OUT, exist_ok=True)
for path in sys.argv[1:]:
    data = json.load(open(path))
    msgs = data if isinstance(data, list) else data.get("messages", [])
    cid, _, name = os.path.basename(path).removesuffix(".json").partition("--")
    rows = []
    for m in sorted(msgs, key=lambda m: m.get("id", "")):
        a = m.get("author"); who = html.escape(a.get("username", "?") if isinstance(a, dict) else str(a or "?"))
        ts = html.escape((m.get("timestamp") or m.get("ts") or "")[:16].replace("T", " "))
        body = html.escape(m.get("content") or "").replace("\n", "<br>")
        rows.append(f'<div class="m" id="m{m.get("id")}"><div class="h"><b>{who}</b> <span>{ts} UTC</span></div><div>{body}</div></div>')
    page = (f'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>#{html.escape(name)} (archived)</title><style>body{{font:15px/1.45 system-ui;margin:0;padding:12px;background:#111;color:#ddd}}'
            f'.m{{border-bottom:1px solid #333;padding:8px 0}}.m:target{{background:#2a2a10}}.h span{{color:#888;font-size:12px}}</style>'
            f'<h2>#{html.escape(name)}</h2><p>Saved copy of a deleted Discord channel ({len(rows)} messages).</p>' + "".join(rows))
    open(f"{OUT}/{cid}.html", "w").write(page)
    print(f"{OUT}/{cid}.html", len(rows))
