// Live check of the session commands on a COPY of a channel session (card omp-discord-commands-build).
// Usage: bun scripts/sessioncmds-live.ts <session folder to copy>
// Runs the real `omp --mode rpc` routes (/session info, /context, Shake, /compact, Export, /tools, /changelog,
// /resume list) against /tmp copies. Never touches the source folder.
import { cpSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCommands, type SessionCtx } from "../src/sessioncmds.ts";

const src = process.argv[2];
if (!src) throw new Error("usage: sessioncmds-live.ts <session folder>");
const dir = join(mkdtempSync(join(tmpdir(), "oc-live-")), "sess");
cpSync(src, dir, { recursive: true });
const ctx: SessionCtx = { key: `live-${Date.now()}`, dir, cwd: process.env.HOME!, channelId: "0", isolatedArgs: [] };
const cmds = new SessionCommands({
  ownerId: "0",
  ompBin: process.env.OMP_BIN ?? "omp",
  stateFile: join(dir, "..", "state.json"),
  overlayDir: join(dir, "..", "overlays"),
  resolve: () => ctx,
  busy: () => false,
  runTurn: async () => {},
  jobs: () => [],
  stopJob: () => "",
  sessionDirFor: (k) => join(dir, "..", k),
  log: (s) => console.error(s),
});
// Private methods are exercised directly here (test seam; the shapes match src/sessioncmds.ts).
const x = cmds as unknown as { readOnlySlash(c: SessionCtx, slash: string): Promise<string>; compact(c: SessionCtx, focus?: string): Promise<string>; treeText(c: SessionCtx): Promise<string>; branchView(c: SessionCtx): Promise<{ components: unknown[] }> };
const size = () => readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => statSync(join(dir, f)).size).join(",");
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t = Date.now();
  try {
    const r = await fn();
    const text = typeof r === "string" ? r : JSON.stringify(r);
    console.log(`✅ ${name} (${Date.now() - t} ms): ${text.replace(/\s+/g, " ").slice(0, 220)}`);
  } catch (e) {
    console.log(`❌ ${name}: ${(e as Error).message.slice(0, 300)}`);
  }
};
await step("session info", async () => (await cmds.sessionView(ctx)).embeds[0]!.toJSON().fields?.map((f) => `${f.name}=${f.value}`).join(" | "));
await step("resume list", async () => cmds.resumeView(ctx).components.length + " menu row(s)");
await step("context", async () => (await cmds.contextView(ctx)).content);
await step("tools", () => x.readOnlySlash(ctx, "/tools"));
await step("changelog", async () => String(await x.readOnlySlash(ctx, "/changelog")).slice(0, 120));
await step("mcp list", async () => String(await x.readOnlySlash(ctx, "/mcp list")).slice(0, 160));
await step("todo", async () => JSON.stringify(cmds.todoView(ctx)).slice(0, 160));
await step("mode view", async () => cmds.modeView(ctx).embeds[0]!.toJSON().fields?.map((f) => `${f.name}=${f.value}`).join(" | "));
await step("tree", async () => String(await x.treeText(ctx)).slice(0, 200));
await step("branch list", async () => JSON.stringify((await x.branchView(ctx)).components).slice(0, 200));
await step("modelpreset", async () => String(await x.readOnlySlash(ctx, "/modelpreset")).slice(0, 120));
await step("memory view", async () => String(await x.readOnlySlash(ctx, "/memory view")).slice(0, 120));
console.log(`jsonl bytes before compact: ${size()}`);
await step("compact", () => x.compact(ctx));
console.log(`jsonl bytes after compact: ${size()}`);
await step("context after compact", async () => (await cmds.contextView(ctx)).content.split("\n")[0]);
console.log(`copy: ${dir}`);
process.exit(0);
