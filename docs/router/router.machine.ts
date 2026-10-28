/**
 * XState v5 state chart of the FIRSTMATE fan-out router (card fm-router). Documentation that runs: the guards use
 * the real route rules (src/router.ts), and test/router-machine.test.ts drives it with sample messages.
 * Rendered to docs/router/router-chart.svg by scripts/render-router-chart.ts.
 *
 * One owner message:  idle → routing (rules → judge → fallback) → dispatch (stack thread) | general (FIRSTMATE)
 *                     → queued → running → reported (✅/❌) | cancelled (🛑)
 * One stack:          a serial queue (one job at a time); stacks run in parallel up to maxParallelStacks.
 */
import { assign, fromPromise, setup } from "xstate";
import { DEFAULT_ROUTER, GENERAL, ruleRoute, type RouteDecision, type RouterConfig } from "../../src/router.ts";

export type MessageContext = { text: string; cfg: RouterConfig; decision: RouteDecision | null; candidates: string[]; outcome?: "done" | "failed" };
export type MessageEvent =
  | { type: "OWNER_MESSAGE"; text: string; answering?: boolean; inherited?: string }
  | { type: "START" }
  | { type: "DONE" }
  | { type: "FAIL" }
  | { type: "CANCEL" };

export const messageMachine = setup({
  types: { context: {} as MessageContext, events: {} as MessageEvent, input: {} as { cfg?: RouterConfig } },
  actors: {
    /** The JEV judge (OpenRouter decisions API). Tests provide a stub. */
    judge: fromPromise<{ stack: string; confidence: number } | null, { text: string }>(async () => null),
  },
  guards: {
    answersFirstmate: ({ event }) => event.type === "OWNER_MESSAGE" && Boolean(event.answering) && !event.inherited,
    ruleMatched: ({ context }) => context.decision !== null,
    toGeneral: ({ context }) => context.decision?.stack === GENERAL,
    confident: ({ context, event }) => {
      const out = (event as unknown as { output?: { stack: string; confidence: number } | null }).output;
      return Boolean(out && out.confidence >= context.cfg.judgeMinConfidence && context.cfg.stacks.some((s) => s.name === out.stack));
    },
  },
  delays: { judgeTimeout: ({ context }) => context.cfg.judgeTimeoutMs },
}).createMachine({
  id: "fmRouterMessage",
  context: ({ input }) => ({ text: "", cfg: input?.cfg ?? DEFAULT_ROUTER, decision: null, candidates: [] }),
  initial: "idle",
  states: {
    idle: {
      on: {
        OWNER_MESSAGE: [
          // A reply or menu answer to FIRSTMATE's own message stays with FIRSTMATE.
          { guard: "answersFirstmate", target: "general", actions: assign({ text: ({ event }) => event.text, decision: { stack: GENERAL, by: "inherit", confidence: 1, detail: "answers FIRSTMATE" } }) },
          {
            target: "routing",
            actions: assign(({ event, context }) => {
              const r = ruleRoute(event.text, { inherited: event.inherited }, context.cfg);
              return { text: event.text, decision: r.decision, candidates: r.candidates };
            }),
          },
        ],
      },
    },
    routing: {
      initial: "rules",
      states: {
        /** forced prefix → inherited → channel → card area → keywords */
        rules: { always: [{ guard: "ruleMatched", target: "#fmRouterMessage.decided" }, { target: "judge" }] },
        judge: {
          invoke: {
            src: "judge",
            input: ({ context }) => ({ text: context.text }),
            onDone: [
              {
                guard: "confident",
                target: "#fmRouterMessage.decided",
                actions: assign({ decision: ({ event }) => ({ stack: event.output!.stack, by: "judge" as const, confidence: event.output!.confidence, detail: "judge" }) }),
              },
              { target: "fallback" },
            ],
            onError: { target: "fallback" },
          },
          after: { judgeTimeout: { target: "fallback" } },
        },
        fallback: {
          entry: assign({ decision: ({ context }) => ({ stack: context.cfg.fallback, by: "fallback" as const, confidence: 0, detail: "no confident route" }) }),
          always: { target: "#fmRouterMessage.decided" },
        },
      },
    },
    decided: { always: [{ guard: "toGeneral", target: "general" }, { target: "dispatch" }] },
    /** Router note under the owner's message, copy into the stack's thread. */
    dispatch: { always: { target: "queued" } },
    /** FIRSTMATE's own session (the mirrored pane's side session). */
    general: { always: { target: "queued" } },
    /** Waits for its stack (serial) and a free parallel slot. */
    queued: { on: { START: "running", CANCEL: "cancelled" } },
    running: { on: { DONE: { target: "reported", actions: assign({ outcome: "done" }) }, FAIL: { target: "reported", actions: assign({ outcome: "failed" }) }, CANCEL: "cancelled" } },
    /** Report up: router note ✅/❌, FIRSTMATE board, stacks.json, /health. */
    reported: { type: "final" },
    cancelled: { type: "final" },
  },
});

/** One stack: a serial queue. `busy` holds one job; more jobs wait in `waiting`. */
export const stackMachine = setup({
  types: { context: {} as { waiting: number; done: number; failed: number }, events: {} as { type: "ENQUEUE" } | { type: "SLOT" } | { type: "JOB_DONE" } | { type: "JOB_FAILED" } },
  guards: { hasWaiting: ({ context }) => context.waiting > 0 },
}).createMachine({
  id: "stack",
  context: { waiting: 0, done: 0, failed: 0 },
  initial: "idle",
  states: {
    idle: { on: { ENQUEUE: { target: "ready", actions: assign({ waiting: ({ context }) => context.waiting + 1 }) } } },
    /** Has work; waits for a free parallel slot (maxParallelStacks). */
    ready: { on: { ENQUEUE: { actions: assign({ waiting: ({ context }) => context.waiting + 1 }) }, SLOT: { target: "busy", actions: assign({ waiting: ({ context }) => context.waiting - 1 }) } } },
    busy: {
      on: {
        ENQUEUE: { actions: assign({ waiting: ({ context }) => context.waiting + 1 }) },
        JOB_DONE: [{ guard: "hasWaiting", target: "ready", actions: assign({ done: ({ context }) => context.done + 1 }) }, { target: "idle", actions: assign({ done: ({ context }) => context.done + 1 }) }],
        // Failure isolation: a failed job ends; the next job of this stack still runs.
        JOB_FAILED: [{ guard: "hasWaiting", target: "ready", actions: assign({ failed: ({ context }) => context.failed + 1 }) }, { target: "idle", actions: assign({ failed: ({ context }) => context.failed + 1 }) }],
      },
    },
  },
});
