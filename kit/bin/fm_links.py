"""blockedBy/blocks sanity (card fm-blockedby-sanity, 2026-11-02). Shared by fm and fm-autoclear.

A blockedBy edge A -> B means "B must finish BEFORE A". `blocks` on B naming A is the same edge reversed.
Refused: a self link, an id that is no card (unless a typed ref like ext:/time:/ci:/job:/unit:/agent:/pane: or a
unit name), and a link that closes a cycle. Resolution of ids/titles is the same as `fm why`.
"""
import re

HINT = "blockedBy = a card that must finish BEFORE this one; work this card does itself is not a blocker"
TYPED = re.compile(r"(?i)^(ext|time|ci|job|unit|agent|pane):|\.(timer|service)$")


def _lst(v):
    return [str(x) for x in (v if isinstance(v, list) else [v] if v else []) if x]


def resolver(items):
    by = {i.get("id"): i for i in items if i.get("id")}
    title = {str(i.get("t", "")).lower(): i.get("id") for i in items if i.get("t")}
    return lambda r: r if r in by else title.get(str(r).lower(), r), by


def edges(items, res, skip=None):
    """blocked -> [blockers], from blockedBy plus reverse `blocks`. skip=(card, key) leaves that field out."""
    e = {i.get("id"): [] for i in items if i.get("id")}
    for i in items:
        iid = i.get("id")
        if not iid:
            continue
        if skip != (iid, "blockedBy"):
            for r in map(res, _lst(i.get("blockedBy"))):
                if r != iid and r not in e[iid]:
                    e[iid].append(r)
        if skip != (iid, "blocks"):
            for d in map(res, _lst(i.get("blocks"))):
                if d in e and d != iid and iid not in e[d]:
                    e[d].append(iid)
    return e


def path(e, src, dst):
    """Shortest blockedBy path src -> ... -> dst, or None."""
    prev, todo = {src: None}, [src]
    while todo:
        n = todo.pop(0)
        if n == dst:
            out = []
            while n is not None:
                out.append(n); n = prev[n]
            return out[::-1]
        for m in e.get(n, []):
            if m not in prev:
                prev[m] = n; todo.append(m)
    return None


def check(items, card, key, refs):
    """Problems for setting items[card][key] = refs. Returns (hard, missing): hard = self/cycle messages,
    missing = refs that name no card (allowed with --force)."""
    res, by = resolver(items)
    e = edges(items, res, skip=(card, key))
    hard, missing = [], []
    for raw in refs:
        r = res(raw)
        if r == card:
            hard.append(f"{raw!r} is the card itself")
            continue
        if r not in by:
            if not TYPED.search(str(raw)):
                missing.append(raw)
            continue
        blocked, blocker = (card, r) if key == "blockedBy" else (r, card)
        p = path(e, blocker, blocked)  # blocker already waits on blocked -> cycle
        if p:
            hard.append(f"{raw!r} closes a cycle: {' -> '.join([blocked] + p)} (-> = blockedBy)")
        e.setdefault(blocked, []).append(blocker)
    return hard, missing


def clean(items, card, refs):
    """fm-autoclear: drop self/cyclic/unknown receipt blockers. Returns (kept, dropped-notes)."""
    kept, dropped = [], []
    for r in refs:
        hard, missing = check(items, card, "blockedBy", kept + [r])
        if hard or missing:
            dropped.append(f"{r} ({'not a card' if missing and not hard else hard[-1].split(' ', 1)[1]})")
        else:
            kept.append(r)
    return kept, dropped
