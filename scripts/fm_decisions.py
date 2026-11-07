"""fm_decisions: find open owner-decision sections in worker receipts (card decisions-to-firstmate, owner 2026-10-28).

Owner decisions go to FIRSTMATE as an ask menu; never only in a report. `fm receipt ... done` refuses a receipt whose
summary or .md/.html evidence file has an open-decision section, and fm-autoclear turns such a section (when a receipt
still has one) into ONE ask menu in FIRSTMATE. Pure helpers only; no Discord calls here.
"""
import hashlib, html, json, os, re

HEAD_WORDS = r"(?:decisions?\s+for\s+(?:you|the\s+owner)|needs?\s+you|owner\s+decisions?|open\s+(?:owner\s+)?(?:questions?|decisions?)|decisions?\s+needed|questions?\s+for\s+(?:you|the\s+owner))"
# A heading: markdown "## X", bold "**X**", or an html <hN>X</hN>; also "X:" at the start of a line.
MD_HEAD = re.compile(r"^\s{0,3}(?:#{1,6}\s*|\*\*\s*)" + HEAD_WORDS + r"\b.*$", re.I | re.M)
LINE_HEAD = re.compile(r"^\s{0,3}" + HEAD_WORDS + r"\s*:", re.I | re.M)
INLINE = re.compile(r"\b" + HEAD_WORDS + r"\s*:\s*(.+)", re.I | re.S)
ANY_HEAD = re.compile(r"^\s{0,3}(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)", re.M)
NONE_TXT = re.compile(r"^\s*(?:[-*]\s*)?(?:none|n/?a|no(?:thing| open)?(?: decisions?| questions?)?(?: open| needed| left)?)\s*\.?\s*$", re.I)
BULLET = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*\S)")
OTHER = "✏️ Other (type or dictate a reply)"
DEFAULT_OPTS = ["Accept as written", "Decide later", OTHER]
MAX_Q = 5


def _strip_md(s):
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def html_to_md(text):
    t = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", text)
    t = re.sub(r"(?i)<h([1-6])[^>]*>", lambda m: "\n" + "#" * int(m.group(1)) + " ", t)
    t = re.sub(r"(?i)</h[1-6]>", "\n", t)
    t = re.sub(r"(?i)<li[^>]*>", "\n- ", t)
    t = re.sub(r"(?i)<(?:br|/p|/li|/ul|/ol|p)[^>]*>", "\n", t)
    return html.unescape(re.sub(r"<[^>]+>", "", t))


def sections(text):
    """Bullets (or the paragraph) under every open-decision heading in markdown text. [] = no open section."""
    out = []
    heads = [m for m in MD_HEAD.finditer(text)] + [m for m in LINE_HEAD.finditer(text)]
    for m in sorted(heads, key=lambda m: m.start()):
        rest = text[m.end():]
        if LINE_HEAD.match(m.group(0)):  # "Decisions for you: x" keeps the text after the colon on the same line
            rest = m.group(0).split(":", 1)[1] + rest
        nxt = ANY_HEAD.search(rest)
        body = rest[:nxt.start()] if nxt else rest
        lines = [l for l in body.splitlines() if l.strip()]
        if not lines or all(NONE_TXT.match(l) for l in lines):
            continue
        bullets = [_strip_md(b.group(1)) for b in map(BULLET.match, lines) if b]
        bullets = [b for b in bullets if b and not NONE_TXT.match(b)]
        if not bullets:
            para = _strip_md(" ".join(lines))
            bullets = [para] if para and not NONE_TXT.match(para) else []
        out += [b for b in bullets if b not in out]
    return out


def summary_decisions(summary):
    """An inline 'Decisions for you: ...' in a receipt summary (one line, so it is one question)."""
    s = str(summary or "")
    found = sections(s)
    if found:
        return found
    m = INLINE.search(s)
    if m and not NONE_TXT.match(m.group(1).strip()):
        return [_strip_md(m.group(1))[:600]]
    return []


def evidence_paths(evidence, home=None):
    """Local .md/.html files named in --evidence values (~ expanded; words around the path are ignored)."""
    home = home or os.path.expanduser("~")
    out = []
    for ev in evidence or []:
        for tok in re.findall(r"(?<![\w.~/-])(?:~/|/)[^\s,;()'\"]+\.(?:md|html?)\b", str(ev)):
            p = os.path.join(home, tok[2:]) if tok.startswith("~/") else tok
            if p not in out:
                out.append(p)
    return out


def receipt_decisions(rec, read=None):
    """Open decision bullets in a receipt: its summary plus every readable .md/.html evidence file."""
    def _read(p):
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                return f.read(2_000_000)
        except OSError:
            return None
    read = read or _read
    found = summary_decisions(rec.get("summary"))
    for p in evidence_paths(rec.get("evidence")):
        t = read(p)
        if t is None:
            continue
        if re.search(r"\.html?$", p, re.I):
            t = html_to_md(t)
        found += [b for b in sections(t) if b not in found]
    return found


def options_for(bullet):
    """Options named in the text ('Options: A; B', 'A or B?'), else the defaults. Always ends with ✏️ Other."""
    m = re.search(r"options?\s*:\s*(.+)$", bullet, re.I)
    opts = []
    if m:
        opts = [o.strip(" .") for o in re.split(r"\s*(?:;|\||/|,\s*or\s+|\s+or\s+)\s*", m.group(1)) if o.strip(" .")]
    else:
        q = re.search(r"([^.:?]{2,80})\s+or\s+([^.:?]{2,80})\?", bullet)
        if q:
            opts = [q.group(1).strip(), q.group(2).strip()]
    opts = [o[:200] for o in opts if 0 < len(o) <= 200][:4]
    if len(opts) < 2:
        opts = DEFAULT_OPTS[:-1]
    else:
        opts.append("Decide later")
    return opts + [OTHER]


def bullets_hash(card, bullets):
    return hashlib.sha256(json.dumps([card, bullets], ensure_ascii=False).encode()).hexdigest()[:16]


def ask_text(card, bullets, title=""):
    """One FIRSTMATE message with ONE ```ask block (max 5 questions; the rest are listed in the text)."""
    qs = [{"id": f"d{i + 1}", "question": f"[{card}] {b}"[:1200], "options": options_for(b)} for i, b in enumerate(bullets[:MAX_Q])]
    head = f"🧾 Owner decisions from the receipt of card {card}" + (f" ({title[:80]})" if title else "") + "."
    more = ""
    if len(bullets) > MAX_Q:
        more = "\nMore decisions (answer with ✏️ Other): " + "; ".join(bullets[MAX_Q:])[:800]
    return head + more + "\n```ask\n" + json.dumps({"questions": qs}, ensure_ascii=False) + "\n```"


REFUSE = ("receipt refused: an open owner-decision section was found ({where}). Owner decisions go to the owner as an "
          "ask menu; never only in a report. Post ONE ```ask block in your own job channel (bot /post to FIRSTMATE with "
          "\"pane\": \"<your Herdr pane id>\" and \"card\": \"<card>\"; the bot moves the menu to your job channel and "
          "FIRSTMATE gets a one-line link), then write the receipt with --q <menu message URL>; or pass --decisions-none when nothing is open.")
