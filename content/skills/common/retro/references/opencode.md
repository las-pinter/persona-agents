# Retro on OpenCode

Read this file only when the retro runs in an OpenCode session.

| Item | Value |
|------|-------|
| Command | `/retro` |
| Session transcript | `~/.local/share/opencode/opencode.db`, a SQLite database. Read it only with a read-only SQLite client. If no client is on `PATH`, use the live context only. |
| Permission rules | The `permissions:` block of the agent file in `~/.config/opencode/agents/`, and `~/.config/opencode/opencode.json`. |
| Permission audit log | Yes: `~/.local/share/opencode/permission-audit.jsonl`. The `permission-auditor` plugin writes one JSON line per permission event, with the time, the kind, the session ID, and the reply. |
| Cost source | None. Skip dimension 6. State in the output that the retro reads no cost data on OpenCode. |

## Evidence Rules

- Read only the audit log lines whose `sessionID` is the current session.
- Do not write to the session database.
- The audit log records OpenCode decisions only. It does not record the
  decisions of a different platform.
