#!/usr/bin/env python3
"""Tests for scripts/fm_decisions.py (card decisions-to-firstmate). Run: python3 scripts/test_fm_decisions.py"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm_decisions as d

n = 0
def ok(cond, msg=""):
    global n
    n += 1
    if not cond:
        sys.exit(f"FAIL {n}: {msg}")

REPORT = """# R
## Result
done
## Decisions for you

- **Live budget:** gates read the budget from the feed.
- **Media hosting:** R2 or static assets is still open.

## Limits
- x
"""
ok(d.sections(REPORT) == ["Live budget: gates read the budget from the feed.", "Media hosting: R2 or static assets is still open."], d.sections(REPORT))
ok(d.sections("## Decisions for you\n\nNone.\n## Next\n- a") == [], "an empty (None) section is closed")
ok(d.sections("## Open questions\n- n/a\n") == [], "n/a bullet")
ok(d.sections("## Needs you\nPick a host for the media.\n") == ["Pick a host for the media."], "a paragraph is one question")
ok(d.sections("### Owner decision\n1. Keep A?\n2) Drop B?\n") == ["Keep A?", "Drop B?"], "numbered bullets")
ok(d.sections("# Result\nNo owner work.\n") == [], "no section")
ok(d.sections(d.html_to_md("<h2>Decisions for you</h2><ul><li>Use R2?</li></ul><h2>Limits</h2>")) == ["Use R2?"], "html")
ok(d.summary_decisions("Built it. Decisions for you: pick R2 or Pages?") == ["pick R2 or Pages?"], "inline summary")
ok(d.summary_decisions("Built it. Decisions for you: none.") == [], "inline none")
ok(d.summary_decisions("Built it; nothing needs you.") == [], "plain words are no section")
ok(d.evidence_paths(["see ~/a/report.md and /x/y.html", "commit abc", "docs/rel.md"], home="/h") == ["/h/a/report.md", "/x/y.html"])
opts = d.options_for("Media hosting: R2 or static assets?")
ok(opts == ["Media hosting: R2", "static assets", "Decide later", d.OTHER] or opts[-1] == d.OTHER, opts)
ok(d.options_for("Options: R2; Pages")[:2] == ["R2", "Pages"], d.options_for("Options: R2; Pages"))
ok(d.options_for("Keep the feed.") == ["Accept as written", "Decide later", d.OTHER])
t = d.ask_text("c1", ["q%d" % i for i in range(7)])
blk = json.loads(t.split("```ask\n", 1)[1].rsplit("\n```", 1)[0])
ok(len(blk["questions"]) == 5 and "q5; q6" in t and t.count("```ask") == 1, t)
ok(d.bullets_hash("c", ["a"]) == d.bullets_hash("c", ["a"]) != d.bullets_hash("c", ["b"]))
files = {"/r/report.md": REPORT}
rec = {"summary": "built", "evidence": ["/r/report.md", "/r/missing.md"]}
ok(len(d.receipt_decisions(rec, read=files.get)) == 2, "evidence file read")

# Replay: the receipt that started this card must be caught (only when the real files exist on this host).
real = os.path.expanduser("~/Documents/reports/web/firstmate/receipts/webapp-dyr-academy.json")
if os.path.exists(real):
    got = d.receipt_decisions(json.load(open(real)))
    ok(len(got) == 3 and got[0].startswith("Live budget"), got)
    print("replay webapp-dyr-academy: caught", len(got), "decisions")
print(f"all tests passed ({n})")
