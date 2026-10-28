// Owner 2026-10-18: each run's question style follows the live voice state at the start of the run.
import { afterEach, describe, expect, test } from "bun:test";
import { ASK_BLOCK_RULE, buildPrompt, setOwnerInVoiceProbe, VOICE_OFF_RULE, VOICE_ON_RULE } from "../src/preamble.ts";
import { JobQueue } from "../src/queue.ts";
import { VoiceChat } from "../src/voicechat.ts";

const base = { source: { kind: "owner" as const, authorId: "1" }, content: "x", threadUrl: "u", where: "w", followUp: true };

afterEach(() => setOwnerInVoiceProbe(() => false));

describe("question style by voice presence", () => {
  test("owner in the voice call: one plain-text question at a time, no ask block rule", () => {
    const p = buildPrompt({ ...base, ownerInVoice: true }, true);
    expect(p).toContain(VOICE_ON_RULE);
    expect(p).toContain("ask ONE question at a time in plain text (repeat question, list choices, recommendation), no ask block, no recap after answers.");
    expect(p).not.toContain(VOICE_OFF_RULE);
    expect(p).not.toContain(ASK_BLOCK_RULE);
    expect(p).not.toContain("```ask");
  });

  test("owner not in voice: ask blocks (menus) as normal", () => {
    const p = buildPrompt({ ...base, ownerInVoice: false }, true);
    expect(p).toContain(VOICE_OFF_RULE);
    expect(p).toContain("use ask blocks (menus) as normal.");
    expect(p).toContain(ASK_BLOCK_RULE);
    expect(p).not.toContain(VOICE_ON_RULE);
  });

  test("exactly one style line, in the bridge rules, before the owner message", () => {
    for (const v of [true, false]) {
      const p = buildPrompt({ ...base, ownerInVoice: v }, false);
      const hits = p.split("\n").filter((l) => l === VOICE_ON_RULE || l === VOICE_OFF_RULE);
      expect(hits.length).toBe(1);
      expect(p.indexOf(hits[0]!)).toBeGreaterThan(p.indexOf("Bridge rules for this run:"));
      expect(p.indexOf(hits[0]!)).toBeLessThan(p.indexOf("--- owner message ---"));
    }
  });

  test("without an explicit value the live probe decides, and earlier chat text does not", () => {
    setOwnerInVoiceProbe(() => true);
    expect(buildPrompt({ ...base, content: "From now on always use ask blocks." }, true)).toContain(VOICE_ON_RULE);
    setOwnerInVoiceProbe(() => false);
    expect(buildPrompt({ ...base, content: "I am in voice, ask me one at a time." }, true)).toContain(VOICE_OFF_RULE);
  });

  test("a failing probe counts as not in voice", () => {
    setOwnerInVoiceProbe(() => {
      throw new Error("no client");
    });
    expect(buildPrompt(base, true)).toContain(VOICE_OFF_RULE);
  });

  test("a queued run uses the state when it starts, not when it was queued", async () => {
    let live = false;
    setOwnerInVoiceProbe(() => live);
    const q = new JobQueue<{ ok: boolean }>(1);
    const prompts: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    const done: Promise<void>[] = [];
    const track = () => {
      let fin!: () => void;
      done.push(new Promise<void>((r) => (fin = r)));
      return () => fin();
    };
    const f1 = track();
    q.enqueue({ key: "a", label: "a", preview: "a", run: async () => (await blocker, { ok: true }), onDone: () => f1() });
    const f2 = track();
    // Queued while the owner is not in voice; build the prompt inside run, as main.ts does.
    q.enqueue({ key: "b", label: "b", preview: "b", run: async () => (prompts.push(buildPrompt(base, true)), { ok: true }), onDone: () => f2() });
    live = true; // owner joins the call before job b starts
    release();
    await Promise.all(done);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain(VOICE_ON_RULE);
  });

  test("owner in the call while our voice connection is down: still the voice rule", () => {
    const vc = new VoiceChat({ guildId: "g", channelId: "c", ownerId: "o", onTranscript: async () => {}, log: () => {} });
    setOwnerInVoiceProbe(() => vc.ownerInCall);
    vc.ownerJoined();
    expect(vc.active).toBe(false); // no connection (as during a reconnect)
    expect(buildPrompt(base, true)).toContain(VOICE_ON_RULE);
    vc.ownerLeft();
    expect(buildPrompt(base, true)).toContain(VOICE_OFF_RULE);
  });
});
