import { expect, test } from "bun:test";
import { channelTitle } from "../src/mirror.ts";

test("channel display name drops machine/workspace prefix (owner 2026-10-24)", () => {
  expect(channelTitle("main-github-firstmate", "main", "firstmate")).toBe("👷‍♂️-firstmate");
  expect(channelTitle("main-apps-demo-plugin", "main", "demo-plugin")).toBe("🎮-demo-plugin");
  expect(channelTitle("main-github-x", "main")).toBe("🤖-main-github-x");
});
