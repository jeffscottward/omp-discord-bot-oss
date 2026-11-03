// Card reask-false-match (2026-11-01): a NEW question on the same topic must post; only the same question with
// the same answer set is held back. Texts are the live case from the owner channel.
import { expect, test } from "bun:test";
import { findAnswered, type AnsweredQuestion } from "../src/reask.ts";

const OLD: AnsweredQuestion = {
  question: "Webapp Autopilot (#65, merged b1ddf2b5): turn on the 1-minute tick timer after the web deploy is live?",
  options: ["Enable after deploy + 1 manual tick check", "Keep OFF for now", "✏️ Other (type or dictate a reply)"],
  answer: ["Enable after deploy + 1 manual tick check"],
  channelId: "100000000000000308",
  messageId: "100000000000000309",
  answeredAt: 1000,
};

const NEW = {
  question: "Webapp Autopilot key: how should it be created?",
  options: ["Session creates it on the server", "I'll create it in the Webapp web page", "Keep Autopilot timer off", "✏️ Other (type or dictate a reply)"],
  descriptions: [
    "No clicks for you; a write-scoped key named autopilot-tick, used only by the timer, recorded on the card.",
    "Follow the 3 steps above and use the 🔐 form.",
    "Ticks only run by hand for now.",
    "",
  ],
};

test("a new question that only shares topic words is posted", () => {
  expect(findAnswered(NEW, [OLD], 2000)).toBeNull();
});

test("the same question again with other wording is still held back", () => {
  const again = { question: "Webapp Autopilot (#65): turn on the 1-minute tick timer after the web deploy is live?", options: OLD.options };
  expect(findAnswered(again, [OLD], 2000)?.earlier.messageId).toBe("100000000000000309");
});
