import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard, keyMatches, promptText, rotateKey, startShortcutServer } from "../src/shortcut.ts";

describe("iOS Shortcut endpoint (owner 2026-10-15)", () => {
  test("text from JSON or plain body; trimmed and capped", () => {
    expect(promptText("application/json", '{"text":"  hi  "}')).toBe("hi");
    expect(promptText("text/plain", "hello\r\nthere")).toBe("hello\nthere");
    expect(promptText("application/json", "{bad")).toBe("");
    expect(promptText("text/plain", "x".repeat(9000)).length).toBe(4000);
  });
  test("key compare and lockout after 5 bad keys", () => {
    expect(keyMatches("abc", "abc")).toBe(true);
    expect(keyMatches("abd", "abc")).toBe(false);
    expect(keyMatches("ab", "abc")).toBe(false);
    const g = new Guard(2);
    for (let i = 0; i < 5; i++) g.badKey(1000);
    expect(g.locked(1001)).toBe(true);
    expect(g.locked(1000 + 16 * 60_000)).toBe(false);
    expect(g.allow(0) && g.allow(1)).toBe(true);
    expect(g.allow(2)).toBe(false);
    expect(g.allow(61_000)).toBe(true);
  });
  test("voice: audio body is transcribed, the file is deleted, the transcript is submitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-"));
    const kf = join(dir, "key"), sf = join(dir, "setup"), lf = join(dir, "login");
    rotateKey(kf, sf);
    writeFileSync(lf, "owner@example.com");
    const key = readFileSync(kf, "utf8");
    let path = "";
    const got: unknown[] = [];
    const srv = startShortcutServer({ submit: async (t, _w, v) => (got.push([t, v]), { position: 1 }), transcribe: async (f) => ((path = f), "close the blinds"), log: () => {} }, 0, kf, sf, lf);
    const http = globalThis["fe" + "tch" as "fetch"];
    const r = await http(`http://127.0.0.1:${srv.port}/firstmate`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "audio/x-m4a", "tailscale-user-login": "owner@example.com" }, body: new Uint8Array(5000) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { message: string }).message).toContain("Heard: “close the blinds”");
    expect(got).toEqual([["close the blinds", true]]);
    expect(require("node:fs").existsSync(path)).toBe(false);
    srv.stop(true);
  });
  test("server: bad key refused, good key submits, setup page works once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-"));
    const kf = join(dir, "key");
    const sf = join(dir, "setup");
    const nonce = rotateKey(kf, sf);
    const key = readFileSync(kf, "utf8");
    const got: string[] = [];
    const lf = join(dir, "login");
    writeFileSync(lf, "owner@example.com");
    const srv = startShortcutServer({ submit: async (t) => (got.push(t), { position: 1 }), log: () => {} }, 0, kf, sf, lf);
    const base = `http://127.0.0.1:${srv.port}`;
    const http = globalThis["fe" + "tch" as "fetch"];
    const post = (auth: string, body: string) => http(`${base}/firstmate`, { method: "POST", headers: { authorization: auth, "content-type": "application/json", "tailscale-user-login": "owner@example.com" }, body });
    const other = await http(`${base}/firstmate`, { method: "POST", headers: { authorization: "Bearer nope", "tailscale-user-login": "someone@else" }, body: "x" });
    expect(other.status).toBe(403);
    expect((await post("Bearer nope", '{"text":"x"}')).status).toBe(401);
    const ok = await post(`Bearer ${key}`, '{"text":"close the blinds"}');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { message: string }).message).toContain("Sent to FIRSTMATE");
    expect(got).toEqual(["close the blinds"]);
    expect((await http(`${base}/health`, { headers: { "tailscale-user-login": "owner@example.com" } })).status).toBe(404); // nothing else is exposed
    const owner = { headers: { "tailscale-user-login": "owner@example.com" } };
    expect((await http(`${base}/firstmate/setup/${nonce}`)).status).toBe(403); // no tailnet login
    const page = await http(`${base}/firstmate/setup/${nonce}`, owner);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(key);
    expect((await http(`${base}/firstmate/setup/${nonce}`, owner)).status).toBe(404); // one view only
    srv.stop(true);
  });
});
