import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { mirrorSpokenSource, speakInPlace, speakRows } from "../src/speakedit.ts";

const row = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId("other").setLabel("x").setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId("speak:1").setEmoji("🔊").setStyle(ButtonStyle.Secondary),
).toJSON();

function fake(existing: string[] = [], editFails = false) {
  const calls = { edits: [] as any[], update: [] as any[], followUps: [] as any[] };
  const message: any = {
    id: "m1",
    components: [row()],
    attachments: new Map(existing.map((a) => [a, { id: a }])),
    edit: async (o: any) => { if (editFails && o.files) throw new Error("boom"); calls.edits.push(o); },
  };
  const i: any = { customId: "speak:1", message, update: async (o: any) => calls.update.push(o), followUp: async (o: any) => calls.followUps.push(o) };
  return { i, calls };
}
const audio = () => { const d = mkdtempSync(join(tmpdir(), "sp-")); const f = join(d, "a.ogg"); writeFileSync(f, "x"); return f; };
const deps = (f: string | null, size = 1) => ({ synthesize: async () => f, fileSize: () => size, log: () => {} });

describe("speakInPlace", () => {
  test("normal: edits the same message with the audio and removes the button", async () => {
    const { i, calls } = fake();
    expect(await speakInPlace(i, { text: "hi", name: "a.ogg" }, deps(audio()))).toBe("ok");
    const busy = calls.update[0].components[0].toJSON().components;
    expect(busy.find((c: any) => c.custom_id === "speak:1").disabled).toBe(true);
    const e = calls.edits[0];
    expect(e.files).toHaveLength(1);
    expect(e.components[0].toJSON().components.map((c: any) => c.custom_id)).toEqual(["other"]);
    expect(calls.followUps).toHaveLength(0);
  });
  test("keeps existing attachments", async () => {
    const { i, calls } = fake(["p1", "p2"]);
    await speakInPlace(i, { text: "hi", name: "a.ogg" }, deps(audio()));
    expect(calls.edits[0].attachments.map((a: any) => a.id)).toEqual(["p1", "p2"]);
  });
  test("edit failure: one ephemeral notice, button restored", async () => {
    const { i, calls } = fake([], true);
    expect(await speakInPlace(i, { text: "hi", name: "a.ogg" }, deps(audio()))).toBe("failed");
    expect(calls.followUps).toHaveLength(1);
    expect(calls.followUps[0].ephemeral).toBe(true);
    expect(calls.edits.at(-1).components[0].components.length).toBe(2);
  });
  test("too large and synth failure give ephemeral notices", async () => {
    for (const d of [deps(audio(), 50e6), deps(null)]) {
      const { i, calls } = fake();
      expect(await speakInPlace(i, { text: "hi", name: "a.ogg" }, d)).toBe("failed");
      expect(calls.followUps[0].ephemeral).toBe(true);
    }
  });
  test("journal: a press logs press + ok; a failure logs press + failed with the reason", async () => {
    const ok: string[] = [];
    await speakInPlace(fake().i, { text: "hello", name: "a.ogg" }, { ...deps(audio(), 1234), log: (s) => ok.push(s) });
    expect(ok[0]).toBe("speak press msg=m1 chars=5");
    expect(ok[1]).toMatch(/^speak ok msg=m1 bytes=1234 ms=\d+$/);
    const bad: string[] = [];
    await speakInPlace(fake().i, { text: "hello", name: "a.ogg" }, { ...deps(null), log: (s) => bad.push(s) });
    expect(bad[1]).toMatch(/^speak failed msg=m1 reason=synth ms=\d+$/);
  });
  test("mirrorSpokenSource drops the terminal header, ask blocks and pastes", () => {
    const t = "🖥️ **main:wB:p08** · terminal reply\nThe fix is live.\n\n```ask\n{\"questions\":[{\"id\":\"a\",\"question\":\"Pick one?\",\"options\":[\"A\",\"B\"]}]}\n```";
    const s = mirrorSpokenSource(t);
    expect(s).toContain("The fix is live.");
    expect(s).not.toContain("terminal reply");
    expect(s).not.toContain("Pick one");
    expect(mirrorSpokenSource("Plain reply")).toContain("Plain reply");
  });
  test("speakRows drops an emptied row", () => {
    const only = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("speak:1").setEmoji("🔊").setStyle(ButtonStyle.Secondary)).toJSON();
    expect(speakRows([only], "speak:1", null)).toHaveLength(0);
  });
});
