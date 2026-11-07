import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailnetSuffix, tailnetUrl } from "../src/tailnet.ts";

const dir = mkdtempSync(join(tmpdir(), "tailnet-"));
const file = join(dir, "tailnet.env");
writeFileSync(file, "# generated\nTAILNET_SUFFIX=tail000000.ts.net\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("suffix comes from TAILNET_SUFFIX first, then the tailnet-sync env file", () => {
  expect(tailnetSuffix({ TAILNET_SUFFIX: "Tail111111.ts.net" }, [file])).toBe("tail111111.ts.net");
  expect(tailnetSuffix({}, [file])).toBe("tail000000.ts.net");
  // The user file wins; the root (/etc) file is the fallback.
  expect(tailnetSuffix({}, [join(dir, "absent.env"), file])).toBe("tail000000.ts.net");
});

test("missing or malformed suffix gives the fallback, never a half-built host", () => {
  expect(tailnetSuffix({}, [join(dir, "absent.env")])).toBe("");
  for (const bad of ["evil.example", "tail1.ts.net.evil.example", "a b.ts.net", "https://x.ts.net"]) {
    expect(tailnetSuffix({ TAILNET_SUFFIX: bad }, [file])).toBe("");
  }
  expect(tailnetUrl("main-host", "http://127.0.0.1:8791", "")).toBe("http://127.0.0.1:8791");
  expect(tailnetUrl("main-host", "http://127.0.0.1:8791", "tail000000.ts.net")).toBe("https://main-host.tail000000.ts.net");
});
