#!/usr/bin/env bun
// Create (or rotate) the FIRSTMATE Shortcut key and print the one-time setup link.
// The link shows the key once (12 h limit). Open it on the iPhone, through `tailscale serve`
// (see docs/SETUP.md, "iPhone Shortcuts"). The key itself is never printed here.
// Usage: bun scripts/shortcut-setup.ts <public base URL, e.g. https://<host>.<tailnet>.ts.net>
import { rotateKey, SHORTCUT_PORT } from "../src/shortcut.ts";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const nonce = rotateKey();
console.log("A new Shortcut key was written to ~/.config/omp-discord/shortcut-key (mode 600). Old keys stop working.");
console.log(`The Shortcut server listens on 127.0.0.1:${SHORTCUT_PORT}; expose it with: tailscale serve --bg --set-path /firstmate http://127.0.0.1:${SHORTCUT_PORT}/firstmate`);
console.log(base ? `One-time setup link: ${base}/firstmate/setup/${nonce}` : `One-time setup path: /firstmate/setup/${nonce} (add your public base URL in front)`);
