// Card bot-reask-false-match (2026-11-02): live case. The answered question was the
// ABC credit line; two later questions about the DEF debit line were held back as "already answered". Both must post.
import { expect, test } from "bun:test";
import { findAnswered, identifiers, saysNew, type AnsweredQuestion } from "../src/reask.ts";

const ABC: AnsweredQuestion = {
  question: "DEF/ABC: add the missing credit ABC line to match Acme's 10-29 batch?",
  options: ["Yes, credit ABC to match Acme's size", "No, leave DEF debit only", "Close the DEF debit too", "✏️ Other (type or dictate a reply)"],
  answer: ["Yes, credit ABC to match Acme's size"],
  channelId: "100000000000000304",
  messageId: "100000000000000301",
  answeredAt: 1000,
};
const OPTS = ["Yes, add DEF to match Acme's batch size", "No, leave the ABC credit alone", "Move DEF units from DEF/GHI to this batch", "✏️ Other (type or dictate a reply)"];
const CTX = "⚓ card acme-def-abc-batch";

test("the DEF-line question (1st wording) is not matched to the ABC answer", () => {
  const q = { question: "DEF/ABC: ABC credit is on (-23). The DEF debit line for this batch is missing: all 82 DEF units belong to DEF/GHI. Add ~82 DEF to match Acme's batch?", options: OPTS };
  expect(findAnswered(q, [ABC], 2000, CTX)).toBeNull();
});

test("the DEF-line question (2nd wording, says it is new) is not matched", () => {
  const q = { question: "New question (not the ABC credit): add DEF units for the DEF/ABC batch debit line? Today all 82 DEF are booked to DEF/GHI, so the batch has no debit line.", options: OPTS };
  expect(saysNew(q.question)).toBe(true);
  expect(findAnswered(q, [ABC], 2000, CTX)).toBeNull();
});

test("the same ABC question again with other wording still matches", () => {
  const q = { question: "DEF/ABC: add the missing credit ABC line so we match Acme's 10-29 batch size?", options: ABC.options };
  expect(findAnswered(q, [ABC], 2000, CTX)?.earlier.messageId).toBe("100000000000000301");
});

test("identifiers ignore common caps words", () => {
  expect([...identifiers("DEF/GHI batch, PR #5 at 9 AM ET, USD 10%")].sort()).toEqual(["DEF", "GHI"]);
});

test("a repeat of a marked-new question still matches", () => {
  const first = { question: "New question (not the ABC credit): add DEF units for the DEF/ABC batch debit line? Today all 82 DEF are booked to DEF/GHI.", options: OPTS };
  const e: AnsweredQuestion = { ...first, answer: [OPTS[0]!], channelId: "c", messageId: "rsp1", answeredAt: 1000 };
  const again = { question: "New question (not the ABC credit): add DEF units for the DEF/ABC batch debit line? Today all 80 DEF are booked to DEF/GHI.", options: OPTS };
  expect(findAnswered(again, [e], 2000, CTX)?.earlier.messageId).toBe("rsp1");
});

test("ordinary wording is not a new-question marker; order words are not identifiers", () => {
  expect(saysNew("DEF/ABC: our ABC credit size is different from Acme's batch; add it?")).toBe(false);
  const q = { question: "DEF/ABC: add the missing credit ABC line via a rush order to match Acme's 10-29 batch?", options: ABC.options };
  expect(findAnswered(q, [ABC], 2000, CTX)?.earlier.messageId).toBe("100000000000000301");
});
