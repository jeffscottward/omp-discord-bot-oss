// Card webapp-tailnet-rotate (owner 2026-11-07): the tailnet DNS suffix is never hard-coded. It comes from
// TAILNET_SUFFIX or from ~/.config/tailnet/tailnet.env, which tailnet-sync writes from tailscaled, so a
// tailnet rename needs no code change.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** tailnet-sync writes the user file; as root it writes the /etc one. */
export const TAILNET_ENV_FILES = [join(homedir(), ".config", "tailnet", "tailnet.env"), "/etc/tailnet/tailnet.env"];
const SUFFIX_RE = /^[a-z0-9-]+\.ts\.net$/;

/** The tailnet DNS suffix (e.g. `tail1234.ts.net`), or "" when unset or malformed. */
export function tailnetSuffix(
  env: Record<string, string | undefined> = process.env,
  files: readonly string[] = TAILNET_ENV_FILES,
): string {
  let value = env.TAILNET_SUFFIX?.trim().toLowerCase() ?? "";
  for (const file of files) {
    if (value) break;
    try {
      value = /^TAILNET_SUFFIX=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim().toLowerCase() ?? "";
    } catch {
      value = "";
    }
  }
  return SUFFIX_RE.test(value) ? value : "";
}

/** `https://<host>.<suffix>`, or `fallback` when no suffix is known. */
export function tailnetUrl(host: string, fallback: string, suffix = tailnetSuffix()): string {
  return suffix ? `https://${host}.${suffix}` : fallback;
}
