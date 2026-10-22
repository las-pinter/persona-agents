# Retro on Claude Code

Read this file only when the retro runs in a Claude Code session.

| Item | Value |
|------|-------|
| Command | `/persona-agents:retro` |
| Session transcript | `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. The slug is the working directory with each character that is not a letter or a digit changed to `-`. For `/home/dev/project` the slug is `-home-dev-project`. Use the newest file. The subagent transcripts of that session are in `~/.claude/projects/<cwd-slug>/<session-id>/subagents/*.jsonl`. |
| Transcript format | JSON Lines. Each line is one message or event. Tool results hold the permission denials. Each assistant message holds a `message.usage` object. |
| Permission rules | The `permissions` block of the settings files (`~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`), and the persona-agents PreToolUse hook `platforms/claude/scripts/doctrine.ts`. The hook returns an ask or a deny verdict. |
| Permission audit log | None. The hook writes `doctrine.log` in the plugin data folder only when `PERSONA_AGENTS_DEBUG` is set. Use that file as evidence only if it exists. |
| Cost source | The per-message `message.usage` fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. They give token counts, not a money value. Add the `usage` fields of the subagent transcripts. Report the token totals. |

## Evidence Rules

- For a large transcript file, read the `usage` fields and the denials only.
  Do not load the whole file into context.
- The permissions dimension uses transcript denials, the settings files, and
  the hook rules. State this limit when the dimension prints.
- Do not claim a Claude Code permission audit log.
