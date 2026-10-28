import { describe, expect, test } from "bun:test";
import { blindsArgs } from "../src/rigcmds.ts";

describe("/blinds button allow-list", () => {
  test("maps known actions", () => {
    expect(blindsArgs("open", "all")).toEqual(["open", "all"]);
    expect(blindsArgs("close", "Living room")).toEqual(["close", "Living room"]);
    expect(blindsArgs("set50", "all")).toEqual(["set", "all", "50"]);
    expect(blindsArgs("set100", "all")).toEqual(["set", "all", "100"]);
  });
  test("rejects anything else", () => {
    expect(blindsArgs("set101", "all")).toBeNull();
    expect(blindsArgs("rm", "all")).toBeNull();
    expect(blindsArgs("open", "x; rm -rf ~")).toBeNull();
    expect(blindsArgs("open", "--help")).toBeNull();
    expect(blindsArgs("open", "")).toBeNull();
  });
});
