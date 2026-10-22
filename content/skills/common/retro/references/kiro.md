# Retro on kiro

Read this file only when the retro runs in a kiro session.

| Item | Value |
|------|-------|
| Command | `/retro` (a file prompt) |
| Session transcript | `~/.kiro/sessions/cli/<session-id>.json` holds the session metadata (`cwd`, `created_at`, `updated_at`, `title`). `~/.kiro/sessions/cli/<session-id>.jsonl` holds the events. Use the newest session whose `cwd` is the current directory. |
| Transcript format | JSON Lines. Each line has a `kind` (for example `Prompt` or `AssistantMessage`) and a `data` object with the content and the tool calls. |
| Permission rules | `~/.kiro/agents/<agent>.json`: `allowedTools`, and `toolsSettings.shell.allowedCommands` and `deniedCommands`. |
| Permission audit log | None. kiro writes no durable permission audit log. |
| Cost source | None. Skip dimension 6. State in the output that kiro records no cost data for the session. |

## Evidence Rules

- For a large event file, read only the lines you need. Do not load the whole
  file into context.
- The permissions dimension uses transcript denials and the agent JSON file.
  State this limit when the dimension prints.
- Do not claim a kiro permission audit log.
