#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.kiro"
FORCE="${1:-}"

copy_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [[ -f "$dest" && "$FORCE" != "--force" ]]; then
    echo "  skipped (exists): $dest"
    return
  fi
  if [[ -f "$dest" && "$FORCE" == "--force" ]]; then
    local backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$dest" "$backup"
    echo "  backed up: $backup"
  fi
  cp "$src" "$dest"
  echo "  installed: $dest"
}

copy_if_missing() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]]; then
    echo "  skipped (customize locally): $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "  created: $dest"
}

echo "Installing kiro-agents to $DEST ..."

for dir in agents personas professions skills; do
  for f in "$REPO_DIR/$dir"/*; do
    copy_file "$f" "$DEST/$dir/$(basename "$f")"
  done
done

# Settings: only install if not already present — never overwrite user customizations
copy_if_missing "$REPO_DIR/settings/cli.json.example"  "$DEST/settings/cli.json"
copy_if_missing "$REPO_DIR/settings/mcp.json.example"  "$DEST/settings/mcp.json"

echo ""
echo "Done! Re-run with --force to overwrite existing files (backs up originals)."
echo "Edit files in $DEST directly to customize — they won't be overwritten unless you use --force."
