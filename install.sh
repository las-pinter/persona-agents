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
# Shared content (personas, professions, skills, agents.json) and the
# per-platform files. Content installs relative to CONTENT_DIR, so the
# installed layout keeps personas/, professions/, and skills/ at the top.
CONTENT_DIR="$REPO_DIR/content"
PLATFORMS_DIR="$REPO_DIR/platforms"
MCP_EXAMPLE="$REPO_DIR/config/mcp.json.example"
AGENTS_JSON="$CONTENT_DIR/agents.json"
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
        # ${2-} keeps set -u quiet when the option value is missing.
        opt_value="${2-}"
        if [[ -z "$opt_value" || "$opt_value" == --* ]]; then
            echo "Error: --target requires a value (kiro, opencode, or all)." >&2
            exit 1
        fi
        TARGET="$opt_value"
        shift 2
        ;;
    --profession=*)
        PROFESSION="${1#--profession=}"
        shift
        ;;
    --profession)
        # ${2-} keeps set -u quiet when the option value is missing.
        opt_value="${2-}"
        if [[ -z "$opt_value" || "$opt_value" == --* ]]; then
            echo "Error: --profession requires a value." >&2
            exit 1
        fi
        PROFESSION="$opt_value"
        shift 2
        ;;
    --theme=*)
        THEME="${1#--theme=}"
        shift
        ;;
    --theme)
        # ${2-} keeps set -u quiet when the option value is missing.
        opt_value="${2-}"
        if [[ -z "$opt_value" || "$opt_value" == --* ]]; then
            echo "Error: --theme requires a value." >&2
            exit 1
        fi
        THEME="$opt_value"
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

# Print one outcome line for a file or a merge.
# In dry-run mode the "(dry-run)" marker is added to the same message a real
# run prints, so a dry run and a real run report the same outcome.
report() {
    if [[ "$DRY_RUN" == true ]]; then
        echo "  (dry-run) $1"
    else
        echo "  $1"
    fi
}

# Escape a value for use as the replacement text of a sed 's|...|...|'
# expression. A sed replacement expands & to the matched text, so & must
# become \&. The delimiter (|) and a backslash must be escaped too.
# A newline would end the s command, so it becomes a space. Every substituted
# field is one line, and a space keeps the install complete.
sed_escape() {
    printf '%s' "$1" | tr '\n' ' ' | sed 's/[&|\\]/\\&/g'
}

copy_file() {
    local src="$1" dest="$2"
    if [[ -f "$dest" && "$FORCE" != true ]]; then
        report "skipped (exists): $dest"
        return
    fi
    if [[ "$DRY_RUN" == true ]]; then
        report "would install: $dest"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    report "installed: $dest"
}

copy_if_missing() {
    local src="$1" dest="$2"
    if [[ -f "$dest" ]]; then
        report "skipped (customize locally): $dest"
        return
    fi
    if [[ "$DRY_RUN" == true ]]; then
        report "would create if missing: $dest"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    report "created: $dest"
}

# Merge a JSON file into a destination JSON file at a given top-level key.
# Only missing entries are added: an entry the user already has under the key
# wins, so a re-run never overwrites a user customization.
# Handles trailing commas in the destination (jq is strict about those).
# A destination jq cannot read (for example one with comments) is left
# untouched with a warning; a failed merge never stops the install.
# The optional fourth argument names the source for the user. A temp file
# hides the real source, so the caller can pass the file the user knows.
merge_json_into() {
    local src_file="$1" dest_file="$2" dest_key="$3" src_label="${4:-$1}"

    if [[ ! -s "$dest_file" ]]; then
        echo "  warning: $dest_file not found or empty, skipping merge into .${dest_key}" >&2
        return
    fi
    if [[ ! -s "$src_file" ]]; then
        echo "  warning: $src_file is empty, skipping merge into .${dest_key}" >&2
        return
    fi
    if [[ "$DRY_RUN" == true ]]; then
        report "would merge $src_label into $dest_file at key '.${dest_key}'"
        return
    fi

    local tmp
    tmp=$(mktemp)
    CLEANUP_FILES+=("$tmp" "${tmp}.merged")

    # jq is strict about valid JSON — if the existing config has trailing
    # commas (which OpenCode tolerates but jq doesn't), strip them first.
    # Only do this if jq can't parse the file, to avoid corrupting strings.
    # The scan is string-aware: a quoted string is matched first and left
    # untouched, so a comma inside a string value is never a separator.
    if ! jq . "$dest_file" >/dev/null 2>&1; then
        perl -0777 -pe 's/"(?:[^"\\]|\\.)*"|,\s*([}\]])/defined $1 ? $1 : $&/ge' "$dest_file" >"$tmp"
    else
        cp "$dest_file" "$tmp"
    fi

    # Merge: add the new entries under dest_key; an existing entry wins.
    if ! jq --argjson data "$(cat "$src_file")" \
        ".${dest_key} = (\$data + (.${dest_key} // {}))" \
        "$tmp" >"${tmp}.merged" 2>/dev/null; then
        echo "  warning: cannot parse $dest_file (comments or invalid JSON?), left unchanged." >&2
        echo "  Merge $src_label under .${dest_key} manually." >&2
        return 0
    fi
    mv "${tmp}.merged" "$dest_file"
    report "merged into $dest_file (.${dest_key})"
}

# ---------------------------------------------------------------------------
# Kiro agent generation & installation
# ---------------------------------------------------------------------------

if target_available kiro; then

    echo ""
    echo "Generating kiro agents from templates..."

    KIRO_AGENTS_DIR="$KIRO_DEST/agents"
    if [[ "$DRY_RUN" != true ]]; then
        mkdir -p "$KIRO_AGENTS_DIR"
    fi

    for theme in $(get_themes); do
        [[ -n "$THEME" && "$theme" != "$THEME" ]] && continue
        for profession in $(get_professions "$theme"); do
            [[ -n "$PROFESSION" && "$profession" != "$PROFESSION" ]] && continue

            template="$PLATFORMS_DIR/kiro/templates/${profession}.json"
            agent_file="$KIRO_AGENTS_DIR/${theme}-${profession}.json"

            if [[ ! -f "$template" ]]; then
                echo "  warning: no kiro template for ${profession}, skipping" >&2
                continue
            fi

            if [[ -f "$agent_file" && "$FORCE" != true ]]; then
                report "skipped (exists): ${theme}-${profession}.json"
                continue
            fi

            if [[ "$DRY_RUN" == true ]]; then
                report "would generate: ${theme}-${profession}.json"
                continue
            fi

            description=$(get_agent_field "$theme" "$profession" "description")
            persona_file=$(get_agent_field "$theme" "$profession" "personaFile")
            welcome_message=$(get_agent_field "$theme" "$profession" "welcomeMessage")

            # Escape sed special chars (&, |, \) in every substituted value
            description_escaped=$(sed_escape "$description")
            theme_escaped=$(sed_escape "$theme")
            persona_file_escaped=$(sed_escape "$persona_file")
            welcome_escaped=$(sed_escape "$welcome_message")
            profession_escaped=$(sed_escape "$profession")

            sed -e "s|{{AGENT_DESCRIPTION}}|${description_escaped}|g" \
                -e "s|{{THEME}}|${theme_escaped}|g" \
                -e "s|{{PERSONA_FILE}}|${persona_file_escaped}|g" \
                -e "s|{{WELCOME_MESSAGE}}|${welcome_escaped}|g" \
                -e "s|{{PROFESSION}}|${profession_escaped}|g" \
                "$template" >"$agent_file"
            report "generated: ${theme}-${profession}.json"
        done
    done

    echo ""
    echo "Installing kiro resource files to $KIRO_DEST ..."

    for dir in personas professions skills; do
        if [[ -d "$CONTENT_DIR/$dir" ]]; then
            while IFS= read -r -d '' f; do
                rel="${f#"$CONTENT_DIR"/}"
                copy_file "$f" "$KIRO_DEST/$rel"
            done < <(find "$CONTENT_DIR/$dir" -type f -print0)
        fi
    done

    # Settings: only install if not already present — never overwrite user customizations
    copy_if_missing "$PLATFORMS_DIR/kiro/cli.json.example" "$KIRO_DEST/settings/cli.json"
    copy_if_missing "$MCP_EXAMPLE" "$KIRO_DEST/settings/mcp.json"
fi

# ---------------------------------------------------------------------------
# OpenCode agent generation, file installation & merge
# ---------------------------------------------------------------------------

if target_available opencode; then

    # -- Copy personas, professions, skills to OpenCode config folder --
    echo ""
    echo "Installing OpenCode resource files to $OPENCODE_DEST ..."

    for dir in personas professions skills; do
        if [[ -d "$CONTENT_DIR/$dir" ]]; then
            while IFS= read -r -d '' f; do
                rel="${f#"$CONTENT_DIR"/}"
                copy_file "$f" "$OPENCODE_DEST/$rel"
            done < <(find "$CONTENT_DIR/$dir" -type f -print0)
        fi
    done

    # -- Generate OpenCode agents as markdown files with YAML frontmatter --
    echo ""
    echo "Generating OpenCode agents..."

    OPENCODE_AGENTS_DIR="$OPENCODE_DEST/agents"
    if [[ "$DRY_RUN" != true ]]; then
        mkdir -p "$OPENCODE_AGENTS_DIR"
    fi

    for theme in $(get_themes); do
        [[ -n "$THEME" && "$theme" != "$THEME" ]] && continue
        for profession in $(get_professions "$theme"); do
            [[ -n "$PROFESSION" && "$profession" != "$PROFESSION" ]] && continue

            frontmatter_template="$PLATFORMS_DIR/opencode/frontmatters/${profession}.yaml"
            profession_file="$CONTENT_DIR/professions/${profession}.md"
            persona_file_path=$(get_agent_field "$theme" "$profession" "personaFile")
            persona_file="$CONTENT_DIR/personas/${theme}/${persona_file_path}"
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
                report "skipped (exists): ${theme}-${profession}.md"
                continue
            fi

            if [[ "$DRY_RUN" == true ]]; then
                report "would generate: ${theme}-${profession}.md"
                continue
            fi

            description=$(get_agent_field "$theme" "$profession" "description")

            # Escape sed special chars (&, |, \) in every substituted value
            description_escaped=$(sed_escape "$description")
            theme_escaped=$(sed_escape "$theme")

            # Build agent markdown: YAML frontmatter + stub comment
            # (prompt content provided at runtime by persona-agents plugin)
            {
                echo "---"
                sed -e "s|{{AGENT_DESCRIPTION}}|${description_escaped}|g" \
                    -e "s|{{THEME}}|${theme_escaped}|g" \
                    "$frontmatter_template"
                # The template may lack a trailing newline; guarantee the
                # closing delimiter starts on its own line.
                printf '\n'
                echo "---"
                echo ""
                echo "<!-- persona-agents:${theme}-${profession}:${persona_file_path} -->"
            } >"$agent_file"
            report "generated: ${theme}-${profession}.md"
        done
    done

    # -- Merge MCP settings into OpenCode config --
    if [[ -f "$OPENCODE_CONFIG" ]]; then
        echo ""
        echo "Merging MCP settings into OpenCode config..."

        mcp_example="$MCP_EXAMPLE"
        if [[ -f "$mcp_example" ]]; then
            # Transform in both modes: a dry run must report the same outcome
            # the real run prints, and the transform can fail.
            mcp_tmp=$(mktemp)
            CLEANUP_FILES+=("$mcp_tmp")
            # Transform mcpServers format → opencode mcp format
            # Handle both remote (url-based) and local/stdio (command-based) transports
            if ! jq '.mcpServers | to_entries | map({key: .key, value: (.value | if .url != null then {type: "remote", url: .url, enabled: true} elif .command != null then {type: "local", command: .command, args: (.args // []), enabled: true} else {type: "unknown", enabled: true} end)}) | from_entries' \
                "$mcp_example" >"$mcp_tmp"; then
                echo "  warning: failed to parse mcpServers from $mcp_example, skipping" >&2
                rm -f "$mcp_tmp"
            else
                merge_json_into "$mcp_tmp" "$OPENCODE_CONFIG" "mcp" "MCP settings from $mcp_example"
            fi
        else
            echo "  warning: MCP example file not found at $mcp_example" >&2
        fi
    fi

    # -- Install persona-agents plugin (self-contained, auto-discovered) --
    PLUGINS_DIR="$OPENCODE_DEST/plugins"
    copy_file "$PLATFORMS_DIR/opencode/plugins/persona-agents.js" "$PLUGINS_DIR/persona-agents.js"

    # -- Install permission-auditor plugin (self-contained, auto-discovered) --
    copy_file "$PLATFORMS_DIR/opencode/plugins/permission-auditor.js" "$PLUGINS_DIR/permission-auditor.js"
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
