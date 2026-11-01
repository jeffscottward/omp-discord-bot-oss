import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vp from "../src/voicepick.ts";

const dir = () => mkdtempSync(join(tmpdir(), "vp-"));

describe("voicepick", () => {
  test("default voice when nothing or garbage is saved", () => {
    const d = dir();
    expect(vp.readVoice(d)).toBe("af_heart");
    writeFileSync(vp.voiceFile(d), "{bad");
    expect(vp.readVoice(d)).toBe("af_heart");
    writeFileSync(vp.voiceFile(d), JSON.stringify({ voice: "zz_nope" }));
    expect(vp.readVoice(d)).toBe("af_heart");
  });
  test("write then read round-trips; unknown voice is refused", () => {
    const d = dir();
    vp.writeVoice(d, "bm_george");
    expect(vp.readVoice(d)).toBe("bm_george");
    expect(() => vp.writeVoice(d, "../x")).toThrow();
  });
  test("every menu fits Discord limits and marks the current voice", () => {
    const m = vp.pickerMenu("am_michael");
    expect(m.components.length).toBe(4);
    for (const r of m.components) {
      const s = r.components[0];
      expect(s.options.length).toBeLessThanOrEqual(25);
      expect(s.custom_id.length).toBeLessThanOrEqual(100);
      for (const o of s.options) expect(o.label.length).toBeLessThanOrEqual(100);
    }
    const set = m.components.filter((r) => r.components[0].custom_id.startsWith(vp.SET_PREFIX));
    expect(set.flatMap((r) => r.components[0].options).filter((o) => o.default).map((o) => o.value)).toEqual(["am_michael"]);
    const hear = m.components.filter((r) => r.components[0].custom_id.startsWith(vp.HEAR_PREFIX));
    expect(hear.flatMap((r) => r.components[0].options).some((o) => o.default)).toBe(false);
  });
  test("labels", () => {
    expect(vp.voiceLabel("bf_emma")).toBe("Emma (British, female)");
    expect(vp.voiceLabel("am_echo")).toBe("Echo (American, male)");
  });
  test("preview cache path is per voice and absent until written", () => {
    const d = dir();
    expect(vp.cachedPreview(d, "af_sky")).toBeNull();
    expect(vp.previewPath(d, "af_sky")).toEndWith("voice-previews/af_sky.ogg");
  });
  test("status text names voice and server state", () => {
    const t = vp.statusText({ voice: "af_heart", serverUp: false, service: "inactive", cached: 2 });
    expect(t).toContain("Heart (American, female)");
    expect(t).toContain("❌ not answering");
    expect(t).toContain("/voice-change");
  });
});
