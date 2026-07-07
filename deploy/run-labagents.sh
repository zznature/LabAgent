#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: deploy/run-labagents.sh <workspacePath>" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
LABAGENTS_REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
WORKSPACE_ROOT=$(CDPATH= cd -- "$1" && pwd -P)
PI_BIN="$LABAGENTS_REPO/node_modules/.bin/pi"
APPEND_SYSTEM_PROMPT="$LABAGENTS_REPO/src/prompts/APPEND_SYSTEM.md"

if [ ! -x "$PI_BIN" ]; then
  echo "Missing local pi binary: $PI_BIN" >&2
  echo "Run npm install --ignore-scripts in $LABAGENTS_REPO first." >&2
  exit 1
fi

if [ ! -f "$WORKSPACE_ROOT/.pi/settings.json" ]; then
  echo "Missing workspace settings: $WORKSPACE_ROOT/.pi/settings.json" >&2
  exit 1
fi

if [ ! -f "$WORKSPACE_ROOT/.pi/labagents-policy.json" ]; then
  echo "Missing workspace policy: $WORKSPACE_ROOT/.pi/labagents-policy.json" >&2
  exit 1
fi

cd "$WORKSPACE_ROOT"
exec "$PI_BIN" --append-system-prompt "$APPEND_SYSTEM_PROMPT"
