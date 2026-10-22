# Retro on pi

Read this file only when the retro runs in a pi session.

| Item | Value |
|------|-------|
| Command | `/retro` |
| Session transcript | `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`. The slug is the working directory without the leading `/`, with each `/` changed to `-`, and with `--` at each end. For `/home/dev/project` the slug is `--home-dev-project--`. Use the newest file. |
| Transcript format | JSON Lines. Each message holds its tool calls, timestamps, and a `usage` object. |
| Permission rules | `~/.pi/agent/permissions.json` (allow, ask, and deny rules) and the `permissions:` block of the agent frontmatter. |
| Permission audit log | None. pi writes no durable permission audit log. |
| Cost source | The per-message `usage` fields (`cost`, `totalTokens`) in the session file. The usage cache `~/.pi/agent/cache/opencode-go-usage.json` holds the account quota, not the cost of one session. |

## Evidence Rules

- For a large session file, read the `usage` fields only. Do not load the
  whole file into context.
- The permissions dimension uses transcript denials and
  `~/.pi/agent/permissions.json`. State this limit when the dimension prints.
- Do not claim a pi permission audit log. The OpenCode audit log does not
  record pi decisions.
