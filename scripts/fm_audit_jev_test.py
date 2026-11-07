"""Tests for fm_audit_jev (card fm-audit-jev). Run: python3 scripts/fm_audit_jev_test.py"""
import io, json, os, sys, tempfile, unittest, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fm_audit_jev as jev

NOW = 1_800_000_000.0
OLD = int((NOW - 3 * 3600) * 1000)


def card(iid, s, **kw):
    return {"id": iid, "t": iid, "s": s, "area": "ops", "cts": OLD, **kw}


class Resp:
    def __init__(self, d):
        self.d = d

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self.d).encode()


def opener_for(choice, conf=0.9, calls=None):
    def op(req, timeout=0):
        if calls is not None:
            calls.append(json.loads(req.data))
        return Resp({"answers": {"state": {"choice": choice, "confidence": conf}}, "usage": {"total_tokens": 300, "cost": 0.001}})
    return op


class Redaction(unittest.TestCase):
    def test_payload_drops_private_values(self):
        it = card("fin-x", "running", area="finance",
                  t="Pay 300 units ACME at $1,234.50,  98,000 acct A1234567",
                  n="see https://x.com/a?token=abc mail owner@example.com key sk-abcdefghijklmnop1234 position 5 contracts 12%; 5000 shares; 250 qty",
                  beatNote="P&L -2,300 USD; margin 40k", l="https://github.com/o/r/pull/9")
        p = jev.payload(it, {"panes": [1], "live": False}, {"result": "done", "tsMs": OLD, "summary": "$500 profit"}, NOW)
        blob = json.dumps(p)
        for bad in ("1,234", "$", "98,000", "A1234567", "owner@example.com", "token=abc", "https://", "sk-abc", "2,300",
                    "40k", "12%", "300 shares", "5000", "250", "profit", "summary"):
            self.assertNotIn(bad, blob, bad)
        self.assertEqual(set(p), {"id", "state", "title", "area", "flaggedNeedsCheck", "ownerAnswered", "changed", "lastBeat",
                                  "minutesSinceChange", "job", "receipt", "receiptApplied", "receiptAt", "prci", "blockedBy", "hasOwnerQuestion"})
        self.assertEqual(p["receipt"], "done")
        self.assertIn("pr linked", p["prci"])


class Transitions(unittest.TestCase):
    def test_done_never_allowed(self):
        fresh = card("c", "partial")
        applied = card("c", "partial"); applied["receipt"] = "1793848203043"
        held = card("c", "partial"); held["n"] = "receipt held: open decisions"
        for c, r in ((fresh, {"result": "done", "tsMs": 1793900000000}),
                     (applied, {"result": "done", "tsMs": 1793848203043}),
                     (held, {"result": "done", "tsMs": 1793900000000, "verified": ""})):
            ok, why = jev.allowed(c, {"proposed_state": "done"}, r)
            self.assertFalse(ok); self.assertIn("fm-autoclear R11", why)
        self.assertTrue(jev.payload(applied, {}, {"result": "done", "tsMs": 1793848203043}, 0)["receiptApplied"])
        self.assertFalse(jev.payload(fresh, {}, {"result": "done", "tsMs": 1793900000000}, 0)["receiptApplied"])

    def test_running_to_partial_fixture(self):
        # test-only fixture: the live 24 h log had 0 running cards, so this path was never exercised live
        ok, why = jev.allowed(card("r", "running"), {"proposed_state": "partial"}, None)
        self.assertTrue(ok); self.assertIn("needs check", why)

    def test_allowed(self):
        A = lambda s, v, r=None: jev.allowed(card("c", s), {"proposed_state": v}, r)[0]
        self.assertTrue(A("running", "partial"))
        self.assertFalse(A("partial", "done", {"result": "done"}))
        self.assertFalse(A("partial", "done"))
        self.assertFalse(A("partial", "done", {"result": "blocked"}))
        self.assertFalse(A("running", "done", {"result": "done"}))
        for s in ("partial", "planned", "blocked", "running"):
            self.assertFalse(A(s, "owner"))
            self.assertFalse(A(s, "keep"))
        self.assertFalse(A("blocked", "partial"))


class Run(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.sp = os.path.join(self.d, "jev.json")
        self.logs, self.alerts, self.applied = [], [], []

    def go(self, items, opener, mode="apply", found=(), J=None):
        return jev.run(items, J or {}, list(found), NOW, protected_fn=lambda it: False, receipt_fn=lambda i: None,
                       apply_fn=lambda it, v: self.applied.append((it["id"], v)) or True, log_fn=self.logs.append,
                       alert_fn=self.alerts.append, state_path=self.sp, key_fn=lambda: "k", opener=opener, mode_=mode)

    def test_candidates_cache_and_apply(self):
        items = [card("r1", "running"), card("ok", "running"), card("p1", "partial"), card("w", "waiting")]
        J = {"ok": {"live": True}}
        calls = []
        out = self.go(items, opener_for("partial", calls=calls), found=[{"id": "p1"}], J=J)
        self.assertEqual({r["card"] for r in out}, {"r1", "p1"})  # stale running + finding; live and waiting skipped
        self.assertEqual(self.applied, [("r1", "partial")])  # p1 partial->partial is not allowed
        # unchanged cts: no new calls
        self.assertEqual(self.go(items, opener_for("partial", calls=calls), found=[{"id": "p1"}], J=J), [])
        self.assertEqual(len(calls), 2)
        st = json.load(open(self.sp))
        self.assertEqual(st["calls"], 2)
        self.assertAlmostEqual(st["usd"], 0.002)

    def test_reason_built_when_api_has_none(self):
        def op(req, timeout=0):
            return Resp({"answers": {"state": {"choice": "partial", "confidence": 0.9,
                                               "probabilities": {"keep": 0.08, "partial": 0.9, "done": 0.02, "owner": 0}}}})
        out = self.go([card("r1", "running")], op)
        r = out[0]["reason"]
        self.assertTrue(r.startswith("derived: partial: Work stopped"), r)
        self.assertIn("next keep 0.08", r)
        self.assertIn("job live=False", r)
        self.assertEqual(jev.explain(None, {}, {}), "no valid choice returned")

    def test_dry_mode_never_applies(self):
        self.go([card("r1", "running")], opener_for("partial"), mode="dry")
        self.assertEqual(self.applied, [])
        self.assertTrue(self.logs[0]["allowed"] and not self.logs[0]["applied"])

    def test_low_confidence_not_applied(self):
        self.go([card("r1", "running")], opener_for("partial", conf=0.4))
        self.assertEqual(self.applied, [])

    def test_caps(self):
        items = [card(f"r{i}", "running") for i in range(10)]
        self.assertEqual(len(self.go(items, opener_for("keep"))), jev.RUN_CAP)
        st = json.load(open(self.sp))
        st["calls"] = jev.DAY_CAP
        json.dump(st, open(self.sp, "w"))
        self.assertEqual(self.go(items, opener_for("keep")), [])

    def test_failure_skips_and_alerts_once(self):
        def bad(req, timeout=0):
            raise urllib.error.HTTPError("u", 402, "Payment Required", {}, io.BytesIO(b""))
        self.assertEqual(self.go([card("r1", "running")], bad), [])
        self.assertEqual(len(self.alerts), 1)
        self.assertIn("402", self.alerts[0])
        self.assertEqual(self.go([card("r1", "running")], opener_for("partial")), [])  # backoff
        st = json.load(open(self.sp))
        st["downUntil"] = 0
        json.dump(st, open(self.sp, "w"))
        self.go([card("r2", "running")], bad)
        self.assertEqual(len(self.alerts), 1)  # once per incident
        self.reset_down()
        self.go([card("r3", "running")], opener_for("keep"))  # a good call ends the incident
        self.reset_down()
        self.go([card("r4", "running")], bad)
        self.assertEqual(len(self.alerts), 2)

    def reset_down(self):
        with open(self.sp) as f:
            st = json.load(f)
        st["downUntil"] = 0
        with open(self.sp, "w") as f:
            json.dump(st, f)

    def test_missing_key_alerts(self):
        def nokey():
            raise RuntimeError("no openrouter credential")
        jev.run([card("r1", "running")], {}, [], NOW, protected_fn=lambda it: False, receipt_fn=lambda i: None,
                apply_fn=lambda *a: True, log_fn=self.logs.append, alert_fn=self.alerts.append, state_path=self.sp,
                key_fn=nokey, opener=opener_for("keep"), mode_="dry")
        self.assertEqual(len(self.alerts), 1)

    def test_off(self):
        self.assertEqual(self.go([card("r1", "running")], opener_for("partial"), mode="off"), [])


if __name__ == "__main__":
    unittest.main()
