/**
 * Owner 2026-10-31 (card audio-in-place): the 🔊 button puts the audio on the SAME message it sits on.
 * No new channel message. Errors go to one short ephemeral notice.
 */
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction } from "discord.js";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { extractAsk } from "./ask.ts";
import { prepareOutbound } from "./outbound.ts";

/** Discord upload limit for bots without boosts. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/**
 * Card tts-on-demand: the text a mirrored terminal reply speaks. Drops the "🖥️ **tab** · terminal reply"
 * header, ask blocks and paste blocks; keeps the privacy filter of prepareOutbound.
 */
export function mirrorSpokenSource(text: string): string {
  const body = text.replace(/^🖥️ [^\n]*· terminal reply\n/u, "");
  return prepareOutbound(extractAsk(body).text).messages.filter((m) => !m.paste).map((m) => m.content).join("\n");
}

export interface SpeakDeps {
  synthesize: (text: string) => Promise<string | null>;
  fileSize: (path: string) => number;
  log: (s: string) => void;
}

/** Rebuild the message rows; the speak button gets `state`, or is removed when state is null. */
export function speakRows(components: readonly unknown[], customId: string, state: "busy" | null): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const r of components) {
    const row = ActionRowBuilder.from(r as never) as ActionRowBuilder<ButtonBuilder>;
    const kept = row.components.filter((c) => !("custom_id" in c.data && c.data.custom_id === customId));
    if (state === "busy" && kept.length !== row.components.length) {
      kept.push(new ButtonBuilder().setCustomId(customId).setEmoji("🔊").setLabel("generating…").setStyle(ButtonStyle.Secondary).setDisabled(true));
    }
    if (kept.length) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(kept));
  }
  return rows;
}

/**
 * Card tts-on-demand: every press writes `speak press` and one `speak ok|failed` line to the journal,
 * so a press that produced audio can be verified there.
 */
export async function speakInPlace(i: ButtonInteraction, saved: { text: string; name: string }, deps: SpeakDeps): Promise<"ok" | "failed"> {
  const m = i.message;
  const original = m.components as readonly unknown[];
  const started = Date.now();
  deps.log(`speak press msg=${m.id} chars=${saved.text.length}`);
  const notice = async (msg: string, reason: string): Promise<"failed"> => {
    deps.log(`speak failed msg=${m.id} reason=${reason} ms=${Date.now() - started}`);
    await m.edit({ components: original as never }).catch(() => {});
    await i.followUp({ content: msg, ephemeral: true }).catch(() => {});
    return "failed";
  };
  try {
    await i.update({ components: speakRows(original, i.customId, "busy") });
  } catch (e) {
    deps.log(`speak failed msg=${m.id} reason=update ms=${Date.now() - started}: ${(e as Error).message}`);
    return "failed";
  }
  const file = await deps.synthesize(saved.text).catch(() => null);
  if (!file) return notice("⚠️ Speech failed. Try again later.", "synth");
  try {
    const bytes = deps.fileSize(file);
    if (bytes > MAX_AUDIO_BYTES) return notice("⚠️ The audio is too large to attach.", `too-large bytes=${bytes}`);
    await m.edit({
      attachments: [...m.attachments.values()],
      files: [new AttachmentBuilder(file, { name: saved.name })],
      components: speakRows(original, i.customId, null),
    });
    deps.log(`speak ok msg=${m.id} bytes=${bytes} ms=${Date.now() - started}`);
    return "ok";
  } catch (e) {
    deps.log(`speak edit: ${(e as Error).message}`);
    return notice("⚠️ Could not add the audio to this message. Try again later.", "edit");
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
}
