// VoiceDebug memory cap (tracker card restart-when-idle-give-up-voicedebug-memory, 2026-10-18):
// the owner track keeps only the newest audio, drops the oldest first and reports the first drop once.
import { describe, expect, test } from "bun:test";
import { OggOpusFile } from "../src/ogg.ts";
import { CappedOpusTrack, DEFAULT_MAX_BYTES, DEFAULT_MAX_SECONDS, voiceDebugLimits } from "../src/voicedebug.ts";

/** A packet whose first byte identifies it, so the kept order can be checked. */
const pkt = (id: number, size = 10) => {
  const b = Buffer.alloc(size, 0);
  b[0] = id;
  return b;
};

/** Packet ids in a built Ogg file: every page after the two header pages, split by its lacing values. */
function packetIds(ogg: Buffer): number[] {
  const ids: number[] = [];
  let off = 0;
  let page = 0;
  while (off < ogg.length) {
    const nseg = ogg[off + 26]!;
    const lacing = [...ogg.subarray(off + 27, off + 27 + nseg)];
    let body = off + 27 + nseg;
    if (page >= 2) {
      let len = 0;
      for (const l of lacing) {
        len += l;
        if (l < 255) {
          ids.push(ogg[body]!);
          body += len;
          len = 0;
        }
      }
    }
    off += 27 + nseg + lacing.reduce((a, b) => a + b, 0);
    page++;
  }
  return ids;
}

describe("voice debug limits", () => {
  test("defaults: 30 min and 32 MiB", () => {
    expect(voiceDebugLimits({})).toEqual({ maxFrames: (DEFAULT_MAX_SECONDS * 1000) / 20, maxBytes: DEFAULT_MAX_BYTES });
    expect(voiceDebugLimits({}).maxFrames).toBe(90_000);
  });
  test("env overrides", () => {
    expect(voiceDebugLimits({ OMP_VOICE_DEBUG_MAX_SECONDS: "60", OMP_VOICE_DEBUG_MAX_BYTES: "1000" })).toEqual({ maxFrames: 3000, maxBytes: 1000 });
  });
  test("bad values fall back to the defaults", () => {
    for (const v of ["", "0", "-5", "abc", "NaN"]) {
      expect(voiceDebugLimits({ OMP_VOICE_DEBUG_MAX_SECONDS: v, OMP_VOICE_DEBUG_MAX_BYTES: v })).toEqual(voiceDebugLimits({}));
    }
  });
});

describe("capped owner track: frame limit", () => {
  const limits = { maxFrames: 5, maxBytes: 1_000_000 };

  test("under the cap: everything kept, no notice", () => {
    const caps: unknown[] = [];
    const t = new CappedOpusTrack(limits, (i) => caps.push(i));
    for (let i = 1; i <= 4; i++) t.add(pkt(i));
    expect(t.file.count).toBe(4);
    expect(t.droppedFrames).toBe(0);
    expect(caps).toEqual([]);
    expect(packetIds(t.file.build())).toEqual([1, 2, 3, 4]);
  });

  test("at the cap: everything kept, no notice", () => {
    const caps: unknown[] = [];
    const t = new CappedOpusTrack(limits, (i) => caps.push(i));
    for (let i = 1; i <= 5; i++) t.add(pkt(i));
    expect(t.file.count).toBe(5);
    expect(t.droppedFrames).toBe(0);
    expect(caps).toEqual([]);
  });

  test("over the cap: oldest dropped first, one notice only", () => {
    const caps: unknown[] = [];
    const t = new CappedOpusTrack(limits, (i) => caps.push(i));
    for (let i = 1; i <= 12; i++) t.add(pkt(i));
    expect(t.file.count).toBe(5);
    expect(t.droppedFrames).toBe(7);
    expect(t.droppedBytes).toBe(70);
    expect(t.file.bytes).toBe(50);
    expect(t.file.durationMs).toBe(100);
    expect(caps).toEqual([{ limit: "frames", maxFrames: 5, maxBytes: 1_000_000 }]);
    expect(packetIds(t.file.build())).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("capped owner track: byte limit", () => {
  const limits = { maxFrames: 1000, maxBytes: 100 };

  test("under and at the cap: nothing dropped", () => {
    const caps: unknown[] = [];
    const t = new CappedOpusTrack(limits, (i) => caps.push(i));
    for (let i = 1; i <= 9; i++) t.add(pkt(i));
    expect(t.file.bytes).toBe(90);
    t.add(pkt(10));
    expect(t.file.bytes).toBe(100);
    expect(t.droppedFrames).toBe(0);
    expect(caps).toEqual([]);
  });

  test("over the cap: oldest dropped until within the byte limit", () => {
    const caps: unknown[] = [];
    const t = new CappedOpusTrack(limits, (i) => caps.push(i));
    for (let i = 1; i <= 10; i++) t.add(pkt(i));
    t.add(pkt(11, 35)); // 135 bytes -> drop 1, 2, 3, 4 (95 bytes left)
    expect(t.file.bytes).toBe(95);
    expect(t.droppedFrames).toBe(4);
    expect(caps).toEqual([{ limit: "bytes", maxFrames: 1000, maxBytes: 100 }]);
    expect(packetIds(t.file.build())).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  test("one packet larger than the byte limit is still kept", () => {
    const t = new CappedOpusTrack(limits);
    t.add(pkt(1));
    t.add(pkt(2, 250));
    expect(t.file.count).toBe(1);
    expect(packetIds(t.file.build())).toEqual([2]);
  });
});

describe("Ogg file drop support", () => {
  test("a long run of drops stays correct across compaction", () => {
    const t = new CappedOpusTrack({ maxFrames: 3, maxBytes: 1_000_000 });
    for (let i = 0; i < 20_000; i++) t.add(pkt(i % 256));
    expect(t.file.count).toBe(3);
    expect(t.droppedFrames).toBe(19_997);
    expect(packetIds(t.file.build())).toEqual([19_997 % 256, 19_998 % 256, 19_999 % 256]);
  });

  test("dropOldest on an empty file returns 0 and build stays empty", () => {
    const f = new OggOpusFile();
    expect(f.dropOldest()).toBe(0);
    f.add(pkt(1));
    expect(f.dropOldest()).toBe(10);
    expect(f.count).toBe(0);
    expect(f.bytes).toBe(0);
    expect(f.build().length).toBe(0);
  });
});
