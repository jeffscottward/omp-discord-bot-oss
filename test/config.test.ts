import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG, DEFAULT_CONFIG, commandEnabled, loadConfig } from "../src/config.ts";

const ROOT = join(import.meta.dir, "..");

describe("config", () => {
  test("tests run with the fake fixture config, never the real one", () => {
    expect(process.env.OMP_BOT_CONFIG).toBe(join(import.meta.dir, "fixtures", "config.test.json"));
    expect(CONFIG.hostLabel).toBe("test-host");
  });
  test("missing file gives the generic defaults (no personal values)", () => {
    const c = loadConfig("/nonexistent/config.json");
    expect(c.ownerId).toBe("");
    expect(c.channels).toEqual({});
    expect(c.dashboardUrl).toBe("");
    expect(c.fmDir).toBe(join(homedir(), ".local/share/omp-discord/reports-web/firstmate"));
    expect(c.optionalCommands).toEqual(DEFAULT_CONFIG.optionalCommands);
  });
  test("unreadable file (for example masked in the sandbox) gives the defaults", () => {
    expect(loadConfig(import.meta.dir).ownerId).toBe("");
  });
  test("config.example.json parses; ~ paths expand; nested defaults merge", () => {
    const c = loadConfig(join(ROOT, "config.example.json"));
    expect(Object.values(c.channels)[0]?.cwd).toBe(join(homedir(), "Github"));
    expect(c.mirror.peers).toEqual([]);
    expect(c.features.newsletterLogin).toBe(false);
    expect(c.heeler).toEqual({ host: "", redirect: "" });
  });
  test("optional owner-only slash commands are off unless listed", () => {
    expect(commandEnabled("cpu")).toBe(true);
    expect(commandEnabled("nest")).toBe(false);
    expect(commandEnabled("blinds")).toBe(false);
  });
});
