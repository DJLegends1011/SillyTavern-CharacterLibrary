#!/bin/sh
# Installs (or updates) the cl-helper SillyTavern plugin: copies extras/cl-helper
# into <SillyTavern>/plugins and enables server plugins in config.yaml.
# Safe to re-run; running it again updates the installed copy.
#
# Usage (no chmod needed):  bash install-cl-helper.sh
# Works on Linux, macOS, and Termux. Windows users: follow the manual steps in the README.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/cl-helper"

fail() {
    echo ""
    echo "ERROR: $1"
    exit 1
}

[ -f "$SRC/index.js" ] || fail "cl-helper source not found next to this script (expected $SRC)"

# The extension normally lives at <SillyTavern>/data/<user>/extensions/SillyTavern-CharacterLibrary,
# which puts the SillyTavern root five directories above extras/. Verify before trusting it.
ST_ROOT=""
CANDIDATE="$(cd "$SCRIPT_DIR/../../../../.." 2>/dev/null && pwd || echo "")"
if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/server.js" ]; then
    ST_ROOT="$CANDIDATE"
elif [ -f "$HOME/SillyTavern/server.js" ]; then
    ST_ROOT="$HOME/SillyTavern"
else
    fail "could not find your SillyTavern folder (looked at '$CANDIDATE' and '$HOME/SillyTavern').
Manual route: copy extras/cl-helper into <your SillyTavern>/plugins/ and set
enableServerPlugins: true in config.yaml, then restart SillyTavern."
fi

CFG="$ST_ROOT/config.yaml"
[ -f "$CFG" ] || fail "no config.yaml in $ST_ROOT. Start SillyTavern once (it creates the file), then run this again."

echo "SillyTavern found at: $ST_ROOT"

DEST="$ST_ROOT/plugins/cl-helper"

# A symlinked cl-helper is a developer setup; leave it alone.
[ -L "$DEST" ] && fail "$DEST is a symlink (developer install); not touching it."

mkdir -p "$ST_ROOT/plugins"
case "$DEST" in
    */plugins/cl-helper) rm -rf "$DEST" ;;
    *) fail "unexpected destination path: $DEST" ;;
esac
cp -r "$SRC" "$DEST"
echo "cl-helper copied to: $DEST"

# Enable server plugins, idempotently. sed -i differs between GNU/BSD, so write via a temp file.
if grep -Eq '^[[:space:]]*enableServerPlugins:[[:space:]]*true' "$CFG"; then
    echo "server plugins already enabled in config.yaml"
elif grep -Eq '^[[:space:]]*enableServerPlugins:' "$CFG"; then
    TMP="$CFG.clhelper.tmp"
    sed 's/^\([[:space:]]*enableServerPlugins:\).*/\1 true/' "$CFG" > "$TMP"
    mv "$TMP" "$CFG"
    echo "enabled server plugins in config.yaml"
else
    printf '\nenableServerPlugins: true\n' >> "$CFG"
    echo "added enableServerPlugins: true to config.yaml"
fi

echo ""
echo "Done. Now RESTART SillyTavern (stop it, e.g. Ctrl+C in its terminal, then start it again)."
echo "After the restart, reload the Character Library tab: Settings > Info should show cl-helper running."
