#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# startup-report.sh — Print a read-only startup report for one agent.
# The usage text lives in usage() only, so there is one copy to keep true.
# ============================================================================

# Byte order keeps week and file name compares stable in every locale.
export LC_ALL=C

# One copy of each limit: the report line and the breach line both read these.
readonly SUMMARY_LINE_LIMIT=30
readonly RULES_FILE_LIMIT=8
readonly RULES_LINE_LIMIT=200

usage() {
    echo "Usage: bash $0 [--home PATH] [--agent TYPE] [--project NAME] [--no-dump] [--help]"
    echo "  --home PATH      Home folder override"
    echo "  --agent TYPE     Agent type folder under agent-notes (default: orchestrator)"
    echo "  --project NAME   Project folder under agent-notes/project-notes (default: auto)"
    echo "  --no-dump        Print the report only, without the content dump"
    echo "  --help, -h       Show this help message"
    echo "Output example (three keys):"
    echo "  today <YYYY-MM-DD>"
    echo "  daily_dir <path> count <n>"
    echo "  unconsolidated <none|week> <none|absent>"
}

# A missing or flag-like value is a user error, not a fallback.
need_value() {
    if [[ -z "${2-}" || "${2-}" == --* ]]; then echo "Error: $1 requires a value." >&2; exit 1; fi
}

# A plain name only: a slash, a dot, or a dot-dot would read outside the notes.
reject_path_value() {
    local flag="$1" value="$2"
    if [[ -z "$value" || "$value" == */* || "$value" == "." || "$value" == ".." ]]; then
        echo "Error: $flag takes a plain name, not a path: '$value'" >&2
        exit 1
    fi
    if [[ "$value" == *[[:cntrl:]]* ]]; then
        echo "Error: $flag takes a plain name with no control character: '$value'" >&2
        exit 1
    fi
}

HOME_ARG=""
AGENT="orchestrator"
PROJECT=""
DUMP=1
while [[ $# -gt 0 ]]; do
    case "$1" in
    --home) HOME_ARG="${2-}"; need_value --home "$HOME_ARG"; shift 2 ;;
    --agent) AGENT="${2-}"; need_value --agent "$AGENT"; shift 2 ;;
    --project) PROJECT="${2-}"; need_value --project "$PROJECT"; shift 2 ;;
    --no-dump) DUMP=0; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "Error: unknown option: $1" >&2; exit 1 ;;
    esac
done

reject_path_value --agent "$AGENT"
if [[ -n "$PROJECT" ]]; then reject_path_value --project "$PROJECT"; fi

# GNU coreutils give readlink -f here; the report targets Linux only.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
[[ "$SCRIPT_PATH" == /* ]] || SCRIPT_PATH="$PWD/$SCRIPT_PATH"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

# A relative --home would print relative; make it absolute without a cd.
if [[ -n "$HOME_ARG" ]]; then
    HOME_ARG="$(readlink -f "$HOME_ARG" 2>/dev/null || printf '%s' "$HOME_ARG")"
    [[ "$HOME_ARG" == /* ]] || HOME_ARG="$PWD/$HOME_ARG"
fi

holds_notes() { [[ -n "$1" && -d "$1/agent-notes" ]]; }

# Nearest folder wins, so the closest agent-notes matches the home rule order.
# An empty strip maps to the root so the root is tested once before the break.
walk_up_for_notes() {
    local dir="$1" next=""
    while :; do
        if holds_notes "$dir"; then printf '%s\n' "$dir"; return 0; fi
        if [[ "$dir" == "/" ]]; then break; fi
        next="${dir%/*}"
        if [[ -z "$next" ]]; then next="/"; fi
        if [[ "$next" == "$dir" ]]; then break; fi
        dir="$next"
    done
    return 1
}

# An explicit --home with no agent-notes fails loud. The user typed the flag,
# so a wrong path must stop the run, not fall back to another folder.
if [[ -n "$HOME_ARG" ]] && ! holds_notes "$HOME_ARG"; then
    echo "Error: --home path has no agent-notes folder: $HOME_ARG" >&2
    exit 1
fi

# The three home rules run in order; the first match wins.
HOME_DIR=""; HOME_RULE="none"
if [[ -n "$HOME_ARG" ]]; then HOME_DIR="$HOME_ARG"; HOME_RULE="flag"
elif HOME_DIR="$(walk_up_for_notes "$SCRIPT_DIR")"; then HOME_RULE="skill-dir"
elif holds_notes "${HOME-}"; then HOME_DIR="${HOME-}"; HOME_RULE="env-home"
fi
if [[ "$HOME_RULE" == "none" ]]; then
    echo "Error: no folder with agent-notes found; pass --home <path>." >&2
    exit 2
fi

# Count records so a file with no trailing newline still counts its last line.
# An unreadable path reports 0 lines; a read failure never aborts the report.
count_lines() {
    local n=""
    n="$(awk 'END { print NR + 0 }' "$1" 2>/dev/null || printf '0')"
    if [[ ! "$n" =~ ^[0-9]+$ ]]; then n=0; fi
    printf '%s\n' "$n"
}

# Count every file in the rules folder: a stray non-md file still counts.
count_rules() {
    local files=0 lines=0 f=""
    if [[ -d "$1" ]]; then
        while IFS= read -r f; do
            files=$((files + 1))
            lines=$((lines + $(count_lines "$f")))
        done < <(find "$1" -maxdepth 1 -type f -print 2>/dev/null | sort)
    fi
    printf '%s %s\n' "$files" "$lines"
}

# Journal names use the local date. Two reads run: one gives the day, one the week and month.
TODAY="$(date -I)"
read -r CUR_WEEK CUR_MONTH < <(date '+%G-W%V %Y-%m')
NOTES="$HOME_DIR/agent-notes"
AGENT_DIR="$NOTES/$AGENT"
DAILY_DIR="$NOTES/$AGENT/journals/daily"
WEEKLY_DIR="$NOTES/$AGENT/journals/weekly"
MONTHLY_DIR="$NOTES/$AGENT/journals/monthly"

DAILY_COUNT=0; DAILY_NEWEST="none"; UNCONSOLIDATED="none"
if [[ -d "$DAILY_DIR" ]]; then
    # The byte sort puts the newest date name last.
    name=""
    while IFS= read -r f; do
        name="${f##*/}"
        DAILY_COUNT=$((DAILY_COUNT + 1))
        # Only a year-month-day name gets a week parsed; any other name is not
        # a daily, because a short name like 2025.md still parses as a date.
        week=""
        if [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$ ]]; then
            week="$(date -d "${name%.md}" +%G-W%V 2>/dev/null || true)"
        fi
        if [[ -n "$week" ]]; then DAILY_NEWEST="$name"; fi
        if [[ -n "$week" && "$week" < "$CUR_WEEK" && ! -f "$WEEKLY_DIR/$week.md" ]]; then
            if [[ "$UNCONSOLIDATED" == "none" || "$week" < "$UNCONSOLIDATED" ]]; then UNCONSOLIDATED="$week"; fi
        fi
    done < <(find "$DAILY_DIR" -maxdepth 1 -type f -name '*.md' -print 2>/dev/null | sort)
fi
# The week loop picked a week whose weekly file is missing; this test re-verifies that path.
UNCONSOLIDATED_STATE="none"
if [[ "$UNCONSOLIDATED" != "none" && ! -f "$WEEKLY_DIR/$UNCONSOLIDATED.md" ]]; then UNCONSOLIDATED_STATE="absent"; fi
WEEKLY_STATE="absent"; MONTHLY_STATE="absent"
if [[ -f "$WEEKLY_DIR/$CUR_WEEK.md" ]]; then WEEKLY_STATE="present"; fi
if [[ -f "$MONTHLY_DIR/$CUR_MONTH.md" ]]; then MONTHLY_STATE="present"; fi
detect_project() {
    local url="" top=""
    url="$(git -C "$PWD" remote get-url origin 2>/dev/null || true)"
    url="${url%/}"; url="${url##*/}"; url="${url%.git}"
    if [[ -z "$url" ]] && top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"; then
        url="${top##*/}"
    fi
    if [[ -z "$url" ]]; then url="${PWD##*/}"; fi
    printf '%s\n' "$url"
}

[[ -n "$PROJECT" ]] || PROJECT="$(detect_project)"
# The auto-detected name takes the same path strip: last segment only, no dots.
PROJECT="${PROJECT##*/}"
if [[ "$PROJECT" == "." || "$PROJECT" == ".." ]]; then PROJECT="none"; fi
[[ -n "$PROJECT" ]] || PROJECT="none"
PROJECT_DIR="$NOTES/project-notes/$PROJECT"
SUMMARY_FILE="$PROJECT_DIR/summary.md"
RULES_DIR="$PROJECT_DIR/rules"

SUMMARY_STATE="absent"; SUMMARY_LINES=0
if [[ "$PROJECT" != "none" && -f "$SUMMARY_FILE" ]]; then
    SUMMARY_STATE="present"
    SUMMARY_LINES="$(count_lines "$SUMMARY_FILE")"
fi
# A none project has no rules folder, so the scan would count a stray path.
RULES_FILES=0; RULES_LINES=0
if [[ "$PROJECT" != "none" ]]; then
    read -r RULES_FILES RULES_LINES < <(count_rules "$RULES_DIR")
fi
SUMMARY_OK="ok"; if [[ "$SUMMARY_LINES" -gt "$SUMMARY_LINE_LIMIT" ]]; then SUMMARY_OK="breach"; fi
RULES_OK="ok"; if [[ "$RULES_FILES" -gt "$RULES_FILE_LIMIT" || "$RULES_LINES" -gt "$RULES_LINE_LIMIT" ]]; then RULES_OK="breach"; fi

printf 'today %s\n' "$TODAY"
printf 'home %s\n' "$HOME_DIR"
printf 'home_rule %s\n' "$HOME_RULE"
printf 'agent %s\n' "$AGENT"
printf 'agent_dir %s\n' "$AGENT_DIR"
printf 'daily_dir %s count %s\n' "$DAILY_DIR" "$DAILY_COUNT"
printf 'daily_newest %s\n' "$DAILY_NEWEST"
printf 'weekly %s %s\n' "$CUR_WEEK" "$WEEKLY_STATE"
printf 'monthly %s %s\n' "$CUR_MONTH" "$MONTHLY_STATE"
printf 'project %s\n' "$PROJECT"
printf 'summary %s %s limit %s %s\n' "$SUMMARY_STATE" "$SUMMARY_LINES" "$SUMMARY_LINE_LIMIT" "$SUMMARY_OK"
printf 'rules %s %s limit %s/%s %s\n' "$RULES_FILES" "$RULES_LINES" "$RULES_FILE_LIMIT" "$RULES_LINE_LIMIT" "$RULES_OK"
printf 'unconsolidated %s %s\n' "$UNCONSOLIDATED" "$UNCONSOLIDATED_STATE"

# Print the file text. Add a newline only when the last byte is not one.
# An empty file gets no extra newline. A failed read returns nonzero.
print_text() {
    cat -- "$1" 2>/dev/null || return 1
    if [[ -s "$1" && -n "$(tail -c 1 -- "$1" 2>/dev/null)" ]]; then printf '\n'; fi
    return 0
}

# The header and the end line make one block easy to find in a long dump.
# An empty path marks an absent source. An unreadable file says so.
dump_block() {
    local label="$1" header="$2" path="$3"
    printf -- '--- %s %s ---\n' "$label" "$header"
    if [[ -n "$path" ]]; then
        # A read failure prints the marker instead of stopping the report.
        if [[ ! -r "$path" ]] || ! print_text "$path"; then printf 'unreadable\n'; fi
    fi
    printf -- '--- end %s ---\n' "$label"
}

# Every rules file gets its own name line above the text, in name order.
dump_rules() {
    local f="" name=""
    if [[ "$PROJECT" == "none" || ! -d "$RULES_DIR" ]]; then
        dump_block rules absent ""
        return 0
    fi
    printf -- '--- rules %s ---\n' "$RULES_DIR"
    while IFS= read -r f; do
        name="${f##*/}"
        printf '### %s\n' "$name"
        if [[ ! -r "$f" ]] || ! print_text "$f"; then printf 'unreadable\n'; fi
    done < <(find "$RULES_DIR" -maxdepth 1 -type f -print 2>/dev/null | sort)
    printf -- '--- end rules ---\n'
}

# The dump never changes a report or a breach line. It only reads text.
dump_sources() {
    dump_rules
    if [[ "$SUMMARY_STATE" == "present" ]]; then
        dump_block summary "$SUMMARY_FILE" "$SUMMARY_FILE"
    else
        dump_block summary absent ""
    fi
    if [[ -n "$DAILY_NEWEST" && "$DAILY_NEWEST" != "none" ]]; then
        dump_block daily "$DAILY_NEWEST" "$DAILY_DIR/$DAILY_NEWEST"
    else
        dump_block daily absent ""
    fi
    if [[ "$WEEKLY_STATE" == "present" ]]; then
        dump_block weekly "$CUR_WEEK.md" "$WEEKLY_DIR/$CUR_WEEK.md"
    else
        dump_block weekly absent ""
    fi
    if [[ "$MONTHLY_STATE" == "present" ]]; then
        dump_block monthly "$CUR_MONTH.md" "$MONTHLY_DIR/$CUR_MONTH.md"
    else
        dump_block monthly absent ""
    fi
}

BREACH_COUNT=0
note_breach() {
    printf 'breach %s %s limit %s\n' "$1" "$2" "$3"
    BREACH_COUNT=$((BREACH_COUNT + 1))
}
if [[ "$SUMMARY_LINES" -gt "$SUMMARY_LINE_LIMIT" ]]; then note_breach summary-lines "$SUMMARY_LINES" "$SUMMARY_LINE_LIMIT"; fi
if [[ "$RULES_FILES" -gt "$RULES_FILE_LIMIT" ]]; then note_breach rules-files "$RULES_FILES" "$RULES_FILE_LIMIT"; fi
if [[ "$RULES_LINES" -gt "$RULES_LINE_LIMIT" ]]; then note_breach rules-lines "$RULES_LINES" "$RULES_LINE_LIMIT"; fi
if [[ "$BREACH_COUNT" -eq 0 ]]; then printf 'breach none\n'; fi
if [[ "$DUMP" -eq 1 ]]; then dump_sources; fi
exit 0
