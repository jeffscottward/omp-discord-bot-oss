/**
 * ❌ Stop for a terminal job (owner 2026-10-28, card stack-catalog): every spawned job must have a Stop control in
 * Discord, also when its pane got no mirrored channel. The button sends Esc to the OMP agent in that exact Herdr
 * pane, which interrupts the running turn (the session and the tab stay; the owner can continue it).
 *
 * Guards: the owner pressed it (checked by the caller), the pane still exists on that host, and it runs `omp`.
 * Every press is logged. Custom id: `ps:<machine>:<paneId>`.
 */
export const PANE_STOP_PREFIX = "ps:";

export type PaneRef = { machine: string; paneId: string };

export function paneStopId(t: PaneRef): string {
  return `${PANE_STOP_PREFIX}${t.machine}:${t.paneId}`;
}

/** Herdr pane ids look like `wB:pWG`; the machine is the first segment of the custom id. */
export function parsePaneStopId(customId: string): PaneRef | null {
  if (!customId.startsWith(PANE_STOP_PREFIX)) return null;
  const m = customId.slice(PANE_STOP_PREFIX.length).match(/^(main|second):(w[A-Za-z0-9]+:p[A-Za-z0-9]+)$/);
  return m ? { machine: m[1]!, paneId: m[2]! } : null;
}

type Herdr = (t: PaneRef, args: string[]) => Promise<{ code: number; out: string }>;

/** Send Esc to the pane's OMP agent after the guards. Returns the text for the owner. */
export async function stopPane(t: PaneRef, herdr: Herdr, log: (s: string) => void = () => {}): Promise<{ ok: boolean; text: string }> {
  const list = await herdr(t, ["pane", "list"]);
  if (list.code !== 0) return { ok: false, text: `Could not reach Herdr on ${t.machine}. Nothing was sent.` };
  let agent: unknown;
  let found = false;
  try {
    const panes: unknown = JSON.parse(list.out)?.result?.panes;
    const pane: unknown = Array.isArray(panes) ? panes.find((p) => p && typeof p === "object" && "pane_id" in p && p.pane_id === t.paneId) : undefined;
    if (pane && typeof pane === "object") {
      found = true;
      agent = "agent" in pane ? pane.agent : undefined;
    }
  } catch {
    return { ok: false, text: "Herdr returned an unreadable pane list. Nothing was sent." };
  }
  if (!found) return { ok: false, text: `Pane \`${t.paneId}\` is closed. Nothing to stop.` };
  if (agent !== "omp") return { ok: false, text: `Pane \`${t.paneId}\` does not run OMP now. Nothing was sent.` };
  const r = await herdr(t, ["agent", "send-keys", t.paneId, "esc"]);
  log(`pane-stop: ${t.machine}:${t.paneId} esc ${r.code === 0 ? "sent" : `failed (${r.code})`}`);
  return r.code === 0
    ? { ok: true, text: `🛑 Stop sent to pane \`${t.paneId}\` (Esc interrupts its OMP turn; the session stays).` }
    : { ok: false, text: `Sending Stop to pane \`${t.paneId}\` failed.` };
}
