import { describe, expect, test } from "bun:test";
import { AskStore, type AskQuestion } from "./ask.ts";
import { findAnswered, isOpenAnswer, REASK_WINDOW_MS, type AnsweredQuestion } from "./reask.ts";

// Real case 2026-10-31: menu 100000000000000201 (answered "2. Allow deleting old CI artifacts") and the re-ask
// 100000000000000202 posted 2 h later by another session for another card.
const A = { question: `webapp-adx-filter (PR #80): the work is done and 3 of 4 CI lanes pass. The coverage lane fails only because GitHub Actions artifact storage quota is full ("Artifact storage quota has been hit"); its tests passed. This blocks every Webapp PR, not only this one. How should I proceed?`,
 options: ["Wait and rerun automatically", "Allow deleting old CI artifacts", "✏️ Other (type or dictate a reply)"],
 descriptions: ["A timer reruns the failed CI jobs every 3 h for 24 h and writes the done receipt when all 4 lanes pass. No deletion, no billing change.", "Delete webapp-research Actions artifacts older than 1 day (coverage blobs, Playwright reports) to free storage now, then rerun. Deletion on GitHub needs your OK.", ""]};
const B = { question: `Browser lane now PASSES on PR #81 (flake fix). But all 13 coverage shards fail: GitHub 'Artifact storage quota has been hit' (account-wide; Client Co hits it too). Tests themselves pass. Webapp holds 258 live artifacts, 1.21 GB (coverage blobs 0.90 GB, Playwright failure evidence 0.30 GB). GitHub recalculates usage every 6-12 h. How do we unblock?`,
 options: ["Delete finished-run CI artifacts now","Stop uploading coverage blobs on the main host","I raise the GitHub storage limit","Wait for the quota reset","✏️ Other (type or dictate a reply)"],
 descriptions: ["Delete coverage blobs of finished runs and old Playwright evidence in webapp-research (about 1.2 GB). Quota frees in 6-12 h. Low risk: blobs are only used inside their own run.","Shards hand blobs to the coverage lane through a main-local folder (all main runners share one host). No artifacts, faster shards. Keep artifacts only for the ubuntu-latest fallback. Own PR.","Billing change by you. No code change.","Do nothing; retry CI after GitHub recalculates.",""]};
const negs = [
 { question: "webapp-adx-filter (PR #80): lint lane fails because biome 2.3 changed a rule. Upgrade biome or pin the old version?", options: ["Upgrade biome and fix lint", "Pin biome 2.2", "✏️ Other (type or dictate a reply)"] },
 { question: "Which Discord category should the new finance stack channels use?", options: ["💹 finance", "🖥️ Main", "✏️ Other (type or dictate a reply)"] },
 { question: "webapp-adx-filter PR #80 is green. Merge it now or wait for a human review of the filter thresholds?", options: ["Merge now", "Wait for review", "✏️ Other (type or dictate a reply)"], descriptions:["Squash-merge to main after CI passes.","Hold the PR until you review the thresholds.",""] },
];

const earlier: AnsweredQuestion = { ...A, answer: ["Allow deleting old CI artifacts"], channelId: "100000000000000029", messageId: "100000000000000201", answeredAt: 1_000_000 };

describe("no re-ask of answered questions", () => {
  test("real case: the artifact-quota re-ask matches the answered menu", () => {
    const m = findAnswered(B, [earlier], 1_000_000 + 2 * 3_600_000);
    expect(m?.earlier.messageId).toBe("100000000000000201");
    expect(m?.earlier.answer).toEqual(["Allow deleting old CI artifacts"]);
  });
  test("negative: same card and CI, other topic (lint)", () => expect(findAnswered(negs[0]!, [earlier], 1_000_001)).toBeNull());
  test("negative: unrelated question", () => expect(findAnswered(negs[1]!, [earlier], 1_000_001)).toBeNull());
  test("negative: same PR, merge decision", () => expect(findAnswered(negs[2]!, [earlier], 1_000_001)).toBeNull());
  test("negative: answered by reply (no stored answer text)", () => expect(findAnswered(B, [{ ...earlier, answer: [] }], 1_000_001)).toBeNull());
  test("negative: answer older than 7 days", () => expect(findAnswered(B, [earlier], 1_000_000 + REASK_WINDOW_MS + 1)).toBeNull());
});

describe("AskStore keeps answered questions", () => {
  test("a set answered with the menu stays as answered, in any channel", () => {
    const s = new AskStore();
    const q: AskQuestion = { id: "q", question: A.question, options: A.options, descriptions: A.descriptions, multi: false };
    const set = s.create("chan-a", [q], 1000);
    s.recordMessage(set.setId, 0, "m1");
    expect(s.answer(AskStore.customId(set.setId, 0), ["1"], 2000)).not.toBe("unknown");
    const got = s.answeredQuestions(REASK_WINDOW_MS, 3000);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ channelId: "chan-a", messageId: "m1", answer: ["Allow deleting old CI artifacts"], answeredAt: 2000 });
    expect(findAnswered(B, got, 4000)?.earlier.messageId).toBe("m1");
    expect(s.lateKind(set.setId, 3000)?.kind).toBe("closed");
  });
  test("cancelled and unanswered sets are not answers", () => {
    const s = new AskStore();
    const q: AskQuestion = { id: "q", question: A.question, options: A.options, multi: false };
    s.create("c", [q], 1000);
    const c = s.create("c", [q], 1000);
    s.cancel(c.setId, 1500);
    expect(s.answeredQuestions(REASK_WINDOW_MS, 2000)).toHaveLength(0);
  });
});

describe("retest / unsure replies leave the question open (card reask-retest-defer)", () => {
  const open = [
    "Other: I said that I didn't hear any pauses, only music ... Maybe it's been restarted now. I have to test it again. I'm not sure",
    "Other: I have to test it again",
    "Other: need to test again",
    "Other: maybe it's been restarted",
    "Other: I'm not sure",
  ];
  for (const a of open) test(`open: ${a.slice(0, 50)}`, () => expect(isOpenAnswer([a])).toBe(true));
  for (const a of ["Other: Yes, I'm sure", "1", "Other: 1"]) test(`answer: ${a}`, () => expect(isOpenAnswer([a])).toBe(false));
});
