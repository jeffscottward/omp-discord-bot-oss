// /voice-change and /voice-status (owner request 2026-10-31, card voice-picker): pick the Kokoro voice that
// reads answers aloud, and hear a preview of each voice first. The choice is saved in state/tts-voice.json;
// speech.ts sends it with every request to scripts/tts_server.py.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_VOICE = "af_heart";
export const PREVIEW_TEXT = "The quick brown fox jumps over the lazy dog.";
/** customId prefixes: set = save the voice and close the menu; hear = post a preview clip. */
export const SET_PREFIX = "vpick:set:";
export const HEAR_PREFIX = "vpick:hear:";

/** English Kokoro v1.0 voices (voices-v1.0.bin). Each group fits one Discord select menu (max 25). */
export const VOICE_GROUPS: { id: string; label: string; voices: string[] }[] = [
  {
    id: "us",
    label: "American English",
    voices: ["af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa"],
  },
  { id: "gb", label: "British English", voices: ["bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis"] },
];
export const ALL_VOICES: readonly string[] = VOICE_GROUPS.flatMap((g) => g.voices);

/** "am_michael" → "Michael (American, male)". */
export function voiceLabel(v: string): string {
  const m = v.match(/^([ab])([fm])_(\w+)$/);
  if (!m) return v;
  const name = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1);
  return `${name} (${m[1] === "a" ? "American" : "British"}, ${m[2] === "f" ? "female" : "male"})`;
}

export function isVoice(v: unknown): v is string {
  return typeof v === "string" && ALL_VOICES.includes(v);
}

export function voiceFile(stateDir: string): string {
  return join(stateDir, "tts-voice.json");
}

/** Saved voice; the default when nothing valid is saved. */
export function readVoice(stateDir: string): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(voiceFile(stateDir), "utf8"));
    const v = raw && typeof raw === "object" && "voice" in raw ? raw.voice : null;
    return isVoice(v) ? v : DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}

export function writeVoice(stateDir: string, voice: string): void {
  if (!isVoice(voice)) throw new Error(`unknown voice ${voice}`);
  mkdirSync(stateDir, { recursive: true });
  const f = voiceFile(stateDir);
  writeFileSync(`${f}.tmp`, `${JSON.stringify({ voice, at: new Date().toISOString() })}\n`);
  renameSync(`${f}.tmp`, f);
}

/** Cached preview clip path for a voice (state/voice-previews/<voice>.ogg). */
export function previewPath(stateDir: string, voice: string): string {
  return join(stateDir, "voice-previews", `${voice}.ogg`);
}

export function cachedPreview(stateDir: string, voice: string): string | null {
  const p = previewPath(stateDir, voice);
  return existsSync(p) && statSync(p).size > 0 ? p : null;
}

type Option = { label: string; value: string; description?: string; default?: boolean };
type SelectRow = { type: 1; components: [{ type: 3; custom_id: string; placeholder: string; options: Option[] }] };

/** The /voice-change message: one "use" menu and one "hear" menu per voice group (4 rows). */
export function pickerMenu(current: string): { content: string; components: SelectRow[] } {
  const rows: SelectRow[] = [];
  for (const kind of ["set", "hear"] as const) {
    for (const g of VOICE_GROUPS) {
      rows.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `${kind === "set" ? SET_PREFIX : HEAR_PREFIX}${g.id}`,
            placeholder: kind === "set" ? `✅ Use a voice: ${g.label}` : `🔊 Hear a sample: ${g.label}`,
            options: g.voices.map((v) => ({ label: voiceLabel(v), value: v, description: v, ...(kind === "set" && v === current ? { default: true } : {}) })),
          },
        ],
      });
    }
  }
  return {
    content: `🗣️ **TTS voice** · now: **${voiceLabel(current)}** (\`${current}\`)\n🔊 "Hear a sample" posts a short clip. ✅ "Use a voice" saves it and closes this menu.`,
    components: rows,
  };
}

/** /voice-status text. */
export function statusText(s: { voice: string; serverUp: boolean; service: string; cached: number }): string {
  return [
    "🗣️ **Voice (text to speech)**",
    `Voice: **${voiceLabel(s.voice)}** (\`${s.voice}\`)`,
    `Server: ${s.serverUp ? "✅ answering" : "❌ not answering"} (omp-tts.service: ${s.service})`,
    `Cached samples: ${s.cached} of ${ALL_VOICES.length}`,
    "Change it with `/voice-change`.",
  ].join("\n");
}
