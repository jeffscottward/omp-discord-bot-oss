import { expect, test } from "bun:test";
import { RESTARTABLE, SERVICES } from "../src/rigcmds.ts";

test("stream and status units exist; every /restart target is a known service", () => {
  expect(SERVICES.streamsrv).toBeDefined();
  expect(SERVICES.statusmon).toBeDefined();
  for (const r of RESTARTABLE) expect(SERVICES[r]).toBeDefined();
});
