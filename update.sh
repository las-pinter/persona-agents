#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:--all}"

# Create timestamped backup of user-customizable files BEFORE any changes
BACKUP_DIR="$HOME/.persona-agents-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

if [ -d "$HOME/.kiro/settings" ]; then
    echo "Backing up existing kiro settings..."
    cp -r "$HOME/.kiro/settings" "$BACKUP_DIR/"
fi

# Add backup for kiro agents too (Grumbak noted this)
if [ -d "$HOME/.kiro/agents" ]; then
    echo "Backing up existing kiro agents..."
    cp -r "$HOME/.kiro/agents" "$BACKUP_DIR/"
fi

OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
AGENTS_DIR="$HOME/.config/opencode/agents"

if [ -f "$OPENCODE_CONFIG" ] && { [ "$TARGET" = "opencode" ] || [ "$TARGET" = "all" ]; }; then
    echo "Backing up existing opencode config..."
    cp "$OPENCODE_CONFIG" "$BACKUP_DIR/" 2>/dev/null || true
fi

if [ -d "$AGENTS_DIR" ] && compgen -G "$AGENTS_DIR/*.json" >/dev/null; then
    echo "Backing up existing agent configs..."
    cp -r "$AGENTS_DIR" "$BACKUP_DIR/"
fi

echo "Backup saved to: $BACKUP_DIR"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

if ! git pull; then
    echo "ERROR: git pull failed. Backup saved to $BACKUP_DIR" >&2
    exit 1
fi

echo "Re-installing agents, personas, professions, and skills..."
"$REPO_DIR/install.sh" --force --target "$TARGET"
echo "Update complete. Settings files were NOT touched — edit ~/.kiro/settings/ manually if needed."
