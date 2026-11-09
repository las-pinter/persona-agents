#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# journal-write.sh — Take, refresh, and release the journal write lock.
# Single responsibility: the take, refresh, and release of one lock, which is why
# this file sits in the 501 to 1000 band.
# The usage text lives in usage() only, so there is one copy to keep true.
# ============================================================================

# Byte order keeps the record compare and the printed times stable.
export LC_ALL=C

readonly LOCK_TTL=600
readonly TIMEOUT_LIMIT=120
readonly AGENT_RE='^[a-z][a-z0-9-]*$'
readonly SESSION_RE='^[A-Za-z0-9._-]{1,64}$'
readonly TOKEN_RE='^[A-Za-z0-9._-]{1,80}$'
# Internal status: held_fail made the lock and printed its one hold block.
readonly HELD_CREATED=10

# The lock path is known only after the parse, so a failure line names it when
# the slot is set. A usage error runs before the path exists.
LOCK=""
# The exit and signal traps share one cleanup path, so the record and claim
# temp files go away on exit and on a caught signal. A hard kill cannot be
# trapped: it leaves at most one of the two temp files behind, and none before
# the first temp file or after cleanup. An orphan claim blocks no writer.
TMP=""
CLAIM=""

cleanup() {
    if [[ -n "$TMP" ]]; then rm -f -- "$TMP" 2>/dev/null || true; fi
    if [[ -n "$CLAIM" ]]; then rm -f -- "$CLAIM" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

usage() {
    cat <<EOF
Usage: bash $0 hold    --agent TYPE --session NAME [--home PATH] [--timeout SEC]
       bash $0 release --agent TYPE --session NAME --token TOKEN [--home PATH]
       bash $0 -h | --help
Subcommands:
  hold     Take the lock for one agent folder, or refresh your own lock
  release  Remove your own lock
Flags:
  --agent TYPE      Agent folder under agent-notes (hold, release; required)
  --session NAME    Session name, 1 to 64 characters (hold, release; required)
  --token TOKEN     Lock token from the hold output (release; required)
  --home PATH       Home folder override; \$HOME by default
  --timeout SEC     Held lock wait in seconds, 1 to $TIMEOUT_LIMIT (hold; default 10)
  -h, --help        Show this help message
Exit codes:
  0  the lock is held, refreshed, or released
  1  usage error: unknown flag, missing value, repeated flag, missing required
     flag, a flag that is not valid for the subcommand, or a positional argument
  2  bad input: a flag value that fails its pattern, or a home folder that is
     not an absolute path
  3  IO failure: lock folder create, record read, record write, or a lock name
     gone before the create
  4  the lock is held and the wait exceeded --timeout
  5  release did not own the lock
A record older than $LOCK_TTL seconds is stale, so the hold deadline names the
time when a live holder must refresh or release.
EOF
}

# One line per failure keeps the cause readable for a caller that reads stderr.
# The third argument names the path a kept record lives at; it defaults to the lock.
fail() {
    local line="Error: $2"
    local path="${3-$LOCK}"
    if [[ -n "$path" ]]; then line="$line: $path"; fi
    printf '%s\n' "$line" >&2
    exit "$1"
}

# UTC ISO form of an epoch second, so every printed time reads the same way.
iso_of() { date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ'; }

# The record fields of one complete lock, in contract order.
REC=()

# A record is complete when it holds the five names in order and a numeric at.
# The caller passes the text it read, so one read serves the digest and this
# parse. An empty file and a short record return 1, read as a stale lock.
read_record() {
    local parsed=""
    REC=()
    parsed="$(printf '%s\n' "$1" | awk '
        NF != 2 { bad = 1 }
        { key[NR] = $1; val[NR] = $2 }
        END {
            if (bad || NR != 5) exit 1
            if (key[1] != "agent" || key[2] != "session" || key[3] != "token" ||
                key[4] != "at" || key[5] != "host") exit 1
            if (val[4] !~ /^[0-9]+$/) exit 1
            for (i = 1; i <= 5; i++) print val[i]
        }' 2>/dev/null)" || return 1
    if [[ -z "$parsed" ]]; then return 1; fi
    mapfile -t REC <<<"$parsed"
    return 0
}

# The digest of the probed bytes detects a record that changed between two
# reads. It is a change detector, not proof of ownership.
digest_text() { printf '%s' "$1" | cksum; }

# The state of the lock name: absent, complete, or incomplete.
PROBE=""
PROBED_DIGEST=""

probe_lock() {
    local text=""
    PROBED_DIGEST=""
    if [[ ! -e "$LOCK" ]]; then
        PROBE="absent"
        return 0
    fi
    # One read serves the digest and the parse. A read that fails for a name
    # that is gone is an absent record, not an IO fault.
    if ! text="$(cat -- "$LOCK" 2>/dev/null)"; then
        if [[ -e "$LOCK" ]]; then fail 3 "lock record read failed"; fi
        PROBE="absent"
        return 0
    fi
    PROBED_DIGEST="$(digest_text "$text")"
    if read_record "$text"; then PROBE="complete"; else PROBE="incomplete"; fi
    # A release beside this read can remove the lock, so the name is tested again.
    if [[ ! -e "$LOCK" ]]; then PROBE="absent"; fi
    return 0
}

# The record reaches a temp file first, so a reader never sees half a record.
write_record() {
    local token="$1" at="$2"
    TMP="$(mktemp "$JOURNALS/.journal-write.XXXXXX" 2>/dev/null)" || fail 3 "temp file create failed"
    if ! printf 'agent %s\nsession %s\ntoken %s\nat %s\nhost %s\n' \
        "$AGENT" "$SESSION" "$token" "$at" "$HOST" >"$TMP" 2>/dev/null; then
        fail 3 "record write failed"
    fi
}

# ln fails when the lock name exists, so exactly one caller creates the lock and
# the record is complete at the moment the name appears.
create_lock() {
    write_record "$1" "$2"
    if ln -- "$TMP" "$LOCK" 2>/dev/null; then
        rm -f -- "$TMP" 2>/dev/null || true
        TMP=""
        return 0
    fi
    rm -f -- "$TMP" 2>/dev/null || true
    TMP=""
    if [[ -e "$LOCK" ]]; then return 1; fi
    fail 3 "lock create failed"
}

# The lock name moves to a private claim path, so one rename wins and every
# other breaker finds the name gone. 0 the claim holds the record, 1 a record
# is still at the lock name, 2 it is gone: a failed move is never read as gone.
claim_lock() {
    local path=""
    path="$(mktemp "$JOURNALS/.journal-write.claim.XXXXXX" 2>/dev/null)" || fail 3 "claim file create failed"
    CLAIM="$path"
    if mv -- "$LOCK" "$path" 2>/dev/null; then
        return 0
    fi
    drop_claim
    if [[ -e "$LOCK" ]]; then return 1; fi
    return 2
}

# The claimed bytes must equal the probed bytes, so a lock that another session
# made in the window is never taken for the record the caller decided on.
claim_matches_probe() {
    local text=""
    if ! text="$(cat -- "$CLAIM" 2>/dev/null)"; then return 1; fi
    [[ "$(digest_text "$text")" == "$PROBED_DIGEST" ]]
}

drop_claim() {
    if [[ -n "$CLAIM" ]]; then rm -f -- "$CLAIM" 2>/dev/null || true; fi
    CLAIM=""
}

# A claimed record returns to the lock name only when no newer lock took it.
# A failed link sends the bytes to the prev file; a failed copy keeps the claim.
restore_claim() {
    local claim="$CLAIM"
    if ln -- "$claim" "$LOCK" 2>/dev/null; then
        drop_claim
        return 0
    fi
    if cp -- "$claim" "$PREV" 2>/dev/null; then
        drop_claim
        fail 3 "lock restore failed, record kept" "$PREV"
    fi
    # The claim is cleared so the trap keeps the only copy.
    CLAIM=""
    fail 3 "lock restore failed, claimed record kept" "$claim"
}

# A refresh claims the record, detects whether it is still the own one, removes
# the claim, and creates again. A created lock returns 0; every other branch
# returns the held_fail status, and the || : guard only stops set -e on it.
refresh_lock() {
    local token="$1" at="$2" deadline="$3" rc=0
    claim_lock || rc=$?
    if ((rc == 1)); then
        held_fail "$deadline" || :
        return "$HELD_CREATED"
    fi
    if ((rc == 2)); then
        # The own record went before the claim, so nothing is left to refresh.
        if create_lock "$token" "$at"; then return 0; fi
        held_fail "$deadline" || :
        return "$HELD_CREATED"
    fi
    if ! claim_matches_probe; then
        restore_claim
        held_fail "$deadline" || :
        return "$HELD_CREATED"
    fi
    drop_claim
    if create_lock "$token" "$at"; then return 0; fi
    held_fail "$deadline" || :
    return "$HELD_CREATED"
}

# A stale record is kept for the owner, and the claim is dropped so the caller
# retries the create once. A changed record goes back; 1 means the hold re-probes.
break_stale() {
    local rc=0
    claim_lock || rc=$?
    if ((rc != 0)); then
        # A record still at the lock name is another caller's. A gone name is
        # broken already, so the caller creates at once.
        if ((rc == 2)); then return 0; fi
        return 1
    fi
    if ! claim_matches_probe; then
        restore_claim
        return 1
    fi
    if ! cp -- "$CLAIM" "$PREV" 2>/dev/null; then
        # A vanished record is broken already, so the caller retries the create.
        if [[ -e "$CLAIM" ]]; then
            drop_claim
            fail 3 "stale record copy failed"
        fi
        drop_claim
        return 0
    fi
    printf 'stale %s age %ss\n' "$LOCK" "$1"
    drop_claim
    return 0
}

emit_hold() {
    local token="$1" at="$2"
    printf 'lock %s\n' "$LOCK"
    printf 'token %s\n' "$token"
    printf 'at %s\n' "$(iso_of "$at")"
    printf 'deadline %s\n' "$(iso_of "$((at + LOCK_TTL))")"
}

# Exit 4 names the holder and the moment it took the lock. A free name is
# created, and the distinct return stops the caller from a second emit.
held_fail() {
    local deadline="$1" at="" token=""
    while :; do
        probe_lock
        if [[ "$PROBE" != "absent" ]]; then break; fi
        at="$(date +%s)"
        token="$SESSION-$$"
        if create_lock "$token" "$at"; then
            emit_hold "$token" "$at"
            return "$HELD_CREATED"
        fi
        # A failed link is re-probed on the next turn, bounded by the deadline.
        if (($(date +%s) >= deadline)); then break; fi
        sleep 1
    done
    if [[ "$PROBE" == "absent" ]]; then
        # A free name at the bound is still the create case.
        at="$(date +%s)"
        token="$SESSION-$$"
        if create_lock "$token" "$at"; then
            emit_hold "$token" "$at"
            return "$HELD_CREATED"
        fi
        probe_lock
    fi
    if [[ "$PROBE" == "complete" ]]; then
        printf 'held %s by %s since %s\n' "$LOCK" "${REC[1]}" "$(iso_of "${REC[3]}")" >&2
        exit 4
    fi
    if [[ "$PROBE" == "incomplete" ]]; then
        printf 'Error: lock record is incomplete: %s\n' "$LOCK" >&2
        exit 4
    fi
    # The create lost to a name that the final probe then found gone.
    fail 3 "lock name went before the create"
}

run_hold() {
    local deadline=$(($(date +%s) + TIMEOUT)) age=0 at="" token="" rc=0
    while :; do
        # The deadline comes from the epoch clock once, so a break that keeps
        # failing ends within the timeout plus one poll.
        if (($(date +%s) >= deadline)); then
            held_fail "$deadline" || rc=$?
            if ((rc == HELD_CREATED)); then return 0; fi
            return "$rc"
        fi
        probe_lock
        if [[ "$PROBE" == "complete" ]]; then
            # A lock this session already holds is refreshed, never waited on.
            if [[ "${REC[0]}" == "$AGENT" && "${REC[1]}" == "$SESSION" ]]; then
                at="$(date +%s)"
                rc=0
                refresh_lock "${REC[2]}" "$at" "$deadline" || rc=$?
                if ((rc == HELD_CREATED)); then return 0; fi
                if ((rc != 0)); then return "$rc"; fi
                emit_hold "${REC[2]}" "$at"
                return 0
            fi
            age=$(($(date +%s) - REC[3]))
            if ((age < 0)); then age=0; fi
            if ((age <= LOCK_TTL)); then
                sleep 1
                continue
            fi
            if ! break_stale "$age"; then
                sleep 1
                continue
            fi
        elif [[ "$PROBE" == "incomplete" ]]; then
            if ! break_stale 0; then
                sleep 1
                continue
            fi
        fi
        at="$(date +%s)"
        token="$SESSION-$$"
        if create_lock "$token" "$at"; then
            emit_hold "$token" "$at"
            return 0
        fi
        # An absent lock that another writer just made is waited on. A broken
        # stale lock that a third writer took again refuses at once.
        if [[ "$PROBE" == "absent" ]]; then
            sleep 1
            continue
        fi
        rc=0
        held_fail "$deadline" || rc=$?
        if ((rc == HELD_CREATED)); then return 0; fi
        return "$rc"
    done
}

# A missing lock, an incomplete record, and a mismatch all mean the caller no
# longer owns the lock. A release never breaks a stale lock.
lost_fail() {
    printf 'lock lost %s\n' "$LOCK" >&2
    exit 5
}

# The release claims the record and proves it is the own one, so it never
# removes a lock that another session made after the read.
run_release() {
    local rc=0
    probe_lock
    if [[ "$PROBE" != "complete" || "${REC[0]}" != "$AGENT" ||
        "${REC[1]}" != "$SESSION" || "${REC[2]}" != "$TOKEN" ]]; then
        lost_fail
    fi
    claim_lock || rc=$?
    # A failed move with the name still present cannot tell our record from a
    # double fault, so this window stays exit 3 and does not widen the table.
    if ((rc == 1)); then fail 3 "lock release claim failed"; fi
    if ((rc == 2)); then lost_fail; fi
    if ! claim_matches_probe; then
        restore_claim
        lost_fail
    fi
    drop_claim
    printf 'released %s\n' "$LOCK"
    return 0
}

# --- argument parse ---------------------------------------------------------

if [[ $# -eq 0 ]]; then fail 1 "no subcommand given"; fi
SUBCMD=""
case "$1" in
-h | --help)
    usage
    exit 0
    ;;
hold | release)
    SUBCMD="$1"
    shift
    ;;
*) fail 1 "unknown subcommand: $1" ;;
esac

AGENT=""
SESSION=""
TOKEN=""
HOME_ARG=""
TIMEOUT=10
USAGE_ERR=""
SEEN=" "
case "$SUBCMD" in
hold) ALLOWED=" --agent --session --home --timeout " ;;
*) ALLOWED=" --agent --session --home --token " ;;
esac

while [[ $# -gt 0 ]]; do
    flag="$1"
    case "$flag" in
    -h | --help)
        usage
        exit 0
        ;;
    --agent | --session | --token | --home | --timeout)
        if [[ "$ALLOWED" != *" $flag "* ]]; then
            USAGE_ERR="$flag is not valid for $SUBCMD"
            break
        fi
        if [[ "$SEEN" == *" $flag "* ]]; then
            USAGE_ERR="repeated flag: $flag"
            break
        fi
        # A long option after a flag is a missing value. A single-dash token is a
        # value, so its pattern decides the exit code below.
        if [[ $# -lt 2 || -z "${2-}" || "${2-}" == --* ]]; then
            USAGE_ERR="missing value for $flag"
            break
        fi
        SEEN="$SEEN$flag "
        case "$flag" in
        --agent) AGENT="$2" ;;
        --session) SESSION="$2" ;;
        --token) TOKEN="$2" ;;
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
if [[ -z "$USAGE_ERR" && -z "$SESSION" ]]; then USAGE_ERR="missing required flag: --session"; fi
if [[ -z "$USAGE_ERR" && "$SUBCMD" == "release" && -z "$TOKEN" ]]; then USAGE_ERR="missing required flag: --token"; fi

# A malformed command line stops here, before any path is resolved.
if [[ -n "$USAGE_ERR" ]]; then fail 1 "$USAGE_ERR"; fi

# --- input shape ------------------------------------------------------------

# A value that starts with a dash is a bad flag value, not a missing one. The
# single-dash form reaches this test because the parse accepts it as a value.
if [[ "$AGENT" == -* ]]; then fail 2 "--agent value starts with a dash"; fi
if [[ "$SESSION" == -* ]]; then fail 2 "--session value starts with a dash"; fi
if [[ -n "$TOKEN" && "$TOKEN" == -* ]]; then fail 2 "--token value starts with a dash"; fi
if [[ ! "$AGENT" =~ $AGENT_RE ]]; then fail 2 "agent name is not valid"; fi
if [[ ! "$SESSION" =~ $SESSION_RE ]]; then fail 2 "session name is not valid"; fi
if [[ -n "$TOKEN" && ! "$TOKEN" =~ $TOKEN_RE ]]; then fail 2 "token is not valid"; fi
if [[ ! "$TIMEOUT" =~ ^[0-9]{1,3}$ ]]; then fail 2 "timeout is not 1 to $TIMEOUT_LIMIT seconds"; fi
TIMEOUT=$((10#$TIMEOUT))
if ((TIMEOUT < 1 || TIMEOUT > TIMEOUT_LIMIT)); then fail 2 "timeout is not 1 to $TIMEOUT_LIMIT seconds"; fi
if [[ -n "$HOME_ARG" && "$HOME_ARG" != /* ]]; then fail 2 "--home is not an absolute path"; fi

# --- lock path --------------------------------------------------------------

HOME_DIR="$HOME_ARG"
if [[ -z "$HOME_DIR" ]]; then HOME_DIR="${HOME-}"; fi
if [[ -z "$HOME_DIR" || "$HOME_DIR" != /* ]]; then fail 2 "no home folder found"; fi
HOME_DIR="$(readlink -f -- "$HOME_DIR" 2>/dev/null || printf '%s' "$HOME_DIR")"
JOURNALS="$HOME_DIR/agent-notes/$AGENT/journals"
LOCK="$JOURNALS/.journal-write.lock"
PREV="$JOURNALS/.journal-write.prev"
HOST="$(hostname 2>/dev/null || printf 'localhost')"
if ! mkdir -p -- "$JOURNALS" 2>/dev/null; then fail 3 "lock folder create failed"; fi

# --- dispatch ---------------------------------------------------------------

case "$SUBCMD" in
hold) run_hold ;;
release) run_release ;;
esac

exit 0
