// Owner rule 2026-10-13: never show a long raw URL. Bare URLs in prose become short masked links
// ("[x.com ↗](<url>)"), and markdown links whose label is itself a URL get a short label.
// Angle brackets also stop Discord's big link previews. Code (fenced or `inline`) is untouched.

const BARE = /(?<![(<\[])\bhttps?:\/\/[^\s<>()`]+[^\s<>()`.,;:!?'"*_)\]]/g;
const MD = /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g;

/** Short human label: host (no www) plus the last path part when short. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const tail = last && last.length <= 24 && !/^[0-9a-f-]{16,}$/i.test(last) && !/^\d{8,}$/.test(last) ? `/${last}` : "";
    return `${host}${tail} ↗`;
  } catch {
    return "link ↗";
  }
}

function shortenPlain(text: string): string {
  // Protect `inline code` spans.
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(MD, (_m, label: string, url: string) => `[${/^https?:\/\//.test(label.trim()) ? linkLabel(url) : label}](<${url}>)`)
            .replace(BARE, (url) => `[${linkLabel(url)}](<${url}>)`)
            // Owner 2026-10-22: a link label that already ends in ↗ followed by a hand-written ↗ showed two arrows.
            .replace(/(\[[^\]\n]*↗\]\(<[^>\s]+>\)) ?↗/g, "$1"),
    )
    .join("");
}

/** Apply to prose; fenced code blocks are left as they are. */
export function shortenLinks(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) out.push(inFence ? buf.join("\n") : shortenPlain(buf.join("\n")));
    buf = [];
  };
  for (const line of text.split("\n")) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      if (!inFence) { flush(); inFence = true; buf.push(line); }
      else { buf.push(line); flush(); inFence = false; }
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join("\n");
}

/**
 * Text for a masked link's label (owner 2026-10-15): Discord does not mask a link whose label contains a URL, so a
 * queue row starting with the owner's pasted URL opened that URL instead of the jump link. URLs become short host labels.
 */
/** Site name without a dot ("instagram.com" -> "Instagram"); "link" when the URL cannot be parsed. */
function siteName(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, "").split(".");
    const name = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : "link";
  } catch {
    return "link";
  }
}

/**
 * Text for a masked link label (queue-board rows). Discord does not render a masked link whose label
 * contains a URL or a domain-like word ("instagram.com/x", "go.fixnotes"): it shows the raw markdown and
 * links the domain instead of the jump link. So URLs become "🌐 Instagram link" and remaining a.b words
 * get a middle dot (go·fixnotes).
 */
export function maskedLabelText(text: string): string {
  return text
    .replace(/[[\]]/g, "")
    .replace(/\bhttps?:\/\/\S*/g, (u) => `🌐 ${siteName(u.replace(/…$/, ""))} link`)
    .replace(/\b([\w-]+)\.(?=[\w-])/g, "$1·");
}
