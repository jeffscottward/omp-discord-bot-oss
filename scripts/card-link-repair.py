#!/usr/bin/env python3
"""Repair FIRSTMATE cards whose q/src is a Discord CHANNEL link (no message id) — pstack audit 2026-10-25.

Contract C1 says a card opens a message. Agents used to copy the run's channel URL into `src`.
For each card that is not done (done cards are only flagged by the dashboard; rewriting them would move
them in the Done list), this repairs the link ONLY when a message in that channel names the card itself
(an `item:<id>` token or the id in a code span, written by the bot or an agent about this card); the oldest such
message wins. A bare `?item=<id>` dashboard URL does not count. A time-based guess ("the owner's last message before the card") was tried and rejected: 4 of 5
spot checks pointed at a different request. No proof: the card is left as it is and listed as "flagged".

Usage: card-link-repair.py [--dry-run] [--json]     Bot token from ~/.config/omp-discord/bot.env (never printed).
"""
import json, os, re, subprocess, sys, time, urllib.error, urllib.request

HOME = os.path.expanduser("~")
ITEMS = os.environ.get("FM_ITEMS") or f"{HOME}/Documents/reports/web/firstmate/items.json"
CHANNEL_ONLY = re.compile(r"^https://discord\.com/channels/(\d+)/(\d+)/?$")
SCAN_PAGES = 10  # newest 500 messages per channel


def mentions(text, card):
    """The card is named in the text itself: an `item:<id>` token or the id in a code span. A `?item=<id>` dashboard
    URL alone does not count: the bot adds it to replies that only touched the card (a spot check found one about
    a different subject)."""
    c = re.escape(card)
    return re.search(r"(?<![=\w-])item:" + c + r"(?![\w-])|`" + c + r"`", text or "") is not None


def pick(messages, card):
    """The oldest message whose text or embeds name the card, or None."""
    hits = [m for m in messages if mentions((m.get("content") or "") + " " + json.dumps(m.get("embeds") or []), card)]
    return min(hits, key=lambda m: int(m["id"])) if hits else None


def plan(items, fetch):
    """[(card, field, old, new | None, reason)] for every not-done card with a channel-only q/src.
    `fetch(channel_id)` returns that channel's recent messages (any order); it may raise HTTPError."""
    out, cache = [], {}
    for it in items:
        if it.get("s") == "done":
            continue
        for f in ("q", "src"):
            m = CHANNEL_ONLY.match(str(it.get(f) or ""))
            if not m:
                continue
            cid = m.group(2)
            if cid not in cache:
                try:
                    cache[cid] = fetch(cid)
                except urllib.error.HTTPError as e:
                    cache[cid] = e.code
            msgs = cache[cid]
            if isinstance(msgs, int):
                out.append((it["id"], f, it[f], None, f"channel unreadable (HTTP {msgs})"))
                continue
            hit = pick(msgs, it["id"])
            if hit:
                out.append((it["id"], f, it[f], f"https://discord.com/channels/{m.group(1)}/{cid}/{hit['id']}", "message that names the card"))
            else:
                out.append((it["id"], f, it[f], None, "no message in the channel names the card"))
    return out


def main():
    dry, as_json = "--dry-run" in sys.argv, "--json" in sys.argv
    env = open(f"{HOME}/.config/omp-discord/bot.env").read()
    token = re.search(r'^(?:export\s+)?DISCORD_(?:BOT_)?TOKEN=["\']?([^"\'\n]+)', env, re.M).group(1)

    def page(cid, before):
        for _ in range(5):
            url = f"https://discord.com/api/v10/channels/{cid}/messages?limit=50" + (f"&before={before}" if before else "")
            req = urllib.request.Request(url, headers={"Authorization": "Bot " + token, "User-Agent": "DiscordBot (omp, 1)"})
            try:
                return json.loads(urllib.request.urlopen(req, timeout=30).read())
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(float(json.loads(e.read() or b"{}").get("retry_after", 2)) + 0.2)
        raise RuntimeError("rate limited")

    def fetch(cid):
        msgs, before = [], None
        for _ in range(SCAN_PAGES):
            p = page(cid, before)
            msgs += p
            if len(p) < 50:
                break
            before = p[-1]["id"]
        return msgs

    d = json.load(open(ITEMS))
    items = d.get("items", []) if isinstance(d, dict) else d
    rows = plan(items, fetch)
    done = []
    for card, f, _old, new, _why in rows:
        if not new or dry:
            continue
        cmd = ["fm", "q", card, new] if f == "q" else ["fm", "field", card, "src", new]
        r = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "FM_BY": "card-link-repair"})
        if r.returncode == 0:
            done.append(card)
    if as_json:
        print(json.dumps([{"card": c, "field": f, "new": n, "reason": w} for c, f, _o, n, w in rows], indent=1))
    else:
        for c, f, _o, n, w in rows:
            print(("REPAIR " if n else "flag   ") + f"{c}.{f}: {w}" + (f" -> {n}" if n else ""))
        fixed = sum(1 for r in rows if r[3]) if dry else len(done)
        print(f"cards={len(rows)} {'would repair' if dry else 'repaired'}={fixed} flagged={sum(1 for r in rows if not r[3])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
