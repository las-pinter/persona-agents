#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# install.sh — Install kiro-agents and OpenCode agents
#
# Usage:
#   ./install.sh [--force] [--dry-run] [--target kiro|opencode|all] [--help]
#
# Options:
#   --force          Overwrite existing files
#   --dry-run        Show what would be done without actually doing it
#   --target TARGET  Which target to install: kiro, opencode, all (default: all)
#   --help, -h       Show this help message
# ============================================================================

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEST="$HOME/.kiro"
OPENCODE_DEST="$HOME/.config/opencode"
OPENCODE_CONFIG="$OPENCODE_DEST/opencode.json"
FORCE=false
DRY_RUN=false
TARGET="all"
THEME=""
PROFESSION=""

# ---------------------------------------------------------------------------
# Temp cleanup trap
# ---------------------------------------------------------------------------
CLEANUP_DIRS=()
CLEANUP_FILES=()

cleanup() {
    if [[ ${#CLEANUP_FILES[@]} -gt 0 ]]; then
        rm -f "${CLEANUP_FILES[@]}"
    fi
    if [[ ${#CLEANUP_DIRS[@]} -gt 0 ]]; then
        rm -rf "${CLEANUP_DIRS[@]}"
    fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------
for cmd in jq perl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is required but not installed." >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --force                Overwrite existing files"
    echo "  --dry-run              Show what would be done without doing it"
    echo "  --target TARGET        Which target to install: kiro, opencode, all (default: all)"
    echo "  --theme THEME          Theme to generate (optional, filters by theme)"
    echo "  --profession PROFESSION Profession to generate (optional, filters by profession)"
    echo "  --help, -h             Show this help message"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
    --force)
        FORCE=true
        shift
        ;;
    --dry-run)
        DRY_RUN=true
        shift
        ;;
    --target=*)
        TARGET="${1#--target=}"
        shift
        ;;
    --target)
        if [[ -z "$2" || "$2" == --* ]]; then
            echo "Error: --target requires a value (kiro, opencode, or all)." >&2
            exit 1
        fi
        TARGET="$2"
        shift 2
        ;;
    --profession=*)
        PROFESSION="${1#--profession=}"
        shift
        ;;
    --profession)
        if [[ -z "$2" || "$2" == --* ]]; then
            echo "Error: --profession requires a value." >&2
            exit 1
        fi
        PROFESSION="$2"
        shift 2
        ;;
    --theme=*)
        THEME="${1#--theme=}"
        shift
        ;;
    --theme)
        if [[ -z "$2" || "$2" == --* ]]; then
            echo "Error: --theme requires a value." >&2
            exit 1
        fi
        THEME="$2"
        shift 2
        ;;
    --help | -h)
        usage
        exit 0
        ;;
    *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
done

# Validate --target value
case "$TARGET" in
kiro | opencode | all) ;;
*)
    echo "Error: --target must be 'kiro', 'opencode', or 'all', got '$TARGET'." >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Target application checks — auto-detect available tools, warn not fail
# ---------------------------------------------------------------------------
TARGETS_TO_INSTALL=()

if [[ "$TARGET" == "kiro" || "$TARGET" == "all" ]]; then
    if command -v kiro-cli &>/dev/null; then
        TARGETS_TO_INSTALL+=("kiro")
    else
        echo "WARNING: kiro-cli not found — skipping kiro install (use --target kiro after installing kiro-cli)" >&2
    fi
fi

if [[ "$TARGET" == "opencode" || "$TARGET" == "all" ]]; then
    if command -v opencode &>/dev/null; then
        TARGETS_TO_INSTALL+=("opencode")
    else
        echo "WARNING: opencode not found — skipping opencode install (use --target opencode after installing opencode)" >&2
    fi
fi

# If no targets available, warn but don't crash — skip all install blocks below
if [[ ${#TARGETS_TO_INSTALL[@]} -eq 0 ]]; then
    echo "WARNING: No installed tools found for target '$TARGET'. Neither kiro-cli nor opencode is on PATH." >&2
    echo "Install one of them and try again, or specify --target kiro or --target opencode explicitly." >&2
fi

# Helper: check if a target is in TARGETS_TO_INSTALL (safe even when empty)
target_available() {
    local t="$1"
    if [[ ${#TARGETS_TO_INSTALL[@]} -eq 0 ]]; then
        return 1
    fi
    [[ " ${TARGETS_TO_INSTALL[*]} " == *" $t "* ]]
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

run() {
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) $*"
    else
        "$@"
    fi
}

copy_file() {
    local src="$1" dest="$2"
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) would install: $dest"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    if [[ -f "$dest" && "$FORCE" != true ]]; then
        echo "  skipped (exists): $dest"
        return
    fi
    cp "$src" "$dest"
    echo "  installed: $dest"
}

copy_if_missing() {
    local src="$1" dest="$2"
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) would create if missing: $dest"
        return
    fi
    if [[ -f "$dest" ]]; then
        echo "  skipped (customize locally): $dest"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "  created: $dest"
}

# Check if generation is needed for a given output directory.
# Returns 0 (needs gen) if force is set or the directory is empty/missing.
# Returns 1 (skip) if the directory has content and force is not set.
needs_generation() {
    local dir="$1"
    if [[ "$FORCE" == true ]]; then
        return 0
    fi
    if [[ -d "$dir" ]] && [[ -n "$(find "$dir" -maxdepth 1 -name '*.json' -print -quit 2>/dev/null)" ]]; then
        return 1
    fi
    return 0
}

# Install a shell alias into a rc file, skipping if already present.
install_alias() {
    local name="$1" cmd="$2" rc="$3"
    local line="alias ${name}='${cmd}'"
    if grep -qF "$line" "$rc" 2>/dev/null; then
        echo "  skipped (exists): $name in $rc"
    else
        if [[ "$DRY_RUN" == true ]]; then
            echo "  (dry-run) would add alias $name to $rc"
        else
            printf '\n%s\n' "$line" >>"$rc"
            echo "  installed alias: $name in $rc"
        fi
    fi
}

# Merge a JSON file into a destination JSON file at a given top-level key.
# Handles trailing commas in the destination (jq is strict about those).
merge_json_into() {
    local src_file="$1" dest_file="$2" dest_key="$3"

    if [[ ! -s "$dest_file" ]]; then
        echo "  warning: $dest_file not found or empty, skipping merge into .${dest_key}" >&2
        return
    fi
    if [[ ! -s "$src_file" ]]; then
        echo "  warning: $src_file is empty, skipping merge into .${dest_key}" >&2
        return
    fi
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) would merge $src_file into $dest_file at key '.${dest_key}'"
        return
    fi

    local tmp
    tmp=$(mktemp)
    CLEANUP_FILES+=("$tmp" "${tmp}.merged")

    # jq is strict about valid JSON — if the existing config has trailing
    # commas (which OpenCode tolerates but jq doesn't), strip them first.
    # Only do this if jq can't parse the file, to avoid corrupting strings.
    if ! jq . "$dest_file" >/dev/null 2>&1; then
        perl -0777 -pe 's/,\s*([}\]])/$1/g' "$dest_file" >"$tmp"
    else
        cp "$dest_file" "$tmp"
    fi

    # Merge: update the dest_key object with new data (new overwrites old at top level)
    if ! jq --argjson data "$(cat "$src_file")" \
        ".${dest_key} = ((.${dest_key} // {}) + \$data)" \
        "$tmp" >"${tmp}.merged"; then
        echo "Error: jq merge failed for .${dest_key}" >&2
        return 1
    fi
    mv "${tmp}.merged" "$dest_file"
    echo "  merged into $dest_file (.${dest_key})"
}

# ---------------------------------------------------------------------------
# Kiro agent generation & installation
# ---------------------------------------------------------------------------

if target_available kiro; then
    if needs_generation "$DEST/agents"; then
        echo "Generating kiro agents from templates..."
        kiro_generator_script="$REPO_DIR/generators/generate_kiro.sh"
        if [[ -x "$kiro_generator_script" ]]; then
            kiro_args=("--output" "$DEST/agents")
            if [[ -n "$THEME" ]]; then
                kiro_args+=("--theme" "$THEME")
            fi
            if [[ -n "$PROFESSION" ]]; then
                kiro_args+=("--profession" "$PROFESSION")
            fi
            run "$kiro_generator_script" "${kiro_args[@]}"
            echo "  kiro agents generated"
        else
            echo "  warning: generate_kiro.sh not found or not executable" >&2
        fi
    else
        echo "  skipped (agents exist, use --force to regenerate): $DEST/agents"
    fi

    echo ""
    echo "Installing kiro-agents to $DEST ..."

    for dir in personas professions skills; do
        if [[ -d "$REPO_DIR/$dir" ]]; then
            while IFS= read -r -d '' f; do
                rel="${f#"$REPO_DIR"/}"
                copy_file "$f" "$DEST/$rel"
            done < <(find "$REPO_DIR/$dir" -type f -print0)
        fi
    done

    # Settings: only install if not already present — never overwrite user customizations
    copy_if_missing "$REPO_DIR/settings/kiro-cli.json.example" "$DEST/settings/cli.json"
    copy_if_missing "$REPO_DIR/settings/mcp.json.example" "$DEST/settings/mcp.json"
fi

# ---------------------------------------------------------------------------
# OpenCode agent generation, file installation & merge
# ---------------------------------------------------------------------------

if target_available opencode; then

    # -- Copy personas, professions, skills to OpenCode config folder --
    echo ""
    echo "Installing OpenCode resource files to $OPENCODE_DEST ..."

    for dir in personas professions skills; do
        if [[ -d "$REPO_DIR/$dir" ]]; then
            while IFS= read -r -d '' f; do
                rel="${f#"$REPO_DIR"/}"
                copy_file "$f" "$OPENCODE_DEST/$rel"
            done < <(find "$REPO_DIR/$dir" -type f -print0)
        fi
    done

    # -- Generate and merge OpenCode agents --
    if [[ "$FORCE" != true ]] && [[ -f "$OPENCODE_CONFIG" ]] &&
        jq -e '.agent | length > 0' "$OPENCODE_CONFIG" &>/dev/null; then
        echo ""
        echo "  skipped (agents already in config, use --force to regenerate)"
    else
        echo ""
        echo "Generating OpenCode agents..."

        # Validate config before attempting merges
        if ! jq empty "$OPENCODE_CONFIG" 2>/dev/null; then
            echo "WARNING: $OPENCODE_CONFIG contains invalid JSON — will regenerate" >&2
        fi

        opencode_generator_script="$REPO_DIR/generators/generate_opencode.sh"
        if [[ -x "$opencode_generator_script" ]]; then
            if [[ "$DRY_RUN" == true ]]; then
                echo "  (dry-run) would run opencode generator..."
            else
                opencode_gen_dir=$(mktemp -d)
                CLEANUP_DIRS+=("$opencode_gen_dir")

                opencode_args=(
                    "--output" "$opencode_gen_dir"
                    "--agents-dir" "$REPO_DIR/agents-generic"
                    "--agents-json" "$REPO_DIR/agents.json"
                    "--skills-dir" "$REPO_DIR/skills"
                )
                if [[ -n "$THEME" ]]; then
                    opencode_args+=("--theme" "$THEME")
                fi
                if [[ -n "$PROFESSION" ]]; then
                    opencode_args+=("--profession" "$PROFESSION")
                fi
                "$opencode_generator_script" "${opencode_args[@]}"

                # Validate all generated agent files before merging
                for f in "$opencode_gen_dir"/*.json; do
                    if ! jq empty "$f" 2>/dev/null; then
                        echo "ERROR: Generated agent file is not valid JSON: $(basename "$f")" >&2
                        rm -rf "$opencode_gen_dir"
                        exit 1
                    fi
                done

                # Combine all generated agent JSONs into one
                # Use find to avoid nullglob/failglob issues
                if [[ -n "$(find "$opencode_gen_dir" -maxdepth 1 -name '*.json' -print -quit)" ]]; then
                    combined_agents=$(mktemp)
                    CLEANUP_FILES+=("$combined_agents")
                    jq -s 'add' "$opencode_gen_dir"/*.json >"$combined_agents"

                    # Validate combined JSON before merging
                    if [[ -s "$combined_agents" ]] && jq empty "$combined_agents" 2>/dev/null; then
                        if [[ -f "$OPENCODE_CONFIG" ]]; then
                            merge_json_into "$combined_agents" "$OPENCODE_CONFIG" "agent"
                        else
                            echo "  warning: $OPENCODE_CONFIG not found — run 'opencode init' first" >&2
                        fi
                    else
                        echo "  warning: combined agents file is empty or invalid, skipping merge" >&2
                    fi
                else
                    echo "  warning: no agent files generated" >&2
                fi
            fi
            echo "  OpenCode agents generated and merged"
        else
            echo "  warning: generate_opencode.sh not found or not executable" >&2
        fi
    fi

    # -- Merge MCP settings into OpenCode config --
    if [[ -f "$OPENCODE_CONFIG" ]]; then
        echo ""
        echo "Merging MCP settings into OpenCode config..."

        mcp_example="$REPO_DIR/settings/mcp.json.example"
        if [[ -f "$mcp_example" ]]; then
            if [[ "$DRY_RUN" == true ]]; then
                echo "  (dry-run) would merge MCP settings from $mcp_example"
            else
                mcp_tmp=$(mktemp)
                CLEANUP_FILES+=("$mcp_tmp")
                # Transform mcpServers format → opencode mcp format
                # Handle both remote (url-based) and local/stdio (command-based) transports
                if ! jq '.mcpServers | to_entries | map({key: .key, value: (.value | if .url != null then {type: "remote", url: .url, enabled: true} elif .command != null then {type: "local", command: .command, args: (.args // []), enabled: true} else {type: "unknown", enabled: true} end)}) | from_entries' \
                    "$mcp_example" >"$mcp_tmp"; then
                    echo "  warning: failed to parse mcpServers from $mcp_example, skipping" >&2
                    rm -f "$mcp_tmp"
                else
                    merge_json_into "$mcp_tmp" "$OPENCODE_CONFIG" "mcp"
                fi
            fi
        else
            echo "  warning: MCP example file not found at $mcp_example" >&2
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Shell aliases (kiro)
# ---------------------------------------------------------------------------

if target_available kiro; then
    echo ""
    echo "Installing kiro-cli aliases ..."

    ALIAS_ENTRIES=(
        "kiro-goblin:kiro-cli chat --agent goblin-orchestrator"
        "kiro-wh40k:kiro-cli chat --agent wh40k-orchestrator"
        "kiro-wh40kOrk:kiro-cli chat --agent wh40kOrk-orchestrator"
    )

    install_kiro_aliases() {
        local rc="$1"
        for entry in "${ALIAS_ENTRIES[@]}"; do
            local name="${entry%%:*}"
            local cmd="${entry#*:}"
            install_alias "$name" "$cmd" "$rc"
        done
    }

    if [[ -f "$HOME/.zshrc" ]]; then
        install_kiro_aliases "$HOME/.zshrc"
    fi

    if [[ -f "$HOME/.bashrc" ]]; then
        if [[ "$DRY_RUN" != true ]]; then
            touch "$HOME/.bash_aliases"
        fi
        install_kiro_aliases "$HOME/.bash_aliases"
        if [[ "$DRY_RUN" != true ]] && ! grep -qs "bash_aliases" "$HOME/.bashrc"; then
            echo "  warning: ~/.bashrc may not source ~/.bash_aliases — check your shell config" >&2
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Shell aliases (opencode)
# ---------------------------------------------------------------------------

if target_available opencode; then
    echo ""
    echo "Installing opencode aliases ..."

    OPENCODE_ALIAS_ENTRIES=(
        "opencode-goblin:opencode --agent goblin-orchestrator"
        "opencode-wh40k:opencode --agent wh40k-orchestrator"
        "opencode-wh40kOrk:opencode --agent wh40kOrk-orchestrator"
    )

    install_opencode_aliases() {
        local rc="$1"
        for entry in "${OPENCODE_ALIAS_ENTRIES[@]}"; do
            local name="${entry%%:*}"
            local cmd="${entry#*:}"
            install_alias "$name" "$cmd" "$rc"
        done
    }

    if [[ -f "$HOME/.zshrc" ]]; then
        install_opencode_aliases "$HOME/.zshrc"
    fi

    if [[ -f "$HOME/.bashrc" ]]; then
        if [[ "$DRY_RUN" != true ]]; then
            touch "$HOME/.bash_aliases"
        fi
        install_opencode_aliases "$HOME/.bash_aliases"
        if [[ "$DRY_RUN" != true ]] && ! grep -qs "bash_aliases" "$HOME/.bashrc"; then
            echo "  warning: ~/.bashrc may not source ~/.bash_aliases — check your shell config" >&2
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

if [[ ${#TARGETS_TO_INSTALL[@]} -eq 0 ]]; then
    echo ""
    echo "WARNING: No tools found — install.sh produced no output." >&2
fi

echo ""
echo "Done!"
if [[ "$DRY_RUN" == true ]]; then
    echo "This was a dry run — no files were modified."
fi
echo "Re-run with --force to overwrite existing files."
echo "Edit files in $DEST directly to customize — they won't be overwritten without --force."
echo "Reload your shell: source ~/.zshrc (zsh) or source ~/.bashrc (bash)"
