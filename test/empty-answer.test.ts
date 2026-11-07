import { describe, expect, test } from "bun:test";
import { EMPTY_FALLBACK, emptyAnswerFallback, emptyAnswerPlan } from "../src/outbound.ts";
import { extractAsk } from "../src/ask.ts";

const askOnly = '```ask\n{"questions":[{"id":"a","question":"Pick?","options":[{"label":"A"},{"label":"✏️ Other (type or dictate a reply)"}]}]}\n```';

describe("card empty-answer-fix", () => {
  test("ask-only answer: no prose message, menu counts as posted, no fallback", () => {
    const ask = extractAsk(askOnly);
    expect(ask.questions?.length).toBe(1);
    const plan = emptyAnswerPlan({ prose: ask.text, files: 0, audio: false, links: 0 });
    expect(plan).toEqual({ blank: true, carrier: false });
    expect(emptyAnswerFallback(plan.blank, 1)).toBeUndefined();
  });
  test("ask-only answer dropped by no-reask: one real line instead of (empty answer)", () => {
    const plan = emptyAnswerPlan({ prose: extractAsk(askOnly).text, files: 0, audio: false, links: 0 });
    expect(emptyAnswerFallback(plan.blank, 0)).toBe(EMPTY_FALLBACK);
    expect(EMPTY_FALLBACK).not.toContain("empty answer");
  });
  test("empty answer with attachment: carrier message, no fallback", () => {
    const plan = emptyAnswerPlan({ prose: "  \n", files: 1, audio: false, links: 0 });
    expect(plan).toEqual({ blank: true, carrier: true });
    expect(emptyAnswerFallback(plan.blank, 1)).toBeUndefined();
  });
  test("normal prose is not blank", () => {
    expect(emptyAnswerPlan({ prose: "hi", files: 0, audio: false, links: 0 }).blank).toBe(false);
    expect(emptyAnswerFallback(false, 0)).toBeUndefined();
  });
});
