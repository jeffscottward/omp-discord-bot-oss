import importlib.util, os, time
s = importlib.util.spec_from_file_location("sc", os.path.join(os.path.dirname(__file__), "..", "scripts", "stopped-cleanup.py"))
sc = importlib.util.module_from_spec(s); s.loader.exec_module(sc)
from datetime import datetime, timezone
def iso(h): return datetime.fromtimestamp(time.time() - h * 3600, timezone.utc).isoformat()
B = {"id": sc.BOT_ID}
now = time.time() * 1000
old = {"id": "1", "author": B, "content": "🛑 Stopped. To steer", "timestamp": iso(30), "message_reference": {"message_id": "0"}}
new = {"id": "2", "author": B, "content": "🛑 Stopped. x", "timestamp": iso(2)}
undo = {"id": "3", "author": B, "content": "🛑 Stopped. ↩️ Undo requested.", "timestamp": iso(30), "edited_timestamp": iso(1)}
undo_old = dict(undo, id="4", edited_timestamp=iso(25))
user = {"id": "5", "author": {"id": "9"}, "content": "🛑 Stopped", "timestamp": iso(30)}
other = {"id": "6", "author": B, "content": "Done", "timestamp": iso(30)}
r = sc.plan([old, new, undo, undo_old, user, other], now, 24)
assert [(m["id"], ref) for m, ref in r] == [("1", "0"), ("4", None)], r
print("ok")
assert sc.safe_ref({"author": {"id": "9"}, "type": 0}) and sc.safe_ref({"author": {"id": "9"}, "type": 19})
assert not sc.safe_ref({"author": B, "type": 0}) and not sc.safe_ref({"author": {"id": "9"}, "type": 21}) and not sc.safe_ref(None)
print("ok refs")
