# Launch a pi agent under Herdr

Launch a pi process with the profession and persona flags:

```bash
pi --agent mascot --persona <theme>/<persona-file>
```

The `--agent` flag takes the bare profession name, for example `mascot` or
`orchestrator`. It does not take a theme-prefixed name, for example
`<theme>-mascot`.

Start the process under herdr control:

```bash
herdr agent start <name> --kind pi --pane <returned-pane-id> -- --agent mascot --persona <theme>/<persona-file>
```

Bind the pi agent with `agent start`. Herdr accepts its pane reports only when
the agent is bound.

Use these commands inside the session:

- `/persona` switches the persona live.
- `/agents` lists the available agents.

The user settings file holds the defaults:

```text
$HOME/.pi/agent/settings.json
```

It stores `defaultAgent` and `defaultPersona`. Example values are
`orchestrator` and `<theme>/<persona-file>`.

A pi process freshly started by herdr reports its state through the session
file. Herdr skips screen scanning for it. The `overseer.herald` plugin fires
reliably. The official pi integration lives at
`$HOME/.pi/agent/extensions/herdr-agent-state.ts`. It self-reports when
`HERDR_ENV` is set. Fresh-pane reporting makes the herald push work, from
watchdog to overseer.

An old pi process does not report its state. Reloading an old process is not a
restart. Only a fresh process counts.

The opencode leader sequence does not apply to pi. In pi, `ctrl+x` copies like
a clipboard action.
