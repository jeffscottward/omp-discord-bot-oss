import { describe, expect, test } from "bun:test";
import { classifyFailure, failureText, HEAL_RETRY_DELAYS_MS, RetryLedger, shouldAutoRetry } from "../src/failcause.ts";

describe("classifyFailure (UX item 7)", () => {
  // Real error texts from the bridge session logs, 2026-10-12..22.
  const cases: [string, string, boolean][] = [
    ["Error: Refusal (cyber): This request triggered restrictions on violative cyber content", "refusal", false],
    ["402 Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits.", "credit", false],
    ["The socket connection was closed unexpectedly before the response completed", "provider", true],
    ["Deadline exceeded", "provider", true],
    ["529 overloaded_error", "rate-limit", true],
    ["Error: ENOSPC: no space left on device, write", "disk-full", false],
    ["SQLITE_BUSY: database is locked", "session-busy", true],
    ["You have hit your usage limit. Your limit resets at 5pm", "usage-limit", false],
    ["401 authentication_error: invalid x-api-key", "auth", false],
    ["spawn error: ENOENT", "start", false],
    ["TypeError: x is not a function\n    at foo (bar.ts:1:1)", "unknown", false],
  ];
  for (const [out, kind, transient] of cases) {
    test(`${kind}: ${out.slice(0, 40)}`, () => {
      const c = classifyFailure(out, 1);
      expect(c.kind).toBe(kind as never);
      expect(c.transient).toBe(transient);
    });
  }

  test("status codes count only as an error line, not inside other text", () => {
    expect(classifyFailure("Error: 503 Service Unavailable", 1).kind).toBe("provider");
    expect(classifyFailure("API error status: 500", 1).kind).toBe("provider");
    expect(classifyFailure("processed 500 rows; 401 left; file ENOENT in tool output", 1).kind).toBe("unknown");
    expect(classifyFailure("spawn /usr/bin/omp ENOENT", 1).kind).toBe("start");
  });

  test("a 429 for a plan limit counts as a plan limit, not a transient error", () => {
    expect(classifyFailure("429 rate_limit_error: usage limit reached", 1).kind).toBe("usage-limit");
  });
});

describe("auto retry", () => {
  const provider = classifyFailure("socket hang up", 1);
  test("transient and unknown failures heal: two tries per message, slow or after tool calls too (owner 2026-11-07)", () => {
    expect(autoRetryDelay(provider, 5_000, 0, 0)).toBe(HEAL_RETRY_DELAYS_MS[0]);
    expect(autoRetryDelay(provider, 10 * 60_000, 1, 3)).toBe(HEAL_RETRY_DELAYS_MS[1]);
    expect(autoRetryDelay(provider, 5_000, 2, 0)).toBeUndefined();
    expect(autoRetryDelay(classifyFailure("weird crash", 1), 5_000, 0, undefined)).toBe(HEAL_RETRY_DELAYS_MS[0]);
    expect(shouldAutoRetry(provider, 5_000, true, 0)).toBe(true);
  });
  test("causes that need an owner fix never retry by themselves", () => {
    for (const t of ["Refusal (cyber)", "402 insufficient balance", "401 unauthorized", "ENOSPC", "spawn omp ENOENT"]) expect(autoRetryDelay(classifyFailure(t, 1), 1_000, 0, 0)).toBeUndefined();
  });
  test("ledger remembers ids and stays bounded", () => {
    const l = new RetryLedger(2);
    l.add("a");
    l.add("b");
    l.add("c");
    expect(l.has("a")).toBe(false);
    expect(l.has("c")).toBe(true);
  });
});

describe("failureText", () => {
  test("cause first, short output in a code block, no raw fence break", () => {
    const t = failureText(classifyFailure("socket hang up", 1), "x".repeat(1000) + "```", 20_000);
    expect(t.startsWith("❌ **Run failed.** 🌐")).toBe(true);
    expect(t).toContain("Cooling down: retrying by itself in 20 s");
    expect(t.split("```").length).toBe(3);
    expect(t.length).toBeLessThan(1000);
  });
  test("manual retry hint when no auto retry", () => {
    expect(failureText(classifyFailure("ENOSPC", 1), "")).toContain("Tap 🔁 Force retry");
  });
});

import { autoRetryDelay, RATE_RETRY_DELAYS_MS, RetryLedger as Ledger2, classifyFailure as cf2 } from "../src/failcause.ts";
import { test as t2, expect as e2 } from "bun:test";
t2("rate errors retry after a growing cool-down, also after tool calls", () => {
  const c = cf2("Error: 429 Too Many Requests", 1);
  e2(c.kind).toBe("rate-limit");
  e2(autoRetryDelay(c, 600_000, 0, 5)).toBe(RATE_RETRY_DELAYS_MS[0]);
  e2(autoRetryDelay(c, 0, 2, 0)).toBe(RATE_RETRY_DELAYS_MS[2]);
  e2(autoRetryDelay(c, 0, RATE_RETRY_DELAYS_MS.length, 0)).toBeUndefined();
  const l = new Ledger2(); l.add("m"); l.add("m"); e2(l.count("m")).toBe(2);
});
