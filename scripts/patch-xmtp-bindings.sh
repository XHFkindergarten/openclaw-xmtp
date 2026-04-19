#!/bin/sh
# Workaround: @xmtp/node-bindings was compiled in a Nix environment,
# causing the .node binary to hardcode a Nix store path for libiconv.
# This patches it to use the Homebrew libiconv instead.
# Remove this script once upstream fixes their CI build.

set -e

NIX_PATH="/nix/store/7h6icyvqv6lqd0bcx41c8h3615rjcqb2-libiconv-109.100.2/lib/libiconv.2.dylib"
BREW_LIBICONV="/opt/homebrew/opt/libiconv/lib/libiconv.2.dylib"

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

if [ ! -f "$BREW_LIBICONV" ]; then
  echo "Warning: libiconv not found at $BREW_LIBICONV. Run: brew install libiconv"
  exit 0
fi

patch_node_file() {
  NODE_FILE="$1"
  if [ ! -f "$NODE_FILE" ]; then
    return
  fi
  if otool -L "$NODE_FILE" 2>/dev/null | grep -q "$NIX_PATH"; then
    install_name_tool -change "$NIX_PATH" "$BREW_LIBICONV" "$NODE_FILE" 2>/dev/null && \
      echo "Patched: $NODE_FILE"
  fi
  # Re-sign after any modification (install_name_tool invalidates code signature,
  # and macOS will SIGKILL the process when loading an unsigned .node binary)
  codesign --sign - --force "$NODE_FILE" 2>/dev/null && \
    echo "Signed:  $NODE_FILE"
}

find node_modules -name "bindings_node.darwin-arm64.node" 2>/dev/null | while read f; do
  patch_node_file "$f"
done
