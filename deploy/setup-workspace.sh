#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: deploy/setup-workspace.sh <workspacePath>" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
LABAGENTS_REPO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
TEMPLATE_ROOT="$LABAGENTS_REPO/deploy/templates/lab-workspace"
WORKSPACE_ROOT=$(
  mkdir -p "$1"
  CDPATH= cd -- "$1" && pwd -P
)
PI_REPO=${PI_REPO:-$(CDPATH= cd -- "$LABAGENTS_REPO/../pi" 2>/dev/null && pwd -P || printf "%s" "$LABAGENTS_REPO/../pi")}

mkdir -p "$WORKSPACE_ROOT/.pi"
mkdir -p "$WORKSPACE_ROOT/lab-config"
mkdir -p "$WORKSPACE_ROOT/lab-config/templates"
mkdir -p "$WORKSPACE_ROOT/lab-records"

render_template() {
  src=$1
  dst=$2
  sed \
    -e "s|{{LABAGENTS_REPO}}|$LABAGENTS_REPO|g" \
    -e "s|{{WORKSPACE_ROOT}}|$WORKSPACE_ROOT|g" \
    -e "s|{{PI_REPO}}|$PI_REPO|g" \
    "$src" > "$dst"
}

render_template "$TEMPLATE_ROOT/.pi/settings.json.template" "$WORKSPACE_ROOT/.pi/settings.json"
render_template "$TEMPLATE_ROOT/.pi/labagents-policy.json.template" "$WORKSPACE_ROOT/.pi/labagents-policy.json"
render_template "$TEMPLATE_ROOT/lab-config/raman-runtime.lab.json.template" "$WORKSPACE_ROOT/lab-config/raman-runtime.lab.json"

# Dev mode: disable the guardrail extension for this workspace. Used when the
# workspace is nested inside the product repo (e.g. ./RamanLabWorkspace), where
# the default protectedRoot (the repo itself) would otherwise block all
# workspace access. The policy file is still rendered so run-labagents.sh's
# presence check passes; it is simply unused without the guardrail extension.
if [ "${LABAGENTS_DEV:-0}" = "1" ]; then
  grep -v "guardrail" "$WORKSPACE_ROOT/.pi/settings.json" > "$WORKSPACE_ROOT/.pi/settings.json.tmp"
  mv "$WORKSPACE_ROOT/.pi/settings.json.tmp" "$WORKSPACE_ROOT/.pi/settings.json"
fi

if [ ! -f "$WORKSPACE_ROOT/lab-config/raman-runtime.local.json" ]; then
  cp "$TEMPLATE_ROOT/lab-config/raman-runtime.local.json.example" \
    "$WORKSPACE_ROOT/lab-config/raman-runtime.local.json"
fi

if [ ! -f "$WORKSPACE_ROOT/lab-config/user-prompts.md" ]; then
  cp "$TEMPLATE_ROOT/lab-config/user-prompts.md" \
    "$WORKSPACE_ROOT/lab-config/user-prompts.md"
fi

if [ -d "$TEMPLATE_ROOT/lab-config/templates" ]; then
  for template_file in "$TEMPLATE_ROOT"/lab-config/templates/*.json; do
    [ -f "$template_file" ] || continue
    template_name=$(basename "$template_file")
    if [ ! -f "$WORKSPACE_ROOT/lab-config/templates/$template_name" ]; then
      cp "$template_file" "$WORKSPACE_ROOT/lab-config/templates/$template_name"
    fi
  done
fi

# Refresh the deployed Raman Python driver copy from product source.
DRIVER_SRC="$LABAGENTS_REPO/src/drivers/raman-python"
DRIVER_DST="$WORKSPACE_ROOT/lab-config/drivers/raman-python"
rm -rf "$DRIVER_DST"
mkdir -p "$WORKSPACE_ROOT/lab-config/drivers"
cp -R "$DRIVER_SRC" "$DRIVER_DST"
find "$DRIVER_DST" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$DRIVER_DST" -type f -name "*.pyc" -delete 2>/dev/null || true

echo "Workspace prepared: $WORKSPACE_ROOT"
