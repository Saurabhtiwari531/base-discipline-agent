#!/usr/bin/env bash
# @xmtp/node-bindings@1.10.0 ships macOS binaries built on nix CI that
# dynamically link /nix/store/...libiconv.2.dylib — a path that only exists on
# the build machine. Repoint them at the macOS system libiconv and re-sign.
# Runs from npm postinstall; no-op on Linux (Docker deploys are unaffected).
set -euo pipefail
[ "$(uname)" = "Darwin" ] || exit 0
cd "$(dirname "$0")/.."

patched=0
while IFS= read -r f; do
  dep=$(otool -L "$f" | awk '/\/nix\/store\/.*libiconv/ {print $1}' | head -1)
  if [ -n "$dep" ]; then
    install_name_tool -change "$dep" /usr/lib/libiconv.2.dylib "$f"
    codesign -f -s - "$f" 2>/dev/null || true
    echo "[fix-xmtp-darwin] patched: $f"
    patched=$((patched + 1))
  fi
done < <(find node_modules -name "bindings_node.darwin-*.node" 2>/dev/null)

echo "[fix-xmtp-darwin] done ($patched patched)"
