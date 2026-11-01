import { expect, test } from "bun:test";
import { AskStore } from "./ask.ts";

test("answerIdsFor maps menu ids to the answer text the menus follow", () => {
  const s = new AskStore();
  const set = s.create("c1", [{ id: "q", question: "Q?", options: ["a", "b"] } as never]);
  s.recordAnswers(set.setId, ["111", "112"]);
  s.recordMessage(set.setId, 0, "200");
  expect(s.answerIdsFor(["200"]).sort()).toEqual(["111", "112"]);
  expect(s.answerIdsFor(["999"])).toEqual([]);
  s.close([set.setId]);
  expect(s.answerIdsFor(["200"]).sort()).toEqual(["111", "112"]);
});
