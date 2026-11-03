import { describe, expect, test } from "bun:test";
import { findAnswered, saysNew, type AnsweredQuestion } from "./reask.ts";

// Card reask-false-match-2 (2026-11-02): live case.
const earlier: AnsweredQuestion = {
  question: "New rule for Acme copies: cap the MAX LOSS per order at $10k?",
  options: ["Yes, $10k max loss per order", "Yes, but as % of account", "No, keep Acme size 1 = 10% of budget", "✏️ Other (type or dictate a reply)"],
  descriptions: [
    "Size = min(Acme size, $10k worst-case loss). For fixed bills that is the bill; for others the agreed cap.",
    "Max loss per order = ~2.8% of budget (≈$10k today), so it scales with the account.",
    "Leave the current rule.",
    "",
  ],
  answer: ["Other: Actually, let's change it to 1% of whatever my total portfolio is"],
  answeredAt: 1_000_000,
} as AnsweredQuestion;
const options = ["A. Full value counts as the loss", "B. Size as if it could drop 20%", "C. 1% cap for options/spreads only", "✏️ Other (type or dictate a reply)"];
const descriptions = [
  "Max ~$3,600 per order. Strict 1% cap; orders about 5x smaller than today.",
  "Up to ~$18k (same as today's JKL). No hold; Vendor emails decide exits. A drop beyond 20% loses more than 1%.",
  "Units stay at Acme size.",
  "",
];

describe("reask-false-match-2", () => {
  test("no-stop share sizing question is not the max-loss cap question", () => {
    const q = { question: "New Acme unit order with NO stop (like JKL): how big may it be under the 1% rule?", options, descriptions };
    expect(findAnswered(q, [earlier], 1_000_001)).toBeNull();
  });
  test("marked 'New question (not …)' is never blocked", () => {
    const question = "New question (not the 1% rule itself): a new Acme unit order with NO stop, like JKL. How big may it be under your 1% rule?";
    expect(saysNew(question)).toBe(true);
    expect(findAnswered({ question, options, descriptions }, [earlier], 1_000_001)).toBeNull();
  });
  test("the same question asked again still matches", () => {
    expect(findAnswered({ question: earlier.question, options: earlier.options, descriptions: earlier.descriptions }, [earlier], 1_000_001)).not.toBeNull();
  });
  test("credit menus sharing one label word are not repeats", () => {
    const a: AnsweredQuestion = { question: "webapp-adx-filter PR: all CI lanes pass and review is done. Merge the PR into main now or wait for the release branch?", options: ["Merge now", "Wait"], answer: ["Merge now"], answeredAt: 1_000_000 } as AnsweredQuestion;
    expect(findAnswered({ question: "webapp-adx-filter PR: all CI lanes pass but main moved. Merge the PR into main as is or rebase the branch first?", options: ["Merge", "Rebase"] }, [a], 1_000_001)).toBeNull();
    const b: AnsweredQuestion = { question: "Acme ABC copy is filled. Close the order before the month-end report or hold it through month-end?", options: ["Close", "Hold"], answer: ["Hold"], answeredAt: 1_000_000 } as AnsweredQuestion;
    expect(findAnswered({ question: "Acme ABC copy is filled. Close the order now or add a hold before the month-end report?", options: ["Close", "Add stop"] }, [b], 1_000_001)).toBeNull();
  });
  test("empty labels on one side only never match", () => {
    const a: AnsweredQuestion = { question: "webapp-adx-filter PR: all CI lanes pass and review is done. Merge the PR into main now?", options: ["Yes", "No"], answer: ["Yes"], answeredAt: 1_000_000 } as AnsweredQuestion;
    expect(findAnswered({ question: a.question, options: ["Yes, merge", "No"] }, [a], 1_000_001)).toBeNull();
  });
});
