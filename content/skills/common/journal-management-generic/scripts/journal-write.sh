#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# journal-write.sh — Append, check, or replace one journal target.
# The usage text lives in usage() only, so there is one copy to keep true.
# ============================================================================

# Byte order keeps the digest, the record count, and the name compares stable.
export LC_ALL=C

readonly LINE_LIMIT=100
readonly BLOCK_LINE_LIMIT=200
readonly TIMEOUT_LIMIT=120
readonly AGENT_RE='^[a-z][a-z0-9-]*$'
readonly SECTION_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
readonly EXPECT_RE='^[0-9a-f]{64}$'
readonly STAMP_RE='^<!-- session: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ([a-z][a-z0-9-]*) [A-Za-z0-9._-]{1,64} -->$'

# A failure line names a path only when that path is known, so an empty slot is
# left out of the line instead of printing a placeholder word. The block slot
# holds the path as given, even when it is relative or does not resolve. A
# control character prints as a space, so the line can never grow a second row.
TARGET=""
BLOCK=""

usage() {
    echo "Usage: bash $0 append --agent TYPE --block PATH [--section NAME] [--timeout SEC] [--home PATH]"
    echo "       bash $0 check --agent TYPE [--level LEVEL] [--name NAME] [--show] [--home PATH]"
    echo "       bash $0 replace --agent TYPE --level LEVEL --block PATH --expect DIGEST [--name NAME] [--timeout SEC] [--home PATH]"
    echo "       bash $0 -h | --help"
    echo "Subcommands:"
    echo "  append   Add one block file to today's daily journal"
    echo "  check    Print the state, the record count, and the digest of one target"
    echo "  replace  Replace one target when its digest matches --expect"
    echo "Flags:"
    echo "  --agent TYPE      Agent folder under agent-notes (required)"
    echo "  --block PATH      Absolute block file path (append, replace; required)"
    echo "  --section NAME    Project subsection under '## Work Log' (append)"
    echo "  --level LEVEL     daily, weekly, monthly, or yearly (check, replace)"
    echo "  --name NAME       Target name; the current period by default (check, replace)"
    echo "  --expect DIGEST   new, or the 64 hex digits of the target digest (replace; required)"
    echo "  --show            Print the body after the digest lines (check)"
    echo "  --home PATH       Home folder override"
    echo "  --timeout SEC     Lock wait in seconds, 1 to 120 (default 10)"
    echo "  -h, --help        Show this help message"
    echo "Exit codes:"
    echo "  0  written, or the check report"
    echo "  1  usage error: unknown flag, missing value, repeated flag, missing required"
    echo "     flag, a flag that is not valid for the subcommand, or a positional argument"
    echo "  2  bad input: a flag value that fails its pattern, a block that fails its rules,"
    echo "     no home folder found, or a --home folder with no agent-notes"
    echo "  3  --expect mismatch: the target changed since the read"
    echo "  4  IO failure: temp create, temp read, temp write, block read, target read,"
    echo "     chmod, or rename"
    echo "  5  lock wait exceeded --timeout"
}

# One line per failure keeps the cause readable for a caller that reads stderr.
fail() {
    local line="Error: $2"
    if [[ -n "$TARGET" ]]; then line="$line: ${TARGET//[[:cntrl:]]/ }"; fi
    if [[ -n "$BLOCK" ]]; then line="$line (block kept: ${BLOCK//[[:cntrl:]]/ })"; fi
    printf '%s\n' "$line" >&2
    exit "$1"
}

level_ok() {
    case "$1" in
    daily | weekly | monthly | yearly) return 0 ;;
    *) return 1 ;;
    esac
}

# One name shape per level, so a name cannot select another level's folder.
name_re() {
    case "$1" in
    daily) printf '%s' '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ;;
    weekly) printf '%s' '^[0-9]{4}-W[0-9]{2}$' ;;
    monthly) printf '%s' '^[0-9]{4}-[0-9]{2}$' ;;
    yearly) printf '%s' '^[0-9]{4}$' ;;
    *) printf '%s' '' ;;
    esac
}

name_ok() {
    local re=""
    re="$(name_re "$1")"
    [[ -n "$re" && "$2" =~ $re ]]
}

current_name() {
    case "$1" in
    weekly) date '+%G-W%V' ;;
    monthly) date '+%Y-%m' ;;
    yearly) date '+%Y' ;;
    *) date '+%Y-%m-%d' ;;
    esac
}

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

# Without --home, the walk-up rule runs before the $HOME rule.
pick_home() {
    if HOME_DIR="$(walk_up_for_notes "$SCRIPT_DIR")"; then return 0; fi
    if holds_notes "${HOME-}"; then HOME_DIR="${HOME-}"; return 0; fi
    return 1
}

# A trailing sentinel keeps the exact bytes, because command substitution drops
# the trailing newlines that the digest and the body print must match.
# The status is cat's status, not printf's, so a failed read is never silent.
read_all() {
    local rc=0
    TEXT="$(
        if cat -- "$1"; then rc=0; else rc=$?; fi
        printf 'x'
        exit "$rc"
    )" || {
        TEXT=""
        return 1
    }
    TEXT="${TEXT%x}"
    return 0
}

# The digest is the shape the report prints, or the call fails with exit 4.
digest_of_text() {
    local out=""
    if ! out="$(printf '%s' "$1" | sha256sum | cut -c 1-64)"; then return 1; fi
    if [[ ! "$out" =~ $EXPECT_RE ]]; then return 1; fi
    DIGEST="$out"
    return 0
}

# One lock per agent folder: the lock file outlives the run and is never removed.
take_lock() {
    LOCK="$JOURNALS/.journal-write.lock"
    if ! mkdir -p -- "${LOCK%/*}" 2>/dev/null; then fail 4 "lock folder create failed"; fi
    # The probe opens the lock first, so a bad lock path fails with one Error line.
    if ! { : >>"$LOCK"; } 2>/dev/null; then fail 4 "lock file open failed"; fi
    exec 9>>"$LOCK"
    if ! flock -w "$TIMEOUT" 9 2>/dev/null; then fail 5 "lock wait exceeded $TIMEOUT seconds"; fi
}

validate_block() {
    local count=0 rec2=""
    if [[ "$BLOCK" != /* ]]; then fail 2 "block path is not absolute"; fi
    BLOCK_REAL="$(readlink -f -- "$BLOCK" 2>/dev/null || true)"
    if [[ -z "$BLOCK_REAL" ]]; then fail 2 "block path does not resolve"; fi
    case "$BLOCK_REAL" in
    "$INCOMING_REAL"/*) ;;
    *) fail 2 "block path is outside the incoming folder" ;;
    esac
    if [[ "$BLOCK_REAL" != *.md ]]; then fail 2 "block name does not end in .md"; fi
    if [[ ! -f "$BLOCK_REAL" ]]; then fail 2 "block is not a regular file"; fi
    if [[ ! -r "$BLOCK_REAL" ]]; then fail 2 "block is not readable"; fi
    if ! count="$(awk 'END { print NR + 0 }' "$BLOCK_REAL")"; then fail 4 "block record count failed"; fi
    if [[ ! "$count" =~ ^[0-9]+$ ]]; then fail 4 "block record count failed"; fi
    if (( count > BLOCK_LINE_LIMIT )); then fail 2 "block is longer than $BLOCK_LINE_LIMIT records"; fi
    STAMP="$(head -n 1 -- "$BLOCK_REAL" 2>/dev/null || true)"
    if [[ ! "$STAMP" =~ $STAMP_RE ]]; then fail 2 "block record 1 is not a session stamp"; fi
    if [[ "${BASH_REMATCH[1]}" != "$AGENT" ]]; then fail 2 "block stamp names another agent"; fi
    # Record 2 is skipped by the splice, so text there would be lost silently.
    if ! rec2="$(awk 'NR == 2 { print; exit }' "$BLOCK_REAL")"; then fail 4 "block record 2 read failed"; fi
    if [[ -n "$rec2" ]]; then fail 2 "block record 2 holds text"; fi
}

# A CRLF target cannot be spliced by heading, so it is refused, not rewritten.
load_target_text() {
    TARGET_PRESENT=0
    TARGET_TEXT=""
    if [[ ! -f "$TARGET" ]]; then return 0; fi
    TARGET_PRESENT=1
    if ! read_all "$TARGET"; then fail 4 "target read failed"; fi
    if [[ "$TEXT" == *$'\r'* ]]; then fail 2 "target holds a carriage return"; fi
    TARGET_TEXT="$TEXT"
}

# A temp file in the target folder plus one rename keeps every reader whole.
# Both texts reach awk through the environment, so no escape is interpreted.
write_target() {
    local mode="$1" rc=0
    TARGET_DIR="${TARGET%/*}"
    if ! mkdir -p -- "$TARGET_DIR" 2>/dev/null; then fail 4 "target folder create failed"; fi
    TMP="$(mktemp "$TARGET_DIR/.journal-write.XXXXXX" 2>/dev/null || true)"
    if [[ -z "$TMP" ]]; then TMP=""; fail 4 "temp file create failed"; fi
    trap 'if [[ -n "${TMP:-}" ]]; then rm -f -- "$TMP"; fi' EXIT
    printf '%s' "$TARGET_TEXT" |
        JW_MODE="$mode" JW_SECTION="$SECTION" JW_STAMP="$STAMP" JW_BLOCK="$BLOCK_REAL" JW_TODAY="$TODAY" \
            awk '
BEGIN {
    mode = ENVIRON["JW_MODE"]
    sec = ENVIRON["JW_SECTION"]
    stamp = ENVIRON["JW_STAMP"]
    block = ENVIRON["JW_BLOCK"]
    datestr = ENVIRON["JW_TODAY"]
    # Record 1 is the stamp, which emit() prints again, and record 2 is the
    # blank separator; validation rejects a record 2 that holds text.
    nb = 0; skip = 2; r = 1; bad2 = 0
    while ((r = (getline l < block)) > 0) {
        if (skip > 0) {
            # A record 2 that gains text after validation would be dropped here.
            if (skip == 1 && l != "") bad2 = 1
            skip--; continue
        }
        blk[++nb] = l
    }
    close(block)
    # An exit from BEGIN still runs END, so a failed read stops in END instead.
    if (r < 0) bad = 1
    # A trailing blank dropped here keeps the target at one final newline.
    while (nb > 0 && blk[nb] ~ /^[ \t]*$/) nb--
}
{ lines[NR] = $0 }
END {
    if (bad) exit 8
    if (bad2) exit 9
    total = NR
    if (mode == "whole") { emit(); exit 0 }
    if (total == 0) {
        print "# " datestr
        print ""
        if (mode == "section") {
            print "## Work Log"
            print ""
            print "### " sec
            print ""
        }
        emit()
        exit 0
    }
    if (mode == "end") {
        head_to(last_nonblank(0, total))
        print ""
        emit()
        exit 0
    }
    wl = 0
    for (i = 1; i <= total; i++) if (lines[i] ~ /^## Work Log[ \t]*$/) { wl = i; break }
    if (wl == 0) {
        head_to(last_nonblank(0, total))
        print ""
        print "## Work Log"
        print ""
        print "### " sec
        print ""
        emit()
        exit 0
    }
    wlend = total
    for (i = wl + 1; i <= total; i++) if (lines[i] ~ /^#[ \t]/ || lines[i] ~ /^##[ \t]/) { wlend = i - 1; break }
    hs = 0
    for (i = wl + 1; i <= wlend; i++) if (sec != "" && heading_name(lines[i]) == sec) { hs = i; break }
    if (hs == 0) {
        p = last_nonblank(wl, wlend)
        head_to(p)
        print ""
        print "### " sec
        print ""
        emit()
        tail_from(p + 1)
        exit 0
    }
    hend = wlend
    for (i = hs + 1; i <= wlend; i++) if (lines[i] ~ /^###[ \t]/ || lines[i] ~ /^##[ \t]/ || lines[i] ~ /^#[ \t]/) { hend = i - 1; break }
    p = last_nonblank(hs, hend)
    head_to(p)
    print ""
    emit()
    tail_from(p + 1)
    exit 0
}
function emit() { print stamp; for (i = 1; i <= nb; i++) print blk[i] }
function head_to(upto) { for (i = 1; i <= upto; i++) print lines[i] }
function tail_from(from,   t) {
    t = last_nonblank(from, total)
    for (i = from; i <= t; i++) print lines[i]
}
function last_nonblank(from, to,   i) {
    i = to
    while (i > from && lines[i] ~ /^[ \t]*$/) i--
    return i
}
# The heading text is compared literally, so a dot in a name stays a dot.
function heading_name(line,   rest) {
    if (line !~ /^###[ \t]+/) return ""
    rest = line
    sub(/^###[ \t]+/, "", rest)
    sub(/[ \t]+$/, "", rest)
    return rest
}
' >"$TMP" 2>/dev/null || rc=$?
    # awk exit 8 means the block read failed before any temp write began.
    if (( rc == 8 )); then fail 4 "block read failed"; fi
    if (( rc == 9 )); then fail 2 "block record 2 holds text"; fi
    if (( rc != 0 )); then fail 4 "temp file write failed"; fi
    # The count comes from the temp file, so a failed count never follows a rename.
    if ! NEW_LINES="$(awk 'END { print NR + 0 }' "$TMP")"; then fail 4 "temp record count failed"; fi
    if [[ ! "$NEW_LINES" =~ ^[0-9]+$ ]]; then fail 4 "temp record count failed"; fi
    if [[ -e "$TARGET" ]]; then
        if ! chmod --reference="$TARGET" -- "$TMP" 2>/dev/null; then fail 4 "mode copy failed"; fi
    else
        if ! chmod 644 -- "$TMP" 2>/dev/null; then fail 4 "mode set failed"; fi
    fi
    if ! mv -f -- "$TMP" "$TARGET" 2>/dev/null; then fail 4 "rename failed"; fi
    trap - EXIT
    TMP=""
}

gate_of() {
    if (( $1 > LINE_LIMIT )); then printf 'over'; else printf 'ok'; fi
}

run_append() {
    local mode="end" gate="ok"
    if [[ -n "$SECTION" ]]; then mode="section"; fi
    take_lock
    load_target_text
    write_target "$mode"
    gate="$(gate_of "$NEW_LINES")"
    if ! rm -f -- "$BLOCK_REAL" 2>/dev/null; then printf 'Warning: block remove failed: %s\n' "$BLOCK_REAL" >&2; fi
    printf 'path %s\n' "$TARGET"
    printf 'lines %s\n' "$NEW_LINES"
    printf 'limit %s\n' "$LINE_LIMIT"
    printf 'gate %s\n' "$gate"
    printf 'stamp %s\n' "$STAMP"
    printf 'block removed %s\n' "$BLOCK_REAL"
}

run_check() {
    local body="" lines=0 digest="new" state="absent"
    if [[ -f "$TARGET" ]]; then
        state="present"
        if ! read_all "$TARGET"; then fail 4 "target read failed"; fi
        body="$TEXT"
        if ! digest_of_text "$body"; then fail 4 "digest failed"; fi
        digest="$DIGEST"
        if ! lines="$(printf '%s' "$body" | awk 'END { print NR + 0 }')"; then fail 4 "target record count failed"; fi
    fi
    printf 'path %s\n' "$TARGET"
    printf 'state %s\n' "$state"
    printf 'lines %s\n' "$lines"
    printf 'limit %s\n' "$LINE_LIMIT"
    printf 'digest %s\n' "$digest"
    if (( SHOW == 1 )); then
        printf '%s\n' '--- body ---'
        printf '%s' "$body"
        if [[ -n "$body" && "$body" != *$'\n' ]]; then printf '\n'; fi
        printf '%s\n' '--- end body ---'
    fi
}

run_replace() {
    local gate="ok"
    take_lock
    load_target_text
    if [[ "$EXPECT" == "new" ]]; then
        if (( TARGET_PRESENT == 1 )); then fail 3 "--expect new but the target is present"; fi
    else
        if (( TARGET_PRESENT == 0 )); then fail 3 "--expect digest but the target is absent"; fi
        if ! digest_of_text "$TARGET_TEXT"; then fail 4 "digest failed"; fi
        if [[ "$DIGEST" != "$EXPECT" ]]; then fail 3 "target digest does not match --expect"; fi
    fi
    TARGET_TEXT=""
    write_target "whole"
    gate="$(gate_of "$NEW_LINES")"
    if ! rm -f -- "$BLOCK_REAL" 2>/dev/null; then printf 'Warning: block remove failed: %s\n' "$BLOCK_REAL" >&2; fi
    printf 'path %s\n' "$TARGET"
    printf 'lines %s\n' "$NEW_LINES"
    printf 'limit %s\n' "$LINE_LIMIT"
    printf 'gate %s\n' "$gate"
    printf '%s\n' 'expect matched'
    printf 'stamp %s\n' "$STAMP"
    printf 'block removed %s\n' "$BLOCK_REAL"
}

# --- argument parse ---------------------------------------------------------

if [[ $# -eq 0 ]]; then fail 1 "no subcommand given"; fi
SUBCMD=""
case "$1" in
-h | --help) usage; exit 0 ;;
append | check | replace) SUBCMD="$1"; shift ;;
*) fail 1 "unknown subcommand: $1" ;;
esac

AGENT=""
SECTION=""
LEVEL=""
NAME=""
EXPECT=""
HOME_ARG=""
TIMEOUT=10
SHOW=0
USAGE_ERR=""
SEEN=" "
case "$SUBCMD" in
append) ALLOWED=" --agent --block --section --home --timeout " ;;
check) ALLOWED=" --agent --level --name --show --home " ;;
*) ALLOWED=" --agent --block --level --name --expect --home --timeout " ;;
esac

while [[ $# -gt 0 ]]; do
    flag="$1"
    case "$flag" in
    -h | --help) usage; exit 0 ;;
    --show)
        if [[ "$ALLOWED" != *" $flag "* ]]; then USAGE_ERR="$flag is not valid for $SUBCMD"; break; fi
        if [[ "$SEEN" == *" $flag "* ]]; then USAGE_ERR="repeated flag: $flag"; break; fi
        SEEN="$SEEN$flag "
        SHOW=1
        shift
        ;;
    --agent | --block | --section | --level | --name | --expect | --home | --timeout)
        if [[ "$ALLOWED" != *" $flag "* ]]; then USAGE_ERR="$flag is not valid for $SUBCMD"; break; fi
        if [[ "$SEEN" == *" $flag "* ]]; then USAGE_ERR="repeated flag: $flag"; break; fi
        # A following flag is a missing value, not a value that starts with a dash.
        if [[ $# -lt 2 || -z "${2-}" || "${2-}" == -* ]]; then USAGE_ERR="missing value for $flag"; break; fi
        SEEN="$SEEN$flag "
        case "$flag" in
        --agent) AGENT="$2" ;;
        --block) BLOCK="$2" ;;
        --section) SECTION="$2" ;;
        --level) LEVEL="$2" ;;
        --name) NAME="$2" ;;
        --expect) EXPECT="$2" ;;
        --home) HOME_ARG="$2" ;;
        --timeout) TIMEOUT="$2" ;;
        esac
        shift 2
        ;;
    *)
        if [[ "$flag" == -* ]]; then USAGE_ERR="unknown flag: $flag"; else USAGE_ERR="positional argument not allowed: $flag"; fi
        break
        ;;
    esac
done

if [[ -z "$USAGE_ERR" && -z "$AGENT" ]]; then USAGE_ERR="missing required flag: --agent"; fi
if [[ -z "$USAGE_ERR" && "$SUBCMD" != "check" && -z "$BLOCK" ]]; then USAGE_ERR="missing required flag: --block"; fi
if [[ -z "$USAGE_ERR" && "$SUBCMD" == "replace" ]]; then
    if [[ -z "$LEVEL" ]]; then USAGE_ERR="missing required flag: --level"; fi
    if [[ -z "$USAGE_ERR" && -z "$EXPECT" ]]; then USAGE_ERR="missing required flag: --expect"; fi
fi

# A malformed command line stops here, before any path is resolved.
if [[ -n "$USAGE_ERR" ]]; then fail 1 "$USAGE_ERR"; fi

# --- input shape ------------------------------------------------------------

if [[ ! "$AGENT" =~ $AGENT_RE ]]; then fail 2 "agent name is not valid"; fi
if [[ -n "$SECTION" && ! "$SECTION" =~ $SECTION_RE ]]; then fail 2 "section name is not valid"; fi
if [[ ! "$TIMEOUT" =~ ^[0-9]{1,3}$ ]]; then fail 2 "timeout is not 1 to $TIMEOUT_LIMIT seconds"; fi
TIMEOUT=$((10#$TIMEOUT))
if (( TIMEOUT < 1 || TIMEOUT > TIMEOUT_LIMIT )); then fail 2 "timeout is not 1 to $TIMEOUT_LIMIT seconds"; fi
if [[ -n "$LEVEL" ]] && ! level_ok "$LEVEL"; then fail 2 "level is not valid"; fi
if [[ "$SUBCMD" == "replace" && "$LEVEL" == "daily" ]]; then fail 2 "replace takes weekly, monthly, or yearly"; fi
if [[ -n "$EXPECT" && "$EXPECT" != "new" && ! "$EXPECT" =~ $EXPECT_RE ]]; then fail 2 "--expect is neither new nor a digest"; fi
if [[ -n "$HOME_ARG" && "$HOME_ARG" != /* ]]; then fail 2 "--home is not an absolute path"; fi

if [[ "$SUBCMD" == "append" ]]; then LEVEL="daily"; fi
if [[ "$SUBCMD" == "check" && -z "$LEVEL" ]]; then LEVEL="daily"; fi
if [[ -z "$NAME" ]]; then NAME="$(current_name "$LEVEL")"; fi
if ! name_ok "$LEVEL" "$NAME"; then fail 2 "name does not match the level"; fi

# --- home and target --------------------------------------------------------

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
[[ "$SCRIPT_PATH" == /* ]] || SCRIPT_PATH="$PWD/$SCRIPT_PATH"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

HOME_DIR=""
if [[ -n "$HOME_ARG" ]]; then
    HOME_DIR="$(readlink -f -- "$HOME_ARG" 2>/dev/null || true)"
    if [[ -z "$HOME_DIR" ]]; then fail 2 "--home does not resolve"; fi
    if ! holds_notes "$HOME_DIR"; then fail 2 "home folder has no agent-notes"; fi
elif ! pick_home; then
    fail 2 "no home folder found"
fi

JOURNALS="$HOME_DIR/agent-notes/$AGENT/journals"
TARGET="$JOURNALS/$LEVEL/$NAME.md"
TODAY="$(date '+%Y-%m-%d')"

# --- dispatch ---------------------------------------------------------------

if [[ "$SUBCMD" == "append" || "$SUBCMD" == "replace" ]]; then
    INCOMING_REAL="$(readlink -f -- "$JOURNALS/incoming" 2>/dev/null || true)"
    if [[ -z "$INCOMING_REAL" ]]; then INCOMING_REAL="$JOURNALS/incoming"; fi
    validate_block
fi

case "$SUBCMD" in
append) run_append ;;
check) run_check ;;
replace) run_replace ;;
esac

exit 0
