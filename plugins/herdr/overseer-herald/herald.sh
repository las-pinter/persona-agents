#!/usr/bin/env bash
#
# Overseer Herald (overseer.herald) -- herdr plugin watchdog.
# ZERO-CONFIG: watches ALL agent panes automatically. No config file, no
# operator environment variables, no hardcoded pane/agent/theme ids.
#
# Triggered by herdr on every pane.agent_status_changed event; the envelope
# arrives in HERDR_PLUGIN_EVENT_JSON.
#
# Pipeline:
#   1. parse pane_id/agent/display_agent/agent_status/title (python3 first,
#      minimal sed fallback),
#   2. in scope iff agent OR display_agent is non-empty -- both empty means
#      skip entirely: no state write, no actions,
#   3. track last-observed status per pane in agent-state.tsv -- events do
#      NOT carry the previous status, so the herald remembers it,
#   4. act only on meaningful transitions (->blocked, or idle/done from
#      working) and never when the previous status is unknown,
#   5. discover the overseer by NAMING CONVENTION, not config: first agent
#      (array order) whose name contains "overseer" (case-insensitive),
#   6. on action: append events.log, desktop notification, herdr-native push
#      (herdr agent prompt) to the overseer. The overseer's own pane only
#      logs (self-loop guard); no overseer means no push.
#
# Safety: this script must NEVER crash herdr. Every path exits 0, and all
# side-effect commands are best-effort. It never touches the repo and never
# runs git. Writes ONLY inside $HERDR_PLUGIN_STATE_DIR.

set -u

# Any exit (including mid-script errors) becomes exit 0 so herdr is never
# disrupted. Only SIGKILL can bypass this.
trap 'exit 0' EXIT

payload="${HERDR_PLUGIN_EVENT_JSON:-}"
[ -n "$payload" ] || exit 0

# Nowhere safe to record state: warn once, stay inert.
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
    printf '%s\n' "herald: HERDR_PLUGIN_STATE_DIR unset; nowhere safe to record state" >&2
    exit 0
fi

STATE_FILE="$STATE_DIR/agent-state.tsv"
LOG_FILE="$STATE_DIR/events.log"

# ---------------------------------------------------------------------------
# Field extraction.
# Primary: python3 (reliable JSON parsing). Fallback: minimal per-key sed
# scan of the full single-line envelope.
# Both parsers emit the SAME one line of \x1f-separated fields (plus an END
# sentinel consumed by the trailing read variable), so the field read below
# is identical for either parser.
# ---------------------------------------------------------------------------
pane_id=""
agent=""
display_agent=""
agent_status=""
title=""

if command -v python3 >/dev/null 2>&1; then
    parsed="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    env = json.load(sys.stdin)
except Exception:
    sys.exit(0)
root = env.get("data") if isinstance(env, dict) else None
if not isinstance(root, dict):
    root = env if isinstance(env, dict) else {}
def g(k):
    v = root.get(k)
    if not isinstance(v, str):
        return ""
    return v.replace("\t", " ").replace("\r", " ").replace("\n", " ").replace("\x1f", " ")
status = g("agent_status")
if status not in ("idle", "working", "blocked", "done", "unknown"):
    status = "unknown"
sys.stdout.write("\x1f".join([g("pane_id"), g("agent"), g("display_agent"), status, g("title"), "END"]))
' 2>/dev/null)"
else
    # Fallback parser (python3 absent).
    #
    # ASSUMPTION: the envelope is a single line (herdr events are). Each
    # field is extracted from the FULL envelope with a greedy last-match
    # pattern: `.*"<key>"...` makes sed anchor on the LAST occurrence of
    # the key, so keys inside the "data" object naturally win over any
    # earlier top-level occurrence.
    get_str() {
        sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
    }
    pane_id="$(printf '%s' "$payload" | get_str pane_id)"
    agent="$(printf '%s' "$payload" | get_str agent)"
    display_agent="$(printf '%s' "$payload" | get_str display_agent)"
    agent_status="$(printf '%s' "$payload" | get_str agent_status)"
    title="$(printf '%s' "$payload" | get_str title)"
    # Identical normalization to the python parser: anything outside the
    # known statuses (including empty) becomes "unknown".
    case "$agent_status" in
    idle | working | blocked | done | unknown) ;;
    *) agent_status="unknown" ;;
    esac
    # Emit the same \x1f-delimited line the python parser emits. \037 is
    # the octal escape for the unit-separator byte (bash 3.2 safe); \x1f
    # hex escapes are not guaranteed in old bash ANSI-C quoting.
    parsed="$(printf '%s\037%s\037%s\037%s\037%s\037%s' "$pane_id" "$agent" "$display_agent" "$agent_status" "$title" "END")"
fi

if [ -n "$parsed" ]; then
    # Fields are separated with a NON-WHITESPACE delimiter (\x1f, unit
    # separator) so EMPTY fields survive. A whitespace IFS (e.g. \t) would
    # collapse consecutive separators and shift every following field left:
    # an empty display_agent used to make agent_status come out empty, the
    # gate never fired, and state lines shifted. Bash treats non-whitespace
    # IFS as a strict delimiter and preserves empty fields. _end consumes
    # the END sentinel so a shifted real field can never leak into it.
    IFS=$'\037' read -r pane_id agent display_agent agent_status title _end <<<"$parsed" || true
fi

# ---------------------------------------------------------------------------
# WATCH ALL AGENTS: a pane is in scope iff agent OR display_agent is
# non-empty. Both empty -> nothing worth watching: skip entirely (no state
# write, no actions).
# ---------------------------------------------------------------------------
if [ -z "$agent" ] && [ -z "$display_agent" ]; then
    exit 0
fi

# ---------------------------------------------------------------------------
# State tracking. Recorded BEFORE the gate so the next event carries the
# true previous status. One line per in-scope pane (TSV). Rewritten
# atomically on EVERY in-scope event: temp file in the same dir then mv
# over, avoiding torn reads when events fire concurrently. The temp file is
# removed if mv fails, so no orphan is left behind.
# ---------------------------------------------------------------------------
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

old_status=""
old_line=""
if [ -f "$STATE_FILE" ]; then
    old_line="$(awk -F '\t' -v p="$pane_id" '$1 == p { print; exit }' "$STATE_FILE" 2>/dev/null)"
    if [ -n "$old_line" ]; then
        old_status="$(printf '%s' "$old_line" | awk -F '\t' '{ print $4 }')"
    fi
fi

new_line="$(printf '%s\t%s\t%s\t%s' "$pane_id" "$agent" "$display_agent" "$agent_status")"
tmp_state="$STATE_FILE.tmp.$$"
if [ -f "$STATE_FILE" ]; then
    # Rewrite every line, replacing this pane's line (or appending at the
    # end if it is a new pane), preserving all other panes.
    awk -F '\t' -v p="$pane_id" -v nl="$new_line" \
        'BEGIN { f = 0 } $1 == p { print nl; f = 1; next } { print } END { if (!f) print nl }' \
        "$STATE_FILE" >"$tmp_state" 2>/dev/null
else
    printf '%s\n' "$new_line" >"$tmp_state" 2>/dev/null
fi
# Only mv if we actually produced content; otherwise keep the old state.
if [ -s "$tmp_state" ]; then
    if ! mv -f "$tmp_state" "$STATE_FILE" 2>/dev/null; then
        rm -f "$tmp_state" 2>/dev/null
    fi
else
    rm -f "$tmp_state" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Meaningful-transition gate (in-scope panes only).
#   (i)  new_status == blocked, OR
#   (ii) new_status in {idle, done} AND old_status == working.
# Skip when the old status is empty (first contact / no state line) or
# "unknown". No action on any other combination.
# ---------------------------------------------------------------------------
act=0
if [ -n "$old_status" ] && [ "$old_status" != "unknown" ]; then
    case "$agent_status" in
    blocked)
        act=1
        ;;
    idle | done)
        [ "$old_status" = "working" ] && act=1
        ;;
    esac
fi
[ "$act" -eq 1 ] || exit 0

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

# ---------------------------------------------------------------------------
# Overseer discovery -- NAMING CONVENTION, not config. Run `herdr agent
# list`, find the FIRST agent (array order) whose name contains "overseer"
# (case-insensitive), record its name + pane_id. Any failure (missing
# binary, child error, malformed output, no match) means NO overseer:
# overseer_name="" and overseer_pane="", and the push is skipped. This is
# best-effort and silent: "agent list" is the single source of truth for
# who the overseer is.
# ---------------------------------------------------------------------------
overseer_name=""
overseer_pane=""

herdr_bin="${HERDR_BIN_PATH:-herdr}"
list_out="$("$herdr_bin" agent list 2>/dev/null)"

if [ -n "$list_out" ]; then
    if command -v python3 >/dev/null 2>&1; then
        ov="$(printf '%s' "$list_out" | python3 -c '
import json, sys
try:
    env = json.load(sys.stdin)
except Exception:
    sys.exit(0)
agents = env.get("result", {}).get("agents", []) if isinstance(env, dict) else []
for a in agents:
    if not isinstance(a, dict):
        continue
    nm = a.get("name")
    if isinstance(nm, str) and "overseer" in nm.lower():
        pid = a.get("pane_id")
        if not isinstance(pid, str):
            pid = ""
        sys.stdout.write(nm + "\x1f" + pid)
        sys.exit(0)
' 2>/dev/null)"
        if [ -n "$ov" ]; then
            IFS=$'\037' read -r overseer_name overseer_pane <<<"$ov" || true
        fi
    else
        # Degraded but safe fallback (python3 absent): single-line
        # assumption; extract the exact adjacency
        #   "name":"<...overseer...>","pane_id":"<...>"
        # (field order verified: pane_id appears AFTER name within an entry).
        # First match wins (head -n 1); any failure -> no overseer.
        adj_pat='"name":"[^"]*overseer[^"]*","pane_id":"[^"]*"'
        adjacency="$(printf '%s' "$list_out" | grep -o -i "$adj_pat" 2>/dev/null | head -n 1)"
        if [ -n "$adjacency" ]; then
            overseer_name="$(printf '%s' "$adjacency" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
            overseer_pane="$(printf '%s' "$adjacency" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p')"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Actions on a meaningful event (in-scope, not the overseer's own pane), in
# order: log, notify, push. All best-effort: failures never stop the script;
# at most one warning line to stderr.
# ---------------------------------------------------------------------------

# a. Append one line to events.log (create dir if missing, never truncate).
mkdir -p "$STATE_DIR" 2>/dev/null
printf '%s, %s, %s, %s->%s\n' "$ts" "$pane_id" "$agent" "$old_status" "$agent_status" >>"$LOG_FILE" 2>/dev/null

# b. Self-loop guard: the overseer's own pane gets the events.log line ONLY
#    (written above) -- no notification, no push -- so the overseer is never
#    interrupted by its own transitions. Previous status still updated
#    normally (above).
if [ -n "$overseer_pane" ] && [ "$pane_id" = "$overseer_pane" ]; then
    exit 0
fi

# Short summary for the notification/push: display_agent + title (if
# present), sanitized -- no newlines/control characters, ~120 chars max.
details=""
[ -n "$display_agent" ] && details="$display_agent"
if [ -n "$title" ]; then
    if [ -n "$details" ]; then
        details="${details} / ${title}"
    else
        details="$title"
    fi
fi
details="$(printf '%s' "$details" | LC_ALL=C tr -d '[:cntrl:]')"
details="${details:0:120}"

# c. Desktop notification via the herdr binary (best-effort).
"$herdr_bin" notification show "Herald: ${agent} ${old_status}->${agent_status}" \
    --body "pane ${pane_id}: ${details}" >/dev/null 2>&1 ||
    printf 'herald: notification failed for pane %s\n' "$pane_id" >&2

# d. herdr-native push to the overseer. Exactly ONE argv TEXT argument:
#    `herdr agent prompt <TARGET> <TEXT>`. The HERALD prefix keeps it
#    unmistakable from a Commander order. No overseer -> skip the push
#    entirely (notification + log still fire). All push failures (including
#    agent_blocked rejections) are ignored -- one stderr warning at most.
if [ -n "$overseer_name" ]; then
    if [ -n "$details" ]; then
        msg="HERALD (watchdog, not Commander): ${agent} in pane ${pane_id} changed ${old_status} -> ${agent_status} at ${ts}. ${details}"
    else
        msg="HERALD (watchdog, not Commander): ${agent} in pane ${pane_id} changed ${old_status} -> ${agent_status} at ${ts}."
    fi
    "$herdr_bin" agent prompt "$overseer_name" "$msg" >/dev/null 2>&1 ||
        printf 'herald: push failed for pane %s (best-effort, ignored)\n' "$pane_id" >&2
fi

exit 0
