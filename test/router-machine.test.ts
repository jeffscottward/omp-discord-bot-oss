import { expect, test } from "bun:test";
import { createActor, fromPromise, waitFor } from "xstate";
import { messageMachine, stackMachine } from "../docs/router/router.machine.ts";

const withJudge = (out: { stack: string; confidence: number } | null) => messageMachine.provide({ actors: { judge: fromPromise(async () => out) } });

test("state chart: keyword message → dispatch to its stack → queued → running → reported", () => {
  const a = createActor(withJudge(null), { input: {} }).start();
  a.send({ type: "OWNER_MESSAGE", text: "check the budget invoices" });
  expect(a.getSnapshot().value).toBe("queued");
  expect(a.getSnapshot().context.decision?.stack).toBe("finance");
  a.send({ type: "START" });
  a.send({ type: "DONE" });
  expect(a.getSnapshot().status).toBe("done");
  expect(a.getSnapshot().context.outcome).toBe("done");
});

test("state chart: ambiguous message → judge (confident) or fallback to FIRSTMATE; answers stay with FIRSTMATE", async () => {
  const j = createActor(withJudge({ stack: "personal", confidence: 0.9 }), { input: {} }).start();
  j.send({ type: "OWNER_MESSAGE", text: "book a table for saturday" });
  await waitFor(j, (s) => s.matches("queued"));
  expect(j.getSnapshot().context.decision).toMatchObject({ stack: "personal", by: "judge" });

  const low = createActor(withJudge({ stack: "personal", confidence: 0.3 }), { input: {} }).start();
  low.send({ type: "OWNER_MESSAGE", text: "hmm" });
  await waitFor(low, (s) => s.matches("queued"));
  expect(low.getSnapshot().context.decision).toMatchObject({ stack: "firstmate", by: "fallback" });

  const ans = createActor(withJudge(null), { input: {} }).start();
  ans.send({ type: "OWNER_MESSAGE", text: "option 2", answering: true });
  expect(ans.getSnapshot().context.decision?.stack).toBe("firstmate");
  ans.send({ type: "CANCEL" });
  expect(ans.getSnapshot().value).toBe("cancelled");
});

test("stack machine: serial queue, failure does not block the next job", () => {
  const s = createActor(stackMachine).start();
  s.send({ type: "ENQUEUE" });
  s.send({ type: "ENQUEUE" });
  s.send({ type: "SLOT" });
  expect(s.getSnapshot().value).toBe("busy");
  s.send({ type: "JOB_FAILED" });
  expect(s.getSnapshot().value).toBe("ready");
  s.send({ type: "SLOT" });
  s.send({ type: "JOB_DONE" });
  expect(s.getSnapshot().value).toBe("idle");
  expect(s.getSnapshot().context).toEqual({ waiting: 0, done: 1, failed: 1 });
});
