import { describe, expect, test } from "bun:test";
import { asksOwner, classify, dueForAsk, hasCaveat, paneBusy, percentile, sessionEnded, trackerOpen } from "../src/cleanup.ts";

const H = 3_600_000;
const base = { name: "main-github-x", idleMs: 30 * H, thresholdMs: 24 * H, lastFromOwner: false, lastText: "Done. Report posted.", agentStatus: "idle", busy: false, ended: true };
const info = (fg: string[]) => JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_processes: fg.map((name) => ({ name })) } } });

describe("cleanup", () => {
  test("percentile", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBe(0);
  });
  test("classify", () => {
    expect(classify(base).kind).toBe("finished");
    expect(classify({ ...base, name: "main-github-firstmate" }).kind).toBe("protected");
    expect(classify({ ...base, name: "main-github-webapp-p2b" }).kind).toBe("protected");
    expect(classify({ ...base, name: "main-github-account-auth-check" }).kind).toBe("protected");
    expect(classify({ ...base, idleMs: H }).kind).toBe("active");
    expect(classify({ ...base, lastText: "Should I push it?" }).kind).toBe("unsure");
    expect(classify({ ...base, lastFromOwner: true }).kind).toBe("unsure");
    expect(classify({ ...base, busy: true }).kind).toBe("unsure");
    expect(classify({ ...base, agentStatus: "working" }).kind).toBe("unsure");
    expect(classify({ ...base, agentStatus: null }).kind).toBe("unsure");
    expect(classify({ ...base, ended: false }).kind).toBe("unsure");
  });
  test("asksOwner", () => {
    expect(asksOwner("All done.")).toBe(false);
    expect(asksOwner("Which one do you want?")).toBe(true);
    expect(asksOwner("Still waiting: P2b start")).toBe(true);
  });
  test("unsure triggers: caveats, empty text, open tracker items", () => {
    expect(classify({ ...base, lastText: "I could not confirm 50144's status because the account read was failing." }).kind).toBe("unsure");
    expect(classify({ ...base, lastText: "They will need a rebase onto that sync before they can be pushed." }).kind).toBe("unsure");
    expect(classify({ ...base, lastText: "   " }).kind).toBe("unsure");
    expect(classify({ ...base, openTrackerItem: true }).kind).toBe("unsure");
    expect(hasCaveat("All tests pass. Report posted.")).toBe(false);
    const items = [{ s: "waiting", n: "Cleanup on hold (#main-github-realestate-os)" }, { s: "done", n: "#main-github-debates" }];
    expect(trackerOpen(items, "main-github-realestate-os", "1")).toBe(true);
    expect(trackerOpen(items, "main-github-debates", "2")).toBe(false);
  });
  test("paneBusy", () => {
    const ps = ["100 1 bash /usr/bin/bash", "200 100 omp omp", "300 200 python3 /usr/bin/python3 ~/.local/share/omp-integrations/jev-browser/bridge.py mcp", "301 200 node-MainThread node /x/context-mode/server.bundle.mjs"].join("\n");
    expect(paneBusy(info(["bash", "omp"]), ps)).toBe(false);
    expect(paneBusy(info(["bash", "omp"]), `${ps}\n400 200 bash bash -c yt-dlp foo`)).toBe(true);
    expect(paneBusy(info(["bash", "longjob"]), ps)).toBe(true);
    expect(paneBusy(info(["bash"]), "100 1 bash bash\n500 100 sleep sleep 100")).toBe(true);
    expect(paneBusy("not json", ps)).toBe(true);
  });
  test("sessionEnded", () => {
    const a = (stop: string) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: stop } });
    expect(sessionEnded(a("stop"))).toBe(true);
    expect(sessionEnded(a("toolUse"))).toBe(false);
    expect(sessionEnded(`${a("stop")}\n${JSON.stringify({ type: "message", message: { role: "user" } })}`)).toBe(false);
    expect(sessionEnded("")).toBe(null);
  });
  test("dueForAsk once per week", () => {
    expect(dueForAsk(undefined, 0)).toBe(true);
    expect(dueForAsk(0, 6 * 24 * H)).toBe(false);
    expect(dueForAsk(0, 7 * 24 * H)).toBe(true);
  });
});
