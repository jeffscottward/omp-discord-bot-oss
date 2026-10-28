// Owner 2026-10-23 (Discord UX item 2): one-time tailnet secret form; value only in a 0600 file.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { destDenied, SecretDrops, startSecretDropServer, writeSecretFile } from "../src/secretdrop.ts";

const home = mkdtempSync("/tmp/sdrop-");
mkdirSync(join(home, ".config", "tahoma"), { recursive: true });
mkdirSync(join(home, ".ssh"));
mkdirSync(join(home, "elsewhere"));
symlinkSync(join(home, "elsewhere"), join(home, ".config", "link"));

describe("destDenied", () => {
  test("allows files under ~/.config, ~/.local/state, ~/.secrets", () => {
    expect(destDenied(join(home, ".config/tahoma/token"), home)).toBeNull();
    expect(destDenied(join(home, ".local/state/x/key"), home)).toBeNull();
    expect(destDenied(join(home, ".secrets/k"), home)).toBeNull();
  });
  test("refuses other places, protected folders, symlinked dirs and bad paths", () => {
    expect(destDenied("rel/token", home)).not.toBeNull();
    expect(destDenied("/etc/token", home)).not.toBeNull();
    expect(destDenied(join(home, ".bashrc"), home)).not.toBeNull();
    expect(destDenied(join(home, ".ssh/authorized_keys"), home)).not.toBeNull();
    expect(destDenied(join(home, ".config/systemd/user/x.service"), home)).not.toBeNull();
    expect(destDenied(join(home, ".config/link/token"), home)).toContain("not a plain directory");
    expect(destDenied(`${home}/.config/../.bashrc`, home)).not.toBeNull();
    expect(destDenied(join(home, ".config/tahoma"), home)).toContain("not a regular file");
  });
});

test("writeSecretFile writes 0600, refuses overwrite unless asked", () => {
  const f = join(home, ".config/tahoma/w1");
  writeSecretFile(f, "abc", false);
  expect(readFileSync(f, "utf8")).toBe("abc\n");
  expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(() => writeSecretFile(f, "x", false)).toThrow();
  writeSecretFile(f, "new", true);
  expect(readFileSync(f, "utf8")).toBe("new\n");
});

describe("SecretDrops", () => {
  test("one use, length only, expiry", () => {
    const d = new SecretDrops(home);
    const t0 = Date.now();
    const a = d.create({ name: "TaHoma token", dest: join(home, ".config/tahoma/token") }, t0);
    if ("error" in a) throw new Error(a.error);
    expect(a.id.length).toBeGreaterThanOrEqual(32);
    const r = d.receive(a.id, "  s3cr3t-value\n", t0 + 1000);
    expect("chars" in r && r.chars).toBe(12);
    expect(JSON.stringify(d.status(a.id, t0 + 1000))).not.toContain("s3cr3t");
    expect(d.receive(a.id, "again", t0 + 2000)).toMatchObject({ status: 410 });
    const b = d.create({ name: "late", dest: join(home, ".config/tahoma/late") }, t0);
    if ("error" in b) throw new Error(b.error);
    expect(d.receive(b.id, "v", t0 + 16 * 60_000)).toMatchObject({ status: 410 });
    expect(d.status(b.id, t0 + 16 * 60_000)!.state).toBe("expired");
  });
  test("a failed write is reported as failed, never as received", () => {
    const d = new SecretDrops(home);
    const dest = join(home, ".config/tahoma/race");
    const a = d.create({ name: "race", dest });
    if ("error" in a) throw new Error(a.error);
    writeFileSync(dest, "existing"); // appears after create; overwrite is off
    expect(d.receive(a.id, "v")).toMatchObject({ status: 500 });
    expect(d.status(a.id)!.state).toBe("failed");
    expect(d.status(a.id)!.chars).toBeUndefined();
    expect(d.receive(a.id, "v")).toMatchObject({ status: 410 });
    expect(readFileSync(dest, "utf8")).toBe("existing");
  });
  test("the bot's own config folder is protected", () => {
    expect(destDenied(join(home, ".config/omp-discord/shortcut-login"), home)).toContain("protected");
    expect(destDenied(join(home, ".local/share/systemd/user/x.service"), home)).toContain("protected");
  });
  test("create refuses existing dest without overwrite and bad names", () => {
    const d = new SecretDrops(home);
    expect(d.create({ name: "x", dest: join(home, ".config/tahoma/w1") })).toHaveProperty("error");
    expect(d.create({ name: "x", dest: join(home, ".config/tahoma/w1"), overwrite: true })).not.toHaveProperty("error");
    expect(d.create({ name: "<script>", dest: join(home, ".config/tahoma/n") })).toHaveProperty("error");
  });
});

describe("server", () => {
  const login = join(home, "login");
  writeFileSync(login, "owner@example.com\n");
  const drops = new SecretDrops(home);
  const logs: string[] = [];
  const received: string[] = [];
  // Port 0 = OS-assigned: a random port in the kernel ephemeral range can be held by an outgoing loopback
  // connection ("Failed to start server. Is port 45756 in use?", gate run 2026-10-23).
  const srv = startSecretDropServer({ drops, log: (m) => logs.push(m), onReceived: (d) => received.push(d.name) }, 0, login);
  const base = `http://127.0.0.1:${srv.port}/secret-drop`;
  const H = { "tailscale-user-login": "owner@example.com" };
  const SECRET = "tok-9f8e7d6c5b4a";

  test("only the owner's tailnet login is served", async () => {
    const d = drops.create({ name: "k1", dest: join(home, ".config/tahoma/k1") });
    if ("error" in d) throw new Error(d.error);
    expect((await globalThis.fetch(`${base}/${d.id}`)).status).toBe(403);
    expect((await globalThis.fetch(`${base}/${d.id}`, { headers: { "tailscale-user-login": "other@x" } })).status).toBe(403);
    const page = await globalThis.fetch(`${base}/${d.id}`, { headers: H });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("<form method=\"post\"");
  });
  test("a submit writes the file once; the value is never logged or echoed", async () => {
    const d = drops.create({ name: "k2", dest: join(home, ".config/tahoma/k2") });
    if ("error" in d) throw new Error(d.error);
    const post = () => globalThis.fetch(`${base}/${d.id}`, { method: "POST", headers: { ...H, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ value: SECRET }) });
    const r = await post();
    const t = await r.text();
    expect(r.status).toBe(200);
    expect(t).toContain(`Received, ${SECRET.length} characters`);
    expect(t).not.toContain(SECRET);
    expect(readFileSync(join(home, ".config/tahoma/k2"), "utf8")).toBe(`${SECRET}\n`);
    expect(statSync(join(home, ".config/tahoma/k2")).mode & 0o777).toBe(0o600);
    expect((await post()).status).toBe(410);
    expect((await globalThis.fetch(`${base}/${d.id}`, { headers: H })).status).toBe(410);
    expect(received).toContain("k2");
    expect(logs.join("\n")).not.toContain(SECRET);
  });
  test("cross-site posts and unknown ids are refused", async () => {
    const d = drops.create({ name: "k3", dest: join(home, ".config/tahoma/k3") });
    if ("error" in d) throw new Error(d.error);
    const xs = await globalThis.fetch(`${base}/${d.id}`, { method: "POST", headers: { ...H, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "value=x" });
    expect(xs.status).toBe(403);
    expect((await globalThis.fetch(`${base}/${"A".repeat(32)}`, { headers: H })).status).toBe(404);
    expect((await globalThis.fetch(`http://127.0.0.1:${srv.port}/other`, { headers: H })).status).toBe(404);
  });
  test("stop", () => srv.stop(true));
});
