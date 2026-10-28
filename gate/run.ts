// Trusted mode: run an approved queue entry from the Discord Approve button (no password).
// Same single-use claim and hash check as gate/approve.ts; output goes into the receipt only.
import { spawn } from "node:child_process";
import { redact } from "../src/redact.ts";
import { redactKnownSecrets } from "../src/secrets.ts";
import { APPROVAL_RUN_TIMEOUT_MS as RUN_TIMEOUT_MS, fmtMin, startHeartbeat } from "./longjob.ts";
import { hashEntry, movePending, readEntry, writeReceipt } from "./queue.ts";
import { stopGroup } from "./procgroup.ts";

const MAX_CAPTURE = 256 * 1024;
const RECEIPT_CHARS = 3000;
/** Button jobs run inside the bridge process, so a bridge restart would kill them. /health reports this count as "approvals"; restart-when-idle.sh waits while it is above 0. */
const active = new Set<string>();
export const activeButtonRuns = () => active.size;

export type ButtonRun = "started" | "gone" | "changed" | "expired";

/** Claim the entry (must still match the posted hash), run it with `bash -c`, write the receipt. */
export function runFromButton(dir: string, id: string, hash: string, by: string): { state: ButtonRun; done?: Promise<void> } {
  const e = readEntry(dir, "pending", id);
  if (!e) return { state: "gone" };
  if (hashEntry(e) !== hash) return { state: "changed" };
  if (Date.now() > e.expiresAt) return { state: "expired" };
  if (!movePending(dir, id, "claimed")) return { state: "gone" };
  const claimed = readEntry(dir, "claimed", id);
  if (!claimed || hashEntry(claimed) !== hash) {
    writeReceipt(dir, { id, status: "rejected", detail: "the entry changed while it was claimed", at: Date.now() });
    return { state: "changed" };
  }
  active.add(id);
  const done = (async () => {
    const child = spawn("bash", ["-c", claimed.command], { cwd: claimed.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const beat = startHeartbeat(`approval \`${id}\`: ${redact(claimed.reason || claimed.command).text.slice(0, 200)}`);
    let output = "";
    const take = (d: Buffer) => {
      if (output.length < MAX_CAPTURE) output += d.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      // Whole group: SIGTERM, SIGKILL after 10 s (gate/procgroup.ts).
      if (child.pid) void stopGroup(child.pid);
    }, RUN_TIMEOUT_MS);
    const closed = Promise.withResolvers<number | null>();
    child.on("close", closed.resolve);
    child.on("error", () => closed.resolve(127));
    const code = await closed.promise;
    clearTimeout(t);
    const tail = output.length > RECEIPT_CHARS ? `…${output.slice(-RECEIPT_CHARS)}` : output;
    writeReceipt(dir, {
      id,
      status: "ran",
      exitCode: code,
      output: redactKnownSecrets(redact(tail).text).text,
      detail: `${timedOut ? `stopped after ${fmtMin(RUN_TIMEOUT_MS)}` : `exit ${code}`}; approved by ${by} with the Discord button`,
      at: Date.now(),
    });
    await beat.stop(timedOut ? `stopped at the ${fmtMin(RUN_TIMEOUT_MS)} limit` : `exit ${code}`);
  })().finally(() => active.delete(id));
  return { state: "started", done };
}
