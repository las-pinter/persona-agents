#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.kiro"
BACKUP_DIR="$HOME/.kiro-bak"
FORCE="${1:-}"

copy_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [[ -f "$dest" && "$FORCE" != "--force" ]]; then
    echo "  skipped (exists): $dest"
    return
  fi
  if [[ -f "$dest" && "$FORCE" == "--force" ]]; then
    local rel_path="${dest#$DEST/}"
    local backup="$BACKUP_DIR/$rel_path.bak.$(date +%Y%m%d%H%M%S)"
    mkdir -p "$(dirname "$backup")"
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

echo "Generating agents from templates..."
if [[ -x "$REPO_DIR/generate-agents.sh" ]]; then
  "$REPO_DIR/generate-agents.sh" "$DEST/agents"
  echo "  agents generated"
else
  echo "  warning: generate-agents.sh not found or not executable"
fi

echo "Installing kiro-agents to $DEST ..."

for dir in personas professions skills; do
  while IFS= read -r -d '' f; do
    rel="${f#$REPO_DIR/}"
    copy_file "$f" "$DEST/$rel"
  done < <(find "$REPO_DIR/$dir" -type f -print0)
done

# Settings: only install if not already present — never overwrite user customizations
copy_if_missing "$REPO_DIR/settings/cli.json.example"  "$DEST/settings/cli.json"
copy_if_missing "$REPO_DIR/settings/mcp.json.example"  "$DEST/settings/mcp.json"

install_alias() {
  local name="$1" cmd="$2" rc="$3"
  local line="alias ${name}='${cmd}'"
  if grep -qF "$line" "$rc" 2>/dev/null; then
    echo "  skipped (exists): $name in $rc"
  else
    printf '\n%s\n' "$line" >> "$rc"
    echo "  installed alias: $name in $rc"
  fi
}

echo "Installing kiro-cli aliases ..."

if [[ -f "$HOME/.zshrc" ]]; then
  install_alias "kiro-goblin" "kiro-cli chat --agent goblin-orchestrator" "$HOME/.zshrc"
  install_alias "kiro-wh40k"  "kiro-cli chat --agent wh40k-orchestrator" "$HOME/.zshrc"
fi

if [[ -f "$HOME/.bashrc" ]]; then
  install_alias "kiro-goblin" "kiro-cli chat --agent goblin-orchestrator" "$HOME/.bash_aliases"
  install_alias "kiro-wh40k"  "kiro-cli chat --agent wh40k-orchestrator" "$HOME/.bash_aliases"
elif [[ ! -f "$HOME/.zshrc" ]]; then
  touch "$HOME/.bashrc"
  install_alias "kiro-goblin" "kiro-cli chat --agent goblin-orchestrator" "$HOME/.bash_aliases"
  install_alias "kiro-wh40k"  "kiro-cli chat --agent wh40k-orchestrator" "$HOME/.bash_aliases"
fi

echo ""
echo "Done! Re-run with --force to overwrite existing files (backs up originals)."
echo "Edit files in $DEST directly to customize — they won't be overwritten unless you use --force."
echo "Reload your shell: source ~/.zshrc (zsh) or source ~/.bashrc (bash)"

