import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mirror, sessionEvents, type MirrorEntry } from "../src/mirror.ts";
import {
  askInfo,
  askMatches,
  choicesFor,
  closedCard,
  customAnswerLine,
  isQuestionReply,
  PaneInjector,
  paneFacts,
  parseAskScreen,
  recordMatches,
  redactTerminal,
  sessionRecord,
  questionLine,
  scrollbackMessages,
  shellQuote,
  type PaneWait,
} from "../src/quickreply.ts";
import { redact } from "../src/redact.ts";

const CUR = "\uf054";
const DOT = "\uf10c";
const W = 126;
const row = (body: string) => `│${body.padEnd(W)}│`;
/** The ask selector as OMP 18.12 draws it (captured from a real pane 2026-10-19). */
const askScreen = (cursor: number, opts = ["Apple", "Banana (Recommended)", "Cherry", "Other (type your own)"], question = "Pick a test fruit") =>
  [
    " Test for a bot feature.",
    `╭─ Ask ${"─".repeat(W - 6)}╮`,
    row(` ${question}`),
    `├${"─".repeat(W)}┤`,
    ...opts.map((o, k) => row(k === cursor ? ` ${CUR} ${DOT} ${o}` : `   ${DOT} ${o}`)),
    row(""),
    row(""),
    `├${"─".repeat(W)}┤`,
    row(" \uf0311 select · n note · ↑/↓ move · cancel · Alt+H hide"),
    `╰${"─".repeat(W)}╯`,
  ].join("\n");
const customScreen = (typed: string) =>
  [`╭─ Custom answer: Pick a test fruit ${"─".repeat(W - 35)}╮`, row(""), row(` > ${typed}`), row(""), row(" or Ctrl+Q submit"), `╰${"─".repeat(W)}╯`].join("\n");
const EDITOR_EMPTY = "\ue0b6 status \ue0b0───\n╰─\n";
const EDITOR_TYPING = "\ue0b6 status \ue0b0───\n╰─ half a sent\n";
const FRUIT = { question: "Pick a test fruit", options: ["Apple", "Banana", "Cherry"], recommended: 1, supported: true };
const jl = (o: object) => `${JSON.stringify(o)}\n`;
/** Session tails as OMP 18.12 writes them (entry ids, bookkeeping entries after the message). */
const ASK_TAIL =
  jl({ type: "message", id: "u0", message: { role: "user", content: [] } }) +
  jl({ type: "message", id: "a1", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "ask", arguments: {} }] } }) +
  jl({ type: "custom", customType: "tool_execution_start", id: "x1" });
const REPLY_TAIL = jl({ type: "message", id: "r1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Push?" }] } }) + jl({ type: "model_usage", id: "m1" });
const USER_LINE = jl({ type: "message", id: "u9", message: { role: "user", content: [{ type: "text", text: "Yes" }] } });
const RESULT_LINE = jl({ type: "message", id: "t1", message: { role: "toolResult", toolCallId: "c1", content: [] } });
const qWait: PaneWait = { nonce: "n", kind: "question", ts: 0, rec: "r1", question: "Push?" };
const aWait: PaneWait = { nonce: "n", kind: "ask", ts: 0, rec: "a1", callId: "c1", ask: FRUIT };

describe("quick replies: parsing", () => {
  test("askInfo: one single-choice question is answerable; others are shown only", () => {
    expect(askInfo({ questions: [{ id: "f", question: "Q?", options: [{ label: "A" }, { label: "B" }], recommended: 5 }] })).toEqual({ question: "Q?", options: ["A", "B"], recommended: 1, supported: true });
    expect(askInfo({ questions: [{ question: "Q?", options: [{ label: "A" }], multi: true }] })?.supported).toBe(false);
    expect(askInfo({ questions: [{ question: "Q1", options: [{ label: "A" }] }, { question: "Q2", options: [{ label: "B" }] }] })?.supported).toBe(false);
    expect(askInfo({ questions: [] })).toBeNull();
    expect(askInfo(null)).toBeNull();
  });

  test("a reply that ends with a question opens a question wait", () => {
    expect(isQuestionReply("Done. Tests pass.\n\nShould I push the branch?")).toBe(true);
    expect(isQuestionReply("Ready to merge? **Yes/No?**")).toBe(true);
    expect(isQuestionReply("I asked why it failed? No.\nAll done.\nCommitted.\nPushed.")).toBe(false);
    expect(isQuestionReply("See https://x.test/a?b=1")).toBe(false);
    expect(isQuestionReply("Pick one:\n```ask\n{}\n```\nWhich?")).toBe(false);
    expect(isQuestionReply("```\nwhat?\n```\nDone.")).toBe(false);
    expect(questionLine("Done.\nShould I push `main`?\nNotes follow.")).toBe("Should I push main?");
  });

  test("buttons: Continue/Yes/No/Reply… for a question; options + Reply… for an ask", () => {
    const q: PaneWait = { nonce: "n", kind: "question", ts: 0, question: "Push?" };
    expect(choicesFor(q).map((c) => c.label)).toEqual(["Continue", "Yes", "No", "Reply…"]);
    const a: PaneWait = { nonce: "n", kind: "ask", ts: 0, ask: FRUIT };
    expect(choicesFor(a).map((c) => c.id)).toEqual(["o0", "o1", "o2", "r"]);
    expect(choicesFor({ ...a, ask: { ...FRUIT, supported: false } })).toEqual([]);
  });

  test("the real selector screen: question, rows without icons, cursor", () => {
    const s = parseAskScreen(askScreen(1))!;
    expect(s).toEqual({ question: "Pick a test fruit", rows: ["Apple", "Banana (Recommended)", "Cherry", "Other (type your own)"], cursor: 1 });
    expect(askMatches(s, FRUIT)).toEqual({ ok: true });
    expect(askMatches(s, { ...FRUIT, question: "Pick a car" }).ok).toBe(false);
    expect(askMatches(s, { ...FRUIT, options: ["Apple", "Banana"] }).ok).toBe(false);
    expect(parseAskScreen(customScreen(""))).toBeNull();
    expect(parseAskScreen("╰─ plain editor")).toBeNull();
  });

  test("custom answer box: input line, or null when not shown", () => {
    expect(customAnswerLine(customScreen(""))).toBe("");
    expect(customAnswerLine(customScreen("Dragonfruit"))).toBe("Dragonfruit");
    expect(customAnswerLine(askScreen(0))).toBeNull();
  });

  test("pane facts from `herdr pane list`: focus and session; another session or agent is refused", () => {
    const list = (o: Record<string, unknown>) =>
      JSON.stringify({ result: { panes: [{ pane_id: "wB:p0", agent: "omp", focused: true }, { pane_id: "wB:p1", agent: "omp", agent_status: "idle", focused: false, agent_session: { kind: "path", value: "/s.jsonl" }, ...o }] } });
    expect(paneFacts(list({}), "wB:p1", "/s.jsonl")).toEqual({ ok: true, focused: false });
    expect(paneFacts(list({ focused: true }), "wB:p1", "/s.jsonl")).toEqual({ ok: true, focused: true });
    expect(paneFacts(list({ agent_session: { kind: "path", value: "/other.jsonl" } }), "wB:p1", "/s.jsonl").ok).toBe(false);
    expect(paneFacts(list({ agent: "claude" }), "wB:p1", "/s.jsonl").ok).toBe(false);
    expect(paneFacts(list({}), "wB:p9", "/s.jsonl").ok).toBe(false);
    expect(paneFacts("not json", "wB:p1", "/s.jsonl").ok).toBe(false);
  });

  test("OMP's own record: last message entry decides; later bookkeeping entries are skipped", () => {
    expect(sessionRecord(ASK_TAIL)).toEqual({ kind: "ask", entryId: "a1", callId: "c1" });
    expect(sessionRecord(REPLY_TAIL)).toEqual({ kind: "question", entryId: "r1" });
    expect(sessionRecord(REPLY_TAIL + USER_LINE).kind).toBe("busy");
    expect(sessionRecord(ASK_TAIL + RESULT_LINE).kind).toBe("busy");
    expect(sessionRecord(REPLY_TAIL.slice(0, -1)).kind).toBe("busy"); // partial last line
    const bash = `${JSON.stringify({ type: "message", id: "b1", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "x", name: "bash" }] } })}\n`;
    expect(sessionRecord(bash).kind).toBe("busy"); // a pending approval also looks like this: never answered
    expect(recordMatches(sessionRecord(ASK_TAIL), aWait)).toEqual({ ok: true });
    expect(recordMatches(sessionRecord(ASK_TAIL), { ...aWait, rec: "a0" }).ok).toBe(false);
    expect(recordMatches(sessionRecord(REPLY_TAIL), aWait).ok).toBe(false);
    expect(recordMatches(sessionRecord(REPLY_TAIL), qWait)).toEqual({ ok: true });
  });

  test("closed card keeps the text, drops the hint line, adds the note", () => {
    expect(closedCard("✍️ **T** · waiting\n> Push?\n-# Buttons type…", "✅ You sent “Yes”")).toBe("✍️ **T** · waiting\n> Push?\n✅ You sent “Yes”");
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
  });
});

describe("scrollback", () => {
  const filter = (s: string) => redact(s).text;
  test("terminal secrets: key blocks (also cut), JWT, AWS ids, auth headers, key=value; plain text kept", () => {
    const raw = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAA",
      "curl -H 'Authorization: Bearer abcDEF123456789xyz' https://x",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop",
      "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
      'DB_PASSWORD="hunter2hunter2"  api_key: zz9988776655',
      "The token count is 12. Auth works.",
    ].join("\n");
    const out = redactTerminal(raw);
    for (const s of ["b3BlbnNz", "abcDEF123456789xyz", "eyJhbGci", "AKIAABCD", "hunter2", "zz9988"]) expect(out).not.toContain(s);
    expect(out).toContain("[REDACTED-PRIVATE-KEY]");
    expect(out).toContain('DB_PASSWORD="[REDACTED-SECRET]"');
    expect(out).toContain("The token count is 12. Auth works.");
    expect(redactTerminal("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter")).toBe("[REDACTED-PRIVATE-KEY]\nafter");
    expect(redactTerminal("MIIEvQIBADANBgkqhkiG9w0B\nAQEFAASCBKcwggSjAgEAAoIB\n-----END PRIVATE KEY-----\nafter")).toBe("[REDACTED-PRIVATE-KEY]\nafter");
  });
  test("redacted, icons and ANSI removed, fenced, every message under 2000", () => {
    const raw = ["\x1b[31mred\x1b[0m line", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "icon \uf054 gone", "```fence```", ...Array.from({ length: 40 }, (_, k) => `${k} ${"x".repeat(90)}`)].join("\n");
    const msgs = scrollbackMessages("📜 **T** · last 40 lines", raw, filter);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThan(2000);
      expect(m.match(/```/g)!.length).toBe(2);
    }
    const all = msgs.join("\n");
    expect(msgs[0]!.startsWith("📜 **T** · last 40 lines\n```\n")).toBe(true);
    expect(all).toContain("red line");
    expect(all).toContain("[REDACTED-SECRET]");
    expect(all).not.toContain("ghp_");
    expect(all).not.toContain("\uf054");
    expect(all).not.toContain("\x1b");
    expect(all).toContain("ˋˋˋfenceˋˋˋ");
  });
  test("an empty pane says so; one huge line is cut", () => {
    expect(scrollbackMessages("H", "\n\n", filter)).toEqual(["H\n-# The pane shows no text."]);
    const [m] = scrollbackMessages("H", "y".repeat(5000), filter);
    expect(m!.length).toBeLessThan(2000);
  });
});

type Call = string[];
/**
 * Fake herdr + session: `pane list` and `agent read` answer from mutable state; every call is recorded.
 * Herdr's agent_status is always "idle" here: the guards must not depend on it (FIRSTMATE 2026-10-19).
 */
function fakePane(init: { focused?: boolean; screen: string; tail: string }) {
  const st = { ...init, focused: init.focused ?? false };
  const calls: Call[] = [];
  const herdr = async (_t: unknown, args: string[]) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "pane" && b === "list")
      return { code: 0, out: JSON.stringify({ result: { panes: [{ pane_id: "wB:p1", agent: "omp", agent_status: "idle", focused: st.focused, agent_session: { kind: "path", value: "/s.jsonl" } }] } }) };
    if (a === "agent" && b === "read") return { code: 0, out: st.screen };
    if (a === "agent" && b === "prompt") st.tail += USER_LINE;
    return { code: 0, out: "" };
  };
  const injector = new PaneInjector({ herdr, readTail: async () => st.tail, sleep: async () => {}, logFile: join(mkdtempSync(join(tmpdir(), "qr-")), "log.jsonl") });
  return { st, calls, injector, sent: () => calls.filter((c) => !(c[0] === "pane" && c[1] === "list") && !(c[0] === "agent" && c[1] === "read")) };
}
const T = { machine: "main", paneId: "wB:p1", sessionFile: "/s.jsonl" };

describe("guarded inject (OMP record + pane focus; never Herdr agent_status)", () => {
  test("question: same OMP reply record, unfocused, empty box → herdr agent prompt; confirmed by the new turn", async () => {
    const p = fakePane({ screen: EDITOR_EMPTY, tail: REPLY_TAIL });
    const r = await p.injector.inject(T, qWait, choicesFor(qWait)[1]!);
    expect(r).toEqual({ ok: true, sent: "Yes", confirmed: true });
    expect(p.sent()).toEqual([["agent", "prompt", "wB:p1", "Yes"]]);
  });

  test("question: refused when focused, typing, a new turn started, or the reply record changed; nothing typed", async () => {
    const newer = `${JSON.stringify({ type: "message", id: "r2", message: { role: "assistant", stopReason: "stop", content: [] } })}\n`;
    for (const [init, reason] of [
      [{ focused: true, screen: EDITOR_EMPTY, tail: REPLY_TAIL }, /focused/],
      [{ screen: EDITOR_TYPING, tail: REPLY_TAIL }, /not empty/],
      [{ screen: EDITOR_EMPTY, tail: REPLY_TAIL + USER_LINE }, /new turn/],
      [{ screen: EDITOR_EMPTY, tail: REPLY_TAIL + USER_LINE + newer }, /changed/],
    ] as const) {
      const p = fakePane(init);
      const r = await p.injector.inject(T, qWait, choicesFor(qWait)[0]!);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
      expect(p.sent()).toEqual([]);
    }
  });

  test("question: the record is checked again right before typing", async () => {
    const p = fakePane({ screen: EDITOR_EMPTY, tail: REPLY_TAIL });
    let reads = 0;
    p.injector["deps"].readTail = async () => (++reads > 1 ? REPLY_TAIL + USER_LINE : REPLY_TAIL);
    expect((await p.injector.inject(T, qWait, choicesFor(qWait)[0]!)).ok).toBe(false);
    expect(p.sent()).toEqual([]);
  });

  test("question: Reply… sends the owner's text; empty text is refused", async () => {
    const p = fakePane({ screen: EDITOR_EMPTY, tail: REPLY_TAIL });
    expect(await p.injector.inject(T, qWait, choicesFor(qWait)[3]!, "  ship it\nthen tag  ")).toEqual({ ok: true, sent: "ship it\nthen tag", confirmed: true });
    expect((await p.injector.inject(T, qWait, choicesFor(qWait)[3]!, "  ")).ok).toBe(false);
  });

  test("ask: moves from the shown cursor to the option, re-checks, Enter, confirmed by the tool result", async () => {
    const p = fakePane({ screen: askScreen(1), tail: ASK_TAIL });
    const herdr = p.injector["deps"].herdr;
    p.injector["deps"].herdr = async (t, args) => {
      const r = await herdr(t, args);
      if (args[1] === "send-keys" && args.includes("up")) p.st.screen = askScreen(0);
      if (args[1] === "send-keys" && args.includes("enter")) p.st.tail += RESULT_LINE;
      return r;
    };
    const r = await p.injector.inject(T, aWait, choicesFor(aWait)[0]!);
    expect(r).toEqual({ ok: true, sent: "Apple", confirmed: true });
    expect(p.sent()).toEqual([
      ["agent", "send-keys", "wB:p1", "up"],
      ["agent", "send-keys", "wB:p1", "enter"],
    ]);
  });

  test("ask: refused when the cursor did not land, the ask was answered, the pane is focused, or another question shows", async () => {
    const p = fakePane({ screen: askScreen(1), tail: ASK_TAIL });
    const r = await p.injector.inject(T, aWait, choicesFor(aWait)[2]!);
    expect(r.ok).toBe(false);
    expect(p.sent()).toEqual([["agent", "send-keys", "wB:p1", "down"]]); // no Enter
    for (const init of [
      { screen: askScreen(1), tail: ASK_TAIL + RESULT_LINE },
      { screen: askScreen(1), tail: ASK_TAIL, focused: true },
      { screen: askScreen(1, undefined, "Pick a car"), tail: ASK_TAIL },
    ]) {
      const q = fakePane(init);
      expect((await q.injector.inject(T, aWait, choicesFor(aWait)[0]!)).ok).toBe(false);
      expect(q.sent()).toEqual([]);
    }
  });

  test("ask: Reply… goes to Other, types one line into the empty box, checks it, submits", async () => {
    const p = fakePane({ screen: askScreen(1), tail: ASK_TAIL });
    const herdr = p.injector["deps"].herdr;
    p.injector["deps"].herdr = async (t, args) => {
      const r = await herdr(t, args);
      if (args[1] === "send-keys" && args[3] === "down") p.st.screen = askScreen(3);
      else if (args[1] === "send-keys" && args[3] === "enter" && p.st.screen.includes("Ask")) p.st.screen = customScreen("");
      else if (args[0] === "pane" && args[1] === "send-text") p.st.screen = customScreen(args[3]!);
      else if (args[1] === "send-keys" && args[3] === "enter") p.st.tail += RESULT_LINE;
      return r;
    };
    const r = await p.injector.inject(T, aWait, choicesFor(aWait)[3]!, "Dragon\nfruit");
    expect(r).toEqual({ ok: true, sent: "Dragon fruit", confirmed: true });
    expect(p.sent()).toEqual([
      ["agent", "send-keys", "wB:p1", "down", "down"],
      ["agent", "send-keys", "wB:p1", "enter"],
      ["pane", "send-text", "wB:p1", "Dragon fruit"],
      ["agent", "send-keys", "wB:p1", "enter"],
    ]);
  });

  test("every inject and refusal is logged without the free text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qrlog-"));
    const file = join(dir, "log.jsonl");
    const p = fakePane({ screen: EDITOR_EMPTY, tail: REPLY_TAIL });
    const inj = new PaneInjector({ herdr: p.injector["deps"].herdr, readTail: async () => p.st.tail, sleep: async () => {}, logFile: file });
    await inj.inject(T, qWait, choicesFor(qWait)[3]!, "secret plan words");
    await inj.inject(T, qWait, choicesFor(qWait)[1]!); // the record moved on: refused
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ pane: "wB:p1", kind: "question", choice: "r", status: "delivered", chars: 17 });
    expect(rows[1]).toMatchObject({ choice: "y", status: "refused", reason: "a new turn started" });
    expect(readFileSync(file, "utf8")).not.toContain("secret plan");
  });
});

describe("mirror wait cards", () => {
  const at = (s: number) => new Date(Date.parse("2026-10-19T15:00:00Z") + s * 1000).toISOString();
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  const user = (s: number) => line({ type: "message", timestamp: at(s), message: { role: "user", content: [{ type: "text", text: "go" }] } });
  const askCall = (s: number, id: string) =>
    line({ type: "message", id: `e-${id}`, timestamp: at(s), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "ask", arguments: { i: "pick", questions: [{ id: "f", question: "Pick a test fruit", options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }], recommended: 1 }] } }] } });
  const result = (s: number, id: string) => line({ type: "message", timestamp: at(s), message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "User selected: Apple" }] } });
  const final = (s: number, text: string) => line({ type: "message", id: `f${s}`, timestamp: at(s), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

  test("ask steps carry the parsed question", () => {
    const { events } = sessionEvents(Buffer.from(askCall(1, "c1")));
    expect(events[0]).toMatchObject({ kind: "step", tool: "ask", callId: "c1", ask: FRUIT });
  });

  test("tail opens a card for an ask, closes it on the answer; a closing question opens another; a new turn closes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "waits-"));
    const session = join(dir, "s.jsonl");
    writeFileSync(session, "");
    const m = new Mirror(null, join(dir, "agents.json"));
    const e: MirrorEntry = { machine: "main", paneId: "wB:p1", tabId: "wB:t1", workspace: "wB", tab: "T", name: "t", channelId: "C1", archived: false, sessionFile: session };
    m.entries = [e];
    const log: string[] = [];
    let n = 0;
    const onWait = async (_e: MirrorEntry, w: PaneWait, a: { open: true } | { close: string }) => {
      log.push("open" in a ? `open ${w.kind}` : `close ${w.kind} ${a.close}`);
      return "open" in a ? `M${++n}` : undefined;
    };
    const tick = () => m.tail(async () => {}, undefined, undefined, Date.now, onWait);
    await tick(); // first sight: start here
    appendFileSync(session, user(0) + askCall(1, "c1"));
    await tick();
    expect(log).toEqual(["open ask"]);
    expect(e.wait).toMatchObject({ kind: "ask", callId: "c1", rec: "e-c1", msgId: "M1" });
    appendFileSync(session, result(5, "c1") + final(6, "Picked Apple. Should I continue with Banana?"));
    await tick();
    expect(log).toEqual(["open ask", "close ask -# ⏹️ Closed: answered at the terminal.", "open question"]);
    expect(e.wait).toMatchObject({ kind: "question", rec: "f6", question: "Picked Apple. Should I continue with Banana?", msgId: "M2" });
    // Saved with the entry, so buttons survive a restart.
    expect(new Mirror(null, join(dir, "agents.json")).entries[0]!.wait?.nonce).toBe(e.wait!.nonce);
    // An inject in progress owns its card: the new turn clears the wait without editing the card.
    e.wait!.sending = true;
    appendFileSync(session, user(9));
    await tick();
    expect(log.length).toBe(3);
    expect(e.wait).toBeUndefined();
  });

  test("a question answered in the same chunk gets no card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "waits2-"));
    const session = join(dir, "s.jsonl");
    writeFileSync(session, "");
    const m = new Mirror(null, join(dir, "agents.json"));
    m.entries = [{ machine: "main", paneId: "wB:p1", tabId: "wB:t1", workspace: "wB", tab: "T", name: "t", channelId: "C1", archived: false, sessionFile: session }];
    const log: string[] = [];
    const onWait = async (_e: MirrorEntry, w: PaneWait, a: { open: true } | { close: string }) => void log.push("open" in a ? `open ${w.kind}` : "close");
    const tick = () => m.tail(async () => {}, undefined, undefined, Date.now, onWait);
    await tick();
    appendFileSync(session, user(0) + askCall(1, "c1") + result(2, "c1") + final(3, "Shall I go on?") + user(4));
    await tick();
    expect(log).toEqual([]);
  });
});
