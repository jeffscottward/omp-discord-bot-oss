#!/usr/bin/env bash
# Owner 2026-10-26 (no-unknown-channel): every <#id> goes through channelMention() in src/mention.ts.
cd "$(dirname "$0")/.." || exit 2
hits=$(grep -rn '<#\${' src --include=*.ts | grep -v '^src/mention.ts:' | grep -v '\.test\.ts:')
if [ -n "$hits" ]; then echo "raw <#\${...}> mention outside channelMention():"; echo "$hits"; exit 1; fi
echo "mention check OK"
