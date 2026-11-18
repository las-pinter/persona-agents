#!/usr/bin/env bash
# install.sh — merge the persona-agents recommended settings into the Claude
# Code user settings.
#
# Usage:
#   ./install.sh [--dry-run] [--help]
#
# The snippet (platforms/claude/settings/recommended.json) sets the
# auto-compaction threshold, gives access to ~/agent-notes, and asks before a
# push or a gh pr / run / release command. The merge keeps every existing key:
# env keys from the snippet are set, permission lists gain the missing entries.
# A leading "~/" in additionalDirectories becomes the home folder. The old file
# is kept as settings.json.bak-<timestamp>.
#
# The target is $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json.
# Needs jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET="$SCRIPT_DIR/platforms/claude/settings/recommended.json"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TARGET="$CONFIG_DIR/settings.json"
DRY_RUN=0

usage() {
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
    case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
        usage
        exit 0
        ;;
    *)
        echo "Error: unknown option '$arg'." >&2
        usage >&2
        exit 2
        ;;
    esac
done

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required." >&2
    exit 1
fi
if [[ ! -f "$SNIPPET" ]]; then
    echo "Error: snippet not found: $SNIPPET" >&2
    exit 1
fi

current='{}'
if [[ -f "$TARGET" ]]; then
    if ! current="$(jq -e 'if type == "object" then . else error("not an object") end' "$TARGET" 2>/dev/null)"; then
        echo "Error: $TARGET is not a JSON object; fix it first. Nothing was changed." >&2
        exit 1
    fi
fi

merged="$(jq -n --argjson cur "$current" --slurpfile snip "$SNIPPET" --arg home "$HOME" '
    def union($a; $b): ($a // []) + [($b // [])[] | select(. as $x | ($a // []) | index($x) | not)];
    ($snip[0]) as $s
    | ($s.permissions.additionalDirectories // [] | map(if startswith("~/") then $home + .[1:] else . end)) as $dirs
    | $cur
    | .env = ((.env // {}) + ($s.env // {}))
    | .permissions = (.permissions // {})
    | .permissions.additionalDirectories = union(.permissions.additionalDirectories; $dirs)
    | .permissions.allow = union(.permissions.allow; $s.permissions.allow)
    | .permissions.ask = union(.permissions.ask; $s.permissions.ask)
')"

if [[ "$merged" == "$(jq . <<<"$current")" ]]; then
    echo "Settings already up to date: $TARGET"
    exit 0
fi

if ((DRY_RUN)); then
    echo "Dry run: $TARGET would become:"
    echo "$merged"
    exit 0
fi

mkdir -p "$CONFIG_DIR"
if [[ -f "$TARGET" ]]; then
    backup="$TARGET.bak-$(date +%Y%m%dT%H%M%S)"
    cp "$TARGET" "$backup"
    echo "Backup: $backup"
fi
tmp="$(mktemp "$CONFIG_DIR/.settings.json.XXXXXX")"
printf '%s\n' "$merged" >"$tmp"
mv "$tmp" "$TARGET"
echo "Updated: $TARGET"
echo
echo "Install the plugin, if you have not:"
echo "  claude plugin marketplace add las-pinter/persona-agents"
echo "  claude plugin install persona-agents@persona-agents"
echo "Start the companion: claude --agent persona-agents:companion"
