import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildPrompt } from "../src/preamble.ts";

// Audit: many cards had a channel link in src. Root cause: the run prompt named only the channel.
test("the run prompt names the message link to use for a card's q/src", () => {
  const msg = "https://discord.com/channels/1/2/3";
  const p = buildPrompt({ source: { kind: "owner", authorId: "9" }, content: "hi", threadUrl: "https://discord.com/channels/1/2", messageUrl: msg, where: "#x", followUp: false, ownerInVoice: false });
  expect(p).toContain(`Link to this owner message (use it as a FIRSTMATE card's q/src; the channel link above is not a message link): ${msg}`);
  const none = buildPrompt({ source: { kind: "owner", authorId: "9" }, content: "hi", threadUrl: "u", where: "#x", followUp: false, ownerInVoice: false });
  expect(none).not.toContain("Link to this");
});

test("card-link-repair: repairs only a not-done card named in a message; a dashboard URL alone or a guess is no proof", () => {
  const script = join(import.meta.dir, "..", "scripts", "card-link-repair.py");
  const py = `
import importlib.util, urllib.error, io
spec = importlib.util.spec_from_file_location("clr", ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
msgs = {"77": [
  {"id": "30", "content": "Tracker card \`card-a\` is saved"},
  {"id": "20", "content": "⚓ item:card-a first"},
  {"id": "25", "content": "reply [Dashboard](<https://x/?item=card-b>)"},
  {"id": "26", "content": "about \`card-a-2\` only"},
]}
def fetch(cid):
    if cid == "404404": raise urllib.error.HTTPError(cid, 404, "x", {}, io.BytesIO(b""))
    return msgs.get(cid, [])
items = [
  {"id": "card-a", "s": "partial", "src": "https://discord.com/channels/1/77"},
  {"id": "card-b", "s": "waiting", "src": "https://discord.com/channels/1/77"},
  {"id": "card-c", "s": "done", "src": "https://discord.com/channels/1/77"},
  {"id": "card-d", "s": "open", "q": "https://discord.com/channels/1/404404"},
  {"id": "card-e", "s": "open", "q": "https://discord.com/channels/1/77/5"},
]
rows = {(r[0], r[1]): (r[3], r[4]) for r in m.plan(items, fetch)}
assert rows[("card-a", "src")][0] == "https://discord.com/channels/1/77/20", rows   # oldest naming message
assert rows[("card-b", "src")][0] is None, rows   # ?item= URL alone is no proof
assert ("card-c", "src") not in rows, rows        # done cards are only flagged by the dashboard
assert rows[("card-d", "q")] == (None, "channel unreadable (HTTP 404)"), rows
assert ("card-e", "q") not in rows, rows          # already a message link
print("OK")
`;
  const r = Bun.spawnSync(["python3", "-B", "-c", py]);
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("OK");
});
