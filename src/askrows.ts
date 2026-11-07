/**
 * Button rows of one question menu (src/main.ts sendQuestions). Short number buttons, one per option; multi-select
 * adds "✅ Done"; there ✏️ Other keeps a note (green when set) that Done sends with the picks. Owner 2026-10-25 (card ask-cancel-button): every menu has a 🚫 Cancel button on its own row.
 * Discord allows 5 rows of 5 buttons, so options get at most 4 rows (20 buttons, Done included); options past that
 * stay in the message text and the owner can type the answer.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { AskStore, isOtherOption, type AskQuestion } from "./ask.ts";

export const ASK_CANCEL_PREFIX = "askcancel:";
export const ASK_DELETE_PREFIX = "askdel:";
const MAX_OPTION_BUTTONS = 20;

export function askRows(setId: string, qi: number, q: AskQuestion, picked = new Set<number>(), note = ""): ActionRowBuilder<ButtonBuilder>[] {
  const max = q.multi ? MAX_OPTION_BUTTONS - 1 : MAX_OPTION_BUTTONS;
  const buttons = q.options.slice(0, max).map((o, oi) =>
    new ButtonBuilder()
      .setCustomId(`${AskStore.customId(setId, qi)}:${isOtherOption(o) ? "other" : oi}`)
      .setLabel(isOtherOption(o) ? `${oi + 1} ✏️` : String(oi + 1))
      .setStyle(picked.has(oi) || (isOtherOption(o) && note) ? ButtonStyle.Success : q.recommended === oi ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  // The ✏️ Other option is normally last; keep its button when the list is cut.
  const other = q.options.findIndex((o) => isOtherOption(o));
  if (other >= max) {
    buttons.pop();
    buttons.push(new ButtonBuilder().setCustomId(`${AskStore.customId(setId, qi)}:other`).setLabel(`${other + 1} ✏️`).setStyle(note ? ButtonStyle.Success : ButtonStyle.Secondary));
  }
  if (q.multi) buttons.push(new ButtonBuilder().setCustomId(`${AskStore.customId(setId, qi)}:done`).setLabel("✅ Done").setStyle(ButtonStyle.Primary));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${ASK_CANCEL_PREFIX}${setId}`).setLabel("Cancel question").setEmoji("🚫").setStyle(ButtonStyle.Danger)));
  return rows;
}

/** Owner 2026-11-03 (card bot-ask-multi-other): the menu text with the pending ✏️ Other note shown (or removed) at its end. */
export const NOTE_MARK = "\n\n✏️ Note (sent with ✅ Done): ";
export function withNote(content: string, note: string): string {
  const i = content.lastIndexOf(NOTE_MARK);
  const base = i >= 0 ? content.slice(0, i) : content;
  if (!note) return base;
  // Shorten the note to fit; never cut the menu text (its options and hint must stay).
  const room = 2000 - base.length - NOTE_MARK.length - 2;
  if (room < 20) return base;
  const shown = note.replace(/[*_`]/g, "").slice(0, Math.min(300, room));
  return `${base}${NOTE_MARK}*${shown}*`;
}
