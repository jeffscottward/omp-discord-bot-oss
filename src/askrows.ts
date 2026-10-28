/**
 * Button rows of one question menu (src/main.ts sendQuestions). Short number buttons, one per option; multi-select
 * adds "✅ Done". Owner 2026-10-25 (card ask-cancel-button): every menu has a 🚫 Cancel button on its own row.
 * Discord allows 5 rows of 5 buttons, so options get at most 4 rows (20 buttons, Done included); options past that
 * stay in the message text and the owner can type the answer.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { AskStore, isOtherOption, type AskQuestion } from "./ask.ts";

export const ASK_CANCEL_PREFIX = "askcancel:";
export const ASK_DELETE_PREFIX = "askdel:";
const MAX_OPTION_BUTTONS = 20;

export function askRows(setId: string, qi: number, q: AskQuestion, picked = new Set<number>()): ActionRowBuilder<ButtonBuilder>[] {
  const max = q.multi ? MAX_OPTION_BUTTONS - 1 : MAX_OPTION_BUTTONS;
  const buttons = q.options.slice(0, max).map((o, oi) =>
    new ButtonBuilder()
      .setCustomId(`${AskStore.customId(setId, qi)}:${isOtherOption(o) ? "other" : oi}`)
      .setLabel(isOtherOption(o) ? `${oi + 1} ✏️` : String(oi + 1))
      .setStyle(picked.has(oi) ? ButtonStyle.Success : q.recommended === oi ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  // The ✏️ Other option is normally last; keep its button when the list is cut.
  const other = q.options.findIndex((o) => isOtherOption(o));
  if (other >= max) {
    buttons.pop();
    buttons.push(new ButtonBuilder().setCustomId(`${AskStore.customId(setId, qi)}:other`).setLabel(`${other + 1} ✏️`).setStyle(ButtonStyle.Secondary));
  }
  if (q.multi) buttons.push(new ButtonBuilder().setCustomId(`${AskStore.customId(setId, qi)}:done`).setLabel("✅ Done").setStyle(ButtonStyle.Primary));
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${ASK_CANCEL_PREFIX}${setId}`).setLabel("Cancel question").setEmoji("🚫").setStyle(ButtonStyle.Danger)));
  return rows;
}
