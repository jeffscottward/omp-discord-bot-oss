/**
 * Discord (notably iOS) shows a masked link `[label](<url>)` as raw markdown when the label holds an emoji.
 * Owner 2026-10-23 (needsyou linkLabel) and again 2026-11-07 (msg 100000000000000057): a hard-coded
 * card-box-emoji Card link bypassed the per-label sanitizer. This is the send-boundary guard: every outgoing text
 * passes through it, so no emoji ever sits inside a masked-link label, whoever built the string.
 */
// Emoji-presentation characters (🧩) or text pictographs forced to emoji by U+FE0F (🗃️). Text arrows like ↗ are fine.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F}|[\u{1F1E6}-\u{1F1FF}]/u;
// One emoji sequence: emoji-presentation char or pictograph+FE0F (skin tone / keycap / ZWJ joins), or a flag pair.
const EMOJI_G = /(?:(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\u{FE0F})[\u{1F3FB}-\u{1F3FF}\u{20E3}]?(?:\u{200D}\p{Extended_Pictographic}\u{FE0F}?)*|[\u{1F1E6}-\u{1F1FF}]{2})/gu;
const MASKED = /\[([^[\]\n]*)\]\((<[^>\n]+>|[^)\s]+)\)/g;

/** Emoji inside masked-link labels move just before the link (card-box emoji + Card becomes emoji, then the plain link). */
export function fixMaskedLinks(text: string): string {
  return text.replace(MASKED, (all, label: string, url: string) => {
    if (!EMOJI.test(label)) return all;
    const emoji = (label.match(EMOJI_G) ?? []).join("");
    const plain = label.replace(EMOJI_G, "").replace(/\u{FE0F}/gu, "").replace(/\s+/g, " ").trim() || "link";
    return `${emoji ? `${emoji} ` : ""}[${plain}](${url})`;
  });
}

/** Labels that still hold an emoji (for tests / lint). */
export function badMaskedLabels(text: string): string[] {
  return [...text.matchAll(MASKED)].map((m) => m[1]!).filter((l) => EMOJI.test(l));
}
