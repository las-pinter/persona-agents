#!/usr/bin/env bash

# ─────────────────────────────────────────────
#  test_runner.sh — diff-based folder output test harness
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATE_KIRO_SCRIPT="${SCRIPT_DIR}/../generate_kiro.sh"
GENERATE_OPENCODE_SCRIPT="${SCRIPT_DIR}/../generate_opencode.sh"

TEST_GENERIC_AGENTS_DIR="${SCRIPT_DIR}/generics"
TEST_AGENTS_JSON="${SCRIPT_DIR}/test-agents.json"
TEST_OUTPUT_DIR="${SCRIPT_DIR}/.test-output/"
TEST_REFERENCE_DIR="${SCRIPT_DIR}/reference/"
TEST_SKILLS_DIR="${SCRIPT_DIR}/skills"

echo "Generating kiro test agents from templates..."
if [[ -x "${GENERATE_KIRO_SCRIPT}" ]]; then
    "$GENERATE_KIRO_SCRIPT" \
        --output "$TEST_OUTPUT_DIR/test-kiro-agents" \
        --agents-dir "$TEST_GENERIC_AGENTS_DIR" \
        --agents-json "$TEST_AGENTS_JSON"
    echo "  agents generated"
else
    echo "Error: generate_kiro.sh not found or not executable at ${GENERATE_KIRO_SCRIPT}"
    exit 1
fi

echo "Generating opencode test agents from templates..."
if [[ -x "${GENERATE_OPENCODE_SCRIPT}" ]]; then
    "$GENERATE_OPENCODE_SCRIPT" \
        --output "$TEST_OUTPUT_DIR/test-opencode-agents" \
        --agents-dir "$TEST_GENERIC_AGENTS_DIR" \
        --agents-json "$TEST_AGENTS_JSON" \
        --skills-dir "$TEST_SKILLS_DIR"
    echo "  agents generated"
else
    echo "Error: generate_opencode.sh not found or not executable at ${GENERATE_OPENCODE_SCRIPT}"
    exit 1
fi

# Directory where the tested script writes its output
OUTPUT_DIR="${TEST_OUTPUT_DIR}"

# Directory containing reference (expected) output
REFERENCE_DIR="${TEST_REFERENCE_DIR}"

FAIL=0

# ANSI colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Colorize a diff block ────────────────────
print_diff() {
    while IFS= read -r line; do
        case "$line" in
        ---*) printf "${YELLOW}%s${RESET}\n" "$line" ;;
        +++*) printf "${YELLOW}%s${RESET}\n" "$line" ;;
        -*) printf "${RED}%s${RESET}\n" "$line" ;;
        +*) printf "${GREEN}%s${RESET}\n" "$line" ;;
        @@*) printf "${CYAN}%s${RESET}\n" "$line" ;;
        *) printf "%s\n" "$line" ;;
        esac
    done
}

# ─── Sanity checks ───────────────────────────
if [[ ! -d "$OUTPUT_DIR" ]]; then
    printf "${RED}ERROR${RESET} output folder not found: %s\n" "$OUTPUT_DIR"
    exit 1
fi
if [[ ! -d "$REFERENCE_DIR" ]]; then
    printf "${RED}ERROR${RESET} reference folder not found: %s\n" "$REFERENCE_DIR"
    exit 1
fi

# ─── Quick folder-level diff ─────────────────
# -r  recursive
# -q  only report which files differ (no content yet)
changed_files=$(diff -rq "$REFERENCE_DIR" "$OUTPUT_DIR" 2>&1)
overall_exit=$?

if [[ $overall_exit -eq 0 ]]; then
    printf "\n${GREEN}${BOLD}  ✓ All files match!${RESET}\n"
    printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"
    exit 0
fi

# ─── Per-file details for anything that differed ─
printf "\n"

while IFS= read -r line; do
    # Files only in reference (missing from output)
    if [[ "$line" == Only\ in\ ${REFERENCE_DIR}* ]]; then
        filepath="${line#Only in }"
        filepath="${filepath/: //}"
        FAIL=$((FAIL + 1))
        printf "${RED}${BOLD}[ MISSING ]${RESET} %s\n" "${filepath#$REFERENCE_DIR/}"
        printf "${RED}  not present in %s${RESET}\n\n" "$OUTPUT_DIR"

    # Files only in output (unexpected / extra)
    elif [[ "$line" == Only\ in\ ${OUTPUT_DIR}* ]]; then
        filepath="${line#Only in }"
        filepath="${filepath/: //}"
        FAIL=$((FAIL + 1))
        printf "${YELLOW}${BOLD}[ EXTRA ]${RESET} %s\n" "${filepath#$OUTPUT_DIR/}"
        printf "${YELLOW}  not present in %s${RESET}\n\n" "$REFERENCE_DIR"

    # Files that exist in both but differ
    elif [[ "$line" == Files\ * ]]; then
        ref_file=$(echo "$line" | awk '{print $2}')
        out_file=$(echo "$line" | awk '{print $4}')
        rel="${ref_file#$REFERENCE_DIR/}"
        FAIL=$((FAIL + 1))

        printf "${RED}${BOLD}[ DIFFER ]${RESET} %s\n" "$rel"
        printf "${RED}  ── diff (expected vs actual) ──────────────────${RESET}\n"
        diff -u --label "expected ($ref_file)" \
            --label "actual   ($out_file)" \
            "$ref_file" "$out_file" | print_diff
        printf "${RED}  ────────────────────────────────────────────────${RESET}\n\n"
    fi
done <<<"$changed_files"

# ─── Summary ─────────────────────────────────
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
if [[ $FAIL -eq 0 ]]; then
    printf "${GREEN}${BOLD}  ✓ All files match!${RESET}\n"
else
    printf "${RED}${BOLD}  ✗ %d file(s) differ${RESET}\n" "$FAIL"
fi
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n\n"

[[ $FAIL -eq 0 ]]
