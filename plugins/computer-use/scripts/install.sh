#!/usr/bin/env bash
# Install / uninstall the computer-use plugin for Antigravity.
#
#   bash scripts/install.sh                       install for the current user
#   bash scripts/install.sh --workspace /path     install into a workspace
#   bash scripts/install.sh --dry-run             show what would happen
#   bash scripts/install.sh --force               overwrite an existing install
#   bash scripts/install.sh --uninstall           remove an installed copy
#   bash scripts/install.sh --use-plugin-data     keep ${PLUGIN_DATA} instead of pinning
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKSPACE=""
DRY_RUN=0
FORCE=0
UNINSTALL=0
USE_PLUGIN_DATA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --use-plugin-data) USE_PLUGIN_DATA=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then say "  [dry-run] $*"; else eval "$@"; fi
}

# --- locate a Python 3 interpreter -------------------------------------------
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
      PY="$candidate"; break
    fi
  fi
done
if [ -z "$PY" ]; then
  say "ERROR: no Python 3 interpreter found on PATH (python3 or python)."
  exit 1
fi
say "interpreter: $PY ($("$PY" -c 'import platform;print(platform.python_version())'))"

# --- validate the source plugin ---------------------------------------------
if [ ! -f "$PLUGIN_ROOT/plugin.json" ]; then
  say "ERROR: $PLUGIN_ROOT does not look like a plugin (no plugin.json)."
  exit 1
fi
NAME="$("$PY" - "$PLUGIN_ROOT/plugin.json" <<'PY'
import io, json, sys
print(json.load(io.open(sys.argv[1], encoding="utf-8"))["name"])
PY
)"
if [ "$NAME" != "computer-use" ]; then
  say "ERROR: plugin.json declares name '$NAME', expected 'computer-use'."
  exit 1
fi
say "plugin     : $NAME  (source: $PLUGIN_ROOT)"

# --- destination -------------------------------------------------------------
if [ -n "$WORKSPACE" ]; then
  DEST="$WORKSPACE/.agents/plugins/$NAME"
else
  DEST="$HOME/.gemini/config/plugins/$NAME"
fi
say "target     : $DEST"

if [ "$UNINSTALL" = "1" ]; then
  if [ ! -d "$DEST" ]; then
    say "nothing to uninstall at $DEST"
    exit 0
  fi
  if [ ! -f "$DEST/plugin.json" ]; then
    say "REFUSING: $DEST has no plugin.json; remove it by hand if you are sure."
    exit 1
  fi
  INSTALLED_NAME="$("$PY" - "$DEST/plugin.json" <<'PY'
import io, json, sys
print(json.load(io.open(sys.argv[1], encoding="utf-8"))["name"])
PY
)"
  if [ "$INSTALLED_NAME" != "computer-use" ]; then
    say "REFUSING: $DEST contains plugin '$INSTALLED_NAME', not 'computer-use'."
    exit 1
  fi
  run "rm -rf \"$DEST\""
  say "uninstalled. Policy files and audit logs were left in place:"
  say "  ~/.local/share/computer-use"
  exit 0
fi

if [ -d "$DEST" ] && [ "$FORCE" != "1" ]; then
  say "ERROR: $DEST already exists. Re-run with --force to overwrite it."
  exit 1
fi

# --- copy --------------------------------------------------------------------
run "mkdir -p \"$(dirname "$DEST")\""
if [ "$FORCE" = "1" ] && [ -d "$DEST" ]; then
  run "rm -rf \"$DEST\""
fi
if command -v rsync >/dev/null 2>&1; then
  run "rsync -a --exclude __pycache__ --exclude '*.pyc' \"$PLUGIN_ROOT/\" \"$DEST/\""
else
  run "cp -R \"$PLUGIN_ROOT\" \"$DEST\""
  run "find \"$DEST\" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true"
fi

# --- point the copy at this machine's interpreter ----------------------------
if [ "$DRY_RUN" = "1" ]; then
  # nothing was copied yet, so preview the rewrite against the source copy
  CONFIGURE_ARGS=(--plugin-dir "$PLUGIN_ROOT" --command "$PY" --dry-run)
else
  CONFIGURE_ARGS=(--plugin-dir "$DEST" --command "$PY")
fi
if [ "$USE_PLUGIN_DATA" = "1" ]; then
  CONFIGURE_ARGS+=(--use-plugin-data)
fi
"$PY" "$PLUGIN_ROOT/scripts/configure.py" "${CONFIGURE_ARGS[@]}"

# --- handshake check against the installed copy ------------------------------
if [ "$DRY_RUN" != "1" ]; then
  say ""
  say "handshake check:"
  HANDSHAKE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install","version":"1"}}}'
  if printf '%s\n' "$HANDSHAKE" | PYTHONDONTWRITEBYTECODE=1 timeout 30 "$PY" "$DEST/scripts/mcp_server.py" 2>/tmp/cu-install-err.$$ | head -n 1 | grep -q '"computer-use"'; then
    say "  OK: the installed server completed an MCP handshake."
  else
    say "  FAILED: no valid handshake. stderr:"
    sed 's/^/    /' /tmp/cu-install-err.$$ || true
    rm -f /tmp/cu-install-err.$$
    exit 1
  fi
  rm -f /tmp/cu-install-err.$$
fi

say ""
say "done. Next:"
say "  1. restart Antigravity (or reload plugins) so it picks up the new plugin"
say "  2. ask it to call computer-use_desktop_get_environment"
say "  3. review the policy at the data dir printed above before letting it click anything"
