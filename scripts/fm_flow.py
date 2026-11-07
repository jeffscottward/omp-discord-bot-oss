"""Standard work flow gates (owner 2026-10-31, card sdlc-standard-flow; doc ~/Documents/reports/web/firstmate/flow.md).

Used by `fm receipt` (done gate) and `fm-spawn` (task-file lint). Pure functions; tests in test_fm_flow.py.
"""
import os
import re

FLOWS = ("full", "short")
DONE_LEVELS = ("live", "tests")
FLOW_RX = re.compile(r"(?im)^\s*[-*]?\s*\**flow\**\s*:\s*\**\s*(full|short)\b(?!\s*\|)")
ACCEPT_RX = re.compile(r"(?im)^#{1,6}\s*acceptance check\b")
CI_REVIEW_RX = re.compile(
    r"(?i)(\bci\b|pipeline|/actions/runs/|/-/jobs/|/pull/\d|merge_requests/\d|\breview(ed|er)?\b)")


def task_flow(text):
    """'full' | 'short' | None from a task file's `Flow:` line."""
    m = FLOW_RX.search(text or "")
    return m.group(1).lower() if m else None


def task_lint(text):
    """Missing required parts of a task file (refused by fm-spawn)."""
    gaps = []
    if not ACCEPT_RX.search(text or ""):
        gaps.append("'## Acceptance check' section")
    if not task_flow(text):
        gaps.append("'Flow: full|short' line")
    return gaps


def flow_from_files(paths):
    """Flow from the first readable task file in paths; None when no file names one."""
    for p in paths:
        if p and os.path.isfile(p):
            try:
                f = task_flow(open(p, encoding="utf-8", errors="replace").read(200_000))
            except OSError:
                continue
            if f:
                return f
    return None


def done_gate(verified, evidence, flow):
    """Refusal message for a done receipt, or None when it passes."""
    if verified not in DONE_LEVELS:
        return (f"a done receipt needs --verified live|tests (got {verified or 'nothing'}); none/typecheck is not "
                "proof. Verify on the real target first (flow.md), or send failed/blocked.")
    if not [e for e in evidence if e.strip()]:
        return "a done receipt needs at least one --evidence (commit, file, test command, URL, live check output)."
    if flow == "full" and not any(CI_REVIEW_RX.search(e) for e in evidence):
        return ("full flow: a done receipt needs one --evidence for CI or review (pipeline/run URL, PR/MR link, "
                "or text with 'CI' or 'review'). Use --flow short only for small edits without deploy.")
    return None
