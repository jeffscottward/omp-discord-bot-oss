/**
 * ▶️ Resume buttons (owner 2026-10-30, card discord-resume-buttons).
 * 1. The "🛑 Stopped." reply gets ▶️ Resume: it continues the SAME session with RESUME_TEXT (the original prompt is not resent).
 * 2. The ⏸️ pause notice gets ▶️ Resume: it calls maintAction(i, "resume", …) through the existing maint:resume button id.
 */
import { maintButton } from "./maintpause.ts";

export const RESUME_PREFIX = "resume:";
export const RESUME_TEXT = "Continue where you stopped.";

export type ResumeDecision<J> = { kind: "denied" } | { kind: "gone" } | { kind: "run"; job: J; text: string };

/** Decide what a ▶️ Resume tap on a Stopped reply does. Only the owner, only on the bot's own message. */
export function resumeDecision<J>(jobs: Map<string, J>, customId: string, userId: string, ownerId: string, onBotMessage: boolean): ResumeDecision<J> {
  if (userId !== ownerId || !onBotMessage) return { kind: "denied" };
  const job = jobs.get(customId.slice(RESUME_PREFIX.length));
  if (!job) return { kind: "gone" };
  return { kind: "run", job, text: RESUME_TEXT };
}

/** The pause notice text plus its ▶️ Resume button (same id as the master-board button, so the same maintAction path runs). */
export function pauseNotice(why: string): { content: string; button: { customId: string; label: string; emoji: string } } {
  return { content: `⏸️ Paused: ${why}. New jobs wait; running jobs finish. Tap ▶️ Resume or use /resume-work.`, button: maintButton(true) };
}
