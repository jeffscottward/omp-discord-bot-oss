/**
 * Unique stack emojis (owner 2026-11-07, card stack-emoji-unique): "No emojis repeated in the stacks list. Never
 * reuse an emoji; all must be unique." A stack without an emoji (or with one another stack already uses) gets an
 * unused one picked from its name/keywords via a small curated map, then a fallback pool. Never a shared 🧩.
 */

const HINTS: [RegExp, string[]][] = [
  [/trad|market|stock|crypto|financ|money|invest/, ["💹", "💰", "📊", "🪙"]],
  [/secur|auth|vault|guard|privacy/, ["🔐", "🛡️", "🔒"]],
  [/bot|discord|chat/, ["🦾", "🤖", "💬"]],
  [/research|paper|study|science/, ["🔬", "🧪", "📑"]],
  [/dev|code|engineer|build|tool/, ["⌨️", "🛠️", "⚙️"]],
  [/factory|pipeline|automat/, ["🏭", "🔄"]],
  [/web|site|frontend|browser/, ["🌐", "🕸️"]],
  [/\b(ai|ml|model|llm|agent)\b/, ["🧠", "✨"]],
  [/game|play/, ["🎮", "🕹️"]],
  [/home|house|family/, ["🏠", "🏡"]],
  [/doc|write|blog|book|learn/, ["📚", "✍️", "📝"]],
  [/music|audio|sound|voice/, ["🎵", "🎙️"]],
  [/video|film|media|photo/, ["🎬", "📷"]],
  [/\b(health|fitness|med|medical)\b/, ["🩺", "💪"]],
  [/deploy|infra|server|cloud|ops/, ["☁️", "🚀"]],
  [/data|db|sql|analytic/, ["🗄️", "📈"]],
  [/mail|email|inbox/, ["📧", "📮"]],
  [/travel|trip/, ["✈️", "🧳"]],
  [/shop|store|commerce/, ["🛒", "🏪"]],
  [/legal|law|gov|polit/, ["⚖️", "🏛️"]],
];

const POOL = [
  "🦊", "🐙", "🦉", "🐝", "🦋", "🐢", "🦀", "🐬", "🦄", "🐳", "🦅", "🐺", "🦁", "🐼", "🐧", "🦜", "🐉", "🌵", "🌻", "🍀",
  "🌙", "⭐", "🔥", "🌊", "⚡", "❄️", "🌈", "🍄", "🪐", "☄️", "🎯", "🎲", "🧲", "🔭", "🧭", "🗺️", "⛵", "🚂", "🛸", "🎈",
  "🎨", "🧵", "🪁", "🏺", "💎", "🔮", "🪄", "🧊", "🍉", "🍋", "🍇", "🥥", "🌶️", "🥕", "🧁", "🍩", "☕", "🫖", "🎸", "🥁",
  "🎺", "🎻", "🏹", "⚓", "🛶", "🏔️", "🌋", "🏝️", "🌲", "🌴", "🪨", "🦔", "🦦", "🦩", "🐞", "🦂", "🐊", "🦓", "🦒", "🐘",
];

/** Emojis of the fixed Discord categories; never given to a stack. */
export const RESERVED = ["🔔", "🔊", "🖥️", "💻", "📦"];

/** Normalize for comparison (drop variation selectors so "🏛" and "🏛️" collide). */
export const emojiKey = (e: string) => e.replace(/\uFE0F/g, "").trim();

/** An emoji not in `used` (compared via emojiKey), preferring `wanted`, then name/keyword hints, then the pool. */
export function pickUniqueEmoji(s: { name: string; keywords?: string[]; emoji?: string }, used: Iterable<string>): string {
  // Fixed (non-stack) Discord categories use these: 🔔 Alerts, 🔊 Voice, 🖥️ Main, 💻 Second, 📦 Archive.
  const taken = new Set([...used, ...RESERVED].map(emojiKey));
  const free = (e: string) => !!e && emojiKey(e) !== "🧩" && !taken.has(emojiKey(e));
  if (s.emoji && free(s.emoji)) return s.emoji;
  const text = [s.name, ...(s.keywords ?? [])].join(" ").toLowerCase();
  for (const [re, list] of HINTS) if (re.test(text)) for (const e of list) if (free(e)) return e;
  for (const [, list] of HINTS) for (const e of list) if (free(e)) return e;
  for (const e of POOL) if (free(e)) return e;
  // Pool exhausted (100+ stacks): a numbered keycap combo is still unique.
  for (let n = 1; ; n++) { const e = `🔢${n}`; if (free(e)) return e; }
}

/** Give every stack a unique emoji in order: earlier stacks keep theirs; later duplicates/missing get a new one. */
export function uniqueEmojis<T extends { name: string; keywords?: string[]; emoji?: string }>(stacks: T[]): T[] {
  const used: string[] = [];
  return stacks.map((s) => {
    const emoji = pickUniqueEmoji(s, used);
    used.push(emoji);
    return emoji === s.emoji ? s : { ...s, emoji };
  });
}
