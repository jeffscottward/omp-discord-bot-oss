#!/usr/bin/env python3
"""Owner 2026-10-21: delete 🛑 Stopped replies older than 24 h, plus the stopped request they reply to.
Scans every text channel and active thread in the guild, except channels in the 📦 Archive categories
(those purge themselves). Saves a JSON copy of every deleted message first.
Skips a Stopped reply whose Undo was requested less than 24 h ago (the Undo run may still be in progress).
Usage: stopped-cleanup.py [--dry-run] [--min-age-hours H] [--pages N]
State: ~/.local/state/omp-discord/stopped-cleanup-state.json (consecutive failures, for the owner alert rule)."""
import json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime

HOME = os.path.expanduser("~")
BOT_ID = "100000000000000027"
ALERTS_CHANNEL_NAME = "omp-alerts"
STATE = f"{HOME}/.local/state/omp-discord/stopped-cleanup-state.json"
OUTDIR = f"{HOME}/.local/state/omp-discord/deleted-stopped"


def ts_ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000 if iso else 0


def is_target(m, now, min_age_h):
    """True when m is a bot 🛑 Stopped reply that is old enough and has no recent Undo."""
    if m.get("author", {}).get("id") != BOT_ID or not m.get("content", "").startswith("🛑 Stopped"):
        return False
    lim = min_age_h * 3600_000
    if now - ts_ms(m["timestamp"]) < lim:
        return False
    if "Undo requested" in m["content"] and now - ts_ms(m.get("edited_timestamp") or m["timestamp"]) < lim:
        return False
    return True


def safe_ref(r):
    """Only delete the referenced message when it is an ordinary user message (not the bot, not a system/thread-starter message)."""
    return bool(r) and r.get("author", {}).get("id") != BOT_ID and r.get("type", 0) in (0, 19)


def plan(msgs, now, min_age_h):
    """Return [(stopped_msg, referenced_id or None)] for one channel."""
    return [(m, (m.get("message_reference") or {}).get("message_id")) for m in msgs if is_target(m, now, min_age_h)]


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    min_age = float(args[args.index("--min-age-hours") + 1]) if "--min-age-hours" in args else 24.0
    pages = int(args[args.index("--pages") + 1]) if "--pages" in args else 5
    env = open(f"{HOME}/.config/omp-discord/bot.env").read()
    token = re.search(r'^(?:export\s+)?DISCORD_(?:BOT_)?TOKEN=["\']?([^"\'\n]+)', env, re.M).group(1)
    cfg = json.load(open(f"{HOME}/.config/omp-discord/config.json"))
    guild = cfg["guildId"]
    arch = {x for x in [cfg.get("mirror", {}).get("categories", {}).get("archive")] + cfg.get("mirror", {}).get("archives", []) if x}

    def api(path, method="GET", body=None):
        for _ in range(8):
            req = urllib.request.Request("https://discord.com/api/v10" + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Authorization": "Bot " + token, "User-Agent": "DiscordBot (omp, 1)",
                                                  "Content-Type": "application/json"})
            try:
                b = urllib.request.urlopen(req, timeout=30).read()
                return json.loads(b) if b else {}
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(float(json.loads(e.read() or b"{}").get("retry_after", 2)) + 0.2)
                    continue
                if e.code == 404 and method == "DELETE":
                    return {}
                raise
        raise RuntimeError("rate limited: " + path)

    try: state = json.load(open(STATE))
    except Exception: state = {"fails": 0, "alerted": False}

    def alert(text):
        ch = next((c for c in chans_cache if ALERTS_CHANNEL_NAME in c.get("name", "")), None)
        if ch: api(f"/channels/{ch['id']}/messages", "POST", {"content": text})

    chans_cache = []
    try:
        chans_cache = api(f"/guilds/{guild}/channels")
        texts = [c for c in chans_cache if c.get("type") in (0, 5) and c.get("parent_id") not in arch]
        threads = [t for t in api(f"/guilds/{guild}/threads/active").get("threads", [])
                   if t.get("parent_id") in {c["id"] for c in texts}]
        now = time.time() * 1000
        # Owner 2026-10-21: never delete a message that an open FIRSTMATE card links to (q/src/l).
        try:
            _d = json.load(open(os.path.expanduser("~/Documents/reports/web/firstmate/items.json")))
            _its = _d.get("items", []) if isinstance(_d, dict) else _d
            linked = {x for it in _its if it.get("s") != "done" for f in ("q", "src", "l") if isinstance(it.get(f), str)
                      for pair in re.findall(r"discord\.com/channels/\d+/(\d+)(?:/(\d+))?", it[f]) for x in pair if x}
        except Exception:
            print("tracker unreadable; deleting nothing this run")
            return
        saved, todo = [], []
        for c in texts + threads:
            msgs, before = [], None
            for _ in range(pages):
                try:
                    page = api(f"/channels/{c['id']}/messages?limit=100" + (f"&before={before}" if before else ""))
                except urllib.error.HTTPError as e:
                    if e.code == 403: break  # no read access: not a channel the bot posts in
                    raise
                if not page: break
                msgs += page
                before = page[-1]["id"]
                if len(page) < 100: break
            byid = {m["id"]: m for m in msgs}
            for m, ref in plan(msgs, now, min_age):
                if m["id"] in linked or (ref and ref in linked):
                    continue  # linked by an open card
                r = byid.get(ref) if ref else None
                if ref and not r:
                    try: r = api(f"/channels/{c['id']}/messages/{ref}")
                    except urllib.error.HTTPError: r = None
                if not safe_ref(r): r = None
                for x in ([r] if r else []) + [m]:
                    saved.append({"channel": c.get("name"), "channel_id": c["id"], "id": x["id"], "ts": x["timestamp"],
                                  "author": x["author"]["username"], "content": x["content"],
                                  "attachments": [a.get("url") for a in x.get("attachments", [])]})
                todo.append((c["id"], r["id"] if r else None, m["id"]))
        print(f"{len(todo)} stopped pairs to delete{' (dry run)' if dry else ''}")
        if dry:
            for s in saved: print(" ", s["channel"], s["id"], s["content"][:60].replace("\n", " "))
            return
        if todo:
            os.makedirs(OUTDIR, mode=0o700, exist_ok=True)
            out = f"{OUTDIR}/{time.strftime('%Y%m%dT%H%M%S')}.json"
            with open(out, "w") as f: json.dump(saved, f)
            for cid, ref, sid in todo:
                if ref: api(f"/channels/{cid}/messages/{ref}", "DELETE")
                api(f"/channels/{cid}/messages/{sid}", "DELETE")
            print(f"deleted {len(todo)} pairs; copy in {out}")
        if state.get("alerted"):
            alert("✅ stopped-cleanup recovered: the hourly 🛑 Stopped cleanup works again.")
        state = {"fails": 0, "alerted": False}
    except Exception as e:
        state["fails"] = state.get("fails", 0) + 1
        print(f"error: {e}", file=sys.stderr)
        if state["fails"] >= 3 and not state.get("alerted"):
            try:
                alert(f"⚠️ stopped-cleanup failed {state['fails']} times in a row: {str(e)[:300]}. Log: journalctl --user -u omp-stopped-cleanup")
                state["alerted"] = True
            except Exception: pass
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        json.dump(state, open(STATE, "w"))
        sys.exit(1)
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, "w"))


if __name__ == "__main__":
    main()
