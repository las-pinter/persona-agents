#!/usr/bin/env bash
# install.sh — install the companion-agents adapters for Claude Code and Kiro CLI.
#
# Usage:
#   ./install.sh [--claude] [--kiro] [--dandelion] [--theme <name>] [--dry-run]
#                [--force] [--kiro-home=<dir>] [--kiro-cli=<path>]
#                [--no-dandelion] [--help]
#
# Claude Code: merges the recommended settings snippet
# (platforms/claude/settings/recommended.json) into the user settings. The merge
# keeps every existing key: env keys from the snippet are set, permission lists
# gain the missing entries. A leading "~/" in additionalDirectories becomes the
# home folder. The old file is kept as settings.json.bak-<timestamp>. The target
# is $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json. Needs jq.
#
# Kiro CLI: copies a self-contained payload into <kiro home>/companion-agents/,
# installs the skills into <kiro home>/skills/, and writes ca-companion,
# ca-reviewer, and ca-writer into <kiro home>/agents/. The kiro home is
# $KIRO_HOME, else ~/.kiro. Needs kiro-cli 3.4.0 or newer and Node 22.6 or
# newer.
#
# With no flag at all, both adapters are installed; --dandelion or --no-dandelion
# alone runs only the Dandelion step. When kiro-cli is absent, the Kiro step is
# skipped with a message unless --kiro was named.
#
# Dandelion (opt-in): --dandelion registers the visuals collection (the files
# /visualize writes) with Dandelion's Documents page by writing
# <plugins>/companion-agents-visuals.json, and runs no adapter step. <plugins>
# is $DANDELION_PLUGINS_DIR when set, else ${XDG_CONFIG_HOME:-~/.config}/dandelion/plugins.
# It writes only when Dandelion is present: $DANDELION_PLUGINS_DIR is set or the
# dandelion config folder exists. --no-dandelion removes that one file, never the
# folder. Without either flag, no manifest is written.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET="$SCRIPT_DIR/platforms/claude/settings/recommended.json"
KIRO_INSTALLER="$SCRIPT_DIR/platforms/kiro/install.ts"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TARGET="$CONFIG_DIR/settings.json"
DRY_RUN=0
DO_CLAUDE=1
DO_KIRO=1
ANY_ADAPTER=0
KIRO_EXPLICIT=0
THEME=""
FORCE=0
KIRO_HOME_ARG="${KIRO_HOME:-}"
KIRO_CLI_ARG="${KIRO_CLI:-kiro-cli}"
DO_DANDELION=0
DANDELION_REMOVE=0
DANDELION_ID="companion-agents-visuals"

usage() {
    cat <<'EOF'
Install the companion-agents adapters for Claude Code and Kiro CLI.

Usage:
  ./install.sh [--claude] [--kiro] [--dandelion] [--theme <name>] [--dry-run]
               [--force] [--kiro-home=<dir>] [--kiro-cli=<path>]
               [--no-dandelion] [--help]

  --claude           Install the Claude Code settings merge only.
  --kiro             Install the Kiro CLI adapter only.
  --theme <name>     Write the Kiro persona theme (default: goblin).
  --dry-run          Print what would change and write nothing.
  --force            Back up and replace a Kiro skill folder not owned by
                     companion-agents.
  --kiro-home=<dir>  The Kiro global directory (default: $KIRO_HOME or ~/.kiro).
  --kiro-cli=<path>  The kiro-cli command to check (default: $KIRO_CLI or
                     kiro-cli).
  --dandelion        Register the /visualize files as a Dandelion collection and
                     run no adapter step (opt-in; needs Dandelion).
  --no-dandelion     Remove the Dandelion collection registration.

With no flag at all, both adapters are installed; --dandelion or --no-dandelion
alone runs only the Dandelion step. When kiro-cli is absent, the Kiro step is
skipped with a message unless --kiro was named. Options that affect an adapter
(--theme, --force, --kiro-home, --kiro-cli) take effect only when an adapter
step runs.

Claude Code needs jq. Kiro CLI needs Node 22.6 or newer and kiro-cli 3.4.0 or
newer.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
    --dry-run)
        DRY_RUN=1
        shift
        ;;
    --claude)
        DO_CLAUDE=1
        DO_KIRO=0
        ANY_ADAPTER=1
        shift
        ;;
    --kiro)
        DO_CLAUDE=0
        DO_KIRO=1
        ANY_ADAPTER=1
        KIRO_EXPLICIT=1
        shift
        ;;
    --theme)
        if [[ $# -lt 2 ]]; then
            echo "Error: --theme needs a name." >&2
            exit 2
        fi
        THEME="$2"
        shift 2
        ;;
    --theme=*)
        THEME="${1#*=}"
        shift
        ;;
    --force)
        FORCE=1
        shift
        ;;
    --kiro-home=*)
        KIRO_HOME_ARG="${1#*=}"
        shift
        ;;
    --kiro-cli=*)
        KIRO_CLI_ARG="${1#*=}"
        shift
        ;;
    --dandelion)
        DO_DANDELION=1
        DANDELION_REMOVE=0
        shift
        ;;
    --no-dandelion)
        DANDELION_REMOVE=1
        DO_DANDELION=0
        shift
        ;;
    -h | --help)
        usage
        exit 0
        ;;
    *)
        echo "Error: unknown option '$1'." >&2
        usage >&2
        exit 2
        ;;
    esac
done

# --dandelion and --no-dandelion alone run only the manifest step; with an
# adapter flag they combine.
if ((!ANY_ADAPTER && (DO_DANDELION || DANDELION_REMOVE))); then
    DO_CLAUDE=0
    DO_KIRO=0
fi

install_claude() {
    if ! command -v jq >/dev/null 2>&1; then
        echo "Error: jq is required." >&2
        exit 1
    fi
    if [[ ! -f "$SNIPPET" ]]; then
        echo "Error: snippet not found: $SNIPPET" >&2
        exit 1
    fi

    local current='{}'
    if [[ -f "$TARGET" ]]; then
        if ! current="$(jq -e 'if type == "object" then . else error("not an object") end' "$TARGET" 2>/dev/null)"; then
            echo "Error: $TARGET is not a JSON object; fix it first. Nothing was changed." >&2
            exit 1
        fi
    fi

    local merged
    # Rules an earlier snippet added and the current one dropped: the merge
    # only adds, so without this a retired ask keeps prompting after an update.
    local retired='["Bash(gh pr:*)", "Bash(gh run:*)", "Bash(gh release:*)"]'
    merged="$(jq -n --argjson cur "$current" --slurpfile snip "$SNIPPET" --arg home "$HOME" --argjson retired "$retired" '
        def union($a; $b): ($a // []) + [($b // [])[] | select(. as $x | ($a // []) | index($x) | not)];
        ($snip[0]) as $s
        | ($s.permissions.additionalDirectories // [] | map(if startswith("~/") then $home + .[1:] else . end)) as $dirs
        | $cur
        | .env = ((.env // {}) + ($s.env // {}))
        | .permissions = (.permissions // {})
        | .permissions.additionalDirectories = union(.permissions.additionalDirectories; $dirs)
        | .permissions.allow = union(.permissions.allow; $s.permissions.allow)
        | .permissions.ask = (union(.permissions.ask; $s.permissions.ask) | map(select(. as $x | $retired | index($x) | not)))
    ')"

    if [[ "$merged" == "$(jq . <<<"$current")" ]]; then
        echo "Settings already up to date: $TARGET"
        return 0
    fi

    if ((DRY_RUN)); then
        echo "Dry run: $TARGET would become:"
        echo "$merged"
        return 0
    fi

    mkdir -p "$CONFIG_DIR"
    if [[ -f "$TARGET" ]]; then
        local backup
        backup="$TARGET.bak-$(date +%Y%m%dT%H%M%S)"
        cp "$TARGET" "$backup"
        echo "Backup: $backup"
    fi
    local tmp
    tmp="$(mktemp "$CONFIG_DIR/.settings.json.XXXXXX")"
    printf '%s\n' "$merged" >"$tmp"
    mv "$tmp" "$TARGET"
    echo "Updated: $TARGET"
}

install_kiro() {
    local kiro_home="${KIRO_HOME_ARG:-$HOME/.kiro}"
    if ((KIRO_EXPLICIT == 0)) && ! command -v "$KIRO_CLI_ARG" >/dev/null 2>&1; then
        echo "Kiro CLI not found ($KIRO_CLI_ARG); skipping the Kiro adapter."
        return 0
    fi
    if ((KIRO_EXPLICIT == 0)); then
        local version major minor
        version="$("$KIRO_CLI_ARG" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || version=""
        if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]]; then
            major="${BASH_REMATCH[1]}"
            minor="${BASH_REMATCH[2]}"
        else
            major="" minor=""
        fi
        # Same minimum as MIN_VERSION in platforms/kiro/install.ts; a test keeps them equal.
        if [[ -z "$major" ]] || ((major < 3)) || ((major == 3 && minor < 4)); then
            echo "Kiro CLI ${version:-unknown} is below 3.4.0; skipping the Kiro adapter. Install kiro-cli 3.4.0 or newer to use it."
            return 0
        fi
    fi
    local node_version node_major node_minor
    if ! command -v node >/dev/null 2>&1; then
        echo "Error: Node is required for the Kiro adapter." >&2
        exit 1
    fi
    node_version="$(node --version 2>/dev/null)" || node_version=""
    if [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+) ]]; then
        node_major="${BASH_REMATCH[1]}"
        node_minor="${BASH_REMATCH[2]}"
    else
        node_major="" node_minor=""
    fi
    if [[ -z "$node_major" ]] || ((node_major < 22)) || ((node_major == 22 && node_minor < 6)); then
        echo "Error: Node 22.6 or newer is required for the Kiro adapter; found ${node_version:-an unreadable version}." >&2
        exit 1
    fi
    local args=(--kiro-home="$kiro_home" --kiro-cli="$KIRO_CLI_ARG")
    [[ -n "$THEME" ]] && args+=(--theme="$THEME")
    ((DRY_RUN)) && args+=(--dry-run)
    ((FORCE)) && args+=(--force)
    node --experimental-strip-types --no-warnings "$KIRO_INSTALLER" "${args[@]}"
}

dandelion_manifest() {
    cat <<EOF
{
  "schema": 1,
  "id": "$DANDELION_ID",
  "name": "Agent visuals",
  "icon": "chart",
  "root": "~/agent-notes/project-notes",
  "include": ["{project}/visuals/{day}/**/*.{html,md}"],
  "group": ["project", "day"]
}
EOF
}

install_dandelion() {
    local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/dandelion"
    local plugins="${DANDELION_PLUGINS_DIR:-$config_dir/plugins}"
    local file="$plugins/$DANDELION_ID.json"

    if ((DANDELION_REMOVE)); then
        if [[ -f "$file" ]]; then
            if ((DRY_RUN)); then
                echo "Dry run: would remove the Dandelion visuals collection: $file"
            else
                rm -f -- "$file"
                echo "Removed the Dandelion visuals collection: $file"
            fi
        fi
        return 0
    fi

    # Defensive: the call sites reach this function only for a write or a
    # removal, so this guard is not expected to run.
    if ((DO_DANDELION == 0)); then
        return 0
    fi

    if [[ -z "${DANDELION_PLUGINS_DIR:-}" && ! -d "$config_dir" ]]; then
        echo "Dandelion not found; skipping the visuals collection."
        return 0
    fi

    local manifest root="$HOME/agent-notes/project-notes"
    manifest="$(dandelion_manifest)"
    local up_to_date=0
    if [[ -f "$file" && "$(cat "$file")" == "$manifest" ]]; then
        up_to_date=1
    fi

    if ((DRY_RUN)); then
        if ((up_to_date)); then
            echo "Dandelion visuals collection already up to date: $file"
        else
            echo "Dry run: $file would become:"
            echo "$manifest"
        fi
        if [[ ! -d "$root" ]]; then
            echo "Dry run: would create $root"
        fi
        return 0
    fi

    # Dandelion lists a manifest whose root is missing as a warning row, so the
    # root is recreated even when the manifest is already up to date.
    mkdir -p "$root"
    if ((up_to_date)); then
        echo "Dandelion visuals collection already up to date: $file"
        return 0
    fi

    mkdir -p "$plugins"
    local tmp
    # The temporary name does not end in .json, so Dandelion never reads it.
    tmp="$(mktemp "$plugins/.$DANDELION_ID.XXXXXX")"
    printf '%s\n' "$manifest" >"$tmp"
    mv "$tmp" "$file"
    echo "Registered the Dandelion visuals collection: $file"
}

# --no-dandelion removes the registration before the adapter steps, so a
# missing jq or a failing adapter still lets the removal run.
if ((DANDELION_REMOVE)); then
    install_dandelion
fi

if ((DO_CLAUDE)); then
    install_claude
fi

if ((DO_KIRO)); then
    install_kiro
fi

if ((DO_DANDELION)); then
    install_dandelion
fi

if ((DO_CLAUDE)); then
    echo
    echo "Install the plugin, if you have not:"
    echo "  claude plugin marketplace add las-pinter/companion-agents"
    echo "  claude plugin install companion-agents@companion-agents"
    echo "Start the companion: claude --agent companion-agents:companion"
fi
