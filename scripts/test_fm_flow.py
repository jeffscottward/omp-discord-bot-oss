#!/usr/bin/env python3
"""Tests for scripts/fm_flow.py and the fm-spawn task lint (card sdlc-standard-flow).
Run: python3 scripts/test_fm_flow.py"""
import os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fm_flow as f

n = 0
def ok(cond, msg=""):
    global n
    n += 1
    if not cond:
        sys.exit(f"FAIL {n}: {msg}")

GOOD = "# Task: x\n\nFlow: short\n\n## Acceptance check\n- grep finds the rule\n"
ok(f.task_flow(GOOD) == "short")
ok(f.task_flow("- **Flow:** full\n") == "full", "bold bullet")
ok(f.task_flow("no flow here") is None)
ok(f.task_flow("Flow: full|short\n") is None, "unedited template line")
ok(f.task_lint(GOOD) == [], f.task_lint(GOOD))
ok(len(f.task_lint("# Task\n## Acceptance\n- x\n")) == 2, "plain Acceptance and no Flow line are refused")
ok(f.task_lint("Flow: full\n### Acceptance check\n") == [])

# done gate
ok(f.done_gate("none", ["commit abc"], None) is not None, "none refused")
ok(f.done_gate("typecheck", ["commit abc"], "short") is not None, "typecheck refused")
ok(f.done_gate(None, ["commit abc"], None) is not None, "missing level refused")
ok(f.done_gate("live", [], "short") is not None, "no evidence refused")
ok(f.done_gate("tests", ["  "], None) is not None, "blank evidence refused")
ok(f.done_gate("live", ["grep output on both hosts"], "short") is None, "short passes")
ok(f.done_gate("live", ["commit abc"], None) is None, "unknown flow: no CI requirement")
ok(f.done_gate("tests", ["commit abc"], "full") is not None, "full without CI/review refused")
for e in ("https://gitlab.com/a/b/-/pipelines/123", "CI green on abc", "fresh-context review: no findings",
          "https://github.com/a/b/pull/7", "https://github.com/a/b/actions/runs/9"):
    ok(f.done_gate("live", ["commit abc", e], "full") is None, e)

# flow_from_files
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "t.md")
    open(p, "w").write(GOOD)
    ok(f.flow_from_files([os.path.join(d, "missing.md"), "", p]) == "short")
    ok(f.flow_from_files([os.path.join(d, "missing.md")]) is None)

    # fm-spawn refuses a task file without the Acceptance check / Flow line (before any Herdr call)
    bad = os.path.join(d, "bad.md")
    open(bad, "w").write("# Task: x\n## Target\n- a\n## Acceptance\n- verify b\n")
    r = subprocess.run([sys.executable, os.path.join(HERE, "fm-spawn"), "--label", "t", "--cwd", d, "--task", bad,
                        "--dry-run"], capture_output=True, text=True, timeout=60)
    ok(r.returncode == 5 and "refused" in r.stderr and "Acceptance check" in r.stderr, (r.returncode, r.stderr[-400:]))

    # fm receipt (main-host CLI, not in this repo): `--verified none` done is refused and writes no receipt
    fm = os.path.expanduser("~/.local/bin/fm")
    if os.path.isfile(fm):
        items = os.path.join(d, "items.json")
        open(items, "w").write('{"items": [{"id": "x", "status": "running", "area": "ai", "title": "t"}]}')
        env = dict(os.environ, FM_ITEMS=items)
        r = subprocess.run([fm, "receipt", "x", "done", "s", "--verified", "none", "--evidence", "e"],
                           capture_output=True, text=True, env=env, timeout=60)
        ok(r.returncode != 0 and "live|tests" in r.stderr and not os.path.exists(os.path.join(d, "receipts", "x.json")),
           (r.returncode, r.stderr[-300:]))
        r = subprocess.run([fm, "receipt", "x", "done", "s", "--verified", "live", "--evidence", "grep ok",
                            "--decisions-none"], capture_output=True, text=True, env=env, timeout=60)
        ok(r.returncode == 0 and os.path.exists(os.path.join(d, "receipts", "x.json")), (r.returncode, r.stderr[-300:]))

print(f"ok {n}")
