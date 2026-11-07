// CLI for agents: bun scripts/remind.ts "<when> <message>"  (same as the bot's /remind: main toast + Discord ping + iPhone add-queue)
// This is the only way agents add reminders. Never edit ~/.local/share/reminders-inbox/add-queue.txt by hand: a line
// without " | <ISO date>" stopped the iPhone Shortcut (card reminder-queue-date-guard, 2026-11-05).
import { remind } from "../src/rigcmds.ts";
console.log(await remind(process.argv.slice(2).join(" ")));
