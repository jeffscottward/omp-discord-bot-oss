// Runs one real 🛠️-local-omp turn (live local-coder, real bwrap sandbox) and prints the final Discord text.
// Usage: bun scripts/local-omp-selftest.ts "<prompt>"   (uses a throwaway state dir; work dir ~/discord-scratch/local-omp)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKDIR, LocalOmpChat } from "../src/localomp.ts";

let last = "";
const chat = new LocalOmpChat({
  stateDir: mkdtempSync(join(tmpdir(), "local-omp-selftest-")),
  workDir: DEFAULT_WORKDIR,
  log: console.error,
  send: async (t) => { console.log(`[send] ${t}`); last = t; return { edit: async (e) => { last = e; } }; },
});
await chat.handle(process.argv[2] ?? "Say hello.");
console.log(`[final]\n${last}`);
