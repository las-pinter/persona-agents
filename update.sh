#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Pulling latest changes..."
cd "$REPO_DIR"
git pull

echo "Re-installing agents, personas, professions, and skills..."
"$REPO_DIR/install.sh" --force

echo "Update complete. Settings files were NOT touched — edit ~/.kiro/settings/ manually if needed."
