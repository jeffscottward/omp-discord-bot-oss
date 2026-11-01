import { expect, test } from "bun:test";
import { join } from "node:path";

// fm-audit (owner 2026-10-31, card dashboard-autoflow): the every-minute dashboard auditor (fm-tick step).
// Its rules (F1-F6) and the ask-menu text are checked by the script's own pure self-test.
test("fm-audit self-test passes", () => {
  const r = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "..", "scripts", "fm-audit"), "--test"]);
  const out = r.stdout.toString() + r.stderr.toString();
  expect(out).toContain("checks passed");
  expect(r.exitCode).toBe(0);
});
