"""JEV judge step for fm-audit (owner 2026-11-04, card fm-audit-jev).

JEV (OpenRouter `~typesafe/jev-latest`, decisions API, same key as the bot: `omp token openrouter`) reads cards that the
fixed rules cannot settle and proposes a state. JEV proposes; code decides (allowed()). Mode file
~/.local/state/fm-audit/jev-mode: "off" (default: no call), "dry" (calls JEV, logs only) or "apply" (allowed transitions only).
Rules:
 - Payload has only id, state, title, area, timestamps, job liveness, receipt result, PR/CI words, blocker ids.
   redact() strips money, positions, account fields, emails, tokens and URLs (all URLs are dropped).
 - Calls only for candidate cards whose cts changed since the last verdict; caps per run and per day.
 - Allowed applies: running -> partial "needs check"; nothing else. Done is never applied here: fm-autoclear R11
   owns receipt -> done and its gates (a done verdict is logged only).
   waiting/open are owner-only and never set. Finance arm/disarm, orders and risk are never touched (only states).
 - Failure (no credit, 402/429/5xx, timeout): skip the judge for 30 min, fixed rules stay, one alert per incident.
State: ~/.local/state/fm-audit/jev.json (cache, day counter, tokens/cost), log: firstmate/jev.log (JSON lines).
"""
import json, os, re, time, urllib.error, urllib.request

HOME = os.path.expanduser("~")
STATE_DIR = os.path.dirname(os.environ.get("FM_AUDIT_STATE") or os.path.join(HOME, ".local/state/fm-audit/state.json"))
ENDPOINT = os.environ.get("FM_JEV_ENDPOINT") or "https://openrouter.ai/api/alpha/decisions"
MODEL = "~typesafe/jev-latest"
DAY_CAP = int(os.environ.get("FM_JEV_DAY_CAP") or 150)
RUN_CAP = int(os.environ.get("FM_JEV_RUN_CAP") or 3)  # fm-tick runs once a minute: this is the per-minute cap
TIMEOUT_S = 8
BACKOFF_S = 30 * 60
STALE_RUNNING_S = 45 * 60  # running card with no live pane, no beat and no change this long = candidate
EST_USD_PER_CALL = float(os.environ.get("FM_JEV_USD_PER_CALL") or 0.002)  # replaced by usage.cost when the API returns it
CHOICES = {
    "keep": "The card state is correct now; change nothing.",
    "partial": "Work stopped: no live job, no recent beat and no done receipt. Move to partial with 'needs check'.",
    "done": ("The work is finished: the card's own done receipt is on record and newer than its last reopen "
             "(receiptApplied is false). A merged PR alone is NOT done. Informational only: never applied."),
    "owner": "Only the owner can move it (question, approval or decision).",
}

_MONEY = re.compile(r"(?:[$€£]\s?\d[\d,.]*\s*[kKmMbB]?|\b\d[\d,.]*\s?(?:usd|eur|dollars?)\b)", re.I)
_ACCT = re.compile(r"(?:\b\d[\d,.]*\s*[kKmMbB]?\s*)?\b(?:net liquidation|account(?:\s*(?:id|no|number|value|balance))?|acct|balance|equity|buying power|"
                   r"margin|position[s]?|qty|quantity|shares?|contracts?|strike|premium|p&l|pnl)\b[^,;.\n]*", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_URL = re.compile(r"\bhttps?://\S+|\bwww\.\S+", re.I)
_TOKEN = re.compile(r"\b(?:sk|pk|rk|ghp|gho|xox[abp]|glpat|AKIA)[-_A-Za-z0-9]{8,}|\b[A-Za-z0-9_\-]{32,}\b")
_NUMS = re.compile(r"\b\d+(?:\.\d+)?\s*%")


def redact(s, n=160):
    """Strip money, account/position fields, emails, URLs and tokens. Order matters: URLs and tokens first."""
    s = str(s or "")
    for rx, rep in ((_URL, "[url]"), (_EMAIL, "[email]"), (_TOKEN, "[token]"), (_MONEY, "[amount]"), (_ACCT, "[acct]"), (_NUMS, "[pct]")):
        s = rx.sub(rep, s)
    return re.sub(r"\s+", " ", s).strip()[:n]


def _iso(ms):
    try:
        return time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(float(ms) / 1000))
    except Exception:
        return ""


def pr_ci(it):
    """PR/CI words only (no URLs): 'pr merged', 'pr open', 'ci green', 'ci red' found in the note or links."""
    txt = " ".join(str(x) for x in (it.get("n"), it.get("l"), it.get("beatNote")))
    words = []
    if re.search(r"/pull/\d+|\bPR\s*#?\d+", txt, re.I):
        words.append("pr merged" if re.search(r"\b(?:PR\s*#?\d+|pull/\d+)\s+(?:was\s+|is\s+)?merged\b", txt, re.I) else "pr linked")
    if re.search(r"\bci (?:green|passed)\b", txt, re.I):
        words.append("ci green")
    elif re.search(r"\bci (?:red|failed)\b", txt, re.I):
        words.append("ci red")
    return words


def payload(it, j, receipt, now):
    """The ONLY data that goes to JEV. Whitelisted fields; free text is redacted."""
    return {
        "id": str(it.get("id"))[:80],
        "state": it.get("s"),
        "title": redact(it.get("t"), 120),
        "area": str(it.get("area") or "")[:20],
        "flaggedNeedsCheck": bool(re.search(r"needs check", str(it.get("n") or ""), re.I)),
        "ownerAnswered": bool(it.get("queued")),
        "changed": _iso(it.get("cts") or 0),
        "lastBeat": _iso(it.get("beat") or 0) if it.get("beat") else "",
        "minutesSinceChange": int((now - float(it.get("cts") or 0) / 1000) / 60) if it.get("cts") else None,
        "job": {"panes": len(j.get("panes") or []), "live": bool(j.get("live")), "recent": bool(j.get("recent")),
                "units": len(j.get("units") or [])},
        "receipt": (receipt or {}).get("result") or "",
        "receiptApplied": receipt_applied(it, receipt),
        "receiptAt": _iso((receipt or {}).get("tsMs") or 0) if receipt else "",
        "prci": pr_ci(it),
        "blockedBy": [str(x)[:80] for x in (it.get("blockedBy") if isinstance(it.get("blockedBy"), list) else
                                               ([it["blockedBy"]] if it.get("blockedBy") else []))][:6],
        "hasOwnerQuestion": bool(it.get("q")),
    }


def receipt_applied(it, receipt):
    """True when fm-autoclear already applied this receipt (card field `receipt` == receipt tsMs): a reopened card."""
    ts = (receipt or {}).get("tsMs")
    return bool(ts) and str(it.get("receipt") or "") == str(ts)


def allowed(it, verdict, receipt):
    """Code decides. Returns (ok, why). Only two transitions are ever applied."""
    s, v = it.get("s"), verdict.get("proposed_state")
    if v in ("keep", "owner") or v is None:
        return False, "no change proposed"
    if s == "running" and v == "partial":
        return True, "running -> partial needs check"
    if v == "done":
        return False, "done is owned by fm-autoclear R11 receipts"
    return False, f"{s} -> {v} is not an allowed transition"


def candidates(items, J, found, now, protected_fn):
    """Cards the fixed rules cannot settle: auditor findings (unclear, needs-check, no-job, daemon-job, answered)
    and running cards with no live/recent job and no change for 45 min."""
    ids = {f["id"] for f in found}
    out = []
    for it in items:
        iid = it.get("id")
        if not iid or it.get("s") in ("done", "backlog", "waiting", "open") or protected_fn(it):
            continue
        j = J.get(iid) or {}
        stale = it.get("s") == "running" and not j.get("live") and not j.get("recent") \
            and now - float(it.get("cts") or 0) / 1000 > STALE_RUNNING_S
        if iid in ids or stale:
            out.append(it)
    return out


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def mode():
    m = os.environ.get("FM_JEV_MODE")
    if not m:
        try:
            m = open(os.path.join(STATE_DIR, "jev-mode")).read().strip()
        except Exception:
            m = "off"
    return m if m in ("dry", "apply", "off") else "off"


def key():
    import subprocess
    omp = os.environ.get("OMP_BIN") or os.path.join(HOME, ".local/bin/omp")
    r = subprocess.run([omp, "token", "openrouter"], capture_output=True, text=True, timeout=20)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError("no openrouter credential")
    return r.stdout.strip()


class JudgeDown(Exception):
    pass


def explain(ch, a, p):
    """The decisions API returns no rationale (question types noul/choice/score/box only; verified 2026-11-05).
    Build one from the picked criterion, the runner-up probability and the evidence the choice rests on."""
    if not ch:
        return "no valid choice returned"
    pr = a.get("probabilities") or {}
    alt = max(((k, v) for k, v in pr.items() if k != ch and isinstance(v, (int, float))), key=lambda kv: kv[1], default=None)
    j = (p or {}).get("job") or {}
    ev = (f"job live={bool(j.get('live'))} recent={bool(j.get('recent'))}, receipt={(p or {}).get('receipt') or 'none'}"
          f" applied={bool((p or {}).get('receiptApplied'))}, ownerQ={bool((p or {}).get('hasOwnerQuestion'))},"
          f" idle={(p or {}).get('minutesSinceChange')}m")
    head = f"{ch}: {CHOICES[ch].split('.')[0]}"
    if alt:
        head += f" (next {alt[0]} {alt[1]:.2f})"
    return f"derived: {head}; {ev}"


def call_jev(p, key_fn, opener=urllib.request.urlopen):
    body = {
        "model": MODEL,
        "state": {"task": "Decide the correct dashboard state of one work card from its live evidence.", "card": p},
        "questions": {"state": {"type": "choice", "criteria": CHOICES, "instructions": {
            "goal": "Pick the state this card should have now.",
            "rules": ["Pick keep when a job is live or recent.", "Pick done only when receipt is done and receiptApplied is false; a merged PR alone is not done.",
                      "Pick owner when the card waits on an owner decision or question."]}}},
    }
    try:
        req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {key_fn()}"})
        with opener(req, timeout=TIMEOUT_S) as r:
            d = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise JudgeDown(f"HTTP {e.code}")
    except Exception as e:
        raise JudgeDown(f"{type(e).__name__}: {str(e)[:80]}")
    a = (d.get("answers") or {}).get("state") or {}
    ch = a.get("choice") if a.get("choice") in CHOICES else None
    conf = a.get("confidence")
    if not isinstance(conf, (int, float)):
        conf = ((a.get("probabilities") or {}).get(ch) or 0)
    u = d.get("usage") or {}
    return {"proposed_state": ch, "confidence": float(conf), "reason": redact(a.get("reason") or a.get("explanation") or explain(ch, a, p), 200),
            "tokens": int(u.get("total_tokens") or (u.get("input_tokens") or u.get("prompt_tokens") or 0) + (u.get("output_tokens") or u.get("completion_tokens") or 0)),
            "cost": float(u["cost"]) if isinstance(u.get("cost"), (int, float)) else None}


def run(items, J, found, now, *, protected_fn, receipt_fn, apply_fn, log_fn, alert_fn, dry=False,
        state_path=None, key_fn=key, opener=urllib.request.urlopen, mode_=None):
    """One judge pass. Returns list of verdict records. Never raises on judge failure."""
    m = mode_ or mode()
    if m == "off":
        return []
    sp = state_path or os.path.join(STATE_DIR, "jev.json")
    st = load(sp, {}) or {}
    for k, v in (("cache", {}), ("day", ""), ("calls", 0), ("tokens", 0), ("usd", 0.0), ("downUntil", 0), ("downAlerted", ""), ("days", {})):
        st.setdefault(k, v)
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    if st["day"] != day:
        if st["day"]:
            st["days"][st["day"]] = {"calls": st["calls"], "tokens": st["tokens"], "usd": round(st["usd"], 4)}
            st["days"] = dict(sorted(st["days"].items())[-14:])
        st.update(day=day, calls=0, tokens=0, usd=0.0)
    out = []
    if now < st["downUntil"]:
        return out
    live = {it["id"] for it in candidates(items, J, found, now, protected_fn)}
    st["cache"] = {k: v for k, v in st["cache"].items() if k in live}
    made = 0
    for it in candidates(items, J, found, now, protected_fn):
        iid, cts = it["id"], it.get("cts") or 0
        if st["cache"].get(iid, {}).get("cts") == cts:
            continue  # unchanged since the last verdict
        if made >= RUN_CAP or st["calls"] >= DAY_CAP:
            break
        rc = receipt_fn(iid)
        p = payload(it, J.get(iid) or {}, rc, now)
        try:
            v = call_jev(p, key_fn, opener)
        except JudgeDown as e:
            st["downUntil"] = now + BACKOFF_S
            if not st["downAlerted"]:  # once per incident; a good call clears it
                st["downAlerted"] = day
                alert_fn(f"FIRSTMATE JEV judge skipped ({e}); fixed rules still run. Retry in 30 min.")
            log_fn({"at": now, "event": "down", "why": str(e)})
            break
        except Exception as e:  # key lookup etc.
            st["downUntil"] = now + BACKOFF_S
            log_fn({"at": now, "event": "down", "why": f"{type(e).__name__}"})
            break
        made += 1
        st["downAlerted"] = ""
        st["calls"] += 1
        st["tokens"] += v["tokens"]
        st["usd"] += v["cost"] if v["cost"] is not None else EST_USD_PER_CALL
        ok, why = allowed(it, v, rc)
        rec = {"at": now, "card": iid, "state": it.get("s"), "proposed_state": v["proposed_state"], "confidence": v["confidence"],
               "reason": v["reason"], "evidence_used": p, "allowed": ok, "decision": why, "mode": m, "applied": False,
               "tokens": v["tokens"], "cost": v["cost"]}
        if ok and m == "apply" and not dry and v["confidence"] >= 0.7:
            rec["applied"] = bool(apply_fn(it, v["proposed_state"]))
        log_fn(rec)
        out.append(rec)
        st["cache"][iid] = {"cts": cts, "v": v["proposed_state"], "at": now}
    if not dry:
        save(sp, st)
    return out
