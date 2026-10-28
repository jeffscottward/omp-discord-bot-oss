import { describe, expect, test } from "bun:test";
import { classifyFailure, failureText, RetryLedger, shouldAutoRetry } from "../src/failcause.ts";

describe("classifyFailure (UX item 7)", () => {
  // Real error texts from the bridge session logs, 2026-10-12..22.
  const cases: [string, string, boolean][] = [
    ["Error: Refusal (cyber): This request triggered restrictions on violative cyber content", "refusal", false],
    ["402 Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits.", "credit", false],
    ["The socket connection was closed unexpectedly before the response completed", "provider", true],
    ["Deadline exceeded", "provider", true],
    ["529 overloaded_error", "provider", true],
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
  test("only quick transient failures, only once", () => {
    expect(shouldAutoRetry(provider, 5_000, false, 0)).toBe(true);
    expect(shouldAutoRetry(provider, 5_000, true, 0)).toBe(false);
    expect(shouldAutoRetry(provider, 10 * 60_000, false, 0)).toBe(false);
    expect(shouldAutoRetry(classifyFailure("Refusal (cyber)", 1), 1_000, false, 0)).toBe(false);
  });
  test("a run that already called a tool (or an unknown count) never retries by itself", () => {
    expect(shouldAutoRetry(provider, 5_000, false, 1)).toBe(false);
    expect(shouldAutoRetry(provider, 5_000, false, undefined)).toBe(false);
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
    const t = failureText(classifyFailure("socket hang up", 1), "x".repeat(1000) + "```", 20);
    expect(t.startsWith("❌ **Run failed.** 🌐")).toBe(true);
    expect(t).toContain("Retrying once by itself in 20 s");
    expect(t.split("```").length).toBe(3);
    expect(t.length).toBeLessThan(1000);
  });
  test("manual retry hint when no auto retry", () => {
    expect(failureText(classifyFailure("ENOSPC", 1), "")).toContain("Tap 🔁 Retry");
  });
});
