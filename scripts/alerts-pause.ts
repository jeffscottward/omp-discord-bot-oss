// Owner alert pause switch (see src/alertpause.ts).
// Usage: bun scripts/alerts-pause.ts <30m|2h|1d> [reason]   pause owner alerts (max 7 days)
//        bun scripts/alerts-pause.ts off | resume            end the pause now (the bot posts the held-alert digest)
//        bun scripts/alerts-pause.ts status                  print the state as JSON
import { clearPause, parseDuration, readPause, setPause } from "../src/alertpause.ts";

const [cmd = "status", ...rest] = process.argv.slice(2);
const by = process.env.FM_BY || (process.env.HERDR_PANE_ID ? `pane:${process.env.HERDR_PANE_ID}` : "cli");
if (cmd === "status") {
  const p = readPause();
  console.log(JSON.stringify(p ? { paused: true, ...p, untilIso: new Date(p.until).toISOString() } : { paused: false }));
} else if (cmd === "off" || cmd === "resume") {
  console.log(clearPause() ? "resumed (the bot posts the held-alert digest within 30 s)" : "not paused");
} else {
  const ms = parseDuration(cmd);
  if (!ms) {
    console.error("usage: alerts-pause <30m|2h|1d|off|status> [reason]");
    process.exit(2);
  }
  try {
    const p = setPause(ms, rest.join(" "), by);
    console.log(`paused until ${new Date(p.until).toISOString()}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
