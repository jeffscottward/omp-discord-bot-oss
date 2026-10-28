// CLI for agents: bun scripts/remind.ts "<when> <message>"  (same as the bot's /remind: main toast + Discord ping + iPhone add-queue)
import { remind } from "../src/rigcmds.ts";
console.log(await remind(process.argv.slice(2).join(" ")));
