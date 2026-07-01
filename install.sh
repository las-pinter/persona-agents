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
AGENTS_JSON="$REPO_DIR/agents.json"
KIRO_DEST="$HOME/.kiro"
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
# agents.json — source of truth for theme/profession/persona mappings
# ---------------------------------------------------------------------------

if [[ ! -f "$AGENTS_JSON" ]]; then
    echo "ERROR: agents.json not found at $AGENTS_JSON" >&2
    exit 1
fi

get_themes() {
    jq -r 'keys[]' "$AGENTS_JSON"
}

get_professions() {
    local theme="$1"
    jq -r ".[\"$theme\"] | keys[]" "$AGENTS_JSON"
}

get_agent_field() {
    local theme="$1" profession="$2" field="$3"
    jq -r ".[\"$theme\"][\"$profession\"].$field" "$AGENTS_JSON"
}

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

    echo ""
    echo "Generating kiro agents from templates..."

    KIRO_AGENTS_DIR="$KIRO_DEST/agents"
    mkdir -p "$KIRO_AGENTS_DIR"

    for theme in $(get_themes); do
        [[ -n "$THEME" && "$theme" != "$THEME" ]] && continue
        for profession in $(get_professions "$theme"); do
            [[ -n "$PROFESSION" && "$profession" != "$PROFESSION" ]] && continue

            template="$REPO_DIR/agent-templates/kiro/${profession}.json"
            agent_file="$KIRO_AGENTS_DIR/${theme}-${profession}.json"

            if [[ ! -f "$template" ]]; then
                echo "  warning: no kiro template for ${profession}, skipping" >&2
                continue
            fi

            if [[ -f "$agent_file" && "$FORCE" != true ]]; then
                echo "  skipped (exists): ${theme}-${profession}.json"
                continue
            fi

            if [[ "$DRY_RUN" == true ]]; then
                echo "  (dry-run) would generate: ${theme}-${profession}.json"
                continue
            fi

            description=$(get_agent_field "$theme" "$profession" "description")
            persona_file=$(get_agent_field "$theme" "$profession" "personaFile")
            welcome_message=$(get_agent_field "$theme" "$profession" "welcomeMessage")

            # Escape sed special chars in welcome message (&, /, \, |)
            welcome_escaped=$(printf '%s\n' "$welcome_message" | sed 's|[\/&|]|\\&|g')

            sed -e "s|{{AGENT_DESCRIPTION}}|${description}|g" \
                -e "s|{{THEME}}|${theme}|g" \
                -e "s|{{PERSONA_FILE}}|${persona_file}|g" \
                -e "s|{{WELCOME_MESSAGE}}|${welcome_escaped}|g" \
                -e "s|{{PROFESSION}}|${profession}|g" \
                "$template" >"$agent_file"
            echo "  generated: ${theme}-${profession}.json"
        done
    done

    echo ""
    echo "Installing kiro resource files to $KIRO_DEST ..."

    for dir in personas professions skills; do
        if [[ -d "$REPO_DIR/$dir" ]]; then
            while IFS= read -r -d '' f; do
                rel="${f#"$REPO_DIR"/}"
                copy_file "$f" "$KIRO_DEST/$rel"
            done < <(find "$REPO_DIR/$dir" -type f -print0)
        fi
    done

    # Settings: only install if not already present — never overwrite user customizations
    copy_if_missing "$REPO_DIR/settings/kiro-cli.json.example" "$KIRO_DEST/settings/cli.json"
    copy_if_missing "$REPO_DIR/settings/mcp.json.example" "$KIRO_DEST/settings/mcp.json"
fi

# ---------------------------------------------------------------------------
# OpenCode agent generation, file installation & merge
# ---------------------------------------------------------------------------

if target_available opencode; then

    # -- Build persona-agents plugin --
    echo ""
    echo "Building persona-agents plugin..."
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) would build plugin in $REPO_DIR"
    else
        (cd "$REPO_DIR" && npm install --silent && npm run build)
        echo "  plugin built at $REPO_DIR/dist/index.js"
    fi

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

    # -- Generate OpenCode agents as markdown files with YAML frontmatter --
    echo ""
    echo "Generating OpenCode agents..."

    OPENCODE_AGENTS_DIR="$OPENCODE_DEST/agents"
    mkdir -p "$OPENCODE_AGENTS_DIR"

    for theme in $(get_themes); do
        [[ -n "$THEME" && "$theme" != "$THEME" ]] && continue
        for profession in $(get_professions "$theme"); do
            [[ -n "$PROFESSION" && "$profession" != "$PROFESSION" ]] && continue

            frontmatter_template="$REPO_DIR/agent-templates/opencode/frontmatters/${profession}.yaml"
            profession_file="$REPO_DIR/professions/${profession}.md"
            persona_file_path=$(get_agent_field "$theme" "$profession" "personaFile")
            persona_file="$REPO_DIR/personas/${theme}/${persona_file_path}"
            agent_file="$OPENCODE_AGENTS_DIR/${theme}-${profession}.md"

            # Check required files
            missing=""
            [[ ! -f "$frontmatter_template" ]] && missing="$missing frontmatter"
            [[ ! -f "$profession_file" ]] && missing="$missing profession"
            [[ ! -f "$persona_file" ]] && missing="$missing persona"
            if [[ -n "$missing" ]]; then
                echo "  warning: missing${missing} for ${theme}-${profession}, skipping" >&2
                continue
            fi

            if [[ -f "$agent_file" && "$FORCE" != true ]]; then
                echo "  skipped (exists): ${theme}-${profession}.md"
                continue
            fi

            if [[ "$DRY_RUN" == true ]]; then
                echo "  (dry-run) would generate: ${theme}-${profession}.md"
                continue
            fi

            description=$(get_agent_field "$theme" "$profession" "description")

            # Build agent markdown: YAML frontmatter + stub comment
            # (prompt content provided at runtime by persona-agents plugin)
            {
                echo "---"
                sed -e "s|{{AGENT_DESCRIPTION}}|${description}|g" \
                    -e "s|{{THEME}}|${theme}|g" \
                    "$frontmatter_template"
                echo "---"
                echo ""
                echo "<!-- persona-agents:${theme}-${profession}:${persona_file_path} -->"
            } >"$agent_file"
            echo "  generated: ${theme}-${profession}.md"
        done
    done

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

    # -- Register persona-agents plugin via auto-discovery --
    echo ""
    echo "Registering persona-agents plugin for auto-discovery..."
    PLUGINS_DIR="$OPENCODE_DEST/plugins"
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) would create $PLUGINS_DIR and install bundled plugin"
    else
        mkdir -p "$PLUGINS_DIR"
        PLUGIN_BUNDLE="$REPO_DIR/dist/plugin-bundled.js"
        PLUGIN_DEST="$PLUGINS_DIR/persona-agents.js"
        if [[ -f "$PLUGIN_BUNDLE" ]]; then
            # Copy the bundled self-contained plugin to auto-discovery directory.
            # The plugin resolves resource paths (agents.json, personas/, professions/)
            # relative to its own location (configRoot/plugins/ → configRoot/).
            cp "$PLUGIN_BUNDLE" "$PLUGIN_DEST"
            echo "  installed: $PLUGIN_BUNDLE → $PLUGIN_DEST"
        else
            echo "  WARNING: bundled plugin not found at $PLUGIN_BUNDLE — trying dist/index.js as fallback" >&2
            PLUGIN_SRC="$REPO_DIR/dist/index.js"
            if [[ -f "$PLUGIN_SRC" ]]; then
                cp "$PLUGIN_SRC" "$PLUGIN_DEST"
                echo "  installed (fallback): $PLUGIN_SRC → $PLUGIN_DEST"
            else
                echo "  WARNING: plugin not built — skipping registration" >&2
            fi
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
        "kiro-pub:kiro-cli chat --agent pub-orchestrator"
        "kiro-caveman:kiro-cli chat --agent caveman-orchestrator"
        "kiro-cyberpunk:kiro-cli chat --agent cyberpunk-orchestrator"
        "kiro-catcrew:kiro-cli chat --agent catcrew-orchestrator"
        "kiro-fantasy:kiro-cli chat --agent fantasy-orchestrator"
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
        "opencode-pub:opencode --agent pub-orchestrator"
        "opencode-caveman:opencode --agent caveman-orchestrator"
        "opencode-cyberpunk:opencode --agent cyberpunk-orchestrator"
        "opencode-catcrew:opencode --agent catcrew-orchestrator"
        "opencode-fantasy:opencode --agent fantasy-orchestrator"
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
echo "Reload your shell: source ~/.zshrc (zsh) or source ~/.bashrc (bash)"
