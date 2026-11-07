import { expect, test } from "bun:test";
import { join } from "node:path";

// kit/bin/fm-autoclear: the tracker rules (R1-R14) are checked by the script's own pure self-test.
// Card fm-boot-gate (2026-11-02) added R14 (bootGate: a card that waits for the next reboot is not idle; receipts apply).
test("kit fm-autoclear self-test passes", () => {
  const r = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "..", "kit", "bin", "fm-autoclear"), "--test"], {
    env: { ...process.env, OMP_KIT_ENV: "/nonexistent" },
  });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(out).toContain("all tests passed");
  expect(r.exitCode).toBe(0);
});
