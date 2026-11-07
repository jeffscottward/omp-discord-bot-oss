/**
 * Owner 2026-10-26 (card no-unknown-channel): a board must never show "#unknown". Discord shows "#unknown" for a
 * `<#id>` mention of a channel or thread that is deleted or that the viewer cannot see. Every `<#id>` on a board or
 * bot message goes through `channelMention()`. It emits the mention only when the registered check confirms the id;
 * otherwise it returns a plain-text fallback. `scripts/check-mentions.sh` refuses raw `<#${` elsewhere in src/.
 */
export type MentionCheck = (id: string) => boolean;

let check: MentionCheck | null = null;

/** main.ts registers the live check (guild channel/thread cache). Tests register their own. */
export function setMentionCheck(fn: MentionCheck | null): void {
  check = fn;
}

/** Bad ids: empty, non-id words, or text that would break the mention markup. Discord ids are digits. */
const BAD_ID = /^(|unknown|undefined|null|none)$|[\s<>#@]/i;

/**
 * `<#id>` when the id is a valid snowflake and (with a registered check) a known, visible channel or thread.
 * Otherwise the fallback text (default "a closed channel"). Never returns a mention for an empty or bad id. With a live check registered, only confirmed ids link.
 */
export function channelMention(id: string | null | undefined, fallback = "a closed channel"): string {
  const v = String(id ?? "").trim();
  if (BAD_ID.test(v)) return fallback;
  if (check && !check(v)) return fallback;
  return `<#${v}>`;
}

/** True when the text holds a mention that the registered check does not confirm (used by the live check). */
export function unresolvedMentions(text: string): string[] {
  const ids = [...text.matchAll(/<#(\d+)>/g)].map((m) => m[1]!);
  return check ? ids.filter((id) => !check!(id)) : [];
}

/**
 * Owner 2026-10-26: a cached channel is linkable only when it is not deleted and, for a thread, not archived.
 * Verified 2026-10-26: the finance stack thread (and 4 other stack threads) existed but were archived (1 h
 * auto-archive) when the board showed "#unknown"; Discord clients render archived-thread mentions as "#unknown".
 */
export function mentionable(ch: { deleted?: boolean; isThread?: () => boolean; archived?: boolean | null } | null | undefined): boolean {
  if (!ch || ch.deleted) return false;
  if (typeof ch.isThread === "function" && ch.isThread() && ch.archived) return false;
  return true;
}

const PLACEHOLDER = /^(card|job|untitled|unknown|item|task|null|undefined|-|…)?$/i;
/** Row title guard: never a bare placeholder such as "card" or "". Falls back to the id/label given. */
export function safeTitle(title: string | null | undefined, ...fallbacks: (string | null | undefined)[]): string {
  const t = String(title ?? "").trim();
  if (!PLACEHOLDER.test(t)) return t;
  for (const f of fallbacks) {
    const s = String(f ?? "").trim();
    if (!PLACEHOLDER.test(s)) return s;
  }
  return "untitled job (no title recorded)";
}
