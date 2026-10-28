import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPostFiles } from "../src/attach.ts";
import { startHttp } from "../src/http.ts";

const home = mkdtempSync("/tmp/postfiles-");
mkdirSync(join(home, "Documents"));
const ok = join(home, "Documents", "t.pdf");
writeFileSync(ok, "pdf");
const big = join(home, "Documents", "big.bin");
writeFileSync(big, Buffer.alloc(2048));

describe("checkPostFiles", () => {
  test("absent is empty", () => expect(checkPostFiles(undefined, home)).toEqual({ files: [] }));
  test("accepts a file under an allowed root", () =>
    expect(checkPostFiles([ok], home)).toEqual({ files: [{ path: ok, name: "t.pdf" }] }));
  test("rejects bad shapes and paths", () => {
    expect(checkPostFiles("x", home)).toHaveProperty("error");
    expect(checkPostFiles([1], home)).toHaveProperty("error");
    expect(checkPostFiles(["rel.pdf"], home)).toHaveProperty("error");
    expect(checkPostFiles(["/etc/hostname"], home)).toHaveProperty("error");
    expect(checkPostFiles([join(home, "Documents")], home)).toHaveProperty("error");
    expect(checkPostFiles([join(home, "Documents", "nope.pdf")], home)).toHaveProperty("error");
    expect(checkPostFiles(Array(11).fill(ok), home)).toHaveProperty("error");
    expect(checkPostFiles([big], home, 1024)).toHaveProperty("error");
  });
});

describe("POST /post files", () => {
  const sent: { files?: unknown[]; opts?: { copy?: boolean } }[] = [];
  // Port 0 = OS-assigned (port clash 2026-10-23); never the live bot's 47821.
  const srv = startHttp({ post: async (_id, _text, files, opts) => void sent.push({ files, opts }), health: () => ({}) }, 0);
  const post = (body: unknown) =>
    globalThis.fetch(`http://127.0.0.1:${srv.port}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  test("rejects a file outside the roots with 400", async () => {
    const r = await post({ channel: "general-x", text: "x", files: ["/etc/hostname"] });
    expect(r.status).toBe(400);
    expect(sent.length).toBe(0);
  });
  test("passes valid files to post", async () => {
    const r = await post({ channel: "general-x", text: "x", files: [ok] });
    expect(r.status).toBe(200);
    expect(sent[0]!.files!.length).toBe(1);
  });
  test("copy:true is passed through; bad copy values and copy+files are rejected", async () => {
    const before = sent.length;
    expect((await post({ channel: "general-x", text: "/watch url:https://example.com/a.mp4", copy: true })).status).toBe(200);
    expect(sent.at(-1)?.opts).toEqual({ copy: true });
    expect((await post({ channel: "general-x", text: "x", copy: "yes" })).status).toBe(400);
    expect(sent.length).toBe(before + 1);
    srv.stop(true);
  });
});

describe("extractAttachments roots (owner 2026-10-19: sandboxed models attach only from their work dir)", () => {
  test("a path outside the given roots is refused; inside is attached", async () => {
    const { extractAttachments } = await import("../src/attach.ts");
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const h = mkdtempSync("/tmp/attroots-");
    mkdirSync(`${h}/work`); mkdirSync(`${h}/Documents`);
    writeFileSync(`${h}/work/ok.txt`, "x"); writeFileSync(`${h}/Documents/private.txt`, "y");
    const r = extractAttachments(`hi\n📎 attach: ${h}/work/ok.txt\n📎 attach: ${h}/Documents/private.txt`, h, 1024, [`${h}/work`]);
    expect(r.files.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(r.notes.join(" ")).toContain("private.txt");
  });
});
